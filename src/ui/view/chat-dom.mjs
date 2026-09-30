/**
 * DOM construction and DOM painting for the chat view.
 *
 * The file has two halves. The builders at the top create the chat tree; the
 * repaint methods at the bottom are mixed into `PiAgentView.prototype` so they
 * can be called as `this.renderToolBadges()` from anywhere in the view. Both
 * halves live here for one reason: `PiAgentView.mjs` should contain no element
 * creation at all, so "where is this element built" has exactly one answer.
 *
 * Builders receive the container plus the view object, which acts as the bag of
 * callbacks and read-only data they need. They never touch the view's lifecycle
 * handles or run state: they only call methods that paint the elements they just
 * created, and every gesture-driven callback is invoked later, so the view is
 * fully constructed by the time it runs.
 */
import { Notice, setIcon } from "obsidian";

import { formatContextUsageBadge, formatTokenCount } from "../../pi/token-usage.mjs";
import { t as tr } from "../../shared/i18n/index.mjs";
import { getSendActionState } from "../send-state.mjs";
import { SUPPORTED_IMAGE_MIME_TYPES, SUPPORTED_TEXT_EXTENSIONS } from "../prompt-payload.mjs";

/**
 * The slice of the view these builders use. It is deliberately narrower than
 * `PiAgentViewSurface`: a builder wires one region, so it should not be able to
 * reach the rest of the view by accident.
 *
 * @typedef {object} ChatDomView
 * @property {(el: HTMLElement) => void} renderPiIcon
 * @property {() => void} renderThreadTitle
 * @property {() => void} renderThreadFavorite
 * @property {() => void} startThreadTitleRename
 * @property {() => void} toggleCurrentThreadFavorite
 * @property {() => void} showThreadList
 * @property {(threadId: string) => boolean} isThreadRunning
 * @property {(event: MouseEvent) => void} handleMessageLinkClick
 * @property {import("./view-state.mjs").ViewState} state Transient view state.
 * @property {() => void} renderToolBadges
 * @property {() => void} renderPromptQueue
 * @property {() => void} renderComposerImages
 * @property {() => void} renderExtensionWidgets
 * @property {() => void} resizeInput
 * @property {() => void} syncCurrentRunFlags
 * @property {(force: boolean) => void} setRunningState
 * @property {boolean} running
 * @property {() => void} cancelCurrentRun
 * @property {() => void} submitInput
 * @property {(event: ClipboardEvent) => void} handleImagePaste
 * @property {(event: DragEvent) => void} handleImageDrop
 * @property {(files: FileList | null | undefined) => void} addLocalFiles
 * @property {() => void} handleSendButtonClick
 * @property {(parent: HTMLElement) => void} renderImagePicker
 * @property {(bar: HTMLElement) => void} observeComposerBar
 * @property {any} suggestions Composer suggestion controller, assigned after the textarea.
 * @property {any} threadMenu Thread actions, assigned before the header is built.
 * @property {any} runSettings Composer run-settings controls, assigned before they render.
 * @property {any} lifecycle Timers owned by the view.
 * @property {any} plugin Backing plugin instance.
 * @property {any} imageInputEl Hidden file input, assigned after it is created.
 */

/**
 * Empty the view container and give it the chat-view class.
 *
 * @param {HTMLElement} container View container to fill.
 * @returns {{ root: HTMLElement }} The filled container.
 */
export function createChatShell(container) {
  container.empty();
  container.addClass("pi-agent-view");
  return { root: container };
}

/**
 * Build the header: brand icon, editable thread title, and thread actions.
 *
 * @param {HTMLElement} root Chat shell.
 * @param {ChatDomView} view View that owns this region's callbacks.
 * @returns {{ threadTitleEl: HTMLElement, threadFavoriteEl: HTMLElement }}
 */
export function createHeader(root, view) {
  const header = root.createDiv({ cls: "pi-agent-header" });
  const brand = header.createDiv({ cls: "pi-agent-brand" });
  const brandIcon = brand.createSpan({
    cls: "pi-agent-brand-icon",
    attr: { title: "Pi Agent" }
  });
  view.renderPiIcon(brandIcon);
  const threadTitleEl = brand.createSpan({
    cls: "pi-agent-thread-title",
    attr: { role: "button", tabindex: "0", title: tr("view.renameChat") }
  });
  threadTitleEl.addEventListener("click", () => view.startThreadTitleRename());
  threadTitleEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      view.startThreadTitleRename();
    }
  });
  view.renderThreadTitle();

  const actions = header.createDiv({ cls: "pi-agent-header-actions" });
  const favoriteButton = actions.createEl("button", {
    cls: "clickable-icon pi-agent-header-action pi-agent-header-favorite"
  });
  const newChatButton = actions.createEl("button", {
    cls: "clickable-icon pi-agent-header-action",
    attr: { "aria-label": tr("view.newChat"), title: tr("view.newChat") }
  });
  setIcon(favoriteButton, "star");
  view.renderThreadFavorite();
  favoriteButton.addEventListener("click", () => view.toggleCurrentThreadFavorite());
  setIcon(newChatButton, "plus");
  newChatButton.addEventListener("click", (event) => {
    event.preventDefault();
    view.threadMenu?.startNewChat();
  });

  const forkButton = actions.createEl("button", {
    cls: "clickable-icon pi-agent-header-action",
    attr: { "aria-label": tr("view.forkChat"), title: tr("view.forkChat") }
  });
  setIcon(forkButton, "split");
  forkButton.addEventListener("click", (event) => {
    event.preventDefault();
    if (view.isThreadRunning(view.plugin.getCurrentThread().id)) {
      new Notice(tr("view.forkBusy"));
      return;
    }
    view.threadMenu?.forkChat();
    view.renderToolBadges();
  });

  const manageButton = actions.createEl("button", {
    cls: "clickable-icon pi-agent-thread-menu",
    attr: {
      "aria-label": tr("view.manageThreads"),
      title: tr("view.manageThreads")
    }
  });
  setIcon(manageButton, "list");
  manageButton.addEventListener("click", (event) => {
    event.preventDefault();
    view.showThreadList();
  });

  return { threadTitleEl, threadFavoriteEl: favoriteButton };
}

/**
 * Build the scrollable message area and its scroll/link wiring.
 *
 * @param {HTMLElement} root Chat shell.
 * @param {ChatDomView} view View that owns this region's callbacks.
 * @returns {{ messagesEl: HTMLElement }}
 */
export function createMessagesArea(root, view) {
  const messagesEl = root.createDiv({ cls: "pi-agent-messages" });
  messagesEl.addEventListener("scroll", () => {
    if (view.state.isRenderingMessages) return;
    const distance = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    view.state.stickToBottom = distance < 40;
  });
  messagesEl.addEventListener("click", (event) => view.handleMessageLinkClick(event), true);
  return { messagesEl };
}

/**
 * Build the composer column in the order it renders top to bottom: tool badges,
 * prompt queue, widgets above the editor, the textarea, widgets below, the
 * hidden file input, then the composer bar with the pickers and send button.
 *
 * @param {HTMLElement} root Chat shell.
 * @param {ChatDomView} view View that owns this region's callbacks.
 * @returns {{
 *   toolBadgesEl: HTMLElement,
 *   promptQueueEl: HTMLElement,
 *   extensionWidgetsAboveEl: HTMLElement,
 *   extensionWidgetsBelowEl: HTMLElement,
 *   inputEl: HTMLTextAreaElement,
 *   imageInputEl: HTMLInputElement,
 *   composerBarEl: HTMLElement,
 *   sendButtonEl: HTMLElement
 * }}
 */
export function createComposer(root, view) {
  const composer = root.createDiv({ cls: "pi-agent-composer" });

  const toolBadgesEl = composer.createDiv({ cls: "pi-agent-tool-badges" });
  view.renderToolBadges();

  const promptQueueEl = composer.createDiv({ cls: "pi-agent-prompt-queue" });
  view.renderPromptQueue();

  const extensionWidgetsAboveEl = composer.createDiv({ cls: "pi-agent-extension-widgets" });
  view.renderComposerImages();

  const inputEl = composer.createEl("textarea", {
    placeholder: tr("composer.placeholder")
  });
  inputEl.addEventListener("keydown", (event) => {
    if (view.suggestions?.handleKeydown(event)) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      view.submitInput();
    }
    if (event.key === "Escape") {
      view.syncCurrentRunFlags();
      if (view.state.running) {
        event.preventDefault();
        view.cancelCurrentRun();
      }
    }
  });
  inputEl.addEventListener("paste", (event) => view.handleImagePaste(event));
  inputEl.addEventListener("dragover", (event) => {
    if ((event.dataTransfer?.files?.length || 0) > 0) event.preventDefault();
  });
  inputEl.addEventListener("drop", (event) => view.handleImageDrop(event));
  inputEl.addEventListener("input", () => {
    view.syncCurrentRunFlags();
    view.resizeInput();
    view.suggestions?.update();
    view.setRunningState(view.state.running);
  });
  inputEl.addEventListener("click", () => {
    view.suggestions?.update();
  });
  inputEl.addEventListener("blur", () => {
    view.lifecycle.setTimer(() => {
      view.suggestions?.close();
    }, 120);
  });

  const extensionWidgetsBelowEl = composer.createDiv({ cls: "pi-agent-extension-widgets" });
  view.renderExtensionWidgets();
  view.resizeInput();

  const imageInputEl = composer.createEl("input", {
    cls: "pi-agent-image-input",
    attr: {
      type: "file",
      accept: [
        ...SUPPORTED_IMAGE_MIME_TYPES,
        ...SUPPORTED_TEXT_EXTENSIONS.map((ext) => `.${ext}`)
      ].join(","),
      multiple: ""
    }
  });
  imageInputEl.addEventListener("change", () => {
    view.addLocalFiles(view.imageInputEl?.files);
    if (view.imageInputEl) view.imageInputEl.value = "";
  });

  const composerBarEl = composer.createDiv({ cls: "pi-agent-composer-bar" });
  view.renderImagePicker(composerBarEl);
  view.runSettings.render(composerBarEl);

  const sendButtonEl = composerBarEl.createEl("button", {
    cls: "clickable-icon pi-agent-send-button",
    attr: { "aria-label": tr("send.sendAria"), title: tr("send.sendAria") }
  });
  setIcon(sendButtonEl, "send");
  sendButtonEl.createSpan({ cls: "pi-agent-control-label", text: tr("send.send") });
  sendButtonEl.addEventListener("click", () => view.handleSendButtonClick());
  view.observeComposerBar(composerBarEl);

  return {
    toolBadgesEl,
    promptQueueEl,
    extensionWidgetsAboveEl,
    extensionWidgetsBelowEl,
    inputEl,
    imageInputEl,
    composerBarEl,
    sendButtonEl
  };
}

// ---------------------------------------------------------------------------
// Repaint methods, mixed into PiAgentView.prototype at the end of
// PiAgentView.mjs. They use `this` as the view does; keeping them here is what
// lets PiAgentView.mjs stay free of element creation.
// ---------------------------------------------------------------------------

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export function renderExtensionWidgets() {
  this.extensionWidgetsAboveEl?.empty();
  this.extensionWidgetsBelowEl?.empty();
  for (const widget of (this.plugin.extensionWidgets ?? new Map()).values()) {
    const target =
      widget.placement === "belowEditor"
        ? this.extensionWidgetsBelowEl
        : this.extensionWidgetsAboveEl;
    if (!target) continue;
    const widgetEl = target.createDiv({ cls: "pi-agent-extension-widget" });
    for (const line of widget.lines) widgetEl.createDiv({ text: line });
  }
}

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export function renderToolBadges() {
  const root = this.toolBadgesEl;
  if (!root) return;
  root.empty();
  const badges = root.createDiv({
    cls: "pi-agent-context-badges",
    attr: { role: "list", "aria-label": "Pending prompt context" }
  });
  const contextFile = this.plugin.getCurrentContextFile();
  if (contextFile)
    this.renderPendingBadge(badges, contextFile.name, {
      title: contextFile.path,
      removeLabel: `Remove ${contextFile.name} from context`,
      onRemove: () => {
        this.plugin.excludeContextFile(contextFile.path);
        this.renderToolBadges();
      }
    });
  for (const image of this.state.composerImages)
    this.renderPendingBadge(badges, image.fileName || "image", {
      removeLabel: `Remove ${image.fileName || "image"}`,
      onRemove: () => {
        this.state.composerImages = this.state.composerImages.filter(
          (item) => item.id !== image.id
        );
        this.renderComposerImages();
      }
    });
  for (const attachment of this.state.composerAttachments)
    this.renderPendingBadge(badges, attachment.fileName, {
      removeLabel: `Remove ${attachment.fileName}`,
      onRemove: () => {
        this.state.composerAttachments = this.state.composerAttachments.filter(
          (item) => item.id !== attachment.id
        );
        this.renderComposerImages();
      }
    });
  const annotations = contextFile ? this.plugin.annotationStore.list(contextFile.path) : [];
  if (annotations.length > 0) {
    const label = `${annotations.length} annotation${annotations.length === 1 ? "" : "s"}`;
    this.renderPendingBadge(badges, label, {
      removeLabel: `Clear ${label}`,
      onRemove: () => {
        this.plugin.annotationController?.cancelPick();
        this.plugin.annotationStore.deletePath(contextFile.path);
        this.renderToolBadges();
      }
    });
  }
  this.renderToolBadgesContextUsage(root);
}

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export function renderPendingBadge(parent, label, options = {}) {
  const { removeLabel, onRemove, title = label } = options;
  const badge = parent.createSpan({
    cls: "pi-agent-tool-badge pi-agent-context-badge is-enabled",
    attr: { title, role: "listitem" }
  });
  badge.createSpan({ cls: "pi-agent-context-badge-label", text: label });
  if (!onRemove) return;
  const remove = badge.createEl("button", {
    cls: "clickable-icon pi-agent-context-badge-remove",
    attr: { type: "button", "aria-label": removeLabel, title: removeLabel }
  });
  setIcon(remove, "x");
  remove.addEventListener("click", onRemove);
}

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export function renderToolBadgesContextUsage(container) {
  const usage = this.getDisplayedContextUsage();
  const badge = usage?.compacted
    ? {
        label: `ctx compacted · ?/${formatTokenCount(usage.contextWindow || 0)}`,
        title:
          "Pi compacted this session. Exact context usage is unknown until the next model response returns fresh token usage."
      }
    : usage
      ? formatContextUsageBadge(usage.contextUsage, usage.tokenUsage)
      : undefined;
  container.createSpan({
    cls: `pi-agent-tool-badge pi-agent-tool-badge-context${badge ? " is-enabled" : ""}`,
    text: badge ? badge.label : "ctx --",
    attr: {
      title: badge
        ? badge.title
        : "Context usage appears after Pi returns token usage for the selected model."
    }
  });
}

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export function renderThreadTitle() {
  if (!this.threadTitleEl) return;
  const thread = this.plugin.getCurrentThread();
  this.threadTitleEl.empty();
  this.threadTitleEl.createSpan({ text: thread.title });
  this.renderThreadFavorite();
}

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export function renderThreadFavorite() {
  if (!this.threadFavoriteEl) return;
  const favorite = this.plugin.getCurrentThread().favorite === true;
  this.threadFavoriteEl.toggleClass("is-favorite", favorite);
  this.threadFavoriteEl.setAttr("aria-pressed", String(favorite));
  this.threadFavoriteEl.setAttr(
    "aria-label",
    tr(favorite ? "view.favoriteRemove" : "view.favoriteAdd")
  );
  this.threadFavoriteEl.setAttr("title", tr(favorite ? "view.favoriteRemove" : "view.favoriteAdd"));
}

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export function startThreadTitleRename() {
  if (!this.threadTitleEl?.isConnected) return;
  const thread = this.plugin.getCurrentThread();
  this.threadTitleEl.empty();
  this.threadTitleEl.addClass("is-editing");
  const input = this.threadTitleEl.createEl("input", {
    cls: "pi-agent-thread-title-input",
    attr: { type: "text", value: thread.title, "aria-label": tr("view.chatTitle") }
  });
  const finish = (commit) => {
    const nextTitle = input.value.trim();
    this.threadTitleEl?.removeClass("is-editing");
    if (commit && nextTitle && nextTitle !== thread.title)
      this.plugin.renameThread(thread.id, nextTitle);
    this.renderThreadTitle();
  };
  const stopEvent = (event) => {
    event.stopPropagation();
  };
  input.addEventListener(
    "keydown",
    (event) => {
      stopEvent(event);
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    },
    { capture: true }
  );
  input.addEventListener("keypress", stopEvent, { capture: true });
  input.addEventListener("keyup", stopEvent, { capture: true });
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("blur", () => finish(true));
  input.focus();
  input.select();
}

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export function renderImagePicker(parent) {
  const button = parent.createEl("button", {
    cls: "clickable-icon pi-agent-image-button",
    attr: { "aria-label": tr("composer.attach"), title: tr("composer.attach") }
  });
  setIcon(button, "paperclip");
  button.addEventListener("click", (event) => this.showAttachmentMenu(event));
}

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export function updateComposerBarMode(width) {
  const bar = this.composerBarEl;
  if (!bar) return;
  bar.toggleClass("is-compact", width < 560);
  bar.toggleClass("is-narrow", width < 390);
}

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export function setRunningState(running) {
  const hasInput =
    !!this.inputEl?.value.trim() ||
    this.state.composerImages.length > 0 ||
    this.state.composerAttachments.length > 0;
  const action = getSendActionState({
    running,
    canceling: this.state.canceling,
    hasInput,
    queuedCount: this.state.promptQueue.length
  });
  if (!this.sendButtonEl) return;
  this.sendButtonEl.empty();
  setIcon(this.sendButtonEl, action.icon);
  this.sendButtonEl.createSpan({ cls: "pi-agent-control-label", text: action.label });
  this.sendButtonEl.toggleAttribute("disabled", action.disabled);
  this.sendButtonEl.setAttr("aria-label", action.ariaLabel);
  this.sendButtonEl.setAttr(
    "title",
    action.titleSuffix ? `${action.ariaLabel}. ${action.titleSuffix}` : action.ariaLabel
  );
  for (const state of ["send", "queue", "cancel", "canceling"])
    this.sendButtonEl.toggleClass(`is-${state}`, action.state === state);
}

/**
 * The repaint methods as one object, so the prototype composition in
 * `PiAgentView.mjs` reads the same way as its other mixins.
 */
export const chatDomMethods = {
  renderExtensionWidgets,
  renderImagePicker,
  renderPendingBadge,
  renderThreadFavorite,
  renderThreadTitle,
  renderToolBadges,
  renderToolBadgesContextUsage,
  setRunningState,
  startThreadTitleRename,
  updateComposerBarMode
};
