import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STRINGS } from "../src/shared/strings.mjs";

const notices = vi.hoisted(() => ({ messages: [] }));

vi.mock("obsidian", () => ({
  Component: class {},
  FuzzySuggestModal: class {},
  ItemView: class {},
  MarkdownRenderChild: class {},
  MarkdownRenderer: { render: vi.fn() },
  MarkdownView: class {},
  Menu: class {},
  Modal: class {},
  Notice: class {
    constructor(message) {
      notices.messages.push(String(message));
    }
  },
  Plugin: class {},
  PluginSettingTab: class {},
  Setting: class {},
  SuggestModal: class {},
  TFile: class {},
  normalizePath: (value) => value,
  setIcon: () => {}
}));

const { PiAgentPlugin } = await import("../src/plugin/PiAgentPlugin.mjs");
const { AnnotationStore } = await import("../src/annotations/annotation-store.mjs");
const { ThreadStore } = await import("../src/threads/thread-store.mjs");
const { DEFAULT_SETTINGS } = await import("../src/plugin/settings.mjs");

const tempDirs = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

async function createTempDir() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-agent-golden-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * A PiAgentPlugin double that keeps the real prototype methods (thread API,
 * persistence, settings loading) and replaces Obsidian I/O with in-memory or
 * temp-directory counterparts.
 */
function createPluginDouble({ dir, data, history, annotationData } = {}) {
  const plugin = Object.create(PiAgentPlugin.prototype);
  Object.assign(plugin, {
    settings: { ...DEFAULT_SETTINGS },
    messages: [],
    threadHistory: new ThreadStore(history),
    annotationStore: new AnnotationStore(annotationData),
    localPromptQueue: [],
    localPromptSteering: [],
    saved: undefined,
    threadRunners: {
      dispose: vi.fn(),
      get: () => undefined,
      disposeAll: vi.fn(),
      hasActive: () => false,
      withRunner: async (threadId, action) => action({ setSessionName: async () => {} })
    },
    saveData: async (saveData) => {
      plugin.saved = JSON.parse(JSON.stringify(saveData));
    },
    loadData: async () => (data === undefined ? {} : JSON.parse(JSON.stringify(data))),
    getPluginDirectory: () => dir,
    getVaultBasePath: () => undefined,
    withSessionRunner: async () => undefined
  });
  plugin.store = plugin.createPluginStore();
  plugin.threads = plugin.buildThreadService();
  return plugin;
}

function createAnnotationInput(notePath, quote, context) {
  return {
    path: notePath,
    intent: "change",
    context,
    quote,
    prefix: "",
    suffix: "",
    range: {
      from: 0,
      to: quote.length,
      start: { line: 0, ch: 0 },
      end: { line: 0, ch: quote.length }
    },
    targetKind: "selection",
    status: "attached"
  };
}

describe("golden path 4: message -> persist -> reload", () => {
  it("restores the exact thread and annotations after a plugin reload", async () => {
    notices.messages.length = 0;
    const dir = await createTempDir();
    const first = createPluginDouble({ dir: await createTempDir() });
    const threadId = first.threadHistory.currentThreadId;

    first.threadHistory.startNewThread("Second chat");
    first.threadHistory.switchThread(threadId);
    first.threadHistory.renameThread(threadId, "Renamed chat");
    first.threadHistory.setThreadPiSessionId(threadId, "session-1");
    first.threadHistory.toggleThreadFavorite(threadId);
    first.threads.addMessageToThread(threadId, {
      role: "user",
      content: "hello",
      createdAt: 1_700_000_000_000
    });
    first.threads.addMessageToThread(threadId, {
      role: "assistant",
      content: "world",
      createdAt: 1_700_000_000_001,
      thinking: "steps"
    });
    first.annotationStore.create(
      createAnnotationInput("Active.md", "exact target", "Make this clearer")
    );

    await first.savePluginData();

    expect(first.saved).toMatchObject({
      annotationData: {
        schemaVersion: 1,
        annotations: { "Active.md": [expect.objectContaining({ context: "Make this clearer" })] }
      },
      localPromptQueue: [],
      localPromptSteering: []
    });
    expect(first.saved.chatHistory.threads.map((thread) => thread.title).sort()).toEqual([
      "Renamed chat",
      "Second chat"
    ]);
    const persistedThread = first.saved.chatHistory.threads.find(
      (thread) => thread.id === threadId
    );
    expect(persistedThread).toMatchObject({
      piSessionId: "session-1",
      favorite: true,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world", thinking: "steps" }
      ]
    });

    const reloaded = createPluginDouble({ dir, data: first.saved });
    await reloaded.loadSettings();

    // Persistence sorts threads by updatedAt desc; the in-memory store keeps
    // insertion order, so compare per thread instead of by array position.
    const expectedThreads = new Map(
      first.threadHistory.toJSON().threads.map((thread) => [thread.id, thread])
    );
    const restoredThreads = new Map(
      reloaded.threadHistory.toJSON().threads.map((thread) => [thread.id, thread])
    );
    expect([...restoredThreads.keys()].sort()).toEqual([...expectedThreads.keys()].sort());
    for (const [id, thread] of expectedThreads) expect(restoredThreads.get(id)).toEqual(thread);
    expect(reloaded.threadHistory.getCurrentThread()).toEqual(
      first.threadHistory.getCurrentThread()
    );
    expect(first.saved.chatHistory.threads.map((thread) => thread.updatedAt)).toEqual(
      [...first.saved.chatHistory.threads.map((thread) => thread.updatedAt)].sort(
        (left, right) => right - left
      )
    );
    expect(reloaded.annotationStore.toJSON()).toEqual(first.annotationStore.toJSON());
    expect(reloaded.threadHistory.currentThreadId).toBe(threadId);
    expect(reloaded.threads.currentMessages()).toEqual(first.threadHistory.getCurrentMessages());
    expect(reloaded.settings).toMatchObject({
      sandboxMode: "read-only",
      desktopNotifications: true
    });
  });

  it("recovers chat history from the checksummed backup when data.json lost it", async () => {
    notices.messages.length = 0;
    const dir = await createTempDir();
    const first = createPluginDouble({ dir });
    const createdAt = Date.now();
    first.threads.addMessage({ role: "user", content: "backup me", createdAt });
    await first.savePluginData();

    const damagedData = { ...first.saved };
    delete damagedData.chatHistory;
    const reloaded = createPluginDouble({ dir, data: damagedData });
    await reloaded.loadSettings();

    expect(reloaded.threadHistory.getCurrentMessages()).toEqual([
      expect.objectContaining({ role: "user", content: "backup me", createdAt })
    ]);
    expect(notices.messages).toEqual([STRINGS.plugin.historyRecovered]);
  });

  it("characterizes that a stored message without createdAt is dropped on reload", async () => {
    // ThreadStore.addMessageToThread keeps the message in memory, but
    // normalizeMessages() filters messages without a numeric createdAt when the
    // plugin reloads. Phase 3 (Persistence) must not make this worse.
    const dir = await createTempDir();
    const first = createPluginDouble({ dir });
    first.threads.addMessage({ role: "user", content: "no timestamp" });

    expect(first.threadHistory.getCurrentMessages()).toEqual([
      expect.objectContaining({ content: "no timestamp" })
    ]);
    await first.savePluginData();

    const reloaded = createPluginDouble({ dir, data: first.saved });
    await reloaded.loadSettings();

    expect(reloaded.threadHistory.getCurrentMessages()).toEqual([]);
  });

  it("persists thread metadata changes through the plugin thread API", async () => {
    const dir = await createTempDir();
    const plugin = createPluginDouble({ dir });
    const currentId = plugin.threadHistory.currentThreadId;
    const newThread = plugin.threads.startNewThread("Work log");

    plugin.threads.renameThread(newThread.id, "Renamed log");
    plugin.threads.toggleThreadFavorite(newThread.id);
    plugin.threads.archiveThread(newThread.id);
    expect(plugin.threads.switchThread(currentId)).toBe(true);

    await plugin.store.flush();

    const persisted = plugin.saved.chatHistory.threads.find((thread) => thread.id === newThread.id);
    expect(persisted).toMatchObject({ title: "Renamed log", favorite: true, archived: true });
    expect(plugin.saved.chatHistory.currentThreadId).toBe(currentId);

    expect(plugin.threads.deleteThread(newThread.id)).toBe(true);
    await plugin.store.flush();
    expect(plugin.saved.chatHistory.threads.some((thread) => thread.id === newThread.id)).toBe(
      false
    );
  });
});
