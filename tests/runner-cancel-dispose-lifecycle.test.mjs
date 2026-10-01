// PiRunner cancel/dispose lifecycle probes.
//
// Question: for a run that is in any stage of its lifecycle, do
// `cancelCurrentRun()` and `dispose()` always let the run settle, without
// leaving a permanently pending run, a stuck runner, an orphan Pi process, or a
// canceled run that still reports success?
//
// These tests pin the CURRENT behaviour only; no production change is made.
// The real `PiRunner` drives a real `PiRpcClient` whose `spawn` is a
// deterministic fake child, so every stage (start pending, get_state pending,
// prompt pending, waiting for the final event) can be held open exactly. The
// fake child exists synchronously once `run()` reaches `start()`, so a command
// responder can be installed before the runner writes anything.
//
// Invariant under test: every run settles. `settleRun()` fails loudly instead of
// hanging when a run never settles, so a permanent pending shows up as a red
// assertion rather than a stuck test.
//
// Unhandled rejections are captured with a plain `process.on("unhandledRejection")`
// listener. A regression in the completion guard makes these assertions fail (and
// the test runner reports the unhandled error as well), which is the evidence the
// E scenarios are after.

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
 * Deterministic stand-in for a spawned Pi process. `emitSpawn()` models the
 * asynchronous 'spawn' event, `fail()` the 'error' event, `exit()` the 'close'
 * event that follows either of them for a dying process.
 */
class FakePiChild extends EventEmitter {
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

  pushStdout(...messages) {
    const payload = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
    this.stdout.emit("data", Buffer.from(payload, "utf8"));
  }

  emitSpawn() {
    this.emit("spawn");
  }

  fail(error) {
    this.emit("error", error);
  }

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
  if (spawnRegistry.autoSpawn) Promise.resolve().then(() => child.emitSpawn());
  return child;
};

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

// Deterministic barriers: drain the microtask queue instead of sleeping.
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

/**
 * Wait for a run to settle. Returns "pending" when it never does, so the
 * "every run settles" invariant is asserted instead of assumed.
 */
async function settleRun(outcome, turns = 600) {
  for (let turn = 0; turn < turns && outcome.status === "pending"; turn += 1) {
    await Promise.resolve();
  }
  return outcome.status;
}

/** One macrotask turn, so a late unhandledRejection can surface. */
function macrotaskBarrier() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function countAborts() {
  return spawnRegistry.children.reduce(
    (total, child) => total + child.writes.filter((command) => command.type === "abort").length,
    0
  );
}

/** Answer get_state (and optionally prompt) so the run can advance. */
function respondToCommands(child, { prompt = false } = {}) {
  child.onCommand = (command) => {
    if (command.type === "get_state" || (prompt && command.type === "prompt")) {
      child.pushStdout({ id: command.id, type: "response", success: true, data: {} });
    }
  };
}

const clients = [];
const runners = [];
const tempDirs = [];
const unhandled = [];

function onUnhandledRejection(reason) {
  unhandled.push(reason);
}

beforeEach(() => {
  spawnRegistry.children.length = 0;
  spawnRegistry.autoSpawn = true;
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandledRejection);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandledRejection);
  for (const runner of runners.splice(0)) runner.dispose();
  for (const client of clients.splice(0)) client.dispose();
  for (const tempDir of tempDirs.splice(0)) fs.rmSync(tempDir, { recursive: true, force: true });
});

function createTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-runner-lifecycle-"));
  tempDirs.push(tempDir);
  return tempDir;
}

/**
 * Scheduler whose yields can be held, so a stdout drain (started by real data)
 * stays in flight and a close handler's `whenDrainIdle()` really waits.
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

function createHarness(options = {}) {
  const scheduler = new ControlledYieldScheduler();
  const client = new PiRpcClient({
    piExecutablePath: process.execPath,
    cwd: process.cwd(),
    yieldScheduler: scheduler,
    ...(options.drainBudget ? { drainBudget: options.drainBudget } : {})
  });
  clients.push(client);
  const runner = new PiRunner(
    { ...DEFAULT_SETTINGS, piExecutablePath: process.execPath },
    { formatPrompt: (prompt) => prompt },
    "/vault",
    createTempDir(),
    client
  );
  runners.push(runner);
  return { client, runner, scheduler };
}

/** The full observation set requested for every scenario. */
function lifecycleState(runner, client, outcome) {
  return {
    run: outcome.status,
    runError: outcome.status === "rejected" ? outcome.value.message : undefined,
    isRunning: runner.isRunning === true,
    cancelRequested: runner.cancelRequested,
    disposed: runner.disposed,
    rpcClient: runner.rpcClient ? "present" : "undefined",
    runCompletionRejector: runner.runCompletionRejector !== undefined,
    pendingRpc: client.pending.size,
    spawns: spawnRegistry.children.length,
    aborts: countAborts()
  };
}

const CANCELED_DISPOSED_STATE = {
  run: "rejected",
  runError: "Pi run canceled.",
  isRunning: false,
  cancelRequested: false,
  disposed: true,
  rpcClient: "undefined",
  runCompletionRejector: false,
  pendingRpc: 0,
  spawns: 1,
  aborts: 0
};

describe("PiRunner cancel/dispose lifecycle", () => {
  it("A1: dispose while start() is pending still settles the run as canceled", async () => {
    const { client, runner } = createHarness();
    spawnRegistry.autoSpawn = false;

    const outcome = observe(runner.run("hello", undefined, "session-1"));
    const child = spawnRegistry.children[0];
    expect(child).toBeDefined();
    expect(client.startPromise).toBeDefined();
    expect(runner.isRunning).toBe(true);

    runner.dispose();
    // dispose() terminates the child that has no owner left.
    expect(child.killed).toBe(true);
    expect(runner.disposed).toBe(true);
    expect(runner.rpcClient).toBeUndefined();

    // Only now does Node report the asynchronous 'spawn' of that child.
    child.emitSpawn();
    expect(await settleRun(outcome)).toBe("rejected");
    expect(lifecycleState(runner, client, outcome)).toEqual(CANCELED_DISPOSED_STATE);
  });

  it("A2: a spawn error after dispose still settles the run", async () => {
    const { client, runner } = createHarness();
    spawnRegistry.autoSpawn = false;

    const outcome = observe(runner.run("hello", undefined, "session-1"));
    const child = spawnRegistry.children[0];

    runner.dispose();
    child.fail(new Error("spawn failed"));
    expect(await settleRun(outcome)).toBe("rejected");
    expect(lifecycleState(runner, client, outcome)).toEqual(CANCELED_DISPOSED_STATE);
  });

  it("A3 (synthetic): a close with neither spawn nor error after dispose leaves start() pending", async () => {
    const { client, runner } = createHarness();
    spawnRegistry.autoSpawn = false;

    const outcome = observe(runner.run("hello", undefined, "session-1"));
    const child = spawnRegistry.children[0];

    runner.dispose();
    // Contrived ordering on purpose: real Node reports 'spawn' or 'error' before
    // 'close'. The disposed close handler returns before failStart(), so nothing
    // ever settles client.start() in this ordering.
    child.exit(1);

    expect(await settleRun(outcome)).toBe("pending");
    expect(client.startPromise).toBeDefined();
    expect(runner.isRunning).toBe(true);
  });

  it("B: dispose while get_state is pending ends the run and never uses Pi", async () => {
    const { client, runner } = createHarness();
    const requestTypes = [];
    const requestFailures = [];
    const realRequest = client.request.bind(client);
    client.request = (type, payload, options) => {
      requestTypes.push(type);
      const promise = realRequest(type, payload, options);
      promise.catch((error) => requestFailures.push({ type, message: error.message }));
      return promise;
    };
    const events = [];
    let promptAccepted = 0;

    const outcome = observe(
      runner.run("hello", undefined, "session-1", [], {
        onEvent: (event) => events.push(event.type),
        onPromptAccepted: () => (promptAccepted += 1)
      })
    );
    const child = spawnRegistry.children[0];
    await flushMicrotasks();
    expect(requestTypes).toEqual(["get_state"]);

    runner.dispose();
    expect(await settleRun(outcome)).toBe("rejected");

    expect(lifecycleState(runner, client, outcome)).toEqual(CANCELED_DISPOSED_STATE);
    // `get_state.catch(() => undefined)` swallows the dispose rejection, so the
    // run does continue: it subscribes, reports pi_start and issues a prompt
    // request. That request is refused by the disposed client, and nothing more
    // is ever written to the process.
    expect(requestTypes).toEqual(["get_state", "prompt"]);
    expect(events).toContain("pi_start");
    expect(promptAccepted).toBe(0);
    expect(requestFailures).toEqual([
      { type: "get_state", message: "Pi RPC client disposed." },
      { type: "prompt", message: "Pi RPC client is disposed." }
    ]);
    expect(child.writes.map((command) => command.type)).toEqual(["get_state"]);
    // dispose() does not null client.child; the process is killed instead, which
    // is what makes `running` false. The runner has already dropped the client.
    expect(client.child).toBe(child);
    expect(child.killed).toBe(true);
    expect(client.running).toBe(false);
  });

  it("C: dispose while the prompt request is pending rejects it and settles the run", async () => {
    const { client, runner } = createHarness();
    const outcome = observe(runner.run("hello", undefined, "session-1"));
    const child = spawnRegistry.children[0];
    respondToCommands(child);
    await waitFor(() => child.writes.some((command) => command.type === "prompt"));
    expect(client.pending.size).toBe(1);
    // The completion rejector is not installed until the prompt request resolves.
    expect(runner.runCompletionRejector).toBeUndefined();

    runner.dispose();
    expect(await settleRun(outcome)).toBe("rejected");
    expect(lifecycleState(runner, client, outcome)).toEqual(CANCELED_DISPOSED_STATE);
  });

  it("D: dispose while awaiting the final event wakes the run and it is no success", async () => {
    const { client, runner } = createHarness();
    let promptAccepted = 0;
    const outcome = observe(
      runner.run("hello", undefined, "session-1", [], {
        onPromptAccepted: () => (promptAccepted += 1)
      })
    );
    const child = spawnRegistry.children[0];
    respondToCommands(child, { prompt: true });
    await waitFor(() => runner.runCompletionRejector !== undefined);
    expect(promptAccepted).toBe(1);
    expect(client.pending.size).toBe(0);

    runner.dispose();
    expect(await settleRun(outcome)).toBe("rejected");

    expect(lifecycleState(runner, client, outcome)).toEqual(CANCELED_DISPOSED_STATE);
    expect(outcome.status).not.toBe("fulfilled");
    expect(child.killed).toBe(true);
  });

  it("E1: rejectRun() lands before await completion consumes it, with no unhandled rejection", async () => {
    // A one-event drain budget makes the second buffered line force a real
    // yield(), so the close handler has to wait in whenDrainIdle() and the
    // rpc_exit is delivered on our schedule instead of by luck.
    const { client, runner, scheduler } = createHarness({
      drainBudget: { maxEvents: 1, maxMs: 10_000 }
    });
    // Subscribed before the run, so this probe sees the state in the instant
    // rpc_exit is emitted, i.e. just before the run's own listener calls
    // rejectRun().
    const rejectorInstalledAtExit = [];
    client.subscribe((event) => {
      if (event.type === "rpc_exit")
        rejectorInstalledAtExit.push(runner.runCompletionRejector !== undefined);
    });

    const outcome = observe(runner.run("hello", undefined, "session-1"));
    const child = spawnRegistry.children[0];
    respondToCommands(child);
    await waitFor(() => child.writes.some((command) => command.type === "prompt"));
    expect(client.pending.size).toBe(1);

    scheduler.holdYields();
    child.pushStdout({ type: "notice", n: 1 }, { type: "notice", n: 2 });
    await flushMicrotasks();
    expect(scheduler.waiters.length).toBe(1);

    const abortPromise = runner.cancelCurrentRun();
    child.exit(0);
    // The close handler cleared this.child and is parked in whenDrainIdle(), so
    // both the prompt and the abort request are still pending.
    expect(client.pending.size).toBe(2);
    scheduler.releaseYields();

    expect(await settleRun(outcome)).toBe("rejected");
    await abortPromise;
    await macrotaskBarrier();

    // The rejection happened before the run reached `await completion`: the
    // completion rejector is installed on the line right before that await.
    expect(rejectorInstalledAtExit).toEqual([false]);
    expect(lifecycleState(runner, client, outcome)).toEqual({
      run: "rejected",
      runError: "Pi run canceled.",
      isRunning: false,
      cancelRequested: false,
      disposed: false,
      rpcClient: "present",
      runCompletionRejector: false,
      pendingRpc: 0,
      spawns: 1,
      aborts: 1
    });
    expect(unhandled).toEqual([]);
  });

  it("E2: cancel plus error then close during the prompt request stays canceled and clean", async () => {
    const { client, runner } = createHarness();
    const outcome = observe(runner.run("hello", undefined, "session-1"));
    const child = spawnRegistry.children[0];
    respondToCommands(child);
    await waitFor(() => child.writes.some((command) => command.type === "prompt"));

    const abortPromise = runner.cancelCurrentRun();
    child.fail(new Error("pipe broke"));
    child.exit(0);
    expect(await settleRun(outcome)).toBe("rejected");
    await abortPromise;
    await macrotaskBarrier();

    expect(lifecycleState(runner, client, outcome)).toEqual({
      run: "rejected",
      runError: "Pi run canceled.",
      isRunning: false,
      cancelRequested: false,
      disposed: false,
      rpcClient: "present",
      runCompletionRejector: false,
      pendingRpc: 0,
      spawns: 1,
      aborts: 1
    });
    expect(unhandled).toEqual([]);
  });

  it("E3: a close-only exit during the prompt request keeps the real RPC error", async () => {
    const { client, runner } = createHarness();
    const outcome = observe(runner.run("hello", undefined, "session-1"));
    const child = spawnRegistry.children[0];
    respondToCommands(child);
    await waitFor(() => child.writes.some((command) => command.type === "prompt"));

    child.exit(5);
    expect(await settleRun(outcome)).toBe("rejected");
    await macrotaskBarrier();

    expect(lifecycleState(runner, client, outcome)).toEqual({
      run: "rejected",
      runError: "Pi RPC process stopped: Pi exited with code 5.",
      isRunning: false,
      cancelRequested: false,
      disposed: false,
      rpcClient: "present",
      runCompletionRejector: false,
      pendingRpc: 0,
      spawns: 1,
      aborts: 0
    });
    expect(unhandled).toEqual([]);
  });

  it("E4: a normal prompt then agent_settled still resolves successfully", async () => {
    const { client, runner } = createHarness();
    const outcome = observe(runner.run("hello", undefined, "session-1"));
    const child = spawnRegistry.children[0];
    respondToCommands(child, { prompt: true });
    await waitFor(() => runner.runCompletionRejector !== undefined);

    child.pushStdout({ type: "agent_settled" });
    await client.whenDrainIdle();
    expect(await settleRun(outcome)).toBe("fulfilled");
    await macrotaskBarrier();

    expect(outcome.value.finalResponse).toBeDefined();
    expect(outcome.value.sessionId).toBeDefined();
    expect(unhandled).toEqual([]);
  });

  it("E5: an error-path RPC failure without cancel or dispose keeps the real error", async () => {
    const { client, runner } = createHarness();
    const outcome = observe(runner.run("hello", undefined, "session-1"));
    const child = spawnRegistry.children[0];
    respondToCommands(child);
    await waitFor(() => child.writes.some((command) => command.type === "prompt"));

    // No cancelCurrentRun() and no dispose(): this is a plain RPC failure, so the
    // caller must see the original error rather than a cancellation.
    child.fail(new Error("pipe broke"));
    expect(await settleRun(outcome)).toBe("rejected");
    await macrotaskBarrier();

    expect(lifecycleState(runner, client, outcome)).toEqual({
      run: "rejected",
      runError: "Could not run Pi CLI: pipe broke",
      isRunning: false,
      cancelRequested: false,
      disposed: false,
      rpcClient: "present",
      runCompletionRejector: false,
      pendingRpc: 0,
      spawns: 1,
      aborts: 0
    });
    expect(outcome.value.message).not.toContain("canceled");
    expect(unhandled).toEqual([]);
  });

  it("E6: an exit while awaiting the final event keeps the real error, not a success", async () => {
    const { client, runner } = createHarness();
    const outcome = observe(runner.run("hello", undefined, "session-1"));
    const child = spawnRegistry.children[0];
    respondToCommands(child, { prompt: true });
    await waitFor(() => runner.runCompletionRejector !== undefined);
    // No pending RPC request is left, so `completion` is the only failure signal.
    expect(client.pending.size).toBe(0);

    child.exit(9);
    expect(await settleRun(outcome)).toBe("rejected");
    await macrotaskBarrier();

    expect(lifecycleState(runner, client, outcome)).toEqual({
      run: "rejected",
      runError: "Pi RPC process stopped: Pi exited with code 9.",
      isRunning: false,
      cancelRequested: false,
      disposed: false,
      rpcClient: "present",
      runCompletionRejector: false,
      pendingRpc: 0,
      spawns: 1,
      aborts: 0
    });
    expect(outcome.status).not.toBe("fulfilled");
    expect(unhandled).toEqual([]);
  });

  it("F: a final event after cancelCurrentRun is reported as canceled, not success", async () => {
    const { client, runner } = createHarness();
    const outcome = observe(runner.run("hello", undefined, "session-1"));
    const child = spawnRegistry.children[0];
    respondToCommands(child, { prompt: true });
    await waitFor(() => runner.runCompletionRejector !== undefined);

    const abortPromise = runner.cancelCurrentRun();
    expect(runner.cancelRequested).toBe(true);
    await flushMicrotasks();
    expect(countAborts()).toBe(1);
    const abortId = client.pending.keys().next().value;

    // Pi answers the abort and still reports its normal final event.
    child.pushStdout({ id: abortId, type: "response", success: true, data: {} });
    child.pushStdout({ type: "agent_settled" });
    await client.whenDrainIdle();
    expect(await settleRun(outcome)).toBe("rejected");
    await abortPromise;

    expect(lifecycleState(runner, client, outcome)).toEqual({
      run: "rejected",
      runError: "Pi run canceled.",
      isRunning: false,
      cancelRequested: false,
      disposed: false,
      rpcClient: "present",
      runCompletionRejector: false,
      pendingRpc: 0,
      spawns: 1,
      aborts: 1
    });
    expect(outcome.status).not.toBe("fulfilled");
  });

  it("G: cancelCurrentRun immediately followed by dispose settles without unhandled rejections", async () => {
    const { client, runner } = createHarness();
    const outcome = observe(runner.run("hello", undefined, "session-1"));
    const child = spawnRegistry.children[0];
    respondToCommands(child);
    await waitFor(() => child.writes.some((command) => command.type === "prompt"));

    // The plugin's unload order: cancel first, then dispose.
    const abortPromise = runner.cancelCurrentRun();
    runner.dispose();
    expect(await settleRun(outcome)).toBe("rejected");
    await abortPromise;
    await macrotaskBarrier();

    expect(unhandled).toEqual([]);
    expect(lifecycleState(runner, client, outcome)).toEqual({
      run: "rejected",
      runError: "Pi run canceled.",
      isRunning: false,
      cancelRequested: false,
      disposed: true,
      rpcClient: "undefined",
      runCompletionRejector: false,
      pendingRpc: 0,
      spawns: 1,
      aborts: 1
    });
    expect(child.killed).toBe(true);
  });

  it("H: a disposed runner refuses to start Pi again", async () => {
    const { client, runner } = createHarness();
    runner.dispose();
    expect(runner.rpcClient).toBeUndefined();

    const first = observe(runner.run("hello", undefined, "session-1"));
    const second = observe(runner.run("hello", undefined, "session-1"));
    await settleRun(first);
    await settleRun(second);

    expect(lifecycleState(runner, client, first)).toEqual({
      run: "rejected",
      runError: "Pi run canceled.",
      isRunning: false,
      cancelRequested: false,
      disposed: true,
      rpcClient: "undefined",
      runCompletionRejector: false,
      pendingRpc: 0,
      spawns: 0,
      aborts: 0
    });
    expect(second.status).toBe("rejected");
    expect(second.value.message).toBe("Pi run canceled.");
    expect(client.child).toBeUndefined();
    expect(client.startPromise).toBeUndefined();
  });

  it("I: a plain cancel stays reusable, dispose is permanent", async () => {
    const { client, runner } = createHarness();

    // I1: cancel without dispose.
    const first = observe(runner.run("one", undefined, "session-1"));
    const firstChild = spawnRegistry.children[0];
    respondToCommands(firstChild);
    await waitFor(() => firstChild.writes.some((command) => command.type === "prompt"));

    const firstAbort = runner.cancelCurrentRun();
    firstChild.exit(0);
    expect(await settleRun(first)).toBe("rejected");
    await firstAbort;
    expect(first.value.message).toBe("Pi run canceled.");
    expect(runner.disposed).toBe(false);
    expect(runner.rpcClient).toBe(client);
    // Same early-rejection window as scenario E1, and now equally clean.
    await macrotaskBarrier();
    expect(unhandled).toEqual([]);

    // The runner is canceled, not disposed: a later run starts a fresh Pi process.
    const second = observe(runner.run("two", undefined, "session-1"));
    const secondChild = spawnRegistry.children[1];
    expect(secondChild).toBeDefined();
    respondToCommands(secondChild, { prompt: true });
    await waitFor(() => runner.runCompletionRejector !== undefined);
    secondChild.pushStdout({ type: "agent_settled" });
    await client.whenDrainIdle();

    expect(await settleRun(second)).toBe("fulfilled");
    expect(second.value.finalResponse).toBeDefined();
    expect(spawnRegistry.children).toHaveLength(2);

    // I2: dispose is permanent, even for later attempts.
    runner.dispose();
    const third = observe(runner.run("three", undefined, "session-1"));
    const fourth = observe(runner.run("four", undefined, "session-1"));
    await settleRun(third);
    await settleRun(fourth);
    expect(third.value.message).toBe("Pi run canceled.");
    expect(fourth.value.message).toBe("Pi run canceled.");
    expect(spawnRegistry.children).toHaveLength(2);
    expect(runner.isRunning === true).toBe(false);
    expect(runner.disposed).toBe(true);
    expect(runner.rpcClient).toBeUndefined();
  });
});
