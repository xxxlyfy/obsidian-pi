import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../src/agent/agent-runtime.mjs";
import { PromptDelivery } from "../src/agent/prompt-delivery.mjs";
import { DEFAULT_SETTINGS } from "../src/plugin/settings.mjs";
import { ThreadRunnerRegistry } from "../src/plugin/thread-runners.mjs";
import { ThreadService } from "../src/threads/thread-service.mjs";
import { ThreadStore } from "../src/threads/thread-store.mjs";
import { PiRunner } from "../src/pi/runner.mjs";

const notices = vi.hoisted(() => ({ messages: [] }));
const state = vi.hoisted(() => ({ instances: [] }));

vi.mock("obsidian", () => ({
  Component: class {},
  FuzzySuggestModal: class {},
  ItemView: class {},
  MarkdownRenderChild: class {},
  MarkdownRenderer: { render: vi.fn() },
  MarkdownView: class {},
  Menu: class {},
  Modal: class {},
  Notice: class {
    constructor(message) {
      notices.messages.push(String(message));
    }
  },
  Plugin: class {},
  PluginSettingTab: class {},
  Setting: class {},
  SuggestModal: class {},
  TFile: class {},
  normalizePath: (value) => value,
  setIcon: () => {}
}));

vi.mock("../src/pi/rpc-client.mjs", () => {
  class FakePiRpcClient {
    constructor() {
      this.disposed = false;
      this.pending = undefined;
      this.listeners = new Set();
      this.child = { pid: state.instances.length + 1, exitCode: null, killed: false };
      state.instances.push(this);
    }

    get running() {
      return !!this.child && !this.disposed;
    }

    async start() {
      if (this.disposed) throw new Error("Pi RPC client is disposed.");
    }

    async request(type) {
      if (this.disposed || !this.child) throw new Error("Pi RPC stdin is not writable.");
      if (type === "prompt" || type === "compact") {
        // Mirrors the real client: a pending request settles only when the
        // process answers, and is rejected when the client is disposed.
        await new Promise((resolve, reject) => {
          this.pending = resolve;
          this.rejectPending = reject;
        });
      }
      return {};
    }

    notify() {}

    /** A wedged abort: the process never reacts, like a stuck Pi process. */
    async abort() {}

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    settle() {
      this.pending?.();
      this.pending = undefined;
      for (const listener of this.listeners) listener({ type: "agent_settled" });
    }

    emit(event) {
      for (const listener of this.listeners) listener(event);
    }

    terminate() {
      this.child = undefined;
    }

    dispose() {
      this.disposed = true;
      this.child = undefined;
      this.rejectPending?.(new Error("Pi RPC client disposed."));
      this.pending = undefined;
      this.rejectPending = undefined;
      for (const listener of this.listeners) listener({ type: "rpc_exit", error: "disposed" });
      this.listeners.clear();
    }
  }
  return { PiRpcClient: FakePiRpcClient };
});

const { PiAgentView } = await import("../src/ui/PiAgentView.mjs");

const CANCEL_TIMEOUT_MS = 50;
const tempDirs = [];

/** Polls with real timers; works with the mocked clock used inside the run. */
async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for the expected lifecycle state");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  state.instances.length = 0;
  notices.messages.length = 0;
});

/**
 * Wires the real chain for the race: ThreadRunnerRegistry -> PiRunner (real) ->
 * mocked RPC client class, plus a real AgentRuntime and a PiAgentView double.
 */
function createIntegrationHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-registry-race-"));
  tempDirs.push(tempDir);

  const store = new ThreadStore();
  const created = [];
  const registry = new ThreadRunnerRegistry(() => {
    const runner = new PiRunner(
      DEFAULT_SETTINGS,
      { formatPrompt: (prompt) => prompt },
      tempDir,
      tempDir
    );
    created.push(runner);
    return runner;
  });

  const plugin = {
    settings: { ...DEFAULT_SETTINGS, desktopNotifications: false },
    app: { vault: { getAbstractFileByPath: () => undefined } },
    getCurrentContextPath: () => undefined,
    consumeAnnotationsForPrompt: vi.fn(async () => []),
    restoreConsumedAnnotations: vi.fn(),
    enrichPromptDelivery: vi.fn(async (delivery) => ({ ...delivery, promptContext: undefined })),
    getSelectedModelInfo: () => undefined,
    beginAnnotationProcessing: vi.fn(),
    endAnnotationProcessingForThread: vi.fn(),
    completeAnnotationProcessingForPath: vi.fn(),
    rebuildServicesIfPending: vi.fn(),
    promptQueue: { replace() {}, getItems: () => [], isPaused: () => false },
    getVaultBasePath: () => undefined,
    createPiRunner: (threadId) => registry.create(threadId),
    cancelPiRun: (runner) => runner?.cancelCurrentRun()
  };
  plugin.threads = new ThreadService({
    store,
    runners: registry,
    createRunner: (threadId) => registry.create(threadId),
    getDefaultRunner: () => undefined,
    persist: () => {}
  });
  plugin.createAgentRuntime = () =>
    new AgentRuntime({
      runPrompt: (request, callbacks) =>
        request.runner.run(
          request.prompt,
          request.promptContext,
          undefined,
          [],
          callbacks,
          request.images
        ),
      createRunner: (threadId) => registry.create(threadId),
      cancelRunner: (runner) => plugin.cancelPiRun(runner),
      forceTerminate: (runner) => runner?.forceTerminate?.(),
      cancelTimeoutMs: CANCEL_TIMEOUT_MS,
      now: () => 1_000
    });

  const view = Object.create(PiAgentView.prototype);
  Object.assign(view, {
    plugin,
    runtime: plugin.createAgentRuntime(),
    closed: false,
    running: false,
    canceling: false,
    activityText: "",
    activityKind: "thinking",
    activityDetail: "",
    activityStickyUntil: 0,
    pendingActivity: undefined,
    pendingActivityTimer: undefined,
    activeToolCalls: new Map(),
    currentRunContextUsage: undefined,
    invalidatedContextThreadIds: new Set(),
    streamingAssistantContent: "",
    promptQueue: [],
    composerImages: [],
    composerAttachments: [],
    excludedContextPath: undefined,
    nativePiQueue: undefined,
    steeringPromptIds: new Set(),
    streamingThinkingContent: "",
    thinkingDisclosureExpanded: false,
    thinkingDisclosureUserSet: false,
    completedThinkingExpansion: new Map(),
    messageRenderComponents: [],
    messageRenderComponentByElement: new WeakMap(),
    desktopNotificationRunIds: new Set(),
    nextDesktopNotificationRunId: 1,
    stickToBottom: true,
    streamingRenderTimer: undefined,
    lastStreamingRenderAt: 0
  });
  view.delivery = new PromptDelivery({
    consumeAnnotations: () => plugin.consumeAnnotationsForPrompt(),
    restoreAnnotations: (annotations) => plugin.restoreConsumedAnnotations(annotations),
    buildDelivery: (delivery, context) => plugin.enrichPromptDelivery(delivery, context),
    isThreadRunning: (threadId) => view.runtime.hasRun(threadId),
    enqueueQueuedPrompt: () => {},
    requeueQueuedPrompt: () => {},
    ensureModelsLoaded: async () => {},
    getSelectedModelInfo: () => undefined,
    shouldIncludeActiveNote: () => true,
    notify: (message) => notices.messages.push(String(message))
  });
  view.inputEl = { value: "" };
  view.sendButtonEl = undefined;
  for (const method of [
    "renderMessages",
    "renderThreadTitle",
    "renderToolBadges",
    "renderPromptQueue",
    "renderThreadListIfVisible",
    "scheduleStreamingRender",
    "clearStreamingRenderTimer",
    "resizeInput"
  ]) {
    view[method] = vi.fn();
  }
  view.updateActivityDom = vi.fn(() => true);
  view.getVaultBasePath = () => undefined;

  return { view, plugin, registry, store, created };
}

describe("integration: wedged cancellation retires the runner", () => {
  it("force-terminates the wedged runner and gives the next run a fresh runner and client", async () => {
    const { view, plugin, registry, created } = createIntegrationHarness();
    const threadId = plugin.threads.currentThreadId;

    const pending = view.runPrompt("A", threadId);
    await waitFor(() => created.length === 1);
    const runnerA = created[0];
    const clientA = state.instances[0];
    await waitFor(() => clientA.listeners.size === 1);

    // Cancel while the mocked abort wedges: only the watchdog can release it.
    view.onCancelClick();
    expect(runnerA.cancelRequested).toBe(true);
    expect(runnerA.isRunning).toBe(true);

    await waitFor(() => runnerA.invalid === true);

    expect(clientA.disposed).toBe(true);
    expect(runnerA.isRunning).toBe(false);

    // The registry replaces the retired runner and the next run gets a new client.
    const runnerB = registry.create(threadId);
    expect(runnerB).not.toBe(runnerA);
    const runB = view.runtime.startPrompt({ threadId, prompt: "B" });
    await waitFor(() => state.instances.length === 2);
    const clientB = state.instances[1];
    expect(clientB).not.toBe(clientA);
    await waitFor(() => runnerB.isRunning === true);

    // Events from the retired run must not reach the new one.
    clientA.emit({ type: "agent_settled" });
    expect(runnerB.isRunning).toBe(true);
    await expect(
      runnerB.run("C", undefined, undefined, [], { isCanceled: () => false })
    ).rejects.toThrow("already has an active run");

    clientB.settle();
    await runB;
    await pending.catch(() => {});
    expect(runnerB.isRunning).toBe(false);
    expect(notices.messages).toContain("已取消运行。");
  });

  it("releases a wedged run when the view closes and never starts the queued prompt", async () => {
    const { view, plugin, registry, created } = createIntegrationHarness();
    const threadId = plugin.threads.currentThreadId;
    view.promptQueue = [
      {
        id: "q1",
        prompt: "queued one",
        threadId,
        createdAt: 1,
        images: [],
        attachments: [],
        annotations: [],
        state: "pending"
      }
    ];
    plugin.promptQueue.getItems = () => view.promptQueue;

    const pending = view.runPrompt("A", threadId);
    await waitFor(() => created.length === 1);
    await waitFor(() => state.instances[0].listeners.size === 1);

    view.onClose();
    expect(view.closed).toBe(true);
    expect(view.runtime.disposed).toBe(true);

    // Disposing the runtime must not disarm the watchdog of the cancelling run.
    await waitFor(() => created[0].invalid === true);

    expect(created).toHaveLength(1);
    expect(view.promptQueue.map((item) => item.id)).toEqual(["q1"]);

    // The thread is usable again through a fresh runner.
    const replacement = registry.create(threadId);
    expect(replacement).not.toBe(created[0]);
    expect(replacement.invalid).toBe(false);

    await pending.catch(() => {});
  });
});
