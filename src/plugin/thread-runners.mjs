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

  /** @param {string} threadId */
  create(threadId) {
    const existing = this.runners.get(threadId);
    if (existing) return existing;
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
    return [...this.runners.values()].some((runner) => runner.isRunning);
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
