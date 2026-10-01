import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Notice texts are recorded so a test can assert that a read-only session lookup never
// reports anything to the user. vi.hoisted because the vi.mock factory below is hoisted
// above these declarations.
const harness = vi.hoisted(() => ({ notices: [] }));

vi.mock("obsidian", () => {
  class ObsidianBase {}
  class Notice {
    constructor(message) {
      harness.notices.push(String(message));
    }
  }
  return {
    Component: ObsidianBase,
    FuzzySuggestModal: ObsidianBase,
    ItemView: ObsidianBase,
    MarkdownRenderChild: ObsidianBase,
    MarkdownRenderer: { render: vi.fn().mockResolvedValue(undefined) },
    MarkdownView: ObsidianBase,
    Menu: ObsidianBase,
    Modal: ObsidianBase,
    Notice,
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

const { PiAgentPlugin } = await import("../src/plugin/PiAgentPlugin.mjs");
const { DEFAULT_SETTINGS } = await import("../src/plugin/settings.mjs");
const { PiRpcClient } = await import("../src/pi/rpc-client.mjs");
const { PiRunner } = await import("../src/pi/runner.mjs");
const { ThreadStore } = await import("../src/threads/thread-store.mjs");

/**
 * `PiAgentPlugin.getThreadSessionEntries(threadId, since)` is a one-shot session lookup
 * and has to leave nothing behind, like Session Info, export and rename.
 *
 * Every scenario goes through the real production path --
 * `plugin.getThreadSessionEntries()` -> `createEphemeralThreadRunner()` /
 * `createPiRunner()` -> `PiRunner.getSessionEntries()` -> `PiRpcClient` -> a real fake Pi
 * child process launched by `spawn` -- and asserts the runner registry, the client and
 * the child process it leaves behind.
 *
 * A thread that already has a runner keeps it untouched, because that runner may be
 * carrying a chat run; every other thread borrows the plugin's ephemeral runner and
 * releases it on success and on failure alike.
 */

const PI_FIXTURE = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
const THREAD_ID = "thread-a";

let tempDirs = [];
let plugins = [];
let startedClients = [];
let spawnedChildren = [];

beforeEach(() => {
  // Record every client that really spawns a Pi process, and the child process it
  // created, so a test that fails mid-lifecycle cannot leak a process into the machine
  // running the suite. `PiRpcClient.start()` assigns `this.child` inside the promise
  // executor, so a child that differs from the previous one is a real `spawn()`.
  const originalStart = PiRpcClient.prototype.start;
  vi.spyOn(PiRpcClient.prototype, "start").mockImplementation(function (...args) {
    const previousChild = this.child;
    startedClients.push(this);
    const result = originalStart.apply(this, args);
    if (this.child && this.child !== previousChild) spawnedChildren.push(this.child);
    return result;
  });
});

afterEach(async () => {
  // Cleanup: dispose every client this test really started, then wait until every child
  // process of this test has exited, so the next test starts on a quiet machine.
  const clients = startedClients.splice(0);
  for (const client of clients) if (!client.disposed) client.dispose();
  for (const plugin of plugins.splice(0)) {
    for (const runner of plugin.threadRunners.values()) runner.dispose();
    plugin.threadRunners.clear();
    for (const runner of plugin.ephemeralRunners ?? []) runner.dispose();
    plugin.ephemeralRunners?.clear();
  }
  const children = spawnedChildren.splice(0);
  await vi.waitFor(() => expect(children.every((child) => !childAlive(child))).toBe(true), {
    timeout: 10_000
  });
  for (const tempDir of tempDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  tempDirs = [];
  vi.restoreAllMocks();
  harness.notices.length = 0;
});

function createTempDir(prefix = "pi-agent-entries-") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

/**
 * A launcher the production spawn path can execute that runs a fake Pi RPC fixture for
 * real. Pi itself is not installed in the test environment, and `PiRunner` always
 * launches its client with Pi's own CLI arguments, so the launcher ignores those
 * arguments and starts the fixture.
 */
function createFakePiLauncher(fixture = PI_FIXTURE) {
  const directory = createTempDir();
  if (process.platform === "win32") {
    const launcher = path.join(directory, "fake-pi.cmd");
    fs.writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${fixture}"\r\n`, "utf8");
    return launcher;
  }
  const launcher = path.join(directory, "fake-pi.sh");
  fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${fixture}"\n`, "utf8");
  fs.chmodSync(launcher, 0o755);
  return launcher;
}

/**
 * A fake Pi child that receives `get_entries` and never answers it, so the request stays
 * pending for as long as the child lives. It first reports that it received the command,
 * so a test can tell "Pi never answered" from "the request never arrived"; every other
 * command succeeds.
 */
const PENDING_ENTRIES_FIXTURE_SOURCE = `let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const index = buffer.indexOf("\\n");
    if (index < 0) break;
    let line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.endsWith("\\r")) line = line.slice(0, -1);
    if (line) handle(JSON.parse(line));
  }
});
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function handle(command) {
  if (command.type === "get_entries") {
    send({ type: "request_pending", command: command.type });
    return;
  }
  send({ id: command.id, type: "response", command: command.type, success: true, data: {} });
}
`;

function createPendingEntriesFixture() {
  const directory = createTempDir();
  const fixture = path.join(directory, "fake-pi-rpc-entries-pending.mjs");
  fs.writeFileSync(fixture, PENDING_ENTRIES_FIXTURE_SOURCE, "utf8");
  return fixture;
}

/**
 * A plugin whose thread store, runner registry and services are the production ones, with
 * one real session file per thread, so a thread that has never run looks exactly like a
 * historical thread the thread list asks `getThreadSessionEntries()` about.
 */
function createSessionPlugin(threadIds, { piFixture = PI_FIXTURE } = {}) {
  const pluginDirectory = createTempDir();
  const sessionDirectory = path.join(pluginDirectory, "pi-sessions");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const threads = threadIds.map((id) => {
    const piSessionId = `session-${id}.jsonl`;
    fs.writeFileSync(path.join(sessionDirectory, piSessionId), "", "utf8");
    const now = Date.now();
    return {
      id,
      title: `Thread ${id}`,
      messages: [],
      createdAt: now,
      updatedAt: now,
      archived: false,
      favorite: false,
      piSessionId
    };
  });

  const plugin = Object.create(PiAgentPlugin.prototype);
  plugin.settings = { ...DEFAULT_SETTINGS, piExecutablePath: createFakePiLauncher(piFixture) };
  plugin.threadRunners = new Map();
  // The constructor field `createEphemeralThreadRunner()` registers into.
  plugin.ephemeralRunners = new Set();
  plugin.unloading = false;
  plugin.modelCatalogGeneration = 0;
  plugin.modelCatalogRefreshedAt = 0;
  plugin.piCommands = [];
  plugin.app = {
    vault: { getAbstractFileByPath: () => undefined },
    workspace: { getActiveFile: () => undefined },
    metadataCache: {}
  };
  plugin.getVaultBasePath = () => pluginDirectory;
  plugin.getPluginDirectory = () => pluginDirectory;
  plugin.threadHistory = new ThreadStore({ currentThreadId: threadIds[0], threads });
  plugin.syncCurrentThreadState = vi.fn();
  plugin.saveThreadHistory = vi.fn();
  plugin.rebuildServices();
  plugins.push(plugin);
  return plugin;
}

/**
 * Records the real runner, client, request, disposal and child process behind every
 * `getSessionEntries()` call. The spies call through to the production implementations,
 * so the objects they collect are the ones doing the work.
 */
function trackSessionEntriesActivity({ failRequestTypes = [] } = {}) {
  const runners = [];
  const requests = [];
  const disposals = [];
  const events = [];

  const originalGetSessionEntries = PiRunner.prototype.getSessionEntries;
  vi.spyOn(PiRunner.prototype, "getSessionEntries").mockImplementation(function (...args) {
    runners.push(this);
    return originalGetSessionEntries.apply(this, args);
  });

  const originalRequest = PiRpcClient.prototype.request;
  vi.spyOn(PiRpcClient.prototype, "request").mockImplementation(function (type, ...rest) {
    requests.push({ client: this, type });
    if (failRequestTypes.includes(type)) return Promise.reject(new Error(`Pi RPC ${type} failed.`));
    return originalRequest.call(this, type, ...rest);
  });

  const originalDispose = PiRpcClient.prototype.dispose;
  vi.spyOn(PiRpcClient.prototype, "dispose").mockImplementation(function (...args) {
    // The child is still attached here; the client drops it once the process exits.
    disposals.push({ client: this, child: this.child });
    return originalDispose.apply(this, args);
  });

  // Every message the client parsed out of Pi's stdout, so a test can prove what the
  // child really received and answered.
  const originalEmit = PiRpcClient.prototype.emit;
  vi.spyOn(PiRpcClient.prototype, "emit").mockImplementation(function (...args) {
    events.push({ client: this, message: args[0] });
    return originalEmit.apply(this, args);
  });

  return {
    runners,
    requests,
    disposals,
    events,
    get clients() {
      return [...new Set(requests.map(({ client }) => client))];
    },
    get children() {
      return spawnedChildren;
    }
  };
}

/** Wait until a fake Pi child has reported that it is holding `command` unanswered. */
async function waitForRequestPending(events, command, timeoutMs = 10_000) {
  await vi.waitFor(
    () =>
      expect(
        events.filter(
          ({ message }) => message.type === "request_pending" && message.command === command
        )
      ).toHaveLength(1),
    { timeout: timeoutMs }
  );
}

function childAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

/** One completed lookup: its runner, client and child process are all released. */
async function expectReleased(tracker, { clients, children }) {
  expect(tracker.runners).toHaveLength(1);
  expect(tracker.runners[0]).toBeInstanceOf(PiRunner);
  expect(tracker.runners[0].disposed).toBe(true);
  expect(tracker.runners[0].rpcClient).toBeUndefined();
  expect(tracker.clients).toHaveLength(clients);
  expect(tracker.clients.every((client) => client.disposed === true)).toBe(true);
  expect(tracker.disposals.map(({ client }) => client)).toEqual(tracker.clients);
  const spawned = tracker.children;
  expect(spawned).toHaveLength(children);
  await vi.waitFor(() => expect(spawned.every((child) => !childAlive(child))).toBe(true), {
    timeout: 10_000
  });
}

describe("A. getThreadSessionEntries on a thread that has no runner yet", () => {
  it("releases the temporary runner and Pi process after a successful lookup", async () => {
    const plugin = createSessionPlugin([THREAD_ID]);
    const tracker = trackSessionEntriesActivity();
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.ephemeralRunners.size).toBe(0);

    // The fixture answers `get_entries` with an empty success payload, so a resolved
    // value proves the request really travelled through the RPC client to the child.
    expect(await plugin.getThreadSessionEntries(THREAD_ID)).toEqual({});

    expect(tracker.requests.map(({ type }) => type)).toEqual(["get_entries"]);
    // Nothing long-lived: no cached runner for the thread, and the borrowed runner, its
    // client and its Pi child process are all released.
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.threadRunners.has(THREAD_ID)).toBe(false);
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(plugin.ephemeralRunners.has(tracker.runners[0])).toBe(false);
    await expectReleased(tracker, { clients: 1, children: 1 });
    expect(harness.notices).toEqual([]);
  }, 60_000);

  it("never registers the temporary runner while it is working", async () => {
    const plugin = createSessionPlugin([THREAD_ID]);
    const threadRegistrySizes = [];
    const ephemeralRegistrySizes = [];
    const originalRequest = PiRpcClient.prototype.request;
    vi.spyOn(PiRpcClient.prototype, "request").mockImplementation(function (type, ...rest) {
      threadRegistrySizes.push(plugin.threadRunners.size);
      ephemeralRegistrySizes.push(plugin.ephemeralRunners.size);
      return originalRequest.call(this, type, ...rest);
    });

    await plugin.getThreadSessionEntries(THREAD_ID);

    // Not registered as a thread runner before, during, or after the request...
    expect(threadRegistrySizes).toEqual([0]);
    expect(plugin.threadRunners.size).toBe(0);
    // ...but tracked as the plugin's ephemeral runner for exactly as long as it exists,
    // which is what lets `onunload()` release it.
    expect(ephemeralRegistrySizes).toEqual([1]);
    expect(plugin.ephemeralRunners.size).toBe(0);
    const [child] = spawnedChildren;
    await vi.waitFor(() => expect(childAlive(child)).toBe(false), { timeout: 10_000 });
  }, 60_000);
});

describe("B. getThreadSessionEntries on a thread that already has a runner", () => {
  it("reuses that runner, its client and its process", async () => {
    const plugin = createSessionPlugin([THREAD_ID]);
    const runner = plugin.createPiRunner(THREAD_ID);
    expect(plugin.threadRunners.get(THREAD_ID)).toBe(runner);
    // A fresh chat runner has not started Pi yet.
    expect(runner.rpcClient).toBeUndefined();
    const tracker = trackSessionEntriesActivity();

    expect(await plugin.getThreadSessionEntries(THREAD_ID)).toEqual({});

    const client = runner.rpcClient;
    expect(tracker.runners).toEqual([runner]);
    expect(plugin.threadRunners.get(THREAD_ID)).toBe(runner);
    expect(plugin.threadRunners.size).toBe(1);
    // The lookup ran on the runner the thread already had: same runner, same client, no
    // second one, and nothing was released.
    expect(tracker.clients).toEqual([client]);
    expect(runner.disposed).toBe(false);
    expect(client).toBeInstanceOf(PiRpcClient);
    expect(client.disposed).toBe(false);
    expect(client.running).toBe(true);
    expect(childAlive(client.child)).toBe(true);
    expect(tracker.children).toHaveLength(1);
    expect(tracker.disposals).toEqual([]);
    // A reused thread runner is never an ephemeral one.
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(harness.notices).toEqual([]);
  }, 60_000);
});

describe("C. getThreadSessionEntries when the RPC fails", () => {
  it("returns the original error and releases the temporary runner and process", async () => {
    const plugin = createSessionPlugin([THREAD_ID]);
    const tracker = trackSessionEntriesActivity({ failRequestTypes: ["get_entries"] });

    await expect(plugin.getThreadSessionEntries(THREAD_ID)).rejects.toThrow(
      "Pi RPC get_entries failed."
    );

    // The failing lookup really started Pi first, then handed the error through.
    expect(tracker.requests.map(({ type }) => type)).toEqual(["get_entries"]);
    await expectReleased(tracker, { clients: 1, children: 1 });
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(harness.notices).toEqual([]);
  }, 60_000);
});

describe("D. getThreadSessionEntries when the session file is missing", () => {
  it("returns the original error and leaves no runner behind", async () => {
    const plugin = createSessionPlugin([THREAD_ID]);
    fs.rmSync(path.join(plugin.getPluginDirectory(), "pi-sessions", `session-${THREAD_ID}.jsonl`));
    const tracker = trackSessionEntriesActivity();

    await expect(plugin.getThreadSessionEntries(THREAD_ID)).rejects.toThrow(
      "The local Pi session file is not available."
    );

    // The failure happened before any client was started, and the borrowed runner was
    // still released.
    expect(tracker.requests).toEqual([]);
    expect(tracker.children).toEqual([]);
    expect(tracker.disposals).toEqual([]);
    expect(tracker.runners).toHaveLength(1);
    expect(tracker.runners[0].disposed).toBe(true);
    expect(tracker.runners[0].rpcClient).toBeUndefined();
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(plugin.ephemeralRunners.has(tracker.runners[0])).toBe(false);
  }, 60_000);
});

describe("E. ten historical threads without a runner", () => {
  it("leaves no long-lived runner or Pi process after ten lookups", async () => {
    const threadIds = Array.from({ length: 10 }, (_, index) => `thread-${index}`);
    const plugin = createSessionPlugin(threadIds);
    const tracker = trackSessionEntriesActivity();
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.ephemeralRunners.size).toBe(0);

    for (const threadId of threadIds) {
      expect(await plugin.getThreadSessionEntries(threadId)).toEqual({});
    }

    // Nothing long-lived: no thread gained a cached runner, no thread is registered at
    // all, and every temporary runner, client and Pi child process is gone.
    expect(plugin.threadRunners.size).toBe(0);
    expect(threadIds.every((threadId) => !plugin.threadRunners.has(threadId))).toBe(true);
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(tracker.runners).toHaveLength(10);
    expect(tracker.runners.every((runner) => runner.disposed === true)).toBe(true);
    expect(tracker.clients).toHaveLength(10);
    expect(tracker.clients.every((client) => client.disposed === true)).toBe(true);
    expect(tracker.disposals).toHaveLength(10);
    const spawned = tracker.children;
    expect(spawned).toHaveLength(10);
    await vi.waitFor(() => expect(spawned.every((child) => !childAlive(child))).toBe(true), {
      timeout: 20_000
    });
    expect(harness.notices).toEqual([]);
  }, 120_000);
});

describe("F. a get_entries request pending when the plugin unloads", () => {
  it("releases the pending lookup through the ephemeral runner lifecycle", async () => {
    const plugin = createSessionPlugin([THREAD_ID], { piFixture: createPendingEntriesFixture() });
    const tracker = trackSessionEntriesActivity();

    // The lookup never gets an answer: it is still in flight when the plugin unloads. Its
    // outcome is captured in the same tick, so the test observes the rejection instead of
    // leaving Node to report it as unhandled.
    const pending = plugin.getThreadSessionEntries(THREAD_ID);
    const pendingOutcome = pending.then(
      () => undefined,
      (error) => error
    );
    await waitForRequestPending(tracker.events, "get_entries");

    const runner = tracker.runners[0];
    const [client] = tracker.clients;
    const child = client.child;
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.ephemeralRunners.size).toBe(1);
    expect(plugin.ephemeralRunners.has(runner)).toBe(true);
    expect(client.pending.size).toBe(1);
    expect(client.running).toBe(true);
    expect(childAlive(child)).toBe(true);

    expect(() => plugin.onunload()).not.toThrow();

    // The ephemeral owner released the pending lookup -- no RPC timeout needed.
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(runner.disposed).toBe(true);
    expect(runner.rpcClient).toBeUndefined();
    expect(client.disposed).toBe(true);
    expect(tracker.disposals.map(({ client: disposed }) => disposed)).toEqual([client]);
    expect(plugin.threadRunners.size).toBe(0);
    await vi.waitFor(() => expect(childAlive(child)).toBe(false), { timeout: 2_000 });

    // The operation that borrowed the runner still settles, through the rejection the
    // disposed client gives it, instead of hanging until the request times out.
    expect((await pendingOutcome)?.message).toBe("Pi RPC client disposed.");
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(plugin.threadRunners.size).toBe(0);
    expect(harness.notices).toEqual([]);
  }, 60_000);
});
