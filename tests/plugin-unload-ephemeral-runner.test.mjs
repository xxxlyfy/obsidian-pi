import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Notices, swallowed warnings and unhandled rejections are recorded so a test can
// report what a post-unload operation really produced. vi.hoisted because the vi.mock
// factory below is hoisted above these declarations.
const harness = vi.hoisted(() => ({ notices: [], warnings: [], unhandled: [] }));

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
 * `PiAgentPlugin.unloading === true` and the ephemeral session runner.
 *
 * `createEphemeralThreadRunner()` carries the same unload defence as `createPiRunner()`:
 * once `onunload()` ran, the factory still hands the caller the runner it owns, but that
 * runner is already disposed. The operations behind Session Info, session export/tree,
 * Session Entries and rename therefore fail through PiRunner's existing cancellation
 * semantics and never start a Pi process behind the unloaded plugin.
 *
 *   A. The factory directly after onunload(): disposed runner, not tracked, no client,
 *      no process -- and no revival when that runner is used.
 *   B. getThreadSessionStats() after onunload().
 *   C. renameThread() after onunload(), whose synchronous API and warning semantics
 *      are unchanged.
 *   D. getThreadSessionEntries() after onunload().
 *   E. Control: the same entry points on a loaded plugin keep their normal ephemeral
 *      lifecycle (runner tracked while it works, Pi spawned, released afterwards).
 *   F. Control: createPiRunner() after onunload(), the sibling defence.
 *
 * Every scenario goes through the real production path -- `plugin.onunload()`,
 * `plugin.createEphemeralThreadRunner()`, `plugin.getThreadSessionStats()`,
 * `plugin.renameThread()`, `plugin.getThreadSessionEntries()` -> `PiRunner` ->
 * `PiRpcClient` -> a real fake Pi child process launched by `spawn`.
 */

const PI_FIXTURE = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
const THREAD_A = "thread-a";

let tempDirs = [];
let plugins = [];
let trackedRunners = [];
let startedClients = [];
let spawnedChildren = [];
let unhandledRejectionListener;

beforeEach(() => {
  // Record every client that really spawns a Pi process, and the child process it
  // created, so a test can prove "no client, no process" as well as "a new process
  // really started", and so a failing test cannot leak a process into the machine
  // running the suite. `PiRpcClient.start()` assigns `this.child` inside the promise
  // executor, so a child that differs from the previous one is a real `spawn()`.
  const originalStart = PiRpcClient.prototype.start;
  vi.spyOn(PiRpcClient.prototype, "start").mockImplementation(function (...args) {
    const previousChild = this.child;
    startedClients.push(this);
    const result = originalStart.apply(this, args);
    if (this.child && this.child !== previousChild) spawnedChildren.push(this.child);
    return result;
  });

  unhandledRejectionListener = (reason) => {
    harness.unhandled.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on("unhandledRejection", unhandledRejectionListener);
});

afterEach(async () => {
  // Cleanup: release every runner and client this test really started, then wait until
  // every fake Pi child process of this test has exited, so the next test starts on a
  // quiet machine.
  process.off("unhandledRejection", unhandledRejectionListener);
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
  harness.unhandled.length = 0;
});

function createTempDir(prefix = "pi-agent-unload-") {
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
 * with one real session file, so every session operation these tests trigger has a
 * session reference it can resolve and really start Pi for.
 */
function createUnloadPlugin(threadIds) {
  const pluginDirectory = createTempDir();
  const sessionDirectory = path.join(pluginDirectory, "pi-sessions");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const threads = threadIds.map((id) => {
    const piSessionId = `session-${id}.jsonl`;
    fs.writeFileSync(path.join(sessionDirectory, piSessionId), "", "utf8");
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
  // The constructor fields `onunload()` and the runner factories rely on.
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

/**
 * Record every runner the ephemeral factory hands out, so a test can name the runner a
 * production entry point created and follow its disposal.
 */
function trackEphemeralFactory() {
  const runners = [];
  const original = PiAgentPlugin.prototype.createEphemeralThreadRunner;
  vi.spyOn(PiAgentPlugin.prototype, "createEphemeralThreadRunner").mockImplementation(function (
    ...args
  ) {
    const runner = original.apply(this, args);
    runners.push(runner);
    trackedRunners.push(runner);
    return runner;
  });
  return runners;
}

/**
 * Sample `ephemeralRunners` at every RPC request an operation sends, which is exactly
 * the window in which a borrowed runner has to be tracked.
 */
function trackEphemeralRegistryDuringRequests(plugin) {
  const sizes = [];
  const originalRequest = PiRpcClient.prototype.request;
  vi.spyOn(PiRpcClient.prototype, "request").mockImplementation(function (type, ...rest) {
    sizes.push(plugin.ephemeralRunners.size);
    return originalRequest.call(this, type, ...rest);
  });
  return sizes;
}

/** Record the warnings the production code swallows instead of reporting to the user. */
function trackConsoleWarnings() {
  vi.spyOn(console, "warn").mockImplementation((...args) => {
    harness.warnings.push(args.map((value) => String(value)).join(" "));
  });
}

function childAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

async function expectChildStopped(child) {
  await vi.waitFor(() => expect(childAlive(child)).toBe(false), { timeout: 10_000 });
}

describe("A. createEphemeralThreadRunner() directly after onunload()", () => {
  it("hands out a disposed runner, does not track it, and creates no client or process", () => {
    const plugin = createUnloadPlugin([THREAD_A]);
    expect(plugin.unloading).toBe(false);
    const clientsBefore = startedClients.length;
    const childrenBefore = spawnedChildren.length;

    plugin.onunload();
    expect(plugin.unloading).toBe(true);
    expect(plugin.ephemeralRunners.size).toBe(0);

    const runner = plugin.createEphemeralThreadRunner();

    // The caller still receives the runner it owns, but that runner is already in its
    // terminal state, exactly like the one `createPiRunner()` hands out after unload.
    expect(runner).toBeInstanceOf(PiRunner);
    expect(runner.disposed).toBe(true);
    expect(runner.cancelPending).toBe(true);
    expect(runner.rpcClient).toBeUndefined();
    expect(runner.rpcSession).toBeUndefined();

    // Nothing was created behind it, and it is not tracked: there is nothing left to
    // release, so the drained registry stays untouched.
    expect(startedClients).toHaveLength(clientsBefore);
    expect(spawnedChildren).toHaveLength(childrenBefore);
    expect(plugin.ephemeralRunners.has(runner)).toBe(false);
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(plugin.threadRunners.size).toBe(0);
    expect(harness.notices).toEqual([]);
  }, 30_000);

  it("refuses a session operation on that runner with the existing cancellation error", async () => {
    const plugin = createUnloadPlugin([THREAD_A]);
    const sessionId = plugin.threadHistory.getThread(THREAD_A).piSessionId;
    plugin.onunload();
    const clientsBefore = startedClients.length;
    const childrenBefore = spawnedChildren.length;

    const runner = plugin.createEphemeralThreadRunner();

    await expect(runner.getSessionStats(sessionId)).rejects.toThrow("Pi run canceled.");
    // Repeated use cannot revive it either.
    await expect(runner.getSessionEntries(sessionId)).rejects.toThrow("Pi run canceled.");

    expect(runner.disposed).toBe(true);
    expect(runner.rpcClient).toBeUndefined();
    expect(startedClients).toHaveLength(clientsBefore);
    expect(spawnedChildren).toHaveLength(childrenBefore);
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(harness.unhandled).toEqual([]);
  }, 30_000);
});

describe("B. getThreadSessionStats() after onunload()", () => {
  it("creates no usable runner and no Pi process, and fails through the disposed runner", async () => {
    const plugin = createUnloadPlugin([THREAD_A]);
    const runners = trackEphemeralFactory();
    const childrenBefore = spawnedChildren.length;
    const clientsBefore = startedClients.length;

    plugin.onunload();
    expect(plugin.unloading).toBe(true);

    // The production entry point a stale Session Info caller would use.
    await expect(plugin.getThreadSessionStats(THREAD_A)).rejects.toThrow("Pi run canceled.");

    expect(runners).toHaveLength(1);
    expect(runners[0].disposed).toBe(true);
    expect(runners[0].rpcClient).toBeUndefined();
    // No client was created, no Pi process was started, and nothing was left behind.
    expect(startedClients).toHaveLength(clientsBefore);
    expect(spawnedChildren).toHaveLength(childrenBefore);
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(plugin.threadRunners.size).toBe(0);
    expect(harness.unhandled).toEqual([]);
    expect(harness.warnings).toEqual([]);
    expect(harness.notices).toEqual([]);
  }, 60_000);
});

describe("C. renameThread() after onunload()", () => {
  it("keeps its synchronous result, starts no Pi process and leaves no ephemeral runner", async () => {
    const plugin = createUnloadPlugin([THREAD_A]);
    const runners = trackEphemeralFactory();
    trackConsoleWarnings();
    const childrenBefore = spawnedChildren.length;
    const clientsBefore = startedClients.length;

    plugin.onunload();
    expect(plugin.unloading).toBe(true);

    // The history rename itself still succeeds, synchronously.
    expect(plugin.renameThread(THREAD_A, "Renamed after unload")).toBe(true);
    expect(plugin.threadHistory.getThread(THREAD_A)?.title).toBe("Renamed after unload");

    // The borrowed runner is the disposed one: it never becomes a live ephemeral runner
    // and never reaches Pi.
    expect(runners).toHaveLength(1);
    expect(runners[0].disposed).toBe(true);
    expect(plugin.ephemeralRunners.size).toBe(0);

    // The rename path's existing catch reports the refused session rename, and its
    // finally releases the runner it borrowed.
    await vi.waitFor(() => expect(harness.warnings).toHaveLength(1), { timeout: 10_000 });
    expect(harness.warnings[0]).toContain("could not rename Pi session");
    expect(harness.warnings[0]).toContain("Pi run canceled.");
    expect(runners[0].disposed).toBe(true);
    expect(runners[0].rpcClient).toBeUndefined();
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(plugin.threadRunners.size).toBe(0);
    expect(startedClients).toHaveLength(clientsBefore);
    expect(spawnedChildren).toHaveLength(childrenBefore);
    expect(harness.unhandled).toEqual([]);
    expect(harness.notices).toEqual([]);
  }, 60_000);
});

describe("D. getThreadSessionEntries() after onunload()", () => {
  it("creates no usable runner and no Pi process, and fails through the disposed runner", async () => {
    const plugin = createUnloadPlugin([THREAD_A]);
    const runners = trackEphemeralFactory();
    const childrenBefore = spawnedChildren.length;
    const clientsBefore = startedClients.length;

    plugin.onunload();
    expect(plugin.unloading).toBe(true);

    await expect(plugin.getThreadSessionEntries(THREAD_A)).rejects.toThrow("Pi run canceled.");

    expect(runners).toHaveLength(1);
    expect(runners[0].disposed).toBe(true);
    expect(runners[0].rpcClient).toBeUndefined();
    expect(startedClients).toHaveLength(clientsBefore);
    expect(spawnedChildren).toHaveLength(childrenBefore);
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(plugin.threadRunners.size).toBe(0);
    expect(harness.unhandled).toEqual([]);
    expect(harness.notices).toEqual([]);
  }, 60_000);
});

describe("E. control: the same entry points on a loaded plugin", () => {
  it("keeps the normal ephemeral lifecycle of getThreadSessionStats()", async () => {
    const plugin = createUnloadPlugin([THREAD_A]);
    const runners = trackEphemeralFactory();
    const registrySizes = trackEphemeralRegistryDuringRequests(plugin);
    const childrenBefore = spawnedChildren.length;
    expect(plugin.unloading).toBe(false);

    expect(await plugin.getThreadSessionStats(THREAD_A)).toEqual({});

    // The borrowed runner was tracked for exactly as long as it was working ...
    expect(registrySizes).toEqual([1]);
    expect(runners).toHaveLength(1);
    // ... it never entered the thread registry ...
    expect(plugin.threadRunners.size).toBe(0);
    // ... and Pi really started, then was released with the runner.
    expect(spawnedChildren).toHaveLength(childrenBefore + 1);
    expect(runners[0].disposed).toBe(true);
    expect(runners[0].rpcClient).toBeUndefined();
    expect(plugin.ephemeralRunners.size).toBe(0);
    await expectChildStopped(spawnedChildren[childrenBefore]);
    expect(harness.notices).toEqual([]);
  }, 60_000);

  it("keeps the normal ephemeral lifecycle of getThreadSessionEntries()", async () => {
    const plugin = createUnloadPlugin([THREAD_A]);
    const runners = trackEphemeralFactory();
    const registrySizes = trackEphemeralRegistryDuringRequests(plugin);
    const childrenBefore = spawnedChildren.length;

    expect(await plugin.getThreadSessionEntries(THREAD_A)).toEqual({});

    expect(registrySizes).toEqual([1]);
    expect(runners).toHaveLength(1);
    expect(plugin.threadRunners.size).toBe(0);
    expect(spawnedChildren).toHaveLength(childrenBefore + 1);
    expect(runners[0].disposed).toBe(true);
    expect(runners[0].rpcClient).toBeUndefined();
    expect(plugin.ephemeralRunners.size).toBe(0);
    await expectChildStopped(spawnedChildren[childrenBefore]);
    expect(harness.notices).toEqual([]);
  }, 60_000);

  it("keeps the normal ephemeral lifecycle of renameThread()", async () => {
    const plugin = createUnloadPlugin([THREAD_A]);
    const runners = trackEphemeralFactory();
    const registrySizes = trackEphemeralRegistryDuringRequests(plugin);
    trackConsoleWarnings();
    const childrenBefore = spawnedChildren.length;

    expect(plugin.renameThread(THREAD_A, "Renamed while loaded")).toBe(true);
    expect(plugin.threadHistory.getThread(THREAD_A)?.title).toBe("Renamed while loaded");

    // The rename borrowed a live ephemeral runner that really reached Pi ...
    expect(runners).toHaveLength(1);
    // ... it was tracked while the request was in flight ...
    await vi.waitFor(() => expect(registrySizes).toEqual([1]), { timeout: 10_000 });
    await vi.waitFor(() => expect(spawnedChildren).toHaveLength(childrenBefore + 1), {
      timeout: 10_000
    });
    // ... and its own cleanup released it once the request settled.
    await vi.waitFor(() => expect(runners[0].disposed).toBe(true), { timeout: 10_000 });
    expect(runners[0].rpcClient).toBeUndefined();
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(plugin.threadRunners.size).toBe(0);
    await expectChildStopped(spawnedChildren[childrenBefore]);
    expect(harness.warnings).toEqual([]);
    expect(harness.unhandled).toEqual([]);
    expect(harness.notices).toEqual([]);
  }, 60_000);
});

describe("F. control: createPiRunner() after onunload()", () => {
  it("hands out an already disposed runner, the sibling defence", () => {
    const plugin = createUnloadPlugin([THREAD_A]);
    plugin.onunload();

    const runner = plugin.createPiRunner(THREAD_A);

    expect(runner).toBeInstanceOf(PiRunner);
    expect(runner.disposed).toBe(true);
    expect(runner.rpcClient).toBeUndefined();
    // Registered, so a caller still reaches the disposed runner by thread id.
    expect(plugin.threadRunners.get(THREAD_A)).toBe(runner);
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(startedClients).toHaveLength(0);
    expect(spawnedChildren).toHaveLength(0);
  }, 30_000);
});
