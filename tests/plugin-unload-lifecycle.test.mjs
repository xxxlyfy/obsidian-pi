import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Notice texts are recorded so a test can assert what the user was told.
// vi.hoisted because the vi.mock factory below is hoisted above these declarations.
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
const { settleRunFailure } = await import("../src/ui/view/run-lifecycle.mjs");

let tempDirs = [];

afterEach(() => {
  for (const tempDir of tempDirs) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDirs = [];
  harness.notices.length = 0;
});

function createTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-unload-"));
  tempDirs.push(tempDir);
  return tempDir;
}

/**
 * A stand-in for `PiRpcClient` that models the parts the unload path depends on:
 * `abort()`, `dispose()` rejecting in-flight requests, and `dispose()` dropping
 * the run's subscription. Every call lands in the shared `order` timeline.
 *
 * `abortSettles` models Pi honouring the abort request by settling the run; the
 * `false` case is Pi never answering, which only `dispose()` can resolve.
 */
function createFakeRpcClient({
  label = "client",
  order = [],
  promptHangs = false,
  abortSettles = true
} = {}) {
  const listeners = new Set();
  const pendingPrompts = [];
  const calls = [];
  return {
    child: { pid: 4242 },
    disposed: false,
    calls,
    start: vi.fn(async () => {}),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request(type) {
      calls.push(type);
      if (type === "get_state") return Promise.resolve({});
      if (type === "prompt") {
        if (promptHangs) return new Promise((_resolve, reject) => pendingPrompts.push({ reject }));
        return Promise.resolve();
      }
      return Promise.resolve({});
    },
    abort: vi.fn(async () => {
      order.push(`${label}:abort`);
      if (abortSettles)
        for (const listener of [...listeners]) listener({ type: "agent_settled" });
    }),
    dispose() {
      this.disposed = true;
      order.push(`${label}:dispose`);
      // What PiRpcClient.dispose() does to a request that is still in flight.
      for (const { reject } of pendingPrompts.splice(0))
        reject(new Error("Pi RPC client disposed."));
      listeners.clear();
    }
  };
}

function createRunner(rpcClient, pluginDirectory) {
  return new PiRunner(
    { ...DEFAULT_SETTINGS },
    { formatPrompt: (prompt) => prompt },
    "/vault",
    pluginDirectory,
    rpcClient
  );
}

function createPlugin(runners = []) {
  const plugin = Object.create(PiAgentPlugin.prototype);
  plugin.settings = { ...DEFAULT_SETTINGS };
  plugin.threadRunners = new Map(runners);
  plugin.annotationController = { destroy: vi.fn() };
  return plugin;
}

/** The subset of the chat view `settleRunFailure` reads. */
function createRunView() {
  const addedMessages = [];
  return {
    addedMessages,
    view: {
      plugin: {
        settings: {},
        addMessageToThread: vi.fn((_threadId, message) => addedMessages.push(message))
      },
      state: { completedThinkingExpansion: new Map() },
      isCurrentThread: () => true,
      renderThreadTitle: vi.fn(),
      renderMessages: vi.fn(),
      renderToolBadges: vi.fn(),
      notifyRunCompleted: vi.fn()
    }
  };
}

function createRunRecord() {
  return {
    canceling: false,
    thinking: "",
    thinkingUserSet: false,
    toolErrors: [],
    notificationRunId: "run-1"
  };
}

describe("PiAgentPlugin unload run lifecycle", () => {
  it("cancels a running thread runner before disposing it, and the run settles as canceled", async () => {
    const order = [];
    const client = createFakeRpcClient({ label: "running", order });
    const runner = createRunner(client, createTempDir());
    const run = runner.runPiRpc("hello", undefined);
    await vi.waitFor(() => expect(client.calls).toContain("prompt"));

    const plugin = createPlugin([["thread-1", runner]]);
    plugin.onunload();

    await expect(run).rejects.toThrow("Pi run canceled.");
    // cancel -> cleanup/dispose, never dispose -> accidental failure.
    expect(order).toEqual(["running:abort", "running:dispose"]);
    expect(client.disposed).toBe(true);
    expect(runner.isRunning).toBe(false);
    expect(runner.disposed).toBe(true);
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.hasActivePiRuns()).toBe(false);
  });

  it("cancels the running runner and only disposes an idle one", async () => {
    const order = [];
    const runningClient = createFakeRpcClient({ label: "running", order });
    const idleClient = createFakeRpcClient({ label: "idle", order });
    const pluginDirectory = createTempDir();
    const running = createRunner(runningClient, pluginDirectory);
    const idle = createRunner(idleClient, pluginDirectory);
    const run = running.runPiRpc("hello", undefined);
    await vi.waitFor(() => expect(runningClient.calls).toContain("prompt"));

    const plugin = createPlugin([
      ["running", running],
      ["idle", idle]
    ]);

    expect(() => plugin.onunload()).not.toThrow();
    await expect(run).rejects.toThrow("Pi run canceled.");

    expect(runningClient.abort).toHaveBeenCalledOnce();
    // An idle runner has nothing to abort: disposal alone is the work.
    expect(idleClient.abort).not.toHaveBeenCalled();
    expect(order).toEqual(["running:abort", "running:dispose", "idle:dispose"]);
    expect(idleClient.disposed).toBe(true);
    expect(plugin.threadRunners.size).toBe(0);
  });

  it("does not report a run canceled by unload as an agent failure", async () => {
    const order = [];
    // The run is inside its `prompt` request, which is exactly what the old unload
    // path rejected with "Pi RPC client disposed.".
    const client = createFakeRpcClient({ label: "running", order, promptHangs: true });
    const runner = createRunner(client, createTempDir());
    const run = runner.runPiRpc("hello", undefined);
    await vi.waitFor(() => expect(client.calls).toContain("prompt"));

    const plugin = createPlugin([["thread-1", runner]]);
    plugin.onunload();

    const error = await run.then(
      () => new Error("the run should have been canceled"),
      (runError) => runError
    );
    expect(error.message).toBe("Pi run canceled.");

    const { addedMessages, view } = createRunView();
    expect(settleRunFailure(view, createRunRecord(), "thread-1", error)).toBe("canceled");
    expect(addedMessages).toEqual([]);
    expect(harness.notices.some((notice) => notice.startsWith("Agent run failed"))).toBe(false);
    expect(harness.notices).toContain("Agent run canceled.");
  });

  it("settles a run whose abort Pi never answered when the plugin unloads", async () => {
    const order = [];
    // Pi ignores the abort, so the run is waiting for a final event that the
    // disposed client can no longer deliver. Disposal has to settle it anyway, and
    // as a cancel rather than as a client failure.
    const client = createFakeRpcClient({ label: "silent", order, abortSettles: false });
    const runner = createRunner(client, createTempDir());
    const run = runner.runPiRpc("hello", undefined);
    await vi.waitFor(() => expect(client.calls).toContain("prompt"));

    createPlugin([["thread-1", runner]]).onunload();

    await expect(run).rejects.toThrow("Pi run canceled.");
    expect(order).toEqual(["silent:abort", "silent:dispose"]);
    expect(runner.isRunning).toBe(false);
  });

  it("keeps normal user cancellation intact: abort only, no disposal, runner reusable", async () => {
    const order = [];
    const client = createFakeRpcClient({ label: "user", order });
    const runner = createRunner(client, createTempDir());
    const run = runner.runPiRpc("hello", undefined);
    await vi.waitFor(() => expect(client.calls).toContain("prompt"));

    // What PiAgentView.cancelCurrentRun() does: request the stop, dispose nothing.
    runner.cancelCurrentRun();

    const error = await run.then(
      () => new Error("the run should have been canceled"),
      (runError) => runError
    );
    expect(error.message).toBe("Pi run canceled.");
    expect(order).toEqual(["user:abort"]);
    expect(client.disposed).toBe(false);
    expect(runner.disposed).toBe(false);

    const { addedMessages, view } = createRunView();
    expect(settleRunFailure(view, createRunRecord(), "thread-1", error)).toBe("canceled");
    expect(addedMessages).toEqual([]);
    expect(harness.notices).toContain("Agent run canceled.");

    // A user cancel is not terminal: the same runner still starts the next run.
    const nextRun = runner.runPiRpc("again", undefined);
    await vi.waitFor(() =>
      expect(client.calls.filter((type) => type === "prompt")).toHaveLength(2)
    );
    runner.cancelCurrentRun();
    await expect(nextRun).rejects.toThrow("Pi run canceled.");
  });

  it("tears down a Pi process that was still starting when the plugin unloaded", async () => {
    let finishStart;
    const client = {
      child: { pid: 1 },
      disposed: false,
      calls: [],
      start: () => new Promise((resolve) => (finishStart = resolve)),
      subscribe: () => () => {},
      request: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(function () {
        this.disposed = true;
      })
    };
    const runner = createRunner(client, createTempDir());
    const run = runner.runPiRpc("hello", undefined);
    await vi.waitFor(() => expect(runner.isRunning).toBe(true));

    const plugin = createPlugin([["thread-1", runner]]);
    plugin.onunload();
    finishStart();

    await expect(run).rejects.toThrow("Pi run canceled.");
    expect(client.dispose).toHaveBeenCalled();
    // Pi never received a prompt, and the started client was not left behind.
    expect(client.request).not.toHaveBeenCalled();
    expect(runner.rpcClient).toBeUndefined();
    expect(runner.isRunning).toBe(false);
  });

  it("refuses to spawn Pi for a runner requested after unload", async () => {
    const plugin = createPlugin();
    plugin.graph = {};
    plugin.contextBuilder = { getSystemInstructions: () => "" };
    plugin.getVaultBasePath = () => "/vault";
    plugin.getPluginDirectory = () => createTempDir();
    plugin.getExtensionUiHandler = () => undefined;
    plugin.onunload();

    const runner = plugin.createPiRunner("thread-2");

    expect(runner.disposed).toBe(true);
    await expect(runner.runPiRpc("late queue drain", undefined)).rejects.toThrow(
      "Pi run canceled."
    );
    expect(runner.rpcClient).toBeUndefined();
  });

  it("completes the unload even when a runner fails to cancel or dispose", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const order = [];
      const client = createFakeRpcClient({ label: "healthy", order });
      const healthy = createRunner(client, createTempDir());
      const broken = {
        isRunning: true,
        cancelCurrentRun() {
          throw new Error("cancel boom");
        },
        dispose() {
          throw new Error("dispose boom");
        }
      };
      const plugin = createPlugin([
        ["broken", broken],
        ["healthy", healthy]
      ]);

      expect(() => plugin.onunload()).not.toThrow();
      expect(client.disposed).toBe(true);
      expect(order).toEqual(["healthy:dispose"]);
      expect(plugin.threadRunners.size).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("Pi abort ordering on unload", () => {
  it("writes the abort request to the live Pi child before any dispose runs", async () => {
    const client = new PiRpcClient({
      piExecutablePath: process.execPath,
      cwd: process.cwd(),
      args: [path.resolve("tests/fixtures/fake-pi-rpc.mjs")]
    });
    try {
      await client.start();
      const order = [];
      const stdin = client.child.stdin;
      const write = stdin.write.bind(stdin);
      stdin.write = (chunk, ...rest) => {
        if (String(chunk).includes('"type":"abort"')) order.push("abort-request");
        return write(chunk, ...rest);
      };
      const dispose = client.dispose.bind(client);
      client.dispose = () => {
        order.push("dispose");
        dispose();
      };

      const runner = createRunner(client, createTempDir());
      // This test is about the order the unload path issues its calls in, not about
      // what Pi answers, so the runner is marked busy instead of driving a run.
      runner.isRunning = true;
      const child = client.child;

      createPlugin([["thread-1", runner]]).onunload();

      // The abort bytes are on the pipe before the client is disposed, which is why
      // an `onunload()` that Obsidian never awaits cannot lose the request.
      expect(order).toEqual(["abort-request", "dispose"]);
      await vi.waitFor(
        () => expect(child.exitCode !== null || child.signalCode !== null).toBe(true),
        { timeout: 5_000 }
      );
    } finally {
      client.dispose();
    }
  });
});
