import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Notice texts are recorded so a test can assert exactly what the user was told.
// vi.hoisted because the vi.mock factory below is hoisted above these declarations.
const harness = vi.hoisted(() => ({ notices: [] }));

// The view, its mixins and the chat DOM builders all import from "obsidian". This
// mock is the smallest set that lets them finish evaluating, so the real header
// builder and the real view running-state method can be driven instead of
// re-implemented here.
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
    setIcon: (element, icon) => {
      element.icon = icon;
    }
  };
});

// The plugin, the runner, the real RPC client and the real UI wiring, in the order
// the components are stacked in production.
const { PiAgentPlugin } = await import("../src/plugin/PiAgentPlugin.mjs");
const { DEFAULT_SETTINGS } = await import("../src/plugin/settings.mjs");
const { PiRpcClient } = await import("../src/pi/rpc-client.mjs");
const { PiRunner } = await import("../src/pi/runner.mjs");
const { ThreadStore } = await import("../src/threads/thread-store.mjs");
const { ThreadActions } = await import("../src/ui/thread-actions.mjs");
const { PiAgentView } = await import("../src/ui/PiAgentView.mjs");
const { createHeader } = await import("../src/ui/view/chat-dom.mjs");
const { t: tr } = await import("../src/shared/i18n/index.mjs");

/**
 * `plugin.forkCurrentThread()` has two rules this file drives through the real
 * production path -- the header fork button, `ThreadActions.forkChat()`, the plugin
 * method, `PiRunner`, `PiRpcClient` and a real fake Pi child process.
 *
 * Running thread: refused, so a live run is never cloned on or released.
 *
 * Idle thread with a runner: that runner, its client and its Pi process belong to the
 * thread, so the fork borrows them and leaves them alone.
 *
 * Idle thread without a runner: the fork borrows an ephemeral runner instead of
 * registering a thread runner, and releases it on success and on failure alike.
 *
 * The running check in the button is the real `PiAgentView.prototype.isThreadRunning`,
 * which reads the same `state.activeRuns` map `beginTrackedRun()` fills with the run's
 * runner, so the check and the run it protects cannot drift apart here.
 */

const THREAD_ID = "thread-a";
const FORK_LABEL = tr("view.forkChat");

let tempDirs = [];
let plugins = [];
let startedClients = [];
let spawnedChildren = [];

beforeEach(() => {
  // Record every client that really spawns a Pi process, and the child process it
  // created, so a test that fails mid-lifecycle cannot leak a process into the
  // machine running the suite.
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

function createTempDir(prefix = "pi-agent-fork-") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function createFakePiLauncher(fixture) {
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
 * A fake Pi that keeps one run in flight forever: it accepts `prompt` and never
 * sends `agent_settled`, so `PiRunner.runPiRpc()` really stays inside its run while
 * a test drives the fork paths. `clone` succeeds and `get_state` reports the session
 * file Pi would have cloned into, so `cloneSession()` has a portable clone to hand
 * back. Every other command succeeds, so a thread's own runner can be started for
 * real before the fork. Written to disk at test time, because no shared fixture
 * belongs to this batch.
 */
function createRunningForkFixture(cloneFile) {
  const directory = createTempDir();
  const fixture = path.join(directory, "fake-pi-rpc-running-fork.mjs");
  const source = `const CLONE_FILE = ${JSON.stringify(cloneFile)};
let buffer = "";
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
  if (command.type === "prompt") {
    send({ id: command.id, type: "response", command: command.type, success: true });
    send({ type: "agent_start" });
    return;
  }
  if (command.type === "get_state") {
    send({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      data: { isStreaming: true, pid: process.pid, sessionFile: CLONE_FILE }
    });
    return;
  }
  send({ id: command.id, type: "response", command: command.type, success: true, data: {} });
}
`;
  fs.writeFileSync(fixture, source, "utf8");
  return fixture;
}

/**
 * A plugin whose thread store, runner registry and services are the production ones,
 * with one current thread that has a message, a Pi session file and a real fake Pi
 * launcher, so `forkCurrentThread()` runs for real.
 */
function createForkPlugin() {
  const pluginDirectory = createTempDir();
  const sessionDirectory = path.join(pluginDirectory, "pi-sessions");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const piSessionId = `session-${THREAD_ID}.jsonl`;
  fs.writeFileSync(path.join(sessionDirectory, piSessionId), "", "utf8");
  const cloneFile = path.join(sessionDirectory, "cloned.jsonl");
  fs.writeFileSync(cloneFile, "", "utf8");
  const now = Date.now();

  const plugin = Object.create(PiAgentPlugin.prototype);
  plugin.settings = {
    ...DEFAULT_SETTINGS,
    piExecutablePath: createFakePiLauncher(createRunningForkFixture(cloneFile))
  };
  plugin.threadRunners = new Map();
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
  plugin.threadHistory = new ThreadStore({
    currentThreadId: THREAD_ID,
    threads: [
      {
        id: THREAD_ID,
        title: `Thread ${THREAD_ID}`,
        messages: [{ role: "user", content: "hello", createdAt: now }],
        createdAt: now,
        updatedAt: now,
        archived: false,
        favorite: false,
        piSessionId
      }
    ]
  });
  plugin.syncCurrentThreadState = vi.fn();
  plugin.saveThreadHistory = vi.fn();
  plugin.rebuildServices();
  plugins.push(plugin);
  return plugin;
}

function threadSessionId(plugin, threadId = THREAD_ID) {
  return plugin.threadHistory.getThread(threadId).piSessionId;
}

/** Start the thread's own runner for real, so the fork has a live client to reuse. */
async function startIdleThreadRunner(plugin, runner) {
  expect(await runner.getSessionStats(threadSessionId(plugin))).toEqual({});
  expect(runner.rpcClient.running).toBe(true);
  return runner.rpcClient;
}

/**
 * Records the runner every fork cloned through, the requests that really reached a
 * client, and every client disposal, so a test can tell what the fork released.
 */
function trackForkActivity({ failRequestTypes = [] } = {}) {
  const requests = [];
  const runners = [];
  const disposals = [];

  const originalClone = PiRunner.prototype.cloneSession;
  vi.spyOn(PiRunner.prototype, "cloneSession").mockImplementation(function (...args) {
    runners.push(this);
    return originalClone.apply(this, args);
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

  return {
    requests,
    runners,
    disposals,
    get clients() {
      return [...new Set(requests.map(({ client }) => client))];
    }
  };
}

/** Every request type, in the order the child received it. */
function requestTypes(requests) {
  return requests.map(({ type }) => type);
}

function childAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

/** Wait until every child process this test really spawned has exited. */
async function expectChildrenGone() {
  await vi.waitFor(() => expect(spawnedChildren.every((child) => !childAlive(child))).toBe(true), {
    timeout: 10_000
  });
}

/** "resolved", "rejected: <message>", or "pending" if the run has not settled in time. */
function settledWithin(runPromise, timeoutMs) {
  return Promise.race([
    runPromise.then(
      () => "resolved",
      (error) => `rejected: ${error?.message}`
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), timeoutMs))
  ]);
}

/**
 * Start a real run on the thread's runner and wait until Pi has received the prompt,
 * which is when `PiRunner.isRunning` is set and the child is alive. The fixture never
 * settles the run, so it stays in flight for the rest of the test.
 */
async function startRunningThread(plugin, requests) {
  const runner = plugin.createPiRunner(THREAD_ID);
  expect(runner).toBeInstanceOf(PiRunner);
  const runPromise = runner.runPiRpc("hello", threadSessionId(plugin), {});
  await vi.waitFor(() => expect(requestTypes(requests)).toContain("prompt"), { timeout: 10_000 });
  expect(runner.isRunning).toBe(true);
  expect(runner.rpcClient.running).toBe(true);
  return { runner, runPromise };
}

class FakeElement {
  constructor(tag, options = {}) {
    this.tag = tag;
    this.cls = options.cls ?? "";
    this.text = options.text ?? "";
    this.attr = options.attr ?? {};
    this.children = [];
    this.listeners = new Map();
  }

  createEl(tag, options) {
    const child = new FakeElement(tag, options);
    this.children.push(child);
    return child;
  }

  createDiv(options) {
    return this.createEl("div", options);
  }

  createSpan(options) {
    return this.createEl("span", options);
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

/** The real view surface `createHeader()` needs, with the real running-state method. */
function createHeaderView(plugin, { runningThreadIds = [] } = {}) {
  const renderToolBadges = vi.fn();
  const view = {
    plugin,
    state: {
      activeRuns: new Map(runningThreadIds.map((threadId) => [threadId, { threadId }]))
    },
    renderPiIcon: vi.fn(),
    renderThreadTitle: vi.fn(),
    renderThreadFavorite: vi.fn(),
    startThreadTitleRename: vi.fn(),
    toggleCurrentThreadFavorite: vi.fn(),
    showThreadList: vi.fn(),
    renderToolBadges,
    // The production method: `state.activeRuns.has(threadId)`.
    isThreadRunning: PiAgentView.prototype.isThreadRunning,
    threadMenu: new ThreadActions(plugin, {
      resetThreadUiState: vi.fn(),
      renderThreadTitle: vi.fn(),
      renderMessages: vi.fn(),
      renderToolBadges
    })
  };
  return view;
}

/** Build the real header and hand back its fork button, wired by production code. */
function createForkButton(plugin, options) {
  const view = createHeaderView(plugin, options);
  const root = new FakeElement("div");
  createHeader(root, view);
  const button = root.descendants().find((element) => element.attr?.["aria-label"] === FORK_LABEL);
  expect(button, `no element labelled ${FORK_LABEL}`).toBeDefined();
  expect(button.listeners.get("click")).toBeTypeOf("function");
  return { view, button };
}

function click(element) {
  element.listeners.get("click")({ preventDefault: () => {} });
}

/** Wait until the fork became the current thread, through the real button chain. */
async function waitForFork(plugin) {
  await vi.waitFor(() => expect(plugin.threadHistory.getCurrentThread().id).not.toBe(THREAD_ID), {
    timeout: 10_000
  });
  return plugin.threadHistory.getCurrentThread();
}

describe("the header fork button on a thread whose run is in flight", () => {
  it("refuses the fork and leaves the run, runner, client and child untouched", async () => {
    const plugin = createForkPlugin();
    const tracker = trackForkActivity();
    const { runner, runPromise } = await startRunningThread(plugin, tracker.requests);
    const client = runner.rpcClient;
    const child = client.child;
    const { view, button } = createForkButton(plugin, { runningThreadIds: [THREAD_ID] });
    expect(view.isThreadRunning(THREAD_ID)).toBe(true);

    click(button);

    // The click was refused before it reached the plugin: the user is told why, and
    // nothing in the fork path ran.
    expect(harness.notices).toEqual([tr("view.forkBusy")]);
    expect(requestTypes(tracker.requests)).toEqual(["get_state", "prompt"]);
    expect(tracker.runners).toEqual([]);
    expect(view.renderToolBadges).not.toHaveBeenCalled();
    expect(plugin.threadHistory.getCurrentThread().id).toBe(THREAD_ID);
    expect(plugin.threadHistory.history.threads).toHaveLength(1);
    // The running runner keeps its registry entry, its client and its Pi process.
    expect(plugin.threadRunners.get(THREAD_ID)).toBe(runner);
    expect(runner.disposed).toBe(false);
    expect(runner.rpcClient).toBe(client);
    expect(client.disposed).toBe(false);
    expect(childAlive(child)).toBe(true);
    expect(runner.isRunning).toBe(true);
    // The run itself is still in flight, not settled by the refused fork.
    expect(await settledWithin(runPromise, 500)).toBe("pending");
  }, 60_000);
});

describe("forkCurrentThread called directly while the thread is running", () => {
  /**
   * The plugin method protects itself, because the header button is not the only way a
   * caller can arrive here. An unguarded fork on a running thread would clone on the
   * live client and switch the current thread while the run was still streaming.
   */
  it("rejects direct plugin fork while the current thread is running", async () => {
    const plugin = createForkPlugin();
    const tracker = trackForkActivity();
    const { runner, runPromise } = await startRunningThread(plugin, tracker.requests);
    const client = runner.rpcClient;
    const child = client.child;
    const requestsBefore = requestTypes(tracker.requests);
    expect(requestsBefore).toEqual(["get_state", "prompt"]);

    // This is the call the header button refuses to make while the thread is running.
    const fork = await plugin.forkCurrentThread();

    // Refused before the fork path did anything: no clone, no session rename, and no
    // request at all beyond the ones the run itself made.
    expect(fork).toBeUndefined();
    expect(requestTypes(tracker.requests)).toEqual(requestsBefore);
    expect(tracker.runners).toEqual([]);
    // History and current thread are untouched.
    expect(plugin.threadHistory.getCurrentThread().id).toBe(THREAD_ID);
    expect(plugin.threadHistory.history.threads).toHaveLength(1);
    // The running runner keeps its registry entry, its client and its Pi process.
    expect(plugin.threadRunners.get(THREAD_ID)).toBe(runner);
    expect(plugin.threadRunners.size).toBe(1);
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(runner.isRunning).toBe(true);
    expect(runner.disposed).toBe(false);
    expect(runner.rpcClient).toBe(client);
    expect(client.disposed).toBe(false);
    expect(client.running).toBe(true);
    expect(childAlive(child)).toBe(true);
    expect(harness.notices).toEqual([]);
    // The run the fork was refused for is still in flight, and still able to finish:
    // the refusal left its event subscription intact instead of orphaning it.
    expect(await settledWithin(runPromise, 500)).toBe("pending");
    client.emit({ type: "agent_settled" });
    expect(await settledWithin(runPromise, 2_000)).toBe("resolved");
    expect(client.disposed).toBe(false);
    expect(childAlive(child)).toBe(true);
  }, 60_000);
});

describe("forking an idle thread through the real button chain", () => {
  it("releases the ephemeral runner and Pi process when the thread has no runner", async () => {
    const plugin = createForkPlugin();
    const tracker = trackForkActivity();
    const { view, button } = createForkButton(plugin);
    expect(view.isThreadRunning(THREAD_ID)).toBe(false);
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.ephemeralRunners.size).toBe(0);

    click(button);

    const fork = await waitForFork(plugin);
    expect(requestTypes(tracker.requests)).toEqual(["clone", "get_state", "set_session_name"]);
    expect(fork.piSessionId).toBe("cloned.jsonl");
    expect(fork.title).toBe(tr("thread.forkTitle", { title: `Thread ${THREAD_ID}` }));
    expect(plugin.threadHistory.history.threads).toHaveLength(2);
    expect(harness.notices).toEqual([]);
    // The fork borrowed an ephemeral runner: it never entered `threadRunners`, and it
    // is released with its client and Pi process once the requests have settled.
    expect(tracker.runners).toHaveLength(1);
    expect(tracker.runners[0]).toBeInstanceOf(PiRunner);
    expect(tracker.runners[0].disposed).toBe(true);
    expect(tracker.runners[0].rpcClient).toBeUndefined();
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.threadRunners.has(THREAD_ID)).toBe(false);
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(plugin.ephemeralRunners.has(tracker.runners[0])).toBe(false);
    expect(tracker.clients).toHaveLength(1);
    expect(tracker.clients[0].disposed).toBe(true);
    expect(tracker.disposals.map(({ client }) => client)).toEqual(tracker.clients);
    expect(spawnedChildren).toHaveLength(1);
    await expectChildrenGone();
    expect(view.renderToolBadges).toHaveBeenCalled();
  }, 60_000);

  it("keeps the thread's own runner, client and Pi process when it already has one", async () => {
    const plugin = createForkPlugin();
    const runner = plugin.createPiRunner(THREAD_ID);
    expect(runner).toBeInstanceOf(PiRunner);
    const tracker = trackForkActivity();
    const client = await startIdleThreadRunner(plugin, runner);
    const child = client.child;
    expect(requestTypes(tracker.requests)).toEqual(["get_session_stats"]);
    expect(plugin.threadRunners.get(THREAD_ID)).toBe(runner);
    expect(plugin.threadRunners.size).toBe(1);
    expect(spawnedChildren).toHaveLength(1);
    const { button } = createForkButton(plugin);

    click(button);

    const fork = await waitForFork(plugin);
    // The fork borrowed the runner the thread already had: same runner, same client,
    // same Pi process, no second runner and no second process.
    expect(requestTypes(tracker.requests)).toEqual([
      "get_session_stats",
      "clone",
      "get_state",
      "set_session_name"
    ]);
    expect(fork.piSessionId).toBe("cloned.jsonl");
    expect(plugin.threadHistory.history.threads).toHaveLength(2);
    expect(tracker.runners).toEqual([runner]);
    expect(tracker.disposals).toEqual([]);
    expect(plugin.threadRunners.get(THREAD_ID)).toBe(runner);
    expect(plugin.threadRunners.size).toBe(1);
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(runner.disposed).toBe(false);
    expect(runner.rpcClient).toBe(client);
    expect(client.disposed).toBe(false);
    expect(client.running).toBe(true);
    expect(childAlive(child)).toBe(true);
    expect(spawnedChildren).toHaveLength(1);
    expect(harness.notices).toEqual([]);
  }, 60_000);
});

describe("fork failures keep the same runner ownership", () => {
  it("releases the ephemeral runner and Pi process when the clone RPC fails", async () => {
    const plugin = createForkPlugin();
    const tracker = trackForkActivity({ failRequestTypes: ["clone"] });
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.ephemeralRunners.size).toBe(0);

    await expect(plugin.forkCurrentThread()).rejects.toThrow("Pi RPC clone failed.");

    // The original error is handed through, and the borrowed runner is released with
    // its client and Pi process.
    expect(requestTypes(tracker.requests)).toEqual(["clone"]);
    expect(tracker.runners).toHaveLength(1);
    expect(tracker.runners[0]).toBeInstanceOf(PiRunner);
    expect(tracker.runners[0].disposed).toBe(true);
    expect(tracker.runners[0].rpcClient).toBeUndefined();
    expect(tracker.clients).toHaveLength(1);
    expect(tracker.clients[0].disposed).toBe(true);
    expect(tracker.disposals.map(({ client }) => client)).toEqual(tracker.clients);
    expect(spawnedChildren).toHaveLength(1);
    await expectChildrenGone();
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.threadRunners.has(THREAD_ID)).toBe(false);
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(plugin.ephemeralRunners.has(tracker.runners[0])).toBe(false);
    expect(plugin.threadHistory.getCurrentThread().id).toBe(THREAD_ID);
    expect(plugin.threadHistory.history.threads).toHaveLength(1);
  }, 60_000);

  it("keeps the thread's own runner, client and process when the clone RPC fails", async () => {
    const plugin = createForkPlugin();
    const runner = plugin.createPiRunner(THREAD_ID);
    const tracker = trackForkActivity({ failRequestTypes: ["clone"] });
    const client = await startIdleThreadRunner(plugin, runner);
    const child = client.child;

    await expect(plugin.forkCurrentThread()).rejects.toThrow("Pi RPC clone failed.");

    expect(requestTypes(tracker.requests)).toEqual(["get_session_stats", "clone"]);
    expect(tracker.disposals).toEqual([]);
    expect(plugin.threadRunners.get(THREAD_ID)).toBe(runner);
    expect(plugin.threadRunners.size).toBe(1);
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(runner.disposed).toBe(false);
    expect(runner.rpcClient).toBe(client);
    expect(client.disposed).toBe(false);
    expect(client.running).toBe(true);
    expect(childAlive(child)).toBe(true);
    expect(spawnedChildren).toHaveLength(1);
    expect(plugin.threadHistory.getCurrentThread().id).toBe(THREAD_ID);
    expect(plugin.threadHistory.history.threads).toHaveLength(1);
  }, 60_000);

  it("treats a session-name failure as non-fatal and keeps the thread's runner", async () => {
    const plugin = createForkPlugin();
    const runner = plugin.createPiRunner(THREAD_ID);
    const tracker = trackForkActivity({ failRequestTypes: ["set_session_name"] });
    const client = await startIdleThreadRunner(plugin, runner);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const fork = await plugin.forkCurrentThread();

    // Naming the clone stays best-effort, exactly as before the ownership change.
    expect(fork).toBeTruthy();
    expect(fork.piSessionId).toBe("cloned.jsonl");
    expect(requestTypes(tracker.requests)).toEqual([
      "get_session_stats",
      "clone",
      "get_state",
      "set_session_name"
    ]);
    expect(warn).toHaveBeenCalledWith(
      "Pi Agent: could not name cloned Pi session",
      expect.any(Error)
    );
    expect(plugin.threadHistory.history.threads).toHaveLength(2);
    expect(tracker.disposals).toEqual([]);
    expect(plugin.threadRunners.get(THREAD_ID)).toBe(runner);
    expect(runner.disposed).toBe(false);
    expect(client.disposed).toBe(false);
    expect(childAlive(client.child)).toBe(true);
  }, 60_000);

  it("reports the original clone error through the real button chain", async () => {
    const plugin = createForkPlugin();
    const tracker = trackForkActivity({ failRequestTypes: ["clone"] });
    const { button } = createForkButton(plugin);

    click(button);

    await vi.waitFor(() => expect(harness.notices).toHaveLength(1), { timeout: 10_000 });
    expect(harness.notices).toEqual(["Pi RPC clone failed."]);
    expect(plugin.threadHistory.getCurrentThread().id).toBe(THREAD_ID);
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(tracker.runners).toHaveLength(1);
    expect(tracker.runners[0].disposed).toBe(true);
    await expectChildrenGone();
  }, 60_000);
});
