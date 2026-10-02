/**
 * The snapshot's schema, now that one snapshot carries two kinds of data.
 *
 * `writeChatHistoryBackup()` can be handed the whole plugin data document instead of
 * just the chat history, so the snapshot the recovery path reads holds an annotation
 * copy of the same generation. That is what makes a damaged `data.json` recoverable
 * without overwriting annotations, and it has two schema requirements:
 *
 *   1. Round trip: what the writer published (history and annotation data) is what the
 *      reader returns, through the real files, the real rotation and the real checksum.
 *   2. Version tolerance: a snapshot written before annotations were carried still
 *      validates against the recipe it was written with -- its checksum covers the
 *      history alone -- so it keeps restoring the chat history instead of being
 *      discarded for lacking a field it never had, and the reader reports that it holds
 *      no annotation copy at all.
 *
 * The checksum mismatch cases are included because "does this snapshot hold annotations
 * I can trust?" must be answered by the checksum, not by the presence of a key.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readChatHistoryBackup,
  readPluginDataBackup,
  writeChatHistoryBackup
} from "../src/threads/chat-history-backup.mjs";

const BACKUP_FILE = "chat-history.backup.json";
const PREVIOUS_BACKUP_FILE = "chat-history.backup.previous.json";
const ANNOTATION_PATH = "Note.md";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function createDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-backup-schema-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createHistory(label) {
  return {
    currentThreadId: label,
    threads: [
      {
        id: label,
        title: `Chat ${label}`,
        messages: [],
        createdAt: 1,
        updatedAt: 1,
        archived: false,
        favorite: false
      }
    ]
  };
}

function createAnnotationData(id, quote) {
  return {
    schemaVersion: 1,
    annotations: {
      [ANNOTATION_PATH]: [
        {
          id,
          path: ANNOTATION_PATH,
          intent: "question",
          context: "context",
          quote,
          prefix: "",
          suffix: "",
          renderedText: quote,
          anchorLabel: quote,
          range: {
            from: 0,
            to: quote.length,
            start: { line: 0, ch: 0 },
            end: { line: 0, ch: quote.length }
          },
          targetKind: "selection",
          status: "attached",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z"
        }
      ]
    }
  };
}

/** One plugin data document, the shape `savePluginData()` hands the writer. */
function createPluginData(label, annotationId, quote) {
  return {
    model: "",
    piExecutablePath: "/opt/pi",
    chatHistory: createHistory(label),
    localPromptQueue: [],
    localPromptSteering: [],
    annotationData: createAnnotationData(annotationId, quote)
  };
}

function readBackupFile(directory, fileName = BACKUP_FILE) {
  return JSON.parse(fs.readFileSync(path.join(directory, fileName), "utf8"));
}

function writeBackupFile(directory, fileName, payload) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, fileName), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/** A snapshot in the pre-annotation format: history, and nothing else. */
function createLegacySnapshot(history) {
  return {
    schemaVersion: 1,
    savedAt: new Date().toISOString(),
    checksum: crypto.createHash("sha256").update(JSON.stringify(history)).digest("hex"),
    chatHistory: history
  };
}

// ---------------------------------------------------------------------------
// 1. Round trip of the payload the plugin data produces
// ---------------------------------------------------------------------------

describe("plugin data snapshots", () => {
  it("S1: round-trips the chat history and the annotation data of one generation", async () => {
    const directory = createDirectory();
    const data = createPluginData("one", "annotation-one", "first quote");

    await writeChatHistoryBackup(directory, data);

    const snapshot = await readPluginDataBackup(directory);
    expect(snapshot.chatHistory).toEqual(data.chatHistory);
    expect(snapshot.annotationData).toEqual(data.annotationData);
    // The reader that only wants the history still gets exactly the history.
    expect(await readChatHistoryBackup(directory)).toEqual(data.chatHistory);

    // The persisted payload carries the annotation copy and a checksum over the whole
    // snapshot, so the recovery path can tell a truncated or tampered one apart.
    const raw = readBackupFile(directory);
    expect(raw.annotationData).toEqual(data.annotationData);
    expect(raw.checksum).toBe(
      crypto
        .createHash("sha256")
        .update(
          JSON.stringify({ chatHistory: raw.chatHistory, annotationData: raw.annotationData })
        )
        .digest("hex")
    );

    console.log(
      "[S1] plugin data snapshot round-trips: chatHistory + annotationData, " +
        `checksum over both (${Object.keys(raw).join(",")})`
    );
  });

  it("S2: keeps the two generations independent, annotation data included", async () => {
    const directory = createDirectory();
    const first = createPluginData("first", "annotation-first", "first quote");
    const second = createPluginData("second", "annotation-second", "second quote");

    await writeChatHistoryBackup(directory, first);
    await writeChatHistoryBackup(directory, second);

    // Current wins for both halves of the snapshot.
    const current = await readPluginDataBackup(directory);
    expect(current.chatHistory).toEqual(second.chatHistory);
    expect(current.annotationData).toEqual(second.annotationData);

    // The rotated generation carries its own annotation data, not the current one's.
    const previous = readBackupFile(directory, PREVIOUS_BACKUP_FILE);
    expect(previous.chatHistory).toEqual(first.chatHistory);
    expect(previous.annotationData).toEqual(first.annotationData);

    fs.writeFileSync(path.join(directory, BACKUP_FILE), "{damaged", "utf8");
    const fallback = await readPluginDataBackup(directory);
    expect(fallback.chatHistory).toEqual(first.chatHistory);
    expect(fallback.annotationData).toEqual(first.annotationData);

    console.log(
      "[S2] rotation keeps each generation's own annotation data; damaged current falls back"
    );
  });

  it("S3: the historical snapshot shape still round-trips and holds no annotation copy", async () => {
    const directory = createDirectory();
    const history = createHistory("history-only");

    // The writer's older call shape: the history itself, with no plugin data.
    await writeChatHistoryBackup(directory, history);

    const raw = readBackupFile(directory);
    expect(Object.keys(raw)).not.toContain("annotationData");
    // The same snapshot document the annotation-carrying writer publishes, so the recipe
    // stays one recipe: `{ chatHistory }`. The older bare-history digest must not
    // validate, or the reader would accept a snapshot it did not verify whole.
    expect(raw.checksum).toBe(
      crypto
        .createHash("sha256")
        .update(JSON.stringify({ chatHistory: raw.chatHistory }))
        .digest("hex")
    );
    expect(raw.checksum).not.toBe(
      crypto.createHash("sha256").update(JSON.stringify(history)).digest("hex")
    );

    const snapshot = await readPluginDataBackup(directory);
    expect(snapshot.chatHistory).toEqual(history);
    // Absent, not empty: the caller has to be able to tell "this snapshot has no
    // annotation copy" from "this snapshot says there are no annotations".
    expect(Object.keys(snapshot)).not.toContain("annotationData");
    expect(await readChatHistoryBackup(directory)).toEqual(history);

    console.log("[S3] history-only snapshot: no annotationData key, chat history still recovered");
  });
});

// ---------------------------------------------------------------------------
// 2. Version tolerance for snapshots written before annotations were carried
// ---------------------------------------------------------------------------

describe("version tolerance", () => {
  it("S4: accepts a legacy snapshot whose checksum covers the history alone", async () => {
    const directory = createDirectory();
    const history = createHistory("legacy");
    writeBackupFile(directory, BACKUP_FILE, createLegacySnapshot(history));

    const snapshot = await readPluginDataBackup(directory);
    expect(snapshot.chatHistory).toEqual(history);
    expect(Object.keys(snapshot)).not.toContain("annotationData");
    expect(await readChatHistoryBackup(directory)).toEqual(history);

    console.log("[S4] legacy checksum recipe accepted: history recovered, no annotation copy");
  });

  it("S5: a tampered annotation copy fails the checksum and the previous snapshot wins", async () => {
    const directory = createDirectory();
    const legacyHistory = createHistory("legacy-previous");
    writeBackupFile(directory, PREVIOUS_BACKUP_FILE, createLegacySnapshot(legacyHistory));
    await writeChatHistoryBackup(directory, createPluginData("current", "annotation-real", "real"));

    // Swapping the annotation copy keeps the JSON valid, so only the checksum stands
    // between the reader and annotation data that was not written as a unit.
    const tampered = readBackupFile(directory);
    tampered.annotationData = createAnnotationData("annotation-forged", "forged");
    writeBackupFile(directory, BACKUP_FILE, tampered);

    const snapshot = await readPluginDataBackup(directory);
    expect(snapshot.chatHistory).toEqual(legacyHistory);
    expect(Object.keys(snapshot)).not.toContain("annotationData");

    console.log("[S5] tampered annotationData rejected by checksum; previous legacy snapshot used");
  });

  it("S5b: an annotation copy under the legacy recipe is not trusted, but the history is", async () => {
    const directory = createDirectory();
    const history = createHistory("legacy-with-annotations");
    const annotations = createAnnotationData("annotation-unverified", "unverified");
    // A file that carries an annotation copy but was checksummed the way the format
    // checked its chat history before annotations existed. The history is verified; the
    // annotation copy is not, so it must not be handed to the store as recovered data.
    writeBackupFile(directory, BACKUP_FILE, {
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      checksum: crypto.createHash("sha256").update(JSON.stringify(history)).digest("hex"),
      chatHistory: history,
      annotationData: annotations
    });

    const snapshot = await readPluginDataBackup(directory);
    expect(snapshot.chatHistory).toEqual(history);
    expect(Object.keys(snapshot)).not.toContain("annotationData");
    expect(await readChatHistoryBackup(directory)).toEqual(history);

    console.log("[S5b] legacy recipe: history trusted, unverified annotation copy withheld");
  });

  it("S6: a version or shape the format does not know is not a usable snapshot", async () => {
    const directory = createDirectory();
    const data = createPluginData("one", "annotation-one", "first quote");
    await writeChatHistoryBackup(directory, data);

    const bumped = readBackupFile(directory);
    bumped.schemaVersion = 2;
    writeBackupFile(directory, BACKUP_FILE, bumped);
    expect(await readPluginDataBackup(directory)).toBeUndefined();

    // A struct that is not a history at all is rejected on both paths.
    writeBackupFile(directory, BACKUP_FILE, {
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      checksum: crypto
        .createHash("sha256")
        .update(JSON.stringify({ nope: true }))
        .digest("hex"),
      chatHistory: { nope: true }
    });
    expect(await readPluginDataBackup(directory)).toBeUndefined();
    expect(await readChatHistoryBackup(directory)).toBeUndefined();

    // An absent directory is still "nothing recoverable", not an error.
    expect(await readPluginDataBackup(path.join(directory, "missing"))).toBeUndefined();
    expect(await readPluginDataBackup(undefined)).toBeUndefined();

    console.log("[S6] unknown version, invalid history and an absent snapshot are all rejected");
  });
});
