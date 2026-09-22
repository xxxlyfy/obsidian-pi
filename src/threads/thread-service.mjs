import fs from "node:fs";
import { STRINGS } from "../shared/strings.mjs";

/**
 * Owns thread and chat-session lifecycle: CRUD, favourites, archival,
 * Pi-session fork/rename/delete, and the session file counters that the thread
 * list shows.
 *
 * It persists through an injected callback so the storage strategy stays a
 * persistence concern (Phase 3) instead of leaking into thread code.
 */
export class ThreadService {
  /**
   * @param {object} options
   * @param {any} options.store              ThreadStore instance.
   * @param {any} options.runners            ThreadRunnerRegistry instance.
   * @param {(threadId: string) => any} options.createRunner
   * @param {() => any} [options.getDefaultRunner] Fallback runner for session paths.
   * @param {() => void} [options.persist]   Called after every mutation.
   */
  constructor({ store, runners, createRunner, getDefaultRunner, persist }) {
    this.store = store;
    this.runners = runners;
    this.createRunner = createRunner;
    this.getDefaultRunner = getDefaultRunner ?? (() => undefined);
    this.persist = persist ?? (() => {});
    /** @type {Map<string, { mtimeMs: number, size: number, count: number }>} */
    this.sessionCountCache = new Map();
  }

  get currentThread() {
    return this.store.getCurrentThread();
  }

  get currentThreadId() {
    return this.store.currentThreadId;
  }

  /** @returns {any[]} */
  currentMessages() {
    return this.store.getCurrentMessages();
  }

  /** @param {string} threadId */
  getThread(threadId) {
    return this.store.getThread(threadId);
  }

  /** @param {any} [options] */
  listThreads(options) {
    return this.store.listThreads(options);
  }

  /**
   * Stores the Pi session that a thread is bound to.
   *
   * @param {string} threadId
   * @param {string} piSessionId
   */
  setThreadSessionId(threadId, piSessionId) {
    const updated = this.store.setThreadPiSessionId(threadId, piSessionId);
    this.persist();
    return updated;
  }

  /** @param {any} message */
  addMessage(message) {
    return this.addMessageToThread(this.store.currentThreadId, message);
  }

  /**
   * @param {string} threadId
   * @param {any} message
   */
  addMessageToThread(threadId, message) {
    const added = this.store.addMessageToThread(threadId, message);
    if (!added) return false;
    this.persist();
    return true;
  }

  /** @param {string} [title] */
  startNewThread(title) {
    const thread = this.store.startNewThread(title);
    this.persist();
    return thread;
  }

  async forkCurrentThread() {
    const current = this.currentThread;
    if (current.messages.length === 0) return undefined;

    let clonedSession;
    if (current.piSessionId) {
      const runner = this.createRunner(current.id);
      try {
        clonedSession = await runner.cloneSession(current.piSessionId);
        if (clonedSession) {
          await runner
            .setSessionName(clonedSession, `${current.title} (fork)`)
            .catch((error) => console.warn(STRINGS.plugin.sessionCloneFailed, error));
        }
      } finally {
        this.runners.dispose(current.id);
      }
      if (!clonedSession) return undefined;
    }

    const fork = this.store.forkCurrentThread(clonedSession);
    if (!fork) return undefined;
    this.persist();
    return fork;
  }

  /** @param {string} threadId */
  switchThread(threadId) {
    if (!this.store.switchThread(threadId)) return false;
    this.persist();
    return true;
  }

  /** @param {string} [threadId] */
  archiveThread(threadId = this.store.currentThreadId) {
    if (!this.store.archiveThread(threadId)) return false;
    this.persist();
    return true;
  }

  /** @param {string} threadId */
  unarchiveThread(threadId) {
    if (!this.store.unarchiveThread(threadId)) return false;
    this.persist();
    return true;
  }

  /** @param {string[]} threadIds */
  archiveThreads(threadIds) {
    const archivedIds = this.store.archiveThreads(threadIds);
    if (archivedIds.length > 0) this.persist();
    return { archivedIds, archivedCount: archivedIds.length };
  }

  /**
   * @param {string} threadId
   * @param {{ deletePiSession?: boolean }} [options]
   */
  deleteThread(threadId, options = {}) {
    const thread = this.store.getThread(threadId);
    if (!thread) return false;

    const runner = this.runners.get(threadId);
    if (runner?.isRunning) return false;

    let sessionPath;
    if (options.deletePiSession && thread.piSessionId) {
      const resolver = runner ?? this.getDefaultRunner();
      sessionPath = resolver?.resolveSessionPath(thread.piSessionId);
      if (!sessionPath || !fs.existsSync(sessionPath)) return false;

      const sessionIsShared = this.store
        .listThreads({ includeArchived: true })
        .some(
          (other) =>
            other.id !== threadId &&
            other.piSessionId &&
            resolver.resolveSessionPath(other.piSessionId) === sessionPath
        );
      if (sessionIsShared) return false;
    }

    this.runners.dispose(threadId);
    if (sessionPath) {
      try {
        fs.unlinkSync(sessionPath);
      } catch (error) {
        console.warn(STRINGS.plugin.sessionDeleteFailed, error);
        return false;
      }
    }

    if (!this.store.deleteThread(threadId)) return false;
    this.persist();
    return true;
  }

  /** @param {string[]} threadIds */
  deleteThreads(threadIds) {
    const requested = new Set(threadIds);
    const threads = this.store
      .listThreads({ includeArchived: true })
      .filter((thread) => requested.has(thread.id));
    const skippedIds = threads
      .filter((thread) => this.runners.get(thread.id)?.isRunning)
      .map((thread) => thread.id);
    const skipped = new Set(skippedIds);
    const deleteIds = threads
      .filter((thread) => !skipped.has(thread.id))
      .map((thread) => thread.id);

    for (const threadId of deleteIds) this.runners.dispose(threadId);

    const result = this.store.deleteThreads(deleteIds);
    if (result.deletedIds.length > 0) this.persist();
    return {
      deletedIds: result.deletedIds,
      deletedCount: result.deletedIds.length,
      skippedIds,
      skippedCount: skippedIds.length,
      createdThreadId: result.createdThreadId
    };
  }

  clearArchivedThreads() {
    const clearedCount = this.store.clearArchivedThreads();
    if (clearedCount === 0) return 0;
    this.persist();
    return clearedCount;
  }

  /**
   * @param {string} threadId
   * @param {string} title
   */
  renameThread(threadId, title) {
    const thread = this.store.getThread(threadId);
    if (!this.store.renameThread(threadId, title)) return false;

    this.persist();
    if (thread?.piSessionId) {
      const sessionName = this.store.getThread(threadId)?.title ?? title;
      void this.withSessionRunner(threadId, (runner) =>
        runner.setSessionName(thread.piSessionId, sessionName)
      ).catch((error) => console.warn(STRINGS.plugin.sessionRenameFailed, error));
    }
    return true;
  }

  /** @param {string} threadId */
  toggleThreadFavorite(threadId) {
    if (!this.store.toggleThreadFavorite(threadId)) return false;
    this.persist();
    return true;
  }

  /** @param {any} thread */
  getThreadDisplayMessageCount(thread) {
    const messageCount = Array.isArray(thread?.messages) ? thread.messages.length : 0;
    const sessionMessageCount = this.countSessionChatMessages(thread?.piSessionId);
    return Math.max(messageCount, sessionMessageCount);
  }

  /** @param {string | undefined} sessionReference */
  countSessionChatMessages(sessionReference) {
    const sessionPath = this.getDefaultRunner()?.resolveSessionPath(sessionReference);
    if (!sessionPath) return 0;

    let stat;
    try {
      stat = fs.statSync(sessionPath);
    } catch {
      this.sessionCountCache.delete(sessionPath);
      return 0;
    }

    const cached = this.sessionCountCache.get(sessionPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.count;

    try {
      const count = fs
        .readFileSync(sessionPath, "utf8")
        .split(/\r?\n/)
        .reduce((total, line) => {
          if (!line.trim()) return total;
          try {
            const parsed = JSON.parse(line);
            const message = parsed?.message;
            return parsed.type === "message" &&
              (message?.role === "user" || message?.role === "assistant")
              ? total + 1
              : total;
          } catch {
            return total;
          }
        }, 0);
      this.sessionCountCache.set(sessionPath, { mtimeMs: stat.mtimeMs, size: stat.size, count });
      return count;
    } catch {
      return 0;
    }
  }

  /** @param {string} threadId */
  async getThreadSessionStats(threadId) {
    const thread = this.store.getThread(threadId);
    if (!thread?.piSessionId) return undefined;
    return this.withSessionRunner(threadId, (runner) => runner.getSessionStats(thread.piSessionId));
  }

  /** @param {string} threadId */
  async exportThreadSession(threadId) {
    const thread = this.store.getThread(threadId);
    if (!thread?.piSessionId) return undefined;
    return this.withSessionRunner(threadId, (runner) => runner.exportSession(thread.piSessionId));
  }

  /** @param {string} threadId */
  async getThreadSessionTree(threadId) {
    const thread = this.store.getThread(threadId);
    if (!thread?.piSessionId) return undefined;
    return this.withSessionRunner(threadId, (runner) => runner.getSessionTree(thread.piSessionId));
  }

  /**
   * @param {string} threadId
   * @param {any} since
   */
  async getThreadSessionEntries(threadId, since) {
    const thread = this.store.getThread(threadId);
    if (!thread?.piSessionId) return undefined;
    return this.withSessionRunner(threadId, (runner) =>
      runner.getSessionEntries(thread.piSessionId, since)
    );
  }

  /**
   * @param {string} threadId
   * @param {(runner: any) => Promise<any>} action
   */
  async withSessionRunner(threadId, action) {
    return this.runners.withRunner(threadId, action);
  }
}
