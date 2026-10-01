/**
 * End-to-end recovery through `PiAgentPlugin.loadSettings()`.
 *
 * Every case here goes through the production recovery path: the test only stubs
 * Obsidian's `loadData()` (and `Notice`) and then calls `loadSettings()` or
 * `onload()`. The chat history backup reader, its checksum validation,
 * `ThreadStore` and the settings normalizer are the real production modules.
 *
 * The failures are separated the way `loadSettings()` separates them:
 *
 * - A damaged `data.json` reaches the plugin as a SyntaxError from Obsidian's
 *   `JSON.parse`, and is recovered from: defaults for the settings that the
 *   unreadable file cannot supply, plus the existing chat history backup.
 * - Any other failure (permissions, filesystem, anything unrecognized) keeps its
 *   original failure semantics, because starting with defaults would hide a vault
 *   the plugin cannot read.
 *
 * `loadData()` therefore always rejects with a *typed* error here: a SyntaxError for
 * corrupt data, and a plain Error for every other case.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Notice texts are recorded so a test can assert what the user was told. vi.hoisted
// because the vi.mock factory below is hoisted above these declarations.
const harness = vi.hoisted(() => ({ notices: [] }));

/** Minimal element double for the status bar item `onload()` creates. */
class FakeElement {
  constructor() {
    this.children = [];
    this.hidden = false;
  }

  addClass() {
    return this;
  }

  createEl(tag, options = {}) {
    const child = new FakeElement(tag, options);
    this.children.push(child);
    return child;
  }

  createDiv(options = {}) {
    return this.createEl("div", options);
  }

  createSpan(options = {}) {
    return this.createEl("span", options);
  }

  setText() {
    return this;
  }

  setAttr() {
    return this;
  }

  empty() {
    this.children = [];
    return this;
  }

  remove() {}

  addEventListener() {
    return this;
  }
}

vi.mock("obsidian", () => {
  // The Component/Plugin surface Obsidian provides; only what `onload()` calls.
  class PluginBase {
    addStatusBarItem() {
      return new FakeElement();
    }

    addRibbonIcon() {
      return new FakeElement();
    }

    addCommand() {}

    addSettingTab() {}

    registerView() {}

    registerEvent(reference) {
      return reference;
    }

    registerEditorExtension() {}

    registerMarkdownPostProcessor() {}

    registerDomEvent() {}
  }
  class Notice {
    constructor(message) {
      harness.notices.push(String(message));
    }
  }
  return {
    Component: PluginBase,
    FuzzySuggestModal: PluginBase,
    ItemView: PluginBase,
    MarkdownRenderChild: PluginBase,
    MarkdownRenderer: { render: vi.fn().mockResolvedValue(undefined) },
    MarkdownView: PluginBase,
    Menu: PluginBase,
    Modal: PluginBase,
    Notice,
    Platform: { isDesktopApp: true },
    Plugin: PluginBase,
    PluginSettingTab: PluginBase,
    Setting: PluginBase,
    SuggestModal: PluginBase,
    TFile: PluginBase,
    addIcon: vi.fn(),
    getLanguage: () => "en",
    normalizePath: (value) => value,
    setIcon: vi.fn()
  };
});

// The two modules that would start a Pi process are stubbed at that boundary only,
// so the `onload()` case stays hermetic. Nothing else in this file reaches them.
vi.mock("../src/pi/health.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  warmupPiCli: () => {}
}));
vi.mock("../src/pi/command-catalog.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  PiCommandCatalog: class {
    async getCommands() {
      return [];
    }
  }
}));

const { PiAgentPlugin } = await import("../src/plugin/PiAgentPlugin.mjs");
const { DEFAULT_SETTINGS } = await import("../src/plugin/settings.mjs");
const { ThreadStore } = await import("../src/threads/thread-store.mjs");
const { writeChatHistoryBackup } = await import("../src/threads/chat-history-backup.mjs");

const BACKUP_FILE = "chat-history.backup.json";
const PREVIOUS_BACKUP_FILE = "chat-history.backup.previous.json";
const RECOVERY_NOTICE = "Pi Agent recovered chat history from its local backup.";
const CONFIG_DIR = ".obsidian";
const PLUGIN_DIR_SEGMENTS = [CONFIG_DIR, "plugins", "pi-agent"];
const DAMAGED_JSON = "{damaged";

/** Temp vaults created per test, removed in afterEach. */
let vaultDirectories = [];

afterEach(() => {
  for (const directory of vaultDirectories) fs.rmSync(directory, { recursive: true, force: true });
  vaultDirectories = [];
  harness.notices.length = 0;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A private temporary vault directory. */
function createVaultDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-recovery-"));
  vaultDirectories.push(directory);
  return directory;
}

/**
 * The plugin directory Obsidian would hand to `getPluginDirectory()`, derived here
 * from the vault path alone so the assertion does not read the value it checks.
 */
function expectedPluginDirectory(vaultDirectory) {
  return path.resolve(vaultDirectory, ...PLUGIN_DIR_SEGMENTS);
}

/** The Obsidian `App` surface the tested paths touch. */
function createApp(vaultDirectory) {
  const on = () => ({});
  return {
    vault: {
      configDir: CONFIG_DIR,
      adapter: { getBasePath: () => vaultDirectory },
      on,
      getAbstractFileByPath: () => undefined,
      getMarkdownFiles: () => []
    },
    workspace: {
      on,
      getActiveFile: () => undefined,
      getLeavesOfType: () => [],
      activeLeaf: undefined,
      activeEditor: undefined
    },
    metadataCache: { getFileCache: () => undefined }
  };
}

/**
 * The real plugin over a stubbed Obsidian app.
 *
 * The Obsidian `Plugin` base class in this suite provides only the host methods, so
 * `app` and `manifest` are assigned explicitly -- that is the surface
 * `getPluginDirectory()` reads. `loadData()` is supplied per test because it is the
 * boundary under test.
 *
 * @param {string} vaultDirectory
 * @param {() => Promise<any>} loadData
 */
function createPlugin(vaultDirectory, loadData) {
  const app = createApp(vaultDirectory);
  const manifest = { id: "pi-agent", dir: PLUGIN_DIR_SEGMENTS.join("/") };
  const plugin = new PiAgentPlugin(app, manifest);
  plugin.app = app;
  plugin.manifest = manifest;
  plugin.loadData = loadData;
  return plugin;
}

/** A `loadData()` stand-in that returns one fixed snapshot of `data.json`. */
function loadDataReturning(data) {
  return async () => data;
}

/** `loadData()` failing because `data.json` is not valid JSON. */
function loadDataWithDamagedJson() {
  const error = new SyntaxError("Unexpected end of JSON input");
  return { error, loadData: async () => Promise.reject(error) };
}

/** A non-JSON failure, shaped like the error Obsidian surfaces for that case. */
function createHostError(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * Record every `fs.promises.readFile` path the production code performs.
 *
 * This is how the test observes whether `readChatHistoryBackup()` was reached
 * without mocking that function: the backup reader is the only code on this path
 * that reads a file, so a missing read is proof the function never ran. The real
 * `node:fs` default export is the same object both modules import.
 */
function instrumentFileReads() {
  const readPaths = [];
  const original = fs.promises.readFile;
  fs.promises.readFile = function instrumentedReadFile(file, ...rest) {
    readPaths.push(path.resolve(String(file)));
    return original.call(fs.promises, file, ...rest);
  };
  return {
    readPaths,
    restore() {
      fs.promises.readFile = original;
    }
  };
}

/** Run `loadSettings()` while recording the files it read. */
async function loadSettingsRecordingReads(plugin) {
  const reads = instrumentFileReads();
  try {
    await plugin.loadSettings();
  } finally {
    reads.restore();
  }
  return reads.readPaths;
}

/**
 * A history the production normalizer round-trips unchanged: only fields
 * `ThreadStore` persists are present, and every message is valid.
 *
 * @param {string} label Distinguishes the snapshots that share one plugin directory.
 * @param {string[]} threadIds
 * @param {string} [currentThreadId]
 */
function createHistory(label, threadIds, currentThreadId = threadIds[0]) {
  return {
    currentThreadId,
    threads: threadIds.map((id, index) => ({
      id,
      title: `${label}:${id}`,
      messages: [{ role: "user", content: `${id} message`, createdAt: 1_700_000_000_000 + index }],
      createdAt: 1_700_000_000_000 + index,
      updatedAt: 1_700_000_000_000 + index,
      archived: false,
      favorite: false
    }))
  };
}

/** Every thread id in a history, in stored order. */
function threadIdsOf(history) {
  return history.threads.map((thread) => thread.id);
}

/** Compare persisted history without depending on `undefined`-valued extras. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Write both backup snapshots through the real writer, so `current` is the newer
 * history and `previous` is the one it replaced -- exactly the on-disk shape after
 * two ordinary saves.
 */
async function writeBackupPair(directory, previous, current) {
  await writeChatHistoryBackup(directory, previous);
  await writeChatHistoryBackup(directory, current);
}

/** Write a checksum-invalid backup whose payload would still parse as a history. */
function writeChecksumTamperedBackup(directory, fileName, history) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, fileName),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        savedAt: new Date().toISOString(),
        checksum: "0".repeat(64),
        chatHistory: history
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

/** The warning text a parse failure must leave behind for diagnostics. */
function expectParseWarning(warn, error) {
  expect(warn).toHaveBeenCalled();
  const call = warn.mock.calls.find(([, thrown]) => thrown === error);
  expect(call, "no warning carried the parse failure").toBeDefined();
  expect(call[0]).toContain("data.json");
  expect(call[0]).toMatch(/parse/i);
}

// ---------------------------------------------------------------------------
// A. Intact data.json, but its chatHistory is unusable
// ---------------------------------------------------------------------------

describe("A: intact data.json without a usable chatHistory", () => {
  it("A1: falls back to chat-history.backup.json and restores the stored threads", async () => {
    const vaultDirectory = createVaultDirectory();
    const directory = expectedPluginDirectory(vaultDirectory);
    const stored = createHistory("backup", ["backup-a", "backup-b"], "backup-b");
    await writeChatHistoryBackup(directory, stored);

    const plugin = createPlugin(
      vaultDirectory,
      loadDataReturning({ piExecutablePath: "/opt/pi", ignoredFolders: [".git"] })
    );
    expect(path.resolve(plugin.getPluginDirectory())).toBe(directory);

    const readPaths = await loadSettingsRecordingReads(plugin);

    // The backup file itself was read, and the current snapshot was enough.
    expect(readPaths).toContain(path.resolve(directory, BACKUP_FILE));
    expect(readPaths).not.toContain(path.resolve(directory, PREVIOUS_BACKUP_FILE));

    // History is restored, and the other settings still come from data.json.
    expect(plugin.threadHistory).toBeInstanceOf(ThreadStore);
    expect(plain(plugin.threadHistory.toJSON())).toEqual(stored);
    expect(plugin.threadHistory.currentThreadId).toBe("backup-b");
    expect(plugin.settings.piExecutablePath).toBe("/opt/pi");
    expect(plugin.settings.ignoredFolders).toEqual([".git"]);
    expect(plugin.settings.chatHistory).toBeUndefined();
    expect(harness.notices).toEqual([RECOVERY_NOTICE]);

    console.log(
      `[A1] data.json intact without chatHistory -> read ${BACKUP_FILE}, ` +
        `restored ${threadIdsOf(stored).length} threads, notice shown`
    );
  });

  it("A2: treats { chatHistory: { invalid: true } } as unusable and uses the backup", async () => {
    const vaultDirectory = createVaultDirectory();
    const directory = expectedPluginDirectory(vaultDirectory);
    const stored = createHistory("backup", ["from-backup"]);
    await writeChatHistoryBackup(directory, stored);

    const plugin = createPlugin(
      vaultDirectory,
      loadDataReturning({ chatHistory: { invalid: true }, piExecutablePath: "/opt/pi" })
    );
    await plugin.loadSettings();

    expect(plain(plugin.threadHistory.toJSON())).toEqual(stored);
    expect(plugin.settings.piExecutablePath).toBe("/opt/pi");
    // chatHistory was excluded from settings rather than normalized into them.
    expect(plugin.settings.chatHistory).toBeUndefined();
    expect(harness.notices).toEqual([RECOVERY_NOTICE]);

    console.log("[A2] isStoredChatHistory() rejected { invalid: true }; backup restored");
  });

  it("A3: treats an empty threads array as unusable, so the backup wins", async () => {
    const vaultDirectory = createVaultDirectory();
    const directory = expectedPluginDirectory(vaultDirectory);
    const stored = createHistory("backup", ["from-backup"]);
    await writeChatHistoryBackup(directory, stored);

    const plugin = createPlugin(
      vaultDirectory,
      loadDataReturning({ chatHistory: { currentThreadId: "gone", threads: [] } })
    );
    await plugin.loadSettings();

    // `isStoredChatHistory()` requires at least one thread, so a well-formed but
    // empty stored history is not accepted and the backup is consulted.
    expect(plain(plugin.threadHistory.toJSON())).toEqual(stored);
    expect(harness.notices).toEqual([RECOVERY_NOTICE]);

    console.log(
      "[A3] chatHistory.threads === [] rejected by isStoredChatHistory(); backup restored"
    );
  });
});

// ---------------------------------------------------------------------------
// B. data.json is not valid JSON, so loadData() rejects with a SyntaxError
// ---------------------------------------------------------------------------

describe("B: data.json JSON parse failure", () => {
  it("B1: recovers the current backup, warns, and completes with default settings", async () => {
    const vaultDirectory = createVaultDirectory();
    const directory = expectedPluginDirectory(vaultDirectory);
    const stored = createHistory("backup", ["recovered-a", "recovered-b"], "recovered-b");
    await writeChatHistoryBackup(directory, stored);

    const { error, loadData } = loadDataWithDamagedJson();
    const plugin = createPlugin(vaultDirectory, loadData);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const readPaths = await loadSettingsRecordingReads(plugin);

    // Recovery is reachable again: the backup reader ran, and only it read a file.
    expect(readPaths).toEqual([path.resolve(directory, BACKUP_FILE)]);
    expect(plain(plugin.threadHistory.toJSON())).toEqual(stored);
    expect(plugin.threadHistory.currentThreadId).toBe("recovered-b");
    expect(plugin.threadHistory).toBeInstanceOf(ThreadStore);
    expect(plugin.getCurrentThread().id).toBe("recovered-b");
    expect(plain(plugin.messages)).toEqual(stored.threads[1].messages);

    // Exactly one user-visible notice: the existing recovery one. The parse failure
    // itself is a diagnostic warning, not a second popup.
    expect(harness.notices).toEqual([RECOVERY_NOTICE]);
    expectParseWarning(warn, error);

    // Unreadable data.json means default settings, and the backup carries history
    // only, so nothing from it may leak into the settings object.
    expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
    expect(plugin.settings.currentThreadId).toBeUndefined();
    expect(plugin.settings.threads).toBeUndefined();

    console.log(
      `[B1] SyntaxError from loadData() -> loadSettings() resolved, read ${BACKUP_FILE}, ` +
        `restored ${threadIdsOf(stored).length} threads, 1 recovery notice, 1 parse warning, ` +
        "default settings"
    );
  });

  it("B2: still falls back to the previous backup when the current one is damaged", async () => {
    const vaultDirectory = createVaultDirectory();
    const directory = expectedPluginDirectory(vaultDirectory);
    const previous = createHistory("previous", ["previous-only"]);
    const current = createHistory("current", ["current-only"]);
    await writeBackupPair(directory, previous, current);
    fs.writeFileSync(path.join(directory, BACKUP_FILE), DAMAGED_JSON, "utf8");

    const { loadData } = loadDataWithDamagedJson();
    const plugin = createPlugin(vaultDirectory, loadData);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const readPaths = await loadSettingsRecordingReads(plugin);

    // Current is attempted first and rejected as unparsable, then previous is read.
    expect(readPaths).toEqual([
      path.resolve(directory, BACKUP_FILE),
      path.resolve(directory, PREVIOUS_BACKUP_FILE)
    ]);
    expect(plain(plugin.threadHistory.toJSON())).toEqual(previous);
    expect(plugin.threadHistory.currentThreadId).toBe("previous-only");
    expect(harness.notices).toEqual([RECOVERY_NOTICE]);
    expect(warn).toHaveBeenCalledTimes(1);

    console.log("[B2] damaged current snapshot ignored, previous snapshot restored");
  });

  it("B3: keeps checksum validation, so a tampered current snapshot falls back too", async () => {
    const vaultDirectory = createVaultDirectory();
    const directory = expectedPluginDirectory(vaultDirectory);
    const previous = createHistory("previous", ["previous-only"]);
    const current = createHistory("current", ["current-only"]);
    await writeBackupPair(directory, previous, current);
    // Parses as JSON and looks like a backup, but the payload was tampered with.
    writeChecksumTamperedBackup(directory, BACKUP_FILE, createHistory("tampered", ["tampered"]));

    const { loadData } = loadDataWithDamagedJson();
    const plugin = createPlugin(vaultDirectory, loadData);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await plugin.loadSettings();

    expect(plain(plugin.threadHistory.toJSON())).toEqual(previous);
    expect(threadIdsOf(plugin.threadHistory.toJSON())).not.toContain("tampered");
    expect(harness.notices).toEqual([RECOVERY_NOTICE]);
    expect(warn).toHaveBeenCalledTimes(1);

    console.log("[B3] checksum-mismatched current snapshot ignored, previous restored");
  });

  it("B4: completes with an empty store, without a false notice, when both snapshots are invalid", async () => {
    const vaultDirectory = createVaultDirectory();
    const directory = expectedPluginDirectory(vaultDirectory);
    const previous = createHistory("previous", ["previous", "previous-b"]);
    const current = createHistory("current", ["current", "current-b"]);
    await writeBackupPair(directory, previous, current);
    fs.writeFileSync(path.join(directory, BACKUP_FILE), DAMAGED_JSON, "utf8");
    fs.writeFileSync(path.join(directory, PREVIOUS_BACKUP_FILE), DAMAGED_JSON, "utf8");

    const { error, loadData } = loadDataWithDamagedJson();
    const plugin = createPlugin(vaultDirectory, loadData);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The parse failure must not escape as the original SyntaxError.
    await expect(plugin.loadSettings()).resolves.toBeUndefined();

    expect(harness.notices).toEqual([]);
    expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
    expect(plugin.threadHistory).toBeInstanceOf(ThreadStore);
    const history = plugin.threadHistory.toJSON();
    expect(history.threads).toHaveLength(1);
    expect(history.threads[0].messages).toEqual([]);
    expect(threadIdsOf(history)).toEqual([history.threads[0].id]);
    // The diagnostic warning survives even when nothing could be recovered.
    expectParseWarning(warn, error);

    console.log(
      "[B4] both snapshots unparsable -> resolved, no recovery notice, one empty thread, " +
        "parse warning retained"
    );
  });
});

// ---------------------------------------------------------------------------
// C. Non-JSON loadData() failures keep their original semantics
// ---------------------------------------------------------------------------

describe("C: non-JSON loadData() failures", () => {
  it("C1: a permission failure rejects and never reaches the backup", async () => {
    const vaultDirectory = createVaultDirectory();
    const directory = expectedPluginDirectory(vaultDirectory);
    const stored = createHistory("backup", ["never-used"]);
    await writeChatHistoryBackup(directory, stored);

    const permissionError = createHostError(
      `EACCES: permission denied, open '${path.join(directory, "data.json")}'`,
      "EACCES"
    );
    const plugin = createPlugin(vaultDirectory, async () => Promise.reject(permissionError));
    const threadStoreBefore = plugin.threadHistory;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const reads = instrumentFileReads();
    let failure;
    try {
      await plugin.loadSettings();
    } catch (error) {
      failure = error;
    } finally {
      reads.restore();
    }

    // The error propagates unchanged -- not swallowed, not re-labelled as corrupt data.
    expect(failure).toBe(permissionError);
    expect(reads.readPaths).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(harness.notices).toEqual([]);
    expect(plugin.threadHistory).toBe(threadStoreBefore);
    expect(plugin.settings).toBe(DEFAULT_SETTINGS);

    console.log("[C1] EACCES rethrown unchanged, backup never read, no warning, no notice");
  });

  it("C2: a missing data.json (ENOENT) rejects the same way", async () => {
    const vaultDirectory = createVaultDirectory();
    const missingFileError = createHostError(
      "ENOENT: no such file or directory, open 'data.json'",
      "ENOENT"
    );
    const plugin = createPlugin(vaultDirectory, async () => Promise.reject(missingFileError));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(plugin.loadSettings()).rejects.toBe(missingFileError);
    expect(warn).not.toHaveBeenCalled();
    expect(harness.notices).toEqual([]);

    console.log("[C2] ENOENT rethrown unchanged: a filesystem failure is not corrupt JSON");
  });
});

// ---------------------------------------------------------------------------
// D. What a recovered store contains, and where the settings come from
// ---------------------------------------------------------------------------

describe("D: validation of a recovered store", () => {
  it("D1: restores the current snapshot exactly and never the older previous one", async () => {
    const vaultDirectory = createVaultDirectory();
    const directory = expectedPluginDirectory(vaultDirectory);
    const previous = createHistory("previous", ["previous-only"], "previous-only");
    const current = createHistory("current", ["current-a", "current-b"], "current-b");
    await writeBackupPair(directory, previous, current);

    const plugin = createPlugin(vaultDirectory, loadDataReturning({}));
    await plugin.loadSettings();

    const restored = plugin.threadHistory.toJSON();
    expect(plain(restored)).toEqual(current);
    expect(restored.currentThreadId).toBe("current-b");
    expect(plugin.threadHistory.currentThreadId).toBe("current-b");
    expect(plugin.getCurrentThread().id).toBe("current-b");
    // The restored messages are the current thread's messages, not the previous
    // snapshot's and not an empty list.
    expect(plain(plugin.messages)).toEqual(current.threads[1].messages);
    expect(threadIdsOf(restored)).not.toContain("previous-only");
    expect(restored.threads.some((thread) => thread.title === "previous:previous-only")).toBe(
      false
    );

    console.log(
      "[D1] restored history is identical to the current snapshot; currentThreadId current-b; " +
        "the older previous snapshot contributed nothing"
    );
  });

  it("D2: takes settings from the file when it parses, and from defaults when it does not", async () => {
    const vaultDirectory = createVaultDirectory();
    const stored = createHistory("backup", ["settings-thread"]);
    await writeChatHistoryBackup(expectedPluginDirectory(vaultDirectory), stored);

    // Intact file: its own settings win, and chatHistory never becomes a setting.
    const intact = createPlugin(
      vaultDirectory,
      loadDataReturning({
        piExecutablePath: "/opt/pi",
        customInstructions: "Be terse.",
        chatHistory: { invalid: true }
      })
    );
    await intact.loadSettings();

    expect(intact.settings.piExecutablePath).toBe("/opt/pi");
    expect(intact.settings.customInstructions).toBe("Be terse.");
    expect(intact.settings.chatHistory).toBeUndefined();
    expect(intact.settings.currentThreadId).toBeUndefined();
    expect(plain(intact.threadHistory.toJSON())).toEqual(stored);

    // Damaged file: the default settings stand in, and the backup still supplies
    // the chat history. The backup holds history only, so no settings come from it.
    const { loadData } = loadDataWithDamagedJson();
    const damaged = createPlugin(vaultDirectory, loadData);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await damaged.loadSettings();

    expect(damaged.settings).toEqual(DEFAULT_SETTINGS);
    expect(damaged.settings.piExecutablePath).toBe("");
    expect(damaged.settings.customInstructions).toBe("");
    expect(damaged.settings.chatHistory).toBeUndefined();
    expect(damaged.settings.currentThreadId).toBeUndefined();
    expect(plain(damaged.threadHistory.toJSON())).toEqual(stored);

    console.log(
      "[D2] settings source: data.json when readable, defaults when damaged; " +
        "chat history always from the backup"
    );
  });
});

// ---------------------------------------------------------------------------
// E. Boundaries after a failed read
// ---------------------------------------------------------------------------

describe("E: boundaries after a failed read", () => {
  it("E1: a non-JSON failure leaves constructor state intact and can initialize again", async () => {
    const vaultDirectory = createVaultDirectory();
    const directory = expectedPluginDirectory(vaultDirectory);
    const recovered = createHistory("backup", ["recovered-thread"]);
    await writeChatHistoryBackup(directory, recovered);

    const permissionError = createHostError("EACCES: permission denied", "EACCES");
    const plugin = createPlugin(vaultDirectory, async () => Promise.reject(permissionError));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(plugin.loadSettings()).rejects.toBe(permissionError);

    expect(harness.notices).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(plugin.threadHistory).toBeInstanceOf(ThreadStore);
    expect(plugin.messages).toEqual([]);
    expect(plugin.settings.model).toBe("");

    // A later, healthy load is not blocked by the earlier rejection: the same plugin
    // object still initializes, with the backup restoring the chat history.
    plugin.loadData = loadDataReturning({ piExecutablePath: "/retry/pi" });
    await plugin.loadSettings();

    expect(plugin.settings.piExecutablePath).toBe("/retry/pi");
    expect(plain(plugin.threadHistory.toJSON())).toEqual(recovered);
    expect(plugin.getCurrentThread().id).toBe("recovered-thread");
    expect(harness.notices).toEqual([RECOVERY_NOTICE]);

    console.log(
      "[E1] the rejection surfaced with no notice, no warning and a live ThreadStore; a later " +
        "loadSettings() recovers the backup"
    );
  });
});

// ---------------------------------------------------------------------------
// F. Full plugin onload()
// ---------------------------------------------------------------------------

describe("F: plugin onload()", () => {
  it("F1: onload() completes and restores the backup after a JSON parse failure", async () => {
    const vaultDirectory = createVaultDirectory();
    const directory = expectedPluginDirectory(vaultDirectory);
    const stored = createHistory("backup", ["onload-a", "onload-b"], "onload-b");
    await writeChatHistoryBackup(directory, stored);

    const { error, loadData } = loadDataWithDamagedJson();
    const plugin = createPlugin(vaultDirectory, loadData);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Before the fix this await rejected, so onload() never finished initializing.
    await expect(plugin.onload()).resolves.toBeUndefined();

    expect(plain(plugin.threadHistory.toJSON())).toEqual(stored);
    expect(plugin.threadHistory.currentThreadId).toBe("onload-b");
    expect(harness.notices).toEqual([RECOVERY_NOTICE]);
    expectParseWarning(warn, error);

    // Initialization actually ran to the end, not just loadSettings().
    expect(plugin.extensionStatusEl).toBeInstanceOf(FakeElement);
    expect(plugin.annotationController).toBeDefined();
    expect(plugin.contextBuilder).toBeDefined();
    expect(plugin.pi).toBeDefined();
    expect(plugin.settingsTab).toBeDefined();

    // Defaults from the unreadable file, plus the config directory the settings tab
    // always prepends to ignoredFolders.
    expect(plugin.settings).toEqual({
      ...DEFAULT_SETTINGS,
      ignoredFolders: [CONFIG_DIR, ...DEFAULT_SETTINGS.ignoredFolders]
    });

    plugin.onunload();

    console.log(
      "[F1] onload() resolved after loadData() rejected; history restored from the backup, " +
        "1 recovery notice, 1 parse warning, services and settings tab initialized"
    );
  });
});
