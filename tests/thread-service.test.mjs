import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadService } from "../src/threads/thread-service.mjs";
import { ThreadStore } from "../src/threads/thread-store.mjs";

const tempDirs = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function createService(options = {}) {
  const store = options.store ?? new ThreadStore();
  const persisted = [];
  const runners = {
    disposed: [],
    get: () => undefined,
    dispose(threadId) {
      this.disposed.push(threadId);
    },
    withRunner: async (threadId, action) => action(options.sessionRunner ?? {})
  };
  const service = new ThreadService({
    store,
    runners,
    createRunner: () => options.sessionRunner ?? {},
    getDefaultRunner: () => options.defaultRunner,
    persist: () => persisted.push(store.toJSON())
  });
  return { service, store, runners, persisted };
}

describe("ThreadService", () => {
  it("persists after every thread mutation", () => {
    const { service, persisted } = createService();

    service.addMessage({ role: "user", content: "hello", createdAt: 1 });
    const thread = service.startNewThread("Second");
    service.renameThread(thread.id, "Renamed");
    service.toggleThreadFavorite(thread.id);
    service.archiveThread(thread.id);
    service.unarchiveThread(thread.id);
    service.switchThread(thread.id);
    service.deleteThread(thread.id);
    service.clearArchivedThreads();

    expect(persisted.length).toBeGreaterThanOrEqual(8);
    expect(persisted.at(-1).threads.some((candidate) => candidate.id === thread.id)).toBe(false);
  });

  it("exposes the current thread, its messages, and the session id setter", () => {
    const { service } = createService();
    const threadId = service.currentThreadId;

    service.addMessageToThread(threadId, { role: "user", content: "hi", createdAt: 1 });
    service.setThreadSessionId(threadId, "session-1");

    expect(service.currentThread.messages).toHaveLength(1);
    expect(service.currentMessages()).toHaveLength(1);
    expect(service.getThread(threadId).piSessionId).toBe("session-1");
    expect(service.listThreads({ includeArchived: true })).toHaveLength(1);
  });

  it("refuses to delete a thread while its runner is active", () => {
    const { service, runners } = createService();
    const threadId = service.currentThreadId;
    runners.get = () => ({ isRunning: true });

    expect(service.deleteThread(threadId)).toBe(false);
    expect(runners.disposed).toEqual([]);
  });

  it("deletes the Pi session only when it is not shared with another thread", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-agent-thread-"));
    tempDirs.push(dir);
    const sessionPath = path.join(dir, "session.jsonl");
    await fs.promises.writeFile(sessionPath, "{}\n", "utf8");
    const store = new ThreadStore();
    const first = store.currentThreadId;
    const second = store.startNewThread("Second").id;
    store.switchThread(first);
    store.setThreadPiSessionId(first, "session-1");
    store.setThreadPiSessionId(second, "session-1");
    const resolver = { resolveSessionPath: (reference) => (reference ? sessionPath : undefined) };
    const { service } = createService({ store, defaultRunner: resolver });

    expect(service.deleteThread(first, { deletePiSession: true })).toBe(false);
    expect(fs.existsSync(sessionPath)).toBe(true);

    service.deleteThread(second);
    expect(service.deleteThread(first, { deletePiSession: true })).toBe(true);
    expect(fs.existsSync(sessionPath)).toBe(false);
  });

  it("counts Pi session messages and caches the stat result", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-agent-thread-"));
    tempDirs.push(dir);
    const sessionPath = path.join(dir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "message", message: { role: "user" } }),
      JSON.stringify({ type: "message", message: { role: "assistant" } }),
      JSON.stringify({ type: "message", message: { role: "system" } }),
      "not json",
      ""
    ];
    await fs.promises.writeFile(sessionPath, `${lines.join("\n")}\n`, "utf8");
    const resolver = { resolveSessionPath: (reference) => (reference ? sessionPath : undefined) };
    const { service } = createService({ defaultRunner: resolver });

    expect(service.countSessionChatMessages("session-1")).toBe(2);
    expect(service.sessionCountCache.size).toBe(1);
    expect(service.countSessionChatMessages("session-1")).toBe(2);
    expect(service.getThreadDisplayMessageCount({ messages: [1, 2, 3], piSessionId: "s" })).toBe(3);
    expect(service.countSessionChatMessages(undefined)).toBe(0);
  });

  it("forks a thread with a cloned Pi session and disposes the temporary runner", async () => {
    const cloneSession = vi.fn(async () => "session-fork");
    const setSessionName = vi.fn(async () => {});
    const { service, runners } = createService({ sessionRunner: { cloneSession, setSessionName } });
    const originalId = service.currentThreadId;
    service.addMessage({ role: "user", content: "hello", createdAt: 1 });
    service.setThreadSessionId(originalId, "session-1");

    const fork = await service.forkCurrentThread();

    expect(cloneSession).toHaveBeenCalledWith("session-1");
    expect(setSessionName).toHaveBeenCalledWith("session-fork", expect.stringContaining("(fork)"));
    expect(fork).toMatchObject({ piSessionId: "session-fork" });
    expect(runners.disposed).toEqual([originalId]);
  });

  it("does not fork an empty thread", async () => {
    const { service } = createService();

    await expect(service.forkCurrentThread()).resolves.toBeUndefined();
  });

  it("picks a safe fallback when the current thread is deleted", () => {
    const { service } = createService();
    const first = service.currentThreadId;
    const second = service.startNewThread("Second");
    service.switchThread(second.id);
    service.addMessageToThread(second.id, { role: "user", content: "hi", createdAt: 1 });

    expect(service.deleteThread(second.id)).toBe(true);

    expect(service.getThread(second.id)).toBeUndefined();
    expect(service.currentThreadId).not.toBe(second.id);
    expect(service.getThread(service.currentThreadId)).toBeDefined();
    expect(service.currentThreadId).toBe(first);
  });

  it("creates a replacement thread when the last thread is deleted", () => {
    const { service } = createService();
    const only = service.currentThreadId;

    expect(service.deleteThread(only)).toBe(true);

    expect(service.listThreads({ includeArchived: true })).toHaveLength(1);
    expect(service.currentThreadId).not.toBe(only);
    expect(service.currentThread.messages).toEqual([]);
  });

  it("keeps a fork isolated from its source thread", () => {
    const { service } = createService();
    const source = service.currentThreadId;
    service.addMessageToThread(source, { role: "user", content: "original", createdAt: 1 });

    const fork = service.store.forkCurrentThread();
    expect(fork).toBeDefined();

    // Mutating either thread must not touch the other.
    service.addMessageToThread(fork.id, { role: "assistant", content: "fork only", createdAt: 2 });
    service.renameThread(source, "Renamed source");
    service.setThreadSessionId(source, "session-source");

    const sourceThread = service.getThread(source);
    const forkThread = service.getThread(fork.id);
    expect(sourceThread.messages.map((message) => message.content)).toEqual(["original"]);
    expect(forkThread.messages.map((message) => message.content)).toEqual([
      "original",
      "fork only"
    ]);
    expect(sourceThread.title).toBe("Renamed source");
    expect(forkThread.piSessionId).toBeUndefined();

    // Returned copies are detached from the stored threads.
    forkThread.messages.push({ role: "user", content: "external", createdAt: 3 });
    expect(service.getThread(fork.id).messages).toHaveLength(2);
  });

  it("delegates session readers to the per-thread runner", async () => {
    const calls = [];
    const sessionRunner = {
      getSessionStats: async (id) => calls.push(["stats", id]) ?? { id },
      exportSession: async (id) => calls.push(["export", id]) ?? { id },
      getSessionTree: async (id) => calls.push(["tree", id]) ?? { id },
      getSessionEntries: async (id, since) => calls.push(["entries", id, since]) ?? { id }
    };
    const { service } = createService({ sessionRunner });
    const threadId = service.currentThreadId;
    service.setThreadSessionId(threadId, "session-1");

    await service.getThreadSessionStats(threadId);
    await service.exportThreadSession(threadId);
    await service.getThreadSessionTree(threadId);
    await service.getThreadSessionEntries(threadId, 5);

    expect(calls).toEqual([
      ["stats", "session-1"],
      ["export", "session-1"],
      ["tree", "session-1"],
      ["entries", "session-1", 5]
    ]);
    expect(await service.getThreadSessionStats("missing")).toBeUndefined();
  });
});
