import * as f from "obsidian";
import { performanceProfiler } from "../shared/performance-profiler.mjs";
import { cancelFrame, now, requestFrame } from "../shared/runtime.mjs";

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function renderMessages() {
  this.syncCurrentRunFlags();
  if (!this.messagesEl) return;
  let e = this.messagesEl,
    t = this.state.stickToBottom,
    n = e.scrollTop;
  this.state.isRenderingMessages = !0;
  this.activityItemEl = void 0;
  this.activityDetailsEl = void 0;
  this.activityLabelEl = void 0;
  this.liveThinkingDetailsEl = void 0;
  this.liveThinkingTextEl = void 0;
  this.liveThinkingSetExpanded = void 0;
  this.unloadMessageRenderComponents();
  e.empty();
  let s = this.plugin.messages;
  if (s.length === 0) {
    this.renderEmptyState();
    this.restoreMessagesScroll(e, t, n);
    this.state.isRenderingMessages = !1;
    return;
  }
  for (let a = 0; a < s.length; a++) this.renderMessage(s[a], a);
  if (this.state.running && this.state.streamingAssistantContent)
    this.renderStreamingAssistantMessage();
  else if (this.state.running && this.state.activityText) this.renderActivityMessage();
  this.restoreMessagesScroll(e, t, n);
  this.state.isRenderingMessages = !1;
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function restoreMessagesScroll(e, t, n) {
  t ? (e.scrollTop = e.scrollHeight) : (e.scrollTop = Math.min(n, e.scrollHeight));
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function renderEmptyState() {
  if (!this.messagesEl) return;
  let t = this.messagesEl
    .createDiv({ cls: "pi-agent-empty-state" })
    .createSpan({ cls: "pi-agent-empty-icon" });
  (0, f.setIcon)(t, "messages-square");
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function renderMessage(e, t) {
  if (!this.messagesEl) return;
  let n = this.messagesEl.createDiv({
    cls: `pi-agent-message pi-agent-message-${e.role}`
  });
  this.renderRoleLabel(n, e.role === "user" ? "user" : "pi", e, t);
  if (e.role === "assistant") this.renderToolErrors(n, e.toolErrors);
  const response = n.createDiv({ cls: "pi-agent-message-content" });
  let answer = response;
  if (e.role === "assistant" && e.thinking) {
    const key = `${this.getCurrentThreadId()}:${e.createdAt}`;
    this.renderThinkingDisclosure(
      response,
      e.thinking,
      this.state.completedThinkingExpansion.get(key) === true,
      (expanded) => this.state.completedThinkingExpansion.set(key, expanded),
      false,
      "Thinking",
      (container, content) => this.renderPlainMessageContent(container, content)
    );
    answer = response.createDiv({ cls: "pi-agent-message-answer" });
  }
  this.renderPlainMessageContent(answer, e.content);
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function renderToolErrors(container, errors) {
  for (const error of Array.isArray(errors) ? errors : [])
    container.createDiv({ cls: "pi-agent-tool-error", text: error });
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function renderThinkingDisclosure(
  container,
  thinking,
  expanded,
  onToggle,
  live = false,
  activityLabel = "Thinking",
  renderMarkdown,
  hasResponse = false
) {
  const details = container.createEl("details", {
    cls: `pi-agent-thinking-disclosure${live ? " is-live" : ""}${hasResponse ? " has-response" : ""}`,
    attr: { title: activityLabel }
  });
  let knownExpanded = expanded;
  details.toggleAttribute("open", expanded);
  const summary = details.createEl("summary");
  const chevron = summary.createSpan({ cls: "pi-agent-thinking-chevron" });
  (0, f.setIcon)(chevron, "chevron-right");
  const label = summary.createSpan({
    cls: "pi-agent-thinking-label",
    text: String(activityLabel || "Thinking").toUpperCase(),
    attr: live
      ? { role: "status", "aria-label": `${activityLabel || "Thinking"} in progress` }
      : undefined
  });
  const canRenderMarkdown = Boolean(thinking && renderMarkdown);
  const text = details.createDiv({
    cls: "pi-agent-thinking-content",
    text: canRenderMarkdown ? undefined : thinking
  });
  if (canRenderMarkdown) renderMarkdown(text, thinking);
  details.addEventListener("toggle", () => {
    if (details.open === knownExpanded) return;
    knownExpanded = details.open;
    onToggle?.(details.open);
  });
  return {
    details,
    label,
    text,
    setExpanded(nextExpanded) {
      knownExpanded = nextExpanded;
      details.toggleAttribute("open", nextExpanded);
    }
  };
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function handleMessageLinkClick(event) {
  const link = event?.target?.closest?.("a.internal-link");
  if (!link) return false;
  const href = link.getAttribute("data-href") || link.getAttribute("href");
  if (!href) return false;
  event.preventDefault?.();
  event.stopPropagation?.();
  this.openVaultLink(href, event.metaKey === true || event.ctrlKey === true);
  return true;
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function renderPlainMessageContent(container, content) {
  performanceProfiler.incrementCounter("markdownRenderCount");
  container.empty();
  container.addClass("markdown-rendered");

  this.state.messageRenderComponentByElement ??= new WeakMap();
  const previousComponent = this.state.messageRenderComponentByElement.get(container);
  if (previousComponent) {
    previousComponent.unload();
    const previousIndex = this.state.messageRenderComponents.indexOf(previousComponent);
    if (previousIndex !== -1) this.state.messageRenderComponents.splice(previousIndex, 1);
  }

  const component = new f.Component();
  component.load();
  this.state.messageRenderComponents.push(component);
  this.state.messageRenderComponentByElement.set(container, component);

  return f.MarkdownRenderer.render(
    this.plugin.app,
    content || "",
    container,
    this.getLinkSourcePath(),
    component
  ).catch((err) => {
    console.error("Pi Agent: Markdown render error", err);
    container.setText(content || "");
  });
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function unloadMessageRenderComponents() {
  for (const component of this.state.messageRenderComponents.splice(0)) component.unload();
  this.state.messageRenderComponentByElement = new WeakMap();
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function renderStreamingAssistantMessage() {
  if (!this.messagesEl) return;
  const item = this.messagesEl.createDiv({
    cls: "pi-agent-message pi-agent-message-assistant pi-agent-message-streaming"
  });
  this.streamingItemEl = item;
  this.activityItemEl = item;
  this.renderRoleLabel(item, "pi");
  const response = item.createDiv({
    cls: "pi-agent-message-content pi-agent-message-content-streaming"
  });
  // The streaming phase is plain text. No Markdown
  // render, no per-delta Component churn; the final Markdown render happens
  // once via finalizeStreamingContent when the run settles.
  const rendered = this.renderThinkingDisclosure(
    response,
    this.state.streamingThinkingContent,
    this.state.thinkingDisclosureExpanded,
    (expanded) => this.setLiveThinkingExpanded(expanded),
    true,
    this.state.activityText || "Responding",
    undefined,
    true
  );
  this.activityDetailsEl = rendered.details;
  this.activityLabelEl = rendered.label;
  this.liveThinkingDetailsEl = rendered.details;
  this.liveThinkingTextEl = rendered.text;
  this.liveThinkingSetExpanded = rendered.setExpanded;
  this.streamingTextEl = response.createDiv({ cls: "pi-agent-message-answer" });
  this.renderStreamingAnswer();
  this.state.streamingAnswerDirty = false;
  this.state.streamingThinkingDirty = false;
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function renderStreamingAnswer() {
  const container = this.streamingTextEl;
  if (!container || container.isConnected === false) return false;
  // Single source of truth: every flush paints the full accumulated text.
  container.setText(this.state.streamingAssistantContent || "");
  container.createSpan({ cls: "pi-agent-typing-cursor", text: "\u258C" });
  return true;
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function renderStreamingThinking() {
  const container = this.liveThinkingTextEl;
  if (!container || container.isConnected === false) return false;
  container.setText(this.state.streamingThinkingContent || "");
  return true;
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function renderActivityMessage() {
  if (!this.messagesEl) return;
  const item = this.messagesEl.createDiv({
    cls: "pi-agent-message pi-agent-message-assistant pi-agent-message-activity"
  });
  this.activityItemEl = item;
  this.renderRoleLabel(item, "pi");
  const response = item.createDiv({ cls: "pi-agent-message-content" });
  const rendered = this.renderThinkingDisclosure(
    response,
    this.state.streamingThinkingContent,
    this.state.streamingThinkingContent ? this.state.thinkingDisclosureExpanded : false,
    (expanded) => this.setLiveThinkingExpanded(expanded),
    true,
    this.state.activityText || "Thinking",
    undefined
  );
  this.activityDetailsEl = rendered.details;
  this.activityLabelEl = rendered.label;
  this.liveThinkingDetailsEl = rendered.details;
  this.liveThinkingTextEl = rendered.text;
  this.liveThinkingSetExpanded = rendered.setExpanded;
  this.state.streamingAnswerDirty = false;
  this.state.streamingThinkingDirty = false;
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function appendStreamingDelta(delta) {
  if (!delta) return;
  this.state.activityText = "Responding";
  this.state.activityKind = "answer";
  this.state.activityDetail = "";
  this.state.activityStickyUntil = 0;
  this.state.pendingActivity = void 0;
  this.clearPendingActivityTimer();
  // The delta only appends to the single source of truth;
  // the low-cost DOM update is coalesced into the next animation frame.
  this.state.streamingAssistantContent += delta;
  this.state.streamingAnswerDirty = true;
  this.updateActivityDom();
  this.scheduleStreamingFlush();
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function appendStreamingThinkingDelta(delta) {
  if (!delta) return;
  // Thinking uses the same single source -> frame
  // coalescing -> plain text pipeline as the assistant answer.
  this.state.streamingThinkingDirty = true;
  this.scheduleStreamingFlush();
}

/**
 * At most one streaming flush per animation frame. Multiple
 * deltas collapse into a single rAF, then a single low-cost text DOM update.
 *
 * @this {import("./view/view-surface.mjs").PiAgentViewSurface}
 */
export function scheduleStreamingFlush() {
  if (this.state.streamingFlushRaf !== undefined) return;
  // requestFrame() falls back to a timer when the window has no rAF.
  // The delayed frame callback carries a run/thread generation
  // guard so a settled run or switched thread cannot repaint stale content.
  this.state.streamingFlushGuard = this.captureUiCallbackGuard?.();
  // Registered with the view lifecycle so closing the view cancels this frame.
  // The handle is captured, not read back later: cancelling clears the field,
  // and a cleanup that read it then would call cancel without an argument.
  this.state.streamingFlushRaf = requestFrame(() => {
    this.releaseStreamingFlushCleanup();
    this.state.streamingFlushRaf = undefined;
    const guard = this.state.streamingFlushGuard;
    this.state.streamingFlushGuard = undefined;
    if (guard && this.isStaleUiCallback?.(guard)) {
      this.state.streamingAnswerDirty = false;
      this.state.streamingThinkingDirty = false;
      this.noteStaleUiCallback?.();
      return;
    }
    this.flushStreaming();
  });
  const frameHandle = this.state.streamingFlushRaf;
  this.state.streamingFlushCleanup = this.lifecycle?.addCleanup(() => cancelFrame(frameHandle));
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function cancelStreamingFlush() {
  // The lifecycle registration is the single place that cancels the frame, so
  // this cannot cancel twice; releaseStreamingFlushCleanup() clears the field.
  this.releaseStreamingFlushCleanup();
  this.state.streamingFlushRaf = undefined;
  this.state.streamingFlushGuard = undefined;
}

/**
 * Drop the frame's lifecycle registration, if any. Called when the frame runs
 * or is cancelled, so dispose() does not touch a frame that is already gone.
 *
 * @this {import("./view/view-surface.mjs").PiAgentViewSurface}
 */
export function releaseStreamingFlushCleanup() {
  const release = this.state.streamingFlushCleanup;
  this.state.streamingFlushCleanup = undefined;
  if (typeof release === "function") release();
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function flushStreaming() {
  if (!this.state.streamingAnswerDirty && !this.state.streamingThinkingDirty) return;

  const profiler = performanceProfiler;
  const profiling = profiler.enabled;
  const startedAt = profiling ? now() : 0;
  try {
    if (this.state.streamingAnswerDirty && !this.renderStreamingAnswer()) {
      this.renderMessages();
      return;
    }
    if (this.state.streamingThinkingDirty && !this.renderStreamingThinking()) {
      this.renderMessages();
      return;
    }
    this.state.streamingAnswerDirty = false;
    this.state.streamingThinkingDirty = false;
    if (this.messagesEl && this.state.stickToBottom)
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  } finally {
    if (profiling) {
      profiler.incrementCounter("streamFlushCount");
      profiler.recordDuration("streamFlush", now() - startedAt);
    }
  }
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
/**
 * Cancel the pending frame, flush synchronously and replace
 * the plain-text streaming container with one final Markdown render based on
 * the single source of truth. Never waits for the next frame.
 *
 * Returns false when there is no connected streaming DOM to finalize (the
 * caller falls back to a full message re-render).
 *
 * @this {import("./view/view-surface.mjs").PiAgentViewSurface}
 */
export function finalizeStreamingContent() {
  const answer = this.state.streamingAssistantContent || "";
  const thinking = this.state.streamingThinkingContent || "";
  this.cancelStreamingFlush();
  if (!answer && !thinking) return false;

  const answerContainer = this.streamingTextEl;
  const thinkingContainer = this.liveThinkingTextEl;
  const hasAnswerDom =
    Boolean(answer) && Boolean(answerContainer) && answerContainer.isConnected !== false;
  const hasThinkingDom =
    Boolean(thinking) && Boolean(thinkingContainer) && thinkingContainer.isConnected !== false;
  if (!hasAnswerDom && !hasThinkingDom) return false;

  const messagesEl = this.messagesEl;
  const previousScrollTop = messagesEl?.scrollTop;
  if (hasThinkingDom) this.renderPlainMessageContent(thinkingContainer, thinking);
  if (hasAnswerDom) this.renderPlainMessageContent(answerContainer, answer);
  this.state.streamingAnswerDirty = false;
  this.state.streamingThinkingDirty = false;
  if (messagesEl) {
    if (this.state.stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    else if (previousScrollTop !== undefined)
      messagesEl.scrollTop = Math.min(previousScrollTop, messagesEl.scrollHeight);
  }
  return true;
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function renderRoleLabel(e, t, n, s) {
  let a = e.createDiv({ cls: "pi-agent-message-role" }),
    o = a.createSpan({ cls: "pi-agent-message-role-title" }),
    l = o.createSpan({
      cls: `pi-agent-role-icon pi-agent-role-icon-${t}`
    });
  if (t === "user") {
    (0, f.setIcon)(l, "user");
    o.createSpan({ text: "You" });
  } else {
    this.renderPiIcon(l);
    o.createSpan({ text: "Agent" });
  }
  if (n && s !== void 0) {
    let u = a.createEl("button", {
      cls: "clickable-icon pi-agent-message-actions",
      attr: { "aria-label": "Message actions" }
    });
    (0, f.setIcon)(u, "ellipsis");
    u.addEventListener("click", (g) => {
      var m;
      g.preventDefault();
      g.stopPropagation();
      if ((m = this.messageActions) != null) m.showMessageMenu(g, n, s);
    });
  }
}
