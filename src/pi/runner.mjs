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
  }

  async run(prompt, context, sessionId, threadHistory = [], callbacks, images = []) {
    if (callbacks?.isCanceled?.()) throw new Error("Pi run canceled.");
    const compactInstructions = getCompactInstructions(prompt);
    if (compactInstructions !== undefined)
      return this.runPiRpcCompact(sessionId, compactInstructions, callbacks);

    const effectivePrompt = context?.userPrompt ?? prompt;
    const formattedPrompt = this.contextBuilder.formatPrompt(
      effectivePrompt,
      context,
      threadHistory
    );
    if (callbacks?.isCanceled?.()) throw new Error("Pi run canceled.");

    return this.runPiRpc(formattedPrompt, sessionId, callbacks, images);
  }

  cancelCurrentRun() {
    this.cancelRequested = true;
    this.rpcClient?.abort();
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
    if (callbacks?.isCanceled?.()) throw new Error("Pi run canceled.");

    this.cancelRequested = false;
    this.isRunning = true;
    let unsubscribe = () => {};
    try {
      const { client, session } = await this.getOrCreateRpcClient(sessionId);
      if (this.cancelRequested || callbacks?.isCanceled?.()) throw new Error("Pi run canceled.");

      const runtimeState = await client.request("get_state").catch(() => undefined);
      const state = createRunState();
      let settled = false;
      let settleRun;
      let rejectRun;
      const completion = new Promise((resolve, reject) => {
        settleRun = resolve;
        rejectRun = reject;
      });
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
      await completion;
      if (this.cancelRequested || callbacks?.isCanceled?.()) throw new Error("Pi run canceled.");
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
      if (this.cancelRequested || callbacks?.isCanceled?.())
        throw new Error("Pi run canceled.", { cause: error });
      throw error;
    } finally {
      this.cancelRequested = false;
      this.isRunning = false;
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
    if (callbacks?.isCanceled?.()) throw new Error("Pi run canceled.");

    this.cancelRequested = false;
    this.isRunning = true;
    let unsubscribe = () => {};
    try {
      const { client, session } = await this.getOrCreateRpcClient(sessionId);
      if (this.cancelRequested || callbacks?.isCanceled?.()) throw new Error("Pi run canceled.");

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
      if (this.cancelRequested || callbacks?.isCanceled?.()) throw new Error("Pi run canceled.");
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
      if (this.cancelRequested || callbacks?.isCanceled?.())
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
