import { STRINGS } from "../shared/strings.mjs";
import * as P from "obsidian";
import { AgentRuntime } from "../agent/agent-runtime.mjs";
import { ThreadService } from "../threads/thread-service.mjs";
import { PluginStore } from "../persistence/plugin-store.mjs";
import { AnnotationStore } from "../annotations/annotation-store.mjs";
import { MarkdownAnnotationsController } from "../annotations/markdown-annotations-controller.mjs";
import { ContextBuilder } from "../context/context-builder.mjs";
import { formatContextShowResponse, isContextShowPrompt } from "../context/context-show.mjs";
import { normalizeSkillFolderList } from "../context/skills.mjs";
import { VaultGraph } from "../context/vault-graph.mjs";
import { VaultIndex } from "../context/vault-index.mjs";
import { checkPiInstallation, warmupPiCli } from "../pi/health.mjs";
import { PiRunCanceledError } from "../pi/run-canceled.mjs";
import { PiCommandCatalog } from "../pi/command-catalog.mjs";
import { createExtensionUiHandler } from "../pi/extension-ui.mjs";
import { PiModelCatalog } from "../pi/model-catalog.mjs";
import { getCompactInstructions, PiRunner } from "../pi/runner.mjs";
import { CUSTOM_MODEL_VALUE, DEFAULT_SETTINGS, normalizeSettings } from "./settings.mjs";
import { PiAgentSettingTab } from "./settings-tab.mjs";
import {
  PI_AGENT_DISPLAY_NAME,
  PI_AGENT_ICON_ID,
  PI_AGENT_ICON_SVG,
  PI_AGENT_VIEW_TYPE
} from "./constants.mjs";
import { ApprovalModal } from "../ui/modals/approval-modal.mjs";
import { PiSetupModal } from "../ui/modals/pi-setup-modal.mjs";
import { showExtensionUiDialog } from "../ui/modals/extension-ui-modal.mjs";
import { PiAgentView } from "../ui/PiAgentView.mjs";
import { requestDesktopNotificationPermission } from "../ui/desktop-notifications.mjs";
import { previewFrontmatterPatch } from "../shared/frontmatter.mjs";
import { sanitizeThreadHistory } from "../shared/thread-history.mjs";
import {
  importVaultChatHistory,
  removeImportedVaultChatHistory
} from "../threads/chat-history-import.mjs";
import { ThreadStore } from "../threads/thread-store.mjs";
import { ThreadRunnerRegistry } from "./thread-runners.mjs";
import {
  enqueueLocalPrompt,
  invalidateLocalPromptPaths,
  migrateLocalPromptPaths,
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
function previewSuggestedFrontmatter(markdown, patch) {
  return previewFrontmatterPatch(markdown, patch);
}
export class PiAgentPlugin extends P.Plugin {
  /**
   * @param {import("obsidian").App} app
   * @param {import("obsidian").PluginManifest} manifest
   */
  constructor(app, manifest) {
    super(app, manifest);
    this.settings = DEFAULT_SETTINGS;
    this.threadHistory = new ThreadStore();
    this.annotationStore = new AnnotationStore();
    this.store = this.createPluginStore();
    this.threadRunners = new ThreadRunnerRegistry(() => this.buildPiRunner());
    this.threads = this.buildThreadService();
    /** @type {any} */
    this.extensionUiHandler = undefined;
    /** @type {Map<string, { mtimeMs: number, size: number, count: number }> | undefined} */
    this.piSessionCountCache = undefined;
    this.piCommands = [];
    this.commandCatalogLoaded = false;
    this.commandCatalogRefreshPromise = undefined;
    this.extensionStatuses = new Map();
    this.extensionWidgets = new Map();
    this.extensionTitle = "";
    this.localPromptQueue = [];
    this.localPromptSteering = [];
    this.localPromptQueuePaused = false;
    this.promptEnricher = undefined;
    this.modelCatalogRefreshGate = new RuntimeCatalogRefreshGate();
    this.modelCatalogRefreshedAt = 0;
    this.modelCatalogGeneration = 0;
    this.modelCatalogError = "";
  }
  async onload() {
    await this.loadSettings();

    if (!P.Platform.isDesktopApp) {
      new P.Notice(STRINGS.plugin.desktopOnly);
      return;
    }

    if (this.settings.desktopNotifications)
      void requestDesktopNotificationPermission().catch(() => {});

    (0, P.addIcon)(PI_AGENT_ICON_ID, PI_AGENT_ICON_SVG);
    this.extensionStatusEl = this.addStatusBarItem();
    this.vaultIndex = new VaultIndex({ app: this.app });
    this.vaultIndex.start((eventRef) => this.registerEvent(eventRef));
    this.rebuildServices();
    this.annotationController = new MarkdownAnnotationsController(this);
    this.annotationController.start();

    if (!this.settings.dryRun) {
      warmupPiCli(this.settings.piExecutablePath, this.getPluginDirectory());
    }

    // Runtime catalogs are loaded on demand by their pickers. Agent runs use
    // Pi directly and must not depend on background discovery processes.
    this.refreshCurrentContextFile();

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.setCurrentContextFile(file);
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.refreshCurrentContextFile();
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof P.TFile)) return;
        if (file.extension === "md") {
          this.migrateQueuedAnnotationPaths(oldPath, file.path);
          if (
            this.annotationStore.list(oldPath).length > 0 &&
            !this.annotationStore.renamePath(oldPath, file.path)
          )
            new P.Notice(STRINGS.plugin.annotationsCouldNotFollow);
        } else {
          this.migrateQueuedAttachmentPaths(oldPath, file.path);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof P.TFile) || file.extension !== "md") return;
        this.annotationStore.deletePath(file.path);
        this.invalidateQueuedAnnotationPaths(file.path);
      })
    );
    this.registerView(PI_AGENT_VIEW_TYPE, (leaf) => new PiAgentView(leaf, this));
    this.addRibbonIcon(PI_AGENT_ICON_ID, STRINGS.plugin.openAgent(PI_AGENT_DISPLAY_NAME), () => {
      this.activateView();
    });
    this.addCommand({
      id: "open-pi",
      name: STRINGS.plugin.commandOpenChat,
      callback: () => {
        this.activateView();
      }
    });
    this.addCommand({
      id: "toggle-annotations",
      name: STRINGS.plugin.commandToggleAnnotations,
      checkCallback: (checking) =>
        this.runWithActiveMarkdownNote(checking, () => {
          this.annotationController?.handleActiveMarkdownNote();
        })
    });
    this.addCommand({
      id: "check-pi-installation",
      name: `Check ${PI_BRAND_NAME} installation`,
      callback: () => {
        void this.checkPiInstallation(true);
      }
    });
    this.addCommand({
      id: "ask-about-current-note",
      name: STRINGS.plugin.commandAskCurrentNote,
      checkCallback: (checking) =>
        this.runWithActiveMarkdownNote(checking, () => {
          this.runCommandPrompt(
            "Use the active note as context. Summarize the key facts, assumptions, and useful follow-up questions."
          );
        })
    });
    this.addCommand({
      id: "research-around-current-note",
      name: STRINGS.plugin.commandResearchCurrentNote,
      checkCallback: (checking) =>
        this.runWithActiveMarkdownNote(checking, () => {
          this.runCommandPrompt(
            "Research around the active note using backlinks, outgoing links, unresolved links, tags, and search results. Return concise findings with vault references."
          );
        })
    });
    this.addCommand({
      id: "suggest-frontmatter",
      name: STRINGS.plugin.commandSuggestFrontmatter,
      checkCallback: (checking) =>
        this.runWithActiveMarkdownNote(checking, () => {
          this.suggestFrontmatterForCurrentNote();
        })
    });
    this.addCommand({
      id: "draft-base-from-current-note",
      name: STRINGS.plugin.commandDraftBase,
      checkCallback: (checking) =>
        this.runWithActiveMarkdownNote(checking, () => {
          this.runCommandPrompt(
            "Draft an Obsidian Base for notes related to the active note. Infer useful fields from frontmatter, tags, backlinks, and linked notes."
          );
        })
    });
    this.settingsTab = new PiAgentSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
  }
  onunload() {
    this.annotationController?.destroy();
    this.cancelPiRun();
    this.threadRunners.disposeAll();
    // Obsidian cannot await unload; this is a best-effort write of anything the
    // debounced save still holds. The debounce window is short on purpose.
    void this.store.flush();
  }
  async loadSettings() {
    const rawData = await this.store.load();
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
        console.warn(STRINGS.plugin.historyImportFailed, error);
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
      restoredHistory = await this.store.readBackupHistory();
      if (restoredHistory) new P.Notice(STRINGS.plugin.historyRecovered);
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
    this.threads = this.buildThreadService();
    this.annotationStore = new AnnotationStore(annotationData, () => {
      this.saveAnnotations();
      this.annotationController?.refresh();
      this.refreshAnnotationBadges();
    });
    if (this.settings.model && isLegacyBareModelId(this.settings.model)) {
      this.settings.customModel = `openai/${this.settings.model}`;
      this.settings.model = "__custom";
    }

    if (importedHistory?.history) {
      await this.savePluginData();
      const persisted = (await this.loadData())?.chatHistory;
      if (!historiesMatch(persisted, this.threadHistory.toJSON())) {
        throw new Error(STRINGS.plugin.verifyImportFailed);
      }
      await removeImportedVaultChatHistory(
        this.getVaultBasePath(),
        importedHistory.managedFiles,
        this.app.vault
      );
      if (importedHistory.warnings.length > 0) {
        console.warn(STRINGS.plugin.historyUnrecognizedFiles, importedHistory.warnings);
        new P.Notice(STRINGS.plugin.historyRestoredPartially);
      } else {
        new P.Notice(STRINGS.plugin.historyRestored);
      }
    }
  }
  async saveSettings() {
    // Invalidate before the first await so an older catalog request cannot win
    // the race against settings persistence or a service restart.
    this.modelCatalogGeneration += 1;
    this.modelCatalogRefreshedAt = 0;
    try {
      await this.savePluginData();
    } catch (error) {
      new P.Notice(
        STRINGS.plugin.settingsSaveFailed(error instanceof Error ? error.message : String(error))
      );
      return;
    }
    if (this.hasActivePiRuns()) this.pendingServiceRebuild = true;
    else this.rebuildServices();
  }
  hasActivePiRuns() {
    return this.threadRunners.hasActive();
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
      if (!this.settings.dismissedPiSetup) void this.checkPiInstallation(false);
    }, 800);
  }
  checkPiInstallation(showSuccess) {
    return checkPiInstallation(this.settings.piExecutablePath).then((result) => {
      if (result.ok) {
        showSuccess && new P.Notice(STRINGS.plugin.cliAvailable(result.version || result.message));
        return result;
      }

      showSuccess ? new P.Notice(result.message) : new PiSetupModal(this, result).open();
      return result;
    });
  }
  async refreshModelCatalog(showNotice = false, force = true) {
    if (!force && !needsRuntimeCatalogRefresh(this.settings, this.modelCatalogRefreshedAt)) {
      return { ok: true, stale: false };
    }
    const result = await this.modelCatalogRefreshGate.run(() => this.performModelCatalogRefresh());
    if (showNotice) {
      new P.Notice(
        result.ok
          ? STRINGS.plugin.modelsLoaded(
              this.settings.availableModels.length,
              this.settings.effectiveModel
            )
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
        if (!catalog) throw new Error(STRINGS.plugin.modelServiceNotReady);

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
      console.warn(STRINGS.plugin.modelCatalogFailed, error);
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
    for (const leaf of this.app.workspace.getLeavesOfType(PI_AGENT_VIEW_TYPE)) {
      const view = /** @type {any} */ (leaf.view);
      view?.runSettings?.refresh?.();
    }
    this.settingsTab?.display?.();
  }
  async refreshCommandCatalog(showNotice = false) {
    if (this.commandCatalogRefreshPromise) return this.commandCatalogRefreshPromise;
    this.commandCatalog || this.rebuildServices();
    this.commandCatalogRefreshPromise = (async () => {
      try {
        this.piCommands = (await this.commandCatalog?.getCommands(this.getVaultBasePath())) ?? [];
        this.commandCatalogLoaded = true;
        if (showNotice) new P.Notice(STRINGS.plugin.commandsLoaded(this.piCommands.length));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (showNotice) new P.Notice(message);
        console.warn(STRINGS.plugin.commandsFailed, error);
      }
      return this.piCommands;
    })().finally(() => {
      this.commandCatalogRefreshPromise = undefined;
    });
    return this.commandCatalogRefreshPromise;
  }
  getPiCommands() {
    return this.piCommands;
  }
  getExtensionUiHandler() {
    this.extensionUiHandler ??= createExtensionUiHandler({
      select: (request) => showExtensionUiDialog(this.app, request),
      confirm: (request) => showExtensionUiDialog(this.app, request),
      input: (request) => showExtensionUiDialog(this.app, request),
      editor: (request) => showExtensionUiDialog(this.app, request),
      notify: (request) => {
        const prefix =
          request.notifyType === "error"
            ? STRINGS.plugin.errorPrefix
            : request.notifyType === "warning"
              ? STRINGS.plugin.warningPrefix
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
    if (text === undefined || text === null || text === "")
      this.extensionStatuses.delete(statusKey);
    else this.extensionStatuses.set(statusKey, String(text));
    this.extensionStatusEl?.setText([...this.extensionStatuses.values()].join(" · "));
  }
  setExtensionWidget(key, lines, placement = "aboveEditor") {
    const widgetKey = String(key || "extension");
    if (!Array.isArray(lines)) this.extensionWidgets.delete(widgetKey);
    else
      this.extensionWidgets.set(widgetKey, {
        lines: lines.map(String),
        placement: placement === "belowEditor" ? "belowEditor" : "aboveEditor"
      });
    this.refreshExtensionUiViews();
  }
  setExtensionTitle(title) {
    this.extensionTitle = String(title || "");
    this.refreshExtensionUiViews();
  }
  setExtensionEditorText(text) {
    const leaf = this.app.workspace.getLeavesOfType(PI_AGENT_VIEW_TYPE)[0];
    const view = /** @type {any} */ (leaf?.view);
    view?.setExtensionEditorText?.(String(text ?? ""));
  }
  refreshExtensionUiViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(PI_AGENT_VIEW_TYPE)) {
      const view = /** @type {any} */ (leaf.view);
      view?.renderExtensionWidgets?.();
      /** @type {any} */ (leaf).updateHeader?.();
    }
  }
  refreshAnnotationBadges() {
    for (const leaf of this.app.workspace.getLeavesOfType(PI_AGENT_VIEW_TYPE)) {
      const view = /** @type {any} */ (leaf.view);
      view?.renderToolBadges?.();
    }
  }
  async activateView() {
    /** @type {import("obsidian").WorkspaceLeaf | null} */
    let leaf = this.app.workspace.getLeavesOfType(PI_AGENT_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        new P.Notice(STRINGS.plugin.couldNotOpenView);
        return;
      }
      await leaf.setViewState({ type: PI_AGENT_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }
  async runPiPrompt(prompt, callbacks, threadId, runner = this.pi, images = [], promptContext) {
    if (callbacks?.isCanceled?.()) throw new PiRunCanceledError();
    if (
      ((!this.graph || !this.contextBuilder || !this.pi) && this.rebuildServices(),
      !this.graph || !this.contextBuilder || !this.pi)
    )
      throw new Error(STRINGS.plugin.servicesUnavailable);
    const selection = this.getEditorSelection();
    if (
      prompt.trim().startsWith("/") &&
      getCompactInstructions(prompt) === undefined &&
      !this.commandCatalogLoaded
    )
      await this.refreshCommandCatalog(false);
    const context =
      getCompactInstructions(prompt) === undefined
        ? (promptContext ??
          (await /** @type {ContextBuilder} */ (this.contextBuilder).build(prompt, selection)))
        : undefined;
    if (callbacks?.isCanceled?.()) throw new PiRunCanceledError();
    if (isContextShowPrompt(prompt)) {
      return {
        finalResponse: formatContextShowResponse(context?.inspection),
        sessionId: threadId,
        threadId: threadId,
        events: [],
        contextUsage: undefined,
        contextCompacted: false,
        tokenUsage: undefined
      };
    }
    const thread = threadId ? this.threads.getThread(threadId) : this.threads.currentThread;
    if (!thread) throw new Error(STRINGS.plugin.threadGone);
    if (!runner) throw new Error(STRINGS.plugin.runnerUnavailable);
    const history = getPriorThreadHistory(thread.messages, prompt);
    if (callbacks?.isCanceled?.()) throw new PiRunCanceledError();
    if (context) {
      callbacks?.onEvent?.({
        type: "context_ready",
        raw: {
          searchResults: context.searchResults.length,
          linkedNeighborhood: context.linkedNeighborhood.length
        }
      });
    }
    if (callbacks?.isCanceled?.()) throw new PiRunCanceledError();
    const result = await runner.run(
      prompt,
      context,
      thread.piSessionId,
      history,
      callbacks,
      images
    );
    if (result.sessionId) this.threads.setThreadSessionId(thread.id, result.sessionId);
    return result;
  }
  setPromptEnricher(callback) {
    this.promptEnricher = typeof callback === "function" ? callback : undefined;
  }
  async enrichPromptDelivery(delivery, context) {
    const enriched = await applyPromptEnricher(delivery, this.promptEnricher, context);
    const hasAnnotationSnapshot = Object.prototype.hasOwnProperty.call(enriched, "annotations");
    const promptContext = await /** @type {ContextBuilder} */ (this.contextBuilder).build(
      enriched.prompt,
      this.getEditorSelection(),
      {
        ...(hasAnnotationSnapshot ? { annotations: enriched.annotations } : {}),
        activeNotePath: enriched.contextFilePath,
        includeActiveNote: enriched.includeActiveNote !== false
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
  migrateQueuedAnnotationPaths(oldPath, newPath) {
    if (!oldPath || !newPath || oldPath === newPath) return;
    this.migrateQueuedPaths(oldPath, newPath);
    this.migrateOpenViewInFlightAnnotations(oldPath, newPath);
  }
  migrateQueuedAttachmentPaths(oldPath, newPath) {
    if (!oldPath || !newPath || oldPath === newPath) return;
    this.migrateQueuedPaths(oldPath, newPath);
  }
  migrateQueuedPaths(oldPath, newPath) {
    this.localPromptQueue = migrateLocalPromptPaths(this.localPromptQueue, oldPath, newPath);
    this.localPromptSteering = migrateLocalPromptPaths(this.localPromptSteering, oldPath, newPath);
    this.saveThreadHistory();
    this.refreshOpenQueueViews();
  }
  invalidateQueuedAnnotationPaths(path) {
    if (!path) return;
    this.localPromptQueue = invalidateLocalPromptPaths(this.localPromptQueue, path);
    this.localPromptSteering = invalidateLocalPromptPaths(this.localPromptSteering, path);
    this.saveThreadHistory();
    this.refreshOpenQueueViews();
    this.invalidateOpenViewInFlightAnnotations(path);
  }
  forEachOpenView(callback) {
    for (const leaf of this.app.workspace.getLeavesOfType(PI_AGENT_VIEW_TYPE)) {
      const view = /** @type {any} */ (leaf.view);
      if (view) callback(view);
    }
  }
  refreshOpenQueueViews() {
    this.forEachOpenView((view) => view.refreshLocalPromptQueue?.());
  }
  migrateOpenViewInFlightAnnotations(oldPath, newPath) {
    this.forEachOpenView((view) => view.migrateInFlightAnnotationPaths?.(oldPath, newPath));
  }
  invalidateOpenViewInFlightAnnotations(path) {
    this.forEachOpenView((view) => view.invalidateInFlightAnnotationPaths?.(path));
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
    this.settings.availableModels.length === 0 && (await this.refreshModelCatalog(false));
  }
  getModelInfoForTokenUsage(tokenUsage) {
    if (!tokenUsage) return undefined;
    const modelId =
      tokenUsage.modelId ||
      (tokenUsage.provider && tokenUsage.model ? `${tokenUsage.provider}/${tokenUsage.model}` : "");
    if (modelId) {
      const match = this.settings.availableModels.find((model) => model.slug === modelId);
      if (match) return match;
    }
    return tokenUsage.model
      ? this.settings.availableModels.find((model) => model.slug.endsWith(`/${tokenUsage.model}`))
      : undefined;
  }
  getSelectedModelInfo(tokenUsage) {
    const tokenUsageModel = this.getModelInfoForTokenUsage(tokenUsage);
    if (tokenUsageModel) return tokenUsageModel;
    let modelId =
      this.settings.model === CUSTOM_MODEL_VALUE ? this.settings.customModel : this.settings.model;
    if (!modelId) modelId = this.settings.effectiveModel;
    return modelId
      ? this.settings.availableModels.find((model) => model.slug === modelId)
      : undefined;
  }
  async inspectPiContext(prompt) {
    if (((!this.graph || !this.contextBuilder) && this.rebuildServices(), !this.contextBuilder))
      throw new Error(STRINGS.plugin.contextBuilderUnavailable);
    return this.contextBuilder.inspectContext(prompt, this.getEditorSelection());
  }
  getCurrentContextFile() {
    return (this.refreshCurrentContextFile(), this.currentContextFile);
  }
  cancelPiRun(runner) {
    (runner ?? this.pi)?.cancelCurrentRun();
  }
  /**
   * Creates the run lifecycle owner for one view. Every view gets its own
   * runtime so in-flight run records are never shared between views.
   *
   * @returns {AgentRuntime}
   */
  createAgentRuntime() {
    return new AgentRuntime({
      runPrompt: (request, callbacks) =>
        this.runPiPrompt(
          request.prompt,
          callbacks,
          request.threadId,
          request.runner,
          request.images ?? [],
          request.promptContext
        ),
      createRunner: (threadId) => this.createPiRunner(threadId),
      cancelRunner: (runner) => this.cancelPiRun(runner),
      now: () => Date.now()
    });
  }
  createPiRunner(threadId = this.threads.currentThreadId) {
    return this.threadRunners.create(threadId);
  }
  buildPiRunner() {
    (!this.graph || !this.contextBuilder) && this.rebuildServices();
    if (!this.contextBuilder) throw new Error(STRINGS.plugin.contextBuilderUnavailable);
    return new PiRunner(
      this.settings,
      this.contextBuilder,
      this.getVaultBasePath(),
      this.getPluginDirectory(),
      undefined,
      this.getExtensionUiHandler()
    );
  }
  async withSessionRunner(threadId, action) {
    return this.threadRunners.withRunner(threadId, action);
  }
  rebuildServices() {
    this.modelCatalogGeneration += 1;
    this.modelCatalogRefreshedAt = 0;
    this.threadRunners.disposeAll();
    this.piCommands = [];
    this.commandCatalogLoaded = false;
    this.graph = new VaultGraph(
      this.app,
      this.settings,
      () => this.getCurrentContextFile(),
      this.vaultIndex
    );
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
    if (sourcePath) {
      const explicitFile = this.app.vault.getAbstractFileByPath(sourcePath);
      if (!(explicitFile instanceof P.TFile) || explicitFile.extension !== "md") {
        new P.Notice(STRINGS.plugin.annotationNoteGone);
        return [];
      }
      const annotations = await this.getAnnotationsForContext(explicitFile.path);
      if (annotations.length > 0) this.annotationStore.deletePath(explicitFile.path);
      return annotations;
    }
    const file = this.getCurrentContextFile();
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
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof P.TFile) || file.extension !== "md") continue;
        const current = this.annotationStore.list(path);
        const ids = new Set(current.map((annotation) => annotation.id));
        this.annotationStore.replacePath(path, [
          ...current,
          ...items.filter((annotation) => !ids.has(annotation.id))
        ]);
      }
    } catch (error) {
      new P.Notice(
        error instanceof Error ? error.message : STRINGS.plugin.annotationsRestoreFailed
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
    const activeEditor = this.app.workspace.activeEditor;
    let content =
      activeEditor && activeEditor.file?.path === path
        ? activeEditor.editor?.getValue?.()
        : undefined;
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
  buildThreadService() {
    return new ThreadService({
      store: this.threadHistory,
      runners: this.threadRunners,
      createRunner: (threadId) => this.createPiRunner(threadId),
      getDefaultRunner: () => this.pi,
      persist: () => this.saveThreadHistory()
    });
  }
  createPluginStore() {
    return new PluginStore({
      loadData: () => this.loadData(),
      saveData: (data) => this.saveData(data),
      getPluginDirectory: () => this.getPluginDirectory(),
      buildPayload: () => this.buildPluginData(),
      onSaveError: (error) => console.warn(STRINGS.plugin.historySaveFailed, error)
    });
  }
  buildPluginData() {
    return {
      ...this.settings,
      chatHistory: sanitizeThreadHistory(this.threadHistory.toJSON()),
      localPromptQueue: this.localPromptQueue,
      localPromptSteering: this.localPromptSteering,
      annotationData: this.annotationStore.toJSON()
    };
  }
  /** Coalesced save for the frequent thread/queue mutations. */
  saveThreadHistory() {
    this.store.schedule();
  }
  saveAnnotations() {
    this.store.saveNow().catch(() => {
      new P.Notice(STRINGS.plugin.annotationSaveFailed);
    });
  }
  /** Immediate serialized write (settings, model catalog, import verification). */
  savePluginData() {
    return this.store.saveNow();
  }
  refreshCurrentContextFile() {
    this.setCurrentContextFile(this.app.workspace.getActiveFile());
  }
  setCurrentContextFile(file) {
    this.currentContextFile = file && file.extension === "md" ? file : undefined;
  }
  runWithActiveMarkdownNote(checking, action) {
    const activeFile = this.app.workspace.getActiveFile();
    const isMarkdown = !!activeFile && activeFile.extension === "md";
    if (checking) return isMarkdown;
    if (!isMarkdown) {
      new P.Notice(STRINGS.plugin.openMarkdownFirst);
      return false;
    }
    action();
    return true;
  }
  async runCommandPrompt(prompt) {
    await this.activateView();
    const leaf = this.app.workspace.getLeavesOfType(PI_AGENT_VIEW_TYPE)[0];
    const view = leaf?.view;
    if (view instanceof PiAgentView) {
      view.startPrompt(prompt);
      return;
    }
    new P.Notice(STRINGS.plugin.couldNotOpenView);
  }
  async runAnnotationsPrompt(path) {
    if (this.annotationStore.list(path).length === 0) {
      new P.Notice(STRINGS.plugin.noAnnotationsToSend);
      return;
    }
    await this.activateView();
    const view = this.app.workspace.getLeavesOfType(PI_AGENT_VIEW_TYPE)[0]?.view;
    if (!(view instanceof PiAgentView)) {
      new P.Notice(STRINGS.plugin.couldNotOpenView);
      return;
    }
    try {
      await view.runAnnotationPrompt(
        "Follow every annotation's user-authored request. Batch non-overlapping Change annotations for this note into one targeted edit call, and answer each Question annotation without modifying its target.",
        path
      );
    } catch (error) {
      new P.Notice(error instanceof Error ? error.message : String(error));
    }
  }
  async suggestFrontmatterForCurrentNote() {
    this.graph || this.rebuildServices();
    const file = this.graph?.getActiveFile();
    if (!file) {
      new P.Notice(STRINGS.plugin.openMarkdownFirst);
      return;
    }
    const content = await this.app.vault.cachedRead(file);
    const today = new Date().toISOString().slice(0, 10);
    const after = previewSuggestedFrontmatter(content, {
      type: "note",
      status: "draft",
      updated: today,
      tags: this.inferTags(file, content)
    });
    const patch = {
      id: `${Date.now()}-${file.path}`,
      path: file.path,
      before: content,
      after,
      reason: "Add baseline Pi-suggested frontmatter",
      frontmatterPatch: {
        type: "note",
        status: "draft",
        updated: today,
        tags: this.inferTags(file, content)
      }
    };
    new ApprovalModal(this, patch, () => {}).open();
  }
  inferTags(file, content) {
    const tags = new Set();
    const folderPath = file.parent?.path;
    if (folderPath && folderPath !== "/") {
      const folderName = folderPath.split("/").pop();
      if (folderName) tags.add(folderName.toLowerCase().replace(/\s+/g, "-"));
    }
    for (const match of content.matchAll(/#([A-Za-z0-9/_-]+)/g)) tags.add(match[1]);
    return [...tags].filter(Boolean).slice(0, 6);
  }
  getEditorSelection() {
    const activeEditor = this.app.workspace.activeEditor;
    return activeEditor?.editor?.getSelection() ?? "";
  }
  getVaultBasePath() {
    return /** @type {any} */ (this.app.vault.adapter).getBasePath?.();
  }
  getPluginDirectory() {
    const basePath = this.getVaultBasePath();
    if (!basePath) return undefined;
    const configDir = this.app.vault.configDir;
    const relativeDir = this.manifest.dir ?? `plugins/${this.manifest.id}`;
    const normalizedBase = basePath.replace(/\/+$/, "");
    const normalizedDir = relativeDir.replace(/^\/+/, "");
    if (normalizedDir.startsWith(`${configDir}/`)) {
      return normalizedBase.endsWith(`/${configDir}`)
        ? `${normalizedBase}/${normalizedDir.slice(configDir.length + 1)}`
        : `${normalizedBase}/${normalizedDir}`;
    }
    return normalizedBase.endsWith(`/${configDir}`)
      ? `${normalizedBase}/${normalizedDir}`
      : `${normalizedBase}/${configDir}/${normalizedDir}`;
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
function getPriorThreadHistory(messages, prompt) {
  let lastMessage = messages[messages.length - 1];
  const isCurrentAttachmentOnlyMessage =
    prompt === "" && /^\[\d+ attached (?:image|file)s?\]$/.test(lastMessage?.content || "");
  return lastMessage?.role === "user" &&
    (lastMessage.content === prompt || isCurrentAttachmentOnlyMessage)
    ? messages.slice(0, -1)
    : messages;
}
