import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Notice texts are recorded so a test can assert that a session lookup never
// reports anything to the user. vi.hoisted because the vi.mock factory below is
// hoisted above these declarations.
const harness = vi.hoisted(() => ({ notices: [] }));

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

const PI_FIXTURE = path.resolve("tests/fixtures/fake-pi-rpc.mjs");

let tempDirs = [];
let plugins = [];
let startedClients = [];

beforeEach(() => {
  // Record every client that really spawns a Pi process, so a test that fails
  // mid-lifecycle cannot leak a child process into the machine running the suite.
  const originalStart = PiRpcClient.prototype.start;
  vi.spyOn(PiRpcClient.prototype, "start").mockImplementation(function (...args) {
    startedClients.push(this);
    return originalStart.apply(this, args);
  });
});

afterEach(() => {
  for (const client of startedClients) if (!client.disposed) client.dispose();
  startedClients = [];
  // A chat runner a test created on purpose still owns a real Pi child process.
  for (const plugin of plugins.splice(0)) {
    for (const runner of plugin.threadRunners.values()) runner.rpcClient?.dispose();
    plugin.threadRunners.clear();
  }
  for (const tempDir of tempDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  tempDirs = [];
  vi.restoreAllMocks();
  harness.notices.length = 0;
});

function createTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-session-"));
  tempDirs.push(tempDir);
  return tempDir;
}

/**
 * A launcher the production spawn path can execute that runs the repository's
 * fake Pi RPC fixture for real. Pi itself is not installed in the test
 * environment, and `PiRunner` always launches its client with Pi's own CLI
 * arguments, so the launcher ignores those arguments and starts the fixture.
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
 * A plugin whose thread store, runner registry and services are the production
 * ones, with one real session file per thread, so a thread that has never run
 * looks exactly like a historical thread the thread list offers Session Info or
 * Export for.
 */
function createSessionPlugin(threadIds) {
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
 * Records the real runner, client and child process behind every session request.
 * The spies call through to the production implementations, so the objects they
 * collect are the ones doing the work.
 */
function trackSessionActivity({ failRequestTypes = [] } = {}) {
  const runners = [];
  const requests = [];
  const disposals = [];

  for (const method of [
    "getSessionStats",
    "getSessionTree",
    "exportSession",
    "getSessionEntries"
  ]) {
    const original = PiRunner.prototype[method];
    vi.spyOn(PiRunner.prototype, method).mockImplementation(function (...args) {
      runners.push(this);
      return original.apply(this, args);
    });
  }

  const originalRequest = PiRpcClient.prototype.request;
  vi.spyOn(PiRpcClient.prototype, "request").mockImplementation(function (type, ...rest) {
    requests.push({ client: this, type });
    if (failRequestTypes.includes(type)) return Promise.reject(new Error(`Pi RPC ${type} failed.`));
    return originalRequest.call(this, type, ...rest);
  });

  const originalDispose = PiRpcClient.prototype.dispose;
  vi.spyOn(PiRpcClient.prototype, "dispose").mockImplementation(function (...args) {
    // The child is still attached here; the client drops it once the process exits.
    disposals.push({ client: this, child: this.child });
    return originalDispose.apply(this, args);
  });

  return { runners, requests, disposals };
}

function distinctClients({ requests }) {
  return [...new Set(requests.map(({ client }) => client))];
}

/** Every Pi child process a disposed client owned has really exited. */
async function expectChildProcessesGone({ disposals }) {
  await vi.waitFor(
    () =>
      expect(
        disposals.every(
          ({ child }) => !child || child.exitCode !== null || child.signalCode !== null
        )
      ).toBe(true),
    { timeout: 10_000 }
  );
}

describe("session operations on a thread that has no runner", () => {
  it("releases the temporary runner and Pi process after getThreadSessionStats", async () => {
    const plugin = createSessionPlugin(["thread-a"]);
    const tracker = trackSessionActivity();
    expect(plugin.threadRunners.size).toBe(0);

    // The fixture answers every session command it does not know with an empty
    // success payload, so a resolved value means the request really travelled
    // through the RPC client.
    expect(await plugin.getThreadSessionStats("thread-a")).toEqual({});

    expect(tracker.requests.map(({ type }) => type)).toEqual(["get_session_stats"]);
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.threadRunners.has("thread-a")).toBe(false);
    expect(tracker.runners).toHaveLength(1);
    expect(tracker.runners[0]).toBeInstanceOf(PiRunner);
    expect(tracker.runners[0].disposed).toBe(true);
    const clients = distinctClients(tracker);
    expect(clients).toHaveLength(1);
    expect(clients[0]).toBeInstanceOf(PiRpcClient);
    expect(clients[0].disposed).toBe(true);
    expect(tracker.disposals.map(({ client }) => client)).toEqual(clients);
    await expectChildProcessesGone(tracker);
    expect(harness.notices).toEqual([]);
  });

  it("releases the temporary runner and Pi process after getThreadSessionTree", async () => {
    const plugin = createSessionPlugin(["thread-a"]);
    const tracker = trackSessionActivity();

    expect(await plugin.getThreadSessionTree("thread-a")).toEqual({});

    expect(tracker.requests.map(({ type }) => type)).toEqual(["get_tree"]);
    expect(plugin.threadRunners.size).toBe(0);
    expect(tracker.runners).toHaveLength(1);
    expect(tracker.runners[0].disposed).toBe(true);
    const clients = distinctClients(tracker);
    expect(clients).toHaveLength(1);
    expect(clients[0].disposed).toBe(true);
    await expectChildProcessesGone(tracker);
  });

  it("releases the temporary runner and Pi process after exportThreadSession", async () => {
    const plugin = createSessionPlugin(["thread-a"]);
    const tracker = trackSessionActivity();

    expect(await plugin.exportThreadSession("thread-a")).toEqual({});

    expect(tracker.requests.map(({ type }) => type)).toEqual(["export_html"]);
    expect(plugin.threadRunners.size).toBe(0);
    expect(tracker.runners).toHaveLength(1);
    expect(tracker.runners[0].disposed).toBe(true);
    const clients = distinctClients(tracker);
    expect(clients).toHaveLength(1);
    expect(clients[0].disposed).toBe(true);
    await expectChildProcessesGone(tracker);
  });

  it("never registers the temporary runner while it is working", async () => {
    const plugin = createSessionPlugin(["thread-a"]);
    const sizesDuringRequests = [];
    const originalRequest = PiRpcClient.prototype.request;
    vi.spyOn(PiRpcClient.prototype, "request").mockImplementation(function (type, ...rest) {
      sizesDuringRequests.push(plugin.threadRunners.size);
      return originalRequest.call(this, type, ...rest);
    });

    await plugin.getThreadSessionStats("thread-a");

    // Not registered before, during, or after the request.
    expect(sizesDuringRequests).toEqual([0]);
    expect(plugin.threadRunners.size).toBe(0);
  });

  it("runs Session Info stats and tree concurrently without either releasing the other", async () => {
    const plugin = createSessionPlugin(["thread-a"]);
    const tracker = trackSessionActivity();

    const [stats, tree] = await Promise.all([
      plugin.getThreadSessionStats("thread-a"),
      plugin.getThreadSessionTree("thread-a")
    ]);

    // Both operations completed, which is what proves neither disposed the runner
    // the other one was still using.
    expect(stats).toEqual({});
    expect(tree).toEqual({});
    expect(tracker.requests.map(({ type }) => type).sort()).toEqual([
      "get_session_stats",
      "get_tree"
    ]);
    // Each of the two calls owned its own temporary runner and client...
    const runners = [...new Set(tracker.runners)];
    const clients = distinctClients(tracker);
    expect(runners).toHaveLength(2);
    expect(clients).toHaveLength(2);
    // ...and both were released, so nothing survives Session Info.
    expect(runners.every((runner) => runner.disposed === true)).toBe(true);
    expect(clients.every((client) => client.disposed === true)).toBe(true);
    expect(tracker.disposals).toHaveLength(2);
    expect(plugin.threadRunners.size).toBe(0);
    await expectChildProcessesGone(tracker);
  });

  it("disposes the temporary runner when the session file is missing", async () => {
    const plugin = createSessionPlugin(["thread-a"]);
    fs.rmSync(path.join(plugin.getPluginDirectory(), "pi-sessions", "session-thread-a.jsonl"));
    const tracker = trackSessionActivity();

    await expect(plugin.getThreadSessionStats("thread-a")).rejects.toThrow(
      "The local Pi session file is not available."
    );

    expect(tracker.runners).toHaveLength(1);
    expect(tracker.runners[0].disposed).toBe(true);
    // The failure happened before any client was started.
    expect(tracker.requests).toEqual([]);
    expect(plugin.threadRunners.size).toBe(0);
  });

  it("disposes the temporary client and Pi process when the session RPC fails", async () => {
    const plugin = createSessionPlugin(["thread-a"]);
    const tracker = trackSessionActivity({ failRequestTypes: ["get_session_stats"] });

    await expect(plugin.getThreadSessionStats("thread-a")).rejects.toThrow(
      "Pi RPC get_session_stats failed."
    );

    expect(tracker.runners).toHaveLength(1);
    expect(tracker.runners[0].disposed).toBe(true);
    const clients = distinctClients(tracker);
    expect(clients).toHaveLength(1);
    expect(clients[0].disposed).toBe(true);
    expect(tracker.disposals.map(({ client }) => client)).toEqual(clients);
    expect(plugin.threadRunners.size).toBe(0);
    await expectChildProcessesGone(tracker);
  });

  it("leaves no long-lived runner or Pi process after ten threads are inspected", async () => {
    const threadIds = Array.from({ length: 10 }, (_, index) => `thread-${index}`);
    const plugin = createSessionPlugin(threadIds);
    const tracker = trackSessionActivity();
    expect(plugin.threadRunners.size).toBe(0);

    for (const threadId of threadIds) {
      await plugin.getThreadSessionStats(threadId);
      await plugin.getThreadSessionTree(threadId);
      await plugin.exportThreadSession(threadId);
    }

    // Nothing long-lived: no thread gained a cached runner, and every temporary
    // runner, client and Pi child process is gone.
    expect(plugin.threadRunners.size).toBe(0);
    expect(threadIds.every((threadId) => !plugin.threadRunners.has(threadId))).toBe(true);
    expect(tracker.runners).toHaveLength(30);
    expect(tracker.runners.every((runner) => runner.disposed === true)).toBe(true);
    const clients = distinctClients(tracker);
    expect(clients).toHaveLength(30);
    expect(clients.every((client) => client.disposed === true)).toBe(true);
    expect(tracker.disposals).toHaveLength(30);
    await expectChildProcessesGone(tracker);
  }, 120_000);
});

describe("session operations on a thread that already has a runner", () => {
  it("keeps that runner, its client and its Pi process, and never creates a second runner", async () => {
    const plugin = createSessionPlugin(["thread-a"]);
    const runner = plugin.createPiRunner("thread-a");
    expect(plugin.threadRunners.get("thread-a")).toBe(runner);
    expect(runner.rpcClient).toBeUndefined();
    const tracker = trackSessionActivity();

    await plugin.getThreadSessionStats("thread-a");
    const client = runner.rpcClient;
    await plugin.getThreadSessionTree("thread-a");
    await plugin.exportThreadSession("thread-a");

    expect(plugin.threadRunners.get("thread-a")).toBe(runner);
    expect(plugin.threadRunners.size).toBe(1);
    // All three lookups ran on the runner the thread already had.
    expect(new Set(tracker.runners)).toEqual(new Set([runner]));
    expect(runner.disposed).toBe(false);
    expect(runner.rpcClient).toBe(client);
    expect(client).toBeInstanceOf(PiRpcClient);
    expect(client.disposed).toBe(false);
    expect(client.running).toBe(true);
    expect(client.child.exitCode).toBeNull();
    expect(client.generation).toBe(1);
    expect(tracker.disposals).toEqual([]);
    expect(tracker.requests.map(({ type }) => type).sort()).toEqual([
      "export_html",
      "get_session_stats",
      "get_tree"
    ]);
  });
});
