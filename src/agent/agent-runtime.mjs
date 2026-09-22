import { isPiRunCanceled } from "../pi/run-canceled.mjs";
import { RUN_STATUS, RunStateStore } from "./run-state.mjs";

/**
 * @typedef {object} PromptRunRequest
 * @property {string} threadId
 * @property {string} prompt
 * @property {any[]} [images]
 * @property {any} [promptContext]
 * @property {any} [runner]          Runner created by `createRunner` when omitted.
 */

/**
 * @typedef {object} RunCallbacks
 * @property {() => boolean} isCanceled
 * @property {(event: import("../pi/events.mjs").RunEvent) => void} [onEvent]
 * @property {(delta: string) => void} [onTextDelta]
 * @property {() => void} [onPromptAccepted]
 */

/**
 * @typedef {object} RunHooks
 * @property {(run: import("./run-state.mjs").RunRecord) => void} [onStarted]
 * @property {(event: import("../pi/events.mjs").RunEvent) => void} [onEvent]
 * @property {(delta: string) => void} [onTextDelta]
 * @property {() => void} [onPromptAccepted]
 */

/**
 * @typedef {object} AgentRuntimePorts
 * @property {(request: PromptRunRequest, callbacks: RunCallbacks) => Promise<import("../pi/runner.mjs").RunResult>} runPrompt
 * @property {(threadId: string) => any} [createRunner]
 * @property {(runner: any) => void} [cancelRunner]
 * @property {() => number} [now]
 */

/**
 * Owns the lifecycle of every Pi run: start, cancel, retry, steer, compact, and
 * event routing. It knows nothing about Obsidian, the DOM, or notifications.
 *
 * All callbacks handed to Pi are wrapped so that events arriving after a run has
 * settled, after a cancel, or from a previous run inside the same thread are
 * dropped instead of mutating live state.
 */
export class AgentRuntime {
  /** @param {AgentRuntimePorts} ports */
  constructor(ports = /** @type {any} */ ({})) {
    this.ports = ports;
    this.runStates = new RunStateStore({ now: ports.now });
    this.lastRequests = new Map();
    this.disposed = false;
  }

  /**
   * @param {(event: { type: string, run: any }) => void} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(listener) {
    return this.runStates.subscribe(listener);
  }

  /** @param {string} threadId */
  getRun(threadId) {
    return this.runStates.get(threadId);
  }

  /** @param {string} threadId */
  getRunSnapshot(threadId) {
    return this.runStates.getSnapshot(threadId);
  }

  /** @returns {any[]} */
  listRuns() {
    return this.runStates.list();
  }

  /** @returns {string[]} Thread ids with a run that is still in flight. */
  activeThreadIds() {
    return this.runStates.list().map((run) => run.threadId);
  }

  /** @param {string} threadId */
  hasRun(threadId) {
    return this.runStates.has(threadId);
  }

  /**
   * True while `run` still describes its thread's active run.
   *
   * @param {import("./run-state.mjs").RunRecord | undefined} run
   */
  isCurrent(run) {
    if (this.disposed || !run) return false;
    return this.runStates.isCurrent(run.threadId, run.runId, run.generation);
  }

  /** @param {string} threadId */
  createRunner(threadId) {
    if (!this.ports.createRunner)
      throw new Error("Pi Agent: AgentRuntime.createRunner is not configured");
    return this.ports.createRunner(threadId);
  }

  /**
   * Creates the run record and stores the request so `retryRun` can replay it.
   *
   * @param {PromptRunRequest} request
   * @param {any} [presentation] Extra view-owned fields kept on the record.
   * @returns {import("./run-state.mjs").RunRecord}
   */
  beginRun(request, presentation = undefined) {
    const run = this.runStates.begin(request.threadId);
    if (presentation) Object.assign(run, presentation);
    return run;
  }

  /** @param {import("./run-state.mjs").RunRecord | undefined} run */
  finishRun(run) {
    if (!run) return false;
    return this.runStates.end(run.threadId, run.runId);
  }

  /**
   * @param {import("./run-state.mjs").RunRecord} run
   * @param {RunHooks} [hooks]
   * @returns {RunCallbacks}
   */
  guardedCallbacks(run, hooks = {}) {
    const alive = () => this.isCurrent(run);
    return {
      isCanceled: () => run.canceling === true || !alive(),
      onEvent: (event) => {
        if (!alive()) return;
        hooks.onEvent?.(event);
      },
      onTextDelta: (delta) => {
        if (!alive()) return;
        hooks.onTextDelta?.(delta);
      },
      onPromptAccepted: () => {
        if (!alive()) return;
        hooks.onPromptAccepted?.();
      }
    };
  }

  /**
   * Runs one prompt and settles the run record when it returns. The record is
   * removed from the active set before this resolves, so any event that arrives
   * afterwards is stale by definition.
   *
   * @param {PromptRunRequest} request
   * @param {RunHooks} [hooks]
   */
  async startPrompt(request, hooks = {}) {
    const threadId = request?.threadId;
    if (!threadId) throw new Error("Pi Agent: AgentRuntime.startPrompt requires a threadId");
    if (this.disposed) throw new Error("Pi Agent: this agent runtime is disposed");
    if (this.hasRun(threadId))
      throw new Error(`Pi Agent: thread ${threadId} already has an active run`);

    const activeRequest = {
      ...request,
      runner: request.runner ?? this.createRunner(threadId)
    };
    const run = this.beginRun(activeRequest);
    run.runner = activeRequest.runner;
    this.lastRequests.set(threadId, activeRequest);
    try {
      hooks.onStarted?.(run);
      const result = await this.execute(run, activeRequest, hooks);
      // A successful run must not be replayable: retrying it would silently
      // send the same prompt twice. Failed and cancelled runs stay replayable.
      this.lastRequests.delete(threadId);
      return { run, result };
    } finally {
      this.finishRun(run);
    }
  }

  /**
   * @param {import("./run-state.mjs").RunRecord} run
   * @param {PromptRunRequest} request
   * @param {RunHooks} [hooks]
   */
  async execute(run, request, hooks = {}) {
    if (!this.ports.runPrompt)
      throw new Error("Pi Agent: AgentRuntime.execute is not configured with a runPrompt port");
    this.runStates.transition(run.threadId, RUN_STATUS.running);
    try {
      const result = await this.ports.runPrompt(request, this.guardedCallbacks(run, hooks));
      this.runStates.transition(run.threadId, RUN_STATUS.completed);
      return result;
    } catch (error) {
      const canceled = run.canceling === true || isPiRunCanceled(error);
      this.runStates.transition(run.threadId, canceled ? RUN_STATUS.cancelling : RUN_STATUS.error, {
        error: canceled ? undefined : error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Replays the last request of a thread on a fresh runner.
   *
   * @param {string} threadId
   * @param {RunHooks} [hooks]
   */
  async retryRun(threadId, hooks = {}) {
    const previous = this.lastRequests.get(threadId);
    if (!previous) throw new Error(`Pi Agent: no previous prompt for thread ${threadId}`);
    return this.startPrompt({ ...previous, runner: undefined }, hooks);
  }

  /**
   * @param {import("./run-state.mjs").RunRecord | undefined} run
   * @param {any} [runner]
   */
  requestCancel(run, runner = run?.runner) {
    if (!run || !this.isCurrent(run) || run.canceling) return false;
    run.canceling = true;
    this.runStates.transition(run.threadId, RUN_STATUS.cancelling);
    if (this.ports.cancelRunner) this.ports.cancelRunner(runner);
    else runner?.cancelCurrentRun?.();
    return true;
  }

  /**
   * Sends a one-shot steering prompt into the run that is still streaming.
   *
   * @param {import("./run-state.mjs").RunRecord | undefined} run
   * @param {string} prompt
   * @param {any[]} [images]
   */
  async steerRun(run, prompt, images = []) {
    if (!run || !this.isCurrent(run)) return false;
    const runner = run.runner;
    if (!runner?.steer) return false;
    await runner.steer(prompt, images);
    if (this.isCurrent(run)) this.runStates.transition(run.threadId, RUN_STATUS.running);
    return true;
  }

  /** @param {string} [instructions] */
  createCompactPrompt(instructions = "") {
    const trimmed = String(instructions ?? "").trim();
    return trimmed ? `/compact ${trimmed}` : "/compact";
  }

  /**
   * @param {string} threadId
   * @param {string} [instructions]
   * @param {RunHooks} [hooks]
   */
  async compactRun(threadId, instructions = "", hooks = {}) {
    return this.startPrompt(
      { threadId, prompt: this.createCompactPrompt(instructions), images: [] },
      hooks
    );
  }

  dispose() {
    this.disposed = true;
    this.runStates.dispose();
    this.lastRequests.clear();
  }
}
