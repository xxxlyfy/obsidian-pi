import { extractEventTokenUsage } from "../pi/events.mjs";
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

export function queuePendingActivity(text, kind, detail = "") {
  this.pendingActivity = { text: text, kind: kind, detail: detail };
  this.schedulePendingActivity();
}

export function schedulePendingActivity() {
  if (this.pendingActivityTimer) return;
  let delay = Math.max(0, this.activityStickyUntil - Date.now());
  this.pendingActivityTimer = window.setTimeout(() => {
    this.pendingActivityTimer = undefined;
    this.flushPendingActivity();
  }, delay);
}

export function clearPendingActivityTimer() {
  if (this.pendingActivityTimer) window.clearTimeout(this.pendingActivityTimer);
  this.pendingActivityTimer = undefined;
}

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
  if (this.activityLabelEl.getAttribute("aria-label") !== `${this.activityText} in progress`)
    this.activityLabelEl.setAttr("aria-label", `${this.activityText} in progress`);
  if (this.activityLabelEl.textContent !== label) this.activityLabelEl.setText(label);
  return true;
}

export function captureContextUsage(event) {
  let tokenUsage = extractEventTokenUsage(event?.raw),
    contextUsage = this.getContextUsageForTokens(tokenUsage);
  if (contextUsage) {
    if (this.runningThreadId) this.invalidatedContextThreadIds.delete(this.runningThreadId);
    this.currentRunContextUsage = { contextUsage, tokenUsage };
    this.updateActivityDom();
    this.renderToolBadges();
  }
}

export function getContextUsageForTokens(tokenUsage) {
  if (!tokenUsage) return;
  const modelInfo = this.plugin.getSelectedModelInfo(tokenUsage);
  const contextWindow = modelInfo?.contextWindow ?? tokenUsage?.contextWindow;
  return createContextUsage(tokenUsage, contextWindow);
}

export function handleRunEvent(event) {
  let type = this.normalizeRunEventType(event.type);
  this.captureContextUsage(event);
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
      skillName ? `Skill · ${skillName}` : "Starting Pi",
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
    if (this.runningThreadId) this.invalidatedContextThreadIds.add(this.runningThreadId);
    this.currentRunContextUsage = undefined;
    this.renderToolBadges();
    this.setActivity("Compacting context", "context", detail);
    return;
  }
  if (type === "compaction_end") {
    if (event.raw && event.raw.errorMessage) {
      this.setActivity("Compaction failed", "error", String(event.raw.errorMessage));
      return;
    }
    if (event.raw && event.raw.aborted) {
      this.setActivity("Compaction skipped", "thinking");
      return;
    }
    let tokensBefore = event.raw && event.raw.result ? event.raw.result.tokensBefore : undefined;
    if (this.runningThreadId) this.invalidatedContextThreadIds.add(this.runningThreadId);
    this.currentRunContextUsage = {
      compacted: true,
      contextWindow: this.plugin.getSelectedModelInfo()?.contextWindow
    };
    this.renderToolBadges();
    this.setActivity(
      event.raw && event.raw.willRetry ? "Compacted context, retrying" : "Finishing",
      event.raw && event.raw.willRetry ? "context" : "finishing",
      tokensBefore ? `Before compaction: ${formatTokenCount(tokensBefore)} tokens` : ""
    );
    return;
  }
  if (type === "auto_retry_start") {
    this.setActivity("Retrying", "finishing", formatRetryDetail(event.raw));
    return;
  }
  if (type === "extension_error" || type === "extension_ui_error") {
    this.setActivity(
      "Extension failed",
      "error",
      String(event.raw?.error ?? event.raw?.message ?? "Pi extension error")
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
    this.streamingAssistantContent || this.setActivity("Thinking", "thinking");
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
        event.isError ? "Tool failed" : "Reviewing results",
        event.isError ? "error" : "thinking"
      );
    return;
  }
  if (type === "text_start") {
    this.setActivity("Responding", "answer");
    return;
  }
  if (type === "message_end" || type === "turn_end") {
    this.streamingAssistantContent || this.setActivity("Thinking", "thinking");
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

export function trackActiveTool(event) {
  let key = getToolEventKey(event),
    name = String(event.toolName || event.message || "tool"),
    args = event.toolArgs || {};
  this.activeToolCalls.set(key, { name: name, args: args });
}

export function untrackActiveTool(event) {
  this.activeToolCalls.delete(getToolEventKey(event));
}

export function formatActiveToolStatus() {
  let tools = [...this.activeToolCalls.values()];
  if (tools.length === 0) return { label: "Thinking", kind: "thinking", detail: "" };
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
