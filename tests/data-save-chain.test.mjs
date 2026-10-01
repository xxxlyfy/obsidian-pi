/**
 * Failure recovery and serialization of `PiAgentPlugin.dataSaveChain`.
 *
 * `savePluginData()` chains every save onto `this.dataSaveChain` and swallows the
 * previous link's rejection before starting the next one. Two properties depend on
 * that shape, and neither can be seen from a single save:
 *
 *   1. Recovery -- one failed save (either the `saveData()` step or the
 *      `writeChatHistoryBackup()` step) must reject only its own caller. The next save
 *      must really run, and the chain must not stay permanently rejected.
 *   2. Serialization -- saves must enter the persistence steps in call order and one
 *      at a time, so two writers can never interleave a `data.json` write and a backup
 *      write, and the last queued snapshot is the one that ends up on disk.
 *
 * The plugin under test is the real `PiAgentPlugin.prototype`, the thread store and
 * the annotation store are the production ones, and `dataSaveChain` is not touched.
 * Only the two external I/O boundaries are replaced: `saveData()` (Obsidian's
 * `data.json` write) and `writeChatHistoryBackup()` (the vault backup module). Both
 * go through one ledger that records, per step, its sequence number, entry and exit
 * order, entry and exit timestamps, the payload it persisted and its outcome.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Test-owned state the hoisted module mocks read. */
const harness = vi.hoisted(() => ({
  notices: [],
  /** `writeChatHistoryBackup` stub; the real module is loaded for its reader. */
  writeChatHistoryBackup: async () => undefined
}));

vi.mock("obsidian", () => {
  class ObsidianBase {}
  return {
    Component: ObsidianBase,
    FuzzySuggestModal: ObsidianBase,
    ItemView: ObsidianBase,
    MarkdownRenderChild: ObsidianBase,
    MarkdownRenderer: { render: vi.fn().mockResolvedValue(undefined) },
    MarkdownView: ObsidianBase,
    Menu: ObsidianBase,
    Modal: ObsidianBase,
    Notice: class Notice {
      constructor(message) {
        harness.notices.push(String(message));
      }
    },
    Platform: { isDesktopApp: true },
    Plugin: ObsidianBase,
    PluginSettingTab: ObsidianBase,
    Setting: ObsidianBase,
    SuggestModal: ObsidianBase,
    TFile: ObsidianBase,
    addIcon: vi.fn(),
    getLanguage: () => "en",
    normalizePath: (value) => value,
    setIcon: vi.fn()
  };
});

// The vault backup module keeps its real reader and only its writer is instrumented:
// `writeChatHistoryBackup()` is one of the two external I/O boundaries under test.
vi.mock("../src/threads/chat-history-backup.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeChatHistoryBackup: async (...args) => harness.writeChatHistoryBackup(...args)
  };
});

const { PiAgentPlugin } = await import("../src/plugin/PiAgentPlugin.mjs");
const { DEFAULT_SETTINGS } = await import("../src/plugin/settings.mjs");
const { AnnotationStore } = await import("../src/annotations/annotation-store.mjs");
const { ThreadStore } = await import("../src/threads/thread-store.mjs");
const { readChatHistoryBackup } = await import("../src/threads/chat-history-backup.mjs");

const DATA_FILE = "data.json";
const BACKUP_FILE = "chat-history.backup.json";
/** A hung chain must fail the test instead of hanging the run. */
const SETTLE_TIMEOUT_MS = 1_500;

let temporaryDirectories = [];
let unhandledRejectionListener;

afterEach(() => {
  if (unhandledRejectionListener) {
    process.off("unhandledRejection", unhandledRejectionListener);
    unhandledRejectionListener = undefined;
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  harness.notices.length = 0;
  vi.restoreAllMocks();
});

function createDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-save-chain-"));
  temporaryDirectories.push(directory);
  return directory;
}

// ---------------------------------------------------------------------------
// The persistence ledger: the two instrumented I/O boundaries
// ---------------------------------------------------------------------------

/**
 * One persisted step. `entry`/`exit` are monotonically increasing positions, so an
 * overlap (two steps inside the persistence steps at once) is visible as an `entry`
 * that is not greater than the previous `exit`, and the order steps ran in is visible
 * as the sequence of `exit` values. `hex` is the `currentThreadId` of the snapshot the
 * step persisted, which ties a backup write to the `data.json` write it belongs to.
 */
function createLedger() {
  return {
    /** @type {Array<{seq:number,phase:string,hex:string,entry:number,exit:number,startedAt:number,finishedAt:number,payload:any,outcome:string,error?:any}>} */
    entries: [],
    /** @type {Map<number, string>} Injected failure by step index (1-based). */
    failAt: new Map(),
    /** @type {Map<string, {phase: string, code: string}>} Injected failure by save label. */
    failLabel: new Map(),
    /**
     * Milliseconds every persistence step spends inside the ledger before returning.
     * Test-only: it makes a save long enough to overlap another one, which is exactly
     * what a writer that stopped waiting for the previous step would do.
     */
    delayMs: 0,
    /** Millisecond position of the next step boundary. */
    position: 0,
    /**
     * How many steps are inside the persistence boundary right now, and the highest
     * that number ever got. This measures overlap directly: if two saves persist at the
     * same time, the count reaches two no matter when each of them got its position.
     */
    concurrent: 0,
    maxConcurrent: 0,
    saveDataCalls: 0,
    backupCalls: 0,

    /** Fail the step with index `seq` (1-based, in call order). */
    fail(seq, code, phase) {
      this.failAt.set(seq, { code, phase });
    },

    /** @param {{directory: string, data?: any, history?: any}} payload */
    async persist(phase, payload) {
      const seq = this.entries.length + 1;
      // Both boundaries persist the snapshot the same `savePluginData()` call captured:
      // `saveData()` receives it as `data.chatHistory`, the backup writer as `history`.
      const snapshot = phase === "saveData" ? payload.data.chatHistory : payload.history;
      const entry = {
        seq,
        phase,
        hex: snapshot.currentThreadId,
        // One position per side of the step, so every step occupies its own pair of
        // positions and any overlap shows up as a non-consecutive `entry`.
        entry: (this.position += 1),
        exit: 0,
        startedAt: Date.now(),
        finishedAt: 0,
        payload,
        outcome: "pending"
      };
      this.entries.push(entry);
      this.concurrent += 1;
      this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
      if (phase === "saveData") this.saveDataCalls += 1;
      else this.backupCalls += 1;

      // A step-targeted failure fires on its global step number; a label-targeted one
      // fires on the named save's own step, which the test cannot know in advance.
      const byStep = this.failAt.get(seq);
      const byLabel = this.failLabel.get(snapshot.currentThreadId);
      const injected = byLabel && byLabel.phase === phase ? byLabel : byStep;
      // `saveData()` persists the whole plugin data object, the backup writer only the
      // snapshot; tests assert against the snapshot envelope either way.
      const envelope =
        phase === "saveData" ? payload.data : { schemaVersion: 1, chatHistory: payload.history };
      try {
        if (injected) {
          throw Object.assign(new Error(`${injected.code}: injected at ${phase}`), {
            code: injected.code
          });
        }
        // The observable effect of the real write, so the final disk state can be
        // checked as well.
        if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        if (phase === "saveData") {
          fs.writeFileSync(
            path.join(payload.directory, DATA_FILE),
            `${JSON.stringify(envelope, null, 2)}\n`,
            "utf8"
          );
        } else {
          // The same envelope the production writer produces, checksum included, so the
          // production reader can validate what this step left behind.
          fs.writeFileSync(
            path.join(payload.directory, BACKUP_FILE),
            `${JSON.stringify(
              {
                schemaVersion: 1,
                savedAt: new Date().toISOString(),
                checksum: checksumOf(payload.history),
                chatHistory: payload.history
              },
              null,
              2
            )}\n`,
            "utf8"
          );
        }
        entry.outcome = "resolved";
        return undefined;
      } catch (error) {
        entry.outcome = "rejected";
        entry.error = error;
        throw error;
      } finally {
        entry.finishedAt = Date.now();
        entry.exit = this.position += 1;
        this.concurrent -= 1;
      }
    },

    entriesFrom(start) {
      return this.entries.slice(start);
    }
  };
}

// ---------------------------------------------------------------------------
// The plugin under test
// ---------------------------------------------------------------------------

/**
 * The real plugin prototype with the real `threadHistory`, `annotationStore`,
 * `dataSaveChain` and `savePluginData()`. Only the two external I/O boundaries are
 * stubbed, and both route through the ledger.
 */
function createPlugin(ledger) {
  const directory = createDirectory();
  const plugin = Object.create(PiAgentPlugin.prototype);
  plugin.settings = { ...DEFAULT_SETTINGS };
  plugin.threadHistory = new ThreadStore();
  plugin.annotationStore = new AnnotationStore();
  plugin.localPromptQueue = [];
  plugin.localPromptSteering = [];
  plugin.dataSaveChain = Promise.resolve();
  plugin.getPluginDirectory = () => directory;
  // The boundary that Obsidian's Plugin base class provides in the real app.
  plugin.saveData = async (data) => {
    await ledger.persist("saveData", { directory, data });
  };
  return { plugin, directory };
}

/** Point the instrumented backup boundary at the ledger and this vault directory. */
function stubBackup(ledger) {
  harness.writeChatHistoryBackup = (directory, history) =>
    ledger.persist("backup", { directory, history });
}

/**
 * A save whose snapshot carries the label `hex`, so every persisted step can be tied
 * back to the exact `savePluginData()` call that produced it.
 *
 * The store is replaced and `savePluginData()` is called in the same synchronous
 * block, exactly as a real caller does, so the snapshot this save captured is the one
 * carrying `hex`. Because the label is read back from the persisted payloads rather
 * than assumed, a "call order" that the chain did not keep would show up in the ledger.
 */
function saveSnapshot(plugin, hex) {
  plugin.threadHistory = new ThreadStore({
    currentThreadId: hex,
    threads: [
      {
        id: hex,
        title: `Chat ${hex}`,
        messages: [],
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        archived: false,
        favorite: false
      }
    ]
  });
  return plugin.savePluginData();
}

// ---------------------------------------------------------------------------
// Observation helpers
// ---------------------------------------------------------------------------

/** Wait for every promise to settle, or fail loudly if the chain is wedged. */
async function settleWithin(promises, label) {
  const settled = await Promise.race([
    Promise.allSettled(promises),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), SETTLE_TIMEOUT_MS))
  ]);
  if (settled === "timeout")
    throw new Error(`${label}: a save never settled within ${SETTLE_TIMEOUT_MS}ms`);
  return settled;
}

/** Why a save was rejected, or `undefined` when it resolved. */
function rejectionOf(result) {
  return result.status === "rejected" ? result.reason : undefined;
}

/**
 * Assert one save's outcome: rejected with `code`, or resolved when `code` is
 * `undefined`.
 */
function expectSaveOutcome(result, code) {
  if (code === undefined) {
    expect(rejectionOf(result)).toBeUndefined();
    return;
  }
  expect(rejectionOf(result)).toMatchObject({ code });
}

/**
 * Make one named save fail at one of its two steps, before the save was even started.
 *
 * The failure is armed by the save's own label -- the label is the snapshot it captures
 * -- rather than by a queue position, so it lands on exactly the save the test names
 * even while four saves are queued in one tick.
 */
function planSaveFailure(ledger, label, phase, code) {
  ledger.failLabel.set(label, { phase, code });
}

/** The global step number an armed label failure ended up on. */
function stepOf(ledger, hex, phase) {
  return ledger.entries.find((entry) => entry.hex === hex && entry.phase === phase)?.seq;
}

/** The step an injected failure landed on really belongs to the save it was aimed at. */
function expectInjectedAt(ledger, hex, phase, code) {
  const failed = ledger.entries.filter((entry) => entry.outcome === "rejected");
  expect(failed.map((entry) => [entry.hex, entry.phase])).toEqual([[hex, phase]]);
  expect(failed[0].error).toMatchObject({ code });
  return failed[0].seq;
}

/**
 * The step before a backup must be the `data.json` write it belongs to, which is the
 * immediately preceding step unless a previous save failed and skipped its own backup.
 */
function precedingSave(entries, index) {
  if (index > 0 && entries[index - 1].phase === "saveData") return entries[index - 1];
  return entries
    .slice(0, index)
    .filter((entry) => entry.phase === "saveData")
    .pop();
}

/**
 * The properties the chain has to deliver for one batch of saves.
 *
 * Serialization: the first entry really is the first step of the batch, every step
 * comes back before the next one starts (no overlap, checked both by position and by
 * the number of steps inside the boundary at once), they run in the order they were
 * enqueued, and every backup write belongs to the `data.json` write that preceded it.
 * Structure: a backup only ever follows its own save, and the number of backup steps
 * is the number of saves minus the ones that failed, whose backup step was skipped.
 */
function verifyStrictSerialization(
  entries,
  { ledger, expectedBackupSteps, firstPosition = 1 } = {}
) {
  expect(entries.length).toBeGreaterThan(0);
  expect(entries[0].entry).toBe(firstPosition);
  expect(entries[0].phase).toBe("saveData");
  expect(entries.every((entry) => entry.outcome !== "pending")).toBe(true);
  // Never two persistence steps inside the boundary at the same time.
  if (ledger) expect(ledger.maxConcurrent).toBe(1);
  expect(entries.map((entry) => entry.seq)).toEqual(
    entries.map((_entry, index) => entries[0].seq + index)
  );

  const saves = entries.filter((entry) => entry.phase === "saveData");
  const backups = entries.filter((entry) => entry.phase === "backup");
  expect(backups).toHaveLength(expectedBackupSteps ?? saves.length);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    expect(entry.exit).toBeGreaterThan(entry.entry);
    expect(entry.exit - entry.entry).toBe(1);
    // A step cannot start inside another step. Consecutive positions are stronger
    // than that: the next step started exactly after the previous one finished.
    if (index > 0) {
      expect(entry.entry).toBe(entries[index - 1].exit + 1);
      expect(entry.seq).toBeGreaterThan(entries[index - 1].seq);
    }
    if (entry.phase === "backup") {
      // A backup never appears without the `data.json` write it belongs to, and it
      // always persists that write's own snapshot.
      expect(precedingSave(entries, index)?.hex).toBe(entry.hex);
    }
  }
  // Completion order matches entry order, so the ledger's tail is the last save.
  expect(entries.map((entry) => entry.exit)).toEqual(
    [...entries.map((entry) => entry.exit)].sort((left, right) => left - right)
  );
}

/** The payload `saveData()` persisted for a snapshot `.json` file. */
function readDataFile(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, DATA_FILE), "utf8"));
}

/** The checksum recipe of the backup format, read independently of the module. */
function checksumOf(history) {
  return crypto.createHash("sha256").update(JSON.stringify(history)).digest("hex");
}

function readBackupFile(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, BACKUP_FILE), "utf8"));
}

/** The labels of the snapshots the ledger persisted to `data.json`. */
function savedLabels(entries) {
  return entries.filter((entry) => entry.phase === "saveData").map((entry) => entry.hex);
}

/**
 * What the *production* backup reader sees. The instrumented writer never left one of
 * the two-step backup files behind, so the reader is verified against an interruption
 * that left only `data.json`: the write that failed to reach the backup must never
 * look like a save that persisted nothing.
 */
async function readBackup(directory) {
  return readChatHistoryBackup(directory);
}

// ---------------------------------------------------------------------------
// 1. A failed saveData does not poison the next save
// ---------------------------------------------------------------------------

describe("dataSaveChain recovery after a failed saveData", () => {
  it("1: the first save rejects with its own error, the second really runs and the chain recovers", async () => {
    const ledger = createLedger();
    const { plugin, directory } = createPlugin(ledger);
    stubBackup(ledger);
    // The first save fails at its own `saveData()` step, before any backup write.
    planSaveFailure(ledger, "one", "saveData", "EIO");

    const first = saveSnapshot(plugin, "one");
    const second = saveSnapshot(plugin, "two");
    const [firstResult, secondResult] = await settleWithin([first, second], "sequence 1 then 2");

    // The failure belongs to the first caller only, and it is the error itself.
    expect(rejectionOf(firstResult)).toMatchObject({ code: "EIO" });
    expect(rejectionOf(secondResult)).toBeUndefined();

    // The second call really performed both persistence steps with its own snapshot.
    const entries = ledger.entries;
    expect(entries).toHaveLength(3);
    expectInjectedAt(ledger, "one", "saveData", "EIO");
    verifyStrictSerialization(entries, { ledger, expectedBackupSteps: 1 });
    expect(savedLabels(entries)).toEqual(["one", "two"]);
    expect(entries.filter((entry) => entry.phase === "backup").map((entry) => entry.hex)).toEqual([
      "two"
    ]);

    // The chain itself ended fulfilled, not permanently rejected.
    await expect(plugin.dataSaveChain).resolves.toBeUndefined();

    // disk: the last save's data.json is the final state, because the second save ran
    // and replaced what the failed first save had already written. The backup writer
    // the failed save never reached is unaffected by the failure.
    const data = readDataFile(directory);
    expect(data.chatHistory.currentThreadId).toBe("two");
    expect((await readBackup(directory))?.currentThreadId).toBe("two");

    // A third save after a failure is never skipped either.
    const third = await saveSnapshot(plugin, "three");
    expect(third).toBeUndefined();
    expect(savedLabels(ledger.entries)).toEqual(["one", "two", "three"]);
    expect(readDataFile(directory).chatHistory.currentThreadId).toBe("three");
    console.log(
      `[1] saveData EIO on the first save: first=rejected(EIO); second=resolved; ` +
        `steps so far=${entries.map((entry) => `${entry.hex}:${entry.phase}`).join(" -> ")}; disk=three`
    );
  });
});

// ---------------------------------------------------------------------------
// 2. A failed backup write does not poison the next save
// ---------------------------------------------------------------------------

describe("dataSaveChain recovery after a failed writeChatHistoryBackup", () => {
  it("2: a backup failure rejects its own save, and the next save runs both steps", async () => {
    const ledger = createLedger();
    const { plugin, directory } = createPlugin(ledger);
    stubBackup(ledger);

    await saveSnapshot(plugin, "seed");
    const seedRead = await readBackup(directory);
    expect(seedRead?.currentThreadId).toBe("seed");
    const mark = ledger.entries.length;

    // `saveData()` succeeds; only the backup the same save writes fails.
    planSaveFailure(ledger, "first", "backup", "ENOSPC");
    const first = saveSnapshot(plugin, "first");
    const second = saveSnapshot(plugin, "second");
    const [firstResult, secondResult] = await settleWithin([first, second], "backup failure");

    expect(rejectionOf(firstResult)).toMatchObject({ code: "ENOSPC" });
    expect(rejectionOf(secondResult)).toBeUndefined();

    const entries = ledger.entriesFrom(mark);
    expect(entries.map((entry) => entry.phase)).toEqual([
      "saveData",
      "backup",
      "saveData",
      "backup"
    ]);
    expectInjectedAt(ledger, "first", "backup", "ENOSPC");
    // The backup that failed carried the same snapshot its data.json write did.
    expect(entries[1].hex).toBe(entries[0].hex);
    // The whole ledger is one strictly serialized sequence: the seed's save and the
    // save after the failure both completed, and only the failed backup is missing.
    verifyStrictSerialization(ledger.entries, { ledger, expectedBackupSteps: 3 });
    await expect(plugin.dataSaveChain).resolves.toBeUndefined();

    // The save after the backup failure really re-ran saveData *and* backup.
    expect(savedLabels(entries)).toEqual(["first", "second"]);
    expect(entries[3].hex).toBe("second");
    expect(readDataFile(directory).chatHistory.currentThreadId).toBe("second");
    // Disk after the failure: the failed save published its data.json but no backup, so
    // the backup file still carries the seed the same save rotated aside; the next save
    // then publishes both steps again and becomes the current generation.
    expect((await readBackup(directory))?.currentThreadId).toBe("second");
    expect(readBackupFile(directory).chatHistory.currentThreadId).toBe("second");
    const third = await saveSnapshot(plugin, "third");
    expect(third).toBeUndefined();
    expect((await readBackup(directory))?.currentThreadId).toBe("third");
    console.log(
      `[2] backup ENOSPC on the first save after the seed: first=rejected(ENOSPC); ` +
        `second=resolved; reader after the failure=${seedRead?.currentThreadId}; after the next save=third`
    );
  });
});

// ---------------------------------------------------------------------------
// 3. success -> failure -> success
// ---------------------------------------------------------------------------

describe("dataSaveChain survives a failure in the middle", () => {
  it("3: three saves run in call order, the middle one fails and the third reaches disk", async () => {
    const ledger = createLedger();
    const { plugin, directory } = createPlugin(ledger);
    stubBackup(ledger);

    await saveSnapshot(plugin, "ok-1");
    // The middle save fails at its backup write, after its `data.json` write succeeded.
    planSaveFailure(ledger, "broken-2", "backup", "EACCES");

    const second = saveSnapshot(plugin, "broken-2");
    const third = saveSnapshot(plugin, "ok-3");
    const [secondResult, thirdResult] = await settleWithin(
      [second, third],
      "success/failure/success"
    );

    expect(rejectionOf(secondResult)).toMatchObject({ code: "EACCES" });
    expect(rejectionOf(thirdResult)).toBeUndefined();

    // The failure was not skipped over: save 2 entered both steps, and save 3 entered
    // after save 2 had already finished.
    const entries = ledger.entries;
    expect(entries).toHaveLength(6);
    verifyStrictSerialization(entries, { ledger });
    expect(savedLabels(entries)).toEqual(["ok-1", "broken-2", "ok-3"]);
    const failedStep = expectInjectedAt(ledger, "broken-2", "backup", "EACCES");
    const nextStep = entries.find((entry) => entry.entry > entries[failedStep - 1].exit);
    expect(nextStep.hex).toBe("ok-3");
    expect(nextStep.entry).toBeGreaterThan(entries[failedStep - 1].exit);

    // Disk: the third save is the current state of both files.
    const data = readDataFile(directory);
    expect(data.chatHistory.currentThreadId).toBe("ok-3");
    const backup = readBackupFile(directory);
    expect(backup.chatHistory.currentThreadId).toBe("ok-3");
    expect((await readBackup(directory))?.currentThreadId).toBe("ok-3");
    // The backup file the failed save never overwrote is what the interrupted save
    // would have left: the second save's own snapshot, not an empty file.
    expect(entries[failedStep - 1].phase).toBe("backup");
    expect(await plugin.dataSaveChain).toBeUndefined();
    console.log(
      `[3] success/failure/success: steps=${entries
        .map((entry) => `${entry.hex}:${entry.phase}:${entry.outcome}`)
        .join(" -> ")}`
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Four concurrent calls are strictly serialized
// ---------------------------------------------------------------------------

describe("dataSaveChain serialization under concurrency", () => {
  it("4: four concurrent saves never overlap, keep call order and leave the last snapshot on disk", async () => {
    const ledger = createLedger();
    const { plugin, directory } = createPlugin(ledger);
    stubBackup(ledger);
    // Every step takes long enough that a writer which stopped waiting for the previous
    // save would put two saves inside the persistence steps at once. Production code is
    // untouched: the delay lives in the instrumented boundary the test owns, and a
    // correctly serialized chain pays the delay plus the one in front of it, but never
    // works on two snapshots at once.
    ledger.delayMs = 20;

    const labels = ["c1", "c2", "c3", "c4"];
    // No delays and no awaits between the calls: all four are enqueued in this tick.
    const saves = labels.map((label) => saveSnapshot(plugin, label));
    const results = await settleWithin(saves, "four concurrent saves");

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "fulfilled"
    ]);

    const entries = ledger.entries;
    expect(entries).toHaveLength(8);
    verifyStrictSerialization(entries, { ledger });
    expect(savedLabels(entries)).toEqual(labels);
    // The steps completed in entry order, so nothing was reordered while queued.
    // Each step holds one position on entry and the next on exit.
    expect(entries.map((entry) => entry.exit)).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    // The four saves entered their `saveData()` step in call order.
    expect(labels.map((label) => stepOf(ledger, label, "saveData"))).toEqual([1, 3, 5, 7]);

    // Disk: the last queued snapshot is the one that persisted.
    const data = readDataFile(directory);
    expect(data.chatHistory.currentThreadId).toBe("c4");
    expect((await readBackup(directory))?.currentThreadId).toBe("c4");
    expect(await plugin.dataSaveChain).toBeUndefined();
    console.log(
      `[4] 4 concurrent saves: steps=${entries.map((entry) => `${entry.hex}:${entry.phase}`).join(" -> ")}; ` +
        `max overlap=1; disk=c4`
    );
  });

  it("5: a failure in the middle of four concurrent saves does not strand the last two", async () => {
    const ledger = createLedger();
    const { plugin, directory } = createPlugin(ledger);
    stubBackup(ledger);
    // The second queued save fails at its own `saveData()` step. The label is what
    // names it, so the failure lands on that save even though all four are queued in
    // one tick and their steps cannot be numbered in advance.
    planSaveFailure(ledger, "c2", "saveData", "EBUSY");

    const labels = ["c1", "c2", "c3", "c4"];
    const saves = labels.map((label) => saveSnapshot(plugin, label));
    const results = await settleWithin(saves, "four concurrent saves with one failure");

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled"
    ]);
    expectInjectedAt(ledger, "c2", "saveData", "EBUSY");
    expect(rejectionOf(results[1])).toMatchObject({ code: "EBUSY" });
    // The saves entered their first step in call order, so the failure did not reorder
    // them, and each one is the save the test queued at that position.
    expect(labels.map((label) => stepOf(ledger, label, "saveData"))).toEqual([1, 3, 4, 6]);
    // c3 and c4 really ran their steps after the failure, rather than being skipped or
    // left pending behind a rejected predecessor.
    expect(stepOf(ledger, "c3", "backup")).toBeGreaterThan(stepOf(ledger, "c2", "saveData"));
    expect(stepOf(ledger, "c4", "backup")).toBeGreaterThan(stepOf(ledger, "c3", "backup"));
    expectSaveOutcome(results[2], undefined);
    expectSaveOutcome(results[3], undefined);
    // The two saves queued behind the failure were neither skipped nor left pending.
    expect(
      ledger.entries.filter((entry) => entry.phase === "saveData").map((entry) => entry.hex)
    ).toEqual(labels);
    // The failed save stopped before its backup step, which is the one skipped step.
    expect(ledger.entries.map((entry) => `${entry.hex}:${entry.phase}`)).toEqual([
      "c1:saveData",
      "c1:backup",
      "c2:saveData",
      "c3:saveData",
      "c3:backup",
      "c4:saveData",
      "c4:backup"
    ]);
    // c1 kept both steps; c2 failed before its backup; c3 and c4 ran to completion, so
    // three of the four saves reached the backup writer.
    verifyStrictSerialization(ledger.entries, { ledger, expectedBackupSteps: 3 });
    expect(results[3].status).toBe("fulfilled");
    expect(readDataFile(directory).chatHistory.currentThreadId).toBe("c4");
    expect((await readBackup(directory))?.currentThreadId).toBe("c4");
    expect(await plugin.dataSaveChain).toBeUndefined();
    console.log(
      `[5] 4 concurrent saves with #2 failing: outcomes=${results
        .map((result) => result.status)
        .join(",")}; steps=${ledger.entries.length}; disk=c4`
    );
  });
});

// ---------------------------------------------------------------------------
// 6. The callers that do not await
// ---------------------------------------------------------------------------

describe("the fire-and-forget callers", () => {
  it("6: saveThreadHistory() reports a failed save without an unhandled rejection", async () => {
    const ledger = createLedger();
    const { plugin, directory } = createPlugin(ledger);
    stubBackup(ledger);
    ledger.fail(1, "EIO", "saveData");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const rejections = [];
    unhandledRejectionListener = (reason) =>
      rejections.push(reason instanceof Error ? reason.message : reason);
    process.on("unhandledRejection", unhandledRejectionListener);

    // No await and no caller-side handler: the plugin's own `.catch()` is the only
    // thing between the failed save and an unhandled rejection.
    expect(plugin.saveThreadHistory()).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0].outcome).toBe("rejected");
    expect(rejections).toEqual([]);
    expect(warn).toHaveBeenCalledWith("Pi Agent: failed to save thread history", expect.anything());

    // A later, ordinary save still runs on the same chain. The failed save had already
    // persisted the current (default) store's snapshot, so that label is in the ledger
    // too -- what matters is that the save after the failure ran and reached the disk.
    const next = await saveSnapshot(plugin, "after-warning");
    expect(next).toBeUndefined();
    expect(savedLabels(ledger.entries)).toContain("after-warning");
    expect(readDataFile(directory).chatHistory.currentThreadId).toBe("after-warning");
    console.log("[6] saveThreadHistory with a failing save: warn=1, unhandled rejections=0");
  });

  it("6b: saveAnnotations() notices a failed save without an unhandled rejection", async () => {
    const ledger = createLedger();
    const { plugin, directory } = createPlugin(ledger);
    stubBackup(ledger);
    ledger.fail(2, "EPERM", "backup");

    const rejections = [];
    unhandledRejectionListener = (reason) =>
      rejections.push(reason instanceof Error ? reason.message : reason);
    process.on("unhandledRejection", unhandledRejectionListener);

    expect(plugin.saveAnnotations()).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 60));

    // The save reached both steps; only the backup failed.
    expect(ledger.entries.map((entry) => entry.outcome)).toEqual(["resolved", "rejected"]);
    expect(rejections).toEqual([]);
    expect(harness.notices).toContain("Could not save annotations to plugin data.");

    const next = await saveSnapshot(plugin, "after-notice");
    expect(next).toBeUndefined();
    expect(readDataFile(directory).chatHistory.currentThreadId).toBe("after-notice");
    console.log("[6b] saveAnnotations with a failing backup: notice=1, unhandled rejections=0");
  });

  it("6c: a fire-and-forget failure does not stop the next fire-and-forget save", async () => {
    const ledger = createLedger();
    const { plugin, directory } = createPlugin(ledger);
    stubBackup(ledger);
    ledger.fail(1, "EACCES", "saveData");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const rejections = [];
    unhandledRejectionListener = (reason) =>
      rejections.push(reason instanceof Error ? reason.message : reason);
    process.on("unhandledRejection", unhandledRejectionListener);

    plugin.saveThreadHistory();
    plugin.saveAnnotations();
    plugin.saveThreadHistory();
    await new Promise((resolve) => setTimeout(resolve, 60));

    // All three entered the chain in call order; the first one's failure skipped its
    // own backup step only.
    expect(ledger.entries.map((entry) => entry.phase)).toEqual([
      "saveData",
      "saveData",
      "backup",
      "saveData",
      "backup"
    ]);
    verifyStrictSerialization(ledger.entries, { ledger, expectedBackupSteps: 2 });
    expect(rejections).toEqual([]);
    expect(readDataFile(directory).chatHistory.currentThreadId).toBe(
      ledger.entries[ledger.entries.length - 1].hex
    );
    console.log(
      `[6c] three fire-and-forget saves with the first failing: steps=${ledger.entries.length}, ` +
        `unhandled rejections=0`
    );
  });
});
