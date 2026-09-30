/**
 * The run's UI callbacks and the paths that finish a run.
 *
 * `PiAgentView.runPrompt` used to hold all of this inline. The callbacks and the
 * success/failure/settlement paths are separated from the orchestration here so
 * `runPrompt` reads as a sequence of stages, but they keep the property that
 * matters: they run in the same order, against the same run record, with the
 * stale-callback guard checked at the same points (`if (activeRuns.get(t) !== n)`
 * before any DOM write). The start-of-callback heap/duration sampling is
 * unchanged as well, so the profiler counters still count the same work.
 */
import { Notice } from "obsidian";

import { performanceProfiler } from "../../shared/performance-profiler.mjs";
import { now } from "../../shared/runtime.mjs";
import { formatToolError, getSkillCommandName, getThinkingDelta } from "../activity.mjs";
import { getCurrentRunMetadata } from "./run-metadata.mjs";

/**
 * A one-line description of what was attached, for the user message of a prompt
 * that had no text of its own.
 *
 * @param {any[]} images Attached images.
 * @param {any[]} attachments Attached text files.
 * @returns {string}
 */
function conciseAttachmentSummary(images, attachments) {
  const count = images.length + attachments.length;
  return `[${count} attached file${count === 1 ? "" : "s"}]`;
}

/**
 * Build the callbacks Pi runs with. Each one is a closure over the run record,
 * exactly as before; they are built once per run and never reused.
 *
 * @param {any} view Chat view.
 * @param {any} run Run record for this prompt.
 * @param {string} threadId Thread the run belongs to.
 * @param {() => void} onPromptAccepted Callback that records a delivery.
 * @returns {{ onEvent: (event: any) => void, onTextDelta: (text: string) => void,
 *   onPromptAccepted: () => void }}
 */
export function createRunEventHandlers(view, run, threadId, onPromptAccepted) {
  return {
    onEvent: (event) => {
      const profiling = performanceProfiler.enabled;
      const startedAt = profiling ? now() : 0;
      try {
        const thinkingDelta = getThinkingDelta(event);
        if (thinkingDelta) {
          performanceProfiler.incrementCounter("streamDeltaCount");
          run.thinking += thinkingDelta;
          if (!run.thinkingUserSet) run.thinkingExpanded = true;
        }
        const toolError = formatToolError(event);
        if (toolError && run.toolErrors[run.toolErrors.length - 1] !== toolError)
          run.toolErrors.push(toolError);
        // Runs even when the run is stale: a mutation already applied to the
        // vault still needs its annotation processing completed.
        view.handleSuccessfulToolMutation(event, threadId);
        // Stale-view and stale-run guard, checked before any view write. Kept
        // inline rather than behind a helper because this early return is the
        // thing the stale-callback assertions are about.
        if (!view.isCurrentThread(threadId)) return;
        if (view.state.activeRuns.get(threadId) !== run) {
          view.noteStaleUiCallback();
          return;
        }
        view.state.streamingThinkingContent = run.thinking;
        view.state.thinkingDisclosureExpanded = run.thinkingExpanded;
        view.state.thinkingDisclosureUserSet = run.thinkingUserSet;
        view.handleRunEvent(event);
        if (thinkingDelta) {
          view.liveThinkingSetExpanded?.(run.thinkingExpanded);
          view.appendStreamingThinkingDelta(thinkingDelta);
        }
      } finally {
        if (profiling) performanceProfiler.recordDuration("uiCallback", now() - startedAt);
      }
    },
    onTextDelta: (text) => {
      const profiling = performanceProfiler.enabled;
      const startedAt = profiling ? now() : 0;
      try {
        performanceProfiler.incrementCounter("streamDeltaCount");
        if (!run.thinkingUserSet) run.thinkingExpanded = false;
        if (!view.isCurrentThread(threadId)) return;
        if (view.state.activeRuns.get(threadId) !== run) {
          view.noteStaleUiCallback();
          return;
        }
        view.state.thinkingDisclosureExpanded = run.thinkingExpanded;
        view.liveThinkingSetExpanded?.(run.thinkingExpanded);
        view.appendStreamingDelta(text);
      } finally {
        if (profiling) performanceProfiler.recordDuration("uiCallback", now() - startedAt);
      }
    },
    onPromptAccepted: () => {
      onPromptAccepted();
    }
  };
}

/**
 * Record the finished run: write the assistant message, refresh the visible
 * surface, and notify. Mirrors `settleRunFailure` for the success case.
 *
 * @param {any} view Chat view.
 * @param {any} run Run record.
 * @param {string} threadId Thread the run belongs to.
 * @param {any} result What the plugin returned from the run.
 */
export function settleRunSuccess(view, run, threadId, result) {
  const createdAt = Date.now();
  view.state.completedThinkingExpansion.set(
    `${threadId}:${createdAt}`,
    run.thinkingUserSet ? run.thinkingExpanded : false
  );
  const runMetadata = getCurrentRunMetadata(view.plugin.settings, result.runtimeState);
  // Drop the streaming frame and its buffers before the final message lands, so
  // a late frame cannot repaint over the finished answer.
  view.cancelStreamingFlush();
  view.state.streamingAssistantContent = "";
  view.state.streamingAnswerDirty = false;
  view.state.streamingThinkingContent = "";
  view.state.streamingThinkingDirty = false;
  view.streamingItemEl = void 0;
  view.streamingTextEl = void 0;
  view.plugin.addMessageToThread(threadId, {
    role: "assistant",
    content: result.finalResponse,
    createdAt,
    contextUsage: result.contextUsage,
    tokenUsage: result.tokenUsage,
    runMetadata,
    thinking: run.thinking || undefined,
    toolErrors: run.toolErrors.length > 0 ? run.toolErrors : undefined
  });
  if (result.contextUsage && !result.contextCompacted)
    view.state.invalidatedContextThreadIds.delete(threadId);
  if (result.contextCompacted) view.state.invalidatedContextThreadIds.add(threadId);
  if (view.isCurrentThread(threadId)) {
    view.renderThreadTitle();
    view.renderMessages();
    view.renderToolBadges();
  }
  view.notifyRunCompleted(run.notificationRunId, threadId);
}

/**
 * Record a failed run. Returns "canceled" when the failure was a user cancel,
 * in which case the caller reports nothing and lets the queue drain as usual.
 *
 * @param {any} view Chat view.
 * @param {any} run Run record.
 * @param {string} threadId Thread the run belongs to.
 * @param {unknown} error Error the run threw.
 * @returns {"canceled" | "failed"} How the run ended.
 */
export function settleRunFailure(view, run, threadId, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Pi run canceled.") {
    new Notice("Agent run canceled.");
    return "canceled";
  }
  const createdAt = Date.now();
  view.state.completedThinkingExpansion.set(
    `${threadId}:${createdAt}`,
    run.thinkingUserSet ? run.thinkingExpanded : false
  );
  view.plugin.addMessageToThread(threadId, {
    role: "assistant",
    content: `Agent run failed: ${message}`,
    createdAt,
    thinking: run.thinking || undefined,
    toolErrors: run.toolErrors.length > 0 ? run.toolErrors : undefined
  });
  if (view.isCurrentThread(threadId)) {
    view.renderThreadTitle();
    view.renderMessages();
    view.renderToolBadges();
  }
  new Notice(message);
  view.notifyRunCompleted(
    run.notificationRunId,
    threadId,
    "Agent run failed. Click to open the chat."
  );
  return "failed";
}

/**
 * Register a new run and put the view into its running state, then hand back the
 * callbacks the run needs to record itself. Registration happens before
 * `beginAnnotationProcessing` on purpose: an observer that fires from it must
 * already be able to see the run in `activeRuns`.
 *
 * @param {any} view Chat view.
 * @param {any} request The prompt, resolved attachments, and queue identity.
 * @returns {{ run: any, addUserMessage: () => void, acknowledgeQueuedDelivery: () => void }}
 */
export function beginTrackedRun(view, request) {
  const { prompt, threadId, images, attachments, queuedId } = request;
  const run = {
    canceling: false,
    runner: view.plugin.createPiRunner(threadId),
    accepted: false,
    notificationRunId: `${threadId}:${view.state.nextDesktopNotificationRunId++}`,
    skillName: getSkillCommandName(prompt),
    thinking: "",
    thinkingExpanded: false,
    thinkingUserSet: false,
    toolErrors: [],
    // Identifies this run for stale-callback checks.
    runGeneration: ++view.state.runGenerationCounter
  };
  const addUserMessage = () => {
    if (run.userMessageAdded) return;
    run.userMessageAdded = true;
    view.plugin.addMessageToThread(threadId, {
      role: "user",
      content: prompt || conciseAttachmentSummary(images, attachments),
      createdAt: Date.now()
    });
    if (view.isCurrentThread(threadId)) {
      view.renderThreadTitle();
      view.renderMessages();
    }
  };
  const acknowledgeQueuedDelivery = () => {
    addUserMessage();
    if (run.accepted) return;
    run.accepted = true;
    if (!queuedId) return;
    view.state.promptQueue = view.state.promptQueue.filter((item) => item.id !== queuedId);
    view.plugin.replaceLocalPromptQueue(view.state.promptQueue);
    view.renderPromptQueue();
  };
  view.state.activeRuns.set(threadId, run);
  view.syncCurrentRunFlags();
  view.runningThreadId = threadId;
  view.state.running = view.isCurrentThread(threadId);
  view.state.canceling = false;
  view.state.activityText = "Preparing context";
  view.state.activityKind = "context";
  view.state.activityDetail =
    "Collecting current note, links, backlinks, and explicit attachments.";
  view.state.activityStickyUntil = 0;
  view.state.pendingActivity = void 0;
  view.clearPendingActivityTimer();
  view.state.activeToolCalls.clear();
  view.state.currentRunContextUsage = void 0;
  view.state.streamingAssistantContent = "";
  view.state.streamingThinkingContent = "";
  view.state.thinkingDisclosureExpanded = false;
  view.state.thinkingDisclosureUserSet = false;
  view.state.stickToBottom = true;
  // Heap samples for the run lifecycle (profiler-only).
  performanceProfiler.markHeap("before");
  view.plugin.beginAnnotationProcessing(threadId, request.annotations);
  view.setRunningState(view.state.running);
  if (!queuedId) addUserMessage();
  view.renderThreadListIfVisible();
  return { run, addUserMessage, acknowledgeQueuedDelivery };
}

/**
 * Release everything the run owned. Runs on every exit path, including the two
 * early returns above, so a cancelled or failed run cannot leave a timer, a
 * frame, or a guard behind.
 *
 * @param {any} view Chat view.
 * @param {string} threadId Thread the run belonged to.
 * @param {boolean} skipQueueDrain Whether to leave the queue alone (a requeued
 * prompt is already going back to pending).
 */
export function settleRunCleanup(view, threadId, skipQueueDrain) {
  view.state.activeRuns.delete(threadId);
  view.syncCurrentRunFlags();
  view.state.running = view.isThreadRunning(view.plugin.getCurrentThread().id);
  view.state.canceling = view.getCurrentThreadRun()?.canceling === true;
  performanceProfiler.markHeap("after");
  view.clearCoalescedActivity();
  view.cancelStreamingFlush();
  view.state.streamingAssistantContent = "";
  view.state.streamingAnswerDirty = false;
  view.state.streamingThinkingContent = "";
  view.state.streamingThinkingDirty = false;
  view.state.thinkingDisclosureExpanded = false;
  view.state.thinkingDisclosureUserSet = false;
  view.state.activityStickyUntil = 0;
  view.state.pendingActivity = void 0;
  view.clearPendingActivityTimer();
  view.state.activeToolCalls.clear();
  view.state.activityText = "";
  view.state.activityDetail = "";
  view.state.currentRunContextUsage = void 0;
  if (view.isCurrentThread(threadId)) view.state.nativePiQueue = void 0;
  view.renderPromptQueue();
  view.runningThreadId = void 0;
  view.setRunningState(view.state.running);
  if (view.isCurrentThread(threadId)) {
    view.renderMessages();
    view.renderToolBadges();
  }
  view.renderThreadListIfVisible();
  view.plugin.endAnnotationProcessingForThread(threadId);
  view.plugin.rebuildServicesIfPending();
  if (!skipQueueDrain) view.runNextQueuedPrompt();
}
