/**
 * DOM construction for the chat view.
 *
 * `PiAgentView.renderChatView` used to build this tree inline, which made
 * "where is this element created" answerable only by reading the whole class.
 * The builders here create the elements and wire the listeners, so no
 * element-building code is left in `PiAgentView.mjs`.
 *
 * Each builder receives the container to fill plus the view object, which acts
 * as the bag of callbacks and read-only data the builder needs. The builders
 * never touch the view's lifecycle handles or run state: they only call methods
 * that paint the elements they just created, and every gesture-driven callback
 * is invoked later, so the view is fully constructed by the time it runs.
 */
import { Notice, setIcon } from "obsidian";

import { t as tr } from "../../shared/i18n/index.mjs";
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
