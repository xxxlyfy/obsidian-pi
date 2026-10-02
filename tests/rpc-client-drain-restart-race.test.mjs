// Cross-generation stdout drain regression tests for PiRpcClient.
//
// The bug these tests now guard against (reproduced before the fix):
//   1. G1 had complete JSONL lines buffered and its cooperative drain parked in
//      a yield (the drain only yields while more complete lines remain);
//   2. G1 closed: the close handler cleared `this.child` and waited for G1's
//      drain;
//   3. a `request()` in that window saw `running === false`, so `start()` spawned
//      G2 and reset the client-level `stdoutBuffer` / `decoder` / `stdoutEnded` /
//      `drainPending` / `drainPromise`;
//   4. G1's buffered tail was gone and its drain stopped on a generation guard,
//      so its trailing events were lost with no `rpc_parse_error` and no other
//      trace - `rpc_exit(G1)` still looked like a plain process exit.
//
// The fix gives every child its own PiRpcStreamState (generation, buffer,
// decoder, stdoutEnded, drainPending, drainPromise). These tests pin:
//   * `start()` never touches the state of the child it replaces;
//   * a replaced child's drain keeps running to the end of its own buffer, so all
//     of its trailing events are delivered, in order, before its own rpc_exit;
//   * a close handler waits for its own child's drain only;
//   * a late stdout 'end' from a replaced child cannot mark the replacement
//     child's stream ended, and cannot leave that child permanently pending.
//
// Determinism: a fake `spawn` (no pid, no real Pi CLI) plus a yield scheduler
// whose parked yields are released by hand, so no assertion depends on timing
// luck or on a sleep.

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
 * by hand, and a close/end/error we time ourselves.
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
    this.pushRaw(jsonl(...messages));
  }

  /** Deliver a truncated record with no trailing LF. */
  pushPartial(text) {
    this.pushRaw(text);
  }

  /** stdout EOF ('end' on the pipe), which production flushDecoder() handles. */
  endStdout() {
    this.stdout.emit("end");
  }

  /** Node sets exitCode before 'close' fires; the close arg is the exit code. */
  exit(exitCode) {
    this.exitCode = exitCode;
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
  Promise.resolve().then(() => child.emit("spawn"));
  return child;
};

/**
 * Scheduler whose yields can be held, so a real drain (started by real stdout
 * data) stays in flight and `whenDrainIdle()` genuinely has to wait. Parked
 * yields are released by hand: oldest first (`releaseNext`), newest first
 * (`releaseLast`), or all at once (`releaseYields`), which lets one generation's
 * drain finish while another generation's drain stays parked.
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

  /** Release exactly the oldest parked yield (one drain step). */
  releaseNext() {
    const resolve = this.waiters.shift();
    resolve?.();
    return resolve !== undefined;
  }

  /** Release exactly the newest parked yield (one drain step). */
  releaseLast() {
    const resolve = this.waiters.pop();
    resolve?.();
    return resolve !== undefined;
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

/** One explicit LF-terminated JSON document, byte-identical to what Pi writes. */
function jsonl(...messages) {
  return `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
}

/** A tail event tagged with its owning generation, so delivery can be counted. */
function tailLine(generation, index) {
  return { type: "agent_message", text: `g${generation}-tail-${index}`, gen: generation, index };
}

function eventLabel(event) {
  if (event.type === "agent_message") return `msg:g${event.gen}-${event.index}`;
  if (event.type === "rpc_exit") return "rpc_exit";
  if (event.type === "rpc_parse_error") return `parse_error:${event.raw}`;
  return event.type;
}

const clients = [];

beforeEach(() => {
  spawnRegistry.children.length = 0;
});

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

/**
 * One client, one gated scheduler, one merged timeline of test steps and client
 * events, a record of every drain `scheduleDrain()` created, and a lookup for a
 * single generation's own stream state.
 */
function createHarness(options = {}) {
  const scheduler = new ControlledYieldScheduler();
  const client = new PiRpcClient({
    piExecutablePath: process.execPath,
    cwd: process.cwd(),
    yieldScheduler: scheduler,
    // One event per batch by default: a second buffered line forces a real
    // yield(), which is the only way to leave a drain in flight.
    drainBudget: options.drainBudget ?? { maxEvents: 1, maxMs: 10_000 }
  });
  clients.push(client);

  const events = [];
  const timeline = [];
  client.subscribe((event) => {
    events.push(event);
    timeline.push({ kind: "event", label: eventLabel(event), event });
  });

  const drains = [];
  const realScheduleDrain = client.scheduleDrain.bind(client);
  client.scheduleDrain = (state) => {
    const before = state.drainPromise;
    realScheduleDrain(state);
    if (state.drainPromise !== before)
      drains.push({ generation: state.generation, promise: state.drainPromise });
  };

  const mark = (label) => timeline.push({ kind: "step", label });
  const order = () =>
    timeline.map((entry) => (entry.kind === "step" ? `step:${entry.label}` : entry.label));
  const delivered = (predicate) => events.filter(predicate).map(eventLabel);
  const stateOf = (generation) => client.streamStates.get(generation);
  const tailEvents = (generation) =>
    delivered((event) => event.type === "agent_message" && event.gen === generation);

  return { client, scheduler, events, order, mark, drains, delivered, stateOf, tailEvents };
}

async function startClient(client) {
  const outcome = observe(client.request("g1-request", {}, { timeoutMs: 0 }));
  await flushMicrotasks();
  return outcome;
}

/**
 * G1 has two complete buffered lines and a parked drain, a partial third line,
 * and reports stdout 'end' (Node's normal order for a dying child). Returns the
 * delivered event stream with or without a replacement child starting during the
 * close wait.
 */
async function runPartialLineScenario({ restart }) {
  const harness = createHarness();
  const { client, scheduler, order, mark, delivered, stateOf } = harness;
  // This helper runs twice in one test, and the process-wide spawn registry is
  // only reset per test, so address this run's own children by offset.
  const base = spawnRegistry.children.length;
  await startClient(client);
  const g1 = spawnRegistry.children[base];
  const g1State = stateOf(1);
  const partial = '{"type":"agent_message","text":"g1-partial"';

  scheduler.holdYields();
  g1.pushStdout(tailLine(1, 1), tailLine(1, 2));
  g1.pushPartial(partial);
  g1.endStdout();
  expect(g1State.stdoutEnded).toBe(true);
  expect(g1State.buffer).toBe(`${jsonl(tailLine(1, 2))}${partial}`);

  g1.exit(6);
  await flushMicrotasks();

  if (restart) {
    mark("g2-start");
    observe(client.request("g2-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    // The replacement child owns a brand-new stream state; G1's is untouched, so
    // the flushed remainder is still there to be parsed.
    expect(spawnRegistry.children[base + 1]).toBeDefined();
    expect(stateOf(2).stdoutEnded).toBe(false);
    expect(stateOf(2).buffer).toBe("");
    expect(g1State.stdoutEnded).toBe(true);
    expect(g1State.buffer).toBe(`${jsonl(tailLine(1, 2))}${partial}`);
  }

  scheduler.releaseYields();
  await flushMicrotasks();

  return {
    eventOrder: order().filter((label) => !label.startsWith("step:")),
    parseErrors: delivered((event) => event.type === "rpc_parse_error"),
    g1State,
    g2State: stateOf(2)
  };
}

describe("PiRpcClient per-child stdout drain across a restart", () => {
  it("A0 (precondition): one lone buffered tail line cannot leave a drain in flight", async () => {
    const { client, scheduler, order, stateOf } = createHarness();
    await startClient(client);
    const g1 = spawnRegistry.children[0];
    const g1State = stateOf(1);

    scheduler.holdYields();
    g1.pushStdout(tailLine(1, 1));

    // The batch budget is one event, but the drain loop only reaches its yield
    // while more complete lines remain. A single line is parsed synchronously and
    // the drain is idle before the close arrives, so the restart window needs at
    // least a second buffered line (that is what A/B/B2 set up).
    expect(scheduler.waiters).toHaveLength(0);
    await flushMicrotasks();
    expect(g1State.drainPromise).toBeUndefined();
    expect(g1State.drainPending).toBe(false);

    g1.exit(1);
    await flushMicrotasks();

    expect(order()).toEqual(["msg:g1-1", "rpc_exit"]);
    expect(g1State.buffer).toBe("");
  });

  it("A: a parked G1 drain keeps its buffer, delivers both tail lines, and exits after them while G2 starts", async () => {
    const { client, scheduler, order, mark, drains, stateOf, tailEvents } = createHarness();
    const g1Outcome = await startClient(client);
    const g1 = spawnRegistry.children[0];
    const g1State = stateOf(1);
    const g1RequestId = g1.writes[0].id;

    // Minimal real window: the agent_message is drained by the first batch, and
    // the second buffered line is what parks the drain in its yield.
    scheduler.holdYields();
    g1.pushStdout(tailLine(1, 1), tailLine(1, 2));
    const g1Drain = g1State.drainPromise;
    expect(g1Drain).toBeDefined();
    expect(g1State.drainPending).toBe(true);
    expect(scheduler.waiters).toHaveLength(1);
    expect(tailEvents(1)).toEqual(["msg:g1-1"]);
    expect(g1State.buffer).toBe(jsonl(tailLine(1, 2)));

    // G1 closes: `this.child` is cleared synchronously, then the handler parks on
    // G1's own drain.
    mark("g1-close");
    g1.exit(7);
    expect(client.child).toBeUndefined();
    expect(client.running).toBe(false);
    await flushMicrotasks();
    expect(g1State.drainPromise).toBe(g1Drain);
    expect(order()).toEqual(["msg:g1-1", "step:g1-close"]);

    // The window: a request sees running === false and spawns G2.
    mark("g2-start");
    const g2Outcome = observe(client.request("g2-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const g2 = spawnRegistry.children[1];
    const g2State = stateOf(2);
    expect(g2).not.toBe(g1);
    expect(client.generation).toBe(2);
    expect(client.child).toBe(g2);
    expect(client.streamState).toBe(g2State);
    expect(g2State).not.toBe(g1State);

    // start() created G2's state without touching G1's: same buffer, same parked
    // drain, still pending.
    expect(g1State.buffer).toBe(jsonl(tailLine(1, 2)));
    expect(g1State.drainPromise).toBe(g1Drain);
    expect(g1State.drainPending).toBe(true);
    expect(order()).toEqual(["msg:g1-1", "step:g1-close", "step:g2-start"]);

    mark("release");
    scheduler.releaseYields();
    await flushMicrotasks();

    // G1's own drain finishes its buffer, and only then is its exit reported.
    expect(order()).toEqual([
      "msg:g1-1",
      "step:g1-close",
      "step:g2-start",
      "step:release",
      "msg:g1-2",
      "rpc_exit"
    ]);
    expect(tailEvents(1)).toEqual(["msg:g1-1", "msg:g1-2"]);
    expect(order().indexOf("rpc_exit")).toBeGreaterThan(order().indexOf("msg:g1-2"));
    expect(g1State.buffer).toBe("");
    expect(g1State.drainPromise).toBeUndefined();
    // The finished child's state is released instead of accumulating.
    expect(client.streamStates.has(1)).toBe(false);
    expect(drains.map((record) => record.generation)).toEqual([1]);

    expect(g1Outcome.status).toBe("rejected");
    expect(g1Outcome.value.message).toContain("code 7");
    expect(client.pending.has(g1RequestId)).toBe(false);

    g2.pushStdout({ id: g2.writes[0].id, type: "response", success: true, data: { ok: true } });
    await client.whenDrainIdle(g2State);
    expect(g2Outcome.status).toBe("fulfilled");
    expect(g2Outcome.value).toEqual({ ok: true });
  });

  it("A-wait (control): with no restart the close handler drains the whole tail before rpc_exit", async () => {
    const { client, scheduler, order, stateOf } = createHarness();
    await startClient(client);
    const g1 = spawnRegistry.children[0];
    const g1State = stateOf(1);

    scheduler.holdYields();
    g1.pushStdout(tailLine(1, 1), tailLine(1, 2), tailLine(1, 3), tailLine(1, 4));
    expect(g1State.buffer).toBe(jsonl(tailLine(1, 2), tailLine(1, 3), tailLine(1, 4)));

    g1.exit(5);
    await flushMicrotasks();
    expect(order()).toEqual(["msg:g1-1"]);

    scheduler.releaseYields();
    await flushMicrotasks();

    expect(order()).toEqual(["msg:g1-1", "msg:g1-2", "msg:g1-3", "msg:g1-4", "rpc_exit"]);
    expect(g1State.buffer).toBe("");
  });

  it("B: all four buffered tail lines survive a G2 restart, and G2 still works", async () => {
    const { client, scheduler, order, mark, stateOf, tailEvents } = createHarness();
    await startClient(client);
    const g1 = spawnRegistry.children[0];
    const g1State = stateOf(1);

    scheduler.holdYields();
    g1.pushStdout(tailLine(1, 1), tailLine(1, 2), tailLine(1, 3), tailLine(1, 4));
    expect(tailEvents(1)).toEqual(["msg:g1-1"]);
    expect(g1State.buffer).toBe(jsonl(tailLine(1, 2), tailLine(1, 3), tailLine(1, 4)));
    expect(scheduler.waiters).toHaveLength(1);

    mark("g1-close");
    g1.exit(3);
    await flushMicrotasks();
    expect(order()).toEqual(["msg:g1-1", "step:g1-close"]);

    mark("g2-start");
    const g2Outcome = observe(client.request("g2-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const g2 = spawnRegistry.children[1];
    const g2State = stateOf(2);
    expect(client.generation).toBe(2);
    expect(g1State.buffer).toBe(jsonl(tailLine(1, 2), tailLine(1, 3), tailLine(1, 4)));

    mark("release");
    scheduler.releaseYields();
    await flushMicrotasks();

    expect(order()).toEqual([
      "msg:g1-1",
      "step:g1-close",
      "step:g2-start",
      "step:release",
      "msg:g1-2",
      "msg:g1-3",
      "msg:g1-4",
      "rpc_exit"
    ]);
    // 4/4 delivered, nothing lost, nothing duplicated, exit last.
    expect(tailEvents(1)).toEqual(["msg:g1-1", "msg:g1-2", "msg:g1-3", "msg:g1-4"]);
    expect(new Set(tailEvents(1)).size).toBe(4);

    // G2 still works, and G1's events are not re-delivered by G2's drain.
    g2.pushStdout(tailLine(2, 1));
    await client.whenDrainIdle(g2State);
    expect(tailEvents(2)).toEqual(["msg:g2-1"]);
    expect(tailEvents(1)).toEqual(["msg:g1-1", "msg:g1-2", "msg:g1-3", "msg:g1-4"]);

    g2.pushStdout({ id: g2.writes[0].id, type: "response", success: true, data: { ok: true } });
    await client.whenDrainIdle(g2State);
    expect(g2Outcome.status).toBe("fulfilled");
  });

  it("B2: the production 64-event budget delivers all 200 tail lines across the restart", async () => {
    const { client, scheduler, order, mark, stateOf, tailEvents } = createHarness({
      drainBudget: { maxEvents: 64, maxMs: 10_000 }
    });
    await startClient(client);
    const g1 = spawnRegistry.children[0];
    const g1State = stateOf(1);

    const expected = Array.from({ length: 200 }, (_, index) => `msg:g1-${index + 1}`);
    scheduler.holdYields();
    g1.pushStdout(...Array.from({ length: 200 }, (_, index) => tailLine(1, index + 1)));

    // One full production batch is drained, then the drain parks because the
    // remaining 136 complete lines are still buffered.
    expect(tailEvents(1)).toEqual(expected.slice(0, 64));
    expect(g1State.buffer.split("\n").filter(Boolean)).toHaveLength(136);
    expect(scheduler.waiters).toHaveLength(1);
    expect(g1State.drainPending).toBe(true);

    mark("g1-close");
    g1.exit(9);
    mark("g2-start");
    observe(client.request("g2-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    expect(client.generation).toBe(2);
    expect(g1State.buffer.split("\n").filter(Boolean)).toHaveLength(136);

    mark("release");
    scheduler.releaseYields();
    await flushMicrotasks();

    // 200/200 delivered in strict order: no 136-line loss, no reordering, no
    // duplication, and the exit comes after the last of them.
    expect(tailEvents(1)).toEqual(expected);
    expect(new Set(tailEvents(1)).size).toBe(200);
    expect(order().filter((label) => label === "rpc_exit")).toHaveLength(1);
    expect(order().indexOf("rpc_exit")).toBeGreaterThan(order().indexOf("msg:g1-200"));
    expect(order().indexOf("step:g1-close")).toBe(64);
    expect(order().slice(order().indexOf("step:release") + 1, order().indexOf("rpc_exit"))).toEqual(
      expected.slice(64)
    );
    expect(g1State.buffer).toBe("");
    expect(g1State.drainPromise).toBeUndefined();
  });

  it("C1/C2 (consistency): a flushed partial line is handled the same with and without a restart", async () => {
    const withoutRestart = await runPartialLineScenario({ restart: false });
    const withRestart = await runPartialLineScenario({ restart: true });
    const partial = '{"type":"agent_message","text":"g1-partial"';

    // Protocol semantics are unchanged: text flushed by stdout 'end' is parsed as
    // one line, and invalid JSON is reported as rpc_parse_error. A restart must
    // not swallow it.
    expect(withoutRestart.eventOrder).toEqual([
      "msg:g1-1",
      "msg:g1-2",
      `parse_error:${partial}`,
      "rpc_exit"
    ]);
    expect(withRestart.eventOrder).toEqual(withoutRestart.eventOrder);
    expect(withoutRestart.parseErrors).toHaveLength(1);
    expect(withRestart.parseErrors).toHaveLength(1);
    expect(withRestart.parseErrors).toEqual(withoutRestart.parseErrors);

    // The replaced child's state is what handled it, and the replacement child's
    // stream was never confused with it.
    expect(withRestart.g1State.stdoutEnded).toBe(true);
    expect(withRestart.g1State.buffer).toBe("");
    expect(withRestart.g2State.stdoutEnded).toBe(false);
    expect(withRestart.g2State.buffer).toBe("");
  });

  it("C3: a late stdout 'end' from G1 leaves the replacement child's stream untouched", async () => {
    const { client, scheduler, order, mark, stateOf, tailEvents } = createHarness();
    await startClient(client);
    const g1 = spawnRegistry.children[0];
    const g1State = stateOf(1);

    scheduler.holdYields();
    g1.pushStdout(tailLine(1, 1), tailLine(1, 2));

    mark("g1-close");
    g1.exit(4);
    await flushMicrotasks();

    mark("g2-start");
    const g2Outcome = observe(client.request("g2-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const g2 = spawnRegistry.children[1];
    const g2State = stateOf(2);
    const g2RequestId = g2.writes[0].id;

    // G2 has half of its own response line in flight.
    const fullResponse = JSON.stringify({
      id: g2RequestId,
      type: "response",
      success: true,
      data: { ok: true }
    });
    const g2Partial = fullResponse.slice(0, Math.floor(fullResponse.length / 2));
    g2.pushPartial(g2Partial);
    await flushMicrotasks();
    expect(g2State.buffer).toBe(g2Partial);
    expect(g2State.stdoutEnded).toBe(false);

    mark("release");
    scheduler.releaseYields();
    await flushMicrotasks();
    expect(tailEvents(1)).toEqual(["msg:g1-1", "msg:g1-2"]);
    expect(order()).toContain("rpc_exit");
    expect(g1State.stdoutEnded).toBe(false);

    // G1's stdout 'end' arrives late - after the replacement child is live. It is
    // bound to G1's own state, so G2's half line is not re-read as a complete one.
    mark("g1-stdout-end");
    g1.endStdout();
    await flushMicrotasks();
    expect(g1State.stdoutEnded).toBe(true);
    expect(g2State.stdoutEnded).toBe(false);
    expect(g2State.buffer).toBe(g2Partial);
    expect(g2State).not.toBe(g1State);

    // G2's request still completes: it is never left permanently pending, and no
    // cross-generation parse error is produced.
    g2.pushRaw(`${fullResponse.slice(Math.floor(fullResponse.length / 2))}\n`);
    await client.whenDrainIdle(g2State);
    expect(tailEvents(2)).toEqual([]);
    expect(order().some((label) => label.startsWith("parse_error"))).toBe(false);
    expect(g2Outcome.status).toBe("fulfilled");
    expect(g2Outcome.value).toEqual({ ok: true });
    expect(client.pending.has(g2RequestId)).toBe(false);
    expect(g2State.stdoutEnded).toBe(false);
  });

  it("D: both generations drain at the same time, and rpc_exit(G1) waits only for G1's drain", async () => {
    const { client, scheduler, order, mark, drains, stateOf, tailEvents } = createHarness();
    const g1Outcome = observe(client.request("g1-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const g1 = spawnRegistry.children[0];
    const g1State = stateOf(1);

    // Generation 1: one line drained, two left buffered, drain parked.
    scheduler.holdYields();
    g1.pushStdout(tailLine(1, 1), tailLine(1, 2), tailLine(1, 3));
    const g1Drain = g1State.drainPromise;
    expect(scheduler.waiters).toHaveLength(1);

    mark("g1-close");
    g1.exit(8);
    await flushMicrotasks();
    expect(g1State.drainPromise).toBe(g1Drain);

    // Generation 2 starts during the wait and parks its own drain.
    mark("g2-start");
    const g2Outcome = observe(client.request("g2-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const g2 = spawnRegistry.children[1];
    const g2State = stateOf(2);
    expect(g2State).not.toBe(g1State);
    expect(client.streamState).toBe(g2State);

    mark("g2-stdout");
    g2.pushStdout(tailLine(2, 1), tailLine(2, 2), tailLine(2, 3), tailLine(2, 4));
    const g2Drain = g2State.drainPromise;
    expect(g2Drain).toBeDefined();
    expect(g2Drain).not.toBe(g1Drain);

    // Both drains are parked at the same time, each on its own state.
    expect(scheduler.waiters).toHaveLength(2);
    expect(g1State.drainPending).toBe(true);
    expect(g2State.drainPending).toBe(true);
    expect(drains.map((record) => record.generation)).toEqual([1, 2]);
    expect(tailEvents(1)).toEqual(["msg:g1-1"]);
    expect(tailEvents(2)).toEqual(["msg:g2-1"]);

    // Drive G1's drain to completion while G2's stays parked.
    mark("release-g1-1");
    expect(scheduler.releaseNext()).toBe(true);
    await flushMicrotasks();
    expect(tailEvents(1)).toEqual(["msg:g1-1", "msg:g1-2"]);
    expect(g2State.drainPromise).toBe(g2Drain);

    mark("release-g1-2");
    expect(scheduler.releaseLast()).toBe(true);
    await flushMicrotasks();

    // G1's tail is complete and its exit is reported, even though G2's drain is
    // still parked - the close handler awaited G1's own drain only.
    expect(tailEvents(1)).toEqual(["msg:g1-1", "msg:g1-2", "msg:g1-3"]);
    expect(order()).toContain("rpc_exit");
    expect(g1State.drainPromise).toBeUndefined();
    expect(g1State.buffer).toBe("");
    expect(g2State.drainPromise).toBe(g2Drain);
    expect(g2State.buffer).toBe(jsonl(tailLine(2, 2), tailLine(2, 3), tailLine(2, 4)));
    expect(scheduler.waiters).toHaveLength(1);
    expect(tailEvents(2)).toEqual(["msg:g2-1"]);
    expect(g1Outcome.status).toBe("rejected");

    // G2's own drain then finishes normally.
    scheduler.releaseYields();
    await flushMicrotasks();
    expect(order()).toEqual([
      "msg:g1-1",
      "step:g1-close",
      "step:g2-start",
      "step:g2-stdout",
      "msg:g2-1",
      "step:release-g1-1",
      "msg:g1-2",
      "step:release-g1-2",
      "msg:g1-3",
      "rpc_exit",
      "msg:g2-2",
      "msg:g2-3",
      "msg:g2-4"
    ]);
    expect(tailEvents(2)).toEqual(["msg:g2-1", "msg:g2-2", "msg:g2-3", "msg:g2-4"]);
    expect(g2State.drainPromise).toBeUndefined();
    expect(g2State.buffer).toBe("");

    g2.pushStdout({ id: g2.writes[0].id, type: "response", success: true, data: { ok: true } });
    await client.whenDrainIdle(g2State);
    expect(g2Outcome.status).toBe("fulfilled");
  });

  it("E (control): a restart with no stdout backlog is unchanged", async () => {
    const { client, order, mark, drains, stateOf } = createHarness();
    await startClient(client);
    const g1 = spawnRegistry.children[0];
    const g1State = stateOf(1);
    expect(g1State.drainPromise).toBeUndefined();

    mark("g1-close");
    g1.exit(2);
    await flushMicrotasks();

    // No drain existed, so the close handler never suspends.
    expect(order()).toEqual(["step:g1-close", "rpc_exit"]);
    expect(drains).toEqual([]);
    expect(client.child).toBeUndefined();
    expect(client.streamStates.has(1)).toBe(false);

    mark("g2-start");
    const g2Outcome = observe(client.request("g2-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const g2 = spawnRegistry.children[1];
    const g2State = stateOf(2);
    expect(client.generation).toBe(2);
    expect(client.child).toBe(g2);
    expect(order()).toEqual(["step:g1-close", "rpc_exit", "step:g2-start"]);

    g2.pushStdout({ id: g2.writes[0].id, type: "response", success: true, data: { step: 1 } });
    await client.whenDrainIdle(g2State);
    expect(g2Outcome.status).toBe("fulfilled");
    expect(g2Outcome.value).toEqual({ step: 1 });
    expect(client.pending.size).toBe(0);
    expect(client.running).toBe(true);
  });

  it("F (regression): a delayed G1 close must not reject G2's pending request", async () => {
    const { client, scheduler, order, mark, stateOf, tailEvents } = createHarness();
    const g1Outcome = observe(client.request("g1-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const g1 = spawnRegistry.children[0];
    const g1State = stateOf(1);
    const g1RequestId = g1.writes[0].id;

    scheduler.holdYields();
    g1.pushStdout(tailLine(1, 1), tailLine(1, 2));

    mark("g1-close");
    g1.exit(11);
    await flushMicrotasks();
    expect(client.pending.has(g1RequestId)).toBe(true);
    expect(order()).toEqual(["msg:g1-1", "step:g1-close"]);

    mark("g2-start");
    const g2Outcome = observe(client.request("g2-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const g2 = spawnRegistry.children[1];
    const g2RequestId = g2.writes[0].id;
    expect(client.pending.get(g2RequestId)?.generation).toBe(2);

    mark("release");
    scheduler.releaseYields();
    await flushMicrotasks();

    // G1's trailing event is delivered first; its exit fails generation 1 only.
    expect(order()).toEqual([
      "msg:g1-1",
      "step:g1-close",
      "step:g2-start",
      "step:release",
      "msg:g1-2",
      "rpc_exit"
    ]);
    expect(tailEvents(1)).toEqual(["msg:g1-1", "msg:g1-2"]);
    expect(order().filter((label) => label === "rpc_exit")).toHaveLength(1);
    expect(g1Outcome.status).toBe("rejected");
    expect(g1Outcome.value.message).toContain("code 11");
    expect(client.pending.has(g1RequestId)).toBe(false);
    expect(client.pending.has(g2RequestId)).toBe(true);
    expect(g2Outcome.status).toBe("pending");
    expect(g1State.drainPromise).toBeUndefined();

    g2.pushStdout({ id: g2RequestId, type: "response", success: true, data: { ok: true } });
    await client.whenDrainIdle(stateOf(2));
    expect(g2Outcome.status).toBe("fulfilled");
    expect(g2Outcome.value).toEqual({ ok: true });
    expect(client.pending.size).toBe(0);
    expect(client.running).toBe(true);
  });

  it("S (white-box): every child owns a distinct stdout/drain state", async () => {
    const { client, scheduler, stateOf } = createHarness();
    await startClient(client);
    const g1 = spawnRegistry.children[0];
    const g1State = stateOf(1);
    expect(g1State).toBeDefined();
    expect(g1State.generation).toBe(1);
    expect(client.streamState).toBe(g1State);
    expect(client.streamStates.size).toBe(1);

    // Park G1's drain with a buffered tail.
    scheduler.holdYields();
    g1.pushStdout(tailLine(1, 1), tailLine(1, 2));
    const g1Buffer = g1State.buffer;
    const g1Drain = g1State.drainPromise;
    expect(g1Buffer).toBe(jsonl(tailLine(1, 2)));
    expect(g1Drain).toBeDefined();

    g1.exit(12);
    await flushMicrotasks();

    // Start G2 while G1's drain is still parked, then park G2's drain too.
    observe(client.request("g2-request", {}, { timeoutMs: 0 }));
    await flushMicrotasks();
    const g2 = spawnRegistry.children[1];
    const g2State = stateOf(2);
    g2.pushStdout(tailLine(2, 1), tailLine(2, 2));
    const g2Drain = g2State.drainPromise;

    // Two children, two state objects, two drain promises: isolation is asserted
    // directly rather than inferred from the delivered event stream.
    expect(g1State).not.toBe(g2State);
    expect(stateOf(1)).toBe(g1State);
    expect(stateOf(2)).toBe(g2State);
    expect(client.streamState).toBe(g2State);
    expect(client.streamStates.size).toBe(2);
    expect(g2State.generation).toBe(2);
    expect(g1State.decoder).not.toBe(g2State.decoder);
    expect(g1State.buffer).not.toBe(g2State.buffer);
    expect(g1State.buffer).toBe(g1Buffer);
    expect(g2State.buffer).toBe(jsonl(tailLine(2, 2)));
    expect(g1State.drainPromise).toBe(g1Drain);
    expect(g2State.drainPromise).toBe(g2Drain);
    expect(g1Drain).not.toBe(g2Drain);
    expect(g1State.drainPending).toBe(true);
    expect(g2State.drainPending).toBe(true);
    expect(g1State.stdoutEnded).toBe(false);
    expect(g2State.stdoutEnded).toBe(false);
    expect(scheduler.waiters).toHaveLength(2);

    // A late stdout 'end' from the replaced child stays inside its own state.
    g1.endStdout();
    await flushMicrotasks();
    expect(g1State.stdoutEnded).toBe(true);
    expect(g2State.stdoutEnded).toBe(false);
    expect(g2State.buffer).toBe(jsonl(tailLine(2, 2)));
  });
});
