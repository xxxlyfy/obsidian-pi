// Double-notification probe for PiRpcClient process death.
//
// A child process that fails emits 'error' and, on Node, usually 'close' after
// it. Both callbacks in `start()` run `handleExit(error, childGeneration)`, and
// `handleExit` always ends with `emit({ type: "rpc_exit" })`. So one process
// death can produce TWO `rpc_exit` notifications for the same generation.
//
// This file pins the current behaviour (no production change is made):
//   * how many `rpc_exit` events one error->close pair produces;
//   * whether the same pending request can be rejected twice;
//   * whether the two notifications carry the same error text;
//   * what the real production `rpc_exit` consumers do with the duplicate.
//
// Windows/ordering are deterministic: a fake `spawn` (no PID, no real Pi CLI)
// plus a gateable yield scheduler for the close-path cases, and the repository's
// existing "inject a fake rpcClient into PiRunner" pattern for the consumer side.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/plugin/settings.mjs";
import { PiRunner } from "../src/pi/runner.mjs";

// Hoisted so the module mock below can reach it. `create` is assigned after the
// fake child class is declared; spawn() only runs inside tests.
const spawnRegistry = vi.hoisted(() => ({ create: undefined, children: [], autoSpawn: true }));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    spawn: (...args) => {
      const child = spawnRegistry.create(...args);
      spawnRegistry.children.push(child);
      return child;
    }
  };
});

import { PiRpcClient } from "../src/pi/rpc-client.mjs";

/**
 * Deterministic stand-in for a spawned Pi process. `fail()` models Node's
 * 'error' event (the process never started or the pipe broke); `exit()` models
 * the 'close' event that can follow it.
 */
class FakePiChild extends EventEmitter {
  /** @param {string} label */
  constructor(label) {
    super();
    this.label = label;
    this.pid = undefined;
    this.exitCode = null;
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.writes = [];
    this.stdin = {
      writable: true,
      write: (line, callback) => {
        const command = JSON.parse(line);
        this.writes.push(command);
        this.onCommand?.(command);
        callback?.();
        return true;
      }
    };
  }

  /** Deliver stdout exactly as the child would: one JSON record per LF. */
  pushStdout(...messages) {
    const payload = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
    this.stdout.emit("data", Buffer.from(payload, "utf8"));
  }

  /** Node emits 'error', then usually 'close'. This emits only 'error'. */
  fail(error) {
    this.emit("error", error);
  }

  /** Node sets exitCode before 'close' fires; the close arg is the exit code. */
  exit(exitCode) {
    this.exitCode = exitCode;
    this.emit("close", exitCode);
  }

  /** @param {string} _signal */
  kill(_signal) {
    this.killed = true;
  }
}

spawnRegistry.create = () => {
  const child = new FakePiChild(`child-${spawnRegistry.children.length + 1}`);
  // Node emits 'spawn' asynchronously, after start() registered its listeners.
  // Scenario D needs a child that errors before it ever reports 'spawn'.
  if (spawnRegistry.autoSpawn) Promise.resolve().then(() => child.emit("spawn"));
  return child;
};

/**
 * Scheduler whose yields can be held, so a real drain (started by real stdout
 * data) stays in flight and the close handler's `whenDrainIdle()` really waits.
 */
class ControlledYieldScheduler {
  constructor() {
    this.hold = false;
    this.waiters = [];
    this.disposed = false;
  }

  yield() {
    if (this.disposed || !this.hold) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  holdYields() {
    this.hold = true;
  }

  releaseYields() {
    this.hold = false;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  dispose() {
    this.disposed = true;
    this.releaseYields();
  }
}

/** Observe a promise without letting its rejection escape as unhandled. */
function observe(promise) {
  const record = { status: "pending", value: undefined };
  promise.then(
    (value) => {
      record.status = "fulfilled";
      record.value = value;
    },
    (error) => {
      record.status = "rejected";
      record.value = error;
    }
  );
  return record;
}

// Deterministic barrier: drains the microtask queue instead of sleeping.
async function flushMicrotasks(turns = 64) {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

async function waitFor(predicate, turns = 400) {
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("waitFor: condition was not reached");
}

const clients = [];
const tempDirs = [];

beforeEach(() => {
  spawnRegistry.children.length = 0;
  spawnRegistry.autoSpawn = true;
});

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  for (const tempDir of tempDirs.splice(0)) fs.rmSync(tempDir, { recursive: true, force: true });
});

function createHarness() {
  const scheduler = new ControlledYieldScheduler();
  const client = new PiRpcClient({
    piExecutablePath: process.execPath,
    cwd: process.cwd(),
    yieldScheduler: scheduler,
    // One event per batch: a second buffered line forces a real yield().
    drainBudget: { maxEvents: 1, maxMs: 10_000 }
  });
  clients.push(client);
  const events = [];
  client.subscribe((event) => events.push(event));
  return { client, scheduler, events };
}

function rpcExits(events) {
  return events.filter((event) => event.type === "rpc_exit");
}

function rpcExitMessages(events) {
  return rpcExits(events).map((event) => event.error);
}

/** Count how often production code calls this pending entry's reject(). */
function countPendingRejections(client, id) {
  const entry = client.pending.get(id);
  const realReject = entry.reject;
  const counter = { calls: 0 };
  entry.reject = (error) => {
    counter.calls += 1;
    realReject(error);
  };
  return counter;
}

function createTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-rpc-exit-"));
  tempDirs.push(tempDir);
  return tempDir;
}

/**
 * PiRunner over a hand-rolled fake client, the pattern already used by
 * tests/runner.test.mjs. `listener()` runs the real `runPiRpc` subscription.
 */
function createRunnerHarness(behaviour = {}) {
  let listeners = new Set();
  const requests = [];
  const rpcClient = {
    start: vi.fn(async () => {}),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(type, payload) {
      requests.push({ type, payload });
      return behaviour.onRequest?.(type, payload, rpcClient) ?? {};
    },
    /** Test-side event source: delivers a client event to current subscribers. */
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    get subscriberCount() {
      return listeners.size;
    },
    resetSubscribers() {
      listeners = new Set();
    }
  };
  const runner = new PiRunner(
    DEFAULT_SETTINGS,
    { formatPrompt: (prompt) => prompt },
    "/vault",
    createTempDir(),
    rpcClient
  );
  return { runner, rpcClient, requests };
}

describe("PiRpcClient exits: error then close for the same child", () => {
  it("A: an error followed by a close emits two rpc_exit events but rejects the pending request once", async () => {
    const { client, events } = createHarness();
    const outcome = observe(client.request("old-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const child = spawnRegistry.children[0];
    const requestId = child.writes[0].id;
    const rejections = countPendingRejections(client, requestId);

    // Node's first event for a failed child.
    child.fail(new Error("pipe broke"));
    await flushMicrotasks();

    expect(outcome.status).toBe("rejected");
    expect(rejections.calls).toBe(1);
    expect(client.pending.size).toBe(0);
    expect(rpcExitMessages(events)).toEqual(["Could not run Pi CLI: pipe broke"]);

    // Node's follow-up event for the same dead child.
    child.exit(0);
    await flushMicrotasks();

    // Two notifications, two different texts, but still a single rejection.
    expect(rpcExitMessages(events)).toEqual([
      "Could not run Pi CLI: pipe broke",
      "Pi RPC process stopped: Pi exited with code 0."
    ]);
    expect(rejections.calls).toBe(1);
    expect(client.pending.size).toBe(0);
    expect(client.child).toBeUndefined();
    expect(client.running).toBe(false);
  });

  it("B: error then close without any pending still emits two rpc_exit events", async () => {
    const { client, events } = createHarness();
    await client.start();
    await flushMicrotasks();
    const child = spawnRegistry.children[0];
    expect(client.pending.size).toBe(0);

    child.fail(new Error("stderr unavailable"));
    await flushMicrotasks();
    expect(rpcExitMessages(events)).toHaveLength(1);

    child.exit(7);
    await flushMicrotasks();
    expect(rpcExitMessages(events)).toEqual([
      "Could not run Pi CLI: stderr unavailable",
      "Pi RPC process stopped: Pi exited with code 7."
    ]);
    expect(client.pending.size).toBe(0);
  });

  it("G: an error alone emits exactly one rpc_exit and leaves the failed child installed", async () => {
    const { client, events } = createHarness();
    const outcome = observe(client.request("old-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const child = spawnRegistry.children[0];
    const requestId = child.writes[0].id;
    const rejections = countPendingRejections(client, requestId);

    child.fail(new Error("pipe broke"));
    await flushMicrotasks();

    // Nothing is delivered twice here: the second event in A/B is a real
    // second event, not the same one observed twice.
    expect(rpcExitMessages(events)).toEqual(["Could not run Pi CLI: pipe broke"]);
    expect(rejections.calls).toBe(1);
    // 'error' alone does not clear this.child; only 'close' does.
    expect(client.child).toBe(child);
    expect(client.running).toBe(true);
    expect(outcome.status).toBe("rejected");
  });

  it("I: a close followed by a late error still rejects the pending request once and notifies twice", async () => {
    const { client, events } = createHarness();
    const outcome = observe(client.request("old-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const child = spawnRegistry.children[0];
    const requestId = child.writes[0].id;
    const rejections = countPendingRejections(client, requestId);

    // Reverse arrival order: 'close' first, the 'error' only afterwards.
    child.exit(4);
    await flushMicrotasks();
    expect(rpcExitMessages(events)).toEqual(["Pi RPC process stopped: Pi exited with code 4."]);
    expect(rejections.calls).toBe(1);
    expect(client.pending.size).toBe(0);

    child.fail(new Error("late pipe error"));
    await flushMicrotasks();

    expect(rpcExitMessages(events)).toEqual([
      "Pi RPC process stopped: Pi exited with code 4.",
      "Could not run Pi CLI: late pipe error"
    ]);
    expect(rejections.calls).toBe(1);
    expect(outcome.status).toBe("rejected");
    // The second notification is still attributed to the same dead child.
    expect(client.child).toBeUndefined();
    expect(client.running).toBe(false);
  });

  it("C: a close without an error emits exactly one rpc_exit and restart still works", async () => {
    const { client, events } = createHarness();
    const outcome = observe(client.request("old-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const oldChild = spawnRegistry.children[0];
    const oldRequestId = oldChild.writes[0].id;
    const rejections = countPendingRejections(client, oldRequestId);

    oldChild.exit(3);
    await flushMicrotasks();

    expect(rpcExitMessages(events)).toEqual(["Pi RPC process stopped: Pi exited with code 3."]);
    expect(rejections.calls).toBe(1);
    expect(outcome.status).toBe("rejected");
    expect(client.pending.size).toBe(0);
    expect(client.child).toBeUndefined();

    const nextOutcome = observe(client.request("next-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const nextChild = spawnRegistry.children[1];
    expect(client.child).toBe(nextChild);
    expect(client.generation).toBe(2);
    const nextId = nextChild.writes[0].id;

    nextChild.pushStdout({ id: nextId, type: "response", success: true, data: { ok: true } });
    await client.whenDrainIdle(client.streamState);

    expect(nextOutcome.status).toBe("fulfilled");
    expect(nextOutcome.value).toEqual({ ok: true });
    expect(rpcExits(events)).toHaveLength(1);
  });

  it("D: an error before start() resolves is reported twice and does not block the next child", async () => {
    const { client, events } = createHarness();
    spawnRegistry.autoSpawn = false;

    const startOutcome = observe(client.request("first-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const firstChild = spawnRegistry.children[0];
    expect(firstChild).toBeDefined();
    expect(client.startPromise).toBeDefined();

    firstChild.fail(new Error("spawn failed"));
    await flushMicrotasks();

    // start() rejected, so the request never registered a pending entry.
    expect(startOutcome.status).toBe("rejected");
    expect(startOutcome.value.message).toBe("Could not run Pi CLI: spawn failed");
    expect(client.pending.size).toBe(0);
    expect(rpcExitMessages(events)).toEqual(["Could not run Pi CLI: spawn failed"]);
    expect(client.running).toBe(true);

    firstChild.exit(1);
    await flushMicrotasks();

    expect(rpcExitMessages(events)).toEqual([
      "Could not run Pi CLI: spawn failed",
      "Pi RPC process stopped: Pi exited with code 1."
    ]);
    expect(client.child).toBeUndefined();
    expect(client.running).toBe(false);
    // failStart() cleared the failed attempt, so the next request may start Pi again.
    expect(client.startPromise).toBeUndefined();

    spawnRegistry.autoSpawn = true;
    const nextOutcome = observe(client.request("second-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const nextChild = spawnRegistry.children[1];
    expect(client.child).toBe(nextChild);
    expect(client.generation).toBe(2);
    const nextId = nextChild.writes[0].id;
    expect(client.pending.get(nextId)?.generation).toBe(2);

    nextChild.pushStdout({ id: nextId, type: "response", success: true, data: { ok: true } });
    await client.whenDrainIdle(client.streamState);
    expect(nextOutcome.status).toBe("fulfilled");
  });

  it("D2: a start-failed child's late close must not touch the next generation's request", async () => {
    const { client, scheduler, events } = createHarness();
    spawnRegistry.autoSpawn = false;
    scheduler.holdYields();

    const startOutcome = observe(client.request("first-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const firstChild = spawnRegistry.children[0];
    firstChild.pushStdout({ type: "notice", n: 1 }, { type: "notice", n: 2 });
    await flushMicrotasks();
    expect(scheduler.waiters.length).toBe(1);

    firstChild.fail(new Error("spawn failed"));
    await flushMicrotasks();
    expect(startOutcome.status).toBe("rejected");
    expect(rpcExitMessages(events)).toHaveLength(1);

    // The close clears this.child synchronously, then suspends in whenDrainIdle().
    firstChild.exit(1);
    expect(client.running).toBe(false);
    expect(client.pending.size).toBe(0);

    spawnRegistry.autoSpawn = true;
    const nextOutcome = observe(client.request("second-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const nextChild = spawnRegistry.children[1];
    const nextId = nextChild.writes[0].id;
    expect(client.pending.get(nextId)?.generation).toBe(2);

    // The late close resumes: its rpc_exit belongs to generation 1 only.
    scheduler.releaseYields();
    await flushMicrotasks();

    expect(rpcExitMessages(events)).toEqual([
      "Could not run Pi CLI: spawn failed",
      "Pi RPC process stopped: Pi exited with code 1."
    ]);
    expect(client.pending.has(nextId)).toBe(true);
    expect(nextOutcome.status).toBe("pending");

    nextChild.pushStdout({ id: nextId, type: "response", success: true, data: { ok: true } });
    await client.whenDrainIdle(client.streamState);
    expect(nextOutcome.status).toBe("fulfilled");
  });
});

describe("production rpc_exit consumers", () => {
  it("E: a run that has not settled re-enters its rpc_exit branch for every duplicate", async () => {
    // `runPiRpc` builds `new Error(event.error || ...)` for each rpc_exit while
    // the run is unsettled, so a counting message object pins that invocation.
    const errorConstructions = { calls: 0 };
    const countingMessage = (label) => ({
      toString: () => {
        errorConstructions.calls += 1;
        return label;
      }
    });
    const { runner, rpcClient } = createRunnerHarness();
    const run = runner.runPiRpc("hello", undefined, { onEvent: () => {} });
    await waitFor(() => runner.runCompletionRejector !== undefined);
    expect(rpcClient.subscriberCount).toBe(1);

    // Two rpc_exit notifications for one death, delivered while still subscribed.
    rpcClient.emit({ type: "rpc_exit", error: countingMessage("first exit") });
    rpcClient.emit({ type: "rpc_exit", error: countingMessage("second exit") });

    expect(errorConstructions.calls).toBe(2);
    // The promise already rejected: the duplicate cannot change the outcome, so
    // the first notification's message is the one the caller sees.
    await expect(run).rejects.toThrow("first exit");
    await flushMicrotasks();

    // The finally block unsubscribed the run's listener, so it hears nothing more.
    expect(rpcClient.subscriberCount).toBe(0);
    rpcClient.emit({ type: "rpc_exit", error: countingMessage("third exit") });
    expect(errorConstructions.calls).toBe(2);
  });

  it("F: a settled run ignores a late rpc_exit instead of failing", async () => {
    const errorConstructions = { calls: 0 };
    let settledEmitted = false;
    let releasePrompt;
    const heldPrompt = new Promise((resolve) => {
      releasePrompt = resolve;
    });
    const { runner, rpcClient } = createRunnerHarness({
      onRequest: (type, _payload, client) => {
        if (type !== "prompt") return {};
        // Settle the run, then hold the prompt request open: the subscription
        // stays active while `settled` is already true.
        client.emit({ type: "agent_settled" });
        settledEmitted = true;
        return heldPrompt;
      }
    });

    const run = runner.runPiRpc("hello", undefined, { onEvent: () => {} });
    await waitFor(() => settledEmitted);
    expect(rpcClient.subscriberCount).toBe(1);

    rpcClient.emit({
      type: "rpc_exit",
      error: {
        toString: () => {
          errorConstructions.calls += 1;
          return "late exit";
        }
      }
    });

    // `settled` is already true, so the run is not failed again.
    expect(errorConstructions.calls).toBe(0);
    expect(rpcClient.subscriberCount).toBe(1);

    releasePrompt();
    await expect(run).resolves.toMatchObject({ sessionId: expect.any(String) });
    expect(rpcClient.subscriberCount).toBe(0);
  });

  it("H: a real client's error->close reaches the run's listener only once", async () => {
    const { client, events } = createHarness();
    const exits = [];
    client.subscribe((event) => {
      if (event.type === "rpc_exit") exits.push(event);
    });
    const delivered = [];
    const realSubscribe = client.subscribe.bind(client);
    client.subscribe = (listener) =>
      realSubscribe((event) => {
        delivered.push(event);
        listener(event);
      });

    const runner = new PiRunner(
      DEFAULT_SETTINGS,
      { formatPrompt: (prompt) => prompt },
      "/vault",
      createTempDir(),
      client
    );
    const run = runner.runPiRpc("hello", undefined, { onEvent: () => {} });

    const child = spawnRegistry.children[0];
    expect(child).toBeDefined();
    child.onCommand = (command) => {
      if (command.type === "get_state" || command.type === "prompt") {
        child.pushStdout({ id: command.id, type: "response", success: true, data: {} });
      }
    };
    await waitFor(() => runner.runCompletionRejector !== undefined);

    child.fail(new Error("pipe broke"));
    child.exit(0);

    await expect(run).rejects.toThrow("Could not run Pi CLI: pipe broke");
    await waitFor(() => exits.length === 2);

    // The client emitted both notifications...
    expect(exits.map((event) => event.error)).toEqual([
      "Could not run Pi CLI: pipe broke",
      "Pi RPC process stopped: Pi exited with code 0."
    ]);
    // ...but the run unsubscribed when the first one settled it, so the run's
    // listener saw the first only.
    expect(delivered.filter((event) => event.type === "rpc_exit")).toHaveLength(1);
    expect(runner.runCompletionRejector).toBeUndefined();
    expect(runner.isRunning).toBe(false);
    expect(client.pending.size).toBe(0);
    expect(events.filter((event) => event.type === "rpc_exit")).toHaveLength(2);
  });

  it("J: the compact path has no rpc_exit branch, so every duplicate reaches onEvent", async () => {
    const seen = [];
    let releaseCompact;
    const heldCompact = new Promise((resolve) => {
      releaseCompact = resolve;
    });
    const { runner, rpcClient, requests } = createRunnerHarness({
      // Hold the compact request open so the subscription stays active.
      onRequest: (type) => (type === "compact" ? heldCompact : {})
    });

    const run = runner.runPiRpcCompact("session-1", "", {
      onEvent: (event) => seen.push(event.type)
    });
    await waitFor(() => requests.some((request) => request.type === "compact"));
    expect(rpcClient.subscriberCount).toBe(1);
    expect(seen).toEqual([]);

    rpcClient.emit({ type: "rpc_exit", error: "first exit" });
    rpcClient.emit({ type: "rpc_exit", error: "second exit" });

    // Unlike runPiRpc, this listener forwards rpc_exit to handlePiEvent, whose
    // catch-all publishes it to onEvent: the duplicate is user-visible twice.
    expect(seen).toEqual(["rpc_exit", "rpc_exit"]);

    releaseCompact();
    await expect(run).resolves.toMatchObject({ contextCompacted: true });
  });

  it("K: a real client's error->close delivers the duplicate to the compact path's onEvent", async () => {
    const { client, events } = createHarness();
    const exits = [];
    client.subscribe((event) => {
      if (event.type === "rpc_exit") exits.push(event);
    });

    const seen = [];
    const runner = new PiRunner(
      DEFAULT_SETTINGS,
      { formatPrompt: (prompt) => prompt },
      "/vault",
      createTempDir(),
      client
    );
    const run = runner.runPiRpcCompact("session-1", "", {
      onEvent: (event) => seen.push(event.type)
    });

    const child = spawnRegistry.children[0];
    expect(child).toBeDefined();
    // The compact request stays unanswered, so the run is waiting on it.
    await waitFor(() => child.writes.some((command) => command.type === "compact"));

    child.fail(new Error("pipe broke"));
    child.exit(0);

    await expect(run).rejects.toThrow("Could not run Pi CLI: pipe broke");
    await waitFor(() => exits.length === 2);

    // The client emitted both notifications, and unlike the runPiRpc listener
    // this one has no rpc_exit branch: the first notification only rejects the
    // pending compact request (a longer microtask chain than the close handler
    // needs for its own handleExit), so the duplicate is still delivered and
    // reaches onEvent as a second unknown-type event.
    expect(exits.map((event) => event.error)).toEqual([
      "Could not run Pi CLI: pipe broke",
      "Pi RPC process stopped: Pi exited with code 0."
    ]);
    expect(seen.filter((type) => type === "rpc_exit")).toHaveLength(2);
    expect(events.filter((event) => event.type === "rpc_exit")).toHaveLength(2);
  });
});
