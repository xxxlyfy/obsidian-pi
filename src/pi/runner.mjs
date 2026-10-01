import fs from "node:fs";
import path from "node:path";
import { getConfiguredSkillPaths } from "../context/skills.mjs";
import { CUSTOM_MODEL_VALUE } from "../plugin/settings.mjs";
import { createContextUsage } from "./token-usage.mjs";
import { handlePiEvent } from "./events.mjs";
import { createRunState } from "./run-state.mjs";
import { PiRpcClient } from "./rpc-client.mjs";
import { toRpcImages } from "../ui/prompt-payload.mjs";

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
    // Terminal. Set once by dispose() and never cleared, so a disposed runner can
    // neither continue nor start a Pi process.
    this.disposed = false;
    /**
     * Rejection handle of the run that is currently waiting for Pi's final event,
     * when there is one. `dispose()` uses it because that wait is not a pending
     * RPC request, so disposing the client could not wake the run by itself.
     *
     * @type {((error: Error) => void) | undefined}
     */
    this.runCompletionRejector = undefined;
  }

  /**
   * Whether this runner must treat its current (or next) run as canceled: the
   * caller asked Pi to abort, or the runner was disposed by the plugin.
   *
   * @returns {boolean}
   */
  get cancelPending() {
    return this.cancelRequested || this.disposed;
  }

  async run(prompt, context, sessionId, threadHistory = [], callbacks, images = []) {
    if (this.cancelPending || callbacks?.isCanceled?.()) throw new Error("Pi run canceled.");
    const compactInstructions = getCompactInstructions(prompt);
    if (compactInstructions !== undefined)
      return this.runPiRpcCompact(sessionId, compactInstructions, callbacks);

    const effectivePrompt = context?.userPrompt ?? prompt;
    const formattedPrompt = this.contextBuilder.formatPrompt(
      effectivePrompt,
      context,
      threadHistory
    );
    if (this.cancelPending || callbacks?.isCanceled?.()) throw new Error("Pi run canceled.");

    return this.runPiRpc(formattedPrompt, sessionId, callbacks, images);
  }

  /**
   * Ask the run that is executing on this runner to stop.
   *
   * Synchronous on purpose. The abort request is written to Pi's stdin before this
   * method returns, so a caller that has to tear the runner down in the same tick
   * -- plugin unload, which Obsidian does not await -- cannot preempt the request
   * with a dispose. `PiRpcClient.abort()` terminates the process tree itself when
   * the request cannot be delivered, so an unawaited cancel still stops Pi.
   *
   * @returns {Promise<void> | undefined} Settles with the abort request; callers
   * that cannot await it (Obsidian's `onunload()`) may ignore it.
   */
  cancelCurrentRun() {
    this.cancelRequested = true;
    const client = this.rpcClient;
    if (!client) return undefined;
    try {
      return Promise.resolve(client.abort()).catch(() => {});
    } catch (error) {
      console.warn("Pi Agent: could not request a Pi run abort", error);
      return undefined;
    }
  }

  /**
   * Release this runner for good and let any run it still carries settle.
   *
   * Disposal only frees resources; asking a live run to stop stays
   * `cancelCurrentRun()`'s job and the plugin always cancels first. Disposal does
   * have to finish what a cancel started: it marks the runner as canceled instead
   * of letting the closed client surface as an agent failure, and it settles a run
   * that is waiting for a final event the disposed client can no longer deliver.
   * After this call the runner cannot start Pi again.
   */
  dispose() {
    this.disposed = true;
    const client = this.rpcClient;
    this.rpcClient = undefined;
    this.rpcSession = undefined;
    const rejectRun = this.runCompletionRejector;
    this.runCompletionRejector = undefined;
    rejectRun?.(new Error("Pi RPC client disposed."));
    client?.dispose();
  }

  async getOrCreateRpcClient(sessionReference) {
    // A disposed runner must never spawn another Pi process, not even when a
    // stale callback or a queue drain still asks it for one.
    if (this.disposed) throw new Error("Pi run canceled.");
    if (this.rpcClient) {
      const client = this.rpcClient;
      this.rpcSession ??= this.resolveOrCreateSession(sessionReference);
      try {
        await client.start();
        // Disposed while Pi was starting: the process this start just produced has
        // no owner left, so it is taken down here instead of leaking.
        if (this.disposed) throw new Error("Pi run canceled.");
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
      if (this.disposed) throw new Error("Pi run canceled.");
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
    if (this.cancelPending || callbacks?.isCanceled?.()) throw new Error("Pi run canceled.");

    this.cancelRequested = false;
    this.isRunning = true;
    let unsubscribe = () => {};
    try {
      const { client, session } = await this.getOrCreateRpcClient(sessionId);
      if (this.cancelPending || callbacks?.isCanceled?.()) throw new Error("Pi run canceled.");

      const runtimeState = await client.request("get_state").catch(() => undefined);
      const state = createRunState();
      let settled = false;
      let settleRun;
      let rejectRun;
      const completion = new Promise((resolve, reject) => {
        settleRun = resolve;
        rejectRun = reject;
      });
      // Claim the rejection as soon as the promise exists. An rpc_exit can arrive
      // while the prompt request below is still pending, so rejectRun() may run
      // before `await completion` attaches its handler, and Node would report an
      // unhandled rejection even though the run still settles correctly. This
      // handler only marks the promise as handled; the result is still consumed
      // by `await completion`.
      completion.catch(() => {});
      unsubscribe = client.subscribe((event) => {
        if (event.type === "rpc_exit") {
          if (!settled) rejectRun(new Error(event.error || "Pi RPC process stopped."));
          return;
        }
        // Parsed objects flow straight into the event handler; no
        // JSON.stringify -> JSON.parse round trip on the persistent RPC path.
        handlePiEvent(event, state, callbacks);
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
      // From here the run waits for Pi's final event, which no pending RPC request
      // can wake. Hand dispose() the rejection handle so releasing the runner
      // settles the run instead of leaving it pending forever.
      this.runCompletionRejector = rejectRun;
      await completion;
      if (this.cancelPending || callbacks?.isCanceled?.()) throw new Error("Pi run canceled.");
      if (state.errorMessage) throw new Error(state.errorMessage);
      return {
        finalResponse: this.getFinalResponse(state),
        sessionId: session.reference,
        threadId: session.reference,
        contextUsage: this.getRunContextUsage(state.tokenUsage, state),
        contextCompacted: state.sawSuccessfulCompaction,
        tokenUsage: state.tokenUsage ?? undefined,
        runtimeState,
        diagnostics: state.diagnostics.snapshot()
      };
    } catch (error) {
      if (this.cancelPending || callbacks?.isCanceled?.())
        throw new Error("Pi run canceled.", { cause: error });
      throw error;
    } finally {
      this.cancelRequested = false;
      this.isRunning = false;
      this.runCompletionRejector = undefined;
      unsubscribe();
    }
  }

  async steer(prompt, images = []) {
    if (!this.isRunning || !this.rpcClient) throw new Error("This agent run has already settled.");
    const rpcImages = toRpcImages(images);
    await this.rpcClient.request("steer", {
      message: String(prompt || ""),
      ...(rpcImages.length > 0 ? { images: rpcImages } : {})
    });
  }

  async runPiRpcCompact(sessionId, customInstructions = "", callbacks) {
    if (!this.pluginDirectory) throw new Error("Plugin directory is not available.");
    if (this.cancelPending || callbacks?.isCanceled?.()) throw new Error("Pi run canceled.");

    this.cancelRequested = false;
    this.isRunning = true;
    let unsubscribe = () => {};
    try {
      const { client, session } = await this.getOrCreateRpcClient(sessionId);
      if (this.cancelPending || callbacks?.isCanceled?.()) throw new Error("Pi run canceled.");

      const state = createRunState();
      unsubscribe = client.subscribe((event) => {
        handlePiEvent(event, state, callbacks);
      });
      const result = await client.request(
        "compact",
        {
          ...(customInstructions ? { customInstructions } : {})
        },
        { timeoutMs: 0 }
      );
      if (this.cancelPending || callbacks?.isCanceled?.()) throw new Error("Pi run canceled.");
      return {
        finalResponse: "Context compacted.",
        sessionId: session.reference,
        threadId: session.reference,
        contextUsage: undefined,
        contextCompacted: true,
        tokenUsage: undefined,
        compactionResult: result,
        diagnostics: state.diagnostics.snapshot()
      };
    } catch (error) {
      if (this.cancelPending || callbacks?.isCanceled?.())
        throw new Error("Pi run canceled.", { cause: error });
      throw error;
    } finally {
      this.cancelRequested = false;
      this.isRunning = false;
      unsubscribe();
    }
  }

  getFinalResponse(state, isCommandPrompt = false) {
    const response = (state.finalResponse.trim() || (state.fallbackText || "").trim()).trim();
    if (response) return response;

    const lastCompactionEnd = state.lastCompactionEnd;
    if (!lastCompactionEnd || !isCommandPrompt) return response;
    if (lastCompactionEnd.errorMessage)
      return `Context compaction failed: ${String(lastCompactionEnd.errorMessage)}`;
    if (lastCompactionEnd.aborted) return "Context compaction skipped.";
    return "Context compacted.";
  }

  getRunContextUsage(tokenUsage, state) {
    if (state?.sawSuccessfulCompaction) return undefined;

    const model = this.getModelInfoForTokenUsage(tokenUsage) ?? this.getSelectedModelInfo();
    const contextWindow = model?.contextWindow ?? tokenUsage?.contextWindow ?? 0;
    return createContextUsage(tokenUsage, contextWindow);
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
}

function isSafeRelativePath(relativePath) {
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}
