import * as f from "obsidian";
import { STRINGS } from "../shared/strings.mjs";

const STREAM_RENDER_INTERVAL_MS = 80;

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function renderMessages() {
  this.syncCurrentRunFlags();
  if (!this.messagesEl) return;
  let messagesEl = this.messagesEl,
    stickToBottom = this.stickToBottom,
    previousScrollTop = messagesEl.scrollTop;
  this.isRenderingMessages = true;
  this.activityItemEl = undefined;
  this.activityDetailsEl = undefined;
  this.activityLabelEl = undefined;
  this.liveThinkingDetailsEl = undefined;
  this.liveThinkingTextEl = undefined;
  this.liveThinkingSetExpanded = undefined;
  try {
    this.unloadMessageRenderComponents();
    messagesEl.empty();
    let messages = this.plugin.threads.currentMessages();
    if (messages.length === 0) {
      this.renderEmptyState();
      return;
    }
    for (let index = 0; index < messages.length; index++)
      this.renderMessage(messages[index], index);
    if (this.running && this.streamingAssistantContent) this.renderStreamingAssistantMessage();
    else if (this.running && this.activityText) this.renderActivityMessage();
  } finally {
    this.restoreMessagesScroll(messagesEl, stickToBottom, previousScrollTop);
    this.isRenderingMessages = false;
  }
}

export function restoreMessagesScroll(messagesEl, stickToBottom, previousScrollTop) {
  stickToBottom
    ? (messagesEl.scrollTop = messagesEl.scrollHeight)
    : (messagesEl.scrollTop = Math.min(previousScrollTop, messagesEl.scrollHeight));
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function renderEmptyState() {
  if (!this.messagesEl) return;
  let iconEl = this.messagesEl
    .createDiv({ cls: "pi-agent-empty-state" })
    .createSpan({ cls: "pi-agent-empty-icon" });
  (0, f.setIcon)(iconEl, "messages-square");
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function renderMessage(message, index) {
  if (!this.messagesEl) return;
  let messageEl = this.messagesEl.createDiv({
    cls: `pi-agent-message pi-agent-message-${message.role}`
  });
  this.renderRoleLabel(messageEl, message.role === "user" ? "user" : "pi", message, index);
  if (message.role === "assistant") this.renderToolErrors(messageEl, message.toolErrors);
  const response = messageEl.createDiv({ cls: "pi-agent-message-content" });
  let answer = response;
  if (message.role === "assistant" && message.thinking) {
    const key = `${this.getCurrentThreadId()}:${message.createdAt}`;
    this.renderThinkingDisclosure(
      response,
      message.thinking,
      this.completedThinkingExpansion.get(key) === true,
      (expanded) => this.completedThinkingExpansion.set(key, expanded),
      false,
      STRINGS.activity.thinking,
      (container, content) => this.renderPlainMessageContent(container, content)
    );
    answer = response.createDiv({ cls: "pi-agent-message-answer" });
  }
  this.renderPlainMessageContent(answer, message.content);
}

export function renderToolErrors(container, errors) {
  for (const error of Array.isArray(errors) ? errors : [])
    container.createDiv({ cls: "pi-agent-tool-error", text: error });
}

export function renderThinkingDisclosure(
  container,
  thinking,
  expanded,
  onToggle,
  live = false,
  activityLabel = STRINGS.activity.thinking,
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
    text: String(activityLabel || STRINGS.activity.thinking).toUpperCase(),
    attr: live
      ? {
          role: "status",
          "aria-label": STRINGS.activity.inProgress(activityLabel || STRINGS.activity.thinking)
        }
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

/** @this {import("./PiAgentView.mjs").PiAgentView} */
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

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function renderPlainMessageContent(container, content) {
  container.empty();
  container.addClass("markdown-rendered");

  this.messageRenderComponentByElement ??= new WeakMap();
  const previousComponent = this.messageRenderComponentByElement.get(container);
  if (previousComponent) {
    previousComponent.unload();
    const previousIndex = this.messageRenderComponents.indexOf(previousComponent);
    if (previousIndex !== -1) this.messageRenderComponents.splice(previousIndex, 1);
  }

  const component = new f.Component();
  component.load();
  this.messageRenderComponents.push(component);
  this.messageRenderComponentByElement.set(container, component);

  return f.MarkdownRenderer.render(
    this.plugin.app,
    content || "",
    container,
    this.getLinkSourcePath(),
    component
  ).catch((err) => {
    console.error(STRINGS.view.markdownRenderError, err);
    container.setText(content || "");
  });
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function unloadMessageRenderComponents() {
  for (const component of this.messageRenderComponents.splice(0)) component.unload();
  this.messageRenderComponentByElement = new WeakMap();
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
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
  const rendered = this.renderThinkingDisclosure(
    response,
    this.streamingThinkingContent,
    this.thinkingDisclosureExpanded,
    (expanded) => this.setLiveThinkingExpanded(expanded),
    true,
    this.activityText || STRINGS.messages.responding,
    (container, content) => this.renderPlainMessageContent(container, content),
    true
  );
  this.activityDetailsEl = rendered.details;
  this.activityLabelEl = rendered.label;
  this.liveThinkingDetailsEl = rendered.details;
  this.liveThinkingTextEl = rendered.text;
  this.liveThinkingSetExpanded = rendered.setExpanded;
  this.streamingTextEl = response.createDiv({ cls: "pi-agent-message-answer" });
  this.renderStreamingAnswer();
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function renderStreamingAnswer() {
  if (!this.streamingTextEl) return;
  if (!this.streamingTextEl.isConnected && this.streamingTextEl.isConnected !== undefined) return;
  this.streamingTextEl.setText(this.streamingAssistantContent || "");
  this.streamingTextEl.createSpan({ cls: "pi-agent-typing-cursor", text: "\u258C" });
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function renderStreamingThinking() {
  if (!this.liveThinkingTextEl?.isConnected) return;
  this.liveThinkingTextEl.setText(this.streamingThinkingContent || "");
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function scheduleStreamingRender() {
  if (this.streamingRenderTimer) return;
  const elapsed = Date.now() - (this.lastStreamingRenderAt || 0);
  const delay = Math.max(0, STREAM_RENDER_INTERVAL_MS - elapsed);
  this.streamingRenderTimer = window.setTimeout(() => {
    this.streamingRenderTimer = undefined;
    this.flushStreamingRender();
  }, delay);
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function flushStreamingRender() {
  this.lastStreamingRenderAt = Date.now();
  if (!this.running) return;
  if (this.streamingTextEl?.isConnected) {
    this.renderStreamingAnswer();
    this.renderStreamingThinking();
  } else if (this.streamingAssistantContent) {
    this.renderMessages();
  } else if (this.liveThinkingTextEl?.isConnected) {
    this.renderStreamingThinking();
  } else {
    this.renderMessages();
  }
  if (this.messagesEl && this.stickToBottom)
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function clearStreamingRenderTimer() {
  if (this.streamingRenderTimer) window.clearTimeout(this.streamingRenderTimer);
  this.streamingRenderTimer = undefined;
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
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
    this.streamingThinkingContent,
    this.streamingThinkingContent ? this.thinkingDisclosureExpanded : false,
    (expanded) => this.setLiveThinkingExpanded(expanded),
    true,
    this.activityText || STRINGS.activity.thinking,
    (container, content) => this.renderPlainMessageContent(container, content)
  );
  this.activityDetailsEl = rendered.details;
  this.activityLabelEl = rendered.label;
  this.liveThinkingDetailsEl = rendered.details;
  this.liveThinkingTextEl = rendered.text;
  this.liveThinkingSetExpanded = rendered.setExpanded;
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function renderRoleLabel(parent, role, message, index) {
  let roleEl = parent.createDiv({ cls: "pi-agent-message-role" }),
    titleEl = roleEl.createSpan({ cls: "pi-agent-message-role-title" }),
    iconEl = titleEl.createSpan({
      cls: `pi-agent-role-icon pi-agent-role-icon-${role}`
    });
  if (role === "user") {
    (0, f.setIcon)(iconEl, "user");
    titleEl.createSpan({ text: STRINGS.messages.roleYou });
  } else {
    this.renderPiIcon(iconEl);
    titleEl.createSpan({ text: STRINGS.messages.roleAgent });
  }
  if (message && index !== undefined) {
    let actionsButton = roleEl.createEl("button", {
      cls: "clickable-icon pi-agent-message-actions",
      attr: { "aria-label": STRINGS.messages.messageActions }
    });
    (0, f.setIcon)(actionsButton, "ellipsis");
    actionsButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.messageActions?.showMessageMenu(event, message, index);
    });
  }
}
