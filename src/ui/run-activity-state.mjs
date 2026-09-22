import { extractEventTokenUsage } from "../pi/events.mjs";
import { STRINGS } from "../shared/strings.mjs";
import {
  createContextUsage,
  formatContextUsageTitle,
  formatTokenCount
} from "../pi/token-usage.mjs";
import {
  formatRetryDetail,
  formatToolStatus,
  getToolEventKey,
  isStickyActivityKind,
  shouldBypassActivityStickiness
} from "./activity.mjs";

const ACTIVITY_STICKY_MS = 1200;

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function setActivity(text, kind, detail = "") {
  let now = Date.now(),
    sticky = isStickyActivityKind(kind),
    deferred = !sticky && !shouldBypassActivityStickiness(kind) && now < this.activityStickyUntil;
  if (deferred) {
    this.queuePendingActivity(text, kind, detail);
    return;
  }
  this.applyActivity(text, kind, detail, sticky ? now + ACTIVITY_STICKY_MS : 0);
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function applyActivity(text, kind, detail = "", stickyUntil = 0) {
  let isUnchanged =
    this.activityText === text && this.activityKind === kind && this.activityDetail === detail;
  this.activityText = text;
  this.activityKind = kind;
  this.activityDetail = detail;
  this.activityStickyUntil = stickyUntil;
  if (stickyUntil) {
    this.pendingActivity = undefined;
    this.clearPendingActivityTimer();
  }
  if (!isUnchanged && !this.updateActivityDom()) this.renderMessages();
}

/**
 * @this {import("./PiAgentView.mjs").PiAgentView}
 * @param {string | undefined} threadId
 */
export function syncRunActivity(threadId) {
  const run = threadId ? this.runtime.getRun(threadId) : undefined;
  if (run)
    run.activity = {
      text: this.activityText,
      kind: this.activityKind,
      detail: this.activityDetail,
      stickyUntil: this.activityStickyUntil
    };
}

/**
 * @this {import("./PiAgentView.mjs").PiAgentView}
 * @param {string | undefined} threadId
 */
export function syncRunContextUsage(threadId) {
  const run = threadId ? this.runtime.getRun(threadId) : undefined;
  if (run) run.contextUsage = this.currentRunContextUsage;
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function queuePendingActivity(text, kind, detail = "") {
  this.pendingActivity = { text: text, kind: kind, detail: detail };
  this.schedulePendingActivity();
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function schedulePendingActivity() {
  if (this.pendingActivityTimer) return;
  let delay = Math.max(0, this.activityStickyUntil - Date.now());
  this.pendingActivityTimer = window.setTimeout(() => {
    this.pendingActivityTimer = undefined;
    this.flushPendingActivity();
  }, delay);
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function clearPendingActivityTimer() {
  if (this.pendingActivityTimer) window.clearTimeout(this.pendingActivityTimer);
  this.pendingActivityTimer = undefined;
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function flushPendingActivity() {
  if (!this.pendingActivity || Date.now() < this.activityStickyUntil) {
    this.pendingActivity && this.schedulePendingActivity();
    return;
  }
  if (!this.running || this.streamingAssistantContent || this.activeToolCalls.size > 0) {
    this.pendingActivity = undefined;
    return;
  }
  let pending = this.pendingActivity;
  this.pendingActivity = undefined;
  this.applyActivity(pending.text, pending.kind, pending.detail);
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function updateActivityDom() {
  if (
    !this.running ||
    !this.activityText ||
    !this.activityItemEl ||
    !this.activityDetailsEl ||
    !this.activityLabelEl ||
    !this.activityItemEl.isConnected ||
    !this.activityDetailsEl.isConnected
  )
    return false;
  const label = this.activityText.toUpperCase();
  const title = this.activityDetail || this.activityText;
  if (this.activityDetailsEl.getAttribute("title") !== title)
    this.activityDetailsEl.setAttr("title", title);
  if (
    this.activityLabelEl.getAttribute("aria-label") !==
    STRINGS.activity.inProgress(this.activityText)
  )
    this.activityLabelEl.setAttr("aria-label", STRINGS.activity.inProgress(this.activityText));
  if (this.activityLabelEl.textContent !== label) this.activityLabelEl.setText(label);
  return true;
}

/**
 * @this {import("./PiAgentView.mjs").PiAgentView}
 * @param {any} event
 * @param {string | undefined} threadId
 */
export function captureContextUsage(event, threadId) {
  let tokenUsage = extractEventTokenUsage(event?.raw),
    contextUsage = this.getContextUsageForTokens(tokenUsage);
  if (contextUsage) {
    if (threadId) this.invalidatedContextThreadIds.delete(threadId);
    this.currentRunContextUsage = { contextUsage, tokenUsage };
    this.syncRunContextUsage(threadId);
    this.updateActivityDom();
    this.renderToolBadges();
  }
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function getContextUsageForTokens(tokenUsage) {
  if (!tokenUsage) return;
  const modelInfo = this.plugin.models.getSelectedInfo(tokenUsage);
  const contextWindow = modelInfo?.contextWindow ?? tokenUsage?.contextWindow;
  return createContextUsage(tokenUsage, contextWindow);
}

/**
 * @this {import("./PiAgentView.mjs").PiAgentView}
 * @param {any} event
 * @param {string | undefined} threadId
 */
export function handleRunEvent(event, threadId) {
  let type = this.normalizeRunEventType(event.type);
  this.captureContextUsage(event, threadId);
  if (type === "queue_update") {
    this.nativePiQueue = {
      steering: Array.isArray(event.raw?.steering) ? event.raw.steering : [],
      followUp: Array.isArray(event.raw?.followUp) ? event.raw.followUp : []
    };
    this.renderPromptQueue();
    return;
  }
  if (type === "context_ready") {
    const skillName = this.getCurrentThreadRun()?.skillName;
    this.setActivity(
      skillName ? STRINGS.activity.skill(skillName) : STRINGS.activity.startingPi,
      skillName ? "skill" : "context"
    );
    return;
  }
  if (type === "compaction_start") {
    let detail = this.currentRunContextUsage?.contextUsage
      ? formatContextUsageTitle(
          this.currentRunContextUsage.contextUsage,
          this.currentRunContextUsage.tokenUsage
        )
      : "";
    if (threadId) this.invalidatedContextThreadIds.add(threadId);
    this.currentRunContextUsage = undefined;
    this.syncRunContextUsage(threadId);
    this.renderToolBadges();
    this.setActivity(STRINGS.activity.compactingContext, "context", detail);
    return;
  }
  if (type === "compaction_end") {
    if (event.raw && event.raw.errorMessage) {
      this.setActivity(STRINGS.activity.compactionFailed, "error", String(event.raw.errorMessage));
      return;
    }
    if (event.raw && event.raw.aborted) {
      this.setActivity(STRINGS.activity.compactionSkipped, "thinking");
      return;
    }
    let tokensBefore = event.raw && event.raw.result ? event.raw.result.tokensBefore : undefined;
    if (threadId) this.invalidatedContextThreadIds.add(threadId);
    this.currentRunContextUsage = {
      compacted: true,
      contextWindow: this.plugin.models.getSelectedInfo()?.contextWindow
    };
    this.syncRunContextUsage(threadId);
    this.renderToolBadges();
    this.setActivity(
      event.raw && event.raw.willRetry
        ? STRINGS.activity.compactedRetrying
        : STRINGS.activity.finishing,
      event.raw && event.raw.willRetry ? "context" : "finishing",
      tokensBefore ? `Before compaction: ${formatTokenCount(tokensBefore)} tokens` : ""
    );
    return;
  }
  if (type === "auto_retry_start") {
    this.setActivity(STRINGS.activity.retrying, "finishing", formatRetryDetail(event.raw));
    return;
  }
  if (type === "extension_error" || type === "extension_ui_error") {
    this.setActivity(
      STRINGS.activity.extensionFailed,
      "error",
      String(event.raw?.error ?? event.raw?.message ?? STRINGS.activity.extensionError)
    );
    return;
  }
  if (
    type === "pi_start" ||
    type === "agent_start" ||
    type === "turn_start" ||
    type === "message_start" ||
    type === "thinking_start" ||
    type === "thinking_delta" ||
    type === "thinking_end"
  ) {
    this.streamingAssistantContent || this.setActivity(STRINGS.activity.thinking, "thinking");
    return;
  }
  if (type === "toolcall_start" || type === "toolcall_delta" || type === "toolcall_end") {
    let status = formatToolStatus(event.toolName, event.toolArgs, "preparing");
    this.setActivity(status.label, status.kind, status.detail);
    return;
  }
  if (type === "tool_start" || type === "tool_update") {
    this.trackActiveTool(event);
    let status = this.formatActiveToolStatus();
    this.setActivity(status.label, status.kind, status.detail);
    return;
  }
  if (type === "tool_end") {
    this.untrackActiveTool(event);
    if (this.activeToolCalls.size > 0) {
      let status = this.formatActiveToolStatus();
      this.setActivity(status.label, status.kind, status.detail);
      return;
    }
    this.streamingAssistantContent ||
      this.setActivity(
        event.isError ? STRINGS.activity.toolFailedLabel : STRINGS.activity.reviewingResults,
        event.isError ? "error" : "thinking"
      );
    return;
  }
  if (type === "text_start") {
    this.setActivity(STRINGS.messages.responding, "answer");
    return;
  }
  if (type === "message_end" || type === "turn_end") {
    this.streamingAssistantContent || this.setActivity(STRINGS.activity.thinking, "thinking");
    return;
  }
  if (type === "agent_end") {
    this.activityText = "";
    this.activityDetail = "";
    this.activityStickyUntil = 0;
    this.pendingActivity = undefined;
    this.clearPendingActivityTimer();
    this.activeToolCalls.clear();
    this.renderMessages();
  }
}

export function normalizeRunEventType(type) {
  return type === "auto_compaction_start" || type === "session_before_compact"
    ? "compaction_start"
    : type === "auto_compaction_end" || type === "session_compact"
      ? "compaction_end"
      : type;
}

/**
 * @this {import("./PiAgentView.mjs").PiAgentView}
 * @param {any} event
 * @param {Map<string, any>} [toolCalls]
 */
export function trackActiveTool(event, toolCalls) {
  let key = getToolEventKey(event),
    name = String(event.toolName || event.message || "tool"),
    args = event.toolArgs || {};
  (toolCalls ?? this.activeToolCalls).set(key, { name: name, args: args });
}

/**
 * @this {import("./PiAgentView.mjs").PiAgentView}
 * @param {any} event
 * @param {Map<string, any>} [toolCalls]
 */
export function untrackActiveTool(event, toolCalls) {
  (toolCalls ?? this.activeToolCalls).delete(getToolEventKey(event));
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function formatActiveToolStatus() {
  let tools = [...this.activeToolCalls.values()];
  if (tools.length === 0) return { label: STRINGS.activity.thinking, kind: "thinking", detail: "" };
  if (tools.length === 1) return formatToolStatus(tools[0].name, tools[0].args, "running");
  let statuses = tools.map((status) => formatToolStatus(status.name, status.args, "running"));
  return {
    label: `Running ${tools.length} actions`,
    kind: statuses.some((status) => status.kind === "shell")
      ? "shell"
      : statuses.some((status) => status.kind === "edit")
        ? "edit"
        : statuses.some((status) => status.kind === "search")
          ? "search"
          : "read",
    detail: statuses.map((status) => status.label).join(" • ")
  };
}
