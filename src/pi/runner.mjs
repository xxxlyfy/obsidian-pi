import fs from "node:fs";
import path from "node:path";
import { getConfiguredSkillPaths } from "../context/skills.mjs";
import { CUSTOM_MODEL_VALUE } from "../plugin/settings.mjs";
import { createContextUsage } from "./token-usage.mjs";
import { handlePiJsonEventLine } from "./events.mjs";
import { PiRpcClient } from "./rpc-client.mjs";
import { PiRunCanceledError } from "./run-canceled.mjs";
import { toRpcImages } from "../shared/prompt-payload.mjs";

/**
 * What a finished run returns to the caller.
 *
 * @typedef {{
 *   finalResponse: string,
 *   sessionId?: string,
 *   threadId?: string,
 *   events: import("./events.mjs").RunEvent[],
 *   contextUsage?: any,
 *   contextCompacted?: boolean,
 *   tokenUsage?: import("./token-usage.mjs").TokenUsage,
 *   runtimeState?: any
 * }} RunResult
 */

export function getCompactInstructions(prompt) {
  const match = prompt.trim().match(/^\/compact(?:\s+([\s\S]+))?$/i);
  return match ? (match[1] ?? "").trim() : undefined;
}

export class PiRunner {
  constructor(
    settings,
    contextBuilder,
    workingDirectory,
    pluginDirectory,
    rpcClient,
    extensionUiHandler
  ) {
    this.settings = settings;
    this.contextBuilder = contextBuilder;
    this.workingDirectory = workingDirectory;
    this.pluginDirectory = pluginDirectory;
    this.rpcClient = rpcClient;
    this.extensionUiHandler = extensionUiHandler;
    this.cancelRequested = false;
    /**
     * A force-terminated runner must never run again. The registry replaces it,
     * so a late finalizer can only ever touch this dead object.
     */
    this.invalid = false;
  }

  async run(prompt, context, sessionId, threadHistory = [], callbacks, images = []) {
    // One runner belongs to one thread and can only host one run: two views on
    // the same chat must not interleave on the same Pi process.
    if (this.invalid) throw new Error("This agent runner was force-stopped and cannot be reused.");
    if (this.isRunning)
      throw new Error("This chat already has an active run. Wait for it to finish or cancel it.");
    if (callbacks?.isCanceled?.()) throw new PiRunCanceledError();
    const compactInstructions = getCompactInstructions(prompt);
    if (compactInstructions !== undefined)
      return this.settings.dryRun
        ? this.formatDryRunCompactResponse(sessionId)
        : this.runPiRpcCompact(sessionId, compactInstructions, callbacks);

    const effectivePrompt = context?.userPrompt ?? prompt;
    const formattedPrompt = this.contextBuilder.formatPrompt(
      effectivePrompt,
      context,
      threadHistory
    );
    if (callbacks?.isCanceled?.()) throw new PiRunCanceledError();

    return this.settings.dryRun
      ? {
          finalResponse: this.formatDryRunResponse(prompt, context),
          sessionId,
          threadId: sessionId,
          events: []
        }
      : this.runPiRpc(formattedPrompt, sessionId, callbacks, images);
  }

  cancelCurrentRun() {
    this.cancelRequested = true;
    this.rpcClient?.abort();
  }

  /**
   * Hard stop used by the runtime's cancel watchdog.
   *
   * The runner becomes invalid and must never run again:
   * - its current RPC client is disposed and dropped, so no later run can
   *   inherit the wedged process
   * - `run()` rejects on an invalid runner
   * - the registry replaces it on the next `create(threadId)`, and the
   *   replacement builds its own fresh RPC client
   */
  forceTerminate() {
    this.invalid = true;
    const client = this.rpcClient;
    this.rpcClient = undefined;
    this.rpcSession = undefined;
    client?.dispose?.();
    this.cancelRequested = false;
    this.isRunning = false;
  }

  async getOrCreateRpcClient(sessionReference) {
    if (this.rpcClient) {
      const client = this.rpcClient;
      this.rpcSession ??= this.resolveOrCreateSession(sessionReference);
      try {
        await client.start();
        return { client, session: this.rpcSession };
      } catch (error) {
        this.resetRpcClientAfterStartupFailure(client);
        throw error;
      }
    }

    const session = this.resolveOrCreateSession(sessionReference);
    const client = new PiRpcClient({
      piExecutablePath: this.settings.piExecutablePath,
      cwd: this.workingDirectory ?? this.pluginDirectory,
      args: this.buildPiArgs(session.path, "rpc"),
      extensionUiHandler: this.extensionUiHandler
    });
    this.rpcClient = client;
    this.rpcSession = session;
    try {
      await client.start();
      return { client, session };
    } catch (error) {
      this.resetRpcClientAfterStartupFailure(client);
      throw error;
    }
  }

  resetRpcClientAfterStartupFailure(client) {
    client.dispose?.();
    if (this.rpcClient === client) this.rpcClient = undefined;
    this.rpcSession = undefined;
  }

  async runPiRpc(prompt, sessionId, callbacks, images = []) {
    if (!this.pluginDirectory) throw new Error("Plugin directory is not available.");
    if (callbacks?.isCanceled?.()) throw new PiRunCanceledError();

    this.cancelRequested = false;
    this.isRunning = true;
    let unsubscribe = () => {};
    let client;
    try {
      let session;
      ({ client, session } = await this.getOrCreateRpcClient(sessionId));
      if (this.cancelRequested || callbacks?.isCanceled?.()) throw new PiRunCanceledError();

      const runtimeState = await client.request("get_state").catch(() => undefined);
      const events = [];
      let finalResponse = "";
      /** @type {{ errorMessage?: string, fallbackText?: string, tokenUsage?: import("./token-usage.mjs").TokenUsage } | undefined} */
      let runState;
      let settled = false;
      let settleRun;
      let rejectRun;
      const completion = new Promise((resolve, reject) => {
        settleRun = resolve;
        rejectRun = reject;
      });
      completion.catch(() => {});
      const updateRunState = (nextRunState) => {
        if (nextRunState) runState = { ...runState, ...nextRunState };
      };
      unsubscribe = client.subscribe((event) => {
        if (event.type === "rpc_exit") {
          if (!settled) rejectRun(new Error(event.error || "Pi RPC process stopped."));
          return;
        }
        handlePiJsonEventLine(
          JSON.stringify(event),
          callbacks,
          events,
          (delta) => {
            finalResponse += delta;
          },
          updateRunState
        );
        if (event.type === "agent_settled" && !settled) {
          settled = true;
          settleRun();
        }
      });

      callbacks?.onEvent?.({
        type: "pi_start",
        raw: { mode: "rpc", cwd: this.workingDirectory ?? this.pluginDirectory }
      });

      const rpcImages = toRpcImages(images);
      const promptRequest = client.request("prompt", {
        message: prompt,
        ...(rpcImages.length > 0 ? { images: rpcImages } : {})
      });
      await promptRequest;
      callbacks?.onPromptAccepted?.();
      await completion;
      if (this.cancelRequested || callbacks?.isCanceled?.()) throw new PiRunCanceledError();
      if (runState?.errorMessage) throw new Error(runState.errorMessage);
      return {
        finalResponse: this.getFinalResponse(finalResponse, runState?.fallbackText, events),
        sessionId: session.reference,
        threadId: session.reference,
        events,
        contextUsage: this.getRunContextUsage(runState?.tokenUsage, events),
        contextCompacted: this.didCompactContext(events),
        tokenUsage: runState?.tokenUsage ?? undefined,
        runtimeState
      };
    } catch (error) {
      const rpcError =
        /** @type {Error & { piRpcUncertain?: boolean, piRpcRequestType?: string }} */ (error);
      if (this.cancelRequested || callbacks?.isCanceled?.()) throw new PiRunCanceledError(error);
      if (rpcError?.piRpcUncertain) {
        await this.recoverUncertainRpcClient(client);
        throw new Error(
          `Pi RPC ${rpcError.piRpcRequestType ?? "request"} timed out. The agent process was restarted to avoid overlapping runs.`,
          { cause: error }
        );
      }
      throw error;
    } finally {
      this.cancelRequested = false;
      this.isRunning = false;
      unsubscribe();
    }
  }

  async recoverUncertainRpcClient(client) {
    if (!client) return;
    await client.abort?.();
    client.dispose?.();
    await client.waitForExit?.();
    if (this.rpcClient === client) {
      this.rpcClient = undefined;
      this.rpcSession = undefined;
    }
  }

  async steer(prompt, images = []) {
    if (!this.isRunning || !this.rpcClient) throw new Error("This agent run has already settled.");
    const client = this.rpcClient;
    const rpcImages = toRpcImages(images);
    try {
      await client.request("steer", {
        message: String(prompt || ""),
        ...(rpcImages.length > 0 ? { images: rpcImages } : {})
      });
    } catch (error) {
      const rpcError =
        /** @type {Error & { piRpcUncertain?: boolean, piRpcRequestType?: string }} */ (error);
      if (rpcError?.piRpcUncertain) {
        await this.recoverUncertainRpcClient(client);
        throw new Error(
          `Pi RPC ${rpcError.piRpcRequestType ?? "steer"} timed out. The agent process was restarted to avoid overlapping runs.`,
          { cause: error }
        );
      }
      throw error;
    }
  }

  async runPiRpcCompact(sessionId, customInstructions = "", callbacks) {
    if (!this.pluginDirectory) throw new Error("Plugin directory is not available.");
    if (callbacks?.isCanceled?.()) throw new PiRunCanceledError();

    this.cancelRequested = false;
    this.isRunning = true;
    let unsubscribe = () => {};
    try {
      const { client, session } = await this.getOrCreateRpcClient(sessionId);
      if (this.cancelRequested || callbacks?.isCanceled?.()) throw new PiRunCanceledError();

      const events = [];
      unsubscribe = client.subscribe((event) => {
        handlePiJsonEventLine(
          JSON.stringify(event),
          callbacks,
          events,
          () => {},
          () => {}
        );
      });
      const result = await client.request(
        "compact",
        {
          ...(customInstructions ? { customInstructions } : {})
        },
        { timeoutMs: 0 }
      );
      if (this.cancelRequested || callbacks?.isCanceled?.()) throw new PiRunCanceledError();
      return {
        finalResponse: "Context compacted.",
        sessionId: session.reference,
        threadId: session.reference,
        events,
        contextUsage: undefined,
        contextCompacted: true,
        tokenUsage: undefined,
        compactionResult: result
      };
    } catch (error) {
      if (this.cancelRequested || callbacks?.isCanceled?.()) throw new PiRunCanceledError(error);
      throw error;
    } finally {
      this.cancelRequested = false;
      this.isRunning = false;
      unsubscribe();
    }
  }

  getFinalResponse(finalResponse, fallbackText, events, isCommandPrompt = false) {
    const response = (finalResponse.trim() || (fallbackText || "").trim()).trim();
    if (response) return response;

    const compactionEnd = [...events]
      .reverse()
      .find((event) => this.normalizeCompactionEventType(event.type) === "compaction_end");
    if (!compactionEnd || !isCommandPrompt) return response;
    if (compactionEnd.raw?.errorMessage)
      return `Context compaction failed: ${String(compactionEnd.raw.errorMessage)}`;
    if (compactionEnd.raw?.aborted) return "Context compaction skipped.";
    return "Context compacted.";
  }

  getRunContextUsage(tokenUsage, events = []) {
    if (this.didCompactContext(events)) return undefined;

    const model = this.getModelInfoForTokenUsage(tokenUsage) ?? this.getSelectedModelInfo();
    const contextWindow = model?.contextWindow ?? tokenUsage?.contextWindow ?? 0;
    return createContextUsage(tokenUsage, contextWindow);
  }

  didCompactContext(events = []) {
    return events.some((event) => {
      if (this.normalizeCompactionEventType(event.type) !== "compaction_end") return false;
      return !event.raw?.errorMessage && !event.raw?.aborted;
    });
  }

  normalizeCompactionEventType(type) {
    return type === "auto_compaction_start" || type === "session_before_compact"
      ? "compaction_start"
      : type === "auto_compaction_end" || type === "session_compact"
        ? "compaction_end"
        : type;
  }

  getModelInfoForTokenUsage(tokenUsage) {
    if (!tokenUsage) return undefined;

    const modelId =
      tokenUsage.modelId ||
      (tokenUsage.provider && tokenUsage.model ? `${tokenUsage.provider}/${tokenUsage.model}` : "");
    if (modelId) {
      const exactMatch = this.settings.availableModels.find((model) => model.slug === modelId);
      if (exactMatch) return exactMatch;
    }

    return tokenUsage.model
      ? this.settings.availableModels.find((model) => model.slug.endsWith(`/${tokenUsage.model}`))
      : undefined;
  }

  getSelectedModelInfo() {
    let modelId =
      this.settings.model === CUSTOM_MODEL_VALUE ? this.settings.customModel : this.settings.model;
    if (!modelId) modelId = this.settings.effectiveModel;

    return modelId
      ? this.settings.availableModels.find((model) => model.slug === modelId)
      : undefined;
  }

  buildPiArgs(sessionId, mode = "rpc") {
    const args = ["--mode", mode, "--session", sessionId];
    const selectedModel =
      this.settings.model === CUSTOM_MODEL_VALUE ? this.settings.customModel : this.settings.model;
    // Keep an empty plugin selection as "Pi default", but launch the runtime
    // with the concrete default Pi reported to the picker. This avoids Pi's
    // unknown/unknown startup fallback without introducing a second model change.
    const model = selectedModel || this.settings.effectiveModel;
    if (model) {
      const separator = model.indexOf("/");
      if (separator <= 0 || separator === model.length - 1) {
        throw new Error(`Invalid Pi model ID: ${model}. Expected provider/model.`);
      }
      args.push("--provider", model.slice(0, separator), "--model", model.slice(separator + 1));
    }
    if (this.settings.reasoningEffort) args.push("--thinking", this.settings.reasoningEffort);
    const instructions = this.contextBuilder.getSystemInstructions?.();
    if (instructions) args.push("--append-system-prompt", instructions);
    if (this.settings.includeDefaultSkills === false) args.push("--no-skills");

    for (const skillPath of getConfiguredSkillPaths(this.settings, this.workingDirectory)) {
      args.push("--skill", skillPath);
    }

    const toolMode =
      this.settings.sandboxMode === "workspace-write" ? "edit" : this.settings.sandboxMode;
    if (toolMode === "chat") {
      args.push("--no-tools");
    } else if (toolMode !== "full-agent") {
      args.push(
        "--tools",
        toolMode === "edit" ? "read,grep,find,ls,edit,write" : "read,grep,find,ls"
      );
    }

    return args;
  }

  getSessionDirectory() {
    return path.resolve(this.pluginDirectory ?? ".", "pi-sessions");
  }

  createSessionFilePath() {
    const sessionDir = this.getSessionDirectory();
    fs.mkdirSync(sessionDir, { recursive: true });

    return path.join(sessionDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  }

  createSessionReference(sessionPath) {
    const sessionDir = this.getSessionDirectory();
    const relativePath = path.relative(sessionDir, path.resolve(sessionPath));

    return relativePath && isSafeRelativePath(relativePath) ? relativePath : undefined;
  }

  resolveSessionPath(sessionReference) {
    if (!sessionReference) return undefined;

    const sessionDir = this.getSessionDirectory();
    const resolvedPath = path.isAbsolute(sessionReference)
      ? path.resolve(sessionReference)
      : path.resolve(sessionDir, sessionReference);
    const relativePath = path.relative(sessionDir, resolvedPath);

    if (!relativePath || !isSafeRelativePath(relativePath)) return undefined;

    return resolvedPath;
  }

  resolveOrCreateSession(sessionReference) {
    const existingPath = this.resolveSessionPath(sessionReference);
    const sessionPath =
      existingPath && fs.existsSync(existingPath) ? existingPath : this.createSessionFilePath();

    return {
      path: sessionPath,
      reference: this.createSessionReference(sessionPath) ?? sessionPath
    };
  }

  async getExistingSessionRpcClient(sessionReference) {
    const sessionPath = this.resolveSessionPath(sessionReference);
    if (!sessionPath || !fs.existsSync(sessionPath)) {
      throw new Error("The local Pi session file is not available.");
    }
    return this.getOrCreateRpcClient(sessionReference);
  }

  async cloneSession(sessionReference) {
    const { client } = await this.getExistingSessionRpcClient(sessionReference);
    const result = await client.request("clone");
    if (result?.cancelled) return undefined;

    const state = await client.request("get_state");
    const cloneReference = this.createSessionReference(state?.sessionFile);
    const clonePath = this.resolveSessionPath(cloneReference);
    if (!clonePath || !fs.existsSync(clonePath)) {
      throw new Error("Pi did not return a portable local clone session.");
    }
    return cloneReference;
  }

  async getSessionStats(sessionReference) {
    const { client } = await this.getExistingSessionRpcClient(sessionReference);
    return client.request("get_session_stats");
  }

  async setSessionName(sessionReference, name) {
    const { client } = await this.getExistingSessionRpcClient(sessionReference);
    return client.request("set_session_name", { name });
  }

  async exportSession(sessionReference, outputPath) {
    const { client } = await this.getExistingSessionRpcClient(sessionReference);
    return client.request("export_html", outputPath ? { outputPath } : {});
  }

  async getSessionTree(sessionReference) {
    const { client } = await this.getExistingSessionRpcClient(sessionReference);
    return client.request("get_tree");
  }

  async getSessionEntries(sessionReference, since) {
    const { client } = await this.getExistingSessionRpcClient(sessionReference);
    return client.request("get_entries", since ? { since } : {});
  }

  formatDryRunCompactResponse(sessionId) {
    return {
      finalResponse: "Dry run: context would be compacted.",
      sessionId,
      threadId: sessionId,
      events: [],
      contextCompacted: true
    };
  }

  formatDryRunResponse(prompt, context) {
    const lines = [
      "Dry run: Pi CLI was not called.",
      "",
      `Prompt: ${prompt}`,
      "",
      context.activeNote
        ? `Active note: [[${context.activeNote.path.replace(/\.md$/i, "")}]]`
        : "Active note: none",
      `Automatic search results: ${context.searchResults.length}`,
      `Linked notes: ${context.linkedNeighborhood.length}`
    ];

    if (context.activeNote) {
      lines.push(
        "",
        "Backlinks:",
        ...context.activeNote.backlinks
          .slice(0, 8)
          .map((backlink) => `- [[${backlink.path.replace(/\.md$/i, "")}]] (${backlink.count})`),
        "",
        "Outgoing links:",
        ...context.activeNote.outgoingLinks
          .slice(0, 8)
          .map(
            (outgoingLink) =>
              `- [[${outgoingLink.path.replace(/\.md$/i, "")}]] (${outgoingLink.count})`
          ),
        "",
        "Unresolved links:",
        ...context.activeNote.unresolvedLinks
          .slice(0, 8)
          .map((unresolvedLink) => `- [[${unresolvedLink.display}]] (${unresolvedLink.count})`)
      );
    }

    if (context.searchResults.length > 0) {
      lines.push(
        "",
        "Automatic note matches:",
        ...context.searchResults.map(
          (result) => `- [[${result.path.replace(/\.md$/i, "")}]] score=${result.score}`
        )
      );
    }

    return lines.join("\n");
  }
}

function isSafeRelativePath(relativePath) {
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}
