/**
 * Which thread a settling run is allowed to repaint.
 *
 * The view keeps exactly one set of "what the user is looking at" fields - the streaming
 * answer and reasoning buffers, the streaming elements, the activity line, the tool list,
 * the native Pi answer and the queue - while `state.activeRuns` tracks a run per thread.
 * `settleRunSuccess()`/`settleRunCleanup()` used to clear that shared surface for any
 * run, so a background thread finishing erased the stream of the thread on screen: its
 * next delta rendered only the text that arrived after the clear, and the answer visibly
 * restarted. Only the visible thread's own settle may clear it.
 */
import { describe, expect, it, vi } from "vitest";

// `run-lifecycle.mjs` imports `Notice` from Obsidian; the module under test only needs
// the class to exist.
vi.mock("obsidian", () => ({
  Notice: class Notice {},
  setIcon() {}
}));

const { settleRunCleanup, settleRunSuccess } = await import("../src/ui/view/run-lifecycle.mjs");

const CURRENT = "thread-current";
const BACKGROUND = "thread-background";

/** A view with the shared surface filled in, as a live run leaves it. */
function createView(threadId) {
  const view = {
    plugin: {
      settings: {},
      addMessageToThread: vi.fn(),
      endAnnotationProcessingForThread: vi.fn(),
      rebuildServicesIfPending: vi.fn(),
      getCurrentThread: () => ({ id: CURRENT })
    },
    state: {
      activeRuns: new Map([[threadId, { threadId }]]),
      completedThinkingExpansion: new Map(),
      invalidatedContextThreadIds: new Set(),
      streamingAssistantContent: "Hello from the visible run, part one. ",
      streamingAnswerDirty: true,
      streamingThinkingContent: "reasoning so far",
      streamingThinkingDirty: true,
      thinkingDisclosureExpanded: true,
      thinkingDisclosureUserSet: true,
      activityStickyUntil: Date.now() + 5_000,
      pendingActivity: { kind: "tool", detail: "Reading Note.md" },
      pendingActivityTimer: 42,
      activityCoalesceTimer: 43,
      activeToolCalls: new Map([["tool-1", { name: "read" }]]),
      activityText: "Reading Note.md",
      activityDetail: "Note.md",
      currentRunContextUsage: { total: 100 },
      nativePiQueue: "queued answer",
      promptQueue: []
    },
    streamingItemEl: { tag: "div" },
    streamingTextEl: { tag: "span" },
    runningThreadId: threadId,
    cancelStreamingFlush: vi.fn(),
    clearPendingActivityTimer: vi.fn(),
    clearCoalescedActivity: vi.fn(),
    syncCurrentRunFlags: vi.fn(),
    renderPromptQueue: vi.fn(),
    setRunningState: vi.fn(),
    renderMessages: vi.fn(),
    renderToolBadges: vi.fn(),
    renderThreadTitle: vi.fn(),
    renderThreadListIfVisible: vi.fn(),
    notifyRunCompleted: vi.fn(),
    isThreadRunning: () => false,
    getCurrentThreadRun: () => undefined,
    isCurrentThread: (id) => id === CURRENT,
    runNextQueuedPrompt: vi.fn()
  };
  return view;
}

const run = { threadId: BACKGROUND, thinking: "", thinkingUserSet: false, toolErrors: [] };
const result = {
  finalResponse: "done",
  contextUsage: undefined,
  contextCompacted: false,
  tokenUsage: undefined,
  runtimeState: undefined
};

describe("settling a run that is not the visible thread", () => {
  it("keeps the visible thread's stream while still recording the message", () => {
    const view = createView(BACKGROUND);

    settleRunSuccess(view, run, BACKGROUND, result);

    // The background run's answer is recorded...
    expect(view.plugin.addMessageToThread).toHaveBeenCalledTimes(1);
    // ...and the stream the user is reading is untouched.
    expect(view.state.streamingAssistantContent).toBe("Hello from the visible run, part one. ");
    expect(view.state.streamingThinkingContent).toBe("reasoning so far");
    expect(view.streamingItemEl).toBeDefined();
    expect(view.streamingTextEl).toBeDefined();
    expect(view.cancelStreamingFlush).not.toHaveBeenCalled();
    // The current thread is not repainted from a background run's result.
    expect(view.renderMessages).not.toHaveBeenCalled();
  });

  it("keeps the visible thread's activity and tool state", () => {
    const view = createView(BACKGROUND);

    settleRunCleanup(view, BACKGROUND, false);

    expect(view.state.activityText).toBe("Reading Note.md");
    expect(view.state.activeToolCalls.size).toBe(1);
    expect(view.state.pendingActivity).toBeDefined();
    expect(view.state.nativePiQueue).toBe("queued answer");
    expect(view.state.streamingAssistantContent).toBe("Hello from the visible run, part one. ");
    expect(view.cancelStreamingFlush).not.toHaveBeenCalled();
    expect(view.clearCoalescedActivity).not.toHaveBeenCalled();
    // The ended run is still removed from the per-thread registry.
    expect(view.state.activeRuns.has(BACKGROUND)).toBe(false);
    expect(view.plugin.endAnnotationProcessingForThread).toHaveBeenCalledWith(BACKGROUND);
  });

  it("clears the surface when the settling run is the visible one", () => {
    const view = createView(CURRENT);

    settleRunCleanup(view, CURRENT, false);

    expect(view.state.streamingAssistantContent).toBe("");
    expect(view.state.streamingThinkingContent).toBe("");
    expect(view.state.activityText).toBe("");
    expect(view.state.activeToolCalls.size).toBe(0);
    expect(view.state.nativePiQueue).toBeUndefined();
    expect(view.streamingItemEl).toBeUndefined();
    expect(view.cancelStreamingFlush).toHaveBeenCalled();
    expect(view.clearCoalescedActivity).toHaveBeenCalled();
    expect(view.runningThreadId).toBeUndefined();
  });

  it("clears the surface when the visible thread's own run succeeds", () => {
    const view = createView(CURRENT);

    settleRunSuccess(view, { ...run, threadId: CURRENT }, CURRENT, result);

    expect(view.state.streamingAssistantContent).toBe("");
    expect(view.state.streamingThinkingContent).toBe("");
    expect(view.streamingTextEl).toBeUndefined();
    expect(view.cancelStreamingFlush).toHaveBeenCalled();
    expect(view.renderMessages).toHaveBeenCalled();
  });
});
