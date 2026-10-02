// Does `PiRunner` honour the `sessionReference` a caller passes when it already
// owns a live client and session, or does it silently keep the session it was
// first bound to?
//
// The review question is about production behaviour, not about a cache field
// looking untidy:
//   * `getOrCreateRpcClient()` assigns `this.rpcSession ??= resolveOrCreateSession(...)`,
//     so from the second call on a DIFFERENT reference is discarded while the
//     first binding is returned;
//   * `runPiRpc()` reports `session.reference` back as the run's `sessionId`, and
//     the plugin writes that value into `thread.piSessionId`
//     (src/plugin/PiAgentPlugin.mjs:1274-1281).
//
// The decisive observable is a divergence between two values a caller is entitled
// to see agree: the session the run ASKED for - which `resolveOrCreateSession()`
// resolves correctly, as asserted below - and the session the runner actually
// binds, uses and reports back.
//
// Only the child process is fake. The runner and client under test are the real
// production ones, driven through their public API. Every assertion reads state
// the production code owns (`rpcSession`, the run result, the fake process that
// was actually spawned and the session file it was launched on), so nothing here
// can pass by asserting a value the test wrote itself.
//
// Facts this file pins:
//   1 mismatch  -> a run that asks for session-b.jsonl is served session-a.jsonl,
//                  is reported as session-a.jsonl, and records A as the thread's
//                  Pi session.
//   2 contrast  -> asking for the session the runner is already bound to spawns no
//                  second process, so fact 1 is about the request DIFFERING, not
//                  about a second run doing something different by itself.
//   3 isolation -> the two sessions are separate contexts: the run that asks for B
//                  is served by the process launched on A and grows A, while B is
//                  never opened and never written.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

import { DEFAULT_SETTINGS } from "../src/plugin/settings.mjs";
import { PiRunner } from "../src/pi/runner.mjs";
import { PiRpcClient } from "../src/pi/rpc-client.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const SESSION_ARG_PREFIX = "--session=";
const SESSION_ARG = "--session";
const sessionName = (value) => (value === undefined ? undefined : path.basename(String(value)));

/**
 * The session file a Pi process is launched on. The real runner passes the
 * session path as the value of `--session` (src/pi/runner.mjs buildPiArgs), which
 * the runtime reads and appends, so this is the session that really serves a run.
 * Both argument shapes are accepted so the helper does not depend on whether the
 * runner emitted `--session <path>` or `--session=<path>`.
 */
function sessionFileFor(child) {
  if (!child) return undefined;
  const argv = child.argv.map(String);
  const joined = argv.find((value) => value.startsWith(SESSION_ARG_PREFIX));
  if (joined !== undefined) return joined.slice(SESSION_ARG_PREFIX.length);
  const index = argv.indexOf(SESSION_ARG);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** The argument vector the runner builds for one session, in production shape. */
const sessionArgs = (sessionPath, mode = "rpc") => [
  `--mode=${mode}`,
  SESSION_ARG,
  String(sessionPath)
];

/**
 * A fake Pi RPC process launched on one session file.
 *
 * `prompt` starts a task and is deliberately NOT acknowledged: the test decides
 * when Pi answers. `readSessionContext()` and `appendToSession()` read and write
 * only the file this process was launched on, exactly like the runtime it stands
 * in for, which is what makes "which session's context did this run see" and
 * "which session did this run grow" real file facts.
 */
class FakePiProcess extends EventEmitter {
  constructor(argv) {
    super();
    this.argv = argv.map(String);
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

  get sessionFile() {
    return sessionFileFor(this);
  }

  /** The session context this process can see, from the file it was launched on. */
  readSessionContext() {
    const file = this.sessionFile;
    return file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  }

  /** Pi appending this run's history to the session file it was launched on. */
  appendToSession(text) {
    const file = this.sessionFile;
    if (!file) throw new Error("The fake Pi process was launched without a session file.");
    fs.appendFileSync(file, `${text}\n`);
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

  respond(command, data) {
    this.pushStdout({ id: command.id, type: "response", success: true, data });
  }

  /**
   * Acknowledge the prompt for `message`, stream the answer, and settle the run.
   * This is the runtime's own side effect plus its own answer: the session file
   * this process is on grows, and the answer names which run produced it.
   */
  settlePrompt(message, answer) {
    const index = this.tasks.findIndex((task) => task.message === message);
    if (index < 0)
      throw new Error(`No task for ${message} on this process (has ${this.tasks.length}).`);
    const task = this.tasks[index];
    task.finished = true;
    this.appendToSession(`RUN:${task.message}`);
    this.respond({ id: task.id }, {});
    this.pushStdout(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: answer } },
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

  get promptCount() {
    return this.tasks.length;
  }

  /** A terminated Pi process: what `terminateProcessTree()` does to this fake. */
  kill(signal) {
    this.killed = true;
    this.killSignals = [...(this.killSignals ?? []), signal];
  }
}

spawnRegistry.create = (...args) => {
  // Node's spawn(command, args, options); Pi is spawned directly, so the process
  // argument vector is the second parameter.
  const argv = Array.isArray(args[1]) ? args[1] : [];
  const child = new FakePiProcess(argv);
  // Node emits 'spawn' asynchronously, after start() registered its listeners.
  if (spawnRegistry.autoSpawn) Promise.resolve().then(() => child.emit("spawn"));
  return child;
};

const spawnCount = () => spawnRegistry.children.length;
/** The fake Pi process the client under test is talking to. */
const piProcess = () => spawnRegistry.children.at(-1);

const clients = [];
let tempDirs = [];

beforeEach(() => {
  spawnRegistry.children.length = 0;
  spawnRegistry.autoSpawn = true;
});

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  for (const tempDir of tempDirs) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDirs = [];
});

function createTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-session-binding-"));
  tempDirs.push(tempDir);
  return tempDir;
}

/**
 * A runner over a real client, with only session A present at first.
 *
 * Session B is created later by `addSession()`, so the runner's initial binding
 * is deterministic: run one resolves the only session that exists. The client is
 * constructed with the argument vector the runner itself would build for that
 * session, which is what fixes the process's session for the client's whole life
 * (src/pi/runner.mjs getOrCreateRpcClient -> buildPiArgs).
 */
function createSessionHarness() {
  const pluginDir = createTempDir();
  const sessionDir = path.join(pluginDir, "pi-sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionAPath = path.join(sessionDir, "session-a.jsonl");
  const sessionBPath = path.join(sessionDir, "session-b.jsonl");
  fs.writeFileSync(sessionAPath, "CONTEXT-OF-SESSION-A\n");

  // The runner is created first so the session reference (and the argument vector
  // it implies) comes from production code rather than from the test. Session A is
  // the named session this thread's first run binds. `piExecutablePath` points at
  // Node so that every client the runner builds for itself - including one built
  // while rebinding - is served by this file's fake child process instead of the
  // real Pi executable.
  const runner = new PiRunner(
    { ...DEFAULT_SETTINGS, piExecutablePath: process.execPath },
    { formatPrompt: (prompt) => prompt },
    pluginDir,
    pluginDir,
    undefined
  );
  const sessionAReference = "session-a.jsonl";
  const firstSession = runner.resolveOrCreateSession(sessionAReference);
  expect(sessionName(firstSession.path)).toBe(sessionAReference);

  const client = new PiRpcClient({
    piExecutablePath: process.execPath,
    cwd: pluginDir,
    // Production's own argument shape (`--session <path>`; see buildPiArgs), so the
    // session each process is launched on is a real production fact.
    args: sessionArgs(firstSession.path),
    // No drain needs to be parked in this file, so yields resolve immediately.
    yieldScheduler: { yield: async () => {}, dispose: () => {} },
    drainBudget: { maxEvents: 64, maxMs: 10_000 }
  });
  clients.push(client);
  runner.rpcClient = client;

  return {
    runner,
    client,
    pluginDir,
    sessionAReference,
    sessionAPath,
    sessionBPath,
    /** Bring session B into existence, as a second thread's session would be. */
    addSession(reference, contents) {
      const sessionPath = path.join(sessionDir, reference);
      fs.writeFileSync(sessionPath, contents);
      return sessionPath;
    }
  };
}

describe("PiRunner session binding when the caller asks for a different session", () => {
  it("1 (mismatch): a run that asks for session-b.jsonl must not stay bound to session-a.jsonl", async () => {
    const harness = createSessionHarness();
    const { runner } = harness;

    // Run one binds session A, the session this thread's first run uses.
    const first = observe(runner.runPiRpc("one", "session-a.jsonl"));
    await waitFor(() => piProcess().promptCount === 1);
    const originallyBound = runner.rpcSession.reference;
    expect(originallyBound).toBe("session-a.jsonl");
    piProcess().settlePrompt("one", "answer one");
    await waitFor(() => first.status === "fulfilled");
    expect(first.value.sessionId).toBe(originallyBound);
    expect(spawnCount()).toBe(1);
    const processLaunchedOnA = piProcess();
    expect(sessionName(sessionFileFor(processLaunchedOnA))).toBe(originallyBound);

    // A second session exists on disk now, and a caller explicitly asks for it.
    const requestedReference = "session-b.jsonl";
    harness.addSession(requestedReference, "CONTEXT-OF-SESSION-B\n");
    expect(requestedReference).not.toBe(originallyBound);

    // The request is legitimately resolvable: B exists, and the runner's own
    // resolution of the request names B.
    const resolvedForRequest = runner.resolveOrCreateSession(requestedReference);
    expect(sessionName(resolvedForRequest.path)).toBe(requestedReference);
    expect(fs.existsSync(resolvedForRequest.path)).toBe(true);

    // Second run on the SAME runner, asking for B.
    const second = observe(runner.runPiRpc("two", requestedReference));
    await waitFor(() => spawnCount() >= 2 || second.status === "rejected");
    if (second.status === "rejected") throw second.value;
    const processServingRunTwo = piProcess();
    await waitFor(() => processServingRunTwo.promptCount === 1);
    processServingRunTwo.settlePrompt("two", "answer two");
    await waitFor(() => second.status === "fulfilled");

    // What the request resolves to is B. This is the value the runner was handed,
    // and it is not the session the run was actually served by.
    expect(sessionName(resolvedForRequest.path)).toBe(requestedReference);

    // REQUIREMENT: a run that asks for B must be bound to B, served by B, and
    // reported as B. Today `rpcSession` is still A here, which is the defect.
    expect(sessionName(runner.rpcSession.reference)).toBe(requestedReference);
    expect(sessionName(runner.rpcSession.path)).toBe(requestedReference);
    expect(second.value.sessionId).toBe(requestedReference);

    // REQUIREMENT: serving B needs a process launched on B; the first process was
    // launched on A and can only ever see A's session file.
    expect(processServingRunTwo).not.toBe(processLaunchedOnA);
    expect(sessionName(sessionFileFor(processServingRunTwo))).toBe(requestedReference);

    // REQUIREMENT: the value the plugin persists as `thread.piSessionId` is exactly
    // what the run reported (PiAgentPlugin.mjs:1276-1279), so it must be B.
    const thread = { id: "thread-1", piSessionId: originallyBound };
    if (second.value.sessionId) thread.piSessionId = second.value.sessionId;
    expect(thread.piSessionId).toBe(requestedReference);
  });

  it("2 (contrast): asking for the session the runner is already bound to is stable and starts nothing new", async () => {
    const harness = createSessionHarness();
    const { runner } = harness;

    const first = observe(runner.runPiRpc("one", "session-a.jsonl"));
    await waitFor(() => piProcess().promptCount === 1);
    const boundReference = runner.rpcSession.reference;
    piProcess().settlePrompt("one", "answer one");
    await waitFor(() => first.status === "fulfilled");

    const servingProcess = piProcess();
    const second = observe(runner.runPiRpc("two", boundReference));
    await waitFor(() => servingProcess.promptCount === 2);
    servingProcess.settlePrompt("two", "answer two");
    await waitFor(() => second.status === "fulfilled");

    // Same reference: the binding is stable, the process is reused, and there is
    // no divergence to report. This isolates test 1's cause to the reference
    // DIFFERING, not to a second run doing something different by itself.
    expect(spawnCount()).toBe(1);
    expect(second.value.sessionId).toBe(boundReference);
    expect(sessionName(runner.rpcSession.path)).toBe(boundReference);
    expect(harness.sessionAReference).toBe(boundReference);
  });

  it("3 (data isolation): a run that asks for B must not see or grow A's session", async () => {
    const harness = createSessionHarness();
    const { runner, sessionAPath, sessionBPath } = harness;

    const first = observe(runner.runPiRpc("one", "session-a.jsonl"));
    await waitFor(() => piProcess().promptCount === 1);
    const boundReference = runner.rpcSession.reference;
    expect(boundReference).toBe("session-a.jsonl");
    const processLaunchedOnA = piProcess();
    piProcess().settlePrompt("one", "answer one");
    await waitFor(() => first.status === "fulfilled");
    // A's content after its own run, so "run two did not touch A" is stated
    // against the real baseline rather than against A's initial bytes.
    const sessionAAfterRunOne = fs.readFileSync(sessionAPath, "utf8");
    expect(sessionAAfterRunOne).toContain("RUN:one");

    // A second session with its own, different context now exists on disk.
    const requestedReference = "session-b.jsonl";
    harness.addSession(requestedReference, "CONTEXT-OF-SESSION-B\n");

    // A caller asks for B.
    const second = observe(runner.runPiRpc("two", requestedReference));
    await waitFor(() => spawnCount() >= 2 || second.status === "rejected");
    if (second.status === "rejected") throw second.value;
    const servingProcess = piProcess();
    await waitFor(() => servingProcess.promptCount === 1);
    servingProcess.settlePrompt("two", "answer two");
    await waitFor(() => second.status === "fulfilled");

    // REQUIREMENT: the run that asked for B is served by a process launched on B,
    // so the context available to it is B's, and A's session is not involved.
    expect(sessionName(servingProcess.sessionFile)).toBe(requestedReference);
    expect(servingProcess.readSessionContext()).toContain("CONTEXT-OF-SESSION-B");
    expect(servingProcess.readSessionContext()).not.toContain("CONTEXT-OF-SESSION-A");
    expect(second.value.sessionId).toBe(requestedReference);

    // REQUIREMENT: Pi writes this run's history to B, and must not touch A. A's
    // bytes must be exactly what its own run left behind.
    expect(fs.readFileSync(sessionBPath, "utf8")).toContain("RUN:two");
    expect(fs.readFileSync(sessionAPath, "utf8")).toBe(sessionAAfterRunOne);
    expect(fs.readFileSync(sessionAPath, "utf8")).not.toContain("RUN:two");

    // Serving B required a second Pi process launched on B.
    expect(spawnCount()).toBe(2);
    expect(sessionName(sessionFileFor(processLaunchedOnA))).not.toBe(requestedReference);
  });
});
