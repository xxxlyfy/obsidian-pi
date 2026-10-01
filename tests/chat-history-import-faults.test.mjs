/**
 * Fault behaviour of the indexed chat history import.
 *
 * `loadIndexedThreads()` reads `pi_sessions/index.json` and treats the outcome in three
 * ways: a missing file is simply "no index", a read failure is a warning that leaves the
 * chat files alone, and a successful read supplies `currentThreadId`. These tests pin that
 * down, because the earlier shape -- an `access()` pre-check whose `catch` turned every
 * error into `false` -- reported EACCES/EPERM/EIO as "the index does not exist", silently
 * degrading `currentThreadId` and producing no warning at all.
 *
 * `listFiles()` is the contrast the fix is modelled on: it rethrows everything except
 * ENOENT, and a readdir failure still aborts the import. An unreadable `index.json` must
 * not, because the chat files behind it were already read.
 *
 * Every test uses a real temporary vault and the real filesystem. Only `fs.promises.*` on
 * the shared `node:fs` object is wrapped -- the same object the module imports -- so every
 * call still reaches the real filesystem unless a rule asks for one specific failure. This
 * is the instrumentation pattern the repository already uses
 * (`chat-history-backup-faults.test.mjs`); no mock filesystem and no new dependency.
 *
 * The facts recorded per case are the ones that decide whether data is lost: what the
 * caller got back, the warnings it got, the `currentThreadId` it ended up with, which
 * files it considers managed, and which filesystem calls it actually made.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  importVaultChatHistory,
  removeImportedVaultChatHistory
} from "../src/threads/chat-history-import.mjs";

const INDEXED_STORAGE_VERSION = 1;
/** Real I/O failures that say nothing about whether a file exists. */
const IO_ERROR_CODES = ["EACCES", "EPERM", "EIO"];

const temporaryDirectories = [];
/** @type {ReturnType<typeof createFsFaultInjector> | undefined} */
let faults;

afterEach(() => {
  faults?.restore();
  faults = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-import-faults-"));
  temporaryDirectories.push(directory);
  return directory;
}

// ---------------------------------------------------------------------------
// Fault injection over the real filesystem
// ---------------------------------------------------------------------------

/**
 * Wrap the `fs.promises` methods this module uses. A rule fails the first `times` calls
 * that match, with the injected `code`; every other call reaches the real filesystem.
 */
function createFsFaultInjector() {
  const log = [];
  const rules = [];
  const originals = new Map();
  const WRAPPED = ["access", "readdir", "readFile"];

  for (const method of WRAPPED) {
    const original = fs.promises[method];
    originals.set(method, original);
    fs.promises[method] = async function instrumented(...args) {
      const entry = { method, path: String(args[0]), failed: undefined };
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
    calls(method, filter = () => true) {
      return log.filter((entry) => entry.method === method && filter(entry));
    },
    /** The injected failures seen so far, in order. */
    injected() {
      return log.filter((entry) => entry.failed).map((entry) => `${entry.method}:${entry.failed}`);
    },
    restore() {
      for (const [method, original] of originals) fs.promises[method] = original;
      originals.clear();
    }
  };
}

function installFaults() {
  faults = createFsFaultInjector();
  return faults;
}

// ---------------------------------------------------------------------------
// Fixtures: a real vault on disk
// ---------------------------------------------------------------------------

function createVault() {
  return createDirectory();
}

/**
 * The indexed layout the import reads: `pi_sessions/chats/*.json` plus the
 * `pi_sessions/index.json` that names the thread to select.
 */
function createIndexedVault({ threads, index } = {}) {
  const vault = createVault();
  const chats = path.join(vault, "pi_sessions", "chats");
  fs.mkdirSync(chats, { recursive: true });
  for (const thread of threads ?? [createThread("thread-1", 1)]) {
    fs.writeFileSync(
      path.join(chats, `${thread.id}.json`),
      JSON.stringify({ schemaVersion: 1, thread })
    );
  }
  if (index !== undefined) {
    fs.writeFileSync(path.join(vault, "pi_sessions", "index.json"), JSON.stringify(index), "utf8");
  }
  return vault;
}

function indexedPath(vault, ...parts) {
  return path.join(vault, "pi_sessions", ...parts);
}

function createThread(id, updatedAt) {
  return {
    id,
    title: id,
    messages: [{ role: "user", content: "Prompt", createdAt: updatedAt }],
    createdAt: updatedAt,
    updatedAt,
    archived: false,
    favorite: false
  };
}

/** The facts of one completed case. */
function inspect(imported) {
  return {
    outcome: imported === undefined ? "undefined" : "history",
    threads: imported?.history?.threads?.map((thread) => thread.id) ?? [],
    currentThreadId: imported?.history?.currentThreadId,
    warnings: imported?.warnings ?? [],
    managedNames: (imported?.managedFiles ?? []).map((filePath) => path.basename(filePath)).sort()
  };
}

/** Print the facts in one line, so a run reads as a report. */
function logFacts(label, injected, snapshot) {
  console.log(
    `[${label}] injected=${injected || "none"}; outcome=${snapshot.outcome}; ` +
      `threads=[${snapshot.threads.join(",")}]; currentThreadId=${snapshot.currentThreadId ?? "none"}; ` +
      `warnings=${snapshot.warnings.length}; managed=[${snapshot.managedNames.join(",")}]`
  );
}

function isIndexFile(filePath, vault) {
  return path.resolve(filePath) === path.resolve(indexedPath(vault, "index.json"));
}

function isMigrationBackup(filePath, vault) {
  return path.resolve(filePath) === path.resolve(indexedPath(vault, "migration-backup-v0.json"));
}

/** A vault whose index points at the older thread, so a fallback is observable. */
function createVaultWithIndex() {
  return createIndexedVault({
    threads: [createThread("thread-newest", 100), createThread("thread-indexed", 50)],
    index: { currentThreadId: "thread-indexed" }
  });
}

// ---------------------------------------------------------------------------
// 1. index.json: present, missing, unreadable
// ---------------------------------------------------------------------------

describe("1: how index.json is read", () => {
  it("1a: index.json present -> its currentThreadId wins and it is managed", async () => {
    const fsFaults = installFaults();
    const vault = createVaultWithIndex();

    const imported = await importVaultChatHistory(vault, {
      chatHistoryStorageVersion: INDEXED_STORAGE_VERSION
    });

    const snapshot = inspect(imported);
    // The index wins over "most recently updated", which is the whole point of the file.
    expect(snapshot.currentThreadId).toBe("thread-indexed");
    expect(snapshot.threads).toEqual(["thread-indexed", "thread-newest"]);
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.managedNames).toEqual([
      "index.json",
      "thread-indexed.json",
      "thread-newest.json"
    ]);
    // ...and it was read, not merely probed.
    expect(fsFaults.calls("readFile").map((entry) => path.basename(entry.path))).toContain(
      "index.json"
    );
    expect(fsFaults.calls("access", (entry) => isIndexFile(entry.path, vault))).toEqual([]);
    logFacts("1a", "none (index.json present)", snapshot);
  });

  it("1b: an explicit currentChatId still overrides the index", async () => {
    const vault = createVaultWithIndex();

    const imported = await importVaultChatHistory(vault, {
      chatHistoryStorageVersion: INDEXED_STORAGE_VERSION,
      currentChatId: "thread-newest"
    });

    expect(imported.history.currentThreadId).toBe("thread-newest");
  });

  it("1c: index.json missing -> no warning, fallback selection, not managed", async () => {
    const fsFaults = installFaults();
    const vault = createIndexedVault({
      threads: [createThread("thread-newest", 100), createThread("thread-indexed", 50)]
    });

    const imported = await importVaultChatHistory(vault, {
      chatHistoryStorageVersion: INDEXED_STORAGE_VERSION
    });

    const snapshot = inspect(imported);
    expect(snapshot.threads).toEqual(["thread-indexed", "thread-newest"]);
    // A missing index is not a problem to report: the fallback picks the newest thread.
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.currentThreadId).toBe("thread-newest");
    expect(snapshot.managedNames).toEqual(["thread-indexed.json", "thread-newest.json"]);
    expect(fsFaults.injected()).toEqual([]);
    logFacts("1c", "none (index.json absent -> real ENOENT)", snapshot);
  });

  it("1d: index.json with unparsable JSON is a warning, not a fatal error", async () => {
    const vault = createVaultWithIndex();
    fs.writeFileSync(indexedPath(vault, "index.json"), "{damaged", "utf8");

    const imported = await importVaultChatHistory(vault, {
      chatHistoryStorageVersion: INDEXED_STORAGE_VERSION
    });

    const snapshot = inspect(imported);
    // The bytes were read, so the file is managed and only its content is a problem.
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toContain("index.json");
    expect(snapshot.threads).toEqual(["thread-indexed", "thread-newest"]);
    expect(snapshot.currentThreadId).toBe("thread-newest");
    expect(snapshot.managedNames).toContain("index.json");
    logFacts("1d", "none (index.json content damaged)", snapshot);
  });
});

// ---------------------------------------------------------------------------
// 2. index.json read failures: warning plus fallback, never a lost import
// ---------------------------------------------------------------------------

describe("2: a failed index.json read warns and the import continues", () => {
  for (const code of IO_ERROR_CODES) {
    it(`2/${code}: the chat files survive an unreadable index`, async () => {
      const fsFaults = installFaults();
      const vault = createVaultWithIndex();
      fsFaults.fail("readFile", { code, match: (entry) => isIndexFile(entry.path, vault) });

      const imported = await importVaultChatHistory(vault, {
        chatHistoryStorageVersion: INDEXED_STORAGE_VERSION
      });

      const snapshot = inspect(imported);
      // The import resolves: one unreadable metadata file is not a failed migration.
      expect(snapshot.outcome).toBe("history");
      // Both chat files are still imported, in full.
      expect(snapshot.threads).toEqual(["thread-indexed", "thread-newest"]);
      // The failure is reported, with the file and the code, so the plugin layer shows a
      // "some files were left in place" notice instead of silence.
      expect(snapshot.warnings).toHaveLength(1);
      expect(snapshot.warnings[0]).toContain(indexedPath(vault, "index.json"));
      expect(snapshot.warnings[0]).toContain(code);
      // `currentThreadId` falls back, but it is not silently reported as "all fine".
      expect(snapshot.currentThreadId).toBe("thread-newest");
      // An index that could not be read must not be treated as a managed file.
      expect(snapshot.managedNames).toEqual(["thread-indexed.json", "thread-newest.json"]);
      // The index is read directly: no `access()` pre-check exists any more.
      expect(fsFaults.injected()).toEqual([`readFile:${code}`]);
      expect(fsFaults.calls("access", (entry) => isIndexFile(entry.path, vault))).toEqual([]);
      expect(
        fsFaults
          .calls("readFile")
          .filter((entry) => isIndexFile(entry.path, vault))
          .map((entry) => entry.failed)
      ).toEqual([code]);
      logFacts(`2/${code}`, `readFile:${code} on index.json`, snapshot);
    });
  }

  it("2e: the reader is asked for index.json, never probed with access() first", async () => {
    const fsFaults = installFaults();
    const vault = createVaultWithIndex();

    await importVaultChatHistory(vault, { chatHistoryStorageVersion: INDEXED_STORAGE_VERSION });

    // The only `access()` call left in this layout is the legacy-backup probe.
    expect(fsFaults.calls("access").map((entry) => path.basename(entry.path))).toEqual([
      "migration-backup-v0.json"
    ]);
    expect(
      fsFaults
        .calls("readFile")
        .map((entry) => path.basename(entry.path))
        .sort()
    ).toEqual(["index.json", "thread-indexed.json", "thread-newest.json"]);
    console.log(
      "[2e] index.json is read with readFile(); access() is only used for the legacy backup"
    );
  });

  it("2f: an unreadable index still returns every thread the chats folder provided", async () => {
    const fsFaults = installFaults();
    const threads = [
      createThread("thread-alpha", 1),
      createThread("thread-beta", 2),
      createThread("thread-gamma", 3)
    ];
    const vault = createIndexedVault({ threads, index: { currentThreadId: "thread-alpha" } });
    fsFaults.fail("readFile", { code: "EACCES", match: (entry) => isIndexFile(entry.path, vault) });

    const imported = await importVaultChatHistory(vault, {
      chatHistoryStorageVersion: INDEXED_STORAGE_VERSION
    });

    // The regression this fix exists for: index metadata unreadable != history lost.
    expect(imported.history.threads.map((thread) => thread.id).sort()).toEqual([
      "thread-alpha",
      "thread-beta",
      "thread-gamma"
    ]);
    expect(imported.warnings).toHaveLength(1);
    expect(imported.warnings[0]).toContain("EACCES");
    // The threads are the real ones, messages included, not placeholders.
    expect(imported.history.threads.find((thread) => thread.id === "thread-beta")).toMatchObject({
      title: "thread-beta",
      messages: [{ role: "user", content: "Prompt", createdAt: 2 }]
    });
    // Nothing was degraded to "no warning at all": the plugin would otherwise restore the
    // history and report complete success.
    expect(imported.warnings.length > 0).toBe(true);
    logFacts("2f", "readFile:EACCES on index.json", inspect(imported));
  });
});

// ---------------------------------------------------------------------------
// 3. The legacy migration backup
// ---------------------------------------------------------------------------

describe("3: the legacy migration-backup-v0.json probe", () => {
  it("3a: a present legacy backup is managed and changes nothing else", async () => {
    const vault = createVaultWithIndex();
    fs.writeFileSync(indexedPath(vault, "migration-backup-v0.json"), "{}\n", "utf8");

    const imported = await importVaultChatHistory(vault, {
      chatHistoryStorageVersion: INDEXED_STORAGE_VERSION
    });

    const snapshot = inspect(imported);
    expect(snapshot.managedNames).toEqual([
      "index.json",
      "migration-backup-v0.json",
      "thread-indexed.json",
      "thread-newest.json"
    ]);
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.currentThreadId).toBe("thread-indexed");
    logFacts("3a", "none (legacy backup present)", snapshot);
  });

  it("3b: a missing legacy backup stays silent", async () => {
    const fsFaults = installFaults();
    const vault = createVaultWithIndex();

    const imported = await importVaultChatHistory(vault, {
      chatHistoryStorageVersion: INDEXED_STORAGE_VERSION
    });

    expect(imported.warnings).toEqual([]);
    expect(inspect(imported).managedNames).not.toContain("migration-backup-v0.json");
    expect(fsFaults.injected()).toEqual([]);
    console.log("[3b] migration-backup-v0.json absent -> not managed, no warning");
  });

  it("3c: an unreadable legacy backup warns instead of looking absent, and keeps the threads", async () => {
    const fsFaults = installFaults();
    const vault = createVaultWithIndex();
    fsFaults.fail("access", {
      code: "EACCES",
      match: (entry) => isMigrationBackup(entry.path, vault)
    });

    const imported = await importVaultChatHistory(vault, {
      chatHistoryStorageVersion: INDEXED_STORAGE_VERSION
    });

    const snapshot = inspect(imported);
    expect(snapshot.outcome).toBe("history");
    expect(snapshot.threads).toEqual(["thread-indexed", "thread-newest"]);
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toContain("migration-backup-v0.json");
    expect(snapshot.warnings[0]).toContain("EACCES");
    // The unconfirmed file is not recorded as managed, and the index still worked.
    expect(snapshot.managedNames).toEqual([
      "index.json",
      "thread-indexed.json",
      "thread-newest.json"
    ]);
    expect(snapshot.currentThreadId).toBe("thread-indexed");
    expect(fsFaults.injected()).toEqual(["access:EACCES"]);
    logFacts("3c", "access:EACCES on migration-backup-v0.json", snapshot);
  });
});

// ---------------------------------------------------------------------------
// 4. Missing directories and readdir failures
// ---------------------------------------------------------------------------

describe("4: missing directories and readdir failures", () => {
  it("4a: a vault with no chat history at all still imports as undefined", async () => {
    installFaults();
    const vault = createVault();

    const imported = await importVaultChatHistory(vault, {});
    expect(imported).toBeUndefined();
    // Every layout is absent: readdir ENOENT and readFile ENOENT, no failure surfaces.
    expect(faults.injected()).toEqual([]);
    logFacts("4a", "none (empty vault -> real ENOENT everywhere)", inspect(imported));
  });

  it("4b: an unreachable indexed chats folder propagates instead of looking empty", async () => {
    const fsFaults = installFaults();
    const vault = createIndexedVault({ threads: [createThread("thread-1", 1)] });
    const chatsFolder = indexedPath(vault, "chats");
    fsFaults.fail("readdir", { code: "EACCES", match: (entry) => entry.path === chatsFolder });

    await expect(
      importVaultChatHistory(vault, { chatHistoryStorageVersion: INDEXED_STORAGE_VERSION })
    ).rejects.toMatchObject({ code: "EACCES" });

    // This is the contrast with the index snapshot: `listFiles()` rethrows everything but
    // ENOENT, so an unreadable chats folder is fatal while an unreadable index is not.
    expect(fsFaults.injected()).toEqual(["readdir:EACCES"]);
    console.log(
      "[4b] readdir:EACCES on pi_sessions/chats -> the import rejects; " +
        "the same code on readFile(index.json) -> the import warns and continues"
    );
  });

  it("4c: other readdir I/O codes propagate as well", async () => {
    for (const code of ["EPERM", "EIO"]) {
      const fsFaults = installFaults();
      const vault = createIndexedVault({ threads: [createThread("thread-1", 1)] });
      const chatsFolder = indexedPath(vault, "chats");
      fsFaults.fail("readdir", { code, match: (entry) => entry.path === chatsFolder });

      await expect(
        importVaultChatHistory(vault, { chatHistoryStorageVersion: INDEXED_STORAGE_VERSION })
      ).rejects.toMatchObject({ code });
      expect(fsFaults.injected()).toEqual([`readdir:${code}`]);
      fsFaults.restore();
      console.log(`[4c] readdir:${code} on pi_sessions/chats -> rejected with ${code}`);
    }
  });

  it("4d: a missing indexed chats folder is still just an empty list", async () => {
    installFaults();
    // `pi_sessions` exists but has no `chats` directory: readdir hits ENOENT and
    // `listFiles()` returns an empty list, which is the behaviour that must not change.
    const vault = createVault();
    fs.mkdirSync(indexedPath(vault));
    fs.writeFileSync(
      indexedPath(vault, "index.json"),
      JSON.stringify({ currentThreadId: "thread-absent" }),
      "utf8"
    );

    const imported = await importVaultChatHistory(vault, {
      chatHistoryStorageVersion: INDEXED_STORAGE_VERSION
    });

    // No threads at all, so `importVaultChatHistory` has nothing to return. The point is
    // that ENOENT from readdir produced no error.
    expect(imported).toBeUndefined();
    expect(faults.injected()).toEqual([]);
    logFacts("4d", "none (indexed chats folder absent -> real ENOENT)", inspect(imported));
  });
});

// ---------------------------------------------------------------------------
// 5. The isInside() boundary of removeImportedVaultChatHistory()
// ---------------------------------------------------------------------------

describe("5: removeImportedVaultChatHistory keeps its vault boundary", () => {
  it("5a: a managed file outside the vault base is skipped", async () => {
    const vault = createVault();
    const chats = path.join(vault, "chats");
    fs.mkdirSync(chats);
    const inside = path.join(chats, "thread-1.json");
    fs.writeFileSync(inside, "{}\n", "utf8");

    // An untrusted path from `data.json`: it resolves outside the vault.
    const outsideDirectory = createVault();
    const outside = path.join(outsideDirectory, "elsewhere.json");
    fs.writeFileSync(outside, "{}\n", "utf8");

    await removeImportedVaultChatHistory(vault, [inside, outside], undefined);

    expect(fs.existsSync(inside)).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.existsSync(outsideDirectory)).toBe(true);
    console.log("[5a] in-vault managed file deleted, out-of-vault managed file skipped");
  });

  it("5b: traversal, the base itself and a sibling prefix are all refused", async () => {
    const vault = createVault();
    const chats = path.join(vault, "chats");
    fs.mkdirSync(chats);
    const inside = path.join(chats, "thread-1.json");
    fs.writeFileSync(inside, "{}\n", "utf8");

    const sibling = `${vault}-sibling`;
    temporaryDirectories.push(sibling);
    fs.mkdirSync(sibling);
    const siblingFile = path.join(sibling, "thread-2.json");
    fs.writeFileSync(siblingFile, "{}\n", "utf8");

    await removeImportedVaultChatHistory(
      vault,
      [
        inside,
        // `..` escapes the base.
        path.join(vault, "chats", "..", "..", "escape.json"),
        // The base directory itself is not "inside" itself.
        vault,
        // A sibling directory whose name starts with the base name is not inside it.
        siblingFile
      ],
      undefined
    );

    expect(fs.existsSync(inside)).toBe(false);
    expect(fs.existsSync(siblingFile)).toBe(true);
    console.log("[5b] traversal, the base itself and a `base-sibling` prefix were all skipped");
  });

  it("5c: a vault-relative managed file goes through the vault API", async () => {
    const vault = createVault();
    const chats = path.join(vault, "chats");
    fs.mkdirSync(chats);
    const inside = path.join(chats, "thread-1.md");
    fs.writeFileSync(inside, "# Chat\n", "utf8");

    const deleted = [];
    const fakeVault = {
      getAbstractFileByPath: (vaultPath) => ({ path: vaultPath, extension: "md" }),
      delete: async (file, force) => deleted.push([file.path, force])
    };

    await removeImportedVaultChatHistory(vault, [inside], fakeVault);

    expect(deleted).toEqual([["chats/thread-1.md", true]]);
    // Deleted through the vault, so the file is still on this test's disk.
    expect(fs.existsSync(inside)).toBe(true);
    console.log("[5c] in-vault .md file deleted through vault.delete(), not fs.rm");
  });
});
