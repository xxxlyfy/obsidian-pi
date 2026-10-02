// Does `/compact` honour the `sessionReference` a caller passes when `PiRunner`
// already owns a live client and session, or - like `runPiRpc()` before commit
// 1ebcb76 - does it silently compact the session the runner was first bound to?
//
// The review question is about production behaviour, not about a cache field
// looking untidy:
//   * `runPiRpc()` (src/pi/runner.mjs:211) calls
//     `discardRpcClientForSessionMismatch(sessionId)` before asking for a client,
//     so a run that asks for B releases A and spawns a process on B;
//   * `runPiRpcCompact()` used to go straight to
//     `getOrCreateRpcClient(sessionId)`, which on an existing client keeps
//     `this.rpcSession` (`??=`) and reuses the process already launched on A; the
//     fix is the same guard `runPiRpc()` uses;
//   * `buildPiArgs()` passes `--session <path>`, so a Pi process bound to A can
//     only ever read and compact A.
//
// The decisive observable is what the REAL production code wrote to the fake Pi
// process's stdin: the process the `compact` command was delivered to is the
// process that performs the compaction, and the session file that process was
// launched on is the session that got compacted. Only the child process is fake;
// the runner and `PiRpcClient` are the production ones, driven through their
// public API (`run()` for the `/compact` prompt path, `runPiRpcCompact()` for the
// direct path).
//
// Facts this file pins:
//   1 baseline -> compacting the session the runner is already bound to is served
//                  by that same process and does not spawn a second one.
//   2 mismatch -> `/compact` that names session-b.jsonl while the runner is bound
//                  to session-a.jsonl is delivered to a process launched on B (via
//                  `run()`, the production parsing path).
//   3 mismatch -> the same on the direct `runPiRpcCompact()` path, where a client
//                  bound to A must not be reused for B.
//   4 isolation-> B's session file grows the compaction marker while A's file is
//                  byte-for-byte what its own run left behind, and the reported
//                  `sessionId` matches what the caller asked for.

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
 * the runtime reads and appends, so this is the session a `compact` command
 * really compacts. Both argument shapes are accepted so the helper does not
 * depend on whether the runner emitted `--session <path>` or `--session=<path>`.
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
 * when Pi answers. `compact` is acknowledged immediately, because it is the
 * request under test and this file must be able to observe exactly which process
 * received it. Every `compact` this process handles also grows the session file
 * it was launched on, exactly like the runtime it stands in for, so "which
 * session was compacted" is a real file fact rather than an assertion about a
 * value the test wrote itself.
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
    this.compactions = [];
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
    if (command.type === "compact") {
      // Record what this process was asked to compact on which session. Written
      // to the file this process owns, so the session that is actually compacted
      // is observable on disk.
      const session = sessionName(this.sessionFile);
      const instructions = String(command.customInstructions ?? "");
      this.compactions.push({ session, instructions });
      this.appendToSession(`COMPACT:${session}:${instructions}`);
      this.respond(command, { tokensBefore: 1234 });
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

  get compactCount() {
    return this.compactions.length;
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-compact-binding-"));
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
function createCompactHarness() {
  const pluginDir = createTempDir();
  const sessionDir = path.join(pluginDir, "pi-sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionAPath = path.join(sessionDir, "session-a.jsonl");
  const sessionBPath = path.join(sessionDir, "session-b.jsonl");
  fs.writeFileSync(sessionAPath, "CONTEXT-OF-SESSION-A\n");

  // `piExecutablePath` points at Node so that every client the runner builds for
  // itself - including one built while rebinding - is served by this file's fake
  // child process instead of the real Pi executable.
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

describe("/compact session binding when the caller asks for a different session", () => {
  it("1 (baseline): compacting the bound session is served by its process and spawns nothing", async () => {
    const harness = createCompactHarness();
    const { runner } = harness;

    // Run one binds session A, the session this thread's first run uses.
    const first = observe(runner.runPiRpc("one", harness.sessionAReference));
    await waitFor(() => piProcess().promptCount === 1);
    const boundProcess = piProcess();
    const boundReference = runner.rpcSession.reference;
    expect(boundReference).toBe(harness.sessionAReference);
    boundProcess.settlePrompt("one", "answer one");
    await waitFor(() => first.status === "fulfilled");
    expect(spawnCount()).toBe(1);

    // A `/compact` that names the session the runner is already bound to.
    const compact = await runner.runPiRpcCompact(boundReference, "keep the decisions");

    expect(compact.sessionId).toBe(boundReference);
    expect(compact.compactionResult).toEqual({ tokensBefore: 1234 });
    // The command reached the process already launched on A, and that process is
    // the only one in existence: no second Pi process was started.
    expect(boundProcess.commandTypes).toContain("compact");
    expect(boundProcess.compactions).toEqual([
      { session: boundReference, instructions: "keep the decisions" }
    ]);
    expect(spawnCount()).toBe(1);
    expect(piProcess()).toBe(boundProcess);
    // A's file grew by the compaction; nothing else exists to have grown.
    expect(fs.readFileSync(harness.sessionAPath, "utf8")).toContain(
      `COMPACT:${boundReference}:keep the decisions`
    );
  });

  it("2 (mismatch, /compact prompt path): compacting session-b.jsonl must not be served by session-a.jsonl", async () => {
    const harness = createCompactHarness();
    const { runner } = harness;

    // Run one binds session A.
    const first = observe(runner.runPiRpc("one", harness.sessionAReference));
    await waitFor(() => piProcess().promptCount === 1);
    const processLaunchedOnA = piProcess();
    const boundReference = runner.rpcSession.reference;
    expect(boundReference).toBe(harness.sessionAReference);
    processLaunchedOnA.settlePrompt("one", "answer one");
    await waitFor(() => first.status === "fulfilled");
    const aAfterItsRun = fs.readFileSync(harness.sessionAPath, "utf8");
    expect(aAfterItsRun).toContain("RUN:one");
    expect(processLaunchedOnA.compactCount).toBe(0);

    // A second session with its own, different context now exists on disk.
    const requestedReference = "session-b.jsonl";
    harness.addSession(requestedReference, "CONTEXT-OF-SESSION-B\n");
    expect(requestedReference).not.toBe(boundReference);

    // A caller asks for B - through the production `/compact` prompt path
    // (run() -> getCompactInstructions() -> runPiRpcCompact()).
    const compact = await runner.run("/compact tidy up the context", undefined, requestedReference);

    // What was requested is legitimately resolvable, and the runner's own
    // resolution of the request names B.
    const resolvedForRequest = runner.resolveSessionPath(requestedReference);
    expect(sessionName(resolvedForRequest)).toBe(requestedReference);
    expect(fs.existsSync(resolvedForRequest)).toBe(true);

    // REQUIREMENT (the decisive one): a `compact` for B must be performed by a Pi
    // process launched on B, so the process that received the command is the one
    // whose session file is B.
    const processThatReceivedCompact = spawnRegistry.children.find((child) =>
      child.commandTypes.includes("compact")
    );
    expect(processThatReceivedCompact).toBeDefined();
    expect(sessionName(processThatReceivedCompact.sessionFile)).toBe(requestedReference);

    // REQUIREMENT: serving B needed a process launched on B, so the runner gave up
    // the client it was bound to and started one on the requested session.
    expect(processThatReceivedCompact).not.toBe(processLaunchedOnA);
    expect(spawnCount()).toBe(2);
    expect(processThatReceivedCompact.compactions).toEqual([
      { session: requestedReference, instructions: "tidy up the context" }
    ]);
    expect(sessionName(piProcess().sessionFile)).toBe(requestedReference);

    // REQUIREMENT: the session the caller named is the session whose context was
    // compacted, and the session the runner stayed bound to is not touched. A's
    // bytes are exactly what its own run left behind.
    expect(fs.readFileSync(harness.sessionBPath, "utf8")).toContain(
      `COMPACT:${requestedReference}:tidy up the context`
    );
    expect(processLaunchedOnA.compactCount).toBe(0);
    expect(processLaunchedOnA.commandTypes).not.toContain("compact");
    expect(fs.readFileSync(harness.sessionAPath, "utf8")).toBe(aAfterItsRun);
    expect(fs.readFileSync(harness.sessionAPath, "utf8")).not.toContain("COMPACT:");

    // REQUIREMENT: the result the caller receives has to name what was compacted,
    // and the runner must now own the client for the session it just serviced.
    expect(compact.sessionId).toBe(requestedReference);
    expect(sessionName(runner.rpcSession.reference)).toBe(requestedReference);
    expect(sessionName(runner.rpcSession.path)).toBe(requestedReference);
  });

  it("3 (mismatch, reboot path): compacting session-b.jsonl must not reuse the client bound to A", async () => {
    const harness = createCompactHarness();
    const { runner } = harness;

    // Run one binds session A, and no session exists at all at this point, so the
    // reboot path below is not decided by an earlier resolution of the request.
    const first = observe(runner.runPiRpc("one", harness.sessionAReference));
    await waitFor(() => piProcess().promptCount === 1);
    const processLaunchedOnA = piProcess();
    const boundReference = runner.rpcSession.reference;
    expect(boundReference).toBe(harness.sessionAReference);
    processLaunchedOnA.settlePrompt("one", "answer one");
    await waitFor(() => first.status === "fulfilled");
    expect(processLaunchedOnA.compactCount).toBe(0);

    const requestedReference = "session-b.jsonl";
    const sessionBPath = harness.addSession(requestedReference, "CONTEXT-OF-SESSION-B\n");
    // B exists and is resolvable, and nothing has been launched on it yet, so the
    // only thing that could serve this compact is the client the runner owns.
    expect(runner.resolveSessionPath(requestedReference)).toBe(sessionBPath);
    expect(
      spawnRegistry.children.some(
        (child) => sessionName(sessionFileFor(child)) === requestedReference
      )
    ).toBe(false);
    const bBeforeCompact = fs.readFileSync(sessionBPath, "utf8");

    // A caller asks to compact B. On a fresh runner this creates a client bound to
    // B; on a runner that already owns A it must not reuse A's client.
    const compact = await runner.runPiRpcCompact(requestedReference, "tidy up the context");

    // REQUIREMENT (the decisive one): a `compact` for B must be performed by a Pi
    // process launched on B.
    const processThatReceivedCompact = spawnRegistry.children.find((child) =>
      child.commandTypes.includes("compact")
    );
    expect(processThatReceivedCompact).toBeDefined();
    expect(sessionName(processThatReceivedCompact.sessionFile)).toBe(requestedReference);

    // REQUIREMENT: no process was launched on B before this call, so the compact
    // could only be served by launching one on the requested session.
    const modernProcess = piProcess();
    expect(spawnCount()).toBe(2);
    expect(modernProcess).not.toBe(processLaunchedOnA);
    expect(modernProcess).toBe(processThatReceivedCompact);
    expect(processThatReceivedCompact.compactions).toEqual([
      { session: requestedReference, instructions: "tidy up the context" }
    ]);

    // REQUIREMENT: B is the session that changed, and A was not compacted by
    // anything - neither by the process it owns nor by the new one.
    expect(fs.readFileSync(sessionBPath, "utf8")).toContain(
      `COMPACT:${requestedReference}:tidy up the context`
    );
    expect(fs.readFileSync(sessionBPath, "utf8")).not.toBe(bBeforeCompact);
    expect(processLaunchedOnA.compactCount).toBe(0);
    expect(processLaunchedOnA.commandTypes).not.toContain("compact");
    expect(fs.readFileSync(harness.sessionAPath, "utf8")).not.toContain("COMPACT:");
    expect(compact.sessionId).toBe(requestedReference);
    expect(compact.compactionResult).toEqual({ tokensBefore: 1234 });
    expect(sessionName(runner.rpcSession.reference)).toBe(requestedReference);
  });
});
