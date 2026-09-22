/**
 * Single source of truth for agent run status.
 *
 * The store owns one run record per thread. Every record carries a monotonic
 * `generation`, so late RPC events, stale callbacks, or events from a previous
 * run can be recognised and dropped instead of mutating the live view.
 *
 * @typedef {"idle" | "starting" | "running" | "waiting" | "cancelling" | "error" | "completed"} RunStatus
 *
 * @typedef {object} RunState
 * @property {string} runId        Stable id of this run (`threadId:generation`).
 * @property {number} generation   Monotonic per-store counter; higher is newer.
 * @property {string} threadId
 * @property {RunStatus} status
 * @property {number} revision     Incremented on every transition.
 * @property {number} startedAt
 * @property {number} [completedAt]
 * @property {string} [error]
 * @property {boolean} [canceling] Set by the caller while a cancel is in flight.
 */

export const RUN_STATUS = Object.freeze({
  idle: "idle",
  starting: "starting",
  running: "running",
  waiting: "waiting",
  cancelling: "cancelling",
  error: "error",
  completed: "completed"
});

/**
 * A run record plus caller-owned fields (runner, prompt presentation state).
 *
 * @typedef {RunState & Record<string, any>} RunRecord
 */

const TERMINAL_STATUSES = /** @type {Set<RunStatus>} */ (
  new Set([RUN_STATUS.completed, RUN_STATUS.error])
);

/** @param {RunStatus} status */
export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export class RunStateStore {
  /**
   * @param {{ now?: () => number }} [options]
   */
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    /** @type {Map<string, RunRecord>} */
    this.runs = new Map();
    this.listeners = new Set();
    this.sequence = 0;
  }

  /** @returns {RunRecord[]} */
  list() {
    return [...this.runs.values()];
  }

  /** @param {string} threadId */
  get(threadId) {
    return this.runs.get(threadId);
  }

  /** @param {string} threadId */
  getSnapshot(threadId) {
    const run = this.runs.get(threadId);
    return run ? { ...run } : undefined;
  }

  /** @param {string} threadId */
  has(threadId) {
    return this.runs.has(threadId);
  }

  get size() {
    return this.runs.size;
  }

  /**
   * Starts a new run for a thread, replacing any finished or in-flight record.
   * The returned record is the mutable object owned by this store.
   *
   * @param {string} threadId
   * @returns {RunRecord}
   */
  begin(threadId) {
    this.sequence += 1;
    const generation = this.sequence;
    const run = {
      runId: `${threadId}:${generation}`,
      generation,
      threadId,
      status: RUN_STATUS.starting,
      revision: 1,
      startedAt: this.now(),
      completedAt: undefined,
      error: undefined
    };
    this.runs.set(threadId, run);
    this.publish({ type: "run-started", run });
    return run;
  }

  /**
   * @param {string} threadId
   * @param {RunStatus} status
   * @param {Partial<RunState>} [patch]
   */
  transition(threadId, status, patch = undefined) {
    const run = this.runs.get(threadId);
    if (!run) return undefined;
    run.status = status;
    run.revision += 1;
    if (patch) Object.assign(run, patch);
    if (isTerminalStatus(status)) run.completedAt = this.now();
    this.publish({ type: "run-state", run });
    return run;
  }

  /**
   * Drops the record for a finished run.
   *
   * @param {string} threadId
   * @param {string} [expectedRunId] Only end the record if it is still this run.
   * @returns {boolean} true when a record was removed.
   */
  end(threadId, expectedRunId = undefined) {
    const run = this.runs.get(threadId);
    if (!run || (expectedRunId !== undefined && run.runId !== expectedRunId)) return false;
    this.runs.delete(threadId);
    this.publish({ type: "run-ended", run });
    return true;
  }

  /**
   * True while the given identity still describes the thread's active run.
   * Stale events must be dropped before they reach shared state.
   *
   * @param {string} threadId
   * @param {string | undefined} runId
   * @param {number | undefined} generation
   */
  isCurrent(threadId, runId, generation) {
    const run = this.runs.get(threadId);
    return !!run && run.runId === runId && run.generation === generation;
  }

  /**
   * @param {(event: { type: string, run: RunState }) => void} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** @param {{ type: string, run: RunState }} event */
  publish(event) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.warn("Pi Agent: run state listener failed", error);
      }
    }
  }

  dispose() {
    this.runs.clear();
    this.listeners.clear();
  }
}
