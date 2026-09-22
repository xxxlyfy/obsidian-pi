/**
 * Owns the per-thread PiRunner instances so runner lifecycle (creation,
 * reuse, temporary sessions, and disposal) stays separate from plugin wiring.
 */
export class ThreadRunnerRegistry {
  /** @param {(threadId: string) => any} createRunner */
  constructor(createRunner) {
    this.createRunner = createRunner;
    /** @type {Map<string, any>} */
    this.runners = new Map();
  }

  /** @param {string} threadId */
  get(threadId) {
    return this.runners.get(threadId);
  }

  /**
   * Returns a reusable runner for the thread. A force-terminated runner is never
   * handed out again: it is disposed and replaced with a fresh one.
   *
   * @param {string} threadId
   */
  create(threadId) {
    const existing = this.runners.get(threadId);
    if (existing && !existing.invalid) return existing;
    if (existing) this.dispose(threadId);
    const runner = this.createRunner(threadId);
    this.runners.set(threadId, runner);
    return runner;
  }

  /**
   * @param {string} threadId
   * @param {(runner: any) => Promise<any>} action
   */
  async withRunner(threadId, action) {
    const existing = this.runners.get(threadId);
    const runner = this.create(threadId);
    try {
      return await action(runner);
    } finally {
      if (!existing) this.dispose(threadId);
    }
  }

  hasActive() {
    return [...this.runners.values()].some((runner) => runner.isRunning && !runner.invalid);
  }

  /** @param {string} threadId */
  dispose(threadId) {
    const runner = this.runners.get(threadId);
    runner?.rpcClient?.dispose();
    this.runners.delete(threadId);
  }

  disposeAll() {
    for (const runner of this.runners.values()) runner.rpcClient?.dispose();
    this.runners.clear();
  }
}
