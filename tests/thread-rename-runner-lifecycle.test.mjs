import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Notice texts are recorded so a test can prove that a rename failure is reported
// on the console and nowhere else. vi.hoisted because the vi.mock factory below is
// hoisted above these declarations.
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

/** Answers every rename command with a success response. */
const PI_FIXTURE = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
/** Answers `set_session_name` with an error response. */
const PI_RENAME_FAILURE_FIXTURE = path.resolve("tests/fixtures/fake-pi-rpc-rename-failure.mjs");
/** Receives one-shot session commands and never answers them, keeping them pending. */
const PI_PENDING_FIXTURE = path.resolve("tests/fixtures/fake-pi-rpc-pending.mjs");

// The production methods, captured before any spy replaces them, so every spy below
// calls through to the real implementation.
const originalStart = PiRpcClient.prototype.start;
const originalRequest = PiRpcClient.prototype.request;
const originalDispose = PiRpcClient.prototype.dispose;
const originalEmit = PiRpcClient.prototype.emit;
const originalCreateEphemeralThreadRunner = PiAgentPlugin.prototype.createEphemeralThreadRunner;
const originalCreatePiRunner = PiAgentPlugin.prototype.createPiRunner;

/**
 * Everything real the current test did: one `spawns` entry per `start()` call, one
 * `requests` entry per RPC request with the promise that settles on Pi's response,
 * one `disposals` entry per `dispose()`, one `events` entry per message the client
 * parsed from Pi, the runners each `renameThread()` entry point handed out, and the
 * runners `createPiRunner()` returned.
 */
let activity;
let tempDirs = [];
let plugins = [];
let spawnedClients = [];

beforeEach(() => {
  activity = {
    spawns: [],
    requests: [],
    disposals: [],
    events: [],
    ephemeralRunners: [],
    threadRunnerRequests: []
  };
  vi.spyOn(PiRpcClient.prototype, "start").mockImplementation(function (...args) {
    const started = originalStart.apply(this, args);
    // start() spawns the child process synchronously, before it returns its promise.
    activity.spawns.push({ client: this, child: this.child });
    spawnedClients.push(this);
    return started;
  });
  vi.spyOn(PiRpcClient.prototype, "request").mockImplementation(function (type, payload, options) {
    const request = originalRequest.call(this, type, payload, options);
    activity.requests.push({ client: this, type, payload, request });
    return request;
  });
  vi.spyOn(PiRpcClient.prototype, "dispose").mockImplementation(function (...args) {
    // The child is still attached here; the client drops it once the process exits.
    activity.disposals.push({ client: this, child: this.child });
    return originalDispose.apply(this, args);
  });
  // Every message the client parsed out of Pi's stdout, so a test can prove what the
  // child really received and answered.
  vi.spyOn(PiRpcClient.prototype, "emit").mockImplementation(function (...args) {
    activity.events.push({ client: this, message: args[0] });
    return originalEmit.apply(this, args);
  });
  // Both runner entry points renameThread() can take are recorded, so a test can
  // prove which branch ran and which runner it owned.
  vi.spyOn(PiAgentPlugin.prototype, "createEphemeralThreadRunner").mockImplementation(function (
    ...args
  ) {
    const runner = originalCreateEphemeralThreadRunner.apply(this, args);
    activity.ephemeralRunners.push(runner);
    return runner;
  });
  vi.spyOn(PiAgentPlugin.prototype, "createPiRunner").mockImplementation(function (...args) {
    const runner = originalCreatePiRunner.apply(this, args);
    activity.threadRunnerRequests.push(runner);
    return runner;
  });
});

afterEach(async () => {
  // Release every Pi process this test really spawned, whether or not production
  // code released it, and wait for the processes to be gone. A failing assertion
  // must not leave a node process behind for the rest of the suite.
  const clients = new Set(spawnedClients.splice(0));
  for (const plugin of plugins.splice(0)) {
    for (const runner of plugin.threadRunners.values()) {
      if (runner.rpcClient) clients.add(runner.rpcClient);
      // A test may have made a runner's release fail on purpose; teardown still has
      // to reach the client below and wait for the process to be gone.
      try {
        runner.dispose();
      } catch {
        // Best effort: the client is released directly below.
      }
    }
    plugin.threadRunners.clear();
  }
  for (const runner of activity?.ephemeralRunners ?? []) {
    if (runner.rpcClient) clients.add(runner.rpcClient);
    try {
      runner.dispose();
    } catch {
      // Best effort: the client is released directly below.
    }
  }
  for (const client of clients) client.dispose();
  await waitForChildrenToExit();
  vi.restoreAllMocks();
  for (const tempDir of tempDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  tempDirs = [];
  harness.notices.length = 0;
  activity = undefined;
});

function createTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-rename-"));
  tempDirs.push(tempDir);
  return tempDir;
}

/**
 * A launcher the production spawn path can execute that runs one of the fake Pi RPC
 * fixtures for real. Pi itself is not installed in the test environment, and
 * `PiRunner` always launches its client with Pi's own CLI arguments, so the launcher
 * ignores those arguments and starts the fixture.
 */
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
 * A launcher that exits immediately instead of speaking RPC: the rename request can
 * be written but never answered, so `setSessionName()` fails at the very start of a
 * client that really started.
 */
function createExitingPiLauncher() {
  const directory = createTempDir();
  if (process.platform === "win32") {
    const launcher = path.join(directory, "exiting-pi.cmd");
    fs.writeFileSync(launcher, "@echo off\r\nexit /b 1\r\n", "utf8");
    return launcher;
  }
  const launcher = path.join(directory, "exiting-pi.sh");
  fs.writeFileSync(launcher, "#!/bin/sh\nexit 1\n", "utf8");
  fs.chmodSync(launcher, 0o755);
  return launcher;
}

/**
 * A plugin whose thread store, runner registry and services are the production
 * ones, with one real session file per thread, so a thread that has never run looks
 * exactly like a historical thread the thread list offers a rename for.
 */
function createRenamePlugin(threadIds, { renameRpcFails = false, piExecutablePath } = {}) {
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
  plugin.settings = {
    ...DEFAULT_SETTINGS,
    piExecutablePath:
      piExecutablePath ??
      createFakePiLauncher(renameRpcFails ? PI_RENAME_FAILURE_FIXTURE : PI_FIXTURE)
  };
  plugin.threadRunners = new Map();
  // The constructor field `createEphemeralThreadRunner()` registers into.
  plugin.ephemeralRunners = new Set();
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

function isChildExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

/** Distinct Pi child processes the production client really spawned. */
function spawnedChildren() {
  return [...new Set(activity.spawns.map(({ child }) => child).filter(Boolean))];
}

/** Distinct clients that really ran a Pi process, whether or not they are reachable now. */
function childClients() {
  return [...new Set(activity.spawns.map(({ client }) => client))];
}

/** The state of one client, as a value a test can assert and a report can print. */
function clientState(client) {
  if (!client) return undefined;
  return {
    disposed: client.disposed === true,
    running: client.running === true,
    childAlive: !isChildExited(client.child)
  };
}

/** The rename RPC requests this test has observed, in the order Pi received them. */
function renameRequests() {
  return activity.requests.filter(({ type }) => type === "set_session_name");
}

/**
 * Wait until every expected `set_session_name` request has received its response.
 *
 * `renameThread()` is not an async method, so the promise of the rename request is
 * the only anchor: the request is the point at which Pi's response really arrived,
 * and the release of a borrowed runner runs in the promise chain right after it.
 *
 * @param {number} expected Number of rename requests to wait for.
 * @returns {Promise<Array<{ client: PiRpcClient, type: string, payload: object }>>}
 */
async function waitForRenameResponses(expected) {
  await vi.waitFor(() => expect(renameRequests()).toHaveLength(expected), { timeout: 30_000 });
  const requests = renameRequests();
  await Promise.all(
    requests.map(({ request }) =>
      request.then(
        () => {},
        () => {}
      )
    )
  );
  return requests;
}

/**
 * Wait until a fake Pi child has told us it received the rename command. This is the
 * point at which `set_session_name` is genuinely outstanding in Pi, rather than still
 * sitting in the client's write path.
 *
 * @param {number} [expected] How many children must report the pending rename.
 * @param {number} [timeoutMs] Bound on waiting for the children's reports.
 */
async function waitForRenameRequestSeen(expected = 1, timeoutMs = 10_000) {
  await vi.waitFor(
    () =>
      expect(
        activity.events.filter(
          ({ message }) =>
            message.type === "request_pending" && message.command === "set_session_name"
        )
      ).toHaveLength(expected),
    { timeout: timeoutMs }
  );
}

/**
 * Wait for the real `close` event of a Pi child process, bounded by a short timeout.
 *
 * Deliberately event-driven and short: a test that used the 30s RPC request timeout
 * could not tell "released on unload" from "released when the request gave up".
 *
 * @param {import("node:child_process").ChildProcess} child Process to watch.
 * @param {number} timeoutMs How long to wait before declaring it still alive.
 * @returns {Promise<boolean>} Whether the process exited within the bound.
 */
function waitForChildExit(child, timeoutMs) {
  if (isChildExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("close", onClose);
      resolve(isChildExited(child));
    }, timeoutMs);
    child.once("close", onClose);
  });
}

/**
 * Collect the unhandled rejections raised while `run` executes, so a test can assert
 * that an asynchronous production path does not leave one behind. Vitest reports
 * unhandled rejections on its own as well; this makes the check explicit.
 *
 * @param {() => Promise<void> | void} run Test body to observe.
 * @returns {Promise<unknown[]>} The rejections Node reported.
 */
async function unhandledRejectionsDuring(run) {
  const rejections = [];
  const listener = (reason) => rejections.push(reason);
  process.on("unhandledRejection", listener);
  try {
    await run();
    // A rejection is only reported as unhandled once its microtask queue has drained.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return rejections;
  } finally {
    process.off("unhandledRejection", listener);
  }
}

/** Every Pi child process this test really spawned has exited. */
async function expectChildrenToExit() {
  const children = spawnedChildren();
  await vi.waitFor(() => expect(children.every(isChildExited)).toBe(true), { timeout: 10_000 });
}

/**
 * Wait for the real child processes of every client of this test to exit, then
 * force-kill whatever survived the polite terminate, so teardown cannot outlive the
 * test run.
 */
async function waitForChildrenToExit() {
  const children = spawnedChildren();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !children.every(isChildExited)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (children.every(isChildExited)) return;
  for (const client of childClients()) {
    try {
      client.terminate("SIGKILL");
    } catch {
      // Best effort: teardown reports nothing about a process already gone.
    }
  }
}

/** The one rename warning, in the wording the plugin has always used. */
function findRenameWarning(warn) {
  return warn.mock.calls.find(([message]) => message === "Pi Agent: could not rename Pi session");
}

describe("renameThread on a thread that has no runner", () => {
  it("borrows an ephemeral runner and releases it, its client and its Pi process", async () => {
    const plugin = createRenamePlugin(["thread-a"]);
    expect(plugin.threadRunners.size).toBe(0);

    expect(plugin.renameThread("thread-a", "New Title")).toBe(true);

    // The synchronous half is unchanged: the local title is updated immediately, and
    // nothing is registered while the rename RPC is still in flight.
    expect(plugin.threadHistory.getThread("thread-a").title).toBe("New Title");
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.threadRunners.has("thread-a")).toBe(false);
    expect(activity.threadRunnerRequests).toEqual([]);
    expect(activity.ephemeralRunners).toHaveLength(1);
    expect(activity.requests).toEqual([]);

    const requests = await waitForRenameResponses(1);

    expect(requests[0].payload).toEqual({ name: "New Title" });
    const [runner] = activity.ephemeralRunners;
    expect(runner).toBeInstanceOf(PiRunner);
    // The borrowed runner is released once the request has settled, and the plugin
    // stops tracking it: nothing ephemeral outlives a rename that completed.
    await vi.waitFor(() => expect(runner.disposed).toBe(true), { timeout: 10_000 });
    expect(runner.rpcClient).toBeUndefined();
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.threadRunners.has("thread-a")).toBe(false);
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(plugin.ephemeralRunners.has(runner)).toBe(false);
    expect(activity.threadRunnerRequests).toEqual([]);

    const clients = childClients();
    expect(clients).toHaveLength(1);
    expect(requests[0].client).toBe(clients[0]);
    expect(clients[0].disposed).toBe(true);
    expect(activity.disposals.map(({ client }) => client)).toEqual(clients);
    expect(spawnedChildren()).toHaveLength(1);
    await expectChildrenToExit();
  });

  it("releases the ephemeral runner when the rename RPC fails", async () => {
    const plugin = createRenamePlugin(["thread-a"], { renameRpcFails: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The synchronous API contract is unchanged: the local rename still succeeds and
    // reports success, and the failure only surfaces later, as a warning.
    expect(plugin.renameThread("thread-a", "New Title")).toBe(true);
    expect(plugin.threadHistory.getThread("thread-a").title).toBe("New Title");
    expect(plugin.saveThreadHistory).toHaveBeenCalledTimes(1);
    expect(plugin.threadRunners.size).toBe(0);

    await waitForRenameResponses(1);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith("Pi Agent: could not rename Pi session", expect.any(Error))
    );
    expect(findRenameWarning(warn)[1].message).toBe("Pi refused to rename the session.");
    expect(harness.notices).toEqual([]);

    const [runner] = activity.ephemeralRunners;
    await vi.waitFor(() => expect(runner.disposed).toBe(true), { timeout: 10_000 });
    expect(runner.rpcClient).toBeUndefined();
    expect(activity.threadRunnerRequests).toEqual([]);
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.threadRunners.has("thread-a")).toBe(false);
    // A failed rename releases its borrowed runner just like a successful one.
    expect(plugin.ephemeralRunners.size).toBe(0);

    const clients = childClients();
    expect(clients).toHaveLength(1);
    expect(clients[0].disposed).toBe(true);
    expect(activity.disposals.map(({ client }) => client)).toEqual(clients);
    expect(spawnedChildren()).toHaveLength(1);
    await expectChildrenToExit();
  });

  it("releases the ephemeral runner when the session file is gone", async () => {
    const plugin = createRenamePlugin(["thread-a"]);
    fs.rmSync(path.join(plugin.getPluginDirectory(), "pi-sessions", "session-thread-a.jsonl"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(plugin.renameThread("thread-a", "New Title")).toBe(true);

    const [runner] = activity.ephemeralRunners;
    await vi.waitFor(() => expect(runner.disposed).toBe(true), { timeout: 10_000 });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith("Pi Agent: could not rename Pi session", expect.any(Error))
    );
    expect(findRenameWarning(warn)[1].message).toBe("The local Pi session file is not available.");
    // The failure happened before any client was started, and the cleanup still ran.
    expect(activity.spawns).toEqual([]);
    expect(runner.rpcClient).toBeUndefined();
    expect(activity.threadRunnerRequests).toEqual([]);
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(harness.notices).toEqual([]);
  });

  it("releases the ephemeral runner when the rename fails right after the client starts", async () => {
    const plugin = createRenamePlugin(["thread-a"], {
      piExecutablePath: createExitingPiLauncher()
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(plugin.renameThread("thread-a", "New Title")).toBe(true);

    const [runner] = activity.ephemeralRunners;
    expect(runner).toBeInstanceOf(PiRunner);
    await vi.waitFor(() => expect(runner.disposed).toBe(true), { timeout: 15_000 });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith("Pi Agent: could not rename Pi session", expect.any(Error))
    );
    expect(runner.rpcClient).toBeUndefined();
    expect(activity.threadRunnerRequests).toEqual([]);
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.ephemeralRunners.size).toBe(0);
    // Every client the failed start produced was released with the borrowed runner.
    const clients = childClients();
    expect(clients.every((client) => client.disposed === true)).toBe(true);
    expect(activity.disposals.map(({ client }) => client)).toEqual(clients);
    await expectChildrenToExit();
    expect(harness.notices).toEqual([]);
  });

  it("keeps a runner another path registers while the rename is in flight", async () => {
    const plugin = createRenamePlugin(["thread-a"]);

    expect(plugin.renameThread("thread-a", "New Title")).toBe(true);
    const [ephemeral] = activity.ephemeralRunners;
    expect(ephemeral).toBeInstanceOf(PiRunner);

    // Another path creates the thread's real runner before the rename RPC settles.
    const late = plugin.createPiRunner("thread-a");
    expect(plugin.threadRunners.get("thread-a")).toBe(late);
    expect(plugin.threadRunners.size).toBe(1);

    const requests = await waitForRenameResponses(1);
    await vi.waitFor(() => expect(ephemeral.disposed).toBe(true), { timeout: 10_000 });

    // The rename keeps using the runner it borrowed and releases only that one: the
    // runner registered meanwhile is still there, undisposed, and was never part of
    // this cleanup.
    expect(requests[0].client).not.toBe(late.rpcClient);
    expect(childClients()).toEqual([requests[0].client]);
    expect(plugin.threadRunners.get("thread-a")).toBe(late);
    expect(plugin.threadRunners.size).toBe(1);
    expect(activity.threadRunnerRequests).toEqual([late]);
    expect(late.disposed).toBe(false);
    expect(late.rpcClient).toBeUndefined();
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(activity.disposals.map(({ client }) => client)).toEqual([requests[0].client]);
    await expectChildrenToExit();
  });

  it("reports a failing release without hiding the rename failure", async () => {
    const plugin = createRenamePlugin(["thread-a"], { renameRpcFails: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Only the borrowed runner fails to release; every other runner keeps the real
    // implementation, so teardown still works.
    const ephemeralRunner = { current: undefined };
    const originalRunnerDispose = PiRunner.prototype.dispose;
    vi.spyOn(PiRunner.prototype, "dispose").mockImplementation(function (...args) {
      if (this === ephemeralRunner.current) throw new Error("dispose boom");
      return originalRunnerDispose.apply(this, args);
    });

    expect(plugin.renameThread("thread-a", "New Title")).toBe(true);
    ephemeralRunner.current = activity.ephemeralRunners[0];

    await waitForRenameResponses(1);
    await vi.waitFor(() =>
      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        "Pi Agent: could not rename Pi session",
        "Pi Agent: could not dispose an ephemeral Pi runner"
      ])
    );

    // The original rename error is reported unchanged; the failed release is a second
    // warning that neither replaces it nor surfaces as a rejection.
    expect(findRenameWarning(warn)[1].message).toBe("Pi refused to rename the session.");
    expect(warn.mock.calls[1][1].message).toBe("dispose boom");
    expect(harness.notices).toEqual([]);
    expect(plugin.threadRunners.size).toBe(0);
    // A failing release still stops tracking the runner, so the Set cannot grow.
    expect(plugin.ephemeralRunners.size).toBe(0);
  });
});

describe("renameThread on a thread that already has a runner", () => {
  it("borrows that runner without replacing or releasing it", async () => {
    const plugin = createRenamePlugin(["thread-a"]);
    const runner = plugin.createPiRunner("thread-a");
    expect(activity.threadRunnerRequests).toEqual([runner]);
    // A freshly created runner has no client yet.
    expect(runner.rpcClient).toBeUndefined();

    expect(plugin.renameThread("thread-a", "New Title")).toBe(true);
    const requests = await waitForRenameResponses(1);

    // No ephemeral runner, no second registration: the existing runner is reused and
    // stays registered for the thread's own lifecycle to manage.
    expect(activity.ephemeralRunners).toEqual([]);
    expect(activity.threadRunnerRequests).toEqual([runner]);
    expect(plugin.threadRunners.size).toBe(1);
    expect(plugin.threadRunners.get("thread-a")).toBe(runner);
    expect(requests[0].client).toBe(runner.rpcClient);
    expect(requests[0].payload).toEqual({ name: "New Title" });
    expect(runner.disposed).toBe(false);
    expect(clientState(runner.rpcClient)).toEqual({
      disposed: false,
      running: true,
      childAlive: true
    });
    expect(spawnedChildren()).toHaveLength(1);
    // Nothing is released while the thread still owns its runner.
    expect(activity.disposals).toEqual([]);
  });

  it("sends the rename through the client that runner already owns", async () => {
    const plugin = createRenamePlugin(["thread-a"]);
    const runner = plugin.createPiRunner("thread-a");
    // The thread already ran: its runner owns a started client with a live Pi process
    // before the rename happens.
    const client = new PiRpcClient({
      piExecutablePath: process.execPath,
      cwd: process.cwd(),
      args: [PI_FIXTURE]
    });
    await client.start();
    runner.rpcClient = client;
    expect(client.generation).toBe(1);
    expect(client.running).toBe(true);

    expect(plugin.renameThread("thread-a", "New Title")).toBe(true);
    const requests = await waitForRenameResponses(1);

    expect(requests[0].client).toBe(client);
    expect(requests[0].payload).toEqual({ name: "New Title" });
    // Reused, not restarted: same generation, one process, no ephemeral runner.
    expect(client.generation).toBe(1);
    expect(childClients()).toEqual([client]);
    expect(spawnedChildren()).toHaveLength(1);
    expect(activity.ephemeralRunners).toEqual([]);
    expect(plugin.threadRunners.get("thread-a")).toBe(runner);
    expect(plugin.threadRunners.size).toBe(1);
    expect(plugin.threadRunners.get("thread-a").rpcClient).toBe(client);
    expect(clientState(client)).toEqual({ disposed: false, running: true, childAlive: true });
    expect(runner.disposed).toBe(false);
    expect(activity.disposals).toEqual([]);
  });
});

describe("renaming ten threads that have no runner", () => {
  it("keeps the registry and the machine empty of rename runners and Pi processes", async () => {
    const threadIds = Array.from({ length: 10 }, (_, index) => `thread-${index}`);
    const plugin = createRenamePlugin(threadIds);
    expect(plugin.threadRunners.size).toBe(0);

    for (const threadId of threadIds) {
      expect(plugin.renameThread(threadId, `Renamed ${threadId}`)).toBe(true);
    }

    const requests = await waitForRenameResponses(threadIds.length);
    expect(requests.map(({ payload }) => payload.name).sort()).toEqual(
      threadIds.map((threadId) => `Renamed ${threadId}`).sort()
    );
    expect(activity.threadRunnerRequests).toEqual([]);

    const runners = activity.ephemeralRunners;
    expect(runners).toHaveLength(threadIds.length);
    expect(new Set(runners).size).toBe(threadIds.length);
    await vi.waitFor(() => expect(runners.every((runner) => runner.disposed)).toBe(true), {
      timeout: 20_000
    });
    await expectChildrenToExit();

    const clients = childClients();
    expect(clients).toHaveLength(threadIds.length);
    expect(activity.disposals).toHaveLength(threadIds.length);
    // 0 -> 0: no rename leaves a runner in the registry, a client open or a process
    // alive.
    expect({
      threadRunners: plugin.threadRunners.size,
      registeredThreadIds: [...plugin.threadRunners.keys()],
      liveClients: clients.filter((client) => client.disposed === false).length,
      livePiProcesses: spawnedChildren().filter((child) => !isChildExited(child)).length
    }).toEqual({
      threadRunners: 0,
      registeredThreadIds: [],
      liveClients: 0,
      livePiProcesses: 0
    });
    expect(threadIds.every((threadId) => !plugin.threadRunners.has(threadId))).toBe(true);
    expect(runners.every((runner) => runner.rpcClient === undefined)).toBe(true);
    expect(clients.every((client) => client.disposed === true)).toBe(true);
    // The plugin tracks nothing ephemeral once every rename has settled.
    expect(plugin.ephemeralRunners.size).toBe(0);
  }, 120_000);
});

describe("renameThread and plugin unload", () => {
  /** How long unload is given to release a pending rename before it counts as a gap. */
  const UNLOAD_RELEASE_BUDGET_MS = 1_500;

  it("releases a rename runner whose request is still pending when the plugin unloads", async () => {
    const plugin = createRenamePlugin(["thread-a"], {
      piExecutablePath: createFakePiLauncher(PI_PENDING_FIXTURE)
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.ephemeralRunners.size).toBe(0);

    expect(plugin.renameThread("thread-a", "New Title")).toBe(true);

    // The child received the rename command and deliberately never answered it.
    await waitForRenameRequestSeen();
    const [runner] = activity.ephemeralRunners;
    const [spawn] = activity.spawns;
    const client = spawn.client;

    // The in-flight state this test starts from: not a thread runner, but tracked as the
    // plugin's ephemeral runner, with a real client and a live Pi process.
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.threadRunners.has("thread-a")).toBe(false);
    expect(plugin.ephemeralRunners.size).toBe(1);
    expect(plugin.ephemeralRunners.has(runner)).toBe(true);
    expect(activity.requests.map(({ type }) => type)).toEqual(["set_session_name"]);
    expect(runner.rpcClient).toBe(client);
    expect(client).toBeInstanceOf(PiRpcClient);
    expect(client.disposed).toBe(false);
    expect(client.running).toBe(true);
    expect(client.child.exitCode).toBeNull();
    expect(client.pending.size).toBe(1);
    expect(plugin.threadHistory.getThread("thread-a").title).toBe("New Title");

    const rejections = await unhandledRejectionsDuring(async () => {
      expect(() => plugin.onunload()).not.toThrow();
      expect(plugin.unloading).toBe(true);

      // Eagerly, without waiting for the 30s RPC timeout: unload released the runner it
      // tracked, which released its client and ended the pending request.
      expect(plugin.ephemeralRunners.size).toBe(0);
      expect(runner.disposed).toBe(true);
      expect(runner.rpcClient).toBeUndefined();
      expect(client.disposed).toBe(true);
      expect(plugin.threadRunners.size).toBe(0);

      // The Pi process is really gone, observed on its own exit event inside the short
      // budget rather than on the request timing out.
      expect(await waitForChildExit(spawn.child, UNLOAD_RELEASE_BUDGET_MS)).toBe(true);
      // The rename promise ended through the existing catch: the disposal is reported
      // once as a rename failure, and no failed-release warning was produced.
      await vi.waitFor(() =>
        expect(findRenameWarning(warn)?.[1]?.message).toBe("Pi RPC client disposed.")
      );
      expect(findRenameWarning(warn)?.[1]?.message).not.toBe("dispose boom");
      expect(
        warn.mock.calls.filter(
          ([message]) => message === "Pi Agent: could not dispose an ephemeral Pi runner"
        )
      ).toEqual([]);
    });

    expect(rejections).toEqual([]);
    expect(harness.notices).toEqual([]);
    expect(plugin.ephemeralRunners.size).toBe(0);

    // The race the fix has to survive: unload already released this runner, and the
    // rename `finally` (and now this explicit third call) release it again. Releasing an
    // untracked, already disposed runner is a silent no-op.
    expect(() => plugin.disposeEphemeralThreadRunner(runner)).not.toThrow();
    expect(() => plugin.disposeEphemeralThreadRunners()).not.toThrow();
    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(
      warn.mock.calls.filter(
        ([message]) => message === "Pi Agent: could not dispose an ephemeral Pi runner"
      )
    ).toEqual([]);
  }, 60_000);

  it("releases every pending rename runner when several are in flight", async () => {
    const plugin = createRenamePlugin(["thread-a", "thread-b", "thread-c"], {
      piExecutablePath: createFakePiLauncher(PI_PENDING_FIXTURE)
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const threadId of ["thread-a", "thread-b", "thread-c"]) {
      expect(plugin.renameThread(threadId, `Renamed ${threadId}`)).toBe(true);
    }
    await waitForRenameRequestSeen(3);

    const runners = activity.ephemeralRunners;
    const children = activity.spawns.map(({ child }) => child);
    expect(runners).toHaveLength(3);
    expect(plugin.ephemeralRunners.size).toBe(3);
    expect(children.every((child) => child.exitCode === null)).toBe(true);

    // One release fails: the other two must still be released.
    const failing = runners[0];
    const originalRunnerDispose = PiRunner.prototype.dispose;
    vi.spyOn(PiRunner.prototype, "dispose").mockImplementation(function (...args) {
      if (this === failing) throw new Error("dispose boom");
      return originalRunnerDispose.apply(this, args);
    });

    expect(() => plugin.onunload()).not.toThrow();

    expect(plugin.ephemeralRunners.size).toBe(0);
    expect(failing.disposed).toBe(false);
    for (const runner of runners.slice(1)) {
      expect(runner.disposed).toBe(true);
      expect(runner.rpcClient).toBeUndefined();
    }
    // The failing release was reported once, and it did not stop the others.
    expect(
      warn.mock.calls.filter(
        ([message]) => message === "Pi Agent: could not dispose an ephemeral Pi runner"
      )
    ).toHaveLength(1);
    // Only the runner whose release failed still holds a client; its process is left to
    // the test teardown, which stands in for the plugin going away for good.
    await vi.waitFor(
      () => expect(children.filter((child) => !isChildExited(child)).length).toBeLessThanOrEqual(1),
      { timeout: 5_000 }
    );
  }, 60_000);

  it("unloads without throwing, rejecting or notifying while the rename is pending", async () => {
    const plugin = createRenamePlugin(["thread-a"], {
      piExecutablePath: createFakePiLauncher(PI_PENDING_FIXTURE)
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(plugin.renameThread("thread-a", "New Title")).toBe(true);
    await waitForRenameRequestSeen();
    const client = activity.spawns[0].client;
    expect(client.pending.size).toBe(1);

    const rejections = await unhandledRejectionsDuring(async () => {
      expect(() => plugin.onunload()).not.toThrow();
      expect(plugin.unloading).toBe(true);
      // Unload settles the pending rename by disposing its client, and production
      // reports that through the one warning it has always used.
      await vi.waitFor(() =>
        expect(findRenameWarning(warn)?.[1]?.message).toBe("Pi RPC client disposed.")
      );
    });

    // No rejection escapes, and the only thing reported is the rename warning: no
    // failed-release warning, no Notice -- rename failure or otherwise.
    expect(rejections).toEqual([]);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "Pi Agent: could not rename Pi session"
    ]);
    expect(harness.notices).toEqual([]);
    expect(client.pending.size).toBe(0);
    expect(plugin.threadRunners.size).toBe(0);
    expect(plugin.ephemeralRunners.size).toBe(0);
  }, 60_000);
});
