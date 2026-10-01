/**
 * Interruption safety of the chat history backup writer.
 *
 * `writeChatHistoryBackup()` copies the current snapshot aside before it replaces
 * it, so a failure in the middle of the write is supposed to leave at least one
 * recoverable generation behind. These tests inject a failure at each filesystem
 * step of that sequence and then ask the *reader* -- the real
 * `readChatHistoryBackup()` -- what is still recoverable.
 *
 * A rejected write is deliberately never treated as lost data: every failure case
 * records five facts.
 *
 *   1. which filesystem step failed,
 *   2. the final state of `chat-history.backup.json` (current),
 *   3. the final state of `chat-history.backup.previous.json` (previous),
 *   4. what `readChatHistoryBackup()` returns afterwards,
 *   5. whether both snapshots are unrecoverable.
 *
 * Section F covers the fix for the one real loss this file found: the writer now tells
 * "there is no usable current snapshot" (missing file, or content that does not
 * validate) apart from "the current snapshot could not be read", and only the second
 * case aborts the write. Section R pins the cases that must keep working -- ENOENT and
 * damaged content -- so the stricter check cannot turn into a blanket refusal to
 * replace an unusable current.
 *
 * The filesystem is real. Only `fs.promises.*` on the shared `node:fs` object is
 * wrapped, which is the same object `chat-history-backup.mjs` imports, so every
 * call still reaches the real filesystem unless a test asks for a specific
 * failure. This follows the instrumentation pattern the repository already uses
 * (`thread-list-session-count-performance.test.mjs` wraps real `node:fs`
 * functions); no mock filesystem and no new dependency is introduced.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readChatHistoryBackup,
  writeChatHistoryBackup
} from "../src/threads/chat-history-backup.mjs";

const BACKUP_FILE = "chat-history.backup.json";
const PREVIOUS_BACKUP_FILE = "chat-history.backup.previous.json";

let temporaryDirectories = [];
/** @type {ReturnType<typeof createFsFaultInjector> | undefined} */
let faults;

afterEach(() => {
  faults?.restore();
  faults = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fault injection over the real filesystem
// ---------------------------------------------------------------------------

/**
 * Wrap the `fs.promises` methods the writer uses.
 *
 * A rule fails the first `times` calls that match, with the injected `code`; every
 * other call goes to the real implementation. The log keeps every call, including
 * which ones were injected, so a test can assert where in the sequence it stopped.
 */
function createFsFaultInjector() {
  const log = [];
  const rules = [];
  const originals = new Map();
  const WRAPPED = ["mkdir", "readFile", "writeFile", "copyFile", "rename", "rm"];

  for (const method of WRAPPED) {
    const original = fs.promises[method];
    originals.set(method, original);
    fs.promises[method] = async function instrumented(...args) {
      const renames = method === "copyFile" || method === "rename";
      const entry = {
        method,
        path: String(args[0]),
        source: renames ? String(args[0]) : undefined,
        destination: renames ? String(args[1]) : undefined,
        failed: undefined
      };
      log.push(entry);

      const rule = rules.find(
        (candidate) =>
          candidate.remaining > 0 && candidate.method === method && candidate.match(entry)
      );
      if (rule) {
        rule.remaining -= 1;
        entry.failed = rule.code;
        throw Object.assign(new Error(`${rule.code}: injected by test`), { code: rule.code });
      }
      return original.apply(fs.promises, args);
    };
  }

  return {
    log,
    fail(method, { code = "EPERM", times = 1, match = () => true } = {}) {
      rules.push({ method, code, remaining: times, match });
    },
    mark() {
      return log.length;
    },
    calls(method, filter = () => true) {
      return log.filter((entry) => entry.method === method && filter(entry));
    },
    restore() {
      for (const [method, original] of originals) fs.promises[method] = original;
      originals.clear();
    }
  };
}

/** Install the injector and register it for cleanup. */
function installFaults() {
  faults = createFsFaultInjector();
  return faults;
}

// ---------------------------------------------------------------------------
// Fixtures and observation helpers
// ---------------------------------------------------------------------------

function createDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-backup-faults-"));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * A history whose `currentThreadId` doubles as its version label, so any restored
 * snapshot can be named in one comparison.
 */
function createHistory(version) {
  return {
    currentThreadId: version,
    threads: [
      {
        id: `${version}-thread`,
        title: `Chat ${version}`,
        messages: [],
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        archived: false,
        favorite: false
      }
    ]
  };
}

function backupPath(directory, fileName) {
  return path.join(directory, fileName);
}

function currentPath(directory) {
  return backupPath(directory, BACKUP_FILE);
}

function previousPath(directory) {
  return backupPath(directory, PREVIOUS_BACKUP_FILE);
}

/** The checksum recipe of the backup format, read independently for reporting. */
function checksumOf(history) {
  return crypto.createHash("sha256").update(JSON.stringify(history)).digest("hex");
}

/**
 * The main temporary paths used in one batch of filesystem calls, in call order.
 * `Date.now()` collisions show up here as fewer distinct paths than calls.
 */
function mainTemporaryPaths(calls, directory) {
  return calls
    .filter(
      (entry) =>
        entry.method === "writeFile" && entry.path.startsWith(`${currentPath(directory)}.tmp-`)
    )
    .map((entry) => entry.path);
}

/** The previous-generation temporary paths `copyAtomic()` copied into, in call order. */
function copyTemporaryPaths(calls, directory) {
  return calls
    .filter(
      (entry) =>
        entry.method === "copyFile" &&
        entry.destination.startsWith(`${previousPath(directory)}.tmp-`)
    )
    .map((entry) => entry.destination);
}

/**
 * Describe one snapshot file as it is on disk, without claiming to be the recovery
 * decision: `readChatHistoryBackup()` below is the authority on that.
 */
function describeSnapshotFile(filePath) {
  if (!fs.existsSync(filePath)) return "missing";
  let backup;
  try {
    backup = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return "invalid-json";
  }
  if (backup?.schemaVersion !== 1) return "schema-mismatch";
  if (backup.checksum !== checksumOf(backup.chatHistory)) return "checksum-mismatch";
  return `valid:${backup.chatHistory?.currentThreadId ?? "?"}`;
}

/** Temporary files the writer left behind, which the reader never looks at. */
function temporaryLeftovers(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.includes(".tmp-"));
}

/**
 * The five facts of a completed failure case, with `readChatHistoryBackup()` as the
 * authority on recoverability.
 */
async function inspect(directory) {
  const recovered = await readChatHistoryBackup(directory);
  return {
    current: describeSnapshotFile(currentPath(directory)),
    previous: describeSnapshotFile(previousPath(directory)),
    recovered: recovered?.currentThreadId,
    bothUnrecoverable: recovered === undefined,
    leftovers: temporaryLeftovers(directory)
  };
}

/** Print the five facts in one line, so a run reads as a report. */
function logFacts(label, failedStep, snapshot) {
  console.log(
    `[${label}] failedStep=${failedStep}; current=${snapshot.current}; ` +
      `previous=${snapshot.previous}; recovered=${snapshot.recovered ?? "none"}; ` +
      `bothUnrecoverable=${snapshot.bothUnrecoverable}; tempLeftovers=${snapshot.leftovers.length}`
  );
}

/** The injected failures seen in the filesystem log, in order. */
function injectedFailures(entries) {
  return entries.filter((entry) => entry.failed).map((entry) => `${entry.method}:${entry.failed}`);
}

// ---------------------------------------------------------------------------
// 1. The new snapshot is written, but the previous-generation copy fails
// ---------------------------------------------------------------------------

describe("1: the previous-generation copy fails", () => {
  it("1a: a failed copy of the old current leaves that current recoverable", async () => {
    const fsFaults = installFaults();
    const directory = createDirectory();
    const old = createHistory("old");
    const fresh = createHistory("new");
    await writeChatHistoryBackup(directory, old);
    expect(describeSnapshotFile(currentPath(directory))).toBe("valid:old");

    // The new temporary file is written, then copying the old current aside fails.
    fsFaults.fail("copyFile", { code: "ENOSPC", match: () => true });
    const mark = fsFaults.mark();
    await expect(writeChatHistoryBackup(directory, fresh)).rejects.toMatchObject({
      code: "ENOSPC"
    });

    const snapshot = await inspect(directory);
    // The failing step really was the copy, after the new temporary file landed and
    // before any rename was attempted.
    const calls = fsFaults.log.slice(mark);
    const writes = calls.filter((entry) => entry.method === "writeFile");
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toContain(`${BACKUP_FILE}.tmp-`);
    expect(calls.filter((entry) => entry.method === "rename")).toHaveLength(0);

    expect(snapshot.current).toBe("valid:old");
    expect(snapshot.previous).toBe("missing");
    expect(snapshot.recovered).toBe("old");
    expect(snapshot.bothUnrecoverable).toBe(false);
    expect(snapshot.leftovers).toEqual([]);
    logFacts("1a", "copyAtomic:copyFile(ENOSPC)", snapshot);
  });

  it("1b: a failed previous-generation replace after its destination was removed still leaves current", async () => {
    const fsFaults = installFaults();
    const directory = createDirectory();
    await writeChatHistoryBackup(directory, createHistory("v1"));
    await writeChatHistoryBackup(directory, createHistory("v2"));
    // Normal state after two writes: current=v2, previous=v1.
    expect(describeSnapshotFile(currentPath(directory))).toBe("valid:v2");
    expect(describeSnapshotFile(previousPath(directory))).toBe("valid:v1");

    // `replaceFile(prevTmp -> previous)`: EPERM takes the destructive fallback, which
    // really deletes v1, and then the retry fails too.
    fsFaults.fail("rename", {
      code: "EPERM",
      match: (e) => e.destination === previousPath(directory)
    });
    fsFaults.fail("rename", {
      code: "EACCES",
      match: (e) => e.destination === previousPath(directory)
    });
    await expect(writeChatHistoryBackup(directory, createHistory("v3"))).rejects.toMatchObject({
      code: "EACCES"
    });

    const snapshot = await inspect(directory);
    // The previous generation was destroyed by the fallback's `rm`, and the current
    // snapshot was never touched because the copy threw first.
    expect(snapshot.current).toBe("valid:v2");
    expect(snapshot.previous).toBe("missing");
    expect(snapshot.recovered).toBe("v2");
    expect(snapshot.bothUnrecoverable).toBe(false);
    expect(injectedFailures(fsFaults.calls("rename"))).toEqual(["rename:EPERM", "rename:EACCES"]);
    logFacts("1b", "copyAtomic:replaceFile rename(EPERM)+rm(previous)+rename(EACCES)", snapshot);
  });
});

// ---------------------------------------------------------------------------
// 2. Replacing the current snapshot fails
// ---------------------------------------------------------------------------

describe("2: replacing the current snapshot fails", () => {
  it("2a: the destructive fallback deletes current and its retry fails, previous still recovers", async () => {
    const fsFaults = installFaults();
    const directory = createDirectory();
    await writeChatHistoryBackup(directory, createHistory("v1"));
    await writeChatHistoryBackup(directory, createHistory("v2"));
    // current=v2, previous=v1.

    fsFaults.fail("rename", {
      code: "EPERM",
      match: (e) => e.destination === currentPath(directory)
    });
    fsFaults.fail("rename", {
      code: "EACCES",
      match: (e) => e.destination === currentPath(directory)
    });
    await expect(writeChatHistoryBackup(directory, createHistory("v3"))).rejects.toMatchObject({
      code: "EACCES"
    });

    const snapshot = await inspect(directory);
    // `rm(current)` really removed v2; the rotation that ran first is what saves the
    // history here.
    expect(snapshot.current).toBe("missing");
    expect(snapshot.previous).toBe("valid:v2");
    expect(snapshot.recovered).toBe("v2");
    expect(snapshot.bothUnrecoverable).toBe(false);
    logFacts("2a", "replaceFile rename(EPERM)+rm(current)+rename(EACCES)", snapshot);
  });

  it("2b: the EPERM fallback completes and the new snapshot becomes current", async () => {
    const fsFaults = installFaults();
    const directory = createDirectory();
    await writeChatHistoryBackup(directory, createHistory("v1"));
    await writeChatHistoryBackup(directory, createHistory("v2"));

    // Only the first rename fails; the documented fallback then does its job.
    fsFaults.fail("rename", {
      code: "EPERM",
      match: (e) => e.destination === currentPath(directory)
    });
    await writeChatHistoryBackup(directory, createHistory("v3"));

    const snapshot = await inspect(directory);
    expect(snapshot.current).toBe("valid:v3");
    expect(snapshot.previous).toBe("valid:v2");
    expect(snapshot.recovered).toBe("v3");
    expect(snapshot.leftovers).toEqual([]);
    logFacts("2b", "replaceFile rename(EPERM)+rm(current)+rename(ok)", snapshot);
  });

  it("2c: the EEXIST fallback completes and the new snapshot becomes current", async () => {
    const fsFaults = installFaults();
    const directory = createDirectory();
    await writeChatHistoryBackup(directory, createHistory("v1"));
    await writeChatHistoryBackup(directory, createHistory("v2"));

    fsFaults.fail("rename", {
      code: "EEXIST",
      match: (e) => e.destination === currentPath(directory)
    });
    await writeChatHistoryBackup(directory, createHistory("v3"));

    const snapshot = await inspect(directory);
    expect(snapshot.current).toBe("valid:v3");
    expect(snapshot.previous).toBe("valid:v2");
    expect(snapshot.recovered).toBe("v3");
    logFacts("2c", "replaceFile rename(EEXIST)+rm(current)+rename(ok)", snapshot);
  });

  it("2d: a non-retryable rename failure leaves the current snapshot untouched", async () => {
    const fsFaults = installFaults();
    const directory = createDirectory();
    await writeChatHistoryBackup(directory, createHistory("v1"));
    await writeChatHistoryBackup(directory, createHistory("v2"));

    // EACCES is not in the retryable list, so no destination is deleted.
    fsFaults.fail("rename", {
      code: "EACCES",
      match: (e) => e.destination === currentPath(directory)
    });
    await expect(writeChatHistoryBackup(directory, createHistory("v3"))).rejects.toMatchObject({
      code: "EACCES"
    });

    const snapshot = await inspect(directory);
    // The rotation to previous=v2 ran before the failing replace, so even this path
    // keeps two recoverable generations.
    expect(snapshot.current).toBe("valid:v2");
    expect(snapshot.previous).toBe("valid:v2");
    expect(snapshot.recovered).toBe("v2");
    expect(snapshot.bothUnrecoverable).toBe(false);
    logFacts("2d", "replaceFile rename(EACCES, not retried) after the rotation", snapshot);
  });
});

// ---------------------------------------------------------------------------
// 3. Temporary file cleanup fails
// ---------------------------------------------------------------------------
//
// Cleanup runs *after* the step that decided the outcome, so it must never decide it.
// A completed replace has already published the new snapshot: failing to unlink the
// (already renamed away) temporary file is a diagnostic, not a failed save. And when
// the replace itself failed, the cleanup error must not take the place of the error in
// flight, or the caller is told "EPERM on a temporary file" instead of the real reason
// the snapshot was not written.

describe("3: a failed temporary cleanup never overrides the main result", () => {
  it("3a: a cleanup failure after a completed write still resolves, and current is the new version", async () => {
    const fsFaults = installFaults();
    const directory = createDirectory();
    await writeChatHistoryBackup(directory, createHistory("v1"));

    // Only the temporary file the write created for this generation resists deletion;
    // the rotation's own temporary file and `current` are untouched by the rule.
    fsFaults.fail("rm", {
      code: "EPERM",
      match: (e) => e.path.startsWith(`${currentPath(directory)}.tmp-`)
    });

    const outcome = await writeChatHistoryBackup(directory, createHistory("v2")).then(
      () => ({ rejected: false, error: undefined }),
      (error) => ({ rejected: true, error })
    );

    const snapshot = await inspect(directory);
    // The rename that published the new snapshot succeeded, so the write is a success:
    // the caller must not be told the save failed while current already holds v2.
    expect(outcome.rejected).toBe(false);
    expect(outcome.error).toBeUndefined();
    expect(snapshot.current).toBe("valid:v2");
    expect(snapshot.previous).toBe("valid:v1");
    expect(snapshot.recovered).toBe("v2");
    expect(snapshot.bothUnrecoverable).toBe(false);

    // A successful rename consumed the temporary file, so the failing `rm` targeted a
    // path that no longer exists: nothing is left behind on this path, and the reader
    // in any case only ever consults current/previous.
    expect(injectedFailures(fsFaults.calls("rm"))).toEqual(["rm:EPERM"]);
    expect(snapshot.leftovers).toEqual([]);
    logFacts("3a", "cleanup rm(main temp) EPERM after a completed write", snapshot);
  });

  it("3a2: a leftover temporary file is ignored, so the write stays current and recoverable", async () => {
    const fsFaults = installFaults();
    const directory = createDirectory();
    await writeChatHistoryBackup(directory, createHistory("v1"));

    // The cleanup of the main temporary file fails; the rotation's own cleanup is left
    // alone so the write reaches publication.
    fsFaults.fail("rm", {
      code: "EPERM",
      match: (e) => e.path.startsWith(`${currentPath(directory)}.tmp-`)
    });
    const outcome = await writeChatHistoryBackup(directory, createHistory("v2")).then(
      () => ({ rejected: false, error: undefined }),
      (error) => ({ rejected: true, error })
    );
    // On a platform where that delete really fails, the temporary file is still there.
    // Recreate it under the name this write used, which is what a failed unlink would
    // have left behind, and check that it changes nothing for the reader.
    const [mainTemporary] = mainTemporaryPaths(fsFaults.log, directory);
    expect(mainTemporary).toContain(`${BACKUP_FILE}.tmp-`);
    fs.writeFileSync(mainTemporary, "leftover", "utf8");

    const snapshot = await inspect(directory);
    expect(outcome.rejected).toBe(false);
    expect(snapshot.current).toBe("valid:v2");
    expect(snapshot.recovered).toBe("v2");
    // The stray temporary file exists and is simply not a snapshot.
    expect(snapshot.leftovers).toHaveLength(1);
    expect(await readChatHistoryBackup(directory)).toEqual(createHistory("v2"));
    logFacts(
      "3a2",
      "cleanup rm(main temp) EPERM, leftover on disk, write still succeeds",
      snapshot
    );
  });

  it("3b: a cleanup failure keeps the original replace error as the rejection", async () => {
    const fsFaults = installFaults();
    const directory = createDirectory();
    await writeChatHistoryBackup(directory, createHistory("v1"));
    await writeChatHistoryBackup(directory, createHistory("v2"));

    // The replacing rename fails first with EACCES; the cleanup then fails with EPERM.
    // The EACCES is the real reason v3 was not written, so it must be what the caller
    // sees -- not the cleanup's EPERM.
    fsFaults.fail("rename", {
      code: "EACCES",
      match: (e) => e.destination === currentPath(directory)
    });
    fsFaults.fail("rm", {
      code: "EPERM",
      match: (e) => e.path.startsWith(`${currentPath(directory)}.tmp-`)
    });

    const outcome = await writeChatHistoryBackup(directory, createHistory("v3")).then(
      () => ({ rejected: false, error: undefined }),
      (error) => ({ rejected: true, error })
    );

    const snapshot = await inspect(directory);
    expect(outcome.rejected).toBe(true);
    expect(outcome.error).toMatchObject({ code: "EACCES" });
    expect(outcome.error?.code).not.toBe("EPERM");

    // The rotation to previous=v2 ran before the failing replace, so both generations
    // survive; the current snapshot was never touched.
    expect(injectedFailures(fsFaults.log)).toEqual(["rename:EACCES", "rm:EPERM"]);
    expect(snapshot.current).toBe("valid:v2");
    expect(snapshot.previous).toBe("valid:v2");
    expect(snapshot.recovered).toBe("v2");
    expect(snapshot.bothUnrecoverable).toBe(false);
    // The temporary file the failed rename left behind also survives the failed
    // cleanup, and the reader simply ignores it.
    expect(snapshot.leftovers).toHaveLength(1);
    logFacts("3b", "replaceFile rename(EACCES) with cleanup rm(EPERM) behind it", snapshot);
  });

  it("3c: a cleanup failure in copyAtomic after a completed rotation still resolves", async () => {
    const fsFaults = installFaults();
    const directory = createDirectory();
    await writeChatHistoryBackup(directory, createHistory("v1"));

    // `copyAtomic()` replaced previous=v1 successfully; only its now-consumed
    // temporary file resists deletion.
    fsFaults.fail("rm", {
      code: "EPERM",
      match: (e) => e.path.startsWith(`${previousPath(directory)}.tmp-`)
    });

    const outcome = await writeChatHistoryBackup(directory, createHistory("v2")).then(
      () => ({ rejected: false, error: undefined }),
      (error) => ({ rejected: true, error })
    );

    const snapshot = await inspect(directory);
    // The rotation succeeded, so the write carries on and publishes v2 as current.
    expect(outcome.rejected).toBe(false);
    expect(outcome.error).toBeUndefined();
    expect(snapshot.current).toBe("valid:v2");
    expect(snapshot.previous).toBe("valid:v1");
    expect(snapshot.recovered).toBe("v2");
    expect(snapshot.bothUnrecoverable).toBe(false);
    logFacts("3c", "copyAtomic cleanup rm(previous temp) EPERM after its replace", snapshot);
  });

  it("3d: a cleanup failure in copyAtomic keeps the original replace error", async () => {
    const fsFaults = installFaults();
    const directory = createDirectory();
    await writeChatHistoryBackup(directory, createHistory("v1"));

    // `copyAtomic(backup -> previous)` writes its temporary file, fails to replace
    // previous with EACCES (not retryable, so previous is left as it is), and then
    // fails to clean up with EPERM.
    fsFaults.fail("rename", {
      code: "EACCES",
      match: (e) => e.destination === previousPath(directory)
    });
    fsFaults.fail("rm", {
      code: "EPERM",
      match: (e) => e.path.startsWith(`${previousPath(directory)}.tmp-`)
    });

    const outcome = await writeChatHistoryBackup(directory, createHistory("v2")).then(
      () => ({ rejected: false, error: undefined }),
      (error) => ({ rejected: true, error })
    );

    const snapshot = await inspect(directory);
    expect(outcome.rejected).toBe(true);
    expect(outcome.error).toMatchObject({ code: "EACCES" });
    // The rotation failure stopped the write before any `current` replace, so v1 is
    // still current and still recoverable.
    expect(injectedFailures(fsFaults.log)).toEqual(["rename:EACCES", "rm:EPERM"]);
    expect(snapshot.current).toBe("valid:v1");
    expect(snapshot.previous).toBe("missing");
    expect(snapshot.recovered).toBe("v1");
    expect(snapshot.bothUnrecoverable).toBe(false);
    logFacts("3d", "copyAtomic replace rename(EACCES) with cleanup rm(EPERM) behind it", snapshot);
  });

  it("3e: a cleanup failure never turns a main copyAtomic failure into a cleanup rejection", async () => {
    const fsFaults = installFaults();
    const directory = createDirectory();
    await writeChatHistoryBackup(directory, createHistory("old"));

    // The rotation's copy fails, and the main temporary file the writer then has to
    // clean up resists deletion as well.
    fsFaults.fail("copyFile", { code: "ENOSPC", match: () => true });
    fsFaults.fail("rm", {
      code: "EPERM",
      match: (e) => e.path.startsWith(`${currentPath(directory)}.tmp-`)
    });
    const mark = fsFaults.mark();

    const outcome = await writeChatHistoryBackup(directory, createHistory("new")).then(
      () => ({ rejected: false, error: undefined }),
      (error) => ({ rejected: true, error })
    );

    const snapshot = await inspect(directory);
    // The out-of-space failure is the reason nothing was written; the cleanup EPERM
    // behind it is not allowed to take its place.
    expect(outcome.rejected).toBe(true);
    expect(outcome.error).toMatchObject({ code: "ENOSPC" });
    expect(injectedFailures(fsFaults.log.slice(mark))).toEqual(["copyFile:ENOSPC", "rm:EPERM"]);
    expect(snapshot.current).toBe("valid:old");
    expect(snapshot.recovered).toBe("old");
    expect(snapshot.bothUnrecoverable).toBe(false);
    logFacts("3e", "copyAtomic copyFile(ENOSPC) with cleanup rm(EPERM) behind it", snapshot);
  });
});

// ---------------------------------------------------------------------------
// 4. Success path regression
// ---------------------------------------------------------------------------

describe("4: the success path is unchanged", () => {
  it("4: old then new keeps new as current, old as previous, and falls back to old", async () => {
    const directory = createDirectory();
    const old = createHistory("old");
    const fresh = createHistory("new");

    await writeChatHistoryBackup(directory, old);
    expect(await readChatHistoryBackup(directory)).toEqual(old);

    await writeChatHistoryBackup(directory, fresh);
    const afterSecondWrite = await inspect(directory);
    expect(afterSecondWrite.current).toBe("valid:new");
    expect(afterSecondWrite.previous).toBe("valid:old");
    expect(afterSecondWrite.recovered).toBe("new");
    expect(await readChatHistoryBackup(directory)).toEqual(fresh);
    // The previous snapshot is the old history, checksum and all.
    const previous = JSON.parse(fs.readFileSync(previousPath(directory), "utf8"));
    expect(previous.chatHistory).toEqual(old);
    expect(previous.checksum).toBe(checksumOf(old));
    expect(previous.schemaVersion).toBe(1);

    // Damaging the current snapshot must fall back to the old generation.
    fs.writeFileSync(currentPath(directory), "{damaged", "utf8");
    expect(await readChatHistoryBackup(directory)).toEqual(old);

    logFacts("4", "none (success path, then a deliberately damaged current)", {
      current: "invalid-json",
      previous: "valid:old",
      recovered: "old",
      bothUnrecoverable: false,
      leftovers: temporaryLeftovers(directory)
    });
  });

  it("4b: serial old -> new -> latest keeps the newest current and the one before it", async () => {
    const directory = createDirectory();
    await writeChatHistoryBackup(directory, createHistory("old"));
    await writeChatHistoryBackup(directory, createHistory("new"));
    await writeChatHistoryBackup(directory, createHistory("latest"));

    const snapshot = await inspect(directory);
    expect(snapshot.current).toBe("valid:latest");
    expect(snapshot.previous).toBe("valid:new");
    expect(snapshot.recovered).toBe("latest");
    expect(snapshot.leftovers).toEqual([]);

    // The generation immediately before the current one is what a damaged current
    // falls back to -- not "old", which two rotations back has been dropped.
    fs.writeFileSync(currentPath(directory), "{damaged", "utf8");
    expect((await readChatHistoryBackup(directory))?.currentThreadId).toBe("new");

    console.log(
      "[4b] serial old -> new -> latest: current=latest, previous=new; a damaged current " +
        "falls back to new"
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Concurrent writes
// ---------------------------------------------------------------------------
//
// The temporary name used to be `tmp-<pid>-<Date.now()>`, so concurrent writers in
// the same millisecond shared one file: they truncated each other's temporary file and
// published the mixture as the new snapshot (current=invalid-json) with no previous
// generation behind it. The names now carry a random UUID, and these tests hold
// `Date.now()` fixed so the old naming would still collide. `current`/`previous` on
// disk and `readChatHistoryBackup()` are what decide whether anything was lost.

describe("5: concurrent writes", () => {
  it("5a: four writers with a frozen clock use four distinct temporary paths", async () => {
    const fsFaults = installFaults();
    const directory = createDirectory();
    // A valid current exists, so every writer also runs the copyAtomic rotation and
    // its temporary names are exercised as well.
    await writeChatHistoryBackup(directory, createHistory("base"));
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const versions = [
      "concurrent-1",
      "concurrent-2-with-a-longer-label",
      "concurrent-3-with-an-even-longer-label-xxxxxxxx",
      "concurrent-4"
    ].map(createHistory);
    const mark = fsFaults.mark();
    const results = await Promise.allSettled(
      versions.map((history) => writeChatHistoryBackup(directory, history))
    );
    clock.mockRestore();
    const calls = fsFaults.log.slice(mark);

    // `Date.now()` returned the same value for all four writers: with the old naming
    // these path lists would each collapse to a single name.
    const mainTemporaries = mainTemporaryPaths(calls, directory);
    expect(mainTemporaries).toHaveLength(versions.length);
    expect(new Set(mainTemporaries).size).toBe(versions.length);

    // `copyAtomic()` runs for the writers that found a current snapshot, and its
    // temporary names collided for exactly the same reason.
    const copyTemporaries = copyTemporaryPaths(calls, directory);
    expect(copyTemporaries.length).toBeGreaterThanOrEqual(2);
    expect(new Set(copyTemporaries).size).toBe(copyTemporaries.length);

    const snapshot = await inspect(directory);
    const rejected = results.filter((result) => result.status === "rejected");
    const written = versions.map((history) => history.currentThreadId);
    // Data safety: a whole payload is what can be published, never a mixture, and one
    // of the generations always survives.
    expect(snapshot.current).not.toBe("invalid-json");
    expect(snapshot.bothUnrecoverable).toBe(false);
    expect(written.concat("base")).toContain(snapshot.recovered);
    expect(snapshot.leftovers).toEqual([]);

    logFacts("5a", "none injected (frozen clock, 4 concurrent writes)", snapshot);
    console.log(
      `[5a] Date.now() frozen for all ${versions.length} writers; distinct main temporary ` +
        `paths=${new Set(mainTemporaries).size}/${versions.length}, distinct copyAtomic paths=` +
        `${new Set(copyTemporaries).size}/${versions.length}, rejected=[${rejected
          .map((result) => result.reason?.code)
          .join(",")}]`
    );
  });

  it("5b: 12 rounds of concurrent writes never mangle or lose a generation", async () => {
    const fsFaults = installFaults();
    const rounds = 12;
    const writers = 4;
    const observed = {
      writes: 0,
      rejected: 0,
      temporaryPathCollisions: 0,
      copyTemporaryPathCollisions: 0,
      roundsWithoutRecovery: 0,
      roundsWithMangledCurrent: 0
    };
    const rejectionCodes = [];
    /** How the two snapshots looked in the rounds that lost everything. */
    const lostStatePairs = new Map();

    for (let round = 0; round < rounds; round += 1) {
      const directory = createDirectory();
      // A base generation makes every concurrent writer rotate too, and the different
      // label lengths would have made an interleaved write an unparsable mixture.
      const base = createHistory(`round-${round}-base`);
      await writeChatHistoryBackup(directory, base);
      const versions = Array.from({ length: writers }, (_, index) =>
        createHistory(`round-${round}-writer-${index}-${"x".repeat(index * 11)}`)
      );
      const known = [base, ...versions].map((history) => history.currentThreadId);
      const mark = fsFaults.mark();

      const results = await Promise.allSettled(
        versions.map((history) => writeChatHistoryBackup(directory, history))
      );
      const callsThisRound = fsFaults.log.slice(mark);
      const temporaryWrites = callsThisRound
        .filter(
          (entry) =>
            entry.method === "writeFile" && entry.path.startsWith(`${currentPath(directory)}.tmp-`)
        )
        .map((entry) => entry.path);
      const copyWrites = callsThisRound
        .filter(
          (entry) =>
            entry.method === "copyFile" &&
            entry.destination.startsWith(`${previousPath(directory)}.tmp-`)
        )
        .map((entry) => entry.destination);

      observed.writes += versions.length;
      for (const result of results) {
        if (result.status !== "rejected") continue;
        observed.rejected += 1;
        rejectionCodes.push(result.reason?.code ?? result.reason?.message);
      }
      observed.temporaryPathCollisions += temporaryWrites.length - new Set(temporaryWrites).size;
      observed.copyTemporaryPathCollisions += copyWrites.length - new Set(copyWrites).size;

      const snapshot = await inspect(directory);
      if (snapshot.current === "invalid-json") observed.roundsWithMangledCurrent += 1;
      if (snapshot.bothUnrecoverable) {
        observed.roundsWithoutRecovery += 1;
        const pair = `current=${snapshot.current}, previous=${snapshot.previous}`;
        lostStatePairs.set(pair, (lostStatePairs.get(pair) ?? 0) + 1);
      } else if (!known.includes(snapshot.recovered))
        throw new Error(`round ${round} recovered an unknown version: ${snapshot.recovered}`);
    }

    const codes = [...new Set(rejectionCodes)];
    expect(observed.writes).toBe(rounds * writers);
    // The three properties the fix has to deliver under real concurrency.
    expect(observed.temporaryPathCollisions).toBe(0);
    expect(observed.copyTemporaryPathCollisions).toBe(0);
    expect(observed.roundsWithMangledCurrent).toBe(0);
    expect(observed.roundsWithoutRecovery).toBe(0);
    console.log(
      `[5b] ${rounds} rounds x ${writers} concurrent writes: rejected=${observed.rejected} ` +
        `(${codes.join(",") || "none"}); temporary-path collisions=` +
        `${observed.temporaryPathCollisions} (copyAtomic: ${observed.copyTemporaryPathCollisions}); ` +
        `rounds with a mangled current=${observed.roundsWithMangledCurrent}; ` +
        `rounds with no recoverable snapshot=${observed.roundsWithoutRecovery}`
    );
    console.log(
      `[5b] state pairs in the unrecoverable rounds: ` +
        ([...lostStatePairs].map(([pair, count]) => `${pair} x${count}`).join("; ") || "none")
    );
  });

  it("5c: the frozen-clock batch that used to publish a mixture now leaves a valid pair", async () => {
    const fsFaults = installFaults();
    const directory = createDirectory();
    const base = createHistory("base");
    await writeChatHistoryBackup(directory, base);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    // Differing label lengths are what turned a shared temporary file into an
    // unparsable mixture before the fix.
    const versions = [
      createHistory(`victim-${"x".repeat(40)}`),
      createHistory("v2"),
      createHistory(`v3-${"y".repeat(12)}`),
      createHistory("v4")
    ];
    const mark = fsFaults.mark();
    const results = await Promise.allSettled(
      versions.map((history) => writeChatHistoryBackup(directory, history))
    );
    clock.mockRestore();
    const calls = fsFaults.log.slice(mark);

    const mainTemporaries = mainTemporaryPaths(calls, directory);
    const copyTemporaries = copyTemporaryPaths(calls, directory);
    expect(new Set(mainTemporaries).size).toBe(versions.length);
    expect(new Set(copyTemporaries).size).toBe(copyTemporaries.length);
    expect(copyTemporaries.length).toBeGreaterThanOrEqual(2);

    // Every temporary file belongs to exactly one writer, so whatever got renamed into
    // place is a whole payload: no mixture is published and no generation is lost. The
    // exact winning version depends on how the four writers interleave.
    const snapshot = await inspect(directory);
    const known = [base, ...versions].map((history) => history.currentThreadId);
    expect(snapshot.current).not.toBe("invalid-json");
    expect(snapshot.bothUnrecoverable).toBe(false);
    expect(known).toContain(snapshot.recovered);
    expect(snapshot.leftovers).toEqual([]);

    logFacts("5c", "frozen clock, 4 concurrent writes (no injected failure)", snapshot);
    const rejected = results.filter((result) => result.status === "rejected");
    console.log(
      `[5c] frozen Date.now(); ${new Set(mainTemporaries).size}/${versions.length} distinct main and ` +
        `${new Set(copyTemporaries).size}/${copyTemporaries.length} distinct copyAtomic temporary ` +
        `paths; recovered=${snapshot.recovered}; rejected=[${rejected
          .map((result) => result.reason?.code)
          .join(",")}]`
    );
  });
});

// ---------------------------------------------------------------------------
// F. The rotation check is strict about read failures
// ---------------------------------------------------------------------------
//
// Regression for the data loss this file first reproduced: an unreadable current
// snapshot was indistinguishable from an absent one, so the previous-generation
// rotation was skipped and the replacing rename could then destroy the only valid
// snapshot. The writer now distinguishes "no usable current" (missing, or content
// that does not validate) from "the current could not be read", and the latter aborts
// the write before anything is copied or replaced.

describe("F: a read failure of current must not skip the rotation", () => {
  it("F1: an unreadable current aborts the write and leaves that snapshot in place", async () => {
    const fsFaults = installFaults();
    const directory = createDirectory();
    const old = createHistory("old");
    await writeChatHistoryBackup(directory, old);
    expect(describeSnapshotFile(currentPath(directory))).toBe("valid:old");

    // A real read failure, which says nothing about the snapshot's content.
    fsFaults.fail("readFile", { code: "EACCES", match: (e) => e.path === currentPath(directory) });
    const mark = fsFaults.mark();

    const outcome = await writeChatHistoryBackup(directory, createHistory("new")).then(
      () => ({ rejected: false, error: undefined }),
      (error) => ({ rejected: true, error })
    );

    const snapshot = await inspect(directory);
    // The data comes first: the old snapshot must still be the current one and must
    // still be recoverable.
    expect(snapshot.current).toBe("valid:old");
    expect(snapshot.previous).toBe("missing");
    expect(snapshot.recovered).toBe("old");
    expect(snapshot.bothUnrecoverable).toBe(false);
    expect(await readChatHistoryBackup(directory)).toEqual(old);
    expect(snapshot.leftovers).toEqual([]);

    // Then the mechanism: the write stopped at the read, so nothing was copied aside
    // and nothing was replaced.
    const calls = fsFaults.log.slice(mark);
    expect(calls.filter((entry) => entry.method === "rename")).toHaveLength(0);
    expect(calls.filter((entry) => entry.method === "copyFile")).toHaveLength(0);

    // ...and the failure the caller sees is the read failure itself.
    expect(outcome.rejected).toBe(true);
    expect(outcome.error).toMatchObject({ code: "EACCES" });
    logFacts("F1", "read(current) EACCES -> write aborted before any rotation", snapshot);
  });

  it("F2: the destructive replace fallback is never reached, so both generations survive", async () => {
    const fsFaults = installFaults();
    const directory = createDirectory();
    const old = createHistory("old");
    await writeChatHistoryBackup(directory, old);
    await writeChatHistoryBackup(directory, createHistory("middle"));
    // current=middle, previous=old.
    expect(describeSnapshotFile(currentPath(directory))).toBe("valid:middle");
    expect(describeSnapshotFile(previousPath(directory))).toBe("valid:old");

    // 1. Reading current fails with EIO (distinct from the rename codes below, so the
    //    reported error proves which step failed).
    fsFaults.fail("readFile", { code: "EIO", match: (e) => e.path === currentPath(directory) });
    // 2. The replacing rename would have taken the destructive fallback and failed.
    fsFaults.fail("rename", {
      code: "EPERM",
      match: (e) => e.destination === currentPath(directory)
    });
    fsFaults.fail("rename", {
      code: "EACCES",
      match: (e) => e.destination === currentPath(directory)
    });
    const mark = fsFaults.mark();

    const outcome = await writeChatHistoryBackup(directory, createHistory("new")).then(
      () => ({ rejected: false, error: undefined }),
      (error) => ({ rejected: true, error })
    );

    const snapshot = await inspect(directory);
    // The data comes first: both generations are still on disk and still recoverable.
    expect(snapshot.current).toBe("valid:middle");
    expect(snapshot.previous).toBe("valid:old");
    expect(snapshot.recovered).toBe("middle");
    expect(snapshot.bothUnrecoverable).toBe(false);

    // Then the mechanism: the rename faults were never consumed, so in particular the
    // fallback's `rm(destination)` never ran.
    const calls = fsFaults.log.slice(mark);
    expect(calls.filter((entry) => entry.method === "rename")).toHaveLength(0);
    expect(
      calls.filter((entry) => entry.method === "rm" && entry.path === currentPath(directory))
    ).toHaveLength(0);

    // The read failure is what surfaced, not the rename failure behind it.
    expect(outcome.rejected).toBe(true);
    expect(outcome.error).toMatchObject({ code: "EIO" });
    logFacts(
      "F2",
      "read(current) EIO -> aborted before rename(EPERM)+rm(current)+rename(EACCES)",
      snapshot
    );
  });
});

// ---------------------------------------------------------------------------
// R. Regressions: only real read failures are fatal
// ---------------------------------------------------------------------------

describe("R: the strict check only rejects real read failures", () => {
  it("R1: a first write with no current snapshot still succeeds", async () => {
    const directory = createDirectory();
    // No `chat-history.backup.json` at all: the strict read hits ENOENT, which must
    // keep meaning "there is nothing to rotate", not "the write must fail".
    await expect(
      writeChatHistoryBackup(directory, createHistory("first"))
    ).resolves.toBeUndefined();

    const snapshot = await inspect(directory);
    expect(snapshot.current).toBe("valid:first");
    expect(snapshot.previous).toBe("missing");
    expect(snapshot.recovered).toBe("first");
    expect(snapshot.bothUnrecoverable).toBe(false);
    logFacts("R1", "read(current) ENOENT -> first snapshot written", snapshot);
  });

  it("R2: an invalid-JSON current is unusable, not fatal", async () => {
    const directory = createDirectory();
    fs.writeFileSync(currentPath(directory), "{damaged", "utf8");

    await expect(
      writeChatHistoryBackup(directory, createHistory("replacement"))
    ).resolves.toBeUndefined();

    const snapshot = await inspect(directory);
    expect(snapshot.current).toBe("valid:replacement");
    // Damaged content is not worth rotating: there was no valid generation to keep.
    expect(snapshot.previous).toBe("missing");
    expect(snapshot.recovered).toBe("replacement");
    logFacts("R2", "current content unparsable -> replaced", snapshot);
  });

  it("R3: a checksum-mismatched current is unusable, not fatal", async () => {
    const directory = createDirectory();
    // Parses as a backup and carries a history, but the payload does not match the
    // checksum, so it is not a usable generation.
    fs.writeFileSync(
      currentPath(directory),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          savedAt: new Date().toISOString(),
          checksum: "0".repeat(64),
          chatHistory: createHistory("ghost")
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await expect(
      writeChatHistoryBackup(directory, createHistory("replacement"))
    ).resolves.toBeUndefined();

    const snapshot = await inspect(directory);
    expect(snapshot.current).toBe("valid:replacement");
    expect(snapshot.previous).toBe("missing");
    expect(snapshot.recovered).toBe("replacement");
    logFacts("R3", "current checksum mismatch -> replaced", snapshot);
  });

  it("R4: a structurally invalid current history is unusable, not fatal", async () => {
    const directory = createDirectory();
    // The checksum matches, but the history itself cannot be validated.
    const brokenHistory = { threads: "not-an-array" };
    fs.writeFileSync(
      currentPath(directory),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          savedAt: new Date().toISOString(),
          checksum: checksumOf(brokenHistory),
          chatHistory: brokenHistory
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await expect(
      writeChatHistoryBackup(directory, createHistory("replacement"))
    ).resolves.toBeUndefined();

    const snapshot = await inspect(directory);
    expect(snapshot.current).toBe("valid:replacement");
    expect(snapshot.previous).toBe("missing");
    expect(snapshot.recovered).toBe("replacement");
    logFacts("R4", "current history invalid (checksum ok) -> replaced", snapshot);
  });

  it("R5: readChatHistoryBackup() keeps its tolerant recovery semantics", async () => {
    // Nothing on disk at all.
    const emptyDirectory = createDirectory();
    expect(await readChatHistoryBackup(emptyDirectory)).toBeUndefined();

    // Only a previous snapshot: a missing current must not stop the fallback.
    await writeChatHistoryBackup(emptyDirectory, createHistory("only"));
    fs.renameSync(currentPath(emptyDirectory), previousPath(emptyDirectory));
    expect((await readChatHistoryBackup(emptyDirectory))?.currentThreadId).toBe("only");

    // An unreadable current: the recovery reader skips it and uses the older
    // generation, exactly as it did before the writer started treating that read as
    // fatal.
    const fsFaults = installFaults();
    const directory = createDirectory();
    await writeChatHistoryBackup(directory, createHistory("v1"));
    await writeChatHistoryBackup(directory, createHistory("v2"));
    fsFaults.fail("readFile", { code: "EACCES", match: (e) => e.path === currentPath(directory) });
    expect((await readChatHistoryBackup(directory))?.currentThreadId).toBe("v1");
    expect(await readChatHistoryBackup(directory)).not.toBeUndefined();

    console.log(
      "[R5] recovery read: no snapshots -> undefined; previous only -> previous; " +
        "unreadable current -> previous"
    );
  });
});
