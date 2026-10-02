import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BACKUP_SCHEMA_VERSION = 1;
const BACKUP_FILE = "chat-history.backup.json";
const PREVIOUS_BACKUP_FILE = "chat-history.backup.previous.json";

/**
 * Write one backup snapshot.
 *
 * The second argument is either the chat history itself (the historical call shape,
 * which leaves `annotationData` out and produces exactly the payload it always did) or
 * the whole plugin data document, which adds the `annotationData` the snapshot has to
 * carry so a damaged `data.json` does not take the annotations down with it. The
 * snapshot file, the rotation and the checksum recipe are unchanged apart from the
 * checksum covering every persisted field.
 *
 * @param {string} pluginDirectory
 * @param {any} snapshot Plugin data, or the chat history on its own.
 */
export async function writeChatHistoryBackup(pluginDirectory, snapshot) {
  if (!pluginDirectory) throw new Error("The plugin directory is unavailable.");
  const normalized = cloneHistory(snapshot?.chatHistory ?? snapshot);
  const payload = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    checksum: checksum(persistedSnapshot(normalized, snapshot?.annotationData)),
    chatHistory: normalized,
    ...(snapshot?.annotationData !== undefined
      ? { annotationData: cloneAnnotationData(snapshot.annotationData) }
      : {})
  };
  await fs.promises.mkdir(pluginDirectory, { recursive: true });

  const backupPath = path.join(pluginDirectory, BACKUP_FILE);
  const previousPath = path.join(pluginDirectory, PREVIOUS_BACKUP_FILE);
  const temporaryPath = createTemporaryPath(backupPath);
  await fs.promises.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    // Strict read on purpose: `undefined` here means "there is no usable current
    // snapshot to rotate", so a real read failure aborts the write before anything is
    // copied or replaced. Treating an unreadable current as an absent one used to skip
    // the rotation and then let the replacing rename overwrite the only valid snapshot
    // with nothing behind it.
    const current = await readBackupSnapshot(backupPath);
    if (current) await copyAtomic(backupPath, previousPath);
    await replaceFile(temporaryPath, backupPath);
  } finally {
    await removeTemporaryFile(temporaryPath);
  }
}

export async function readChatHistoryBackup(pluginDirectory) {
  return (await readPluginDataBackup(pluginDirectory))?.chatHistory;
}

/**
 * Read the newest valid snapshot whole, rather than only its chat history.
 *
 * The plugin needs the annotation data of the same snapshot to recover annotations
 * whose `data.json` could not be parsed. A snapshot written before the backup carried
 * annotations parses exactly as it always did and simply has none.
 *
 * @param {string} [pluginDirectory]
 * @returns {Promise<{ chatHistory: any, annotationData?: any } | undefined>}
 */
export async function readPluginDataBackup(pluginDirectory) {
  if (!pluginDirectory) return undefined;
  for (const fileName of [BACKUP_FILE, PREVIOUS_BACKUP_FILE]) {
    const backup = await readValidBackup(path.join(pluginDirectory, fileName));
    if (backup) return toRecoverySnapshot(backup);
  }
  return undefined;
}

/**
 * Read one backup snapshot, separating "this file holds nothing usable" from "this
 * file could not be read".
 *
 * `undefined` is returned for exactly the content-level outcomes: the snapshot does
 * not exist (ENOENT), or what is in it is not a valid snapshot (unparsable JSON,
 * wrong schema version, checksum mismatch, structurally invalid history). Every other
 * failure -- EACCES, EPERM, EIO, EMFILE -- is rethrown, because it says nothing about
 * the snapshot's content, and a caller must never treat a file it could not read as an
 * empty one.
 *
 * A snapshot is valid when its checksum matches and it holds a usable chat history.
 * Two recipes are accepted, because both were written by this module: the one that
 * covers the whole snapshot, and the one that covers only the chat history, which is
 * the recipe of every snapshot written before this module carried an annotation copy.
 * A snapshot written with the older recipe keeps its full value -- its chat history --
 * instead of being discarded for the sake of a field it never had. Annotation data is
 * only ever accepted under the whole-snapshot recipe, so it can never be trusted from a
 * file that was not verified as a unit.
 */
async function readBackupSnapshot(filePath) {
  let text;
  try {
    text = await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if (/** @type {any} */ (error)?.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const backup = JSON.parse(text);
    if (backup?.schemaVersion !== BACKUP_SCHEMA_VERSION) return undefined;
    // Either recipe proves the chat history is the history that was written: the one
    // that covers the whole snapshot, or the one that covers the history alone. The
    // annotation copy, by contrast, is only ever trusted under the whole-snapshot
    // recipe, so a snapshot that cannot vouch for it is read as history only.
    const verifiedWhole =
      backup.annotationData !== undefined &&
      backup.checksum === checksum(persistedSnapshot(backup.chatHistory, backup.annotationData));
    const isAnnotated =
      verifiedWhole || backup.checksum === checksum(persistedSnapshot(backup.chatHistory));
    if (!isAnnotated && backup.checksum !== checksum(backup.chatHistory)) return undefined;
    // Only the fields this module verified are handed on. The raw keys are deliberately
    // not spread: an annotation copy the checksum did not cover must not reach a caller
    // that would read it as recovered data.
    return {
      chatHistory: cloneHistory(backup.chatHistory),
      ...(verifiedWhole ? { annotationData: cloneAnnotationData(backup.annotationData) } : {})
    };
  } catch {
    // The bytes were read successfully, so a malformed payload is a content problem.
    return undefined;
  }
}

/**
 * The recovery reader's view of a snapshot: one it cannot validate is simply skipped
 * so the caller can try the next generation. This keeps `readChatHistoryBackup()`
 * tolerant of unreadable files, which is the behaviour it has always had.
 */
async function readValidBackup(filePath) {
  try {
    return await readBackupSnapshot(filePath);
  } catch {
    return undefined;
  }
}

/**
 * The part of a snapshot a caller can actually use, so the recovery path reads the
 * file once and takes both halves of the same generation. `annotationData` stays
 * absent when the snapshot predates it, which is what tells the caller there is no
 * annotation copy in this backup.
 *
 * @param {{ chatHistory: any, annotationData?: any }} backup
 */
function toRecoverySnapshot(backup) {
  return {
    chatHistory: backup.chatHistory,
    ...(backup.annotationData !== undefined ? { annotationData: backup.annotationData } : {})
  };
}

/**
 * The document a snapshot's checksum covers: the chat history, plus the annotation data
 * when the snapshot carries it. Key order is the payload's own construction order, so
 * the writer and the reader always compute the same bytes.
 */
function persistedSnapshot(history, annotationData) {
  return annotationData === undefined
    ? { chatHistory: history }
    : { chatHistory: history, annotationData };
}

function cloneHistory(history) {
  if (!history || !Array.isArray(history.threads)) throw new Error("Invalid chat history backup.");
  const cloned = JSON.parse(JSON.stringify(history));
  if (
    typeof cloned.currentThreadId !== "string" ||
    cloned.threads.some(
      (thread) =>
        !thread ||
        typeof thread.id !== "string" ||
        typeof thread.title !== "string" ||
        !Array.isArray(thread.messages)
    )
  ) {
    throw new Error("Invalid chat history backup.");
  }
  return cloned;
}

/**
 * The snapshot's copy of the annotation document.
 *
 * Deliberately shallow-validating: this is data the plugin itself just serialized, and
 * it is the annotation store's own loader that decides what is usable. A value that
 * cannot be serialized is a broken snapshot rather than a reason to publish one.
 */
function cloneAnnotationData(annotationData) {
  try {
    return JSON.parse(JSON.stringify(annotationData));
  } catch {
    throw new Error("Invalid annotation data in the plugin data backup.");
  }
}

function checksum(history) {
  return crypto.createHash("sha256").update(JSON.stringify(history)).digest("hex");
}

/**
 * The temporary name for one atomic write.
 *
 * `Date.now()` alone is not unique: two writers in the same process and the same
 * millisecond used to compute the same path, so they truncated and overwrote each
 * other's temporary file and then published the mixture as the new snapshot. A random
 * UUID makes every generated name unique, which is what the write-then-rename pattern
 * requires; the pid is kept only to make stray files easy to attribute.
 */
function createTemporaryPath(filePath) {
  return `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
}

async function copyAtomic(sourcePath, destinationPath) {
  const temporaryPath = createTemporaryPath(destinationPath);
  await fs.promises.copyFile(sourcePath, temporaryPath);
  try {
    await replaceFile(temporaryPath, destinationPath);
  } finally {
    await removeTemporaryFile(temporaryPath);
  }
}

async function replaceFile(sourcePath, destinationPath) {
  try {
    await fs.promises.rename(sourcePath, destinationPath);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
    await fs.promises.rm(destinationPath, { force: true });
    await fs.promises.rename(sourcePath, destinationPath);
  }
}

/**
 * Best-effort removal of one write's temporary file.
 *
 * This runs after the rename (or the copy) that decided the outcome, so it is the only
 * remaining step, and it must never decide that outcome itself:
 *
 * - A `rename(temporary -> backup)` that succeeded has already published the new
 *   snapshot. Failing to delete the now-gone temporary file afterwards says nothing
 *   about the write, so reporting it as a failed save would tell the caller the very
 *   opposite of what is on disk.
 * - A failed replace leaves its own error in flight. Throwing here would replace that
 *   error with a cleanup error and hide the real reason the write failed.
 *
 * The temporary name is unique per write, so a leftover is a bounded, unreferenced
 * file that no later write or reader can mistake for a snapshot; it can never take the
 * place of the current one. The failure is therefore reported as a diagnostic and
 * swallowed, and the caller keeps whichever result the main operation produced.
 */
async function removeTemporaryFile(temporaryPath) {
  try {
    await fs.promises.rm(temporaryPath, { force: true });
  } catch (error) {
    console.warn(
      "Pi Agent: could not remove a temporary chat history backup file",
      temporaryPath,
      error
    );
  }
}
