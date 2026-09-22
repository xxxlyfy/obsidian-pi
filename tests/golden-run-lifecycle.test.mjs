import { describe, expect, it, vi } from "vitest";
import { STRINGS } from "../src/shared/strings.mjs";

const notices = vi.hoisted(() => ({ messages: [] }));

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

globalThis.window ??= {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
  addEventListener() {},
  removeEventListener() {}
};

const { PiAgentView } = await import("../src/ui/PiAgentView.mjs");
const { PiRunCanceledError } = await import("../src/pi/run-canceled.mjs");
const { ThreadStore } = await import("../src/threads/thread-store.mjs");
const { DEFAULT_SETTINGS } = await import("../src/plugin/settings.mjs");

function createScriptedRunner(script) {
  const calls = [];
  return {
    calls,
    cancelCurrentRun: vi.fn(),
    run: vi.fn(async (prompt, context, sessionId, history, callbacks, images) => {
      calls.push({ prompt, context, sessionId, history, images });
      return script({ prompt, context, sessionId, history, callbacks, images });
    })
  };
}

function createPluginDouble(runner) {
  const store = new ThreadStore();
  return {
    settings: { ...DEFAULT_SETTINGS, desktopNotifications: false },
    threadHistory: store,
    savedMessages: [],
    replacedQueues: [],
    getCurrentThread: () => store.getCurrentThread(),
    getCurrentContextFile: () => undefined,
    addMessageToThread(threadId, message) {
      const added = store.addMessageToThread(threadId, message);
      if (added) this.savedMessages.push(message);
      return added;
    },
    consumeAnnotationsForPrompt: vi.fn(async () => []),
    restoreConsumedAnnotations: vi.fn(),
    enrichPromptDelivery: vi.fn(async (delivery) => ({ ...delivery, promptContext: undefined })),
    ensureModelCatalogLoaded: vi.fn(async () => {}),
    getSelectedModelInfo: () => ({ contextWindow: 1_000 }),
    createPiRunner: () => runner,
    runPiPrompt: vi.fn((prompt, callbacks, threadId, activeRunner, images, promptContext) =>
      activeRunner.run(prompt, promptContext, undefined, [], callbacks, images)
    ),
    beginAnnotationProcessing: vi.fn(),
    endAnnotationProcessingForThread: vi.fn(),
    completeAnnotationProcessingForPath: vi.fn(),
    rebuildServicesIfPending: vi.fn(),
    replaceLocalPromptQueue(queue) {
      this.replacedQueues.push(queue);
    },
    getLocalPromptQueue: () => [],
    isLocalPromptQueuePaused: () => false,
    getVaultBasePath: () => undefined,
    cancelPiRun: vi.fn((activeRunner) => activeRunner?.cancelCurrentRun()),
    app: { vault: { getAbstractFileByPath: () => undefined } }
  };
}

function createViewDouble(plugin) {
  const view = Object.create(PiAgentView.prototype);
  Object.assign(view, {
    plugin,
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
    pendingAnnotationSnapshots: new Set(),
    nativePiQueue: undefined,
    steeringPromptIds: new Set(),
    streamingThinkingContent: "",
    thinkingDisclosureExpanded: false,
    thinkingDisclosureUserSet: false,
    completedThinkingExpansion: new Map(),
    activeRuns: new Map(),
    desktopNotificationRunIds: new Set(),
    nextDesktopNotificationRunId: 1,
    stickToBottom: true,
    streamingRenderTimer: undefined,
    lastStreamingRenderAt: 0
  });
  view.inputEl = { value: "" };
  view.sendButtonEl = undefined;
  view.renderMessages = vi.fn();
  view.renderThreadTitle = vi.fn();
  view.renderToolBadges = vi.fn();
  view.renderPromptQueue = vi.fn();
  view.renderThreadListIfVisible = vi.fn();
  view.scheduleStreamingRender = vi.fn();
  view.clearStreamingRenderTimer = vi.fn();
  view.resizeInput = vi.fn();
  view.updateActivityDom = vi.fn(() => true);
  view.getVaultBasePath = () => undefined;
  return view;
}

function successfulResult(finalResponse, threadId) {
  return {
    finalResponse,
    sessionId: "session-1",
    threadId,
    events: [],
    contextUsage: undefined,
    contextCompacted: false,
    tokenUsage: undefined,
    runtimeState: undefined
  };
}

describe("golden path 1: prompt -> streaming -> tool -> completion", () => {
  it("streams text, tracks the tool, and stores user then assistant messages", async () => {
    notices.messages.length = 0;
    const observations = [];
    let view;
    let threadId;
    const runner = createScriptedRunner(async ({ callbacks }) => {
      callbacks.onEvent({
        type: "context_ready",
        raw: { searchResults: 0, linkedNeighborhood: 0 }
      });
      callbacks.onEvent({ type: "agent_start" });
      callbacks.onTextDelta("hello");
      observations.push({
        stage: "after first delta",
        streaming: view.streamingAssistantContent,
        running: view.running
      });
      callbacks.onEvent({
        type: "tool_start",
        toolCallId: "call-1",
        toolName: "read",
        toolArgs: { path: "A.md" }
      });
      observations.push({
        stage: "during tool",
        runTools: view.activeRuns.get(threadId).activeToolCalls.size,
        viewTools: view.activeToolCalls.size,
        kind: view.activityKind
      });
      callbacks.onEvent({ type: "tool_end", toolCallId: "call-1", toolName: "read" });
      observations.push({
        stage: "after tool",
        runTools: view.activeRuns.get(threadId).activeToolCalls.size
      });
      callbacks.onTextDelta(" world");
      callbacks.onPromptAccepted();
      callbacks.onEvent({ type: "agent_end" });
      return successfulResult("hello world", threadId);
    });
    const plugin = createPluginDouble(runner);
    threadId = plugin.getCurrentThread().id;
    view = createViewDouble(plugin);

    await view.runPrompt("hi", threadId);

    expect(plugin.savedMessages.map((message) => [message.role, message.content])).toEqual([
      ["user", "hi"],
      ["assistant", "hello world"]
    ]);
    expect(plugin.savedMessages[1].runMetadata).toMatchObject({
      toolMode: "read-only",
      toolModeLabel: "审阅"
    });
    expect(observations).toEqual([
      { stage: "after first delta", streaming: "hello", running: true },
      { stage: "during tool", runTools: 1, viewTools: 1, kind: "read" },
      { stage: "after tool", runTools: 0 }
    ]);
    expect(view.activeRuns.size).toBe(0);
    expect(view.running).toBe(false);
    expect(view.canceling).toBe(false);
    expect(view.streamingAssistantContent).toBe("");
    expect(view.streamingThinkingContent).toBe("");
    expect(view.activityText).toBe("");
    expect(view.currentRunContextUsage).toBeUndefined();
    expect(view.nativePiQueue).toBeUndefined();
    expect(plugin.endAnnotationProcessingForThread).toHaveBeenCalledWith(threadId);
    expect(plugin.rebuildServicesIfPending).toHaveBeenCalledOnce();
    expect(notices.messages).toEqual([]);
  });

  it("keeps thinking deltas on the run and stores them on the assistant message", async () => {
    let threadId;
    const runner = createScriptedRunner(async ({ callbacks }) => {
      callbacks.onEvent({ type: "thinking_delta", thinkingDelta: "step 1 " });
      callbacks.onEvent({ type: "thinking_delta", thinkingDelta: "step 2" });
      callbacks.onTextDelta("answer");
      return successfulResult("answer", threadId);
    });
    const plugin = createPluginDouble(runner);
    threadId = plugin.getCurrentThread().id;
    const view = createViewDouble(plugin);

    await view.runPrompt("think", threadId);

    expect(plugin.savedMessages[1]).toMatchObject({
      role: "assistant",
      content: "answer",
      thinking: "step 1 step 2"
    });
    expect(view.thinkingDisclosureExpanded).toBe(false);
    expect(view.thinkingDisclosureUserSet).toBe(false);
  });
});

describe("golden path 2: prompt -> cancel", () => {
  it("stops the run, reports cancellation, and stores only the user message", async () => {
    notices.messages.length = 0;
    let cancelState;
    let lateCallbacks;
    const runner = createScriptedRunner(async ({ callbacks }) => {
      lateCallbacks = callbacks;
      callbacks.onEvent({ type: "agent_start" });
      callbacks.onTextDelta("partial");
      view.cancelCurrentRun();
      cancelState = {
        canceling: view.canceling,
        activity: view.activityText,
        runnerCancelRequests: runner.cancelCurrentRun.mock.calls.length
      };
      throw new PiRunCanceledError();
    });
    const plugin = createPluginDouble(runner);
    const threadId = plugin.getCurrentThread().id;
    const view = createViewDouble(plugin);

    await view.runPrompt("stop me", threadId);

    expect(cancelState).toEqual({
      canceling: true,
      activity: STRINGS.view.canceling,
      runnerCancelRequests: 1
    });
    expect(plugin.savedMessages.map((message) => message.role)).toEqual(["user"]);
    expect(notices.messages).toEqual([STRINGS.view.runCanceled]);
    expect(view.activeRuns.size).toBe(0);
    expect(view.running).toBe(false);
    expect(view.canceling).toBe(false);
    expect(view.streamingAssistantContent).toBe("");

    // Characterization of the pre-refactor leak: the view still accepts events
    // from a settled run because callbacks are not generation-guarded yet.
    // Phase 1 replaces this with AgentRuntime stale-event dropping.
    lateCallbacks.onTextDelta(" late");
    lateCallbacks.onEvent({
      type: "tool_start",
      toolCallId: "late-1",
      toolName: "read",
      toolArgs: { path: "A.md" }
    });

    expect(view.streamingAssistantContent).toBe(" late");
    expect(view.activityText.length).toBeGreaterThan(0);
    expect(plugin.savedMessages.map((message) => message.role)).toEqual(["user"]);
  });
});

describe("golden path 3: prompt -> failure -> retry", () => {
  it("stores the failure message, then lets a retry succeed on the same thread", async () => {
    notices.messages.length = 0;
    const timeoutError = new Error("Pi RPC request timed out: prompt");
    let threadId;
    const failingRunner = createScriptedRunner(async () => {
      throw timeoutError;
    });
    const plugin = createPluginDouble(failingRunner);
    threadId = plugin.getCurrentThread().id;
    const view = createViewDouble(plugin);

    await view.runPrompt("slow", threadId);

    expect(plugin.savedMessages.map((message) => [message.role, message.content])).toEqual([
      ["user", "slow"],
      ["assistant", `${STRINGS.view.runFailed}：${timeoutError.message}`]
    ]);
    expect(notices.messages).toEqual([timeoutError.message]);
    expect(view.activeRuns.size).toBe(0);
    expect(view.running).toBe(false);

    notices.messages.length = 0;
    const healthyRunner = createScriptedRunner(async ({ callbacks }) => {
      callbacks.onTextDelta("recovered");
      return successfulResult("recovered", threadId);
    });
    plugin.createPiRunner = () => healthyRunner;

    await view.runPrompt("retry", threadId);

    expect(plugin.savedMessages.map((message) => [message.role, message.content])).toEqual([
      ["user", "slow"],
      ["assistant", `${STRINGS.view.runFailed}：${timeoutError.message}`],
      ["user", "retry"],
      ["assistant", "recovered"]
    ]);
    expect(view.running).toBe(false);
    expect(notices.messages).toEqual([]);
  });
});
