// Restart race regression tests for PiRpcClient.
//
// Window under test:
//   1. the old child closes, its `close` handler clears `this.child` and then
//      suspends in `await this.whenDrainIdle()`;
//   2. a `request()` inside that window sees `running === false` and calls
//      `start()`, which spawns a NEW child and registers a pending request for it;
//   3. the old close handler resumes and calls `handleExit(oldError)`, which must
//      fail only the pending requests that the OLD child generation owned.
//
// The same contract applies to the old child's `error` callback, which can also
// arrive after a replacement child is already live.
//
// Windows are created deterministically with a fake `spawn` (no PID, no real Pi
// CLI) plus a gateable yield scheduler, so no assertion depends on timing luck.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the module mock below can reach it. `create` is assigned after the
// fake child class is declared; spawn() only runs inside tests.
const spawnRegistry = vi.hoisted(() => ({ create: undefined, children: [] }));

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
 * Deterministic stand-in for a spawned Pi process: no pid (so
 * terminateProcessTree() falls back to child.kill()), LF-framed stdout we drive
 * by hand, and a close/error we time ourselves.
 */
class FakePiChild extends EventEmitter {
  /** @param {string} label */
  constructor(label) {
    super();
    this.label = label;
    this.pid = undefined;
    this.exitCode = null;
    this.killed = false;
    this.killSignals = [];
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.writes = [];
    this.stdin = {
      writable: true,
      write: (line, callback) => {
        this.writes.push(JSON.parse(line));
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

  /** Node sets exitCode before 'close' fires; the close arg is the exit code. */
  exit(exitCode) {
    this.exitCode = exitCode;
    this.emit("close", exitCode);
  }

  /** @param {string} signal */
  kill(signal) {
    this.killed = true;
    this.killSignals.push(signal);
  }
}

spawnRegistry.create = (command, args, options) => {
  const child = new FakePiChild(`child-${spawnRegistry.children.length + 1}`);
  child.invocation = { command, args, options };
  // Node emits 'spawn' asynchronously, after start() registered its listeners.
  Promise.resolve().then(() => child.emit("spawn"));
  return child;
};

/**
 * Scheduler whose yields can be held, so a real drain (started by real stdout
 * data) stays in flight and `whenDrainIdle()` genuinely has to wait.
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

const clients = [];

beforeEach(() => {
  spawnRegistry.children.length = 0;
});

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
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

function pendingGeneration(client, id) {
  return client.pending.get(id)?.generation;
}

function rpcExitEvents(events) {
  return events.filter((event) => event.type === "rpc_exit");
}

describe("PiRpcClient restart race between an old exit and new requests", () => {
  it("A: an old close must not reject a request a replacement child accepted", async () => {
    const { client, scheduler, events } = createHarness();

    // G1: the old child, with a pending request of its own.
    const oldOutcome = observe(client.request("old-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const oldChild = spawnRegistry.children[0];
    const oldRequestId = oldChild.writes[0].id;
    expect(pendingGeneration(client, oldRequestId)).toBe(1);

    // Put a real drain in flight, so the close handler must wait in whenDrainIdle().
    scheduler.holdYields();
    oldChild.pushStdout({ type: "notice", n: 1 }, { type: "notice", n: 2 });
    await flushMicrotasks();
    expect(scheduler.waiters.length).toBe(1);
    expect(client.streamState.drainPromise).toBeDefined();

    // Old child closes: the handler clears this.child, then suspends.
    oldChild.exit(7);
    expect(client.child).toBeUndefined();
    expect(client.running).toBe(false);
    expect(client.pending.has(oldRequestId)).toBe(true);

    // G2: a request in that window starts a replacement child.
    const newOutcome = observe(client.request("new-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const newChild = spawnRegistry.children[1];
    expect(newChild).not.toBe(oldChild);
    expect(client.child).toBe(newChild);
    expect(client.running).toBe(true);
    expect(client.generation).toBe(2);
    const newRequestId = newChild.writes[0].id;
    expect(pendingGeneration(client, newRequestId)).toBe(2);
    expect([...client.pending.keys()]).toEqual([oldRequestId, newRequestId]);

    // Old close handler resumes and fails its own generation only.
    scheduler.releaseYields();
    await flushMicrotasks();

    expect(oldOutcome.status).toBe("rejected");
    expect(oldOutcome.value.message).toContain("code 7");
    // The new generation's request is untouched, and the map was not cleared.
    expect(client.pending.size).toBe(1);
    expect(client.pending.has(newRequestId)).toBe(true);
    expect(newOutcome.status).toBe("pending");
    // The exit is still reported even for a partially-affected map.
    expect(rpcExitEvents(events)).toHaveLength(1);

    // The replacement child answers its own request.
    newChild.pushStdout({ id: newRequestId, type: "response", success: true, data: { ok: true } });
    await client.whenDrainIdle(client.streamState);

    expect(newOutcome.status).toBe("fulfilled");
    expect(newOutcome.value).toEqual({ ok: true });
    expect(client.pending.size).toBe(0);
    expect(client.running).toBe(true);
  });

  it("B: three requests on the replacement child all survive the old close", async () => {
    const { client, scheduler } = createHarness();

    const oldOutcome = observe(client.request("old-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const oldChild = spawnRegistry.children[0];

    scheduler.holdYields();
    oldChild.pushStdout({ type: "notice", n: 1 }, { type: "notice", n: 2 });
    await flushMicrotasks();
    oldChild.exit(9);
    expect(client.running).toBe(false);

    const newOutcomes = ["new-1", "new-2", "new-3"].map((type) =>
      observe(client.request(type, {}, { timeoutMs: 0 }))
    );
    await flushMicrotasks();
    const newChild = spawnRegistry.children[1];
    expect(client.child).toBe(newChild);
    const newIds = newChild.writes.map((command) => command.id);
    expect(newIds).toEqual(["obsidian-pi-2", "obsidian-pi-3", "obsidian-pi-4"]);
    for (const id of newIds) expect(pendingGeneration(client, id)).toBe(2);
    expect(client.pending.size).toBe(4);

    scheduler.releaseYields();
    await flushMicrotasks();

    expect(oldOutcome.status).toBe("rejected");
    expect(oldOutcome.value.message).toContain("code 9");
    // All three new-generation requests keep waiting for their own answers.
    expect(newOutcomes.map((outcome) => outcome.status)).toEqual(["pending", "pending", "pending"]);
    expect(client.pending.size).toBe(3);

    newChild.pushStdout(
      ...newIds.map((id) => ({ id, type: "response", success: true, data: { id } }))
    );
    await client.whenDrainIdle(client.streamState);

    expect(newOutcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
    // Requests racing on one startPromise do not necessarily receive their ids in
    // call order, so each request only has to get the response for its own id.
    expect(newOutcomes.filter((outcome) => outcome.status !== "fulfilled")).toEqual([]);
    expect(newOutcomes.map((outcome) => outcome.value.id).sort()).toEqual([...newIds].sort());
    expect(client.pending.size).toBe(0);
  });

  it("C: a pending request of the exiting generation is still rejected", async () => {
    const { client, scheduler } = createHarness();

    const oldOutcome = observe(client.request("old-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const oldChild = spawnRegistry.children[0];
    const oldRequestId = oldChild.writes[0].id;

    scheduler.holdYields();
    oldChild.pushStdout({ type: "notice", n: 1 }, { type: "notice", n: 2 });
    await flushMicrotasks();
    oldChild.exit(3);

    const newOutcome = observe(client.request("new-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const newChild = spawnRegistry.children[1];
    const newRequestId = newChild.writes[0].id;
    expect(pendingGeneration(client, newRequestId)).toBe(2);

    scheduler.releaseYields();
    await flushMicrotasks();

    // The exiting generation's own request fails with the old error...
    expect(oldOutcome.status).toBe("rejected");
    expect(oldOutcome.value.message).toContain("code 3");
    expect(client.pending.has(oldRequestId)).toBe(false);
    // ...while the new generation's request is not collateral damage.
    expect(client.pending.has(newRequestId)).toBe(true);
    expect(newOutcome.status).toBe("pending");

    newChild.pushStdout({ id: newRequestId, type: "response", success: true, data: { ok: true } });
    await client.whenDrainIdle(client.streamState);
    expect(newOutcome.status).toBe("fulfilled");
  });

  it("D: a normal close rejects the old request and the restarted client keeps working", async () => {
    const { client } = createHarness();

    const oldOutcome = observe(client.request("old-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const oldChild = spawnRegistry.children[0];
    const oldRequestId = oldChild.writes[0].id;
    expect(client.streamState.drainPromise).toBeUndefined();

    // No drain in flight: the close handler does not pause before handleExit().
    oldChild.exit(4);
    await flushMicrotasks();

    expect(oldOutcome.status).toBe("rejected");
    expect(oldOutcome.value.message).toContain("code 4");
    expect(client.pending.size).toBe(0);
    expect(client.pending.has(oldRequestId)).toBe(false);
    expect(client.child).toBeUndefined();
    expect(client.running).toBe(false);

    const firstOutcome = observe(client.request("new-1", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const newChild = spawnRegistry.children[1];
    expect(newChild).not.toBe(oldChild);
    expect(client.child).toBe(newChild);
    expect(client.generation).toBe(2);
    const firstId = newChild.writes[0].id;
    expect(pendingGeneration(client, firstId)).toBe(2);

    newChild.pushStdout({ id: firstId, type: "response", success: true, data: { step: 1 } });
    await client.whenDrainIdle(client.streamState);
    expect(firstOutcome.status).toBe("fulfilled");
    expect(firstOutcome.value).toEqual({ step: 1 });

    // The client stays usable: a second request reuses the same child.
    const secondOutcome = observe(client.request("new-2", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    expect(spawnRegistry.children).toHaveLength(2);
    const secondId = newChild.writes[1].id;
    newChild.pushStdout({ id: secondId, type: "response", success: true, data: { step: 2 } });
    await client.whenDrainIdle(client.streamState);

    expect(secondOutcome.status).toBe("fulfilled");
    expect(secondOutcome.value).toEqual({ step: 2 });
    expect(client.pending.size).toBe(0);
    expect(client.running).toBe(true);
  });

  it("E: a late error from the exiting child must not reject the replacement child's request", async () => {
    const { client, scheduler } = createHarness();

    const oldOutcome = observe(client.request("old-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const oldChild = spawnRegistry.children[0];
    const oldRequestId = oldChild.writes[0].id;

    scheduler.holdYields();
    oldChild.pushStdout({ type: "notice", n: 1 }, { type: "notice", n: 2 });
    await flushMicrotasks();

    oldChild.exit(6);
    expect(client.running).toBe(false);

    const newOutcome = observe(client.request("new-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const newChild = spawnRegistry.children[1];
    const newRequestId = newChild.writes[0].id;
    expect(pendingGeneration(client, newRequestId)).toBe(2);
    expect(client.pending.size).toBe(2);

    // The old child reports an error after the replacement child is already live.
    oldChild.emit("error", new Error("old child exploded"));
    await flushMicrotasks();

    expect(oldOutcome.status).toBe("rejected");
    expect(oldOutcome.value.message).toContain("old child exploded");
    expect(client.pending.has(oldRequestId)).toBe(false);
    expect(client.pending.has(newRequestId)).toBe(true);
    expect(newOutcome.status).toBe("pending");
    expect(client.running).toBe(true);

    // The still-suspended close handler of the same old child behaves identically.
    scheduler.releaseYields();
    await flushMicrotasks();

    expect(client.pending.has(newRequestId)).toBe(true);
    expect(newOutcome.status).toBe("pending");

    newChild.pushStdout({ id: newRequestId, type: "response", success: true, data: { ok: true } });
    await client.whenDrainIdle(client.streamState);

    expect(newOutcome.status).toBe("fulfilled");
    expect(newOutcome.value).toEqual({ ok: true });
    expect(client.pending.size).toBe(0);
  });
});
