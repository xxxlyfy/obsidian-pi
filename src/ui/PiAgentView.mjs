import * as f from "obsidian";
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
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.running = false;
    this.canceling = false;
    this.composerBarExpanded = false;
    this.activityText = "Thinking";
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
    this.promptQueue = this.plugin.getLocalPromptQueue();
    this.composerImages = [];
    this.composerAttachments = [];
    this.nativePiQueue = undefined;
    this.steeringPromptIds = new Set();
    this.streamingThinkingContent = "";
    this.thinkingDisclosureExpanded = false;
    this.thinkingDisclosureUserSet = false;
    this.completedThinkingExpansion = new Map();
    this.messageRenderComponents = [];
    this.messageRenderComponentByElement = new WeakMap();
    this.activeRuns = new Map();
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
      attr: { role: "button", tabindex: "0", title: "Rename chat" }
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
        attr: { "aria-label": "New chat", title: "New chat" }
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
      attr: { "aria-label": "Fork chat", title: "Fork chat" }
    });
    (0, f.setIcon)(forkButton, "split");
    forkButton.addEventListener("click", (event) => {
      event.preventDefault();
      if (this.isThreadRunning(this.plugin.getCurrentThread().id)) {
        new f.Notice("Wait for this chat's agent run to finish before forking it.");
        return;
      }
      this.threadMenu?.forkChat();
      this.renderToolBadges();
    });
    let threadListButton = headerActions.createEl("button", {
      cls: "clickable-icon pi-agent-thread-menu",
      attr: {
        "aria-label": "Manage chat threads",
        title: "Manage chat threads"
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
    this.promptQueue = this.plugin.getLocalPromptQueue();
    this.promptQueueEl = composer.createDiv({ cls: "pi-agent-prompt-queue" });
    this.renderPromptQueue();
    this.extensionWidgetsAboveEl = composer.createDiv({ cls: "pi-agent-extension-widgets" });
    this.renderComposerImages();
    this.inputEl = composer.createEl("textarea", {
      placeholder: "Ask the agent about your vault... Enter sends, Shift+Enter adds a line."
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
      attr: { "aria-label": "Send message", title: "Send message" }
    });
    (0, f.setIcon)(sendButton, "send");
    sendButton.createSpan({ cls: "pi-agent-control-label", text: "Send" });
    this.sendButtonEl = sendButton;
    sendButton.addEventListener("click", () => this.handleSendButtonClick());
    this.observeComposerBar(composerBar);
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
    this.imageInputEl = undefined;
    this.sendButtonEl = undefined;
    this.composerBarEl = undefined;
    this.composerBarExpandEl = undefined;
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
      attr: { role: "list", "aria-label": "Pending prompt context" }
    });
    const contextFile = this.plugin.getCurrentContextFile();
    if (contextFile) this.renderPendingBadge(badges, contextFile.name, { title: contextFile.path });
    for (const image of this.composerImages)
      this.renderPendingBadge(badges, image.fileName || "image", {
        removeLabel: `Remove ${image.fileName || "image"}`,
        onRemove: () => {
          this.composerImages = this.composerImages.filter((item) => item.id !== image.id);
          this.renderComposerImages();
        }
      });
    for (const attachment of this.composerAttachments)
      this.renderPendingBadge(badges, attachment.fileName, {
        removeLabel: `Remove ${attachment.fileName}`,
        onRemove: () => {
          this.composerAttachments = this.composerAttachments.filter(
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
            label: `ctx compacted · ?/${formatTokenCount(usage.contextWindow || 0)}`,
            title:
              "Pi compacted this session. Exact context usage is unknown until the next model response returns fresh token usage."
          }
        : usage
          ? formatContextUsageBadge(usage.contextUsage, usage.tokenUsage)
          : undefined;
    root.createSpan({
      cls: `pi-agent-tool-badge pi-agent-tool-badge-context${badge ? " is-enabled" : ""}`,
      text: badge ? badge.label : "ctx --",
      attr: {
        title: badge
          ? badge.title
          : "Context usage appears after Pi returns token usage for the selected model."
      }
    });
  }
  getDisplayedContextUsage() {
    if (this.currentRunContextUsage) return this.currentRunContextUsage;
    const thread = this.plugin.getCurrentThread();
    if (this.invalidatedContextThreadIds.has(thread.id))
      return { compacted: true, contextWindow: this.plugin.getSelectedModelInfo()?.contextWindow };
    const messages = thread.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role === "assistant" && message.contextUsage)
        return { contextUsage: message.contextUsage, tokenUsage: message.tokenUsage };
    }
  }
  renderThreadTitle() {
    if (!this.threadTitleEl) return;
    let thread = this.plugin.getCurrentThread();
    this.threadTitleEl.empty();
    this.threadTitleEl.createSpan({ text: thread.title });
    this.renderThreadFavorite();
  }
  renderThreadFavorite() {
    if (!this.threadFavoriteEl) return;
    const favorite = this.plugin.getCurrentThread().favorite === true;
    this.threadFavoriteEl.toggleClass("is-favorite", favorite);
    this.threadFavoriteEl.setAttr("aria-pressed", String(favorite));
    this.threadFavoriteEl.setAttr("aria-label", favorite ? "Remove favorite" : "Mark as favorite");
    this.threadFavoriteEl.setAttr("title", favorite ? "Remove favorite" : "Mark as favorite");
  }
  toggleCurrentThreadFavorite() {
    const thread = this.plugin.getCurrentThread();
    if (!this.plugin.toggleThreadFavorite(thread.id)) {
      new f.Notice("Chat thread was not found.");
      return;
    }
    this.renderThreadFavorite();
    this.renderThreadListIfVisible();
  }
  startThreadTitleRename() {
    if (!this.threadTitleEl?.isConnected) return;
    const thread = this.plugin.getCurrentThread();
    this.threadTitleEl.empty();
    this.threadTitleEl.addClass("is-editing");
    const input = this.threadTitleEl.createEl("input", {
      cls: "pi-agent-thread-title-input",
      attr: { type: "text", value: thread.title, "aria-label": "Chat title" }
    });
    const commit = (save) => {
      const title = input.value.trim();
      this.threadTitleEl?.removeClass("is-editing");
      if (save && title && title !== thread.title) this.plugin.renameThread(thread.id, title);
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
    const contextFilePath = this.plugin.getCurrentContextFile()?.path;
    if (!text && images.length === 0 && attachments.length === 0) return;
    if (images.length > 0) {
      try {
        await this.plugin.ensureModelCatalogLoaded();
      } catch (error) {
        new f.Notice(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    if (images.length > 0 && !modelSupportsImages(this.plugin.getSelectedModelInfo())) {
      new f.Notice("The selected Pi model does not support image input.");
      return;
    }
    if (this.inputEl) this.inputEl.value = "";
    this.composerImages = [];
    this.composerAttachments = [];
    this.renderComposerImages();
    this.suggestions?.close();
    this.resizeInput();
    this.syncCurrentRunFlags();
    this.startPrompt(text, undefined, images, undefined, attachments, undefined, contextFilePath);
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
    let run = this.getCurrentThreadRun();
    if (run && !run.canceling) {
      run.canceling = true;
      this.canceling = true;
      this.setActivity("Canceling", "finishing");
      this.plugin.cancelPiRun(run.runner);
      this.setRunningState(true);
      this.renderThreadListIfVisible();
    }
  }
  finishCanceledRun() {
    this.running = false;
    this.canceling = false;
    this.streamingAssistantContent = "";
    this.streamingThinkingContent = "";
    this.thinkingDisclosureExpanded = false;
    this.thinkingDisclosureUserSet = false;
    this.streamingItemEl = undefined;
    this.streamingTextEl = undefined;
    this.activityText = "";
    this.activityDetail = "";
    this.activityStickyUntil = 0;
    this.pendingActivity = undefined;
    this.clearPendingActivityTimer();
    this.clearStreamingRenderTimer();
    this.activeToolCalls.clear();
    this.currentRunContextUsage = undefined;
    if (this.runningThreadId) this.plugin.endAnnotationProcessingForThread(this.runningThreadId);
    this.runningThreadId = undefined;
    this.plugin.cancelPiRun();
    this.renderPromptQueue();
    this.setRunningState(false);
    this.renderMessages();
    this.renderToolBadges();
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
    if (!isCompact && this.composerBarExpanded) this.composerBarExpanded = false;
    bar.toggleClass("is-compact", isCompact);
    bar.toggleClass("is-narrow", isNarrow);
    this.updateComposerBarExpansion();
  }
  updateComposerBarExpansion() {
    let bar = this.composerBarEl,
      expandButton = this.composerBarExpandEl;
    if (!bar || !expandButton) return;
    let expanded = this.composerBarExpanded && bar.hasClass("is-compact");
    bar.toggleClass("is-expanded", expanded);
    expandButton.setAttr("aria-label", expanded ? "Collapse run options" : "Expand run options");
    expandButton.setAttr("title", expanded ? "Collapse run options" : "Expand run options");
    (0, f.setIcon)(expandButton, expanded ? "chevrons-right" : "chevrons-left");
  }
  renderImagePicker(parent) {
    const button = parent.createEl("button", {
      cls: "clickable-icon pi-agent-image-button",
      attr: { "aria-label": "Attach files", title: "Attach files" }
    });
    f.setIcon(button, "paperclip");
    button.addEventListener("click", (event) => this.showAttachmentMenu(event));
  }
  showAttachmentMenu(event) {
    const menu = new f.Menu();
    menu.addItem((item) =>
      item
        .setTitle("Vault file")
        .setIcon("vault")
        .onClick(() => this.showVaultFilePicker())
    );
    menu.addItem((item) =>
      item
        .setTitle("Local file")
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
    modal.setPlaceholder("Choose a vault image, text, code, or config file…");
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
        await this.plugin.ensureModelCatalogLoaded();
        if (!modelSupportsImages(this.plugin.getSelectedModelInfo()))
          throw new Error("The selected Pi model does not support image input.");
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
    await this.plugin.ensureModelCatalogLoaded();
    if (!modelSupportsImages(this.plugin.getSelectedModelInfo())) {
      new f.Notice("The selected Pi model does not support image input.");
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
    return this.plugin.getCurrentThread()?.id;
  }
  isCurrentThread(threadId) {
    return this.getCurrentThreadId() === threadId;
  }
  isThreadRunning(threadId) {
    return this.activeRuns.has(threadId);
  }
  getCurrentThreadRun() {
    let threadId = this.getCurrentThreadId();
    return threadId ? this.activeRuns.get(threadId) : undefined;
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
  runAnnotationPrompt(prompt, sourcePath) {
    return this.runPrompt(prompt, undefined, [], undefined, [], undefined, sourcePath);
  }
  startPrompt(...args) {
    void this.runPrompt(...args).catch((error) => {
      new f.Notice(error instanceof Error ? error.message : String(error));
    });
  }
  async runPrompt(
    prompt,
    threadId = this.plugin.getCurrentThread().id,
    images = [],
    queuedId,
    attachments = [],
    annotations,
    annotationSourcePath
  ) {
    if (annotations === undefined) {
      try {
        annotations = await this.plugin.consumeAnnotationsForPrompt(annotationSourcePath);
      } catch (error) {
        new f.Notice(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    const restoreUnsentAnnotations = () => {
      if (!queuedId && annotations.length > 0) this.plugin.restoreConsumedAnnotations(annotations);
    };
    if (this.isThreadRunning(threadId)) {
      if (queuedId) {
        this.promptQueue = this.promptQueue.map((item) =>
          item.id === queuedId ? { ...item, state: "pending" } : item
        );
        this.plugin.replaceLocalPromptQueue(this.promptQueue);
        this.renderPromptQueue();
      } else {
        this.enqueuePrompt(
          prompt,
          threadId,
          images,
          attachments,
          annotations,
          annotationSourcePath
        );
      }
      return;
    }
    let delivery;
    try {
      delivery = await this.plugin.enrichPromptDelivery(
        {
          prompt,
          images,
          attachments,
          annotations,
          contextFilePath: annotationSourcePath
        },
        { mode: "prompt", threadId: threadId }
      );
    } catch (error) {
      if (queuedId) {
        this.promptQueue = this.promptQueue.map((item) =>
          item.id === queuedId ? { ...item, state: "pending" } : item
        );
        this.plugin.replaceLocalPromptQueue(this.promptQueue);
        this.renderPromptQueue();
      } else restoreUnsentAnnotations();
      new f.Notice(error instanceof Error ? error.message : String(error));
      return;
    }
    prompt = String(delivery.prompt || "").trim();
    images = delivery.images || [];
    attachments = delivery.attachments || [];
    if (delivery.promptContext && attachments.length > 0)
      delivery.promptContext.fileAttachmentsContext = appendTextAttachmentContext("", attachments);
    if (!prompt && images.length === 0 && attachments.length === 0) {
      if (queuedId) {
        this.promptQueue = this.promptQueue.map((item) =>
          item.id === queuedId ? { ...item, state: "pending" } : item
        );
        this.plugin.replaceLocalPromptQueue(this.promptQueue);
        this.renderPromptQueue();
        new f.Notice("The queued message became empty and was not sent.");
      } else restoreUnsentAnnotations();
      return;
    }
    if (images.length > 0) await this.plugin.ensureModelCatalogLoaded();
    if (images.length > 0 && !modelSupportsImages(this.plugin.getSelectedModelInfo())) {
      if (queuedId) {
        this.promptQueue = this.promptQueue.map((item) =>
          item.id === queuedId ? { ...item, state: "pending" } : item
        );
        this.plugin.replaceLocalPromptQueue(this.promptQueue);
        this.renderPromptQueue();
      } else restoreUnsentAnnotations();
      new f.Notice("The selected Pi model does not support image input.");
      return;
    }
    if (this.isThreadRunning(threadId)) {
      if (queuedId) {
        this.promptQueue = this.promptQueue.map((item) =>
          item.id === queuedId ? { ...item, state: "pending" } : item
        );
        this.plugin.replaceLocalPromptQueue(this.promptQueue);
        this.renderPromptQueue();
      } else {
        this.enqueuePrompt(
          prompt,
          threadId,
          images,
          attachments,
          annotations,
          annotationSourcePath
        );
      }
      return;
    }
    let run = {
      canceling: false,
      runner: this.plugin.createPiRunner(threadId),
      accepted: false,
      notificationRunId: `${threadId}:${this.nextDesktopNotificationRunId++}`,
      skillName: getSkillCommandName(prompt),
      thinking: "",
      thinkingExpanded: false,
      thinkingUserSet: false,
      toolErrors: []
    };
    let skipQueueDrain = false;
    const addUserMessage = () => {
      if (run.userMessageAdded) return;
      run.userMessageAdded = true;
      this.plugin.addMessageToThread(threadId, {
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
      this.plugin.replaceLocalPromptQueue(this.promptQueue);
      this.renderPromptQueue();
    };
    this.activeRuns.set(threadId, run);
    this.syncCurrentRunFlags();
    this.runningThreadId = threadId;
    this.running = this.isCurrentThread(threadId);
    this.canceling = false;
    this.activityText = "Preparing context";
    this.activityKind = "context";
    this.activityDetail = "Collecting current note, links, backlinks, and explicit attachments.";
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
    this.plugin.beginAnnotationProcessing(threadId, annotations);
    this.setRunningState(this.running);
    if (!queuedId) addUserMessage();
    this.renderThreadListIfVisible();
    try {
      let result = await this.plugin.runPiPrompt(
        prompt,
        {
          isCanceled: () => run.canceling,
          onEvent: (event) => {
            const thinkingDelta = getThinkingDelta(event);
            if (thinkingDelta) {
              run.thinking += thinkingDelta;
              if (!run.thinkingUserSet) run.thinkingExpanded = true;
            }
            const toolError = formatToolError(event);
            if (toolError && run.toolErrors[run.toolErrors.length - 1] !== toolError)
              run.toolErrors.push(toolError);
            this.handleSuccessfulToolMutation(event, threadId);
            if (!this.isCurrentThread(threadId)) return;
            this.streamingThinkingContent = run.thinking;
            this.thinkingDisclosureExpanded = run.thinkingExpanded;
            this.thinkingDisclosureUserSet = run.thinkingUserSet;
            this.handleRunEvent(event);
            if (thinkingDelta) {
              this.liveThinkingSetExpanded?.(run.thinkingExpanded);
              this.appendStreamingThinkingDelta(thinkingDelta);
            }
          },
          onTextDelta: (delta) => {
            if (!run.thinkingUserSet) run.thinkingExpanded = false;
            if (!this.isCurrentThread(threadId)) return;
            this.thinkingDisclosureExpanded = run.thinkingExpanded;
            this.liveThinkingSetExpanded?.(run.thinkingExpanded);
            this.appendStreamingDelta(delta);
          },
          onPromptAccepted: acknowledgeQueuedDelivery
        },
        threadId,
        run.runner,
        images,
        delivery.promptContext
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
      this.plugin.addMessageToThread(threadId, {
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
      let message = error instanceof Error ? error.message : String(error);
      if (queuedId && !run.accepted) {
        this.promptQueue = this.promptQueue.map((item) =>
          item.id === queuedId ? { ...item, state: "pending" } : item
        );
        this.plugin.replaceLocalPromptQueue(this.promptQueue);
        skipQueueDrain = true;
      } else if (!run.accepted) restoreUnsentAnnotations();
      if (message === "Pi run canceled.") {
        new f.Notice("Agent run canceled.");
        return;
      }
      const createdAt = Date.now();
      this.completedThinkingExpansion.set(
        `${threadId}:${createdAt}`,
        run.thinkingUserSet ? run.thinkingExpanded : false
      );
      this.plugin.addMessageToThread(threadId, {
        role: "assistant",
        content: `Agent run failed: ${message}`,
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
      this.notifyRunCompleted(
        run.notificationRunId,
        threadId,
        "Agent run failed. Click to open the chat."
      );
    } finally {
      this.activeRuns.delete(threadId);
      this.syncCurrentRunFlags();
      this.running = this.isThreadRunning(this.plugin.getCurrentThread().id);
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
      this.runningThreadId = undefined;
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
  notifyRunCompleted(runId, threadId, body = "Agent response completed. Click to open the chat.") {
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
