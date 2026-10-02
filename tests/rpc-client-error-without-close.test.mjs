// Does a child that reports 'error' WITHOUT a following 'close' leave a
// permanent stale entry in PiRpcClient's per-child `streamStates` map?
//
// A Node ChildProcess can emit 'error' for a spawn failure, a kill failure, a
// send failure or a signal abort, and the client cannot assume every 'error' is
// followed by 'close'. In the current production code:
//   * `child.once("error", ...)` runs `failStart()` + `handleExit()` only - it
//     never touches `streamStates`;
//   * `child.once("close", ...)` is the only per-child path that calls
//     `streamStates.delete(generation)` (plus `dispose()`, which clears the map).
//
// This file records the resulting behaviour as facts. It asserts what the code
// does today, not what it "should" do, and it changes no production code:
//   A  error alone            -> state retained, child retained, still "running"
//   B1 error alone + request  -> no restart happens (the dead child is reused)
//   B2 error + 'exit' + request -> G2 starts, G1's stale state stays, G2 is fine
//   B3 error + terminate()    -> same as B2 through the kill path
//   C  ... + G2 close         -> only the stale G1 state is left
//   C2 repeated abandon cycles-> one stale state added per cycle (measurement)
//   C3 repeated error+close   -> the map never accumulates (contrast)
//   D  spawn failure + close  -> state correctly released (contrast with A)
//   E  synthetic send/kill    -> the client keeps writing to the errored child
//   S  sensitivity            -> error-only / close-only / error-then-close are
//                                three demonstrably different traces

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
 * Deterministic stand-in for a spawned Pi process. `fail()`/`exitOnly()`/
 * `exit()` let a test choose exactly which ChildProcess events arrive, which is
 * the whole point of this file.
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
        this.writes.push(JSON.parse(line));
        callback?.();
        return true;
      }
    };
  }

  /** Raw stdout bytes, exactly as the pipe would deliver them. */
  pushRaw(text) {
    this.stdout.emit("data", Buffer.from(text, "utf8"));
  }

  /** Deliver complete records: one JSON document per LF. */
  pushStdout(...messages) {
    this.pushRaw(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
  }

  /** Deliver a truncated record with no trailing LF. */
  pushPartial(text) {
    this.pushRaw(text);
  }

  /** A ChildProcess 'error': spawn failure, kill failure, send failure, abort. */
  fail(error) {
    this.emit("error", error);
  }

  /** Node's 'exit' (exitCode set) with no 'close' ever following it. */
  exitOnly(exitCode) {
    this.exitCode = exitCode;
    this.emit("exit", exitCode);
  }

  /** Node's 'close', which normally follows 'exit'. */
  exit(exitCode) {
    if (this.exitCode === null) this.exitCode = exitCode;
    this.emit("close", exitCode);
  }

  /** @param {string} signal */
  kill(signal) {
    this.killed = true;
    this.killSignals = [...(this.killSignals ?? []), signal];
  }
}

spawnRegistry.create = () => {
  const child = new FakePiChild(`child-${spawnRegistry.children.length + 1}`);
  // Node emits 'spawn' asynchronously, after start() registered its listeners.
  if (spawnRegistry.autoSpawn) Promise.resolve().then(() => child.emit("spawn"));
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

// Deterministic barrier: drains the microtask queue instead of sleeping.
async function flushMicrotasks(turns = 64) {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

const clients = [];

beforeEach(() => {
  spawnRegistry.children.length = 0;
  spawnRegistry.autoSpawn = true;
});

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

function createHarness() {
  const client = new PiRpcClient({
    piExecutablePath: process.execPath,
    cwd: process.cwd(),
    // No drain needs to be parked in this file, so yields resolve immediately.
    yieldScheduler: { yield: async () => {}, dispose: vi.fn() },
    drainBudget: { maxEvents: 64, maxMs: 10_000 }
  });
  clients.push(client);
  const events = [];
  client.subscribe((event) => events.push(event));
  return { client, events };
}

/** The observable client facts this batch is about, recorded as one object. */
function snapshot(client, events) {
  return {
    states: [...client.streamStates.keys()].sort((a, b) => a - b),
    size: client.streamStates.size,
    childInstalled: client.child !== undefined,
    running: client.running,
    pending: client.pending.size,
    generation: client.generation,
    rpcExits: events.filter((event) => event.type === "rpc_exit").length
  };
}

async function startFirstChild(client) {
  const outcome = observe(client.request("g1-request", {}, { timeoutMs: 0 }));
  await flushMicrotasks();
  return { outcome, child: spawnRegistry.children.at(-1) };
}

describe("PiRpcClient streamStates when a child errors without closing", () => {
  it("A: an error alone leaves the child's stream state in the map", async () => {
    const { client, events } = createHarness();
    const { outcome, child } = await startFirstChild(client);
    expect(client.streamStates.has(1)).toBe(true);
    expect(outcome.status).toBe("pending");
    expect(client.pending.size).toBe(1);

    child.fail(new Error("kill ESRCH"));
    await flushMicrotasks();

    // Recorded, not assumed: 'error' runs failStart() + handleExit() and nothing
    // else, so the state, the child and the "running" flag all survive; only the
    // pending request owned by this generation is failed.
    expect(snapshot(client, events)).toEqual({
      states: [1],
      size: 1,
      childInstalled: true,
      running: true,
      pending: 0,
      generation: 1,
      rpcExits: 1
    });
    expect(client.child).toBe(child);
    expect(outcome.status).toBe("rejected");
    expect(outcome.value.message).toContain("kill ESRCH");
    expect(client.streamStates.get(1)).toBe(client.streamState);
    expect(client.streamState.drainPending).toBe(false);
    expect(client.streamState.drainPromise).toBeUndefined();
    expect(client.streamState.buffer).toBe("");

    // 'error' is registered with once(), so the client has no second-error path
    // at all: Node/EventEmitter semantics make a repeated 'error' on the same
    // child throw (no listener left) instead of adding an rpc_exit or a state.
    expect(() => child.fail(new Error("kill ESRCH again"))).toThrow("kill ESRCH again");
    await flushMicrotasks();
    expect(snapshot(client, events).rpcExits).toBe(1);
    expect(client.streamStates.size).toBe(1);
    expect([...client.streamStates.keys()]).toEqual([1]);
  });

  it("B1: while the errored child still counts as running, a new request reuses it instead of starting G2", async () => {
    const { client } = createHarness();
    const { child } = await startFirstChild(client);
    child.fail(new Error("send EPIPE"));
    await flushMicrotasks();

    // `running` is still true (exitCode is null and the child was never killed),
    // so request() skips start(): no G2, no second generation, no second state.
    const queued = observe(client.request("queued-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();

    expect(spawnRegistry.children).toHaveLength(1);
    expect(client.child).toBe(child);
    expect(client.generation).toBe(1);
    expect([...client.streamStates.keys()]).toEqual([1]);
    expect(child.writes.map((command) => command.type)).toEqual(["g1-request", "queued-request"]);
    const queuedId = child.writes[1].id;
    expect(client.pending.get(queuedId)?.generation).toBe(1);
    expect(queued.status).toBe("pending");
  });

  it("B2: after the errored child reports 'exit', G2 starts and the stale G1 state neither drains nor corrupts it", async () => {
    const { client, events } = createHarness();
    const { outcome, child } = await startFirstChild(client);

    // G1 leaves an unfinished JSON fragment in its own buffer before it dies.
    child.pushPartial('{"type":"agent_event"');
    await client.whenDrainIdle(client.streamState);
    expect(client.streamState.buffer).toBe('{"type":"agent_event"');

    child.fail(new Error("kill ESRCH"));
    await flushMicrotasks();
    expect(outcome.status).toBe("rejected");
    const g1State = client.streamStates.get(1);
    expect(g1State.buffer).toBe('{"type":"agent_event"');

    // Node's 'exit' sets exitCode, which makes `running` false even though the
    // 'close' that would release the state never arrives.
    child.exitOnly(7);
    expect(client.running).toBe(false);
    expect(client.streamStates.has(1)).toBe(true);

    const second = observe(client.request("g2-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const g2 = spawnRegistry.children.at(-1);
    const g2State = client.streamStates.get(2);

    expect(g2).not.toBe(child);
    expect(client.generation).toBe(2);
    expect(client.child).toBe(g2);
    // G2 gets its own state; G1's stale one is still in the map, untouched.
    expect([...client.streamStates.keys()].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(g2State).not.toBe(g1State);
    expect(client.streamState).toBe(g2State);
    expect(g2State.buffer).toBe("");
    expect(g2State.drainPending).toBe(false);
    expect(g1State.buffer).toBe('{"type":"agent_event"');

    // G2 parses and drains normally: G1's fragment is never read as a line, so
    // no cross-generation parse error appears and G2's request still resolves.
    g2.pushStdout({ id: g2.writes[0].id, type: "response", success: true, data: { ok: true } });
    await client.whenDrainIdle(g2State);
    expect(second.status).toBe("fulfilled");
    expect(second.value).toEqual({ ok: true });
    expect(events.filter((event) => event.type === "rpc_parse_error")).toHaveLength(0);
    expect(g1State.buffer).toBe('{"type":"agent_event"');
    expect(client.pending.size).toBe(0);
  });

  it("B3: the kill path (terminate()) behaves like the 'exit' path", async () => {
    const { client, events } = createHarness();
    const { child } = await startFirstChild(client);
    child.fail(new Error("kill failure"));
    await flushMicrotasks();

    client.terminate();
    expect(child.killed).toBe(true);
    expect(client.running).toBe(false);
    expect(client.streamStates.has(1)).toBe(true);

    const next = observe(client.request("g2-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const g2 = spawnRegistry.children.at(-1);
    expect(g2).not.toBe(child);
    expect(client.generation).toBe(2);
    expect([...client.streamStates.keys()].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(events.filter((event) => event.type === "rpc_exit")).toHaveLength(1);

    g2.pushStdout({ id: g2.writes[0].id, type: "response", success: true, data: { ok: true } });
    await client.whenDrainIdle(client.streamState);
    expect(next.status).toBe("fulfilled");
  });

  it("C: after G2 works and closes, only the stale G1 state is left", async () => {
    const { client, events } = createHarness();
    const { child } = await startFirstChild(client);
    child.fail(new Error("kill ESRCH"));
    await flushMicrotasks();
    child.exitOnly(7);

    const second = observe(client.request("g2-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const g2 = spawnRegistry.children.at(-1);
    g2.pushStdout({ id: g2.writes[0].id, type: "response", success: true, data: { ok: true } });
    await client.whenDrainIdle(client.streamStates.get(2));
    expect(second.status).toBe("fulfilled");
    expect([...client.streamStates.keys()].sort((a, b) => a - b)).toEqual([1, 2]);

    // G2's close releases generation 2 only; generation 1 was never released.
    g2.exit(0);
    await flushMicrotasks();

    expect([...client.streamStates.keys()]).toEqual([1]);
    expect(client.streamStates.has(2)).toBe(false);
    expect(client.streamStates.has(1)).toBe(true);
    expect(client.child).toBeUndefined();
    expect(client.running).toBe(false);
    expect(events.filter((event) => event.type === "rpc_exit")).toHaveLength(2);
  });

  it("C2: repeated error-without-close restarts add one stale state per cycle", async () => {
    const { client, events } = createHarness();
    await startFirstChild(client);
    const sizes = [client.streamStates.size];
    const generations = [];

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const child = spawnRegistry.children.at(-1);
      child.fail(new Error(`kill ESRCH ${cycle}`));
      await flushMicrotasks();
      // No 'close' ever arrives for this generation, so its state is never
      // deleted; its exitCode ('exit') is enough to let the next request spawn.
      child.exitOnly(9);
      observe(client.request(`cycle-${cycle}`, {}, { timeoutMs: 0 }));
      await flushMicrotasks();
      sizes.push(client.streamStates.size);
      generations.push(client.generation);
    }

    // Measured growth: the live child plus one abandoned state per cycle.
    expect(generations).toEqual([2, 3, 4]);
    expect(sizes).toEqual([1, 2, 3, 4]);
    expect([...client.streamStates.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(events.filter((event) => event.type === "rpc_exit")).toHaveLength(3);
    // The abandoned states keep their own (empty) buffers and no pending work.
    for (const generation of [1, 2, 3]) {
      const state = client.streamStates.get(generation);
      expect(state.generation).toBe(generation);
      expect(state.drainPending).toBe(false);
      expect(state.drainPromise).toBeUndefined();
    }

    // The map is bounded by the client's own lifetime: dispose() releases all of
    // it, including the abandoned generations.
    client.dispose();
    expect(client.streamStates.size).toBe(0);
  });

  it("C3 (contrast): when each error is followed by close, the map never accumulates", async () => {
    const { client, events } = createHarness();
    observe(client.request("c0", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const sizes = [client.streamStates.size];
    const generations = [client.generation];

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const child = spawnRegistry.children.at(-1);
      child.fail(new Error(`spawn/pipe failure ${cycle}`));
      await flushMicrotasks();
      child.exit(1);
      await flushMicrotasks();
      sizes.push(client.streamStates.size);
      expect(client.child).toBeUndefined();

      observe(client.request(`c${cycle + 1}`, {}, { timeoutMs: 0 }));
      await flushMicrotasks();
      sizes.push(client.streamStates.size);
      generations.push(client.generation);
    }

    // One live state at a time, however many restarts happen; generation numbers
    // still grow because that is the request-ownership token.
    expect(sizes).toEqual([1, 0, 1, 0, 1, 0, 1]);
    expect(generations).toEqual([1, 2, 3, 4]);
    expect(client.streamStates.size).toBe(1);
    expect([...client.streamStates.keys()]).toEqual([4]);
    expect(events.filter((event) => event.type === "rpc_exit")).toHaveLength(6);
  });

  it("D (contrast): a spawn failure followed by close does release its state", async () => {
    const { client, events } = createHarness();
    spawnRegistry.autoSpawn = false;
    const startOutcome = observe(client.request("g1-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const child = spawnRegistry.children.at(-1);
    expect(client.startPromise).toBeDefined();
    expect([...client.streamStates.keys()]).toEqual([1]);

    child.fail(new Error("spawn ENOENT"));
    await flushMicrotasks();

    // 'error' alone: the attempt is rejected, the state is still registered.
    expect(startOutcome.status).toBe("rejected");
    expect(startOutcome.value.message).toContain("spawn ENOENT");
    expect([...client.streamStates.keys()]).toEqual([1]);
    expect(events.filter((event) => event.type === "rpc_exit")).toHaveLength(1);

    // Node's follow-up 'close' for the same child is what releases it.
    child.exit(1);
    await flushMicrotasks();
    expect(client.streamStates.size).toBe(0);
    expect(client.child).toBeUndefined();
    expect(client.running).toBe(false);
    expect(events.filter((event) => event.type === "rpc_exit")).toHaveLength(2);

    spawnRegistry.autoSpawn = true;
    const next = observe(client.request("g2-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const g2 = spawnRegistry.children.at(-1);
    expect(client.generation).toBe(2);
    expect([...client.streamStates.keys()]).toEqual([2]);
    g2.pushStdout({ id: g2.writes[0].id, type: "response", success: true, data: { ok: true } });
    await client.whenDrainIdle(client.streamState);
    expect(next.status).toBe("fulfilled");
  });

  it("E (synthetic send/kill model): the client keeps writing to the errored child and keeps its state", async () => {
    const { client, events } = createHarness();
    const { outcome, child } = await startFirstChild(client);

    // A kill/send failure on an already started child, modelled as 'error' with
    // no following 'close' - no real signal is involved.
    child.fail(new Error("send EPIPE"));
    await flushMicrotasks();

    expect(snapshot(client, events)).toEqual({
      states: [1],
      size: 1,
      childInstalled: true,
      running: true,
      pending: 0,
      generation: 1,
      rpcExits: 1
    });
    expect(outcome.status).toBe("rejected");

    // Nothing retries or cleans up on its own: the failed child still owns the
    // RPC channel, so notify() and request() are written straight to it.
    expect(client.notify("ping")).toBe(true);
    const queued = observe(client.request("queued-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();

    expect(spawnRegistry.children).toHaveLength(1);
    expect(child.writes.map((command) => command.type)).toEqual([
      "g1-request",
      "ping",
      "queued-request"
    ]);
    expect(queued.status).toBe("pending");
    expect(client.pending.size).toBe(1);
    expect(client.streamStates.size).toBe(1);
    expect([...client.streamStates.keys()]).toEqual([1]);
  });

  it("S (sensitivity): error-only, close-only and error-then-close are three different traces", async () => {
    const traces = {};
    for (const timing of ["error-only", "close-only", "error-then-close"]) {
      const { client, events } = createHarness();
      const { child } = await startFirstChild(client);
      if (timing !== "close-only") {
        child.fail(new Error("pipe broke"));
        await flushMicrotasks();
      }
      if (timing !== "error-only") {
        child.exit(1);
        await flushMicrotasks();
      }
      traces[timing] = snapshot(client, events);
    }

    expect(traces["error-only"]).toEqual({
      states: [1],
      size: 1,
      childInstalled: true,
      running: true,
      pending: 0,
      generation: 1,
      rpcExits: 1
    });
    expect(traces["close-only"]).toEqual({
      states: [],
      size: 0,
      childInstalled: false,
      running: false,
      pending: 0,
      generation: 1,
      rpcExits: 1
    });
    expect(traces["error-then-close"]).toEqual({
      states: [],
      size: 0,
      childInstalled: false,
      running: false,
      pending: 0,
      generation: 1,
      rpcExits: 2
    });

    // The three orderings really are distinguishable, at the state map, the
    // child/running flags and the rpc_exit count.
    expect(traces["error-only"]).not.toEqual(traces["close-only"]);
    expect(traces["error-only"]).not.toEqual(traces["error-then-close"]);
    expect(traces["close-only"]).not.toEqual(traces["error-then-close"]);
  });
});
