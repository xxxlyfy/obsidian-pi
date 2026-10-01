import * as f from "obsidian";
import {
  PI_AGENT_DISPLAY_NAME as Ce,
  PI_AGENT_ICON_ID as I,
  PI_AGENT_VIEW_TYPE as T
} from "../plugin/constants.mjs";

import { MessageActions } from "./message-actions.mjs";
import { NoteActions } from "./note-actions.mjs";
import { composerAttachmentMethods } from "./view/composer-attachments.mjs";
import * as promptQueueMethods from "./prompt-queue.mjs";
import * as threadListMethods from "./thread-list-view.mjs";
import * as vaultLinkMethods from "./vault-link-actions.mjs";
import * as messageRendererMethods from "./message-renderer.mjs";
import * as runActivityMethods from "./run-activity-state.mjs";
import { RunSettingsControls } from "./run-settings.mjs";
import { ComposerSuggestions } from "./suggestions.mjs";
import { ThreadActions } from "./thread-actions.mjs";
import {
  beginTrackedRun,
  createRunEventHandlers,
  executePromptRun,
  settleRunCleanup
} from "./view/run-lifecycle.mjs";
import {
  enrichPromptDelivery,
  enqueueOrRequeue,
  reportDeliveryFailure,
  resolvePromptInput
} from "./view/run-prompt.mjs";
import {
  chatDomMethods,
  createChatShell,
  createComposer,
  createHeader,
  createMessagesArea
} from "./view/chat-dom.mjs";
import { modelSupportsImages } from "./prompt-payload.mjs";
import {
  getSuccessfulMarkdownMutationPath,
  refreshOpenMarkdownViews
} from "./editor-file-refresh.mjs";
import { openNotificationThread, showDesktopRunNotification } from "./desktop-notifications.mjs";
import { performanceProfiler } from "../shared/performance-profiler.mjs";
import { createViewLifecycle } from "./view/lifecycle.mjs";
import { createViewState } from "./view/view-state.mjs";
// Aliased: `t` is already a local identifier throughout this view.
import { t as tr } from "../shared/i18n/index.mjs";

/**
 * The members this class declares in its own body. They are subtracted from the
 * inherited surface in `ComposedItemView` below, because checkJs rejects a class
 * method that overrides a base *property* (ts2425) and the surface describes
 * every mixin member as a function-typed property.
 *
 * The list is load-bearing in both directions: naming a member here that this
 * class does not declare, or leaving out one that it does, is a
 * `npm run typecheck` error rather than a silent change in what is checked.
 *
 * @typedef {"captureUiCallbackGuard" | "cleanupComposerBarObserver"
 *   | "getCurrentThreadId" | "getCurrentThreadRun" | "getDisplayedContextUsage"
 *   | "isCurrentThread" | "isStaleUiCallback" | "isThreadRunning"
 *   | "noteStaleUiCallback" | "renderChatView" | "renderComposerImages"
 *   | "renderPiIcon" | "resetTransientRunUiState" | "resizeInput" | "runPrompt"
 *   | "setLiveThinkingExpanded" | "syncCurrentRunFlags"} PiAgentViewOwnMember
 */

/**
 * The composed view type: Obsidian's `ItemView` plus every member the runtime
 * mixins add to `PiAgentView.prototype` at the end of this file
 * (message-renderer, run-activity-state, prompt-queue, thread-list-view,
 * vault-link-actions, composer-attachments, chat-dom).
 *
 * `PiAgentViewSurface` in `./view/view-surface.mjs` is the single description of
 * that shared shape, and it is a closed description: a member that is not
 * declared there is a `checkJs` error instead of a silent `undefined`.
 *
 * This is a type cast, not a declaration. It emits nothing, so the class still
 * extends `ItemView` itself, the mixins are still applied to the prototype
 * exactly as before, and Obsidian's view lifecycle is untouched.
 *
 * Declaring the members in the class body is not an option: Obsidian loads this
 * class without a transform, so a bare `foo;` field declaration would create a
 * real instance property and shadow the mixin method with `undefined`, which is
 * how `this.clearCoalescedActivity is not a function` happened once already.
 *
 * @typedef {new (leaf: any) => f.ItemView & Omit<import("./view/view-surface.mjs").PiAgentViewSurface, PiAgentViewOwnMember>} ComposedItemView
 */

/**
 * Chat view. Its methods are assembled here plus the mixin modules imported
 * above (message-renderer, run-activity-state, prompt-queue, thread-list-view,
 * vault-link-actions, composer-attachments, chat-dom), which all operate on this
 * same instance.
 */
export class PiAgentView extends /** @type {ComposedItemView} */ (f.ItemView) {
  constructor(e, t) {
    super(e);
    this.plugin = t;
    /** @type {import("./view/lifecycle.mjs").ViewLifecycle} Timers and cleanup handles owned by this view. */
    this.lifecycle = createViewLifecycle();
    // Transient view state lives in one documented place and under one name
    // (see view-state.mjs). The mixins reach it through `this.state`, so a field
    // belongs to exactly one object instead of being spread across the instance
    // next to the methods that use it.
    /** @type {import("./view/view-state.mjs").ViewState} */
    this.state = createViewState(t);
  }

  // The mixin modules above add their methods to this class's prototype at
  // runtime via Object.assign at the end of this file; their state is created
  // above and reached through `this.state`. `ComposedItemView`, the type this
  // class extends, is what makes those members visible to `checkJs` without
  // declaring any of them here.

  getViewType() {
    return T;
  }
  getDisplayText() {
    return this.plugin.extensionTitle || Ce;
  }
  getIcon() {
    return I;
  }
  async onOpen() {
    this.registerDomEvent(document, "keydown", (e) => {
      this.syncCurrentRunFlags();
      if (e.key === "Escape" && this.state.running) {
        e.preventDefault();
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
    // The DOM is rebuilt from scratch here, so the previous lifecycle's timers
    // and cleanups (if any survived onClose) must not outlive this call.
    if (this.lifecycle) this.lifecycle.dispose();
    this.lifecycle = createViewLifecycle();
    this.showingThreadList = !1;
    let currentThreadId = this.getCurrentThreadId();
    if (this.renderedThreadId !== currentThreadId) this.resetTransientRunUiState();
    this.renderedThreadId = currentThreadId;
    this.syncCurrentRunFlags();
    // Collaborators are built before the DOM so the header's callbacks can call
    // them directly, exactly as the inline listeners did before the extraction.
    this.createViewCollaborators();
    // The tree itself is built by src/ui/view/chat-dom.mjs; this method owns the
    // order (shell, header, messages, composer) and everything that follows.
    this.state.promptQueue = this.plugin.getLocalPromptQueue();
    this.runSettings = new RunSettingsControls(this.plugin);
    const { root } = createChatShell(this.containerEl.children[1]);
    Object.assign(this, createHeader(root, this));
    Object.assign(this, createMessagesArea(root, this));
    Object.assign(this, createComposer(root, this));
    // Assigned here rather than in createComposer so the builder never has to
    // know which collaborator class the composer needs.
    this.suggestions = new ComposerSuggestions(this.inputEl, this.plugin, () => this.resizeInput());
    this.renderMessages();
    this.setRunningState(this.state.running);
  }
  createViewCollaborators() {
    this.noteActions = new NoteActions(this.plugin, {
      parseVaultLinkTarget: (c) => this.parseVaultLinkTarget(c),
      formatVaultLinkTarget: (c) => this.formatVaultLinkTarget(c),
      openVaultLink: (c) => this.openVaultLink(c)
    });
    this.messageActions = new MessageActions(this.plugin, {
      getInput: () => this.inputEl,
      runPrompt: (c) => {
        this.runPrompt(c);
      },
      insertIntoCurrentNote: (c) => {
        var p;
        return (p = this.noteActions) == null ? void 0 : p.insertIntoCurrentNote(c);
      },
      createNoteFromResponse: (c) => {
        var p, v;
        return (v = (p = this.noteActions) == null ? void 0 : p.createNoteFromResponse(c)) != null
          ? v
          : Promise.resolve();
      },
      openCitedNotes: (c) => {
        var p, v;
        return (v = (p = this.noteActions) == null ? void 0 : p.openCitedNotes(c)) != null
          ? v
          : Promise.resolve();
      },
      extractVaultLinks: (c) => {
        var p, v;
        return (v = (p = this.noteActions) == null ? void 0 : p.extractVaultLinks(c)) != null
          ? v
          : [];
      },
      getPreviousUserPrompt: (c) => {
        var p;
        return (p = this.noteActions) == null ? void 0 : p.getPreviousUserPrompt(c);
      }
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
        this.setRunningState(this.state.running);
      }
    });
  }
  async onClose() {
    this.messagesEl = void 0;
    this.inputEl = void 0;
    this.promptQueueEl = void 0;
    this.extensionWidgetsAboveEl = void 0;
    this.extensionWidgetsBelowEl = void 0;
    this.state.composerImages = [];
    this.state.composerAttachments = [];
    this.imageInputEl = void 0;
    this.sendButtonEl = void 0;
    this.composerBarEl = void 0;
    this.runSettings = void 0;
    this.toolBadgesEl = void 0;
    this.threadTitleEl = void 0;
    this.threadFavoriteEl = void 0;
    this.cleanupComposerBarObserver();
    this.clearPendingActivityTimer();
    this.clearCoalescedActivity();
    this.cancelStreamingFlush();
    this.unloadMessageRenderComponents();
    // Release anything the mixins registered. Their own clear* calls above keep
    // their state consistent; this is the backstop for handles they no longer
    // track, and it makes a forgotten timer harmless instead of a leak.
    this.lifecycle?.dispose();
    this.messageActions = void 0;
    this.noteActions = void 0;
    this.threadMenu = void 0;
    this.suggestions?.close();
    this.suggestions = void 0;
  }
  setExtensionEditorText(text) {
    if (!this.inputEl) return;
    this.inputEl.value = text;
    this.resizeInput();
    this.suggestions?.update();
    this.inputEl.focus();
  }
  getDisplayedContextUsage() {
    var n;
    if (this.state.currentRunContextUsage) return this.state.currentRunContextUsage;
    let e = this.plugin.getCurrentThread();
    if (this.state.invalidatedContextThreadIds.has(e.id))
      return { compacted: true, contextWindow: this.plugin.getSelectedModelInfo()?.contextWindow };
    let t = (n = e.messages) != null ? n : [];
    for (let s = t.length - 1; s >= 0; s--) {
      let a = t[s];
      if (a.role === "assistant" && a.contextUsage)
        return { contextUsage: a.contextUsage, tokenUsage: a.tokenUsage };
    }
  }
  toggleCurrentThreadFavorite() {
    const thread = this.plugin.getCurrentThread();
    if (!this.plugin.toggleThreadFavorite(thread.id)) {
      new f.Notice(tr("view.threadMissing"));
      return;
    }
    this.renderThreadFavorite();
    this.renderThreadListIfVisible();
  }
  async submitInput() {
    var t, n;
    let e = (t = this.inputEl) == null ? void 0 : t.value.trim();
    let images = this.state.composerImages.map((image) => ({ ...image }));
    let attachments = this.state.composerAttachments.map((attachment) => ({ ...attachment }));
    const contextFilePath = this.plugin.getCurrentContextFile()?.path;
    if (!e && images.length === 0 && attachments.length === 0) return;
    if (images.length > 0) await this.plugin.ensureModelCatalogLoaded();
    if (images.length > 0 && !modelSupportsImages(this.plugin.getSelectedModelInfo())) {
      new f.Notice("The selected Pi model does not support image input.");
      return;
    }
    if (this.inputEl) this.inputEl.value = "";
    this.state.composerImages = [];
    this.state.composerAttachments = [];
    this.renderComposerImages();
    if ((n = this.suggestions) != null) n.close();
    this.resizeInput();
    this.syncCurrentRunFlags();
    this.runPrompt(e, undefined, images, undefined, attachments, undefined, contextFilePath);
    this.setRunningState(this.state.running);
  }
  handleSendButtonClick() {
    var t;
    this.syncCurrentRunFlags();
    if (
      this.state.running &&
      !((t = this.inputEl) != null && t.value.trim()) &&
      this.state.composerImages.length === 0 &&
      this.state.composerAttachments.length === 0
    ) {
      this.cancelCurrentRun();
      return;
    }
    this.submitInput();
  }
  cancelCurrentRun() {
    this.syncCurrentRunFlags();
    let e = this.getCurrentThreadRun();
    if (e && !e.canceling) {
      e.canceling = !0;
      this.state.canceling = !0;
      this.clearCoalescedActivity();
      this.setActivity("Canceling", "finishing");
      this.plugin.cancelPiRun(e.runner);
      this.setRunningState(!0);
      this.renderThreadListIfVisible();
    }
  }
  cleanupComposerBarObserver() {
    if (this.composerBarCleanup) {
      this.composerBarCleanup();
      this.composerBarCleanup = void 0;
    }
  }
  observeComposerBar(e) {
    // The previous observer, if any, was released by cleanupComposerBarObserver()
    // or by disposing the lifecycle; registering the new one replaces it.
    let t = () => this.updateComposerBarMode(e.clientWidth);
    t();
    if (typeof ResizeObserver == "undefined") {
      window.addEventListener("resize", t);
      let n = !1,
        s = () => {
          if (!n) {
            n = !0;
            window.removeEventListener("resize", t);
          }
        };
      this.composerBarCleanup = this.lifecycle.addCleanup(s);
      return;
    }
    let n = new ResizeObserver((a) => {
        var l, d;
        let o = (d = (l = a[0]) == null ? void 0 : l.contentRect.width) != null ? d : e.clientWidth;
        this.updateComposerBarMode(o);
      }),
      s = !1,
      a = () => {
        if (!s) {
          s = !0;
          n.disconnect();
        }
      };
    n.observe(e);
    this.composerBarCleanup = this.lifecycle.addCleanup(a);
  }
  renderComposerImages() {
    this.renderToolBadges();
  }
  resizeInput() {
    if (!this.inputEl) return;
    this.inputEl.setCssProps({ height: "auto" });
    this.inputEl.setCssProps({ height: `${Math.min(this.inputEl.scrollHeight, 160)}px` });
  }
  getCurrentThreadId() {
    var e;
    return (e = this.plugin.getCurrentThread()) == null ? void 0 : e.id;
  }
  isCurrentThread(e) {
    return this.getCurrentThreadId() === e;
  }
  isThreadRunning(e) {
    return this.state.activeRuns.has(e);
  }
  getCurrentThreadRun() {
    let e = this.getCurrentThreadId();
    return e ? this.state.activeRuns.get(e) : void 0;
  }
  syncCurrentRunFlags() {
    let e = this.getCurrentThreadRun();
    this.state.running = !!e;
    this.state.canceling = e?.canceling === !0;
  }
  // Unified stale-view / stale-run guard for delayed UI
  // callbacks (activity timers, streaming rAF, pending sticky state).
  captureUiCallbackGuard() {
    return {
      runGeneration: this.getCurrentThreadRun()?.runGeneration,
      threadGeneration: this.state.threadGeneration,
      threadId: this.getCurrentThreadId()
    };
  }
  isStaleUiCallback(guard) {
    if (!guard) return false;
    if (guard.threadGeneration !== this.state.threadGeneration) return true;
    if (guard.threadId !== this.getCurrentThreadId()) return true;
    if (guard.runGeneration !== undefined) {
      const run = this.getCurrentThreadRun();
      if (!run || run.runGeneration !== guard.runGeneration) return true;
    }
    return false;
  }
  noteStaleUiCallback() {
    performanceProfiler.incrementCounter("staleCallbackPrevented");
  }
  resetTransientRunUiState() {
    // A rendered-thread reset invalidates every callback bound to the old
    // thread generation.
    this.state.threadGeneration += 1;
    this.clearCoalescedActivity();
    this.state.activityText = "";
    this.state.activityKind = "thinking";
    this.state.activityDetail = "";
    this.state.activityStickyUntil = 0;
    this.state.pendingActivity = void 0;
    this.clearPendingActivityTimer();
    this.state.activeToolCalls.clear();
    this.state.currentRunContextUsage = void 0;
    this.cancelStreamingFlush();
    this.state.streamingAssistantContent = "";
    this.state.streamingAnswerDirty = false;
    this.state.streamingThinkingContent = "";
    this.state.streamingThinkingDirty = false;
    this.state.thinkingDisclosureExpanded = false;
    this.state.thinkingDisclosureUserSet = false;
    this.streamingItemEl = void 0;
    this.streamingTextEl = void 0;
  }
  renderThreadListIfVisible() {
    if (this.showingThreadList) this.renderThreadList();
  }
  runAnnotationPrompt(prompt, sourcePath) {
    return this.runPrompt(prompt, undefined, [], undefined, [], undefined, sourcePath);
  }
  async runPrompt(
    e,
    t = this.plugin.getCurrentThread().id,
    images = [],
    queuedId,
    attachments = [],
    annotations,
    annotationSourcePath
  ) {
    const resolvedInput = await resolvePromptInput(this, annotationSourcePath, annotations);
    if (resolvedInput.failed) return;
    annotations = resolvedInput.annotations;
    // Gives consumed annotations back when the prompt never reached Pi.
    const restoreUnsentAnnotations = () =>
      !queuedId && annotations.length > 0 && this.plugin.restoreConsumedAnnotations(annotations);
    // A prompt for a thread that is already running is queued, not started. This
    // decision is re-checked after enrichment, because enrichment can await.
    if (this.isThreadRunning(t)) {
      enqueueOrRequeue(this, {
        prompt: e,
        threadId: t,
        images,
        attachments,
        annotations,
        queuedId,
        annotationSourcePath
      });
      return;
    }
    const delivery = await enrichPromptDelivery(this, {
      prompt: e,
      images,
      attachments,
      annotations,
      annotationSourcePath,
      threadId: t
    });
    if (!delivery.ok) {
      reportDeliveryFailure(this, delivery, queuedId, restoreUnsentAnnotations);
      return;
    }
    e = delivery.prompt;
    images = delivery.images;
    attachments = delivery.attachments;
    if (this.isThreadRunning(t)) {
      enqueueOrRequeue(this, {
        prompt: e,
        threadId: t,
        images,
        attachments,
        annotations,
        queuedId,
        annotationSourcePath
      });
      return;
    }
    const tracked = beginTrackedRun(this, {
      prompt: e,
      threadId: t,
      images,
      attachments,
      annotations,
      queuedId
    });
    const handlers = createRunEventHandlers(
      this,
      tracked.run,
      t,
      tracked.acknowledgeQueuedDelivery
    );
    const skipQueueDrain = await executePromptRun(
      this,
      { prompt: e, threadId: t, images, queuedId, promptContext: delivery.promptContext },
      tracked,
      handlers,
      restoreUnsentAnnotations
    );
    settleRunCleanup(this, t, skipQueueDrain);
  }
  notifyRunCompleted(runId, threadId, body = "Agent response completed. Click to open the chat.") {
    if (!this.plugin.settings.desktopNotifications) return false;
    return showDesktopRunNotification({
      runId,
      sentRunIds: this.state.desktopNotificationRunIds,
      body,
      onClick: () => openNotificationThread(this.plugin, threadId, T)
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
  setLiveThinkingExpanded(expanded) {
    const run = this.getCurrentThreadRun();
    this.state.thinkingDisclosureExpanded = expanded;
    this.state.thinkingDisclosureUserSet = true;
    if (run) {
      run.thinkingExpanded = expanded;
      run.thinkingUserSet = true;
    }
  }
  renderPiIcon(e) {
    (0, f.setIcon)(e, I);
  }
}

// Every member that paints or creates DOM lives in chat-dom.mjs; mixing it in
// here keeps the class body free of element creation without changing a single
// call site (`this.renderToolBadges()` still resolves through the prototype).
Object.assign(
  PiAgentView.prototype,
  promptQueueMethods,
  threadListMethods,
  vaultLinkMethods,
  messageRendererMethods,
  runActivityMethods,
  composerAttachmentMethods,
  chatDomMethods
);
