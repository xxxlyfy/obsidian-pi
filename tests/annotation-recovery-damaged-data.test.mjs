/**
 * Regression: a damaged `data.json` must not cost the annotations.
 *
 * The failure this file pins down, found by the previous batch's injection:
 *
 *   annotations exist in `data.json`
 *   -> `data.json` becomes invalid JSON
 *   -> plugin startup (`loadSettings()`)
 *   -> chat history was restored from the local backup, annotations were not
 *   -> the next ordinary save (`savePluginData()`) wrote the empty store back
 *   -> every annotation was gone for good.
 *
 * Two properties are asserted here, in the order they matter:
 *
 *   1. Recoverable -- the snapshot the chat history comes from now carries the
 *      annotation data of its own generation, so a damaged `data.json` is repaired by
 *      the next ordinary save instead of being erased by it, and the original annotation
 *      ids are still there after a save and after a reload.
 *   2. Unreachable -- when no snapshot can supply the annotations (a backup written
 *      before it carried them, or none at all), the save is refused outright and the
 *      damaged file is left exactly as it was. Refusing is the only safe outcome: the
 *      unreadable file is the last remaining copy of those annotations, and a save
 *      replaces the file whole.
 *
 * Which layer is under test:
 *
 * - `PiAgentPlugin.prototype.loadSettings()` and `PiAgentPlugin.prototype
 *   .savePluginData()` are the real production methods, and `AnnotationStore`,
 *   `ThreadStore`, the settings normalizer, the backup writer and the backup reader are
 *   the real production modules. Nothing on the recovery or the save path is mocked.
 * - Only Obsidian's host boundary is stubbed, and it is stubbed the way Obsidian
 *   behaves: `loadData()` reads the plugin's `data.json` from disk and hands the text to
 *   `JSON.parse` (so a damaged file rejects with a SyntaxError, which is exactly the
 *   failure the production code classifies, and an absent file resolves to `null`), and
 *   `saveData()` writes the object it is given back to that same file. Neither stub is
 *   an Obsidian process: this is the plugin's own data-recovery and persistence code
 *   over a real filesystem.
 *
 * The baseline case exists so a failure below cannot be blamed on `AnnotationStore`
 * itself: with an intact `data.json`, the same load path restores the same annotations
 * from the same store.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** User-visible notices, so the recovery notice can be asserted. */
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

const { PiAgentPlugin } = await import("../src/plugin/PiAgentPlugin.mjs");
const { DEFAULT_SETTINGS } = await import("../src/plugin/settings.mjs");
const { AnnotationStore } = await import("../src/annotations/annotation-store.mjs");

const DATA_FILE = "data.json";
const BACKUP_FILE = "chat-history.backup.json";
const RECOVERY_NOTICE = "Pi Agent recovered chat history from its local backup.";
const CONFIG_DIR = ".obsidian";
const PLUGIN_DIR_SEGMENTS = [CONFIG_DIR, "plugins", "pi-agent"];
const DAMAGED_JSON = "{damaged";
const ANNOTATION_PATH = "Recovery note.md";
const PI_EXECUTABLE = "/opt/pi-redirect";

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

function createVaultDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-annotation-recovery-"));
  vaultDirectories.push(directory);
  return directory;
}

/** The plugin directory Obsidian would hand to `getPluginDirectory()`. */
function expectedPluginDirectory(vaultDirectory) {
  return path.resolve(vaultDirectory, ...PLUGIN_DIR_SEGMENTS);
}

/** The `data.json` path the stubbed host boundary reads and writes. */
function dataFilePath(vaultDirectory) {
  return path.join(expectedPluginDirectory(vaultDirectory), DATA_FILE);
}

function backupFilePath(vaultDirectory) {
  return path.join(expectedPluginDirectory(vaultDirectory), BACKUP_FILE);
}

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
 * The real plugin over the stubbed Obsidian boundary.
 *
 * `loadData()`/`saveData()` are the two replaced host methods, and both are file
 * access over the vault directory: Obsidian's `loadData()` is `adapter.read()` plus
 * `JSON.parse`, so a damaged file rejects with a SyntaxError here for the same reason
 * it does in the app, and an absent file resolves to `null` (`await this.loadData()`
 * is `?? {}`-ed by the production code) rather than surfacing a read error the app
 * would never produce.
 */
function createPlugin(vaultDirectory) {
  const app = createApp(vaultDirectory);
  const manifest = { id: "pi-agent", dir: PLUGIN_DIR_SEGMENTS.join("/") };
  const plugin = new PiAgentPlugin(app, manifest);
  plugin.app = app;
  plugin.manifest = manifest;
  const file = dataFilePath(vaultDirectory);
  plugin.loadData = async () => {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      // Obsidian returns nothing when the plugin has never saved; only a JSON.parse
      // failure is the "damaged data" case the production code recovers from.
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    return JSON.parse(text);
  };
  plugin.saveData = async (data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  return plugin;
}

/** Read the persisted `data.json` exactly as Obsidian's `loadData()` would. */
function readDataFile(vaultDirectory) {
  return JSON.parse(fs.readFileSync(dataFilePath(vaultDirectory), "utf8"));
}

/** The raw `data.json` bytes, so "the file was not overwritten" is checkable. */
function readRawDataFile(vaultDirectory) {
  return fs.readFileSync(dataFilePath(vaultDirectory), "utf8");
}

/** The stored `data.json`, or a description of why it could not be parsed. */
function dataFileState(vaultDirectory) {
  try {
    return { parsed: readDataFile(vaultDirectory) };
  } catch (error) {
    return { error: error.message };
  }
}

/** One annotation record, as `AnnotationStore.create()` persists it. */
function createAnnotation(plugin, quote, offset) {
  return plugin.annotationStore.create({
    path: ANNOTATION_PATH,
    intent: "question",
    context: `${quote} context`,
    quote,
    range: { from: offset, to: offset + quote.length }
  });
}

/**
 * Create the annotations a damaging event is about to endanger, persist them through
 * the production save path, and confirm they really are in `data.json` first.
 */
async function seedPersistedAnnotations(
  vaultDirectory,
  quotes = ["first annotation", "second annotation"]
) {
  const plugin = createPlugin(vaultDirectory);
  await plugin.loadSettings();
  const created = quotes.map((quote, index) => createAnnotation(plugin, quote, index * 30));
  plugin.settings.piExecutablePath = PI_EXECUTABLE;
  await plugin.savePluginData();

  const persisted = readDataFile(vaultDirectory);
  expect(annotationIdsOf(persisted.annotationData, ANNOTATION_PATH)).toEqual(
    created.map((annotation) => annotation.id)
  );
  return { plugin, created, persisted };
}

/** The annotation ids one persisted `annotationData` document holds for a path. */
function annotationIdsOf(annotationData, notePath) {
  return (annotationData?.annotations?.[notePath] ?? []).map((annotation) => annotation.id);
}

/** The annotation ids the live store holds for a path. */
function storeIds(plugin) {
  return plugin.annotationStore.list(ANNOTATION_PATH).map((annotation) => annotation.id);
}

/** A backup payload as the pre-annotation format wrote it: history, and nothing else. */
function writeLegacyBackup(directory, history) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, BACKUP_FILE),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        savedAt: new Date().toISOString(),
        checksum: crypto.createHash("sha256").update(JSON.stringify(history)).digest("hex"),
        chatHistory: history
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

/** Compare persisted data without depending on `undefined`-valued extras. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// 1. Baseline: intact data.json still restores its annotations
// ---------------------------------------------------------------------------

describe("baseline: intact data.json", () => {
  it("1: loads the stored annotation into the real AnnotationStore, and a save keeps it", async () => {
    const vaultDirectory = createVaultDirectory();
    const { created } = await seedPersistedAnnotations(vaultDirectory, ["baseline quote"]);

    // A fresh load (this is the reload half of the baseline).
    const plugin = createPlugin(vaultDirectory);
    await plugin.loadSettings();

    expect(plugin.annotationStore).toBeInstanceOf(AnnotationStore);
    expect(plugin.annotationStore.count()).toBe(1);
    expect(storeIds(plugin)).toEqual([created[0].id]);
    expect(plugin.annotationStore.list(ANNOTATION_PATH)[0].quote).toBe("baseline quote");
    expect(plugin.settings.piExecutablePath).toBe(PI_EXECUTABLE);
    // Nothing needed recovering, so no recovery notice and no refusal.
    expect(harness.notices).toEqual([]);
    expect(plugin.isAnnotationRecoveryPending()).toBe(false);

    // The normal load -> modify -> save -> reload path is untouched.
    createAnnotation(plugin, "added later", 60);
    await plugin.savePluginData();
    const reloaded = createPlugin(vaultDirectory);
    await reloaded.loadSettings();

    expect(reloaded.annotationStore.count()).toBe(2);
    expect(storeIds(reloaded)).toEqual([created[0].id, expect.any(String)]);
    expect(annotationIdsOf(readDataFile(vaultDirectory).annotationData, ANNOTATION_PATH)).toEqual(
      storeIds(reloaded)
    );

    console.log(
      `[baseline] intact data.json: annotations=1 (id=${created[0].id}) -> ` +
        `modified/saved/reloaded annotations=${reloaded.annotationStore.count()}, notices=0`
    );
  });
});

// ---------------------------------------------------------------------------
// 2. The regression: damaged data.json, annotations still recoverable
// ---------------------------------------------------------------------------

describe("regression: a damaged data.json no longer costs the annotations", () => {
  it("2: recovers the annotations with the chat history, repairs data.json on the next save, and keeps them after a reload", async () => {
    const vaultDirectory = createVaultDirectory();
    const { plugin: seed, created } = await seedPersistedAnnotations(vaultDirectory);
    const chatThreadId = seed.threadHistory.currentThreadId;

    // The snapshot the production save path wrote carries the annotations too, which is
    // what makes them recoverable at all.
    const backupBeforeDamage = JSON.parse(fs.readFileSync(backupFilePath(vaultDirectory), "utf8"));
    expect(annotationIdsOf(backupBeforeDamage.annotationData, ANNOTATION_PATH)).toEqual(
      created.map((annotation) => annotation.id)
    );

    // --- Damage data.json into invalid JSON.
    fs.writeFileSync(dataFilePath(vaultDirectory), DAMAGED_JSON, "utf8");
    expect(() => JSON.parse(readRawDataFile(vaultDirectory))).toThrow(SyntaxError);

    // --- A real reload of the plugin data, through the production load path.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = createPlugin(vaultDirectory);
    await expect(plugin.loadSettings()).resolves.toBeUndefined();

    // chatHistory: restored, as before.
    expect(plugin.threadHistory.currentThreadId).toBe(chatThreadId);
    // Annotations: restored from the same snapshot, by id -- not merely "not empty".
    expect(plugin.annotationStore).toBeInstanceOf(AnnotationStore);
    expect(plugin.annotationStore.count()).toBe(2);
    expect(storeIds(plugin)).toEqual(created.map((annotation) => annotation.id));
    expect(plugin.annotationStore.list(ANNOTATION_PATH).map((item) => item.quote)).toEqual([
      "first annotation",
      "second annotation"
    ]);
    // The recovery was real, so the recovered store is a saveable state.
    expect(plugin.isAnnotationRecoveryPending()).toBe(false);
    expect(harness.notices).toEqual([RECOVERY_NOTICE]);
    expect(warn).toHaveBeenCalledTimes(1);

    // --- One ordinary save: the damaged file is repaired, not erased.
    await expect(plugin.savePluginData()).resolves.toBeUndefined();

    const repaired = readDataFile(vaultDirectory);
    expect(annotationIdsOf(repaired.annotationData, ANNOTATION_PATH)).toEqual(
      created.map((annotation) => annotation.id)
    );
    expect(repaired.annotationData).not.toEqual({ schemaVersion: 1, annotations: {} });
    expect(repaired.chatHistory.currentThreadId).toBe(chatThreadId);
    // The settings lost to the unreadable file cannot come back from a snapshot that
    // never carried them; that is unchanged behaviour and not what this batch fixes.
    expect(repaired.piExecutablePath).toBe("");

    // --- Reload after the save: the annotations are still there.
    const reloaded = createPlugin(vaultDirectory);
    await reloaded.loadSettings();
    expect(reloaded.annotationStore.count()).toBe(2);
    expect(storeIds(reloaded)).toEqual(created.map((annotation) => annotation.id));
    expect(reloaded.threadHistory.currentThreadId).toBe(chatThreadId);

    console.log(
      `[2] damaged data.json -> recovered chatHistory=${chatThreadId} and ` +
        `annotations=${created.length} (ids preserved) -> save repaired data.json -> ` +
        `reload annotations=${reloaded.annotationStore.count()}; notices=${JSON.stringify(harness.notices)}`
    );
  });

  it("3: refuses the save and leaves the damaged file untouched when no snapshot carries the annotations", async () => {
    const vaultDirectory = createVaultDirectory();
    const { plugin: seed, created } = await seedPersistedAnnotations(vaultDirectory);
    const chatHistory = plain(seed.threadHistory.toJSON());

    // A snapshot from before the backup carried annotations: it still restores the chat
    // history (existing behaviour), and it holds no annotation copy at all.
    writeLegacyBackup(expectedPluginDirectory(vaultDirectory), chatHistory);

    fs.writeFileSync(dataFilePath(vaultDirectory), DAMAGED_JSON, "utf8");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const plugin = createPlugin(vaultDirectory);
    await plugin.loadSettings();

    // The chat history still comes from the backup, exactly as it always did.
    expect(plugin.threadHistory.currentThreadId).toBe(chatHistory.currentThreadId);
    expect(harness.notices).toEqual([RECOVERY_NOTICE]);
    // The annotations could not be recovered, so the store is empty and the refusal is
    // armed -- this is the state that used to be saved over the records.
    expect(plugin.annotationStore.count()).toBe(0);
    expect(plugin.isAnnotationRecoveryPending()).toBe(true);

    // Every save path the plugin has, refused.
    await expect(plugin.savePluginData()).rejects.toThrow(/annotations could not be recovered/);
    await expect(plugin.saveSettings()).rejects.toThrow(/annotations could not be recovered/);
    plugin.saveAnnotations();
    plugin.saveThreadHistory();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.notices).toContain("Could not save annotations to plugin data.");

    // Disk: the damaged bytes are byte-for-byte what they were, so the annotations they
    // still contain were never overwritten. This is the whole point of refusing.
    expect(readRawDataFile(vaultDirectory)).toBe(DAMAGED_JSON);
    expect(dataFileState(vaultDirectory).error).toMatch(/JSON/i);

    console.log(
      `[3] damaged data.json without an annotation snapshot -> chatHistory restored, ` +
        `annotations=${plugin.annotationStore.count()} (${created.length} unreadable), ` +
        `save refused, data.json untouched (${readRawDataFile(vaultDirectory)})`
    );
  });

  it("4: the live store recovers once annotations exist again, so the refusal is not permanent", async () => {
    const vaultDirectory = createVaultDirectory();
    await seedPersistedAnnotations(vaultDirectory);
    // No recoverable snapshot at all: the annotations are unreachable this session.
    fs.rmSync(backupFilePath(vaultDirectory), { force: true });
    fs.rmSync(
      path.join(expectedPluginDirectory(vaultDirectory), "chat-history.backup.previous.json"),
      { force: true }
    );
    fs.writeFileSync(dataFilePath(vaultDirectory), DAMAGED_JSON, "utf8");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const plugin = createPlugin(vaultDirectory);
    await plugin.loadSettings();
    expect(plugin.isAnnotationRecoveryPending()).toBe(true);
    await expect(plugin.savePluginData()).rejects.toThrow(/annotations could not be recovered/);

    // The user annotates a note again: there is something worth persisting now, and
    // `AnnotationStore` is the same store, so the refusal stops applying.
    const recreated = createAnnotation(plugin, "annotated after the damage", 0);
    expect(plugin.isAnnotationRecoveryPending()).toBe(false);
    await expect(plugin.savePluginData()).resolves.toBeUndefined();

    const persisted = readDataFile(vaultDirectory);
    expect(annotationIdsOf(persisted.annotationData, ANNOTATION_PATH)).toEqual([recreated.id]);

    const reloaded = createPlugin(vaultDirectory);
    await reloaded.loadSettings();
    expect(storeIds(reloaded)).toEqual([recreated.id]);

    console.log(
      "[4] refusal lifted by a new annotation: save succeeded, reload holds " +
        `annotations=${reloaded.annotationStore.count()}`
    );
  });
});

// ---------------------------------------------------------------------------
// 4. The store itself is not the variable
// ---------------------------------------------------------------------------

describe("control: the store is not what loses the records", () => {
  it("5: AnnotationStore rebuilds the persisted records, and builds an empty store from nothing", () => {
    // `normalizeAnnotationData()` receives exactly what the recovery path passes it:
    // the persisted document (records kept) or `undefined` (nothing to keep). The two
    // outcomes differ only in the input, which is why the fix is in the recovery path.
    const persisted = {
      schemaVersion: 1,
      annotations: {
        [ANNOTATION_PATH]: [
          {
            id: "control-a",
            path: ANNOTATION_PATH,
            intent: "question",
            context: "Control context",
            quote: "control quote",
            range: { from: 0, to: "control quote".length },
            targetKind: "selection",
            status: "attached",
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000
          }
        ]
      }
    };

    const fromPersisted = new AnnotationStore(persisted);
    const fromUndefined = new AnnotationStore(undefined);

    // The persisted document is rebuilt (normalized fields added, its own values kept),
    // so the record survives the store rather than being dropped by it.
    expect(fromPersisted.count()).toBe(1);
    expect(fromPersisted.list(ANNOTATION_PATH)[0]).toMatchObject({
      id: "control-a",
      path: ANNOTATION_PATH,
      context: "Control context",
      quote: "control quote"
    });
    expect(fromUndefined.count()).toBe(0);
    expect(fromUndefined.toJSON()).toEqual({ schemaVersion: 1, annotations: {} });

    console.log(
      `[5] control: AnnotationStore(persisted)=${fromPersisted.count()} annotation(s), ` +
        `AnnotationStore(undefined)=${fromUndefined.count()} -- the store is not the variable`
    );
  });

  it("6: AnnotationStore(undefined) round-trips to the empty document a save would have written", () => {
    // The payload a destructive save produced, asserted at the store boundary so the
    // regression above is anchored to the same document.
    expect(new AnnotationStore(undefined).toJSON()).toEqual({ schemaVersion: 1, annotations: {} });
    expect(DEFAULT_SETTINGS.piExecutablePath).toBe("");
  });
});
