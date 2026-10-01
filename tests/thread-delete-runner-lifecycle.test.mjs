import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Notices and console warnings are recorded so a test can prove what the user does --
// and does not -- see when a delete refuses or cannot remove the session file. vi.hoisted
// because the vi.mock factory below is hoisted above these declarations.
const harness = vi.hoisted(() => ({ notices: [], warnings: [] }));

vi.mock("obsidian", () => {
  class ObsidianBase {}
  class Notice {
    constructor(message) {
      harness.notices.push(String(message));
    }
  }
  return {
    Component: ObsidianBase,
    FuzzySuggestModal: ObsidianBase,
    ItemView: ObsidianBase,
    MarkdownRenderChild: ObsidianBase,
    MarkdownRenderer: { render: vi.fn().mockResolvedValue(undefined) },
    MarkdownView: ObsidianBase,
    Menu: ObsidianBase,
    Modal: ObsidianBase,
    Notice,
    Platform: { isDesktopApp: true },
    Plugin: ObsidianBase,
    PluginSettingTab: ObsidianBase,
    Setting: ObsidianBase,
    SuggestModal: ObsidianBase,
    TFile: ObsidianBase,
    addIcon: vi.fn(),
    getLanguage: () => "en",
    normalizePath: (value) => value,
    setIcon: vi.fn()
  };
});

const { PiAgentPlugin } = await import("../src/plugin/PiAgentPlugin.mjs");
const { DEFAULT_SETTINGS } = await import("../src/plugin/settings.mjs");
const { PiRpcClient } = await import("../src/pi/rpc-client.mjs");
const { PiRunner } = await import("../src/pi/runner.mjs");
const { ThreadStore } = await import("../src/threads/thread-store.mjs");

/**
 * The runner lifecycle of `PiAgentPlugin.deleteThread()` / `deleteThreads()`.
 *
 * A deleted thread releases its idle runner through `disposeThreadRunner()`, the same
 * lifecycle archiving and unloading use, so the runner itself reaches its terminal
 * state instead of surviving as a deregistered object:
 *
 *   runner.dispose() -> runner.disposed === true, runner.rpcClient === undefined
 *   threadRunners no longer holds the thread id
 *
 *   A. deleteThread() on an idle runner that owns a live Pi process.
 *   B. deleteThreads() over three such runners.
 *   C. Regression: the stale runner a caller may still hold is terminal, and reusing it
 *      neither starts Pi nor revives its client -- however often it is called.
 *   D. The running-thread guard deleteThread() keeps.
 *   E. deleteThreads() with a running and an idle thread in one call.
 *   F. deleteThread({ deletePiSession: true }), whose error handling is unchanged.
 *
 * Every scenario goes through the real production path -- `plugin.createPiRunner()`,
 * `plugin.getThreadSessionEntries()` (which reuses the thread's own runner and starts
 * its client), `PiRunner` -> `PiRpcClient` -> a real fake Pi child process launched by
 * `spawn` -- so the objects and processes observed here are the ones doing the work.
 */

const PI_FIXTURE = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
const THREAD_A = "thread-a";
const THREAD_B = "thread-b";
const THREAD_C = "thread-c";

let tempDirs = [];
let plugins = [];
let trackedRunners = [];
let startedClients = [];
let spawnedChildren = [];

beforeEach(() => {
  // Record every client that really spawns a Pi process, and the child process it
  // created, so a test that fails mid-lifecycle cannot leak a process into the machine
  // running the suite. `PiRpcClient.start()` assigns `this.child` inside the promise
  // executor, so a child that differs from the previous one is a real `spawn()`. The
  // recorded attempts also let a test prove that a stale runner never even tries.
  const originalStart = PiRpcClient.prototype.start;
  vi.spyOn(PiRpcClient.prototype, "start").mockImplementation(function (...args) {
    const previousChild = this.child;
    startedClients.push(this);
    const result = originalStart.apply(this, args);
    if (this.child && this.child !== previousChild) spawnedChildren.push(this.child);
    return result;
  });
});

afterEach(async () => {
  // Cleanup: release every runner and client this test really started, then wait until
  // every fake Pi child process of this test has exited, so the next test starts on a
  // quiet machine. A runner a delete left registered nowhere is still released here
  // through the reference the test kept.
  for (const runner of trackedRunners.splice(0)) {
    try {
      runner.dispose();
    } catch (error) {
      console.warn("cleanup: could not dispose a tracked runner", error);
    }
  }
  for (const plugin of plugins.splice(0)) {
    for (const runner of plugin.threadRunners.values()) runner.dispose();
    plugin.threadRunners.clear();
    for (const runner of plugin.ephemeralRunners ?? []) runner.dispose();
    plugin.ephemeralRunners?.clear();
  }
  for (const client of startedClients.splice(0)) if (!client.disposed) client.dispose();
  const children = spawnedChildren.splice(0);
  await vi.waitFor(() => expect(children.every((child) => !childAlive(child))).toBe(true), {
    timeout: 10_000
  });
  for (const tempDir of tempDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  tempDirs = [];
  vi.restoreAllMocks();
  harness.notices.length = 0;
  harness.warnings.length = 0;
});

function createTempDir(prefix = "pi-agent-delete-") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

/**
 * A launcher the production spawn path can execute that runs a fake Pi RPC fixture for
 * real. Pi itself is not installed in the test environment, and `PiRunner` always
 * launches its client with Pi's own CLI arguments, so the launcher ignores those
 * arguments and starts the fixture.
 */
function createFakePiLauncher() {
  const directory = createTempDir();
  if (process.platform === "win32") {
    const launcher = path.join(directory, "fake-pi.cmd");
    fs.writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${PI_FIXTURE}"\r\n`, "utf8");
    return launcher;
  }
  const launcher = path.join(directory, "fake-pi.sh");
  fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${PI_FIXTURE}"\n`, "utf8");
  fs.chmodSync(launcher, 0o755);
  return launcher;
}

/**
 * A plugin whose thread store, runner registry and services are the production ones,
 * with one real session entry per thread.
 *
 * `sessionKind: "directory"` creates that entry as a directory instead of a file: it
 * satisfies every existence check deleteThread() makes and still makes the real
 * `fs.unlinkSync()` fail, which is the only way to reach that failure under F without
 * mocking the filesystem.
 */
function createDeletePlugin(threadIds, { sessionKind = "file" } = {}) {
  const pluginDirectory = createTempDir();
  const sessionDirectory = path.join(pluginDirectory, "pi-sessions");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const threads = threadIds.map((id) => {
    const piSessionId = `session-${id}.jsonl`;
    const sessionPath = path.join(sessionDirectory, piSessionId);
    if (sessionKind === "directory") fs.mkdirSync(sessionPath);
    else fs.writeFileSync(sessionPath, "", "utf8");
    const now = Date.now();
    return {
      id,
      title: `Thread ${id}`,
      messages: [],
      createdAt: now,
      updatedAt: now,
      archived: false,
      favorite: false,
      piSessionId
    };
  });

  const plugin = Object.create(PiAgentPlugin.prototype);
  plugin.settings = { ...DEFAULT_SETTINGS, piExecutablePath: createFakePiLauncher() };
  plugin.threadRunners = new Map();
  plugin.ephemeralRunners = new Set();
  plugin.unloading = false;
  plugin.modelCatalogGeneration = 0;
  plugin.modelCatalogRefreshedAt = 0;
  plugin.piCommands = [];
  plugin.app = {
    vault: { getAbstractFileByPath: () => undefined },
    workspace: { getActiveFile: () => undefined },
    metadataCache: {}
  };
  plugin.getVaultBasePath = () => pluginDirectory;
  plugin.getPluginDirectory = () => pluginDirectory;
  plugin.threadHistory = new ThreadStore({ currentThreadId: threadIds[0], threads });
  plugin.syncCurrentThreadState = vi.fn();
  plugin.saveThreadHistory = vi.fn();
  plugin.rebuildServices();
  plugins.push(plugin);
  return plugin;
}

function sessionFilePath(plugin, threadId) {
  return path.join(plugin.getPluginDirectory(), "pi-sessions", `session-${threadId}.jsonl`);
}

/**
 * Give a thread its own real runner and start the Pi process behind it through the
 * production lookup path: the thread already has a runner, so
 * `getThreadSessionEntries()` reuses it, starts its `PiRpcClient` and answers a real
 * `get_entries` request from the fake Pi child. The runner it returns is idle -- a
 * lookup never sets `isRunning` -- which is exactly the state deleteThread() accepts.
 */
async function startIdleRunner(plugin, threadId) {
  const runner = plugin.createPiRunner(threadId);
  trackedRunners.push(runner);
  expect(await plugin.getThreadSessionEntries(threadId)).toEqual({});

  const client = runner.rpcClient;
  const child = client?.child;
  expect(runner.disposed).toBe(false);
  expect(runner.isRunning).toBeFalsy();
  expect(client).toBeInstanceOf(PiRpcClient);
  expect(client.disposed).toBe(false);
  expect(client.pending.size).toBe(0);
  expect(childAlive(child)).toBe(true);
  return { threadId, runner, client, child };
}

/**
 * Record every disposal the production code performs, on the client and on the runner,
 * so a test can tell "the client was disposed" from "the runner was disposed" and in
 * which order.
 */
function trackDisposals() {
  const clients = [];
  const runners = [];
  const events = [];

  const originalClientDispose = PiRpcClient.prototype.dispose;
  vi.spyOn(PiRpcClient.prototype, "dispose").mockImplementation(function (...args) {
    clients.push(this);
    events.push("client-dispose");
    return originalClientDispose.apply(this, args);
  });

  const originalRunnerDispose = PiRunner.prototype.dispose;
  vi.spyOn(PiRunner.prototype, "dispose").mockImplementation(function (...args) {
    runners.push(this);
    events.push("runner-dispose");
    return originalRunnerDispose.apply(this, args);
  });

  return { clients, runners, events };
}

function childAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

async function expectChildStopped(child) {
  await vi.waitFor(() => expect(childAlive(child)).toBe(false), { timeout: 10_000 });
}

describe("A. deleteThread() on a thread whose idle runner owns a live Pi process", () => {
  it("deletes the thread and leaves its runner and client in the disposed terminal state", async () => {
    const plugin = createDeletePlugin([THREAD_A, THREAD_B]);
    const { runner, client, child } = await startIdleRunner(plugin, THREAD_A);
    const other = await startIdleRunner(plugin, THREAD_B);
    const disposals = trackDisposals();

    expect(plugin.deleteThread(THREAD_A)).toBe(true);

    // The thread really is deleted, and its registry entry with it.
    expect(plugin.threadHistory.getThread(THREAD_A)).toBeUndefined();
    expect(plugin.threadRunners.has(THREAD_A)).toBe(false);
    expect(plugin.threadRunners.size).toBe(1);
    expect([...plugin.threadRunners.values()]).not.toContain(runner);
    expect(plugin.ephemeralRunners.has(runner)).toBe(false);

    // The runner itself reached its terminal state: disposed, and no longer holding the
    // client it released.
    expect(runner.disposed).toBe(true);
    expect(runner.cancelPending).toBe(true);
    expect(runner.rpcClient).toBeUndefined();
    expect(runner.rpcSession).toBeUndefined();

    // The client was released through the runner, and it took its Pi process down.
    expect(client.disposed).toBe(true);
    expect(disposals.events).toEqual(["runner-dispose", "client-dispose"]);
    expect(disposals.runners).toEqual([runner]);
    expect(disposals.clients).toEqual([client]);
    await expectChildStopped(child);

    // The delete released only that thread's runner.
    expect(other.runner.disposed).toBe(false);
    expect(other.runner.rpcClient).toBe(other.client);
    expect(other.client.disposed).toBe(false);
    expect(childAlive(other.child)).toBe(true);
    expect(plugin.threadRunners.get(THREAD_B)).toBe(other.runner);

    // The local Pi session is kept, and no lifecycle cleanup reached the user.
    expect(fs.existsSync(sessionFilePath(plugin, THREAD_A))).toBe(true);
    expect(harness.notices).toEqual([]);
  }, 60_000);
});

describe("B. deleteThreads() over three idle runners", () => {
  it("empties the registry and leaves all three runners and clients in the disposed terminal state", async () => {
    const threadIds = [THREAD_A, THREAD_B, THREAD_C];
    const plugin = createDeletePlugin(threadIds);
    const startedById = new Map();
    for (const threadId of threadIds)
      startedById.set(threadId, await startIdleRunner(plugin, threadId));
    const started = threadIds.map((threadId) => startedById.get(threadId));
    const disposals = trackDisposals();
    expect(plugin.threadRunners.size).toBe(3);

    const result = plugin.deleteThreads(threadIds);

    // `listThreads()` decides the order inside deleteThreads(), so the ids are compared
    // as a set.
    expect([...result.deletedIds].sort()).toEqual([...threadIds].sort());
    expect(result.deletedCount).toBe(3);
    expect(result.skippedIds).toEqual([]);
    expect(result.skippedCount).toBe(0);

    // The registry is empty ...
    expect(plugin.threadRunners.size).toBe(0);
    expect(threadIds.every((threadId) => !plugin.threadRunners.has(threadId))).toBe(true);

    // ... every runner and every client was disposed exactly once, through the runner
    // (`listThreads()` order, compared as sets rather than by position) ...
    expect(disposals.runners).toHaveLength(3);
    expect(new Set(disposals.runners)).toEqual(new Set(started.map(({ runner }) => runner)));
    expect(disposals.clients).toHaveLength(3);
    expect(new Set(disposals.clients)).toEqual(new Set(started.map(({ client }) => client)));
    const eventsPerDispose = ["runner-dispose", "client-dispose"];
    expect(disposals.events).toEqual([
      ...eventsPerDispose,
      ...eventsPerDispose,
      ...eventsPerDispose
    ]);

    // ... and every one of the three runners reached its terminal state.
    for (const { runner, client, child } of started) {
      expect(runner.disposed).toBe(true);
      expect(runner.rpcClient).toBeUndefined();
      expect(runner.rpcSession).toBeUndefined();
      expect(client.disposed).toBe(true);
      await expectChildStopped(child);
    }

    // Every thread is gone from the store; the deleted thread that was current is
    // replaced, and the replacement has no runner of its own.
    const remaining = plugin.threadHistory.listThreads({ includeArchived: true });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(result.createdThreadId);
    expect(plugin.threadRunners.has(result.createdThreadId)).toBe(false);
    expect(plugin.saveThreadHistory).toHaveBeenCalled();
    expect(harness.notices).toEqual([]);
  }, 90_000);
});

describe("C. the stale runner of a deleted thread cannot come back", () => {
  it("is already disposed and never starts Pi again, however often it is reused", async () => {
    const plugin = createDeletePlugin([THREAD_A, THREAD_B]);
    // `runner` is the reference a caller -- the UI, a queue drain, a stale callback --
    // can still hold after the thread is deleted.
    const { runner, client, child } = await startIdleRunner(plugin, THREAD_A);
    const sessionId = plugin.threadHistory.getThread(THREAD_A).piSessionId;

    expect(plugin.deleteThread(THREAD_A)).toBe(true);

    // The kept reference is terminal, not merely deregistered: no client to fail over
    // to, and no dispose left to run.
    const staleRunner = runner;
    expect(staleRunner.disposed).toBe(true);
    expect(staleRunner.rpcClient).toBeUndefined();
    expect(staleRunner.rpcSession).toBeUndefined();
    expect(staleRunner.cancelPending).toBe(true);
    // The client the runner used to own is disposed and no longer reachable from it.
    expect(client.disposed).toBe(true);

    const spawnsBefore = spawnedChildren.length;
    const startAttemptsBefore = startedClients.length;
    await expectChildStopped(child);

    // Reusing it twice is refused by PiRunner's own cancellation semantics -- the
    // disposed-runner refusal it already uses everywhere else -- and neither attempt
    // starts, creates or revives anything.
    const errors = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      errors.push(
        await staleRunner.getSessionEntries(sessionId).then(
          () => undefined,
          (error) => error
        )
      );
    }

    expect(errors.map((error) => error?.message)).toEqual(["Pi run canceled.", "Pi run canceled."]);
    expect(spawnedChildren).toHaveLength(spawnsBefore);
    expect(startedClients).toHaveLength(startAttemptsBefore);
    expect(staleRunner.disposed).toBe(true);
    expect(staleRunner.rpcClient).toBeUndefined();
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(plugin.threadHistory.getThread(THREAD_A)).toBeUndefined();
    expect(harness.notices).toEqual([]);
  }, 60_000);
});

describe("D. deleting a thread whose runner is running", () => {
  it("refuses, and leaves the thread, the registry entry, the client and the process alone", async () => {
    const plugin = createDeletePlugin([THREAD_A, THREAD_B]);
    const { runner, client, child } = await startIdleRunner(plugin, THREAD_A);
    // A chat run owns this runner; deleteThread() must not touch it.
    runner.isRunning = true;
    const disposals = trackDisposals();

    expect(plugin.deleteThread(THREAD_A)).toBe(false);

    expect(plugin.threadHistory.getThread(THREAD_A)).toBeTruthy();
    expect(plugin.threadRunners.get(THREAD_A)).toBe(runner);
    // The refused delete left the registry untouched.
    expect(plugin.threadRunners.size).toBe(1);
    expect(runner.disposed).toBe(false);
    expect(runner.rpcClient).toBe(client);
    expect(client.disposed).toBe(false);
    expect(childAlive(child)).toBe(true);
    expect(disposals.clients).toEqual([]);
    expect(disposals.runners).toEqual([]);
    expect(runner.isRunning).toBe(true);
    expect(plugin.saveThreadHistory).not.toHaveBeenCalled();
    expect(fs.existsSync(sessionFilePath(plugin, THREAD_A))).toBe(true);
    expect(harness.notices).toEqual([]);
  }, 60_000);
});

describe("E. deleteThreads() over a running and an idle thread", () => {
  it("skips the running thread and disposes only the idle one's runner", async () => {
    const plugin = createDeletePlugin([THREAD_A, THREAD_B]);
    const running = await startIdleRunner(plugin, THREAD_A);
    const idle = await startIdleRunner(plugin, THREAD_B);
    running.runner.isRunning = true;
    const disposals = trackDisposals();

    const result = plugin.deleteThreads([THREAD_A, THREAD_B]);

    expect(result.deletedIds).toEqual([THREAD_B]);
    expect(result.deletedCount).toBe(1);
    expect(result.skippedIds).toEqual([THREAD_A]);
    expect(result.skippedCount).toBe(1);

    // The running thread keeps everything it had.
    expect(plugin.threadHistory.getThread(THREAD_A)).toBeTruthy();
    expect(plugin.threadRunners.get(THREAD_A)).toBe(running.runner);
    expect(running.runner.disposed).toBe(false);
    expect(running.runner.rpcClient).toBe(running.client);
    expect(running.client.disposed).toBe(false);
    expect(childAlive(running.child)).toBe(true);

    // The idle thread was deleted exactly the way deleteThread() deletes one.
    expect(plugin.threadHistory.getThread(THREAD_B)).toBeUndefined();
    expect(plugin.threadRunners.has(THREAD_B)).toBe(false);
    expect(idle.runner.disposed).toBe(true);
    expect(idle.runner.rpcClient).toBeUndefined();
    expect(idle.client.disposed).toBe(true);
    expect(disposals.events).toEqual(["runner-dispose", "client-dispose"]);
    expect(disposals.runners).toEqual([idle.runner]);
    expect(disposals.clients).toEqual([idle.client]);
    await expectChildStopped(idle.child);
    expect(harness.notices).toEqual([]);
  }, 60_000);
});

describe("F. deleteThread({ deletePiSession: true })", () => {
  it("deletes the thread, its session file and its runner when the session can be removed", async () => {
    const plugin = createDeletePlugin([THREAD_A, THREAD_B]);
    const { runner, client, child } = await startIdleRunner(plugin, THREAD_A);
    const sessionPath = sessionFilePath(plugin, THREAD_A);
    expect(fs.existsSync(sessionPath)).toBe(true);
    const disposals = trackDisposals();

    expect(plugin.deleteThread(THREAD_A, { deletePiSession: true })).toBe(true);

    expect(plugin.threadHistory.getThread(THREAD_A)).toBeUndefined();
    expect(fs.existsSync(sessionPath)).toBe(false);
    expect(plugin.threadRunners.has(THREAD_A)).toBe(false);
    expect(runner.disposed).toBe(true);
    expect(runner.rpcClient).toBeUndefined();
    expect(client.disposed).toBe(true);
    expect(disposals.events).toEqual(["runner-dispose", "client-dispose"]);
    await expectChildStopped(child);
    expect(plugin.saveThreadHistory).toHaveBeenCalled();
    expect(harness.warnings).toEqual([]);
    expect(harness.notices).toEqual([]);
  }, 60_000);

  it("keeps the failure semantics when the session file cannot be removed", async () => {
    const plugin = createDeletePlugin([THREAD_A, THREAD_B], { sessionKind: "directory" });
    const { runner, client } = await startIdleRunner(plugin, THREAD_A);
    const other = await startIdleRunner(plugin, THREAD_B);
    const sessionPath = runner.resolveSessionPath(`session-${THREAD_A}.jsonl`);
    // A real, unremovable session entry: present for every existence check, and
    // `fs.unlinkSync()` fails on it for real (EPERM on Windows, EISDIR elsewhere).
    expect(fs.statSync(sessionPath).isDirectory()).toBe(true);
    // One ordered record of what the failed delete did: the tracker logs every
    // disposal, and the swallowed warning marks the point where the file removal gave
    // up -- after the runner and its client were already released.
    const disposals = trackDisposals();
    vi.spyOn(console, "warn").mockImplementation((...args) => {
      harness.warnings.push(args.map((value) => String(value)).join(" "));
      disposals.events.push("unlink-failed");
    });

    expect(plugin.deleteThread(THREAD_A, { deletePiSession: true })).toBe(false);

    // Unchanged: the caller is told the delete failed and the chat is still there ...
    expect(plugin.threadHistory.getThread(THREAD_A)).toBeTruthy();
    expect(plugin.threadHistory.getThread(THREAD_A)?.piSessionId).toBe(`session-${THREAD_A}.jsonl`);
    expect(fs.existsSync(sessionPath)).toBe(true);
    expect(plugin.saveThreadHistory).not.toHaveBeenCalled();

    // ... while the runner and its client were already released, in terminal state.
    expect(disposals.events).toEqual(["runner-dispose", "client-dispose", "unlink-failed"]);
    expect(disposals.runners).toEqual([runner]);
    expect(disposals.clients).toEqual([client]);
    expect(runner.disposed).toBe(true);
    expect(runner.rpcClient).toBeUndefined();
    expect(client.disposed).toBe(true);
    expect(plugin.threadRunners.has(THREAD_A)).toBe(false);
    expect(plugin.threadRunners.size).toBe(1);
    // The untouched thread keeps its runner and its live Pi process.
    expect(plugin.threadRunners.get(THREAD_B)).toBe(other.runner);
    expect(other.runner.disposed).toBe(false);
    expect(other.client.disposed).toBe(false);
    expect(childAlive(other.child)).toBe(true);
    await expectChildStopped(client.child);
    expect(
      harness.warnings.some((line) => line.includes("could not delete local Pi session"))
    ).toBe(true);
    expect(harness.notices).toEqual([]);

    // The partial state is recoverable: the chat-only retry deletes the thread, because
    // its registry entry is what the first attempt already removed.
    expect(plugin.deleteThread(THREAD_A)).toBe(true);
    expect(plugin.threadHistory.getThread(THREAD_A)).toBeUndefined();
    expect(runner.disposed).toBe(true);
  }, 60_000);
});
