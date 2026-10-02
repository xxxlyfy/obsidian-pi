// Is the `streamStates` stale-state / monotonic-growth path found with a fake
// child actually reachable with a REAL Node ChildProcess?
//
// This file answers that with real processes only: no `vi.mock`, no hand-emitted
// 'error'/'exit'/'close', no writes to `child.exitCode`/`child.killed`, and the
// production `error`/`close` handlers are untouched. PiRpcClient is driven through
// its own real spawn path by pointing `piExecutablePath` at `process.execPath` and
// `args` at a minimal real Node script (the client passes those straight to
// `spawn`), so every event the client sees comes from the operating system.
//
// Everything recorded here is a Node/OS fact rather than a PiAgent contract, and
// the two kinds of statement in this file must not be confused:
//
//   Cross-platform invariants (asserted unconditionally on every platform):
//     * a normal exit delivers exactly one 'exit' and then one 'close';
//     * the checkpoints an exit handler queues run nextTick -> microtask ->
//       setImmediate;
//     * a spawn failure delivers exactly one 'error' then one 'close' and never an
//       'exit', and fills `exitCode` with the negative libuv errno before 'error',
//       so `running` is already false when PiRpcClient's own handler runs;
//     * `pid` is published by Node only after a successful `uv_spawn`
//       (src/process_wrap.cc), so a failed spawn has no pid;
//     * `kill()` on a dead child returns false and emits no 'error';
//     * `terminateProcessTree()` on a dead child throws nothing and emits nothing;
//     * a detached descendant outlives the parent that spawned it, which is what
//       makes an exit with 'close' still pending a real-world shape.
//
//   Platform facts (branched and pinned per platform - never assumed for the
//   other one):
//     * Windows, measured locally on Node 24: a normal exit reports 'close' from
//       inside the same callback that reported 'exit', before the exit handler's
//       nextTick; an attached descendant dies together with its parent (the
//       parent's job object takes the tree down).
//     * POSIX, measured on ubuntu-latest CI with Node 24: 'close' is delivered
//       either from inside the exit callback or in the next loop turn after the
//       check phase - two CI runs of this unchanged file produced one shape each,
//       so no single order may be demanded - and an attached descendant is merely
//       reparented, so it keeps running after its parent exits.
//     * UNIX vs Windows errno: a missing executable is UV_ENOENT, reported as
//       -4058 on Windows and -2 on POSIX.
//
//   Node runtime probes (kept because they show why some shapes are unreachable
//   for PiRpcClient, not because PiRpcClient must behave this way):
//     * kill failure, and terminateProcessTree() on an already dead child;
//     * the only real 'error' without a following 'close' needs an IPC channel,
//       which this client never creates. The missing 'close' is Node's own close
//       bookkeeping rather than an OS behaviour: an explicit `disconnect()` closes
//       the IPC channel without incrementing the counter `_maybeClose()` waits
//       for, so 'close' can never be emitted. The same combination was measured
//       on win32 and on ubuntu-latest.
//     * exit + delayed close: holdable with a real (detached) descendant that
//       inherits stdio, which is the real-world shape the fake `exitOnly()` was
//       standing in for.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiProcessInvocation } from "../src/pi/environment.mjs";
import { terminateProcessTree } from "../src/shared/process-tree.mjs";
import { PiRpcClient } from "../src/pi/rpc-client.mjs";

const PLATFORM = process.platform;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Platform facts, expressed as pure functions of a platform string.
//
// Keeping them pure is what makes the branches testable: the sensitivity test at
// the bottom proves the two answers really differ, so writing a branch backwards
// fails there instead of silently weakening a real-process test.
// ---------------------------------------------------------------------------

/** Does a descendant spawned WITHOUT `detached` die with the parent that spawned it? */
const attachedDescendantDiesWithParent = (platform) => platform === "win32";

/** Every real 'exit' + 'close' batch shape observed for a normally exiting child. */
const exitCloseOrders = (platform) =>
  platform === "win32"
    ? // Measured on Windows: the stdio pipes are already closed when the exit
      // notification is delivered, so Node emits 'close' from inside the exit
      // callback, ahead of every checkpoint the exit handler queued.
      [["exit", "close", "nextTick-from-exit", "microtask-from-exit", "setImmediate-from-exit"]]
    : // Measured on ubuntu-latest: the pipe EOF and the exit notification are two
      // independent loop events, so 'close' lands either inside the exit batch
      // (like Windows) or in the next loop turn, after the check phase. Two CI
      // runs produced one shape each, and PiRpcClient does not distinguish them.
      [
        ["exit", "close", "nextTick-from-exit", "microtask-from-exit", "setImmediate-from-exit"],
        ["exit", "nextTick-from-exit", "microtask-from-exit", "setImmediate-from-exit", "close"]
      ];

/** UV_ENOENT as Node reports it in `error.errno` and in `child.exitCode`. */
const spawnFailureExitCode = (platform) => (platform === "win32" ? -4058 : -2);

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

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(intervalMs);
  }
  throw new Error("waitFor timed out");
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const killQuietly = (pid) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
};

/** Real event trace of one real ChildProcess, with the observer's own ordering. */
function trace(child, extra = {}) {
  const events = [];
  const record = (entry) => events.push(entry);
  child.once("spawn", () => record("spawn"));
  child.once("error", (error) => {
    extra.atError = {
      code: error.code,
      errno: error.errno,
      exitCode: child.exitCode,
      killed: child.killed,
      pid: child.pid
    };
    record(`error:${error.code ?? error.message}`);
  });
  child.once("exit", (code, signal) => record(`exit:${code}:${signal}`));
  child.once("close", (code) => {
    extra.atClose = { exitCode: child.exitCode };
    record(`close:${code}`);
  });
  return { events, record };
}

const ownedPids = [];
const clients = [];

function own(child) {
  if (typeof child.pid === "number") ownedPids.push(child.pid);
  return child;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  for (const pid of ownedPids.splice(0)) killQuietly(pid);
  await delay(20);
});

// ---------------------------------------------------------------------------
// Minimal real Pi stand-ins, run by a real `node` process through the client.
// ---------------------------------------------------------------------------

/** Answers every JSONL command with a response, then exits shortly after. */
const REQUEST_THEN_EXIT_SCRIPT = `
process.stdin.setEncoding("utf8");
let seen = false;
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    process.stdout.write(JSON.stringify({ id: command.id, type: "response", success: true, data: { echo: command.type } }) + "\\n");
    if (!seen) {
      seen = true;
      setTimeout(() => process.exit(0), 30);
    }
  }
});
process.stdin.resume();
`;

/**
 * Announces a detached grandchild that inherits this process's stdout/stderr,
 * then exits. The grandchild keeps the parent's pipes open, so the parent's
 * 'close' cannot be emitted until the grandchild dies - the real-process shape of
 * "exit with 'close' still pending".
 */
const EXIT_WITH_PIPE_HOLDER_SCRIPT = `
const { spawn } = require("node:child_process");
const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"], detached: true });
process.stdout.write(JSON.stringify({ type: "holder", pid: holder.pid }) + "\\n", () => process.exit(0));
`;

const MISSING_PI_EXECUTABLE = path.join(os.tmpdir(), "pi-missing-binary-real-probe.exe");

function createClient(options = {}) {
  const client = new PiRpcClient({
    piExecutablePath: options.piExecutablePath ?? process.execPath,
    args: options.args ?? ["-e", REQUEST_THEN_EXIT_SCRIPT],
    cwd: options.cwd ?? process.cwd(),
    yieldScheduler: { yield: async () => {}, dispose: () => {} },
    drainBudget: { maxEvents: 64, maxMs: 10_000 }
  });
  clients.push(client);
  const events = [];
  client.subscribe((event) => events.push(event));
  return { client, events };
}

const holderPidsOf = (events) =>
  events.filter((event) => event.type === "holder" && event.pid).map((event) => event.pid);

describe("real Node ChildProcess event order", () => {
  it("records 'exit' before 'close', in the batch shape this platform really delivers", async () => {
    const order = [];
    const child = own(
      spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: ["pipe", "pipe", "pipe"] })
    );
    child.on("exit", () => {
      order.push("exit");
      process.nextTick(() => order.push("nextTick-from-exit"));
      globalThis.queueMicrotask(() => order.push("microtask-from-exit"));
      globalThis.setImmediate(() => order.push("setImmediate-from-exit"));
    });
    child.on("close", () => order.push("close"));

    await new Promise((resolve) => child.on("close", resolve));
    await delay(50);

    // Cross-platform: both events arrive exactly once, 'close' strictly after
    // 'exit', and the checkpoints the exit handler queued keep their order on
    // every platform (nextTick is drained before promise microtasks, and both
    // before the check phase).
    expect(order).toHaveLength(5);
    expect(order.indexOf("exit")).toBeLessThan(order.indexOf("close"));
    expect(order.indexOf("nextTick-from-exit")).toBeLessThan(order.indexOf("microtask-from-exit"));
    expect(order.indexOf("microtask-from-exit")).toBeLessThan(
      order.indexOf("setImmediate-from-exit")
    );

    // Platform-specific: where 'close' lands relative to those checkpoints. On
    // Windows it is always inside the exit batch, so a normal exit offers no
    // awaitable boundary there. On POSIX both shapes occur, so this asserts the
    // set of real shapes rather than one of them.
    expect(exitCloseOrders(PLATFORM)).toContainEqual(order);

    expect(child.exitCode).toBe(3);
    expect(child.killed).toBe(false);
  });

  it("records a real spawn failure: 'error' with the UV errno, no 'exit', and 'close' after the check phase", async () => {
    const extra = {};
    const child = own(spawn(MISSING_PI_EXECUTABLE, [], { stdio: ["pipe", "pipe", "pipe"] }));
    const order = [];
    const { events } = trace(child, extra);
    child.on("error", () => {
      order.push("error");
      process.nextTick(() => order.push("nextTick"));
      globalThis.queueMicrotask(() => order.push("microtask"));
      globalThis.setImmediate(() => order.push("setImmediate"));
    });
    child.on("close", () => order.push("close"));

    await new Promise((resolve) => child.on("close", resolve));
    await delay(50);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatch(/^error:/);
    expect(events[1]).toMatch(/^close:/);
    // A spawn failure emits no 'exit' at all: there was never a process to exit.
    expect(events.some((entry) => entry.startsWith("exit:"))).toBe(false);
    expect(extra.atError.killed).toBe(false);
    // Node publishes `pid` only for a successful uv_spawn, so a failed spawn has
    // none on either platform.
    expect(extra.atError.pid).toBeUndefined();
    // ...but it DOES set exitCode before 'error' - to the same negative errno the
    // error carries - so PiRpcClient's `running` is already false at 'error'.
    expect(extra.atError.exitCode).toBe(extra.atError.errno);
    expect(extra.atError.exitCode).toBeLessThan(0);
    expect(extra.atError.exitCode).toBe(spawnFailureExitCode(PLATFORM));
    // Measured identical on win32 and on ubuntu-latest: the stdio handles were
    // opened before the failed spawn and are closed by Node itself, so their close
    // callbacks land in the closing phase after the check phase. The window
    // error -> close therefore spans a whole macrotask but always closes, which is
    // why it cannot hold a stream state forever.
    expect(order).toEqual(["error", "nextTick", "microtask", "setImmediate", "close"]);
  });

  it("records kill failure: kill() on a dead child returns false and emits no 'error'", async () => {
    const child = own(
      spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["pipe", "pipe", "pipe"] })
    );
    const { events } = trace(child);
    await new Promise((resolve) => child.on("close", resolve));
    await delay(50);
    const before = [...events];

    expect(child.kill()).toBe(false);
    await delay(200);

    expect(child.kill()).toBe(false);
    expect(events).toEqual(before);
    expect(events).not.toContain("error:ESRCH");
  });

  it("records a real kill of a live child: exit + close with the signal", async () => {
    const child = own(
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["pipe", "pipe", "pipe"]
      })
    );
    const { events } = trace(child);
    await new Promise((resolve) => child.once("spawn", resolve));

    expect(child.kill()).toBe(true);
    await new Promise((resolve) => child.on("close", resolve));

    // Platform-neutral: kill() defaults to SIGTERM, a signal death leaves
    // exitCode null on both platforms, and 'close' still follows 'exit'.
    expect(events).toEqual(["spawn", "exit:null:SIGTERM", "close:null"]);
    expect(child.killed).toBe(true);
  });

  it("records terminateProcessTree() on an already dead child: no throw and no child 'error'", async () => {
    const child = own(
      spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["pipe", "pipe", "pipe"] })
    );
    const { events } = trace(child);
    await new Promise((resolve) => child.on("close", resolve));
    await delay(50);
    const before = [...events];

    // The real production helper: on Windows it tries `taskkill /T /F` (which
    // fails for a dead pid) and on POSIX `process.kill(-pid, ...)` (ESRCH); both
    // fall back to `child.kill()`, which reports false for a dead child.
    terminateProcessTree(child, { signal: "SIGTERM" });
    await delay(300);

    expect(events).toEqual(before);
    expect(child.kill()).toBe(false);
    expect(events.some((entry) => entry.startsWith("error:"))).toBe(false);
  });

  it("(Node runtime probe) records send failure as the only real 'error' without close - and it needs an IPC channel", async () => {
    const child = own(
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["pipe", "pipe", "pipe", "ipc"]
      })
    );
    const { events } = trace(child);
    await new Promise((resolve) => child.once("spawn", resolve));

    child.disconnect();
    await delay(50);
    const sent = child.send({ hello: true });
    await delay(400);

    // A genuine error with no 'close': the child is still alive and still running.
    // This is a Node runtime probe, not a PiRpcClient contract - and it is not a
    // Windows quirk either: `disconnect()` closes the IPC channel without
    // incrementing the close counter `_maybeClose()` waits for, so the same
    // combination was measured on win32 and on ubuntu-latest.
    expect(sent).toBe(false);
    expect(events).toEqual(["spawn", "error:ERR_IPC_CHANNEL_CLOSED"]);
    expect(child.exitCode).toBeNull();
    expect(child.killed).toBe(false);

    // Killing it produces 'exit' - and still no 'close', even seconds later.
    child.kill();
    await waitFor(() => events.includes("exit:null:SIGTERM"), { timeoutMs: 5000 });
    await delay(600);
    expect(events).toEqual(["spawn", "error:ERR_IPC_CHANNEL_CLOSED", "exit:null:SIGTERM"]);

    // PiRpcClient never creates an IPC channel: it passes no `stdio` at all, so
    // Node's default pipes apply and `child.send` is not usable. The options here
    // are exactly the ones the client's start() passes to spawn().
    const invocation = buildPiProcessInvocation(process.execPath, ["--mode", "rpc"], {
      cwd: process.cwd(),
      detached: process.platform !== "win32"
    });
    expect(invocation.options.stdio).toBeUndefined();
    expect(invocation.options.detached).toBe(process.platform !== "win32");
    expect(invocation.options.stdio ?? []).not.toContain("ipc");
  }, 20000);

  it("(Node runtime probe) records a disconnected IPC child as exit-without-close: killed but exitCode null, no close ever", async () => {
    const child = own(
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["pipe", "pipe", "pipe", "ipc"]
      })
    );
    const { events } = trace(child);
    await new Promise((resolve) => child.once("spawn", resolve));

    child.disconnect();
    await delay(50);
    child.kill();
    await waitFor(() => events.some((entry) => entry.startsWith("exit:")), { timeoutMs: 5000 });
    await delay(600);

    // This is the closest real-Node equivalent of the fake's `exitOnly()` state:
    // the process is dead and `killed` is true (so `running` would be false), yet
    // 'close' never arrives and exitCode stays null - it would never be released.
    // Unreachable for PiRpcClient, whose spawn options carry no 'ipc'.
    expect(events).toEqual(["spawn", "exit:null:SIGTERM"]);
    expect(child.killed).toBe(true);
    expect(child.exitCode).toBeNull();
  }, 20000);

  it("records that a detached descendant outlives its parent, and that Windows also takes the attached one down", async () => {
    const heartbeat = path.join(os.tmpdir(), `pi-real-child-heartbeat-${process.pid}.txt`);
    fs.rmSync(heartbeat, { force: true });
    const holderScript = `const fs = require("node:fs"); const p = process.argv[1]; setInterval(() => { try { fs.appendFileSync(p, "x"); } catch {} }, 100);`;
    const runner = `
const { spawn } = require("node:child_process");
const args = ["-e", ${JSON.stringify(holderScript)}, ${JSON.stringify(heartbeat)}];
const attached = spawn(process.execPath, args, { stdio: "ignore" });
const detached = spawn(process.execPath, args, { stdio: "ignore", detached: true });
process.stdout.write(JSON.stringify({ attached: attached.pid, detached: detached.pid }) + "\\n");
setTimeout(() => process.exit(0), 300);
`;
    const child = own(spawn(process.execPath, ["-e", runner], { stdio: ["pipe", "pipe", "pipe"] }));
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    await new Promise((resolve) => child.on("close", resolve));

    const pids = JSON.parse(out.trim().split("\n").at(-1));
    // Own BOTH descendants before asserting anything: a failing expectation must
    // not be able to leak a real process.
    own({ pid: pids.detached });
    own({ pid: pids.attached });
    await delay(700);

    // The load-bearing fact for PiRpcClient, true on every platform: a detached
    // descendant keeps its own lifetime after the parent that spawned it is gone.
    // That is exactly how a real child can exit while the pipes it handed to its
    // descendant (and therefore 'close') stay pending.
    expect(isAlive(pids.detached)).toBe(true);

    if (attachedDescendantDiesWithParent(PLATFORM)) {
      // Windows: the attached descendant sits inside the parent's job object, so
      // it is taken down together with the parent.
      expect(isAlive(pids.attached)).toBe(false);
    } else {
      // POSIX: there is no job object. An attached descendant whose parent exits
      // is only reparented, so it also keeps running - this test must not demand
      // its death. (Measured on ubuntu-latest: alive.)
      expect(isAlive(pids.attached)).toBe(true);
    }

    // Clean up both, whatever the expectations above decided.
    killQuietly(pids.detached);
    killQuietly(pids.attached);
    fs.rmSync(heartbeat, { force: true });
  });

  it("records that a detached descendant holding the pipes really defers 'close'", async () => {
    const events = [];
    const child = own(
      spawn(process.execPath, ["-e", EXIT_WITH_PIPE_HOLDER_SCRIPT], {
        stdio: ["pipe", "pipe", "pipe"]
      })
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    const closed = new Promise((resolve) => child.on("close", resolve));
    child.on("exit", (code) => events.push(`exit:${code}`));
    child.on("close", (code) => events.push(`close:${code}`));

    await waitFor(() => events.includes("exit:0"), { timeoutMs: 5000 });
    const holderPid = Number((out.match(/"pid":(\d+)/) ?? [])[1]);
    own({ pid: holderPid });
    expect(isAlive(holderPid)).toBe(true);

    // 'exit' is real, exitCode is set (so `running` is false), yet 'close' is
    // still pending as long as the holder lives. This shape needs `detached`
    // precisely because an attached descendant would not survive on Windows.
    await delay(800);
    expect(child.exitCode).toBe(0);
    expect(events).toEqual(["exit:0"]);
    expect(isAlive(holderPid)).toBe(true);

    killQuietly(holderPid);
    await closed;
    expect(events).toEqual(["exit:0", "close:0"]);
  });
});

describe("PiRpcClient driven by real Node children", () => {
  it("A: a real spawn failure leaves its state only until the real close arrives", async () => {
    const { client } = createClient({ piExecutablePath: MISSING_PI_EXECUTABLE });
    const outcome = observe(client.request("g1-request", {}, { timeoutMs: 0 }));
    await waitFor(() => client.streamStates.size === 1);

    // Attached after the client's own 'error' listener: it runs second, in the
    // same emit, with the client's handler already done.
    const atError = {};
    client.child.once("error", (error) => {
      atError.code = error.code;
      atError.states = [...client.streamStates.keys()];
      atError.running = client.running;
      atError.childInstalled = client.child !== undefined;
      atError.pending = client.pending.size;
    });

    await waitFor(() => outcome.status === "rejected", { timeoutMs: 5000 });
    expect(atError.code).toBe("ENOENT");
    // The state is still registered at the error, but the child already counts as
    // not-running (Node set exitCode to the negative UV errno) and no request is
    // left pending. Both hold on win32 and on ubuntu-latest.
    expect(atError.states).toEqual([1]);
    expect(atError.running).toBe(false);
    expect(atError.childInstalled).toBe(true);
    expect(atError.pending).toBe(0);

    // The real 'close' that Node emits for a spawn failure releases the state.
    await waitFor(() => client.streamStates.size === 0, { timeoutMs: 5000 });
    expect(client.child).toBeUndefined();
    expect(client.running).toBe(false);
  });

  it("B: a real error->close window can host a restart, but the map self-heals", async () => {
    const { client } = createClient({ piExecutablePath: MISSING_PI_EXECUTABLE });
    const first = observe(client.request("g1-request", {}, { timeoutMs: 0 }));
    await waitFor(() => client.streamStates.size === 1);
    const observed = {};

    // Driven from the real 'error' checkpoint: the window spans a macrotask
    // (setImmediate) before 'close' on every platform, so a request landing here
    // really starts a second child while generation 1's state is still registered.
    client.child.once("error", () => {
      observed.atError = [...client.streamStates.keys()];
      observed.runningAtError = client.running;
      observed.restart = observe(client.request("g2-request", {}, { timeoutMs: 0 }));
      observed.afterRestart = [...client.streamStates.keys()];
      observed.generationAfterRestart = client.generation;
    });

    await waitFor(() => observed.restart !== undefined, { timeoutMs: 5000 });
    expect(observed.runningAtError).toBe(false);
    expect(observed.atError).toEqual([1]);
    // Two generations registered at once: the restart is real, not synthetic.
    expect(observed.afterRestart).toEqual([1, 2]);
    expect(observed.generationAfterRestart).toBe(2);

    // Both generations are spawn failures, and both releases are driven by real
    // 'close' events: nothing is left behind.
    await waitFor(() => observed.restart.status === "rejected", { timeoutMs: 5000 });
    await waitFor(() => client.streamStates.size === 0, { timeoutMs: 5000 });
    expect(first.status).toBe("rejected");
    expect([...client.streamStates.keys()]).toEqual([]);
    expect(client.pending.size).toBe(0);
  });

  it("C: real exit-with-close-pending restarts grow the map, and the real closes shrink it back", async () => {
    const { client, events } = createClient({ args: ["-e", EXIT_WITH_PIPE_HOLDER_SCRIPT] });
    const cycles = [];
    const outcomes = [];

    for (let cycle = 1; cycle <= 5; cycle += 1) {
      const outcome = observe(client.request(`cycle-${cycle}`, {}, { timeoutMs: 0 }));
      outcomes.push(outcome);
      // Only continue when the real event sequence satisfies the precondition:
      // the child exited (exitCode set => not running) while its close is still
      // pending because the detached holder keeps the pipes open.
      await waitFor(() => client.generation === cycle && client.child?.exitCode !== null, {
        timeoutMs: 8000
      });
      const child = client.child;
      expect(client.running).toBe(false);
      expect(child.killed).toBe(false);
      await waitFor(() => client.streamStates.size === cycle, { timeoutMs: 8000 });
      await waitFor(() => holderPidsOf(events).length >= cycle, { timeoutMs: 8000 });

      // Keep every holder owned by the test, so a failure cannot leak processes.
      for (const pid of holderPidsOf(events)) if (!ownedPids.includes(pid)) ownedPids.push(pid);

      cycles.push({
        cycle,
        generation: client.generation,
        states: [...client.streamStates.keys()],
        size: client.streamStates.size,
        running: client.running,
        childInstalled: client.child !== undefined,
        restarted: client.generation === cycle,
        staleState: client.streamStates.has(cycle) && client.child?.exitCode !== null,
        pid: child.pid
      });
      expect(child.pid).toBeTypeOf("number");
      // The request is NOT failed by 'exit': only the (still pending) close
      // handler calls handleExit, so every cycle's request is still open here.
      expect(outcome.status).toBe("pending");
    }

    // Every cycle's child really exited with its close still pending: the states
    // of all five abandoned generations are still in the map.
    expect(cycles.map((entry) => entry.size)).toEqual([1, 2, 3, 4, 5]);
    expect(cycles.map((entry) => entry.generation)).toEqual([1, 2, 3, 4, 5]);
    expect(cycles.every((entry) => entry.restarted)).toBe(true);
    expect(cycles.map((entry) => entry.running)).toEqual([false, false, false, false, false]);
    // The abandoned generations never received a close, so they are all stale.
    expect([...client.streamStates.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);

    // Now let the pipe holders die: each real 'close' arrives and releases its
    // generation, proving the states were delayed, not permanently lost.
    const holders = holderPidsOf(events);
    expect(holders).toHaveLength(5);
    for (const pid of holders) killQuietly(pid);
    await waitFor(() => client.streamStates.size === 0, { timeoutMs: 8000 });

    expect([...client.streamStates.keys()]).toEqual([]);
    expect(client.child).toBeUndefined();
    // The deferred closes are also what finally fails each cycle's request.
    await waitFor(() => outcomes.every((entry) => entry.status === "rejected"), {
      timeoutMs: 8000
    });
    expect(
      outcomes.every((entry) => String(entry.value?.message).includes("Pi exited with code 0"))
    ).toBe(true);
  }, 40000);

  it("C2 (contrast): real exit+close cycles never accumulate a state", async () => {
    const { client } = createClient({ args: ["-e", REQUEST_THEN_EXIT_SCRIPT] });
    const sizes = [];
    const generations = [];

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const outcome = observe(client.request(`request-${cycle}`, {}, { timeoutMs: 0 }));
      await waitFor(() => outcome.status === "fulfilled", { timeoutMs: 8000 });
      expect(outcome.value).toEqual({ echo: `request-${cycle}` });
      // The script exits right after answering, and the state is released before
      // the next request starts: 'close' follows 'exit' on every platform, even
      // where it lands in the next loop turn.
      await waitFor(() => client.streamStates.size === 0, { timeoutMs: 8000 });
      sizes.push(client.streamStates.size);
      generations.push(client.generation);
      expect(client.child).toBeUndefined();
      expect(client.running).toBe(false);
    }

    expect(sizes).toEqual([0, 0, 0]);
    expect(generations).toEqual([1, 2, 3]);
    expect(client.pending.size).toBe(0);
  });

  it("D (Node runtime probe): a real error with no close (IPC send failure) keeps state and running, and cannot restart", async () => {
    // The client cannot be given an IPC channel (asserted above), so this
    // sequence is documented at the raw ChildProcess level: it is the only real
    // 'error' that is not followed by 'close'.
    const child = own(
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["pipe", "pipe", "pipe", "ipc"]
      })
    );
    const { events } = trace(child);
    await new Promise((resolve) => child.once("spawn", resolve));
    child.disconnect();
    child.send({ hello: true });
    await waitFor(() => events.some((entry) => entry.startsWith("error:")), { timeoutMs: 5000 });
    await delay(500);

    expect(events).toEqual(["spawn", "error:ERR_IPC_CHANNEL_CLOSED"]);
    // Error without close, but the child is NOT dead: exitCode is null and it was
    // never killed, so `running` would still be true and no restart can happen.
    expect(child.exitCode).toBeNull();
    expect(child.killed).toBe(false);
    expect(events.some((entry) => entry.startsWith("close"))).toBe(false);
    expect(isAlive(child.pid)).toBe(true);
  }, 20000);
});

describe("platform expectations are real branches", () => {
  it("answers Windows and POSIX differently, so a swapped branch fails here", () => {
    // Windows: job object takes the attached descendant down, and 'close' is
    // emitted from inside the exit callback.
    expect(attachedDescendantDiesWithParent("win32")).toBe(true);
    expect(exitCloseOrders("win32")).toEqual([
      ["exit", "close", "nextTick-from-exit", "microtask-from-exit", "setImmediate-from-exit"]
    ]);
    expect(spawnFailureExitCode("win32")).toBe(-4058);

    // POSIX: the attached descendant is only reparented, 'close' has two real
    // shapes (so one unconditional order would be a flaky assertion), and the
    // errno is a POSIX one.
    expect(attachedDescendantDiesWithParent("linux")).toBe(false);
    expect(attachedDescendantDiesWithParent("darwin")).toBe(false);
    expect(exitCloseOrders("linux")).toContainEqual([
      "exit",
      "nextTick-from-exit",
      "microtask-from-exit",
      "setImmediate-from-exit",
      "close"
    ]);
    expect(exitCloseOrders("linux")).toHaveLength(2);
    expect(spawnFailureExitCode("linux")).toBe(-2);

    // Writing any branch backwards (for example `platform !== "win32"`, or an
    // unconditional single expected order) contradicts one of the assertions
    // above - the branches are load-bearing, not decorative.
    expect(attachedDescendantDiesWithParent("win32")).not.toBe(
      attachedDescendantDiesWithParent("linux")
    );
    expect(spawnFailureExitCode("win32")).not.toBe(spawnFailureExitCode("linux"));
    expect(exitCloseOrders("win32")).not.toEqual(exitCloseOrders("linux"));
  });
});
