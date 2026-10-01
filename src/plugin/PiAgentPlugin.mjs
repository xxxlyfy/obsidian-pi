import fs from "node:fs";
import * as P from "obsidian";
import { AnnotationStore } from "../annotations/annotation-store.mjs";
import { MarkdownAnnotationsController } from "../annotations/markdown-annotations-controller.mjs";
import { ContextBuilder } from "../context/context-builder.mjs";
import { formatContextShowResponse, isContextShowPrompt } from "../context/context-show.mjs";
import { normalizeSkillFolderList } from "../context/skills.mjs";
import { VaultGraph } from "../context/vault-graph.mjs";
import { checkPiInstallation, warmupPiCli } from "../pi/health.mjs";
import { PiCommandCatalog } from "../pi/command-catalog.mjs";
import {
  createExtensionUiHandler,
  renderExtensionStatuses,
  sanitizeExtensionText
} from "../pi/extension-ui.mjs";
import { PiModelCatalog } from "../pi/model-catalog.mjs";
import { getCompactInstructions, PiRunner } from "../pi/runner.mjs";
import { t } from "../shared/i18n/index.mjs";
import { CUSTOM_MODEL_VALUE as b, DEFAULT_SETTINGS as H, normalizeSettings } from "./settings.mjs";
import { PiAgentSettingTab } from "./settings-tab.mjs";
import { refreshUiLanguage } from "./ui-language.mjs";
import {
  PI_AGENT_DISPLAY_NAME as Ce,
  PI_AGENT_ICON_ID as I,
  PI_AGENT_ICON_SVG as O,
  PI_AGENT_VIEW_TYPE as T
} from "./constants.mjs";
import { ApprovalModal } from "../ui/modals/approval-modal.mjs";
import { PiSetupModal } from "../ui/modals/pi-setup-modal.mjs";
import { showExtensionUiDialog } from "../ui/modals/extension-ui-modal.mjs";
import { PiAgentView } from "../ui/PiAgentView.mjs";
import { requestDesktopNotificationPermission } from "../ui/desktop-notifications.mjs";
import { previewFrontmatterPatch } from "../shared/frontmatter.mjs";
import { performanceProfiler } from "../shared/performance-profiler.mjs";
import { sanitizeThreadHistory } from "../shared/thread-history.mjs";
import { readChatHistoryBackup, writeChatHistoryBackup } from "../threads/chat-history-backup.mjs";
import {
  importVaultChatHistory,
  removeImportedVaultChatHistory
} from "../threads/chat-history-import.mjs";
import { ThreadStore } from "../threads/thread-store.mjs";
import {
  enqueueLocalPrompt,
  normalizeLocalPromptQueue,
  removeLocalPrompt,
  restorePersistedLocalPromptQueue,
  updateLocalPrompt
} from "../ui/local-prompt-queue.mjs";
import { applyPromptEnricher } from "../ui/prompt-payload.mjs";
import {
  createRuntimeCatalogSnapshot,
  hasSafeRuntimeCatalog,
  needsRuntimeCatalogRefresh,
  RuntimeCatalogRefreshGate
} from "../ui/model-picker.mjs";

const PI_BRAND_NAME = "Pi";

var be = `# Pi Agent

You are Pi, an agentic AI coding assistant from https://pi.dev, running inside Pi Agent.

The user is working in an Obsidian vault made of Markdown notes, scripts, configs, and sometimes plugin/source-code projects. Treat vault paths, wikilinks, frontmatter, headings, tags, backlinks, outgoing links, and code files as first-class context. The plugin may provide the current note, selected text, backlinks, outgoing links, explicit search results, and explicit @note, #tag, or /command attachments.

Your primary role is agentic coding and technical knowledge work inside the vault: inspect files, reason about systems, propose implementation plans, edit code or Markdown when edit tools are enabled, run commands when shell tools are enabled, and summarize concrete changes.

## Operation modes

- Chat: no Pi CLI tools are enabled. Use only the Obsidian context attached by the plugin and ask for more context when needed.
- Review: read/search/list tools are enabled. Inspect files and explain, review, summarize, or propose changes, but do not modify files.
- Edit: read/search/list plus edit/write tools are enabled. Make focused file changes when the user asks. Shell commands are not available, so ask the user to run tests/builds manually when needed.
- Full agent: Pi's complete tool set is enabled, including extension/custom tools and read/search/list/edit/write/bash. You may run appropriate shell commands for coding tasks, tests, builds, repo inspection, and diagnostics.

Pi CLI tools are controlled by the selected tool mode. They are not an OS-level sandbox. Use tools intentionally, keep edits small, and avoid destructive commands unless explicitly requested and clearly safe.

## Coding behavior

- Before editing code, inspect the relevant files and existing patterns.
- Prefer minimal, reviewable changes over broad rewrites.
- Run targeted tests or build commands when shell tools are enabled and practical; otherwise tell the user what to run.
- Preserve project conventions, formatting, imports, and file organization.
- If a task touches generated files or dependencies, explain why.
- If you cannot safely determine the right implementation, ask a concise clarification or propose a plan first.
- After code edits, summarize changed files, behavior changes, tests/builds run, and any follow-up checks.

## Vault behavior

- Treat every markdown file as user-owned knowledge.
- When the user says "this", "here", "this note", or "this idea", start from the current note and selected text before using broader search context.
- Preserve existing headings, links, aliases, tags, and frontmatter unless the user asks to change them.
- Prefer Obsidian wikilinks for vault references, for example [[Note Name]] or [[path/to/note|label]].
- Do not infer facts that are not present in notes. Say when references are weak or missing.
- If a referenced note, heading, block, or file is not present in the provided context, say it was not found instead of inventing content.
- Preserve Obsidian callouts, embeds, block IDs, footnotes, comments, and dataview/base-related sections unless the user explicitly asks to change them.
- Use Obsidian-friendly Markdown: clear headings, compact bullets, tables only when useful, and callouts only when they improve the note.

## Chat responses

- Be concise and action-oriented.
- Avoid Markdown formatting in chat responses unless the user asks for it or a structured/note-ready response clearly needs it.
- Use wikilinks when mentioning vault notes.

## Frontmatter

- Keep YAML frontmatter compact and stable.
- Common fields: type, status, tags, aliases, created, updated, project, area, source.
- Prefer arrays for tags and aliases.
- Do not delete unknown fields.
- Do not rewrite the entire YAML block unless asked. Add or update only the specific fields needed.
- Preserve existing field names, ordering, quoting style, and unknown system-managed fields as much as possible.

## Backlinks and references

- Use backlinks to understand who depends on the current note.
- Use outgoing links to understand what the current note depends on.
- Use unresolved links as possible missing notes, typos, or future note ideas.
- When researching a topic, start with exact title and alias matches, then tags, then full-text mentions.
- Before renaming, moving, deleting, or substantially changing the meaning of a note, consider backlinks and outgoing links and mention likely affected references.
- When adding new links, prefer existing note titles or aliases discovered from context instead of creating duplicate concepts.

## Obsidian Bases

- Bases are useful when notes share predictable frontmatter.
- A good Base starts from the fields already used in a folder.
- Suggested fields: type, status, tags, project, area, created, updated.
- Propose a Base config before creating it unless the user explicitly asks you to create it immediately.`;
export class PiAgentPlugin extends P.Plugin {
  /**
   * Obsidian may pass constructor arguments through to Plugin; forward the first
   * two explicitly, which is the documented shape, and ignore the rest.
   *
   * @param {any} app
   * @param {any} [manifest]
   */
  constructor(app, manifest) {
    super(app, manifest);
    this.settings = H;
    this.messages = [];
    this.threadHistory = new ThreadStore();
    this.annotationStore = new AnnotationStore();
    this.dataSaveChain = Promise.resolve();
    this.threadRunners = new Map();
    // Runners a one-shot session operation (Session Info, export, rename) borrowed and
    // releases itself. Deliberately not part of `threadRunners`: they must never become
    // a thread's chat runner. The plugin tracks them for one reason only -- a borrowed
    // runner whose request is still in flight when the plugin unloads has no other
    // owner, and `threadRunners` cannot see it.
    /** @type {Set<PiRunner>} */
    this.ephemeralRunners = new Set();
    /** @type {boolean} Set by onunload(); after it, no new Pi process may start. */
    this.unloading = false;
    this.piCommands = [];
    this.commandCatalogLoaded = false;
    this.commandCatalogRefreshPromise = undefined;
    this.extensionStatuses = new Map();
    this.extensionStatusElements = new Map();
    this.extensionWidgets = new Map();
    this.extensionTitle = "";
    this.localPromptQueue = [];
    this.localPromptSteering = [];
    this.localPromptQueuePaused = false;
    this.promptEnricher = undefined;
    /** @type {any} Extension UI handler, built on first use by getExtensionUiHandler(). */
    this.extensionUiHandler = undefined;
    this.modelCatalogRefreshGate = new RuntimeCatalogRefreshGate();
    this.modelCatalogRefreshedAt = 0;
    this.modelCatalogGeneration = 0;
    this.modelCatalogError = "";
  }
  async onload() {
    await this.loadSettings();
    refreshUiLanguage();
    this.profiler = performanceProfiler;

    if (!P.Platform.isDesktopApp) {
      new P.Notice("Pi Agent is desktop-only.");
      return;
    }

    if (this.settings.desktopNotifications)
      void requestDesktopNotificationPermission().catch(() => {});

    (0, P.addIcon)(I, O);
    this.extensionStatusEl = this.addStatusBarItem();
    this.extensionStatusEl.addClass("pi-agent-extension-statuses");
    this.renderExtensionStatuses();
    this.rebuildServices();
    this.annotationController = new MarkdownAnnotationsController(this);
    this.annotationController.start();

    warmupPiCli(this.settings.piExecutablePath, this.getPluginDirectory());

    this.refreshCurrentContextFile();
    // Start Pi extensions and populate skills, prompts, and extension commands
    // without waiting for the first slash autocomplete interaction.
    void this.refreshCommandCatalog(false);

    this.registerEvent(
      this.app.workspace.on("file-open", (e) => {
        this.setCurrentContextFile(e);
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.refreshCurrentContextFile();
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (
          /** @type {any} */ (file).extension === "md" &&
          this.annotationStore.list(oldPath).length > 0 &&
          !this.annotationStore.renamePath(oldPath, file.path)
        )
          new P.Notice(
            "Annotations could not follow the renamed note; their original records were kept."
          );
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (/** @type {any} */ (file).extension === "md")
          this.annotationStore.deletePath(file.path);
      })
    );
    this.registerView(T, (e) => new PiAgentView(e, this));
    this.addRibbonIcon(I, `Open ${Ce}`, () => {
      this.activateView();
    });
    this.addCommand({
      id: "open-pi",
      name: "Open agent chat",
      callback: () => {
        this.activateView();
      }
    });
    this.addCommand({
      id: "toggle-annotations",
      name: "Add or toggle annotation for active note",
      checkCallback: (checking) =>
        this.runWithActiveMarkdownNote(checking, () => {
          this.annotationController?.handleActiveMarkdownNote();
        })
    });
    this.addCommand({
      id: "check-pi-installation",
      name: `Check ${PI_BRAND_NAME} installation`,
      callback: () => {
        this.checkPiInstallation(true);
      }
    });
    this.addCommand({
      id: "ask-about-current-note",
      name: "Ask about current note",
      checkCallback: (e) =>
        this.runWithActiveMarkdownNote(e, () => {
          this.runCommandPrompt(
            "Use the active note as context. Summarize the key facts, assumptions, and useful follow-up questions."
          );
        })
    });
    this.addCommand({
      id: "research-around-current-note",
      name: "Research around current note",
      checkCallback: (e) =>
        this.runWithActiveMarkdownNote(e, () => {
          this.runCommandPrompt(
            "Research around the active note using backlinks, outgoing links, unresolved links, tags, and search results. Return concise findings with vault references."
          );
        })
    });
    this.addCommand({
      id: "suggest-frontmatter",
      name: "Suggest frontmatter for current note",
      checkCallback: (e) =>
        this.runWithActiveMarkdownNote(e, () => {
          this.suggestFrontmatterForCurrentNote();
        })
    });
    this.addCommand({
      id: "draft-base-from-current-note",
      name: "Draft base from current note context",
      checkCallback: (e) =>
        this.runWithActiveMarkdownNote(e, () => {
          this.runCommandPrompt(
            "Draft an Obsidian Base for notes related to the active note. Infer useful fields from frontmatter, tags, backlinks, and linked notes."
          );
        })
    });
    this.settingsTab = new PiAgentSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
  }
  onunload() {
    // Set first: everything below may create or settle a runner, and nothing may
    // start a new Pi process once the plugin is going away.
    this.unloading = true;
    this.annotationController?.destroy();
    // Order matters -- request cancellation for every run that is actually
    // executing, then release resources. `onunload()` has to stay synchronous
    // because Obsidian does not await it (`Component.unload(): void`), so the
    // aborts cannot be awaited here; instead `cancelCurrentRun()` writes the abort
    // request to Pi's stdin before it returns, `PiRpcClient.abort()` terminates the
    // process tree itself when the request cannot be delivered, and
    // `disposeThreadRunners()` terminates whatever is left. Neither call throws.
    this.cancelAllPiRuns();
    this.disposeThreadRunners();
    // Last, and last for a reason: a one-shot session operation (Session Info, export,
    // rename) owns its runner outside `threadRunners`, so only this releases one that
    // is still waiting for Pi. There is nothing to cancel first: those operations never
    // set `isRunning`, and disposing the client is what ends their request.
    this.disposeEphemeralThreadRunners();
  }
  async loadSettings() {
    const rawData = (await this.loadData()) ?? {};
    const {
      chatHistory,
      messages,
      threadId,
      sessionId,
      localPromptQueue,
      localPromptSteering,
      annotationData,
      currentChatId: _currentChatId,
      chatHistoryFolder,
      chatHistoryStorageVersion,
      chatHistoryMigrationDismissed: _chatHistoryMigrationDismissed,
      legacyIndexedHistoryFolder: _indexedHistoryFolder,
      legacyJsonHistoryFolder: _jsonHistoryFolder,
      ...rawSettings
    } = rawData;
    const shouldImportVaultHistory = [1, 2, 3].includes(chatHistoryStorageVersion);
    let importedHistory;
    if (shouldImportVaultHistory) {
      try {
        importedHistory = await importVaultChatHistory(this.getVaultBasePath(), rawData);
      } catch (error) {
        console.warn("Pi Agent: could not import vault chat history", error);
      }
      if (Array.isArray(rawSettings.ignoredFolders) && chatHistoryFolder) {
        rawSettings.ignoredFolders = rawSettings.ignoredFolders.filter(
          (folder) => folder !== chatHistoryFolder
        );
      }
    }

    let restoredHistory = importedHistory?.history;
    if (!restoredHistory && isStoredChatHistory(chatHistory)) restoredHistory = chatHistory;
    if (!restoredHistory) {
      restoredHistory = await readChatHistoryBackup(this.getPluginDirectory());
      if (restoredHistory) new P.Notice("Pi Agent recovered chat history from its local backup.");
    }

    this.settings = normalizeSettings(rawSettings);
    this.localPromptQueue = restorePersistedLocalPromptQueue(localPromptQueue, localPromptSteering);
    this.localPromptSteering = [];
    this.localPromptQueuePaused = this.localPromptQueue.length > 0;
    this.settings.additionalSkillFolders = normalizeSkillFolderList(
      this.settings.additionalSkillFolders
    );
    this.threadHistory = new ThreadStore(
      restoredHistory,
      messages,
      sessionId != null ? sessionId : threadId
    );
    this.annotationStore = new AnnotationStore(annotationData, () => {
      this.saveAnnotations();
      this.annotationController?.refresh();
      this.refreshAnnotationBadges();
    });
    this.syncCurrentThreadState();
    if (this.settings.model && isLegacyBareModelId(this.settings.model)) {
      this.settings.customModel = `openai/${this.settings.model}`;
      this.settings.model = "__custom";
    }

    if (importedHistory?.history) {
      await this.savePluginData();
      const persisted = (await this.loadData())?.chatHistory;
      if (!historiesMatch(persisted, this.threadHistory.toJSON())) {
        throw new Error("Could not verify imported chat history in plugin data.");
      }
      await removeImportedVaultChatHistory(
        this.getVaultBasePath(),
        importedHistory.managedFiles,
        this.app.vault
      );
      if (importedHistory.warnings.length > 0) {
        console.warn(
          "Pi Agent: some unrecognized chat files were left in place",
          importedHistory.warnings
        );
        new P.Notice("Chat history was restored, but unreadable chat files were left in place.");
      } else {
        new P.Notice("Chat history was restored to Pi Agent's local plugin data.");
      }
    }
  }
  async saveSettings() {
    // Invalidate before the first await so an older catalog request cannot win
    // the race against settings persistence or a service restart.
    this.modelCatalogGeneration += 1;
    this.modelCatalogRefreshedAt = 0;
    await this.savePluginData();
    if (this.hasActivePiRuns()) this.pendingServiceRebuild = true;
    else this.rebuildServices();
  }
  hasActivePiRuns() {
    return [...this.threadRunners.values()].some((runner) => runner.isRunning);
  }
  rebuildServicesIfPending() {
    if (this.pendingServiceRebuild && !this.hasActivePiRuns()) {
      this.pendingServiceRebuild = false;
      this.rebuildServices();
    }
  }
  showPiSetupIfNeeded() {
    if (this.settings.dismissedPiSetup) return;

    window.setTimeout(() => {
      if (!this.settings.dismissedPiSetup) this.checkPiInstallation(false);
    }, 800);
  }
  checkPiInstallation(showSuccess) {
    let e = checkPiInstallation(this.settings.piExecutablePath);
    if (e.ok) {
      showSuccess && new P.Notice(t("notice.cliAvailable", { version: e.version || e.message }));
      return e;
    }

    showSuccess ? new P.Notice(e.message) : new PiSetupModal(this, e).open();
    return e;
  }
  async refreshModelCatalog(showNotice = false, force = true) {
    if (!force && !needsRuntimeCatalogRefresh(this.settings, this.modelCatalogRefreshedAt)) {
      return { ok: true, stale: false };
    }
    const result = await this.modelCatalogRefreshGate.run(() => this.performModelCatalogRefresh());
    if (showNotice) {
      new P.Notice(
        result.ok
          ? t("notice.modelsLoaded", {
              count: this.settings.availableModels.length,
              model: this.settings.effectiveModel
            })
          : this.modelCatalogError
      );
    }
    return result;
  }
  async performModelCatalogRefresh() {
    try {
      while (true) {
        const generation = this.modelCatalogGeneration;
        const catalog = this.catalog;
        if (!catalog) throw new Error("Pi model service is not ready.");

        let models;
        let effectiveConfig;
        try {
          models = await catalog.getAvailableModels(this.getVaultBasePath());
          effectiveConfig = catalog.getEffectiveConfig();
        } catch (error) {
          if (generation !== this.modelCatalogGeneration) continue;
          throw error;
        }
        if (generation !== this.modelCatalogGeneration) continue;

        const snapshot = createRuntimeCatalogSnapshot(models, effectiveConfig);
        this.settings.availableModels = snapshot.availableModels;
        this.settings.effectiveModel = snapshot.effectiveModel;
        this.settings.effectiveReasoning = snapshot.effectiveReasoning;
        if (
          this.settings.model === "__custom" &&
          this.settings.customModel &&
          models.some((model) => model.slug === this.settings.customModel)
        ) {
          this.settings.model = this.settings.customModel;
        }
        if (
          this.settings.model &&
          this.settings.model !== "__custom" &&
          !models.some((model) => model.slug === this.settings.model)
        ) {
          this.settings.model = "";
          this.settings.reasoningEffort = "";
        }

        this.modelCatalogRefreshedAt = Date.now();
        this.modelCatalogError = "";
        await this.savePluginData();
        if (generation !== this.modelCatalogGeneration) continue;

        this.refreshOpenModelControls();
        return { ok: true, stale: false };
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.modelCatalogError = `Could not refresh models from Pi. Check the Pi executable and configuration, then try again. ${detail}`;
      console.warn("Pi Agent: failed to refresh model catalog", error);
      this.refreshOpenModelControls();
      if (hasSafeRuntimeCatalog(this.settings)) return { ok: false, stale: true };
      throw new Error(this.modelCatalogError, { cause: error });
    }
  }
  async ensureRuntimeModelState() {
    const result = await this.refreshModelCatalog(false, false);
    if (!result.ok && this.modelCatalogError) new P.Notice(this.modelCatalogError);
    return result;
  }
  refreshOpenModelControls() {
    for (const leaf of this.app.workspace.getLeavesOfType(T)) {
      /** @type {any} */ (leaf.view)?.runSettings?.refresh?.();
    }
    this.settingsTab?.display?.();
  }
  async refreshCommandCatalog(showNotice = false) {
    if (this.commandCatalogRefreshPromise) return this.commandCatalogRefreshPromise;
    // Service restore: only the missing catalog is rebuilt, so the thread runners
    // that are already in use are left alone (a settings rebuild still releases them).
    this.commandCatalog || this.rebuildServices({ disposeThreadRunners: false });
    const catalog = this.commandCatalog;
    const refreshPromise = (async () => {
      try {
        const commands = (await catalog?.getCommands(this.getVaultBasePath())) ?? [];
        if (this.commandCatalog !== catalog) return this.piCommands;
        this.piCommands = commands;
        this.commandCatalogLoaded = true;
        if (showNotice) new P.Notice(`Loaded ${this.piCommands.length} Pi commands.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (showNotice) new P.Notice(message);
        console.warn("Pi Agent: failed to refresh Pi commands", error);
      }
      return this.piCommands;
    })();
    const trackedPromise = refreshPromise.finally(() => {
      if (this.commandCatalogRefreshPromise === trackedPromise)
        this.commandCatalogRefreshPromise = undefined;
    });
    this.commandCatalogRefreshPromise = trackedPromise;
    return trackedPromise;
  }
  getPiCommands() {
    return this.piCommands;
  }
  addMessage(e) {
    return this.addMessageToThread(this.threadHistory.currentThreadId, e);
  }
  addMessageToThread(e, t) {
    let n = this.threadHistory.addMessageToThread(e, t);
    return n ? (this.syncCurrentThreadState(), this.saveThreadHistory(), !0) : !1;
  }
  startNewThread(e) {
    let t = this.threadHistory.startNewThread(e);
    this.clearExcludedContextFile();
    return (this.syncCurrentThreadState(), this.saveThreadHistory(), t);
  }
  async forkCurrentThread() {
    const current = this.getCurrentThread();
    if (current.messages.length === 0) return undefined;

    let clonedSession;
    if (current.piSessionId) {
      const runner = this.createPiRunner(current.id);
      try {
        clonedSession = await runner.cloneSession(current.piSessionId);
        if (clonedSession) {
          await runner
            .setSessionName(clonedSession, `${current.title} (fork)`)
            .catch((error) => console.warn("Pi Agent: could not name cloned Pi session", error));
        }
      } finally {
        runner.rpcClient?.dispose();
        this.threadRunners.delete(current.id);
      }
      if (!clonedSession) return undefined;
    }

    const fork = this.threadHistory.forkCurrentThread(clonedSession);
    return fork
      ? (this.clearExcludedContextFile(),
        this.syncCurrentThreadState(),
        this.saveThreadHistory(),
        fork)
      : undefined;
  }
  getCurrentThread() {
    return this.threadHistory.getCurrentThread();
  }
  listThreads(e) {
    return this.threadHistory.listThreads(e);
  }
  /**
   * A PiRunner for a one-shot session lookup.
   *
   * Built from the same settings, context builder, directories and extension UI as
   * a chat runner, but deliberately not registered in `threadRunners`: the caller
   * owns it and disposes it through `disposeEphemeralThreadRunner()`, so a temporary
   * lookup cannot leave a Pi process behind. `threadId` plays no part in the
   * configuration -- it is only the key a chat runner is cached under -- so no thread
   * id is needed here.
   *
   * The runner is tracked in `ephemeralRunners` until the caller releases it, so
   * `onunload()` can release a lookup that is still waiting for Pi. It never sets
   * `isRunning` and is never cancelled: disposing its client is what ends its request.
   */
  createEphemeralThreadRunner() {
    (!this.graph || !this.contextBuilder) && this.rebuildServices({ disposeThreadRunners: false });
    if (!this.contextBuilder) throw new Error("Pi context builder is not available.");
    const runner = new PiRunner(
      this.settings,
      this.contextBuilder,
      this.getVaultBasePath(),
      this.getPluginDirectory(),
      undefined,
      this.getExtensionUiHandler()
    );
    this.ephemeralRunners.add(runner);
    return runner;
  }
  /**
   * Release one ephemeral runner and stop tracking it.
   *
   * Idempotent on purpose: `onunload()` may already have released this runner, so the
   * `finally` of the operation that borrowed it can run afterwards without reporting
   * anything. A failing release is a warning; it must not break the caller.
   *
   * @param {PiRunner} runner Runner a one-shot session operation borrowed.
   */
  disposeEphemeralThreadRunner(runner) {
    this.ephemeralRunners.delete(runner);
    try {
      runner.dispose();
    } catch (error) {
      console.warn("Pi Agent: could not dispose an ephemeral Pi runner", error);
    }
  }
  /**
   * Release every ephemeral runner that is still in flight, for `onunload()`.
   *
   * Snapshot before clearing, so a runner that settles while this loop runs cannot
   * change what is being released, and so one failing release cannot leave the others
   * running.
   */
  disposeEphemeralThreadRunners() {
    const runners = [...this.ephemeralRunners];
    this.ephemeralRunners.clear();
    for (const runner of runners) this.disposeEphemeralThreadRunner(runner);
  }
  async getThreadSessionStats(threadId) {
    const thread = this.threadHistory.getThread(threadId);
    if (!thread?.piSessionId) return undefined;
    // A thread that already has a runner keeps it: that runner may be carrying a
    // chat run, so a read-only lookup must never dispose it.
    const existing = this.threadRunners.get(threadId);
    if (existing) return existing.getSessionStats(thread.piSessionId);
    const runner = this.createEphemeralThreadRunner();
    try {
      return await runner.getSessionStats(thread.piSessionId);
    } finally {
      this.disposeEphemeralThreadRunner(runner);
    }
  }
  async exportThreadSession(threadId) {
    const thread = this.threadHistory.getThread(threadId);
    if (!thread?.piSessionId) return undefined;
    const existing = this.threadRunners.get(threadId);
    if (existing) return existing.exportSession(thread.piSessionId);
    const runner = this.createEphemeralThreadRunner();
    try {
      return await runner.exportSession(thread.piSessionId);
    } finally {
      this.disposeEphemeralThreadRunner(runner);
    }
  }
  async getThreadSessionTree(threadId) {
    const thread = this.threadHistory.getThread(threadId);
    if (!thread?.piSessionId) return undefined;
    const existing = this.threadRunners.get(threadId);
    if (existing) return existing.getSessionTree(thread.piSessionId);
    // Session Info runs stats and tree together. Each call owns its own temporary
    // runner, so neither can dispose the runner the other one is still using.
    const runner = this.createEphemeralThreadRunner();
    try {
      return await runner.getSessionTree(thread.piSessionId);
    } finally {
      this.disposeEphemeralThreadRunner(runner);
    }
  }
  async getThreadSessionEntries(threadId, since) {
    const thread = this.threadHistory.getThread(threadId);
    if (!thread?.piSessionId) return undefined;
    return this.createPiRunner(threadId).getSessionEntries(thread.piSessionId, since);
  }
  getThreadDisplayMessageCount(e) {
    let t = Array.isArray(e == null ? void 0 : e.messages) ? e.messages.length : 0,
      n = this.countPiSessionChatMessages(e == null ? void 0 : e.piSessionId);
    return Math.max(t, n);
  }
  countPiSessionChatMessages(e) {
    let t = this.pi?.resolveSessionPath(e);
    if (!t || !fs.existsSync(t)) return 0;
    try {
      return fs
        .readFileSync(t, "utf8")
        .split(/\r?\n/)
        .reduce((t, n) => {
          if (!n.trim()) return t;
          try {
            let s = JSON.parse(n),
              a = s == null ? void 0 : s.message;
            return s.type === "message" && (a?.role === "user" || a?.role === "assistant")
              ? t + 1
              : t;
          } catch {
            return t;
          }
        }, 0);
    } catch {
      return 0;
    }
  }
  switchThread(e) {
    return this.threadHistory.switchThread(e)
      ? (this.clearExcludedContextFile(),
        this.syncCurrentThreadState(),
        this.saveThreadHistory(),
        !0)
      : !1;
  }
  /**
   * Release the runner a thread owns once that thread no longer needs it.
   *
   * A running runner is left alone: archiving stops a thread from being used again,
   * it does not cancel the run that is executing on it. A missing runner is a
   * no-op, and a failing release must not break the operation that asked for it.
   *
   * @param {string} threadId Thread whose idle runner is released.
   * @returns {boolean} Whether a runner was released.
   */
  disposeThreadRunner(threadId) {
    const runner = this.threadRunners.get(threadId);
    if (!runner || runner.isRunning) return false;
    try {
      runner.dispose();
    } catch (error) {
      console.warn("Pi Agent: could not dispose a thread runner", error);
    }
    this.threadRunners.delete(threadId);
    return true;
  }
  archiveThread(e = this.threadHistory.currentThreadId) {
    // Same contract as deleteThread(): a thread whose runner is running is not
    // archived, so the executing run keeps its runner and the thread keeps its
    // archived state.
    if (this.threadRunners.get(e)?.isRunning) return false;
    return this.threadHistory.archiveThread(e)
      ? (this.disposeThreadRunner(e), this.syncCurrentThreadState(), this.saveThreadHistory(), !0)
      : !1;
  }
  unarchiveThread(e) {
    return this.threadHistory.unarchiveThread(e)
      ? (this.syncCurrentThreadState(), this.saveThreadHistory(), !0)
      : !1;
  }
  archiveThreads(e) {
    // Running threads are skipped the way deleteThreads() skips them, and reported
    // back so the caller can see which requests were refused.
    const requested = new Set(e);
    const skippedIds = this.threadHistory
      .listThreads({ includeArchived: true })
      .filter((thread) => requested.has(thread.id) && this.threadRunners.get(thread.id)?.isRunning)
      .map((thread) => thread.id);
    const skipped = new Set(skippedIds);
    const archivedIds = this.threadHistory.archiveThreads(
      e.filter((threadId) => !skipped.has(threadId))
    );
    // An archived thread is not used again, so its idle runner is released with it.
    for (const threadId of archivedIds) this.disposeThreadRunner(threadId);
    if (archivedIds.length > 0) {
      this.syncCurrentThreadState();
      this.saveThreadHistory();
    }
    return {
      archivedIds,
      archivedCount: archivedIds.length,
      skippedIds,
      skippedCount: skippedIds.length
    };
  }
  deleteThread(e, options = {}) {
    const thread = this.threadHistory.getThread(e);
    if (!thread) return false;

    const runner = this.threadRunners.get(e);
    if (runner?.isRunning) return false;

    let sessionPath;
    if (options.deletePiSession && thread.piSessionId) {
      const resolver = runner ?? this.pi;
      sessionPath = resolver?.resolveSessionPath(thread.piSessionId);
      if (!sessionPath || !fs.existsSync(sessionPath)) return false;

      const sessionIsShared = this.threadHistory
        .listThreads({ includeArchived: true })
        .some(
          (other) =>
            other.id !== e &&
            other.piSessionId &&
            resolver.resolveSessionPath(other.piSessionId) === sessionPath
        );
      if (sessionIsShared) return false;
    }

    runner?.rpcClient?.dispose();
    this.threadRunners.delete(e);
    if (sessionPath) {
      try {
        fs.unlinkSync(sessionPath);
      } catch (error) {
        console.warn("Pi Agent: could not delete local Pi session", error);
        return false;
      }
    }

    return this.threadHistory.deleteThread(e)
      ? (this.clearExcludedContextFile(),
        this.syncCurrentThreadState(),
        this.saveThreadHistory(),
        true)
      : false;
  }
  deleteThreads(threadIds) {
    const requested = new Set(threadIds);
    const threads = this.threadHistory
      .listThreads({ includeArchived: true })
      .filter((thread) => requested.has(thread.id));
    const skippedIds = threads
      .filter((thread) => this.threadRunners.get(thread.id)?.isRunning)
      .map((thread) => thread.id);
    const skipped = new Set(skippedIds);
    const deleteIds = threads
      .filter((thread) => !skipped.has(thread.id))
      .map((thread) => thread.id);

    for (const threadId of deleteIds) {
      this.threadRunners.get(threadId)?.rpcClient?.dispose();
      this.threadRunners.delete(threadId);
    }

    const result = this.threadHistory.deleteThreads(deleteIds);
    if (result.deletedIds.length > 0) {
      this.syncCurrentThreadState();
      this.saveThreadHistory();
    }
    return {
      deletedIds: result.deletedIds,
      deletedCount: result.deletedIds.length,
      skippedIds,
      skippedCount: skippedIds.length,
      createdThreadId: result.createdThreadId
    };
  }
  clearArchivedThreads() {
    // A running archived thread is kept, exactly like deleteThreads() keeps one:
    // deleting its history first would leave a runner with no thread left to settle
    // into. It is picked up by a later clear, once its run has ended. The current
    // thread is kept too, because the store keeps it even when it is archived.
    const deleteIds = this.threadHistory
      .listThreads({ includeArchived: true })
      .filter(
        (thread) =>
          thread.archived &&
          thread.id !== this.threadHistory.currentThreadId &&
          !this.threadRunners.get(thread.id)?.isRunning
      )
      .map((thread) => thread.id);
    // deleteThreads() owns the lifecycle of a thread that goes away: it releases the
    // idle runner, clears its registry entry, deletes the history and saves.
    return this.deleteThreads(deleteIds).deletedCount;
  }
  renameThread(e, t) {
    const thread = this.threadHistory.getThread(e);
    const renamed = this.threadHistory.renameThread(e, t);
    if (!renamed) return false;

    this.syncCurrentThreadState();
    this.saveThreadHistory();
    if (thread?.piSessionId) {
      const sessionName = this.threadHistory.getThread(e)?.title ?? t;
      // A thread that already has a runner keeps it: that runner's client and Pi
      // process belong to the thread's own lifecycle (archive and delete release
      // them), so a rename neither releases nor replaces it. A thread that has no
      // runner borrows an ephemeral one instead of registering a thread runner: a
      // rename is not a chat run, so the runner it uses is released here once the
      // request has settled -- on success and on failure alike. The closure owns the
      // borrowed runner, so a runner another path creates for the same thread while
      // the request is in flight is never part of this cleanup.
      const existing = this.threadRunners.get(e);
      const runner = existing ?? this.createEphemeralThreadRunner();
      void runner
        .setSessionName(thread.piSessionId, sessionName)
        .catch((error) => {
          console.warn("Pi Agent: could not rename Pi session", error);
        })
        .finally(() => {
          if (existing) return;
          this.disposeEphemeralThreadRunner(runner);
        });
    }
    return true;
  }
  toggleThreadFavorite(e) {
    return this.threadHistory.toggleThreadFavorite(e)
      ? (this.syncCurrentThreadState(), this.saveThreadHistory(), !0)
      : !1;
  }
  getExtensionUiHandler() {
    // Built lazily and cached, because the handler closes over this plugin.
    this.extensionUiHandler ??= createExtensionUiHandler({
      select: (request) => showExtensionUiDialog(this.app, request),
      confirm: (request) => showExtensionUiDialog(this.app, request),
      input: (request) => showExtensionUiDialog(this.app, request),
      editor: (request) => showExtensionUiDialog(this.app, request),
      notify: (request) => {
        const prefix =
          request.notifyType === "error"
            ? "Error: "
            : request.notifyType === "warning"
              ? "Warning: "
              : "";
        new P.Notice(`${prefix}${String(request.message ?? "")}`);
      },
      setStatus: (request) => this.setExtensionStatus(request.statusKey, request.statusText),
      setWidget: (request) =>
        this.setExtensionWidget(request.widgetKey, request.widgetLines, request.widgetPlacement),
      setTitle: (request) => this.setExtensionTitle(request.title),
      set_editor_text: (request) => this.setExtensionEditorText(request.text)
    });
    return this.extensionUiHandler;
  }
  setExtensionStatus(key, text) {
    const statusKey = String(key || "extension");
    const statusText = sanitizeExtensionText(text);
    if (!statusText) this.extensionStatuses.delete(statusKey);
    else this.extensionStatuses.set(statusKey, statusText);
    this.renderExtensionStatuses();
  }
  renderExtensionStatuses() {
    renderExtensionStatuses(
      this.extensionStatusEl,
      this.extensionStatusElements,
      this.extensionStatuses,
      this.settings.showExtensionStatus
    );
  }
  async setShowExtensionStatus(value) {
    this.settings.showExtensionStatus = value;
    this.renderExtensionStatuses();
    await this.savePluginData();
  }
  setExtensionWidget(key, lines, placement = "aboveEditor") {
    const widgetKey = String(key || "extension");
    if (!Array.isArray(lines)) this.extensionWidgets.delete(widgetKey);
    else
      this.extensionWidgets.set(widgetKey, {
        lines: lines.map(sanitizeExtensionText),
        placement: placement === "belowEditor" ? "belowEditor" : "aboveEditor"
      });
    this.refreshExtensionUiViews();
  }
  setExtensionTitle(title) {
    this.extensionTitle = sanitizeExtensionText(title);
    this.refreshExtensionUiViews();
  }
  setExtensionEditorText(text) {
    const leaf = this.app.workspace.getLeavesOfType(T)[0];
    /** @type {any} */ (leaf?.view)?.setExtensionEditorText?.(String(text ?? ""));
  }
  refreshExtensionUiViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(T)) {
      /** @type {any} */ (leaf.view)?.renderExtensionWidgets?.();
      /** @type {any} */ (leaf).updateHeader?.();
    }
  }
  refreshAnnotationBadges() {
    for (const leaf of this.app.workspace.getLeavesOfType(T))
      /** @type {any} */ (leaf.view)?.renderToolBadges?.();
  }
  async activateView() {
    var n;
    let t = (n = this.app.workspace.getLeavesOfType(T)[0]) != null ? n : null;
    if (!t) {
      if (((t = this.app.workspace.getRightLeaf(!1)), !t)) {
        new P.Notice("Could not open Pi view.");
        return;
      }
      await t.setViewState({ type: T, active: !0 });
    }
    this.app.workspace.revealLeaf(t);
  }
  async runPiPrompt(e, t, n, i, images = [], promptContext) {
    var p;
    if (t != null && t.isCanceled && t.isCanceled()) throw new Error("Pi run canceled.");
    // Repair path: only the missing service parts are restored. This run's runner
    // is registered in `threadRunners` (and other threads' runners may be live), so
    // the rebuild must not release thread runners. A settings change still does.
    if (!this.graph || !this.contextBuilder || !this.pi)
      this.rebuildServices({ disposeThreadRunners: false });
    if (!this.graph || !this.contextBuilder || !this.pi)
      throw new Error("Pi services are not available.");
    // Resolved here, after the guard above, and never as a parameter default: a
    // default would capture `this.pi` on entry, and the guard can replace -- and
    // now dispose -- that runner before the run starts. A runner the caller passed
    // is left alone: a chat run's thread runner is not the service runner, and a
    // rebuild must not swap it out.
    i ??= this.pi;
    let s = this.getEditorSelection();
    if (
      e.trim().startsWith("/") &&
      getCompactInstructions(e) === undefined &&
      !this.commandCatalogLoaded
    )
      await this.refreshCommandCatalog(false);
    let a =
      getCompactInstructions(e) === undefined
        ? (promptContext ?? (await this.contextBuilder.build(e, s)))
        : void 0;
    if (t != null && t.isCanceled && t.isCanceled()) throw new Error("Pi run canceled.");
    if (isContextShowPrompt(e)) {
      return {
        finalResponse: formatContextShowResponse(a?.inspection),
        sessionId: n,
        threadId: n,
        events: [],
        contextUsage: undefined,
        contextCompacted: false,
        tokenUsage: undefined
      };
    }
    let o = n ? this.threadHistory.getThread(n) : this.threadHistory.getCurrentThread();
    if (!o) throw new Error("Chat thread no longer exists.");
    if (!i) throw new Error("Pi runner is not available.");
    let l = getPriorThreadHistory(o.messages, e);
    if (t != null && t.isCanceled && t.isCanceled()) throw new Error("Pi run canceled.");
    if (t != null && t.isCanceled && t.isCanceled()) throw new Error("Pi run canceled.");
    a &&
      ((p = t == null ? void 0 : t.onEvent) == null ||
        p.call(t, {
          type: "context_ready",
          raw: {
            searchResults: a.searchResults.length,
            linkedNeighborhood: a.linkedNeighborhood.length
          }
        }));
    if (t != null && t.isCanceled && t.isCanceled()) throw new Error("Pi run canceled.");
    let h = await i.run(e, a, o.piSessionId, l, t, images);
    return (
      h.sessionId &&
        (this.threadHistory.setThreadPiSessionId(o.id, h.sessionId),
        this.syncCurrentThreadState(),
        this.saveThreadHistory()),
      h
    );
  }
  setPromptEnricher(callback) {
    this.promptEnricher = typeof callback === "function" ? callback : undefined;
  }
  async enrichPromptDelivery(delivery, context) {
    const enriched = await applyPromptEnricher(delivery, this.promptEnricher, context);
    const hasAnnotationSnapshot = Object.prototype.hasOwnProperty.call(enriched, "annotations");
    const promptContext = await this.contextBuilder.build(
      enriched.prompt,
      this.getEditorSelection(),
      {
        ...(hasAnnotationSnapshot ? { annotations: enriched.annotations } : {}),
        activeNotePath: enriched.contextFilePath
      }
    );
    return { ...enriched, promptContext };
  }
  getLocalPromptQueue() {
    return this.localPromptQueue.map((item) => ({
      ...item,
      images: item.images.map((image) => ({ ...image })),
      attachments: item.attachments.map((attachment) => ({ ...attachment })),
      annotations: item.annotations.map((annotation) => ({ ...annotation }))
    }));
  }
  isLocalPromptQueuePaused() {
    return this.localPromptQueuePaused;
  }
  resumeLocalPromptQueue() {
    this.localPromptQueuePaused = false;
  }
  beginLocalPromptSteering(item) {
    if (!this.localPromptSteering.some((candidate) => candidate.id === item.id))
      this.localPromptSteering.push(item);
    this.saveThreadHistory();
  }
  finishLocalPromptSteering(id) {
    this.localPromptSteering = this.localPromptSteering.filter((item) => item.id !== id);
    this.saveThreadHistory();
  }
  replaceLocalPromptQueue(queue) {
    this.localPromptQueue = normalizeLocalPromptQueue(queue, { preserveState: true });
    this.saveThreadHistory();
  }
  enqueueLocalPrompt(item) {
    this.localPromptQueue = enqueueLocalPrompt(this.localPromptQueue, item);
    this.saveThreadHistory();
    return this.localPromptQueue.at(-1);
  }
  updateLocalPrompt(id, patch) {
    this.localPromptQueue = updateLocalPrompt(this.localPromptQueue, id, patch);
    this.saveThreadHistory();
  }
  removeLocalPrompt(id) {
    this.localPromptQueue = removeLocalPrompt(this.localPromptQueue, id);
    this.saveThreadHistory();
  }
  async ensureModelCatalogLoaded() {
    this.settings.availableModels.length === 0 && (await this.refreshModelCatalog(!1));
  }
  getModelInfoForTokenUsage(e) {
    if (!e) return;
    let t = e.modelId || (e.provider && e.model ? `${e.provider}/${e.model}` : "");
    if (t) {
      let n = this.settings.availableModels.find((s) => s.slug === t);
      if (n) return n;
    }
    return e.model
      ? this.settings.availableModels.find((n) => n.slug.endsWith(`/${e.model}`))
      : void 0;
  }
  getSelectedModelInfo(e) {
    let t = this.getModelInfoForTokenUsage(e);
    if (t) return t;
    let n = this.settings.model === b ? this.settings.customModel : this.settings.model;
    n || (n = this.settings.effectiveModel);
    return n ? this.settings.availableModels.find((s) => s.slug === n) : void 0;
  }
  async inspectPiContext(e) {
    // Service restore: only the missing service parts are rebuilt, so the thread
    // runners that are already in use are left alone.
    if (!this.graph || !this.contextBuilder) this.rebuildServices({ disposeThreadRunners: false });
    if (!this.contextBuilder) throw new Error("Pi context builder is not available.");
    return this.contextBuilder.inspectContext(e, this.getEditorSelection());
  }
  getCurrentContextFile() {
    this.refreshCurrentContextFile();
    return this.isExcludedContextFile(this.currentContextFile) ? void 0 : this.currentContextFile;
  }
  cancelPiRun(e) {
    var t;
    (e != null ? e : (t = this.pi) != null ? t : void 0)?.cancelCurrentRun();
  }
  /**
   * Request cancellation of every Pi run that is actually executing.
   *
   * Chat runs execute on the per-thread runner `PiAgentView.runPrompt()` created
   * for their thread, which lives in `threadRunners` -- not on `this.pi`, the
   * service-level runner used as a session resolver. Cancelling only that service
   * runner left real runs to be disposed mid-flight, which the run then reported
   * as the agent failure "Pi RPC client disposed.". The service runner is included
   * because `runPiPrompt()` still defaults to it.
   *
   * Never throws: `onunload()` must not be interrupted, and a runner without an
   * active run has nothing to abort.
   *
   * @returns {Promise<void>[]} The abort requests. Obsidian does not await
   * `onunload()`, so a caller may ignore them; see `onunload()` for why an
   * unawaited cancel still stops Pi.
   */
  cancelAllPiRuns() {
    const runners = new Set(this.threadRunners.values());
    if (this.pi) runners.add(this.pi);
    const aborts = [];
    for (const runner of runners) {
      if (!runner?.isRunning) continue;
      try {
        const abort = runner.cancelCurrentRun();
        if (abort) aborts.push(abort);
      } catch (error) {
        console.warn("Pi Agent: could not cancel a running Pi runner", error);
      }
    }
    return aborts;
  }
  createPiRunner(threadId = this.getCurrentThread().id) {
    // Service restore: this thread's runner may already be registered, so the
    // rebuild must not clear `threadRunners` and hand back a second runner for the
    // same thread.
    (!this.graph || !this.contextBuilder) && this.rebuildServices({ disposeThreadRunners: false });
    if (!this.contextBuilder) throw new Error("Pi context builder is not available.");
    const existing = this.threadRunners.get(threadId);
    if (existing) return existing;
    const runner = new PiRunner(
      this.settings,
      this.contextBuilder,
      this.getVaultBasePath(),
      this.getPluginDirectory(),
      undefined,
      this.getExtensionUiHandler()
    );
    // After unload a runner may still be requested by a queue drain or a stale
    // callback. Handing back an already disposed runner makes that request fail as
    // a cancel instead of spawning Pi behind an unloaded plugin.
    if (this.unloading) runner.dispose();
    this.threadRunners.set(threadId, runner);
    return runner;
  }
  disposeThreadRunners() {
    // Snapshot before clearing, so a runner that settles while this loop runs
    // cannot change what is being released.
    const runners = [...this.threadRunners.values()];
    this.threadRunners.clear();
    for (const runner of runners) {
      try {
        runner.dispose();
      } catch (error) {
        console.warn("Pi Agent: could not dispose a Pi runner", error);
      }
    }
  }
  /**
   * Replace the services the plugin's runners are built on.
   *
   * @param {{ disposeThreadRunners?: boolean }} [options] `disposeThreadRunners`
   *   defaults to true: the thread runners were built on the services being
   *   replaced, so a settings change releases them with it. A caller that only
   *   restores missing service parts while a run is already using its registered
   *   runner passes false, so a service rebuild cannot dispose that run's runner.
   */
  rebuildServices({ disposeThreadRunners = true } = {}) {
    this.modelCatalogGeneration += 1;
    this.modelCatalogRefreshedAt = 0;
    // Release the runners this rebuild replaces. Thread runners first, when this
    // rebuild owns them, then the service-level runner: it is overwritten further
    // down, and a Pi process it started would otherwise keep running with no owner
    // left to dispose it. The old runner has to be released before the new one is
    // created, not after the assignment.
    if (disposeThreadRunners) this.disposeThreadRunners();
    const previousServiceRunner = this.pi;
    if (previousServiceRunner) {
      try {
        previousServiceRunner.dispose();
      } catch (error) {
        // A failed release must not block the rebuild that is already in progress.
        console.warn("Pi Agent: could not dispose the previous Pi service runner", error);
      }
    }
    this.piCommands = [];
    this.commandCatalogLoaded = false;
    this.commandCatalogRefreshPromise = undefined;
    this.graph = new VaultGraph(this.app, this.settings, () => this.getCurrentContextFile());
    this.contextBuilder = new ContextBuilder(
      this.graph,
      this.settings,
      be,
      this.getVaultBasePath(),
      () => this.piCommands,
      (path) => this.getAnnotationsForContext(path)
    );
    this.catalog = new PiModelCatalog(this.getPluginDirectory(), this.settings);
    this.commandCatalog = new PiCommandCatalog(
      this.getPluginDirectory(),
      this.settings,
      this.getExtensionUiHandler()
    );
    this.pi = new PiRunner(
      this.settings,
      this.contextBuilder,
      this.getVaultBasePath(),
      this.getPluginDirectory(),
      undefined,
      this.getExtensionUiHandler()
    );
  }
  async consumeAnnotationsForPrompt(sourcePath) {
    this.annotationController?.cancelPick();
    const explicitFile = sourcePath ? this.app.vault.getAbstractFileByPath(sourcePath) : undefined;
    const file = explicitFile instanceof P.TFile ? explicitFile : this.getCurrentContextFile();
    if (!file) return [];
    const annotations = await this.getAnnotationsForContext(file.path);
    if (annotations.length > 0) this.annotationStore.deletePath(file.path);
    return annotations;
  }
  beginAnnotationProcessing(threadId, annotations) {
    this.annotationController?.beginProcessing(threadId, annotations);
  }
  completeAnnotationProcessingForPath(threadId, path) {
    this.annotationController?.completeProcessingForPath(threadId, path);
  }
  endAnnotationProcessingForThread(threadId) {
    this.annotationController?.endProcessingForThread(threadId);
  }
  restoreConsumedAnnotations(annotations) {
    const byPath = new Map();
    for (const annotation of Array.isArray(annotations) ? annotations : []) {
      if (!annotation?.path) continue;
      const items = byPath.get(annotation.path) ?? [];
      items.push(annotation);
      byPath.set(annotation.path, items);
    }
    try {
      for (const [path, items] of byPath) {
        const current = this.annotationStore.list(path);
        const ids = new Set(current.map((annotation) => annotation.id));
        this.annotationStore.replacePath(path, [
          ...current,
          ...items.filter((annotation) => !ids.has(annotation.id))
        ]);
      }
    } catch (error) {
      new P.Notice(
        error instanceof Error ? error.message : "Could not restore queued annotations."
      );
    }
  }
  async getAnnotationsForContext(path) {
    const annotations = this.annotationStore.list(path);
    if (annotations.length === 0) return annotations;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof P.TFile) || file.extension !== "md") return annotations;
    // Resolve against the exact current file at prompt time. Prefer an open
    // editor because vault reads can lag behind an unsaved CodeMirror change.
    const activeEditor = /** @type {any} */ (this.app.workspace.activeEditor);
    let content = activeEditor?.file?.path === path ? activeEditor.editor?.getValue?.() : undefined;
    if (typeof content !== "string") {
      const openLeaf = this.app.workspace.getLeavesOfType("markdown").find((leaf) => {
        const view = /** @type {any} */ (leaf.view);
        return view?.file?.path === path && view?.editor?.getValue;
      });
      content = /** @type {any} */ (openLeaf?.view)?.editor?.getValue?.();
    }
    if (typeof content !== "string") content = await this.app.vault.read(file);
    return this.annotationStore.reanchorPath(path, content);
  }
  syncCurrentThreadState() {
    this.messages = this.threadHistory.getCurrentMessages();
  }
  saveThreadHistory() {
    this.savePluginData().catch((e) => {
      console.warn("Pi Agent: failed to save thread history", e);
    });
  }
  saveAnnotations() {
    this.savePluginData().catch(() => {
      new P.Notice("Could not save annotations to plugin data.");
    });
  }
  savePluginData() {
    const history = sanitizeThreadHistory(this.threadHistory.toJSON());
    const data = {
      ...this.settings,
      chatHistory: history,
      localPromptQueue: this.localPromptQueue,
      localPromptSteering: this.localPromptSteering,
      annotationData: this.annotationStore.toJSON()
    };
    this.dataSaveChain = this.dataSaveChain
      .catch(() => {})
      .then(async () => {
        await this.saveData(data);
        await writeChatHistoryBackup(this.getPluginDirectory(), history);
      });
    return this.dataSaveChain;
  }
  refreshCurrentContextFile() {
    this.setCurrentContextFile(this.app.workspace.getActiveFile());
  }
  setCurrentContextFile(e) {
    this.currentContextFile = e && e.extension === "md" ? e : void 0;
    if (
      this.excludedContextPath &&
      this.currentContextFile &&
      this.currentContextFile.path !== this.excludedContextPath
    )
      this.excludedContextPath = void 0;
  }
  excludeContextFile(path) {
    this.excludedContextPath = path || void 0;
  }
  clearExcludedContextFile() {
    this.excludedContextPath = void 0;
  }
  isExcludedContextFile(file) {
    return Boolean(file && this.excludedContextPath && file.path === this.excludedContextPath);
  }
  runWithActiveMarkdownNote(e, t) {
    let n = this.app.workspace.getActiveFile(),
      s = !!n && n.extension === "md";
    if (e) return s;
    if (!s) {
      new P.Notice("Open a markdown note first.");
      return !1;
    }
    t();
    return !0;
  }
  async runCommandPrompt(e) {
    await this.activateView();
    let t = this.app.workspace.getLeavesOfType(T)[0],
      n = t == null ? void 0 : t.view;
    if (n instanceof PiAgentView) {
      n.runPrompt(e);
      return;
    }
    new P.Notice("Could not open Pi view.");
  }
  async runAnnotationsPrompt(path) {
    if (this.annotationStore.list(path).length === 0) {
      new P.Notice("There are no annotations to send for this note.");
      return;
    }
    await this.activateView();
    const view = this.app.workspace.getLeavesOfType(T)[0]?.view;
    if (!(view instanceof PiAgentView)) {
      new P.Notice("Could not open Pi view.");
      return;
    }
    await view.runAnnotationPrompt(
      "Follow every annotation's user-authored request. Batch non-overlapping Change annotations for this note into one targeted edit call, and answer each Question annotation without modifying its target.",
      path
    );
  }
  async suggestFrontmatterForCurrentNote() {
    var o;
    // Service restore: only the missing graph is rebuilt, so the thread runners
    // that are already in use are left alone.
    this.graph || this.rebuildServices({ disposeThreadRunners: false });
    let e = (o = this.graph) == null ? void 0 : o.getActiveFile();
    if (!e) {
      new P.Notice("Open a markdown note first.");
      return;
    }
    let t = await this.app.vault.cachedRead(e),
      n = new Date().toISOString().slice(0, 10),
      s = previewFrontmatterPatch(t, {
        type: "note",
        status: "draft",
        updated: n,
        tags: this.inferTags(e, t)
      }),
      a = {
        id: `${Date.now()}-${e.path}`,
        path: e.path,
        before: t,
        after: s,
        reason: "Add baseline Pi-suggested frontmatter",
        frontmatterPatch: {
          type: "note",
          status: "draft",
          updated: n,
          tags: this.inferTags(e, t)
        }
      };
    new ApprovalModal(this, a, () => {}).open();
  }
  inferTags(e, t) {
    var a, o, l;
    let n = new Set(),
      s = (a = e.parent) == null ? void 0 : a.path;
    if (s && s !== "/") {
      n.add(
        (l = (o = s.split("/").pop()) == null ? void 0 : o.toLowerCase().replace(/\s+/g, "-")) !=
          null
          ? l
          : ""
      );
    }
    for (let d of t.matchAll(/#([A-Za-z0-9/_-]+)/g)) n.add(d[1]);
    return [...n].filter(Boolean).slice(0, 6);
  }
  getEditorSelection() {
    var n;
    let e = this.app.workspace.activeEditor,
      t = e == null ? void 0 : e.editor;
    return (n = t == null ? void 0 : t.getSelection()) != null ? n : "";
  }
  getVaultBasePath() {
    var t;
    let e = /** @type {any} */ (this.app.vault.adapter);
    return (t = e.getBasePath) == null ? void 0 : t.call(e);
  }
  getPluginDirectory() {
    var a;
    let e = this.getVaultBasePath();
    if (!e) return;
    const configDir = this.app.vault.configDir;
    let t = (a = this.manifest.dir) != null ? a : `plugins/${this.manifest.id}`,
      n = e.replace(/\/+$/, ""),
      s = t.replace(/^\/+/, "");
    if (s.startsWith(`${configDir}/`)) {
      return n.endsWith(`/${configDir}`) ? `${n}/${s.slice(configDir.length + 1)}` : `${n}/${s}`;
    }
    return n.endsWith(`/${configDir}`) ? `${n}/${s}` : `${n}/${configDir}/${s}`;
  }
}
function isStoredChatHistory(history) {
  return (
    history &&
    typeof history === "object" &&
    !Array.isArray(history) &&
    Array.isArray(history.threads) &&
    history.threads.length > 0
  );
}
function historiesMatch(left, right) {
  return (
    isStoredChatHistory(left) &&
    JSON.stringify(sanitizeThreadHistory(left)) === JSON.stringify(sanitizeThreadHistory(right))
  );
}
function isLegacyBareModelId(model) {
  return !model.includes("/") && model !== "__custom";
}
function getPriorThreadHistory(r, i) {
  let e = r[r.length - 1];
  const isCurrentAttachmentOnlyMessage =
    i === "" && /^\[\d+ attached (?:image|file)s?\]$/.test(e?.content || "");
  return e?.role === "user" && (e.content === i || isCurrentAttachmentOnlyMessage)
    ? r.slice(0, -1)
    : r;
}
