import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Notice texts are recorded so a test can assert that a lifecycle cleanup never
// reaches the user. vi.hoisted because the vi.mock factory below is hoisted above
// these declarations.
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
const { ThreadStore } = await import("../src/threads/thread-store.mjs");

const CURRENT_THREAD_ID = "thread-current";
const ARCHIVED_THREAD_ID = "thread-a";
const OTHER_THREAD_ID = "thread-b";

let tempDirs = [];
let clients = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.dispose();
  for (const tempDir of tempDirs) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDirs = [];
  harness.notices.length = 0;
});

function createTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-archive-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function storedThread(id) {
  const now = Date.now();
  return {
    id,
    title: `Thread ${id}`,
    messages: [],
    createdAt: now,
    updatedAt: now,
    archived: false,
    favorite: false
  };
}

/**
 * A plugin whose thread store, runner registry and services are the production
 * ones; only the app surface, the vault paths and the persistence calls are
 * stubbed, so `createPiRunner()` and the archive entry points behave for real.
 */
function createArchivePlugin() {
  const pluginDirectory = createTempDir();
  const plugin = Object.create(PiAgentPlugin.prototype);
  plugin.settings = { ...DEFAULT_SETTINGS };
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
  plugin.threadHistory = new ThreadStore({
    currentThreadId: CURRENT_THREAD_ID,
    threads: [
      storedThread(CURRENT_THREAD_ID),
      storedThread(ARCHIVED_THREAD_ID),
      storedThread(OTHER_THREAD_ID)
    ]
  });
  plugin.syncCurrentThreadState = vi.fn();
  plugin.saveThreadHistory = vi.fn();
  plugin.rebuildServices();
  return plugin;
}

function createFakeRpcClient() {
  return {
    child: { pid: 4242 },
    disposed: false,
    dispose() {
      this.disposed = true;
    }
  };
}

/** Register a real runner for a thread and give it an idle RPC client. */
function registerRunner(plugin, threadId) {
  const runner = plugin.createPiRunner(threadId);
  const client = createFakeRpcClient();
  runner.rpcClient = client;
  return { runner, client };
}

function isArchived(plugin, threadId) {
  return plugin.threadHistory.getThread(threadId)?.archived === true;
}

describe("PiAgentPlugin thread archive runner lifecycle", () => {
  it("releases the archived thread's runner and its RPC client", () => {
    const plugin = createArchivePlugin();
    const { runner, client } = registerRunner(plugin, ARCHIVED_THREAD_ID);

    expect(plugin.archiveThread(ARCHIVED_THREAD_ID)).toBe(true);

    expect(isArchived(plugin, ARCHIVED_THREAD_ID)).toBe(true);
    expect(plugin.threadRunners.has(ARCHIVED_THREAD_ID)).toBe(false);
    expect(runner.disposed).toBe(true);
    expect(client.disposed).toBe(true);
  });

  it("releases only the runners of the threads archiveThreads archived", () => {
    const plugin = createArchivePlugin();
    const archived = registerRunner(plugin, ARCHIVED_THREAD_ID);
    const kept = registerRunner(plugin, OTHER_THREAD_ID);
    const current = registerRunner(plugin, CURRENT_THREAD_ID);

    const result = plugin.archiveThreads([ARCHIVED_THREAD_ID]);

    expect(result.archivedIds).toEqual([ARCHIVED_THREAD_ID]);
    expect(isArchived(plugin, ARCHIVED_THREAD_ID)).toBe(true);
    expect(plugin.threadRunners.has(ARCHIVED_THREAD_ID)).toBe(false);
    expect(archived.runner.disposed).toBe(true);
    expect(archived.client.disposed).toBe(true);
    // Threads that were not archived keep their runner, client and registration.
    expect(plugin.threadRunners.get(OTHER_THREAD_ID)).toBe(kept.runner);
    expect(kept.runner.disposed).toBe(false);
    expect(kept.client.disposed).toBe(false);
    expect(plugin.threadRunners.get(CURRENT_THREAD_ID)).toBe(current.runner);
    expect(current.runner.disposed).toBe(false);
  });

  it("deletes the archived threads clearArchivedThreads removes and releases their clients", () => {
    const plugin = createArchivePlugin();
    plugin.threadHistory.archiveThread(ARCHIVED_THREAD_ID);
    plugin.threadHistory.archiveThread(OTHER_THREAD_ID);
    const archived = registerRunner(plugin, ARCHIVED_THREAD_ID);
    const otherArchived = registerRunner(plugin, OTHER_THREAD_ID);
    const current = registerRunner(plugin, CURRENT_THREAD_ID);

    expect(plugin.clearArchivedThreads()).toBe(2);

    expect(plugin.threadHistory.getThread(ARCHIVED_THREAD_ID)).toBeUndefined();
    expect(plugin.threadHistory.getThread(OTHER_THREAD_ID)).toBeUndefined();
    expect(plugin.threadRunners.has(ARCHIVED_THREAD_ID)).toBe(false);
    expect(plugin.threadRunners.has(OTHER_THREAD_ID)).toBe(false);
    // deleteThreads() releases the runner's RPC client and its registry entry.
    expect(archived.client.disposed).toBe(true);
    expect(otherArchived.client.disposed).toBe(true);
    // A thread the store keeps -- here the active one -- keeps its runner.
    expect(plugin.threadRunners.get(CURRENT_THREAD_ID)).toBe(current.runner);
    expect(current.runner.disposed).toBe(false);
    expect(current.client.disposed).toBe(false);
  });

  it("keeps the current thread's runner when that thread is the one archived", () => {
    const plugin = createArchivePlugin();
    // The store keeps the current thread even when it is archived, so clearing
    // archived threads must not release its runner either.
    plugin.threadHistory.archiveThread(CURRENT_THREAD_ID);
    const current = registerRunner(plugin, CURRENT_THREAD_ID);

    expect(plugin.clearArchivedThreads()).toBe(0);

    expect(plugin.threadHistory.getThread(CURRENT_THREAD_ID)).toBeTruthy();
    expect(plugin.threadRunners.get(CURRENT_THREAD_ID)).toBe(current.runner);
    expect(current.runner.disposed).toBe(false);
    expect(current.client.disposed).toBe(false);
  });

  it("archives a thread that has no runner without touching other runners", () => {
    const plugin = createArchivePlugin();
    const kept = registerRunner(plugin, OTHER_THREAD_ID);

    expect(plugin.archiveThread(ARCHIVED_THREAD_ID)).toBe(true);

    expect(isArchived(plugin, ARCHIVED_THREAD_ID)).toBe(true);
    expect(plugin.threadRunners.has(ARCHIVED_THREAD_ID)).toBe(false);
    expect(plugin.threadRunners.get(OTHER_THREAD_ID)).toBe(kept.runner);
    expect(kept.runner.disposed).toBe(false);
    expect(harness.notices).toEqual([]);
  });

  it("clears archived threads that have no runner without touching other runners", () => {
    const plugin = createArchivePlugin();
    plugin.threadHistory.archiveThread(ARCHIVED_THREAD_ID);
    const current = registerRunner(plugin, CURRENT_THREAD_ID);

    expect(() => plugin.clearArchivedThreads()).not.toThrow();

    expect(plugin.threadHistory.getThread(ARCHIVED_THREAD_ID)).toBeUndefined();
    expect(plugin.threadRunners.get(CURRENT_THREAD_ID)).toBe(current.runner);
    expect(current.runner.disposed).toBe(false);
  });
});

describe("PiAgentPlugin archiving a thread whose runner is running", () => {
  it("refuses to archive it and keeps the running runner alive", () => {
    const plugin = createArchivePlugin();
    const { runner, client } = registerRunner(plugin, ARCHIVED_THREAD_ID);
    runner.isRunning = true;

    expect(plugin.archiveThread(ARCHIVED_THREAD_ID)).toBe(false);

    // Same contract as deleteThread(): the thread is untouched and the run keeps
    // its runner until it settles.
    expect(isArchived(plugin, ARCHIVED_THREAD_ID)).toBe(false);
    expect(plugin.threadRunners.get(ARCHIVED_THREAD_ID)).toBe(runner);
    expect(runner.disposed).toBe(false);
    expect(client.disposed).toBe(false);
    expect(runner.isRunning).toBe(true);
    expect(plugin.saveThreadHistory).not.toHaveBeenCalled();
  });

  it("skips running threads in archiveThreads and reports them", () => {
    const plugin = createArchivePlugin();
    const running = registerRunner(plugin, ARCHIVED_THREAD_ID);
    running.runner.isRunning = true;
    const idle = registerRunner(plugin, OTHER_THREAD_ID);

    const result = plugin.archiveThreads([ARCHIVED_THREAD_ID, OTHER_THREAD_ID]);

    expect(result.archivedIds).toEqual([OTHER_THREAD_ID]);
    expect(result.skippedIds).toEqual([ARCHIVED_THREAD_ID]);
    expect(isArchived(plugin, ARCHIVED_THREAD_ID)).toBe(false);
    expect(isArchived(plugin, OTHER_THREAD_ID)).toBe(true);
    expect(plugin.threadRunners.get(ARCHIVED_THREAD_ID)).toBe(running.runner);
    expect(running.runner.disposed).toBe(false);
    expect(running.client.disposed).toBe(false);
    expect(plugin.threadRunners.has(OTHER_THREAD_ID)).toBe(false);
    expect(idle.runner.disposed).toBe(true);
  });

  it("keeps a running archived thread and deletes it once its run has ended", () => {
    const plugin = createArchivePlugin();
    plugin.threadHistory.archiveThread(ARCHIVED_THREAD_ID);
    plugin.threadHistory.archiveThread(OTHER_THREAD_ID);
    const running = registerRunner(plugin, ARCHIVED_THREAD_ID);
    running.runner.isRunning = true;
    const idle = registerRunner(plugin, OTHER_THREAD_ID);

    // Only the thread that can be deleted safely is deleted; the running one is
    // excluded from the count instead of losing its history under the run.
    expect(plugin.clearArchivedThreads()).toBe(1);

    expect(plugin.threadHistory.getThread(ARCHIVED_THREAD_ID)).toBeTruthy();
    expect(isArchived(plugin, ARCHIVED_THREAD_ID)).toBe(true);
    expect(plugin.threadRunners.get(ARCHIVED_THREAD_ID)).toBe(running.runner);
    expect(running.runner.disposed).toBe(false);
    expect(running.runner.isRunning).toBe(true);
    expect(running.client.disposed).toBe(false);
    expect(plugin.threadHistory.getThread(OTHER_THREAD_ID)).toBeUndefined();
    expect(plugin.threadRunners.has(OTHER_THREAD_ID)).toBe(false);
    expect(idle.client.disposed).toBe(true);

    // The run ends, and the next clear removes the thread and releases its runner.
    running.runner.isRunning = false;

    expect(plugin.clearArchivedThreads()).toBe(1);

    expect(plugin.threadHistory.getThread(ARCHIVED_THREAD_ID)).toBeUndefined();
    expect(plugin.threadRunners.has(ARCHIVED_THREAD_ID)).toBe(false);
    expect(running.client.disposed).toBe(true);
  });
});

describe("PiAgentPlugin archive runner process teardown", () => {
  it("terminates the Pi process of an archived thread's runner", async () => {
    const plugin = createArchivePlugin();
    const runner = plugin.createPiRunner(ARCHIVED_THREAD_ID);
    const client = new PiRpcClient({
      piExecutablePath: process.execPath,
      cwd: process.cwd(),
      args: [path.resolve("tests/fixtures/fake-pi-rpc.mjs")]
    });
    clients.push(client);
    await client.start();
    const child = client.child;
    runner.rpcClient = client;

    expect(plugin.archiveThread(ARCHIVED_THREAD_ID)).toBe(true);

    expect(runner.disposed).toBe(true);
    expect(client.disposed).toBe(true);
    await vi.waitFor(
      () => expect(child.exitCode !== null || child.signalCode !== null).toBe(true),
      { timeout: 5_000 }
    );
  });

  it("terminates the Pi processes of the archived threads clearArchivedThreads removes", async () => {
    const plugin = createArchivePlugin();
    plugin.threadHistory.archiveThread(ARCHIVED_THREAD_ID);
    plugin.threadHistory.archiveThread(OTHER_THREAD_ID);
    const started = [];
    for (const threadId of [ARCHIVED_THREAD_ID, OTHER_THREAD_ID]) {
      const runner = plugin.createPiRunner(threadId);
      const client = new PiRpcClient({
        piExecutablePath: process.execPath,
        cwd: process.cwd(),
        args: [path.resolve("tests/fixtures/fake-pi-rpc.mjs")]
      });
      clients.push(client);
      await client.start();
      runner.rpcClient = client;
      started.push({ runner, client, child: client.child });
    }

    expect(plugin.clearArchivedThreads()).toBe(2);

    for (const { client } of started) expect(client.disposed).toBe(true);
    expect(plugin.threadRunners.size).toBe(0);
    await vi.waitFor(
      () =>
        expect(
          started.every(({ child }) => child.exitCode !== null || child.signalCode !== null)
        ).toBe(true),
      { timeout: 5_000 }
    );
  });

  it("keeps the live Pi process of a running archived thread until its run has ended", async () => {
    const plugin = createArchivePlugin();
    plugin.threadHistory.archiveThread(ARCHIVED_THREAD_ID);
    const runner = plugin.createPiRunner(ARCHIVED_THREAD_ID);
    const client = new PiRpcClient({
      piExecutablePath: process.execPath,
      cwd: process.cwd(),
      args: [path.resolve("tests/fixtures/fake-pi-rpc.mjs")]
    });
    clients.push(client);
    await client.start();
    const child = client.child;
    runner.rpcClient = client;
    runner.isRunning = true;

    expect(plugin.clearArchivedThreads()).toBe(0);

    // Still archived, still registered, and its Pi process is still alive.
    expect(isArchived(plugin, ARCHIVED_THREAD_ID)).toBe(true);
    expect(plugin.threadRunners.get(ARCHIVED_THREAD_ID)).toBe(runner);
    expect(client.disposed).toBe(false);
    expect(child.exitCode).toBeNull();

    runner.isRunning = false;

    expect(plugin.clearArchivedThreads()).toBe(1);

    expect(plugin.threadRunners.has(ARCHIVED_THREAD_ID)).toBe(false);
    expect(client.disposed).toBe(true);
    await vi.waitFor(
      () => expect(child.exitCode !== null || child.signalCode !== null).toBe(true),
      { timeout: 5_000 }
    );
  });
});
