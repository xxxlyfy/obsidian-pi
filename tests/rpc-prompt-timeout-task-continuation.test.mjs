// Does a `prompt` RPC timeout cancel the Pi-side task, or does the plugin only
// stop waiting while Pi keeps working?
//
// The review question is narrow and about `PiRpcClient.request()`: when
// `timeoutMs` expires the caller's promise rejects - but does anything reach Pi?
// This file answers that with a fake Pi RPC transport that models a *task*: it
// records that the prompt arrived, deliberately answers later than the timeout,
// and can finish the task afterwards. The client and the runner under test are
// the real production ones; only the child process is fake in A/B/C/S. Test D
// repeats the question over a real `node` child process, where no fake is needed
// to show that the OS process and its work continue.
//
// Facts this file pins (each asserted, not assumed):
//   A client, delayed `prompt` response -> the request times out locally and
//     sends NOTHING to Pi (no abort, no kill, no second command); the task keeps
//     running, then completes; the late prompt response is dropped, so only the
//     task's ordinary agent events reach the plugin.
//   B runner -> `runPiRpc()` has already taken the failure path and reset
//     `isRunning` while the task it started is still running on Pi; the runner
//     then gives up the client itself (process, session attachment and
//     subscription included), so that abandoned task cannot reach this runner or
//     any later run.
//   C race -> after a timed-out prompt, the next run on the same thread reopens
//     the same session in a fresh process, and the abandoned first task's
//     `agent_settled` never settles it: the second run stays pending until its
//     OWN task settles and then returns its own answer. (This is the regression
//     test: before the fix the abandoned task settled the second run and its text
//     became that run's `finalResponse`.)
//   D real process -> the real child process is alive and still doing work
//     after the timeout, and Pi never received a cancel request.
//   S sensitivity -> the same harness DOES observe a real cancellation when the
//     plugin aborts, so "the task kept running" is not vacuous.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the module mock below can reach it. `create`/`originalSpawn` are
// assigned while this file is evaluated; spawn() only runs inside tests.
const spawnRegistry = vi.hoisted(() => ({
  create: undefined,
  originalSpawn: undefined,
  children: [],
  autoSpawn: true,
  // Test D needs the real node:child_process.spawn; every other test drives the
  // fake Pi process below.
  useRealSpawn: false
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal();
  spawnRegistry.originalSpawn = original.spawn;
  return {
    ...original,
    spawn: (...args) => {
      if (spawnRegistry.useRealSpawn) return spawnRegistry.originalSpawn(...args);
      const child = spawnRegistry.create(...args);
      spawnRegistry.children.push(child);
      return child;
    }
  };
});

import { DEFAULT_SETTINGS } from "../src/plugin/settings.mjs";
import { PiRpcClient } from "../src/pi/rpc-client.mjs";
import { PiRunner } from "../src/pi/runner.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Deterministic barrier: drains the microtask queue instead of sleeping. */
async function flushMicrotasks(turns = 64) {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(intervalMs);
  }
  throw new Error("waitFor timed out");
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

const spawnCount = () => spawnRegistry.children.length;
/** The fake Pi process the client under test is talking to. */
const piProcess = () => spawnRegistry.children.at(-1);

/**
 * A fake Pi RPC transport that models work, not just events.
 *
 * `prompt` starts a task and is deliberately NOT acknowledged: the test decides
 * when - and whether - Pi answers and settles it, which is what makes "the task
 * is still running after the plugin's timeout" observable.
 */
class FakePiProcess extends EventEmitter {
  constructor() {
    super();
    // No pid on purpose: `terminateProcessTree()` must never be able to signal a
    // real process this test does not own.
    this.pid = undefined;
    this.exitCode = null;
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.commands = [];
    this.tasks = [];
    this.stdin = {
      writable: true,
      write: (line, callback) => {
        const command = JSON.parse(line);
        this.commands.push(command);
        this.receive(command);
        callback?.();
        return true;
      }
    };
  }

  /** Pi's command loop: what arrives on stdin, and what it means for the task. */
  receive(command) {
    if (command.type === "get_state") {
      this.respond(command, {});
      return;
    }
    if (command.type === "prompt") {
      this.tasks.push({
        id: command.id,
        message: command.message,
        finished: false,
        aborted: false
      });
      return;
    }
    if (command.type === "abort") {
      for (const task of this.tasks) if (!task.finished) task.aborted = true;
      this.respond(command, {});
    }
  }

  /** Pi acknowledging a request, as the real runtime does before it works. */
  respond(command, data) {
    this.pushStdout({ id: command.id, type: "response", success: true, data });
  }

  /** Pi acknowledging a prompt while its task keeps running. */
  acknowledgeTask(index) {
    this.respond({ id: this.tasks[index].id }, {});
  }

  /**
   * The task keeps working after the plugin gave up: it acknowledges late, then
   * streams its answer and settles.
   */
  finishTask(index, text) {
    const task = this.tasks[index];
    task.finished = true;
    this.acknowledgeTask(index);
    this.pushStdout(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } },
      { type: "agent_settled" }
    );
  }

  pushStdout(...messages) {
    const text = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
    this.stdout.emit("data", Buffer.from(text, "utf8"));
  }

  get commandTypes() {
    return this.commands.map((command) => command.type);
  }

  get abortCount() {
    return this.commands.filter((command) => command.type === "abort").length;
  }

  get promptCount() {
    return this.tasks.length;
  }

  /** A terminated Pi process: what `terminateProcessTree()` does to this fake. */
  kill(signal) {
    this.killed = true;
    this.killSignals = [...(this.killSignals ?? []), signal];
  }
}

spawnRegistry.create = () => {
  const child = new FakePiProcess();
  // Node emits 'spawn' asynchronously, after start() registered its listeners.
  if (spawnRegistry.autoSpawn) Promise.resolve().then(() => child.emit("spawn"));
  return child;
};

const clients = [];
const ownedPids = [];
let tempDirs = [];

beforeEach(() => {
  spawnRegistry.children.length = 0;
  spawnRegistry.autoSpawn = true;
  spawnRegistry.useRealSpawn = false;
});

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  for (const pid of ownedPids.splice(0)) killQuietly(pid);
  for (const tempDir of tempDirs) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDirs = [];
});

function createTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-prompt-timeout-"));
  tempDirs.push(tempDir);
  return tempDir;
}

/**
 * Stand-in for Obsidian's `window` timers, which `PiRpcClient` accepts as
 * `hostWindow`. It makes the plugin-side request timeout (30s by default) a
 * value this file can fire on demand instead of waiting out.
 */
function createManualTimerHost() {
  const pending = new Map();
  let nextId = 1;
  return {
    host: {
      setTimeout(callback, ms) {
        const id = nextId++;
        pending.set(id, { callback, ms });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      }
    },
    get pendingDelays() {
      return [...pending.values()].map((entry) => entry.ms);
    },
    /** Fire the single pending timer with this delay, if there is one. */
    fire(ms) {
      const match = [...pending.entries()].find(([, entry]) => entry.ms === ms);
      if (!match) return false;
      pending.delete(match[0]);
      match[1].callback();
      return true;
    }
  };
}

function createClientHarness({ args = [], hostWindow } = {}) {
  const client = new PiRpcClient({
    piExecutablePath: process.execPath,
    cwd: process.cwd(),
    args,
    hostWindow,
    // No drain needs to be parked in this file, so yields resolve immediately.
    yieldScheduler: { yield: async () => {}, dispose: () => {} },
    drainBudget: { maxEvents: 64, maxMs: 10_000 }
  });
  clients.push(client);
  const events = [];
  client.subscribe((event) => events.push(event));
  return { client, events };
}

/**
 * The real `PiRunner` over a real `PiRpcClient`: the runner gets the client
 * injected (the same seam tests/plugin-unload-lifecycle.test.mjs uses), so the
 * run path under test is production code end to end. Only the child process is
 * fake.
 */
function createRunnerHarness() {
  const pluginDir = createTempDir();
  const timers = createManualTimerHost();
  const { client, events } = createClientHarness({ hostWindow: timers.host });
  const runner = new PiRunner(
    DEFAULT_SETTINGS,
    { formatPrompt: (prompt) => prompt },
    pluginDir,
    pluginDir,
    client
  );
  return { runner, client, events, timers, pluginDir };
}

/**
 * A real Pi stand-in run by a real `node` process: it starts a task on `prompt`,
 * keeps working well past the plugin's timeout, and only then streams its answer
 * and settles. Every step is written to a log file, so the test can observe work
 * that happens after the plugin stopped waiting - and that Pi never received a
 * cancel request.
 */
const CONTINUING_TASK_SCRIPT = `
const fs = require("node:fs");
const logPath = process.argv[1];
const commands = [];
const record = (line) => fs.appendFileSync(logPath, line + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    commands.push(command.type);
    if (command.type === "get_state") {
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", success: true, data: {} }) + "\\n");
      continue;
    }
    if (command.type !== "prompt") continue;
    record("task:start");
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      record("task:tick");
      if (ticks < 6) return;
      clearInterval(timer);
      process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "late answer" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", success: true, data: {} }) + "\\n");
      setTimeout(() => {
        record("commands:" + JSON.stringify(commands));
        process.exit(0);
      }, 60);
    }, 100);
  }
});
process.stdin.resume();
`;

const readLog = (logPath) => (fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "");
const countTicks = (logPath) => readLog(logPath).split("task:tick").length - 1;
const logHas = (logPath, text) => readLog(logPath).includes(text);
const commandLog = (logPath) =>
  JSON.parse(
    readLog(logPath)
      .split("\n")
      .find((line) => line.startsWith("commands:"))
      .slice("commands:".length)
  );

describe("RPC prompt timeout vs the Pi-side task", () => {
  it("A: a delayed prompt response times out locally, and the Pi task keeps running and finishes", async () => {
    const { client, events } = createClientHarness();
    const outcome = observe(client.request("prompt", { message: "long task" }, { timeoutMs: 40 }));

    await waitFor(() => piProcess().promptCount === 1);
    expect(piProcess().tasks[0].finished).toBe(false);

    await waitFor(() => outcome.status === "rejected");
    expect(String(outcome.value.message)).toBe("Pi RPC prompt timed out after 40ms.");

    // The timeout is entirely local: Pi received the prompt and nothing else.
    expect(piProcess().commandTypes).toEqual(["prompt"]);
    expect(piProcess().abortCount).toBe(0);
    expect(piProcess().killed).toBe(false);
    expect(client.running).toBe(true);
    expect(client.pending.size).toBe(0);

    // The task the plugin gave up on is still running...
    await delay(60);
    expect(piProcess().tasks[0].finished).toBe(false);

    // ...and finishes on its own schedule, after the plugin stopped waiting.
    piProcess().finishTask(0, "late answer");
    await waitFor(() => events.some((event) => event.type === "agent_settled"));
    expect(piProcess().tasks[0].finished).toBe(true);
    // Its response arrives too late to be routed - the pending entry is gone - so
    // the finished task is only visible as ordinary agent events.
    expect(events.map((event) => event.type)).toEqual(["message_update", "agent_settled"]);
  });

  it("B: runPiRpc() has failed and reset isRunning while the task it started is still running", async () => {
    const { runner, client, events, timers } = createRunnerHarness();
    const run = observe(runner.runPiRpc("long task", undefined));

    await waitFor(() => piProcess().promptCount === 1);
    expect(runner.isRunning).toBe(true);
    expect(piProcess().tasks[0].finished).toBe(false);

    // The real 30s prompt timeout is fired here instead of being waited out.
    expect(timers.pendingDelays).toEqual([30_000]);
    expect(timers.fire(30_000)).toBe(true);

    await waitFor(() => run.status === "rejected");
    expect(String(run.value.message)).toBe("Pi RPC prompt timed out after 30000ms.");
    // Plugin side: the run is over, its subscription is gone, nothing is pending.
    expect(runner.isRunning).toBe(false);
    expect(runner.runCompletionRejector).toBeUndefined();
    expect(runner.cancelRequested).toBe(false);
    // Pi side: the abandoned task was still running when the run failed - the
    // timeout itself cancels nothing (that fact lives in tests A and D).
    expect(piProcess().commandTypes).toEqual(["get_state", "prompt"]);
    expect(piProcess().abortCount).toBe(0);
    expect(piProcess().tasks[0].finished).toBe(false);

    // Plugin side: because the request lost its owner, the runner gives up the
    // client - process, session attachment and subscription included - so the
    // task it abandoned can no longer reach this runner or any later run.
    expect(client.disposed).toBe(true);
    expect(piProcess().killed).toBe(true);
    expect(runner.rpcClient).toBeUndefined();
    expect(runner.rpcSession).toBeUndefined();

    // Even when the abandoned task finishes, its settle is never delivered.
    piProcess().finishTask(0, "late answer");
    await flushMicrotasks();
    expect(piProcess().tasks[0].finished).toBe(true);
    expect(events.some((event) => event.type === "agent_settled")).toBe(false);
  });

  it("C (regression): a timed-out prompt can no longer settle the NEXT run on the same thread", async () => {
    const { runner, client, events, timers, pluginDir } = createRunnerHarness();
    const first = observe(runner.runPiRpc("first", undefined));
    await waitFor(() => piProcess().promptCount === 1);
    // The thread keeps its session file, so the next run can reopen it.
    const sessionReference = runner.rpcSession.reference;
    const abandonedProcess = piProcess();
    expect(timers.fire(30_000)).toBe(true);
    await waitFor(() => first.status === "rejected");
    expect(abandonedProcess.tasks[0].finished).toBe(false);

    // The same thread, immediately: a second run on the same session.
    fs.writeFileSync(path.join(pluginDir, "pi-sessions", sessionReference), "");
    const second = observe(runner.runPiRpc("second", sessionReference));
    // Wait until the second run has actually subscribed and sent its prompt to
    // whichever client now serves it (pre-fix that is the old, still-attached
    // client; with the fix it is a fresh one), then let Pi acknowledge that
    // prompt - the run is now waiting for its task to settle, like in production.
    await waitFor(() => runner.rpcClient.pending.size === 1);
    const servingProcess = piProcess();
    servingProcess.acknowledgeTask(servingProcess.tasks.length - 1);
    await waitFor(() => runner.rpcClient.pending.size === 0);

    // The regression: the abandoned first task finishing must NOT settle the
    // second run. Before the fix it did - its stream still belonged to the client
    // the second run had attached to - and the second run returned "answer one".
    abandonedProcess.finishTask(0, "answer one");
    await flushMicrotasks();
    expect(second.status).toBe("pending");
    expect(runner.isRunning).toBe(true);
    expect(events.some((event) => event.type === "agent_settled")).toBe(false);

    // With the fix the second run does not even share the abandoned process: the
    // first run gave that client up (process and session attachment included)
    // while the thread's session file was preserved.
    const freshClient = runner.rpcClient;
    const freshProcess = piProcess();
    expect(freshProcess).not.toBe(abandonedProcess);
    expect(freshClient).not.toBe(client);
    expect(spawnCount()).toBe(2);
    expect(abandonedProcess.killed).toBe(true);
    expect(freshProcess.promptCount).toBe(1);
    expect(client.disposed).toBe(true);

    // The second run settles on its OWN task, with its own answer, and keeps the
    // thread's session.
    freshProcess.finishTask(0, "answer two");
    await waitFor(() => second.status === "fulfilled");
    expect(freshClient.pending.size).toBe(0);
    expect(second.value.finalResponse).toBe("answer two");
    expect(second.value.finalResponse).not.toBe("answer one");
    expect(second.value.sessionId).toBe(sessionReference);
    expect(runner.isRunning).toBe(false);
  });

  it("S: the same harness does observe a real cancel, so 'still running' is not vacuous", async () => {
    const { client } = createClientHarness();
    const outcome = observe(
      client.request("prompt", { message: "cancelled task" }, { timeoutMs: 0 })
    );
    await waitFor(() => piProcess().promptCount === 1);

    // The production cancel path, for contrast with the timeout: Pi really
    // receives an abort and its task is marked aborted.
    await client.abort();

    expect(piProcess().abortCount).toBe(1);
    expect(piProcess().commandTypes).toEqual(["prompt", "abort"]);
    expect(piProcess().tasks[0].aborted).toBe(true);
    expect(outcome.status).toBe("pending");
  });

  it("D: a REAL Pi child process and its task keep running after the timeout", async () => {
    spawnRegistry.useRealSpawn = true;
    const logPath = path.join(createTempDir(), "task-log.txt");
    const { client, events } = createClientHarness({
      args: ["-e", CONTINUING_TASK_SCRIPT, logPath]
    });
    const outcome = observe(client.request("prompt", { message: "long task" }, { timeoutMs: 150 }));

    await waitFor(() => logHas(logPath, "task:start"), { timeoutMs: 8000 });
    await waitFor(() => outcome.status === "rejected", { timeoutMs: 8000 });
    expect(String(outcome.value.message)).toBe("Pi RPC prompt timed out after 150ms.");

    const pid = client.child?.pid;
    expect(pid).toBeTypeOf("number");
    ownedPids.push(pid);
    // How much of the task's work existed when the plugin gave up; the task then
    // keeps ticking well past this point on its own schedule.
    const ticksAtTimeout = countTicks(logPath);
    expect(isAlive(pid)).toBe(true);
    expect(client.running).toBe(true);
    expect(client.pending.size).toBe(0);

    // The real process is still doing the work after the plugin stopped waiting.
    await waitFor(() => countTicks(logPath) > ticksAtTimeout, { timeoutMs: 8000 });

    // Its task completes to a client nobody is waiting on: the late prompt
    // response is dropped, the agent events still arrive.
    await waitFor(() => events.some((event) => event.type === "agent_settled"), {
      timeoutMs: 8000
    });
    expect(events.some((event) => event.type === "response")).toBe(false);

    // Pi never received a cancel request of any kind.
    await waitFor(() => logHas(logPath, "commands:"), { timeoutMs: 8000 });
    expect(commandLog(logPath)).toEqual(["prompt"]);
  }, 20000);
});
