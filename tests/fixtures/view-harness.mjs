import { vi } from "vitest";

/**
 * Shared harness for view/plugin doubles.
 *
 * The src modules are injected by the calling test file so that `vi.mock("obsidian")`
 * is registered before any module that imports Obsidian is evaluated.
 *
 * @param {object} deps
 * @param {any} deps.PiAgentView
 * @param {any} deps.AgentRuntime
 * @param {any} deps.PromptDelivery
 * @param {any} deps.ThreadService
 * @param {any} deps.ThreadStore
 * @param {any} deps.DEFAULT_SETTINGS
 * @param {{ messages: string[] }} deps.notices
 */
export function createViewHarness({
  PiAgentView,
  AgentRuntime,
  PromptDelivery,
  ThreadService,
  ThreadStore,
  DEFAULT_SETTINGS,
  notices
}) {
  function createScriptedRunner(script) {
    const calls = [];
    return {
      calls,
      cancelCurrentRun: vi.fn(),
      steer: vi.fn(async () => {}),
      run: vi.fn(async (prompt, context, sessionId, history, callbacks, images) => {
        calls.push({ prompt, context, sessionId, history, images });
        return script({ prompt, context, sessionId, history, callbacks, images });
      })
    };
  }

  function createPluginDouble(runner) {
    const store = new ThreadStore();
    const plugin = {
      settings: { ...DEFAULT_SETTINGS, desktopNotifications: false },
      threadHistory: store,
      getCurrentContextPath: () => undefined,
      consumeAnnotationsForPrompt: vi.fn(async () => []),
      restoreConsumedAnnotations: vi.fn(),
      enrichPromptDelivery: vi.fn(async (delivery) => ({ ...delivery, promptContext: undefined })),
      getSelectedModelInfo: () => ({ contextWindow: 1_000 }),
      createPiRunner: () => runner,
      runPiPrompt: vi.fn((prompt, callbacks, threadId, activeRunner, images, promptContext) =>
        activeRunner.run(prompt, promptContext, undefined, [], callbacks, images)
      ),
      beginAnnotationProcessing: vi.fn(),
      endAnnotationProcessingForThread: vi.fn(),
      completeAnnotationProcessingForPath: vi.fn(),
      rebuildServicesIfPending: vi.fn(),
      promptQueue: {
        replaced: [],
        replace(queue) {
          this.replaced.push(queue);
        },
        getItems: () => [],
        isPaused: () => false
      },
      getVaultBasePath: () => undefined,
      cancelPiRun: vi.fn((activeRunner) => activeRunner?.cancelCurrentRun()),
      app: { vault: { getAbstractFileByPath: () => undefined } }
    };
    plugin.threads = new ThreadService({
      store,
      runners: {
        get: () => undefined,
        dispose: () => {},
        disposeAll: () => {},
        withRunner: async (threadId, action) => action(plugin.createPiRunner(threadId))
      },
      createRunner: (threadId) => plugin.createPiRunner(threadId),
      getDefaultRunner: () => undefined,
      persist: () => {}
    });
    plugin.createAgentRuntime = () =>
      new AgentRuntime({
        runPrompt: (request, callbacks) =>
          plugin.runPiPrompt(
            request.prompt,
            callbacks,
            request.threadId,
            request.runner,
            request.images,
            request.promptContext
          ),
        createRunner: (threadId) => plugin.createPiRunner(threadId),
        cancelRunner: (activeRunner) => plugin.cancelPiRun(activeRunner),
        now: () => 1_000
      });
    return plugin;
  }

  function createViewDouble(plugin) {
    const view = Object.create(PiAgentView.prototype);
    Object.assign(view, {
      plugin,
      runtime: plugin.createAgentRuntime(),
      delivery: new PromptDelivery({
        consumeAnnotations: (sourcePath) => plugin.consumeAnnotationsForPrompt(sourcePath),
        restoreAnnotations: (annotations) => plugin.restoreConsumedAnnotations(annotations),
        buildDelivery: (delivery, context) => plugin.enrichPromptDelivery(delivery, context),
        isThreadRunning: (threadId) => view.runtime.hasRun(threadId),
        enqueueQueuedPrompt: () => {},
        requeueQueuedPrompt: () => {},
        ensureModelsLoaded: async () => {},
        getSelectedModelInfo: () => undefined,
        shouldIncludeActiveNote: () => true,
        notify: (message) => notices.messages.push(String(message))
      }),
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

  return { createScriptedRunner, createPluginDouble, createViewDouble };
}
