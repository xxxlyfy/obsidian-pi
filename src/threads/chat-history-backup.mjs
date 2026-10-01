import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BACKUP_SCHEMA_VERSION = 1;
const BACKUP_FILE = "chat-history.backup.json";
const PREVIOUS_BACKUP_FILE = "chat-history.backup.previous.json";

export async function writeChatHistoryBackup(pluginDirectory, history) {
  if (!pluginDirectory) throw new Error("The plugin directory is unavailable.");
  const normalized = cloneHistory(history);
  const payload = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    checksum: checksum(normalized),
    chatHistory: normalized
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
  if (!pluginDirectory) return undefined;
  for (const fileName of [BACKUP_FILE, PREVIOUS_BACKUP_FILE]) {
    const backup = await readValidBackup(path.join(pluginDirectory, fileName));
    if (backup) return backup.chatHistory;
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
    if (
      backup?.schemaVersion !== BACKUP_SCHEMA_VERSION ||
      backup.checksum !== checksum(backup.chatHistory)
    ) {
      return undefined;
    }
    return { ...backup, chatHistory: cloneHistory(backup.chatHistory) };
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
