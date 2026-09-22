import * as f from "obsidian";
import { STRINGS } from "../shared/strings.mjs";
import { isPiRunCanceled } from "../pi/run-canceled.mjs";
import { formatContextUsageBadge, formatTokenCount } from "../pi/token-usage.mjs";
import {
  PI_AGENT_DISPLAY_NAME,
  PI_AGENT_ICON_ID,
  PI_AGENT_VIEW_TYPE
} from "../plugin/constants.mjs";

import { MessageActions } from "./message-actions.mjs";
import { NoteActions } from "./note-actions.mjs";
import * as promptQueueMethods from "./prompt-queue.mjs";
import * as threadListMethods from "./thread-list-view.mjs";
import * as vaultLinkMethods from "./vault-link-actions.mjs";
import * as messageRendererMethods from "./message-renderer.mjs";
import * as runActivityMethods from "./run-activity-state.mjs";
import { RunSettingsControls } from "./run-settings.mjs";
import { ComposerSuggestions } from "./suggestions.mjs";
import { ThreadActions } from "./thread-actions.mjs";
import { getCurrentRunMetadata } from "./view/run-metadata.mjs";
import {
  appendTextAttachmentContext,
  bytesToPromptImage,
  createPromptTextAttachment,
  fileToPromptImage,
  isSupportedTextFile,
  modelSupportsImages,
  SUPPORTED_IMAGE_MIME_TYPES,
  SUPPORTED_TEXT_EXTENSIONS,
  textAttachmentBytes,
  MAX_TOTAL_TEXT_ATTACHMENT_BYTES
} from "./prompt-payload.mjs";
import { formatToolError, getSkillCommandName, getThinkingDelta } from "./activity.mjs";
import { getSendActionState } from "./send-state.mjs";
import {
  getSuccessfulMarkdownMutationPath,
  refreshOpenMarkdownViews
} from "./editor-file-refresh.mjs";
import { openNotificationThread, showDesktopRunNotification } from "./desktop-notifications.mjs";

export class PiAgentView extends f.ItemView {
  /**
   * @param {import("obsidian").WorkspaceLeaf} leaf
   * @param {import("../plugin/PiAgentPlugin.mjs").PiAgentPlugin} plugin
   */
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.running = false;
    this.canceling = false;
    this.activityText = STRINGS.activity.thinking;
    this.activityKind = "thinking";
    this.activityDetail = "";
    this.activityStickyUntil = 0;
    this.pendingActivity = undefined;
    this.pendingActivityTimer = undefined;
    this.isRenderingMessages = false;
    this.activeToolCalls = new Map();
    this.currentRunContextUsage = undefined;
    this.invalidatedContextThreadIds = new Set();
    this.streamingAssistantContent = "";
    this.promptQueue = this.plugin.promptQueue.getItems();
    this.composerImages = [];
    this.composerAttachments = [];
    this.excludedContextPath = undefined;
    this.pendingAnnotationSnapshots = new Set();
    this.nativePiQueue = undefined;
    this.steeringPromptIds = new Set();
    this.streamingThinkingContent = "";
    this.thinkingDisclosureExpanded = false;
    this.thinkingDisclosureUserSet = false;
    this.completedThinkingExpansion = new Map();
    this.messageRenderComponents = [];
    this.messageRenderComponentByElement = new WeakMap();
    this.runtime = this.plugin.createAgentRuntime();
    this.desktopNotificationRunIds = new Set();
    this.nextDesktopNotificationRunId = 1;
    this.stickToBottom = true;
    this.streamingRenderTimer = undefined;
    this.lastStreamingRenderAt = 0;
  }
  getViewType() {
    return PI_AGENT_VIEW_TYPE;
  }
  getDisplayText() {
    return this.plugin.extensionTitle || PI_AGENT_DISPLAY_NAME;
  }
  getIcon() {
    return PI_AGENT_ICON_ID;
  }
  async onOpen() {
    this.registerDomEvent(document, "keydown", (event) => {
      this.syncCurrentRunFlags();
      if (event.key === "Escape" && this.running) {
        event.preventDefault();
        this.cancelCurrentRun();
      }
    });
    this.registerEvent(
      this.plugin.app.workspace.on("file-open", () => {
        this.renderToolBadges();
      })
    );
    this.registerEvent(
      this.plugin.app.workspace.on("active-leaf-change", () => {
        this.renderToolBadges();
      })
    );
    this.renderChatView();
  }
  renderChatView() {
    this.showingThreadList = false;
    let currentThreadId = this.getCurrentThreadId();
    if (this.renderedThreadId !== currentThreadId) this.resetTransientRunUiState();
    this.renderedThreadId = currentThreadId;
    this.syncCurrentRunFlags();
    this.cleanupComposerBarObserver();
    let root = this.containerEl.children[1];
    root.empty();
    root.addClass("pi-agent-view");
    this.noteActions = new NoteActions(this.plugin, {
      parseVaultLinkTarget: (target) => this.parseVaultLinkTarget(target),
      formatVaultLinkTarget: (target) => this.formatVaultLinkTarget(target),
      openVaultLink: (target) => this.openVaultLink(target)
    });
    this.messageActions = new MessageActions(this.plugin, {
      getInput: () => this.inputEl,
      runPrompt: (prompt) => {
        this.startPrompt(prompt);
      },
      insertIntoCurrentNote: (text) => this.noteActions?.insertIntoCurrentNote(text),
      createNoteFromResponse: (text) =>
        this.noteActions?.createNoteFromResponse(text) ?? Promise.resolve(),
      openCitedNotes: (text) => this.noteActions?.openCitedNotes(text) ?? Promise.resolve(),
      extractVaultLinks: (text) => this.noteActions?.extractVaultLinks(text) ?? [],
      getPreviousUserPrompt: (text) => this.noteActions?.getPreviousUserPrompt(text)
    });
    this.threadMenu = new ThreadActions(this.plugin, {
      renderThreadTitle: () => this.renderThreadTitle(),
      renderMessages: () => this.renderMessages(),
      renderToolBadges: () => this.renderToolBadges(),
      resetThreadUiState: () => {
        this.renderedThreadId = this.getCurrentThreadId();
        this.resetTransientRunUiState();
        this.syncCurrentRunFlags();
        this.renderPromptQueue();
        this.setRunningState(this.running);
      }
    });
    let header = root.createDiv({ cls: "pi-agent-header" }),
      brand = header.createDiv({ cls: "pi-agent-brand" }),
      brandIcon = brand.createSpan({
        cls: "pi-agent-brand-icon",
        attr: { title: "Pi Agent" }
      });
    this.renderPiIcon(brandIcon);
    this.threadTitleEl = brand.createSpan({
      cls: "pi-agent-thread-title",
      attr: { role: "button", tabindex: "0", title: STRINGS.view.renameChat }
    });
    this.threadTitleEl.addEventListener("click", () => this.startThreadTitleRename());
    this.threadTitleEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.startThreadTitleRename();
      }
    });
    this.renderThreadTitle();
    let headerActions = header.createDiv({ cls: "pi-agent-header-actions" }),
      favoriteButton = headerActions.createEl("button", {
        cls: "clickable-icon pi-agent-header-action pi-agent-header-favorite"
      }),
      newChatButton = headerActions.createEl("button", {
        cls: "clickable-icon pi-agent-header-action",
        attr: { "aria-label": STRINGS.view.newChat, title: STRINGS.view.newChat }
      });
    this.threadFavoriteEl = favoriteButton;
    (0, f.setIcon)(favoriteButton, "star");
    this.renderThreadFavorite();
    favoriteButton.addEventListener("click", () => this.toggleCurrentThreadFavorite());
    (0, f.setIcon)(newChatButton, "plus");
    newChatButton.addEventListener("click", (event) => {
      event.preventDefault();
      this.threadMenu?.startNewChat();
    });
    let forkButton = headerActions.createEl("button", {
      cls: "clickable-icon pi-agent-header-action",
      attr: { "aria-label": STRINGS.view.forkChat, title: STRINGS.view.forkChat }
    });
    (0, f.setIcon)(forkButton, "split");
    forkButton.addEventListener("click", (event) => {
      event.preventDefault();
      if (this.isThreadRunning(this.plugin.threads.currentThreadId)) {
        new f.Notice(STRINGS.view.forkBusy);
        return;
      }
      this.threadMenu?.forkChat();
      this.renderToolBadges();
    });
    let threadListButton = headerActions.createEl("button", {
      cls: "clickable-icon pi-agent-thread-menu",
      attr: {
        "aria-label": STRINGS.view.manageThreads,
        title: STRINGS.view.manageThreads
      }
    });
    (0, f.setIcon)(threadListButton, "list");
    threadListButton.addEventListener("click", (event) => {
      event.preventDefault();
      this.showThreadList();
    });
    this.messagesEl = root.createDiv({ cls: "pi-agent-messages" });
    this.messagesEl.addEventListener("scroll", () => {
      if (!this.messagesEl || this.isRenderingMessages) return;
      let distanceFromBottom =
        this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight;
      this.stickToBottom = distanceFromBottom < 40;
    });
    this.messagesEl.addEventListener("click", (event) => this.handleMessageLinkClick(event), true);
    let composer = root.createDiv({ cls: "pi-agent-composer" });
    this.toolBadgesEl = composer.createDiv({ cls: "pi-agent-tool-badges" });
    this.renderToolBadges();
    this.promptQueue = this.plugin.promptQueue.getItems();
    this.promptQueueEl = composer.createDiv({ cls: "pi-agent-prompt-queue" });
    this.renderPromptQueue();
    this.extensionWidgetsAboveEl = composer.createDiv({ cls: "pi-agent-extension-widgets" });
    this.renderComposerImages();
    this.inputEl = composer.createEl("textarea", {
      placeholder: STRINGS.view.inputPlaceholder
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (this.suggestions?.handleKeydown(event)) return;
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.submitInput();
      }
      if (event.key === "Escape") {
        this.syncCurrentRunFlags();
        if (this.running) {
          event.preventDefault();
          this.cancelCurrentRun();
        }
      }
    });
    this.inputEl.addEventListener("paste", (event) => this.handleImagePaste(event));
    this.inputEl.addEventListener("dragover", (event) => {
      if ((event.dataTransfer?.files?.length || 0) > 0) event.preventDefault();
    });
    this.inputEl.addEventListener("drop", (event) => this.handleImageDrop(event));
    this.inputEl.addEventListener("input", () => {
      this.syncCurrentRunFlags();
      this.resizeInput();
      this.suggestions?.update();
      this.setRunningState(this.running);
    });
    this.inputEl.addEventListener("click", () => {
      this.suggestions?.update();
    });
    this.inputEl.addEventListener("blur", () => {
      if (this.suggestionBlurTimer) window.clearTimeout(this.suggestionBlurTimer);
      this.suggestionBlurTimer = window.setTimeout(() => {
        this.suggestionBlurTimer = undefined;
        this.suggestions?.close();
      }, 120);
    });
    this.suggestions = new ComposerSuggestions(this.inputEl, this.plugin, () => this.resizeInput());
    this.extensionWidgetsBelowEl = composer.createDiv({ cls: "pi-agent-extension-widgets" });
    this.renderExtensionWidgets();
    this.resizeInput();
    this.imageInputEl = composer.createEl("input", {
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
    this.imageInputEl.addEventListener("change", () => {
      this.addLocalFiles(this.imageInputEl?.files);
      if (this.imageInputEl) this.imageInputEl.value = "";
    });
    let composerBar = composer.createDiv({ cls: "pi-agent-composer-bar" });
    this.composerBarEl = composerBar;
    this.runSettings = new RunSettingsControls(this.plugin);
    this.renderImagePicker(composerBar);
    this.runSettings.render(composerBar);
    let sendButton = composerBar.createEl("button", {
      cls: "clickable-icon pi-agent-send-button",
      attr: { "aria-label": STRINGS.view.sendMessage, title: STRINGS.view.sendMessage }
    });
    (0, f.setIcon)(sendButton, "send");
    sendButton.createSpan({ cls: "pi-agent-control-label", text: STRINGS.view.send });
    this.sendButtonEl = sendButton;
    sendButton.addEventListener("click", () => this.handleSendButtonClick());
    this.observeComposerBar(composerBar);
    this.restoreActiveRunUiState();
    this.renderMessages();
    this.setRunningState(this.running);
  }
  async onClose() {
    this.messagesEl = undefined;
    this.inputEl = undefined;
    this.promptQueueEl = undefined;
    this.extensionWidgetsAboveEl = undefined;
    this.extensionWidgetsBelowEl = undefined;
    this.composerImages = [];
    this.composerAttachments = [];
    this.excludedContextPath = undefined;
    this.pendingAnnotationSnapshots.clear();
    this.imageInputEl = undefined;
    this.sendButtonEl = undefined;
    this.composerBarEl = undefined;
    this.runSettings = undefined;
    this.toolBadgesEl = undefined;
    this.threadTitleEl = undefined;
    this.threadFavoriteEl = undefined;
    this.cleanupComposerBarObserver();
    this.clearPendingActivityTimer();
    this.clearStreamingRenderTimer();
    if (this.suggestionBlurTimer) window.clearTimeout(this.suggestionBlurTimer);
    this.suggestionBlurTimer = undefined;
    this.unloadMessageRenderComponents();
    this.messageActions = undefined;
    this.noteActions = undefined;
    this.threadMenu = undefined;
    this.suggestions?.close();
    this.suggestions = undefined;
  }
  refreshRunSettings() {
    this.runSettings?.refresh?.();
  }
  renderExtensionWidgets() {
    this.extensionWidgetsAboveEl?.empty();
    this.extensionWidgetsBelowEl?.empty();
    for (const [key, widget] of this.plugin.extensionWidgets ?? []) {
      const target =
        widget.placement === "belowEditor"
          ? this.extensionWidgetsBelowEl
          : this.extensionWidgetsAboveEl;
      if (!target) continue;
      const widgetEl = target.createDiv({ cls: "pi-agent-extension-widget" });
      widgetEl.setAttr("data-widget-key", key);
      for (const line of widget.lines) widgetEl.createDiv({ text: line });
    }
  }
  setExtensionEditorText(text) {
    if (!this.inputEl) return;
    this.inputEl.value = text;
    this.resizeInput();
    this.suggestions?.update();
    this.inputEl.focus();
  }
  renderToolBadges() {
    const root = this.toolBadgesEl;
    if (!root) return;
    root.empty();
    const badges = root.createDiv({
      cls: "pi-agent-context-badges",
      attr: { role: "list", "aria-label": STRINGS.view.pendingContext }
    });
    const contextFilePath = this.plugin.getCurrentContextPath();
    const includeActiveNote = this.resolveActiveNoteInclusion(contextFilePath);
    if (includeActiveNote && contextFilePath)
      this.renderPendingBadge(badges, noteTitleFromPath(contextFilePath), {
        title: contextFilePath,
        removeLabel: STRINGS.view.removeNote(noteTitleFromPath(contextFilePath)),
        onRemove: () => {
          this.excludedContextPath = contextFilePath;
          this.renderToolBadges();
        }
      });
    for (const image of this.composerImages)
      this.renderPendingBadge(badges, image.fileName || "image", {
        removeLabel: STRINGS.view.removePending(image.fileName || "image"),
        onRemove: () => {
          this.composerImages = this.composerImages.filter((item) => item.id !== image.id);
          this.renderComposerImages();
        }
      });
    for (const attachment of this.composerAttachments)
      this.renderPendingBadge(badges, attachment.fileName, {
        removeLabel: STRINGS.view.removePending(attachment.fileName),
        onRemove: () => {
          this.composerAttachments = this.composerAttachments.filter(
            (item) => item.id !== attachment.id
          );
          this.renderComposerImages();
        }
      });
    const annotations =
      includeActiveNote && contextFilePath ? this.plugin.annotationStore.list(contextFilePath) : [];
    if (annotations.length > 0) {
      const label = STRINGS.view.annotationsCount(annotations.length);
      this.renderPendingBadge(badges, label, {
        removeLabel: STRINGS.view.clearAnnotations(annotations.length),
        onRemove: () => {
          this.plugin.annotationController?.cancelPick();
          this.plugin.annotationStore.deletePath(contextFilePath);
          this.renderToolBadges();
        }
      });
    }
    this.renderToolBadgesContextUsage(root);
  }
  shouldIncludeActiveNote() {
    return this.resolveActiveNoteInclusion(this.plugin.getCurrentContextPath());
  }
  resolveActiveNoteInclusion(contextPath) {
    if (this.excludedContextPath && contextPath && this.excludedContextPath !== contextPath)
      this.excludedContextPath = undefined;
    return !!contextPath && this.excludedContextPath !== contextPath;
  }
  renderPendingBadge(parent, label, options = {}) {
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
    (0, f.setIcon)(remove, "x");
    remove.addEventListener("click", onRemove);
  }
  renderToolBadgesContextUsage(root) {
    let usage = this.getDisplayedContextUsage(),
      badge = usage?.compacted
        ? {
            label: STRINGS.view.compactionBadge(formatTokenCount(usage.contextWindow || 0)),
            title: STRINGS.view.compactionUnknownTitle
          }
        : usage
          ? formatContextUsageBadge(usage.contextUsage, usage.tokenUsage)
          : undefined;
    root.createSpan({
      cls: `pi-agent-tool-badge pi-agent-tool-badge-context${badge ? " is-enabled" : ""}`,
      text: badge ? badge.label : STRINGS.view.contextUsageEmpty,
      attr: {
        title: badge ? badge.title : STRINGS.view.contextUsagePendingTitle
      }
    });
  }
  getDisplayedContextUsage() {
    if (this.currentRunContextUsage) return this.currentRunContextUsage;
    const thread = this.plugin.threads.currentThread;
    if (this.invalidatedContextThreadIds.has(thread.id))
      return {
        compacted: true,
        contextWindow: this.plugin.models.getSelectedInfo()?.contextWindow
      };
    const messages = thread.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role === "assistant" && message.contextUsage)
        return { contextUsage: message.contextUsage, tokenUsage: message.tokenUsage };
    }
  }
  renderThreadTitle() {
    if (!this.threadTitleEl) return;
    let thread = this.plugin.threads.currentThread;
    this.threadTitleEl.empty();
    this.threadTitleEl.createSpan({ text: thread.title });
    this.renderThreadFavorite();
  }
  renderThreadFavorite() {
    if (!this.threadFavoriteEl) return;
    const favorite = this.plugin.threads.currentThread.favorite === true;
    this.threadFavoriteEl.toggleClass("is-favorite", favorite);
    this.threadFavoriteEl.setAttr("aria-pressed", String(favorite));
    const favoriteLabel = favorite ? STRINGS.threads.removeFavorite : STRINGS.threads.markFavorite;
    this.threadFavoriteEl.setAttr("aria-label", favoriteLabel);
    this.threadFavoriteEl.setAttr("title", favoriteLabel);
  }
  toggleCurrentThreadFavorite() {
    const thread = this.plugin.threads.currentThread;
    if (!this.plugin.threads.toggleThreadFavorite(thread.id)) {
      new f.Notice(STRINGS.view.threadNotFound);
      return;
    }
    this.renderThreadFavorite();
    this.renderThreadListIfVisible();
  }
  startThreadTitleRename() {
    if (!this.threadTitleEl?.isConnected) return;
    const thread = this.plugin.threads.currentThread;
    this.threadTitleEl.empty();
    this.threadTitleEl.addClass("is-editing");
    const input = this.threadTitleEl.createEl("input", {
      cls: "pi-agent-thread-title-input",
      attr: { type: "text", value: thread.title, "aria-label": STRINGS.view.chatTitle }
    });
    const commit = (save) => {
      const title = input.value.trim();
      this.threadTitleEl?.removeClass("is-editing");
      if (save && title && title !== thread.title)
        this.plugin.threads.renameThread(thread.id, title);
      this.renderThreadTitle();
    };
    const stopPropagation = (event) => {
      event.stopPropagation();
    };
    input.addEventListener(
      "keydown",
      (event) => {
        stopPropagation(event);
        if (event.key === "Enter") commit(true);
        if (event.key === "Escape") commit(false);
      },
      { capture: true }
    );
    input.addEventListener("keypress", stopPropagation, { capture: true });
    input.addEventListener("keyup", stopPropagation, { capture: true });
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("blur", () => commit(true));
    input.focus();
    input.select();
  }
  async submitInput() {
    const text = this.inputEl?.value.trim();
    const images = this.composerImages.map((image) => ({ ...image }));
    const attachments = this.composerAttachments.map((attachment) => ({ ...attachment }));
    const contextFilePath = this.plugin.getCurrentContextPath();
    const includeActiveNote = this.shouldIncludeActiveNote();
    if (!text && images.length === 0 && attachments.length === 0) return;
    if (images.length > 0) {
      try {
        await this.plugin.models.ensureLoaded();
      } catch (error) {
        new f.Notice(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    if (images.length > 0 && !modelSupportsImages(this.plugin.models.getSelectedInfo())) {
      new f.Notice(STRINGS.view.modelNoImage);
      return;
    }
    if (this.inputEl) this.inputEl.value = "";
    this.composerImages = [];
    this.composerAttachments = [];
    this.renderComposerImages();
    this.suggestions?.close();
    this.resizeInput();
    this.syncCurrentRunFlags();
    this.startPrompt(
      text,
      undefined,
      images,
      undefined,
      attachments,
      undefined,
      contextFilePath,
      includeActiveNote
    );
    this.setRunningState(this.running);
  }
  handleSendButtonClick() {
    this.syncCurrentRunFlags();
    if (
      this.running &&
      !this.inputEl?.value.trim() &&
      this.composerImages.length === 0 &&
      this.composerAttachments.length === 0
    ) {
      this.cancelCurrentRun();
      return;
    }
    this.submitInput();
  }
  cancelCurrentRun() {
    this.syncCurrentRunFlags();
    const run = this.getCurrentThreadRun();
    if (!this.runtime.requestCancel(run)) return;
    this.canceling = true;
    this.setActivity(STRINGS.view.canceling, "finishing");
    this.setRunningState(true);
    this.renderThreadListIfVisible();
  }
  cleanupComposerBarObserver() {
    if (this.composerBarCleanup) {
      this.composerBarCleanup();
      this.composerBarCleanup = undefined;
    }
  }
  observeComposerBar(barEl) {
    this.cleanupComposerBarObserver();
    const updateMode = () => this.updateComposerBarMode(barEl.clientWidth);
    updateMode();
    if (typeof ResizeObserver == "undefined") {
      window.addEventListener("resize", updateMode);
      let disconnected = false;
      const cleanup = () => {
        if (!disconnected) {
          disconnected = true;
          window.removeEventListener("resize", updateMode);
        }
      };
      this.composerBarCleanup = cleanup;
      this.register(cleanup);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? barEl.clientWidth;
      this.updateComposerBarMode(width);
    });
    let disconnected = false;
    const cleanup = () => {
      if (!disconnected) {
        disconnected = true;
        observer.disconnect();
      }
    };
    observer.observe(barEl);
    this.composerBarCleanup = cleanup;
    this.register(cleanup);
  }
  updateComposerBarMode(width) {
    let bar = this.composerBarEl;
    if (!bar) return;
    let isCompact = width < 560,
      isNarrow = width < 390;
    bar.toggleClass("is-compact", isCompact);
    bar.toggleClass("is-narrow", isNarrow);
  }
  renderImagePicker(parent) {
    const button = parent.createEl("button", {
      cls: "clickable-icon pi-agent-image-button",
      attr: { "aria-label": STRINGS.view.attachFiles, title: STRINGS.view.attachFiles }
    });
    f.setIcon(button, "paperclip");
    button.addEventListener("click", (event) => this.showAttachmentMenu(event));
  }
  showAttachmentMenu(event) {
    const menu = new f.Menu();
    menu.addItem((item) =>
      item
        .setTitle(STRINGS.view.vaultFile)
        .setIcon("vault")
        .onClick(() => this.showVaultFilePicker())
    );
    menu.addItem((item) =>
      item
        .setTitle(STRINGS.view.localFile)
        .setIcon("hard-drive")
        .onClick(() => this.imageInputEl?.click())
    );
    menu.showAtMouseEvent(event);
  }
  showVaultFilePicker() {
    const getAttachableFiles = () =>
      this.plugin.app.vault
        .getFiles()
        .filter((file) => this.isAttachableFile(file.name, mimeForName(file.name)));
    const addVaultFile = (file) => this.addVaultFile(file);
    class VaultFileModal extends f.FuzzySuggestModal {
      getItems() {
        return getAttachableFiles();
      }
      getItemText(file) {
        return file.path;
      }
      onChooseItem(file) {
        addVaultFile(file);
      }
    }
    const modal = new VaultFileModal(this.plugin.app);
    modal.setPlaceholder(STRINGS.view.chooseAttachable);
    modal.open();
  }
  isAttachableFile(name, mimeType) {
    return SUPPORTED_IMAGE_MIME_TYPES.includes(mimeType) || isSupportedTextFile(name, mimeType);
  }
  getImageFiles(files) {
    return [...(files || [])].filter((file) => SUPPORTED_IMAGE_MIME_TYPES.includes(file.type));
  }
  async addLocalFiles(files) {
    for (const file of [...(files || [])]) {
      try {
        if (SUPPORTED_IMAGE_MIME_TYPES.includes(file.type)) await this.addImageFiles([file]);
        else {
          const remaining =
            MAX_TOTAL_TEXT_ATTACHMENT_BYTES - textAttachmentBytes(this.composerAttachments);
          const bytes = new Uint8Array(
            await file.slice(0, Math.min(file.size, remaining + 4)).arrayBuffer()
          );
          const attachment = createPromptTextAttachment(
            {
              bytes,
              fileName: file.name,
              mimeType: file.type,
              source: "local",
              originalSize: file.size
            },
            remaining
          );
          this.composerAttachments.push(attachment);
        }
      } catch (error) {
        new f.Notice(error instanceof Error ? error.message : String(error));
      }
    }
    this.renderComposerImages();
    this.setRunningState(this.running);
  }
  async addVaultFile(file) {
    try {
      const mimeType = mimeForName(file.name);
      const bytes = new Uint8Array(await this.plugin.app.vault.readBinary(file));
      if (SUPPORTED_IMAGE_MIME_TYPES.includes(mimeType)) {
        await this.plugin.models.ensureLoaded();
        if (!modelSupportsImages(this.plugin.models.getSelectedInfo()))
          throw new Error(STRINGS.view.modelNoImage);
        this.composerImages.push(
          bytesToPromptImage({
            bytes,
            fileName: file.name,
            mimeType,
            source: "vault",
            path: file.path
          })
        );
      } else {
        this.composerAttachments.push(
          createPromptTextAttachment(
            { bytes, fileName: file.name, mimeType, source: "vault", path: file.path },
            MAX_TOTAL_TEXT_ATTACHMENT_BYTES - textAttachmentBytes(this.composerAttachments)
          )
        );
      }
      this.renderComposerImages();
      this.setRunningState(this.running);
    } catch (error) {
      new f.Notice(error instanceof Error ? error.message : String(error));
    }
  }
  async addImageFiles(files) {
    const imageFiles = [...(files || [])];
    if (imageFiles.length === 0) return;
    await this.plugin.models.ensureLoaded();
    if (!modelSupportsImages(this.plugin.models.getSelectedInfo())) {
      new f.Notice(STRINGS.view.modelNoImage);
      return;
    }
    try {
      const images = await Promise.all(imageFiles.map(fileToPromptImage));
      this.composerImages.push(...images);
      this.renderComposerImages();
      this.setRunningState(this.running);
    } catch (error) {
      new f.Notice(error instanceof Error ? error.message : String(error));
    }
  }
  handleImagePaste(event) {
    const files = this.getImageFiles(event.clipboardData?.files);
    if (files.length === 0) return;
    event.preventDefault();
    this.addImageFiles(files);
  }
  handleImageDrop(event) {
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length === 0) return;
    event.preventDefault();
    this.addLocalFiles(files);
  }
  renderComposerImages() {
    this.renderToolBadges();
  }
  resizeInput() {
    if (!this.inputEl) return;
    this.inputEl.setCssProps({ height: "auto" });
    this.inputEl.setCssProps({
      height: `${Math.min(Math.max(this.inputEl.scrollHeight, 64), 320)}px`
    });
  }
  getCurrentThreadId() {
    return this.plugin.threads.currentThreadId;
  }
  isCurrentThread(threadId) {
    return this.getCurrentThreadId() === threadId;
  }
  isThreadRunning(threadId) {
    return this.runtime.hasRun(threadId);
  }
  getCurrentThreadRun() {
    let threadId = this.getCurrentThreadId();
    return threadId ? this.runtime.getRun(threadId) : undefined;
  }
  syncCurrentRunFlags() {
    let run = this.getCurrentThreadRun();
    this.running = !!run;
    this.canceling = run?.canceling === true;
  }
  resetTransientRunUiState() {
    this.activityText = "";
    this.activityKind = "thinking";
    this.activityDetail = "";
    this.activityStickyUntil = 0;
    this.pendingActivity = undefined;
    this.clearPendingActivityTimer();
    this.clearStreamingRenderTimer();
    this.activeToolCalls.clear();
    this.currentRunContextUsage = undefined;
    this.streamingAssistantContent = "";
    this.streamingThinkingContent = "";
    this.thinkingDisclosureExpanded = false;
    this.thinkingDisclosureUserSet = false;
    this.streamingItemEl = undefined;
    this.streamingTextEl = undefined;
  }
  renderThreadListIfVisible() {
    if (this.showingThreadList) this.renderThreadList();
  }
  refreshLocalPromptQueue() {
    this.promptQueue = this.plugin.promptQueue.getItems();
    this.renderPromptQueue();
    this.setRunningState(this.running);
  }
  /**
   * @param {any} snapshot
   * @returns {() => void}
   */
  trackPendingAnnotationSnapshot(snapshot) {
    this.pendingAnnotationSnapshots.add(snapshot);
    return () => this.pendingAnnotationSnapshots.delete(snapshot);
  }
  /**
   * Snapshots of prompts that are still being prepared are not attached to a run
   * yet, but a rename or delete during delivery still has to reach them.
   *
   * @param {(snapshot: any) => void} callback
   */
  forEachAnnotationSnapshot(callback) {
    const seen = new Set();
    for (const snapshot of this.pendingAnnotationSnapshots) {
      if (seen.has(snapshot)) continue;
      seen.add(snapshot);
      callback(snapshot);
    }
    for (const run of this.runtime.listRuns()) {
      const snapshot = run.annotationSnapshot;
      if (!snapshot || seen.has(snapshot)) continue;
      seen.add(snapshot);
      callback(snapshot);
    }
  }
  migrateInFlightAnnotationPaths(oldPath, newPath) {
    if (!oldPath || !newPath || oldPath === newPath) return;
    this.forEachAnnotationSnapshot((snapshot) => {
      if (snapshot.sourcePath === oldPath) snapshot.sourcePath = newPath;
      snapshot.annotations = snapshot.annotations.map((annotation) =>
        annotation?.path === oldPath ? { ...annotation, path: newPath } : annotation
      );
    });
  }
  invalidateInFlightAnnotationPaths(path) {
    if (!path) return;
    this.forEachAnnotationSnapshot((snapshot) => {
      if (snapshot.sourcePath === path) snapshot.sourcePath = undefined;
      snapshot.annotations = snapshot.annotations.filter((annotation) => annotation?.path !== path);
    });
  }
  /**
   * A rename or delete can migrate the annotation snapshot while the context is
   * still being built. Rebuild the delivery once so the prompt keeps its note.
   *
   * @param {() => Promise<any>} buildDelivery
   * @param {any} annotationSnapshot
   */
  async buildDeliveryWithSnapshotRetry(buildDelivery, annotationSnapshot) {
    const releasePendingSnapshot = this.trackPendingAnnotationSnapshot(annotationSnapshot);
    try {
      const deliverySourcePath = annotationSnapshot.sourcePath;
      const delivery = await buildDelivery();
      if (
        annotationSnapshot.sourcePath !== deliverySourcePath &&
        !delivery.promptContext?.activeNote
      )
        return buildDelivery();
      return delivery;
    } finally {
      releasePendingSnapshot();
    }
  }
  /**
   * Returns a failed queued delivery to the pending queue so it can run again.
   *
   * @param {string | undefined} queuedId
   */
  requeueQueuedPrompt(queuedId) {
    if (!queuedId) return;
    this.promptQueue = this.promptQueue.map((item) =>
      item.id === queuedId ? { ...item, state: "pending" } : item
    );
    this.plugin.promptQueue.replace(this.promptQueue);
    this.renderPromptQueue();
  }
  restoreActiveRunUiState() {
    const run = this.getCurrentThreadRun();
    if (!run) return;
    this.streamingAssistantContent = run.assistantContent || "";
    this.streamingThinkingContent = run.thinking || "";
    this.thinkingDisclosureExpanded = run.thinkingExpanded === true;
    this.thinkingDisclosureUserSet = run.thinkingUserSet === true;
    this.currentRunContextUsage = run.contextUsage;
    if (run.activity) {
      this.activityText = run.activity.text;
      this.activityKind = run.activity.kind;
      this.activityDetail = run.activity.detail;
      this.activityStickyUntil = run.activity.stickyUntil ?? 0;
    }
    this.activeToolCalls = new Map(run.activeToolCalls ?? []);
    if (this.activeToolCalls.size > 0) {
      const status = this.formatActiveToolStatus();
      this.activityText = status.label;
      this.activityKind = status.kind;
      this.activityDetail = status.detail;
      this.activityStickyUntil = 0;
    }
  }
  runAnnotationPrompt(prompt, sourcePath) {
    return this.runPrompt(prompt, undefined, [], undefined, [], undefined, sourcePath, true);
  }
  startPrompt(...args) {
    void this.runPrompt(...args).catch((error) => {
      new f.Notice(error instanceof Error ? error.message : String(error));
    });
  }
  async runPrompt(
    prompt,
    threadId = this.plugin.threads.currentThreadId,
    images = [],
    queuedId,
    attachments = [],
    annotations,
    annotationSourcePath,
    includeActiveNote
  ) {
    const prepared = await this.preparePromptPayload({
      prompt,
      threadId,
      images,
      queuedId,
      attachments,
      annotations,
      annotationSourcePath,
      includeActiveNote
    });
    if (!prepared) return;
    await this.executePromptRun(prepared);
  }
  /**
   * Resolves the annotations, builds the pre-attached context, and returns the
   * payload a run needs. Returns undefined when the prompt was queued, rolled
   * back, or rejected; every bail-out path already reported itself.
   *
   * @param {any} request
   * @returns {Promise<any>}
   */
  async preparePromptPayload(request) {
    let prompt = request.prompt;
    let images = request.images || [];
    let attachments = request.attachments || [];
    const threadId = request.threadId;
    const queuedId = request.queuedId;
    const annotationSourcePath = request.annotationSourcePath;
    let annotations = request.annotations;
    let includeActiveNote = request.includeActiveNote;
    if (includeActiveNote === undefined) includeActiveNote = this.shouldIncludeActiveNote();
    if (annotations === undefined) {
      try {
        annotations = await this.plugin.consumeAnnotationsForPrompt(annotationSourcePath);
      } catch (error) {
        new f.Notice(error instanceof Error ? error.message : String(error));
        return undefined;
      }
    }
    const annotationSnapshot = { annotations, sourcePath: annotationSourcePath };
    const restoreUnsentAnnotations = () => {
      const unsent = annotationSnapshot.annotations;
      if (!queuedId && unsent.length > 0) this.plugin.restoreConsumedAnnotations(unsent);
    };
    const enqueueWhileRunning = () =>
      this.enqueuePrompt(
        prompt,
        threadId,
        images,
        attachments,
        annotationSnapshot.annotations,
        annotationSnapshot.sourcePath,
        includeActiveNote
      );
    if (this.isThreadRunning(threadId)) {
      if (queuedId) {
        this.requeueQueuedPrompt(queuedId);
      } else {
        enqueueWhileRunning();
      }
      return undefined;
    }
    const buildDelivery = () =>
      this.plugin.enrichPromptDelivery(
        {
          prompt,
          images,
          attachments,
          annotations: annotationSnapshot.annotations,
          contextFilePath: annotationSnapshot.sourcePath,
          includeActiveNote
        },
        { mode: "prompt", threadId: threadId }
      );
    let delivery;
    try {
      delivery = await this.buildDeliveryWithSnapshotRetry(buildDelivery, annotationSnapshot);
    } catch (error) {
      if (queuedId) {
        this.requeueQueuedPrompt(queuedId);
      } else restoreUnsentAnnotations();
      new f.Notice(error instanceof Error ? error.message : String(error));
      return undefined;
    }
    prompt = String(delivery.prompt || "").trim();
    images = delivery.images || [];
    attachments = delivery.attachments || [];
    if (delivery.promptContext && attachments.length > 0)
      delivery.promptContext.fileAttachmentsContext = appendTextAttachmentContext("", attachments);
    if (!prompt && images.length === 0 && attachments.length === 0) {
      if (queuedId) {
        this.requeueQueuedPrompt(queuedId);
        new f.Notice(STRINGS.view.queuedEmpty);
      } else restoreUnsentAnnotations();
      return undefined;
    }
    if (images.length > 0) await this.plugin.models.ensureLoaded();
    if (images.length > 0 && !modelSupportsImages(this.plugin.models.getSelectedInfo())) {
      if (queuedId) {
        this.requeueQueuedPrompt(queuedId);
      } else restoreUnsentAnnotations();
      new f.Notice(STRINGS.view.modelNoImage);
      return undefined;
    }
    if (this.isThreadRunning(threadId)) {
      if (queuedId) {
        this.requeueQueuedPrompt(queuedId);
      } else {
        enqueueWhileRunning();
      }
      return undefined;
    }
    return {
      prompt,
      threadId,
      images,
      attachments,
      queuedId,
      annotationSnapshot,
      restoreUnsentAnnotations,
      delivery
    };
  }
  /**
   * Streams one prepared prompt through Pi and settles the run.
   *
   * @param {any} prepared
   */
  async executePromptRun(prepared) {
    const { threadId, queuedId, annotationSnapshot, restoreUnsentAnnotations, delivery } = prepared;
    const prompt = prepared.prompt;
    const images = prepared.images;
    const attachments = prepared.attachments;
    // Assigned by runtime.onStarted before any event can reach this view. It
    // stays loosely typed until the run record is typed end to end (Phase 9).
    /** @type {any} */
    let run;
    const presentation = {
      accepted: false,
      notificationRunId: `${threadId}:${this.nextDesktopNotificationRunId++}`,
      skillName: getSkillCommandName(prompt),
      assistantContent: "",
      annotationSnapshot,
      activeToolCalls: new Map(),
      thinking: "",
      thinkingExpanded: false,
      thinkingUserSet: false,
      toolErrors: /** @type {string[]} */ ([])
    };
    let skipQueueDrain = false;
    const addUserMessage = () => {
      if (run.userMessageAdded) return;
      run.userMessageAdded = true;
      this.plugin.threads.addMessageToThread(threadId, {
        role: "user",
        content: prompt || conciseAttachmentSummary(images, attachments),
        createdAt: Date.now()
      });
      if (this.isCurrentThread(threadId)) {
        this.renderThreadTitle();
        this.renderMessages();
      }
    };
    const acknowledgeQueuedDelivery = () => {
      addUserMessage();
      if (run.accepted) return;
      run.accepted = true;
      if (!queuedId) return;
      this.promptQueue = this.promptQueue.filter((item) => item.id !== queuedId);
      this.plugin.promptQueue.replace(this.promptQueue);
      this.renderPromptQueue();
    };
    try {
      const { result } = await this.runtime.startPrompt(
        { threadId, prompt, images, promptContext: delivery.promptContext },
        {
          onStarted: (startedRun) => {
            Object.assign(startedRun, presentation);
            run = startedRun;
            this.applyRunStartUiState(threadId);
            this.plugin.beginAnnotationProcessing(threadId, annotationSnapshot.annotations);
            this.setRunningState(this.running);
            if (!queuedId) addUserMessage();
            this.renderThreadListIfVisible();
          },
          onEvent: (event) => this.handleRunStreamEvent(run, threadId, event),
          onTextDelta: (delta) => this.handleRunStreamDelta(run, threadId, delta),
          onPromptAccepted: acknowledgeQueuedDelivery
        }
      );
      acknowledgeQueuedDelivery();
      const createdAt = Date.now();
      const thinkingKey = `${threadId}:${createdAt}`;
      this.completedThinkingExpansion.set(
        thinkingKey,
        run.thinkingUserSet ? run.thinkingExpanded : false
      );
      const runMetadata = getCurrentRunMetadata(this.plugin.settings, result.runtimeState);
      this.streamingAssistantContent = "";
      this.streamingThinkingContent = "";
      this.streamingItemEl = undefined;
      this.streamingTextEl = undefined;
      this.plugin.threads.addMessageToThread(threadId, {
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
        this.invalidatedContextThreadIds.delete(threadId);
      if (result.contextCompacted) this.invalidatedContextThreadIds.add(threadId);
      if (this.isCurrentThread(threadId)) {
        this.renderThreadTitle();
        this.renderMessages();
        this.renderToolBadges();
      }
      this.notifyRunCompleted(run.notificationRunId, threadId);
    } catch (error) {
      // Start-up failures (no runner, runtime busy) happen before a run record exists.
      if (!run) throw error;
      let message = error instanceof Error ? error.message : String(error);
      if (queuedId && !run.accepted) {
        this.requeueQueuedPrompt(queuedId);
        skipQueueDrain = true;
      } else if (!run.accepted) restoreUnsentAnnotations();
      if (isPiRunCanceled(error)) {
        new f.Notice(STRINGS.view.runCanceled);
        return;
      }
      const createdAt = Date.now();
      this.completedThinkingExpansion.set(
        `${threadId}:${createdAt}`,
        run.thinkingUserSet ? run.thinkingExpanded : false
      );
      this.plugin.threads.addMessageToThread(threadId, {
        role: "assistant",
        content: `${STRINGS.view.runFailed}：${message}`,
        createdAt,
        thinking: run.thinking || undefined,
        toolErrors: run.toolErrors.length > 0 ? run.toolErrors : undefined
      });
      if (this.isCurrentThread(threadId)) {
        this.renderThreadTitle();
        this.renderMessages();
        this.renderToolBadges();
      }
      new f.Notice(message);
      this.notifyRunCompleted(run.notificationRunId, threadId, STRINGS.view.notificationFailed);
    } finally {
      if (run) {
        this.syncCurrentRunFlags();
        this.running = this.isThreadRunning(this.plugin.threads.currentThreadId);
        this.canceling = this.getCurrentThreadRun()?.canceling === true;
        this.streamingAssistantContent = "";
        this.streamingThinkingContent = "";
        this.thinkingDisclosureExpanded = false;
        this.thinkingDisclosureUserSet = false;
        this.activityStickyUntil = 0;
        this.pendingActivity = undefined;
        this.clearPendingActivityTimer();
        this.clearStreamingRenderTimer();
        this.activeToolCalls.clear();
        this.activityText = "";
        this.activityDetail = "";
        this.currentRunContextUsage = undefined;
        if (this.isCurrentThread(threadId)) this.nativePiQueue = undefined;
        this.renderPromptQueue();
        this.setRunningState(this.running);
        if (this.isCurrentThread(threadId)) {
          this.renderMessages();
          this.renderToolBadges();
        }
        this.renderThreadListIfVisible();
        this.plugin.endAnnotationProcessingForThread(threadId);
        this.plugin.rebuildServicesIfPending();
        if (!skipQueueDrain) this.runNextQueuedPrompt();
      }
    }
  }
  /**
   * Resets the transient per-run UI state before a run starts streaming.
   *
   * @param {string} threadId
   */
  applyRunStartUiState(threadId) {
    this.syncCurrentRunFlags();
    this.running = this.isCurrentThread(threadId);
    this.canceling = false;
    this.activityText = STRINGS.view.preparingContext;
    this.activityKind = "context";
    this.activityDetail = STRINGS.view.collectingContext;
    this.activityStickyUntil = 0;
    this.pendingActivity = undefined;
    this.clearPendingActivityTimer();
    this.clearStreamingRenderTimer();
    this.activeToolCalls.clear();
    this.currentRunContextUsage = undefined;
    this.streamingAssistantContent = "";
    this.streamingThinkingContent = "";
    this.thinkingDisclosureExpanded = false;
    this.thinkingDisclosureUserSet = false;
    this.stickToBottom = true;
  }
  /**
   * @param {any} run
   * @param {string} threadId
   * @param {any} event
   */
  handleRunStreamEvent(run, threadId, event) {
    const thinkingDelta = getThinkingDelta(event);
    if (thinkingDelta) {
      run.thinking += thinkingDelta;
      if (!run.thinkingUserSet) run.thinkingExpanded = true;
    }
    const toolError = formatToolError(event);
    if (toolError && run.toolErrors[run.toolErrors.length - 1] !== toolError)
      run.toolErrors.push(toolError);
    const eventType = this.normalizeRunEventType(event.type);
    if (eventType === "tool_start" || eventType === "tool_update")
      this.trackActiveTool(event, run.activeToolCalls);
    else if (eventType === "tool_end") this.untrackActiveTool(event, run.activeToolCalls);
    this.handleSuccessfulToolMutation(event, threadId);
    if (!this.isCurrentThread(threadId)) return;
    this.streamingThinkingContent = run.thinking;
    this.thinkingDisclosureExpanded = run.thinkingExpanded;
    this.thinkingDisclosureUserSet = run.thinkingUserSet;
    this.handleRunEvent(event, threadId);
    this.syncRunActivity(threadId);
    this.syncRunContextUsage(threadId);
    if (thinkingDelta) {
      this.liveThinkingSetExpanded?.(run.thinkingExpanded);
      this.appendStreamingThinkingDelta(thinkingDelta);
    }
  }
  /**
   * @param {any} run
   * @param {string} threadId
   * @param {string} delta
   */
  handleRunStreamDelta(run, threadId, delta) {
    if (!run.thinkingUserSet) run.thinkingExpanded = false;
    run.assistantContent += delta;
    if (!this.isCurrentThread(threadId)) return;
    this.thinkingDisclosureExpanded = run.thinkingExpanded;
    this.liveThinkingSetExpanded?.(run.thinkingExpanded);
    this.appendStreamingDelta(delta);
  }
  notifyRunCompleted(runId, threadId, body = STRINGS.view.notificationCompleted) {
    if (!this.plugin.settings.desktopNotifications) return false;
    return showDesktopRunNotification({
      runId,
      sentRunIds: this.desktopNotificationRunIds,
      body,
      onClick: () => openNotificationThread(this.plugin, threadId, PI_AGENT_VIEW_TYPE)
    });
  }
  handleSuccessfulToolMutation(event, threadId) {
    const path = getSuccessfulMarkdownMutationPath(event, this.plugin.getVaultBasePath());
    if (!path) return;
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof f.TFile) || file.extension !== "md") return;
    this.plugin.completeAnnotationProcessingForPath(threadId, file.path);
    void refreshOpenMarkdownViews(this.plugin.app, file).catch((error) => {
      console.warn("Pi Agent: failed to refresh an externally changed Markdown file", error);
    });
  }
  appendStreamingThinkingDelta(delta) {
    if (!delta) return;
    this.scheduleStreamingRender();
  }
  setLiveThinkingExpanded(expanded) {
    const run = this.getCurrentThreadRun();
    this.thinkingDisclosureExpanded = expanded;
    this.thinkingDisclosureUserSet = true;
    if (run) {
      run.thinkingExpanded = expanded;
      run.thinkingUserSet = true;
    }
  }
  appendStreamingDelta(delta) {
    if (!delta) return;
    this.activityText = "Responding";
    this.activityKind = "answer";
    this.activityDetail = "";
    this.activityStickyUntil = 0;
    this.pendingActivity = undefined;
    this.clearPendingActivityTimer();
    this.streamingAssistantContent += delta;
    this.updateActivityDom();
    this.scheduleStreamingRender();
  }
  setRunningState(running) {
    const hasInput =
      !!this.inputEl?.value.trim() ||
      this.composerImages.length > 0 ||
      this.composerAttachments.length > 0;
    const action = getSendActionState({
      running,
      canceling: this.canceling,
      hasInput,
      queuedCount: this.promptQueue.length
    });
    if (!this.sendButtonEl) return;
    this.sendButtonEl.empty();
    (0, f.setIcon)(this.sendButtonEl, action.icon);
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
  renderPiIcon(element) {
    (0, f.setIcon)(element, PI_AGENT_ICON_ID);
  }
}

function noteTitleFromPath(path) {
  const name =
    String(path ?? "")
      .split("/")
      .pop() ?? "";
  return name.replace(/\.md$/i, "") || name;
}
function mimeForName(name) {
  const extension = String(name || "")
    .toLowerCase()
    .split(".")
    .pop();
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      md: "text/markdown",
      txt: "text/plain",
      csv: "text/csv",
      json: "application/json",
      yaml: "application/yaml",
      yml: "application/yaml",
      xml: "application/xml",
      html: "text/html",
      css: "text/css",
      js: "text/javascript",
      mjs: "text/javascript",
      ts: "text/typescript",
      py: "text/x-python"
    }[extension] || ""
  );
}
function conciseAttachmentSummary(images, attachments) {
  const count = images.length + attachments.length;
  return `[${count} attached file${count === 1 ? "" : "s"}]`;
}

Object.assign(
  PiAgentView.prototype,
  promptQueueMethods,
  threadListMethods,
  vaultLinkMethods,
  messageRendererMethods,
  runActivityMethods
);
