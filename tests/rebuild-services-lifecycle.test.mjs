import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Notice texts are recorded so a test can assert that a failing disposal stays a
// console warning instead of reaching the user. vi.hoisted because the vi.mock
// factory below is hoisted above these declarations.
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
const { ContextBuilder } = await import("../src/context/context-builder.mjs");
const { PiCommandCatalog } = await import("../src/pi/command-catalog.mjs");
const { PiRpcClient } = await import("../src/pi/rpc-client.mjs");
const { PiRunner } = await import("../src/pi/runner.mjs");

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-rebuild-"));
  tempDirs.push(tempDir);
  return tempDir;
}

/**
 * A plugin instance that can run the real `rebuildServices()`: only the app
 * surface it hands to the services and the vault paths are stubbed, so the
 * service constructors and the service runner are the production ones.
 */
function createPlugin() {
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
  return plugin;
}

const THREAD_ID = "thread-1";
// A prompt context is always supplied, so `runPiPrompt()` never has to build one
// and the tests stay about which runner the run reaches.
const PROMPT_CONTEXT = { searchResults: [], linkedNeighborhood: [] };

/** A plugin that can run the real `runPiPrompt()`. */
function createRunPlugin() {
  const thread = { id: THREAD_ID, messages: [], piSessionId: undefined };
  const plugin = createPlugin();
  plugin.threadHistory = {
    getThread: vi.fn(() => thread),
    getCurrentThread: vi.fn(() => thread),
    setThreadPiSessionId: vi.fn()
  };
  plugin.syncCurrentThreadState = vi.fn();
  plugin.saveThreadHistory = vi.fn();
  return plugin;
}

/** Record which `PiRunner` instance each `run()` call lands on. */
function recordRunTargets() {
  const targets = [];
  vi.spyOn(PiRunner.prototype, "run").mockImplementation(async function () {
    targets.push(this);
    return { sessionId: undefined };
  });
  return targets;
}

describe("PiAgentPlugin.rebuildServices service runner lifecycle", () => {
  it("disposes the previous service runner before replacing it", () => {
    const plugin = createPlugin();
    plugin.rebuildServices();
    const previous = plugin.pi;
    const dispose = vi.fn(() => {
      // It is still the installed runner while it is being released: the disposal
      // is not a consequence of the new runner taking over.
      expect(plugin.pi).toBe(previous);
    });
    previous.dispose = dispose;

    plugin.rebuildServices();

    expect(dispose).toHaveBeenCalledOnce();
    expect(plugin.pi).not.toBe(previous);
    expect(plugin.pi).toBeInstanceOf(PiRunner);
    expect(plugin.threadRunners.size).toBe(0);
  });

  it("releases every service runner across consecutive rebuilds", () => {
    const plugin = createPlugin();
    const runners = [];
    for (let index = 0; index < 4; index += 1) {
      plugin.rebuildServices();
      runners.push(plugin.pi);
    }

    expect(new Set(runners).size).toBe(4);
    for (const runner of runners.slice(0, -1)) expect(runner.disposed).toBe(true);
    expect(runners.at(-1).disposed).toBe(false);
    // The service runner is never tracked as a chat runner.
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.hasActivePiRuns()).toBe(false);
  });

  it("disposes the RPC client the previous service runner started", () => {
    const plugin = createPlugin();
    plugin.rebuildServices();
    const previous = plugin.pi;
    const client = {
      disposed: false,
      dispose() {
        this.disposed = true;
      }
    };
    previous.rpcClient = client;

    plugin.rebuildServices();

    expect(client.disposed).toBe(true);
    expect(previous.disposed).toBe(true);
    expect(previous.rpcClient).toBeUndefined();
    expect(plugin.pi).not.toBe(previous);
  });

  it("rebuilds when no service runner exists yet", () => {
    const plugin = createPlugin();
    expect(plugin.pi).toBeUndefined();

    expect(() => plugin.rebuildServices()).not.toThrow();

    expect(plugin.pi).toBeInstanceOf(PiRunner);
    expect(plugin.graph).toBeTruthy();
    expect(plugin.contextBuilder).toBeTruthy();
    expect(plugin.catalog).toBeTruthy();
    expect(plugin.commandCatalog).toBeTruthy();
  });

  it("rebuilds when the previous service runner was already disposed", () => {
    const plugin = createPlugin();
    plugin.rebuildServices();
    const previous = plugin.pi;
    previous.dispose();

    expect(() => plugin.rebuildServices()).not.toThrow();

    expect(previous.disposed).toBe(true);
    expect(plugin.pi).toBeInstanceOf(PiRunner);
    expect(plugin.pi).not.toBe(previous);
  });

  it("keeps rebuilding when the previous service runner fails to dispose", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const plugin = createPlugin();
      const previous = {
        dispose() {
          throw new Error("dispose boom");
        }
      };
      plugin.pi = previous;

      expect(() => plugin.rebuildServices()).not.toThrow();

      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).toContain("service runner");
      expect(plugin.pi).not.toBe(previous);
      expect(plugin.pi).toBeInstanceOf(PiRunner);
      // A failed release is reported once, on the console, and nowhere else.
      expect(harness.notices).toEqual([]);
      expect(plugin.graph).toBeTruthy();
      expect(plugin.commandCatalog).toBeTruthy();
    } finally {
      warn.mockRestore();
    }
  });

  it("terminates the Pi process of the previous service runner on rebuild", async () => {
    const plugin = createPlugin();
    plugin.rebuildServices();
    const previous = plugin.pi;
    const client = new PiRpcClient({
      piExecutablePath: process.execPath,
      cwd: process.cwd(),
      args: [path.resolve("tests/fixtures/fake-pi-rpc.mjs")]
    });
    clients.push(client);
    await client.start();
    const child = client.child;
    previous.rpcClient = client;

    plugin.rebuildServices();

    expect(client.disposed).toBe(true);
    expect(previous.disposed).toBe(true);
    expect(plugin.pi).not.toBe(previous);
    await vi.waitFor(
      () => expect(child.exitCode !== null || child.signalCode !== null).toBe(true),
      { timeout: 5_000 }
    );
  });
});

describe("PiAgentPlugin.runPiPrompt service runner resolution", () => {
  it("uses the current service runner when the services are complete", async () => {
    const plugin = createRunPlugin();
    plugin.rebuildServices();
    const serviceRunner = plugin.pi;
    const rebuildServices = vi.spyOn(plugin, "rebuildServices");
    const targets = recordRunTargets();

    await plugin.runPiPrompt(
      "hello",
      { isCanceled: () => false },
      THREAD_ID,
      undefined,
      [],
      PROMPT_CONTEXT
    );

    expect(rebuildServices).not.toHaveBeenCalled();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toBe(serviceRunner);
    expect(plugin.pi).toBe(serviceRunner);
  });

  it("resolves the service runner after the rebuild instead of the disposed one", async () => {
    const plugin = createRunPlugin();
    plugin.rebuildServices();
    const previous = plugin.pi;
    const rebuildServices = vi.spyOn(plugin, "rebuildServices");
    // Services incomplete: the guard inside runPiPrompt() rebuilds them, which
    // disposes and replaces the runner a parameter default would have captured.
    plugin.graph = undefined;
    const targets = recordRunTargets();

    await plugin.runPiPrompt(
      "hello",
      { isCanceled: () => false },
      THREAD_ID,
      undefined,
      [],
      PROMPT_CONTEXT
    );

    expect(rebuildServices).toHaveBeenCalledOnce();
    expect(previous.disposed).toBe(true);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toBe(plugin.pi);
    expect(targets).not.toContain(previous);
  });

  it("keeps the registered thread runner the caller passed even when the services are rebuilt", async () => {
    const plugin = createRunPlugin();
    plugin.rebuildServices();
    const previous = plugin.pi;
    // The real chat path: the runner a run passes to runPiPrompt() comes from the
    // plugin's own registry, so it is the same object rebuildServices() sees.
    const threadRunner = plugin.createPiRunner(THREAD_ID);
    expect(plugin.threadRunners.get(THREAD_ID)).toBe(threadRunner);
    plugin.graph = undefined;
    const targets = recordRunTargets();

    await plugin.runPiPrompt(
      "hello",
      { isCanceled: () => false },
      THREAD_ID,
      threadRunner,
      [],
      PROMPT_CONTEXT
    );

    // The rebuild still released the old service runner, but the run keeps the
    // registered thread runner its caller chose -- alive and still registered.
    expect(targets).toHaveLength(1);
    expect(targets[0]).toBe(threadRunner);
    expect(threadRunner.disposed).toBe(false);
    expect(plugin.threadRunners.get(THREAD_ID)).toBe(threadRunner);
    expect(previous.disposed).toBe(true);
    expect(plugin.pi).not.toBe(threadRunner);
  });

  it("does not dispose registered thread runners when a run restores missing services", async () => {
    const plugin = createRunPlugin();
    plugin.rebuildServices();
    const previousServiceRunner = plugin.pi;
    const threadRunner = plugin.createPiRunner(THREAD_ID);
    const otherThreadRunner = plugin.createPiRunner("thread-2");
    plugin.graph = undefined;
    const targets = recordRunTargets();

    await plugin.runPiPrompt(
      "hello",
      { isCanceled: () => false },
      THREAD_ID,
      threadRunner,
      [],
      PROMPT_CONTEXT
    );

    expect(threadRunner.disposed).toBe(false);
    expect(otherThreadRunner.disposed).toBe(false);
    expect(plugin.threadRunners.get(THREAD_ID)).toBe(threadRunner);
    expect(plugin.threadRunners.get("thread-2")).toBe(otherThreadRunner);
    expect(previousServiceRunner.disposed).toBe(true);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toBe(threadRunner);
  });

  it("still releases thread runners when the services are rebuilt for a settings change", () => {
    const plugin = createRunPlugin();
    plugin.rebuildServices();
    const serviceRunner = plugin.pi;
    const threadRunner = plugin.createPiRunner(THREAD_ID);

    // What saveSettings()/rebuildServicesIfPending() do: replace the services the
    // thread runners were built on and release those runners with them.
    plugin.rebuildServices();

    expect(threadRunner.disposed).toBe(true);
    expect(serviceRunner.disposed).toBe(true);
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.pi).not.toBe(serviceRunner);
  });

  it("runs on the new service runner while the old one and its client stay disposed", async () => {
    const plugin = createRunPlugin();
    plugin.rebuildServices();
    const previous = plugin.pi;
    const client = {
      disposed: false,
      dispose() {
        this.disposed = true;
      }
    };
    previous.rpcClient = client;
    plugin.graph = undefined;
    plugin.contextBuilder = undefined;
    const targets = recordRunTargets();

    await plugin.runPiPrompt(
      "hello",
      { isCanceled: () => false },
      THREAD_ID,
      undefined,
      [],
      PROMPT_CONTEXT
    );

    const current = plugin.pi;
    expect(previous.disposed).toBe(true);
    expect(client.disposed).toBe(true);
    expect(current.disposed).toBe(false);
    expect(current).not.toBe(previous);
    expect(current.rpcClient).toBeUndefined();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toBe(current);
  });
});

describe("PiAgentPlugin service restore paths", () => {
  it("restores the command catalog without releasing registered thread runners", async () => {
    const plugin = createRunPlugin();
    plugin.rebuildServices();
    const previousServiceRunner = plugin.pi;
    const previousCatalog = plugin.commandCatalog;
    const threadRunner = plugin.createPiRunner(THREAD_ID);
    const otherThreadRunner = plugin.createPiRunner("thread-2");
    vi.spyOn(PiCommandCatalog.prototype, "getCommands").mockResolvedValue([]);
    plugin.commandCatalog = undefined;

    await plugin.refreshCommandCatalog(false);

    expect(threadRunner.disposed).toBe(false);
    expect(otherThreadRunner.disposed).toBe(false);
    expect(plugin.threadRunners.get(THREAD_ID)).toBe(threadRunner);
    // The restore did rebuild the service parts, including the service runner.
    expect(plugin.commandCatalog).toBeTruthy();
    expect(plugin.commandCatalog).not.toBe(previousCatalog);
    expect(previousServiceRunner.disposed).toBe(true);
    expect(plugin.pi).not.toBe(previousServiceRunner);
  });

  it("restores the context builder for an inspection without releasing registered thread runners", async () => {
    const plugin = createRunPlugin();
    plugin.rebuildServices();
    const threadRunner = plugin.createPiRunner(THREAD_ID);
    const inspectContext = vi
      .spyOn(ContextBuilder.prototype, "inspectContext")
      .mockResolvedValue({ prompt: "hello" });
    plugin.graph = undefined;
    plugin.contextBuilder = undefined;

    await expect(plugin.inspectPiContext("hello")).resolves.toEqual({ prompt: "hello" });

    expect(inspectContext).toHaveBeenCalledOnce();
    expect(threadRunner.disposed).toBe(false);
    expect(plugin.threadRunners.get(THREAD_ID)).toBe(threadRunner);
    expect(plugin.contextBuilder).toBeTruthy();
    expect(plugin.graph).toBeTruthy();
  });

  it("returns the already registered thread runner when createPiRunner restores the services", () => {
    const plugin = createRunPlugin();
    plugin.rebuildServices();
    const previousServiceRunner = plugin.pi;
    const threadRunner = plugin.createPiRunner(THREAD_ID);
    expect(plugin.threadRunners.get(THREAD_ID)).toBe(threadRunner);
    // Services go missing while that runner is registered and in use.
    plugin.graph = undefined;
    plugin.contextBuilder = undefined;

    const again = plugin.createPiRunner(THREAD_ID);

    expect(again).toBe(threadRunner);
    expect(threadRunner.disposed).toBe(false);
    // No second runner for the same thread, and the registry was not cleared.
    expect(plugin.threadRunners.size).toBe(1);
    expect(plugin.threadRunners.get(THREAD_ID)).toBe(threadRunner);
    expect(previousServiceRunner.disposed).toBe(true);
    expect(plugin.pi).not.toBe(previousServiceRunner);
  });

  it("restores the graph for a frontmatter suggestion without releasing registered thread runners", async () => {
    const plugin = createRunPlugin();
    plugin.rebuildServices();
    const previousServiceRunner = plugin.pi;
    const threadRunner = plugin.createPiRunner(THREAD_ID);
    plugin.graph = undefined;

    await plugin.suggestFrontmatterForCurrentNote();

    expect(threadRunner.disposed).toBe(false);
    expect(plugin.threadRunners.get(THREAD_ID)).toBe(threadRunner);
    expect(plugin.graph).toBeTruthy();
    expect(previousServiceRunner.disposed).toBe(true);
    // No note is open in this harness, so the command stops after restoring.
    expect(harness.notices).toContain("Open a markdown note first.");
  });
});
