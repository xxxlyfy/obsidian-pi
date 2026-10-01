import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Only the Obsidian runtime surface is stubbed. Every module on the measured call
// chain (thread-list-view -> PiAgentPlugin.getThreadDisplayMessageCount ->
// getCachedPiSessionMessageCount -> session-message-counter -> node:fs) is the real
// production code.
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
    Notice: ObsidianBase,
    Platform: { isDesktopApp: true },
    Plugin: ObsidianBase,
    PluginSettingTab: ObsidianBase,
    Setting: ObsidianBase,
    SuggestModal: ObsidianBase,
    TFile: ObsidianBase,
    addIcon: vi.fn(),
    getLanguage: () => "en",
    normalizePath: (value) => value,
    setIcon(element, icon) {
      element.icon = icon;
    }
  };
});

import { PiAgentPlugin } from "../src/plugin/PiAgentPlugin.mjs";
import { createPiSessionMessageCounter } from "../src/plugin/session-message-counter.mjs";
import { ThreadStore } from "../src/threads/thread-store.mjs";
import {
  formatThreadMeta,
  renderThreadList,
  renderThreadListRow,
  updateThreadListRowMeta
} from "../src/ui/thread-list-view.mjs";

const WORKSPACE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP_ROOT = path.join(WORKSPACE_ROOT, "tests", ".tmp");
const SESSION_ROOT = path.join(TMP_ROOT, "pi-sessions");

/** Large fixtures. The defaults are the batch sizes; PC_PERF_STRESS=1 adds one more. */
const LARGE_SIZES_MB = [10, 50, 100];
const STRESS_SIZE_MB = Number(process.env.PC_PERF_STRESS_SIZE_MB ?? 256);
const STRESS_ENABLED = process.env.PC_PERF_STRESS === "1";

const createdDirs = new Set();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a real JSONL session line. Only odd indices are chat messages, so half of
 * every fixture is user/assistant traffic surrounded by the session/event/summary
 * records a real Pi session file also contains.
 *
 * @param {string} id
 * @param {number} index
 * @param {number} padding Characters of filler per line; sets the fixture size.
 * @returns {string}
 */
function sessionLine(id, index, padding) {
  const timestamp = 1_760_000_000_000 + index;
  const isMessage = index % 2 === 1;
  /** @type {"session" | "event" | "summary" | "message"} */
  const type = isMessage
    ? "message"
    : index % 6 === 0
      ? "session"
      : index % 4 === 0
        ? "event"
        : "summary";

  if (type === "event") {
    return JSON.stringify({
      type,
      id: `${id}-e${index}`,
      timestamp,
      event: {
        kind: "tool_call",
        name: "read",
        path: `notes/${index}.md`,
        detail: "x".repeat(padding)
      }
    });
  }
  if (type === "summary") {
    return JSON.stringify({
      type,
      id: `${id}-s${index}`,
      timestamp,
      summary: "Compacted history".padEnd(padding, ".")
    });
  }

  const role = index % 4 === 1 ? "user" : "assistant";
  return JSON.stringify({
    type,
    id: `${id}-m${index}`,
    timestamp,
    parentId: index > 2 ? `${id}-m${index - 1}` : null,
    message: {
      role,
      provider: "anthropic",
      model: "claude-sonnet-4",
      timestamp,
      content: [
        {
          type: "text",
          text: `${role} turn ${index}: ${"lorem ipsum dolor sit amet ".repeat(2)}`.padEnd(
            140 + padding,
            "."
          )
        }
      ]
    }
  });
}

/**
 * Write a real JSONL session fixture of at least `minBytes`, with whole lines.
 *
 * @param {string} filePath
 * @param {number} minBytes
 * @param {{ padding?: number }} [options]
 * @returns {{ bytes: number, lines: number, messages: number }}
 */
function writeSessionFixture(filePath, minBytes, options = {}) {
  const id = path.basename(filePath, ".jsonl");
  const padding = options.padding ?? 200;
  const handle = fs.openSync(filePath, "w");
  const parts = [];
  let pendingBytes = 0;
  let totalBytes = 0;
  let index = 0;
  let messages = 0;
  try {
    while (totalBytes < minBytes) {
      const line = `${sessionLine(id, index, padding)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      parts.push(line);
      pendingBytes += lineBytes;
      totalBytes += lineBytes;
      if (index % 2 === 1) messages += 1;
      index += 1;
      if (pendingBytes >= 4 * 1024 * 1024) {
        fs.writeSync(handle, parts.join(""));
        parts.length = 0;
        pendingBytes = 0;
      }
    }
    if (parts.length > 0) fs.writeSync(handle, parts.join(""));
  } finally {
    fs.closeSync(handle);
  }
  return { bytes: fs.statSync(filePath).size, lines: index, messages };
}

/** A private session directory per test, so fixtures and caches never overlap. */
function createSessionDir(label) {
  const dir = path.join(SESSION_ROOT, label);
  createdDirs.add(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** One message line, for small hand-made fixtures. */
function messageLine(id, index) {
  return JSON.stringify({
    type: "message",
    id: `${id}-m${index}`,
    timestamp: 1_760_000_000_000 + index,
    message: {
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `turn ${index}`.padEnd(64, ".") }]
    }
  });
}

// ---------------------------------------------------------------------------
// Reference rule (independent of the loader)
// ---------------------------------------------------------------------------

/**
 * @param {string} line
 * @returns {boolean}
 */
function isCountedChatMessageLine(line) {
  if (!line.trim()) return false;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return false;
  }
  const message = record?.message;
  return record?.type === "message" && (message?.role === "user" || message?.role === "assistant");
}

/** Count messages in a file by streaming 4 MB blocks. */
function referenceCountFile(filePath) {
  const handle = fs.openSync(filePath, "r");
  try {
    const block = Buffer.allocUnsafe(4 * 1024 * 1024);
    let count = 0;
    let tail = "";
    for (;;) {
      const read = fs.readSync(handle, block, 0, block.length, null);
      if (read === 0) break;
      const lines = (tail + block.toString("utf8", 0, read)).split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) {
        if (isCountedChatMessageLine(line)) count += 1;
      }
    }
    if (tail.trim() && isCountedChatMessageLine(tail)) count += 1;
    return count;
  } finally {
    fs.closeSync(handle);
  }
}

// ---------------------------------------------------------------------------
// View / plugin harness
// ---------------------------------------------------------------------------

/** Minimal element double for the view's DOM surface. */
class FakeElement {
  constructor(tag = "div", options = {}) {
    this.tag = tag;
    this.cls = options.cls ?? "";
    this.text = options.text ?? "";
    this.attr = options.attr ?? {};
    this.children = [];
    this.listeners = new Map();
    this.icon = undefined;
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

  empty() {
    this.children.length = 0;
    this.text = "";
    return this;
  }

  addClass(name) {
    this.cls = this.cls ? `${this.cls} ${name}` : name;
    return this;
  }

  setText(value) {
    this.text = value ?? "";
    return this;
  }

  setAttr(name, value) {
    this.attr[name] = value;
    return this;
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
    return this;
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

/** Count file reads on the real `node:fs` default export the production code imports. */
function installReadInstrumentation() {
  const originalReadFileSync = fs.readFileSync;
  const originalExistsSync = fs.existsSync;
  const stats = {
    readCalls: 0,
    bytesRead: 0,
    existsCalls: 0,
    perPath: new Map(),
    readsSinceReset: 0,
    bytesSinceReset: 0
  };
  fs.readFileSync = function instrumentedReadFileSync(file, ...rest) {
    const key = String(file);
    const size = fs.statSync(key).size;
    stats.readCalls += 1;
    stats.bytesRead += size;
    stats.readsSinceReset += 1;
    stats.bytesSinceReset += size;
    stats.perPath.set(key, (stats.perPath.get(key) ?? 0) + 1);
    return originalReadFileSync.call(fs, file, ...rest);
  };
  fs.existsSync = function instrumentedExistsSync(file) {
    stats.existsCalls += 1;
    return originalExistsSync.call(fs, file);
  };
  return {
    stats,
    reset() {
      stats.readsSinceReset = 0;
      stats.bytesSinceReset = 0;
      stats.perPath.clear();
    },
    restore() {
      fs.readFileSync = originalReadFileSync;
      fs.existsSync = originalExistsSync;
    }
  };
}

/**
 * Count the read streams the streaming scanner opens.
 *
 * A scan run is not the same as a file open: the counter can join an in-flight scan
 * of the same path, so counting opens is what proves a session file was really read
 * once. Wraps the real constructor, so the streams are the production ones.
 *
 * @returns {{ opens: number, byPath: Map<string, number>, restore: () => void }}
 */
function installStreamInstrumentation() {
  const original = fs.createReadStream;
  const state = { opens: 0, byPath: new Map() };
  fs.createReadStream = function instrumentedCreateReadStream(file, ...rest) {
    const key = String(file);
    state.opens += 1;
    state.byPath.set(key, (state.byPath.get(key) ?? 0) + 1);
    return original.call(fs, file, ...rest);
  };
  return {
    opens: () => state.opens,
    byPath: () => new Map(state.byPath),
    restore() {
      fs.createReadStream = original;
    }
  };
}

/** PiRunner's own session-path resolution, without spawning a Pi process. */
function createPathResolver(sessionDir) {
  return {
    resolveSessionPath(sessionReference) {
      if (!sessionReference) return undefined;
      const resolved = path.isAbsolute(sessionReference)
        ? path.resolve(sessionReference)
        : path.resolve(sessionDir, sessionReference);
      const relative = path.relative(sessionDir, resolved);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) return undefined;
      return resolved;
    }
  };
}

/** How many session scans the plugin's scanner has actually run. */
function scanRuns(plugin) {
  return plugin.piSessionMessageCounter.scanCount();
}

/**
 * Count every scan the stub's counter starts.
 *
 * The plugin reaches the scanner through `this.piSessionMessageCounter.scan(...)`, so
 * the counter's own method is the boundary a test has to observe; wrapping the stub
 * instead would count nothing.
 *
 * @param {any} plugin
 * @param {any} counter
 */
function instrumentCounterScan(plugin, counter) {
  const realScan = counter.scan.bind(counter);
  const instrument = (wrap) => {
    counter.scan = (sessionPath) => wrap(sessionPath, realScan);
  };
  instrument((sessionPath, nextScan) => {
    plugin.scanCount += 1;
    return nextScan(sessionPath);
  });
  return instrument;
}

/**
 * The real plugin statistics methods over a real ThreadStore, plus the real session
 * scanner. Only the fields the measured chain touches are supplied.
 *
 * @param {object} history Sanitized thread history, as persisted by the plugin.
 * @param {object} pi Session path resolver.
 * @param {{ concurrency?: number }} [options]
 */
function createPluginStub(history, pi, options = {}) {
  const store = new ThreadStore(history);
  const counter = createPiSessionMessageCounter({ concurrency: options.concurrency ?? 2 });
  /** @type {any} */
  const plugin = {
    pi,
    app: {},
    piSessionMessageCounter: counter,
    sessionMessageCountCache: new Map(),
    sessionMessageCountRefreshes: new Map(),
    threadListRenderGeneration: 0,
    /** Scans started, observed at the counter boundary. */
    scanCount: 0,
    get threadHistory() {
      return store;
    },
    listThreads(threadOptions) {
      return PiAgentPlugin.prototype.listThreads.call(this, threadOptions);
    },
    getCurrentThread() {
      return PiAgentPlugin.prototype.getCurrentThread.call(this);
    },
    getThreadDisplayMessageCount(thread) {
      return PiAgentPlugin.prototype.getThreadDisplayMessageCount.call(this, thread);
    },
    getCachedPiSessionMessageCount(thread) {
      return PiAgentPlugin.prototype.getCachedPiSessionMessageCount.call(this, thread);
    },
    countPiSessionChatMessages(piSessionId) {
      return PiAgentPlugin.prototype.countPiSessionChatMessages.call(this, piSessionId);
    },
    isSessionMessageCountCacheFresh(sessionPath) {
      return PiAgentPlugin.prototype.isSessionMessageCountCacheFresh.call(this, sessionPath);
    },
    getPiSessionMessageCount(sessionPath) {
      return PiAgentPlugin.prototype.getPiSessionMessageCount.call(this, sessionPath);
    },
    refreshPiSessionMessageCount(sessionPath) {
      return PiAgentPlugin.prototype.refreshPiSessionMessageCount.call(this, sessionPath);
    },
    refreshThreadListSessionCounts(threads, generation, onCount) {
      return PiAgentPlugin.prototype.refreshThreadListSessionCounts.call(
        this,
        threads,
        generation,
        onCount
      );
    }
  };
  plugin.instrumentScan = instrumentCounterScan(plugin, counter);
  return plugin;
}

/** The real thread-list view surface, with `renderThreadList` bound to it. */
function createViewContext(plugin) {
  const view = {
    plugin,
    containerEl: { children: [new FakeElement("div"), new FakeElement("div")] },
    suggestions: undefined,
    state: { activeRuns: new Map() },
    showingThreadList: true,
    threadListRenderGeneration: 0,
    threadListRows: new Map(),
    isThreadRunning(threadId) {
      return this.state.activeRuns.has(threadId);
    },
    isCurrentThread(threadId) {
      return this.plugin.getCurrentThread()?.id === threadId;
    },
    cleanupComposerBarObserver() {},
    renderChatView() {},
    renderThreadList,
    renderThreadListRow,
    formatThreadMeta,
    updateThreadListRowMeta,
    // Locale-independent so the meta text is stable across machines.
    formatThreadDate() {
      return "1970-01-01 00:00";
    }
  };
  return view;
}

/**
 * Render through the real `renderThreadList`, then mirror the generation the view
 * claimed onto the plugin.
 *
 * `renderThreadList()` itself owns the generation counter (it bumps it on every
 * render), so the helper must not bump it again; the plugin only reads the value.
 */
function render(view) {
  view.renderThreadList.call(view);
  view.plugin.threadListRenderGeneration = view.threadListRenderGeneration;
}

/**
 * Render and snapshot the painted meta text before yielding.
 *
 * The background scan starts in a microtask, so anything that awaits between the
 * render and the assertion can already have repainted the row. Every assertion about
 * the *initial* text therefore reads a snapshot taken inside the synchronous call.
 *
 * @param {any} view
 * @returns {Promise<{ snapshot: string[], elapsedMs: number, maxGapMs: number, ticks: number }>}
 */
async function renderAndSnapshot(view) {
  let snapshot = [];
  const measured = await measureEventLoopBlocking(() => {
    render(view);
    snapshot = rowMetaTexts(view);
  });
  return { snapshot, ...measured };
}

/** The meta elements of the currently rendered rows, in order. */
function rowMetaTexts(view) {
  const list = view.containerEl.children[1].children.find(
    (child) => child.cls === "pi-agent-thread-list"
  );
  return list.children.map((row) => row.children[0].children[1].text);
}

function rowMetaText(view, index) {
  return rowMetaTexts(view)[index];
}

/** Wait until every thread has a cached session count, then assert the values. */
async function waitForCachedCounts(plugin, threads, timeoutMs = 120_000) {
  const settled = await waitFor(
    () =>
      plugin.sessionMessageCountRefreshes.size === 0 &&
      !plugin.piSessionMessageCounter.isScanning(),
    timeoutMs
  );
  expect(settled, "background session counts did not settle").toBe(true);
  return threads.map((thread) => plugin.getCachedPiSessionMessageCount(thread));
}

/**
 * @param {(index: number) => { piSessionId?: string, messages: number }} spec
 */
function createThreads(prefix, count, spec) {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => {
    const { piSessionId, messages } = spec(index);
    return {
      id: `${prefix}-${index}`,
      title: `${prefix} thread ${index}`,
      createdAt: now - count + index,
      updatedAt: now - (count - index),
      archived: false,
      favorite: false,
      piSessionId,
      messages: Array.from({ length: messages }, (_, messageIndex) => ({
        role: messageIndex % 2 === 0 ? "user" : "assistant",
        content: `plugin message ${messageIndex}`,
        createdAt: now - count + index + messageIndex
      }))
    };
  });
}

/**
 * Hold the next `count` scanner reads open until released.
 *
 * The generation guard only matters while a scan is genuinely in flight, so the test
 * needs control over when it finishes instead of guessing from fixture size.
 *
 * @param {number} count Number of reads to hold.
 * @returns {{ blocked: () => boolean, release: () => void }}
 */
function createScanGate(count) {
  let blocked = 0;
  let started = 0;
  let release;
  const released = new Promise((resolve) => {
    release = () => resolve();
  });
  const gate = {
    blocked: () => blocked > 0,
    waitForStart: async (timeoutMs = 10_000) => {
      await waitFor(() => started > 0, timeoutMs);
      return started > 0;
    },
    release: () => release(),
    async run(read) {
      if (started >= count) return read();
      started += 1;
      blocked += 1;
      try {
        await released;
      } finally {
        blocked -= 1;
      }
      return read();
    }
  };
  return gate;
}

/** Wait until `check` is true, with a hard bound so a hung refresh fails fast. */
async function waitFor(check, timeoutMs = 10_000) {
  const deadline = globalThis.performance.now() + timeoutMs;
  while (globalThis.performance.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
  }
  return check();
}

/**
 * Measure the largest gap between event-loop timer callbacks across `run`.
 *
 * `run` may be synchronous (the render) or asynchronous (an idle baseline that
 * yields), which is what makes the comparison meaningful.
 *
 * @param {() => unknown | Promise<unknown>} run
 */
async function measureEventLoopBlocking(run) {
  const intervalMs = 10;
  const fires = [];
  const timer = globalThis.setInterval(() => {
    fires.push(globalThis.performance.now());
  }, intervalMs);
  const startedAt = globalThis.performance.now();
  try {
    await run();
  } finally {
    globalThis.clearInterval(timer);
  }
  const elapsedMs = globalThis.performance.now() - startedAt;
  const ticks = fires.length;
  const firstTickGapMs = ticks > 0 ? fires[0] - startedAt : elapsedMs;
  const tickGaps = fires.slice(1).map((fire, index) => fire - fires[index]);
  const maxGapMs = Math.max(firstTickGapMs, ...tickGaps);
  return { elapsedMs, maxGapMs, ticks, intervalMs };
}

/** Longest synchronous slice of the async background scan, measured from the host. */
async function measureScanResponsiveness(job) {
  let maxSliceMs = 0;
  let idle = globalThis.performance.now();
  const timer = globalThis.setInterval(() => {
    maxSliceMs = Math.max(maxSliceMs, globalThis.performance.now() - idle);
    idle = globalThis.performance.now();
  }, 10);
  const startedAt = globalThis.performance.now();
  try {
    await job;
  } finally {
    globalThis.clearInterval(timer);
  }
  maxSliceMs = Math.max(maxSliceMs, globalThis.performance.now() - idle);
  return { elapsedMs: globalThis.performance.now() - startedAt, maxSliceMs };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const work = {
  fixture: undefined,
  /** @type {Array<{ label: string, path: string, bytes: number, messages: number, lines: number }>} */
  large: []
};

beforeAll(() => {
  fs.mkdirSync(SESSION_ROOT, { recursive: true });
  work.fixture = installReadInstrumentation();

  const dir = createSessionDir("large");
  const sizes = STRESS_ENABLED ? [...LARGE_SIZES_MB, STRESS_SIZE_MB] : LARGE_SIZES_MB;
  for (const sizeMb of sizes) {
    const filePath = path.join(dir, `large-${sizeMb}mb.jsonl`);
    const written = writeSessionFixture(filePath, sizeMb * 1024 * 1024);
    // The fixture must be parseable exactly as the counting rule reads it, and the
    // independent streaming reference must agree, so the measured cost is real.
    expect(referenceCountFile(filePath)).toBe(written.messages);
    expect(written.messages).toBeGreaterThan(0);
    work.large.push({
      label: `${sizeMb} MB`,
      path: filePath,
      bytes: written.bytes,
      messages: written.messages,
      lines: written.lines
    });
  }
}, 300_000);

afterAll(() => {
  work.fixture?.restore();
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
  // `rmSync` leaves the now-empty parents behind, so remove them explicitly: the test
  // must not leave any artifact in the repository.
  for (const dir of [SESSION_ROOT, TMP_ROOT]) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// A. First render must not read session files synchronously
// ---------------------------------------------------------------------------

describe("first render stays synchronous and read-free", () => {
  it("A: renderThreadList creates every row without one synchronous session read", async () => {
    const dir = createSessionDir("a-basic");
    const sessionPath = path.join(dir, "session.jsonl");
    writeSessionFixture(sessionPath, 256 * 1024);
    const threads = createThreads("a", 12, (index) => ({
      piSessionId: "session.jsonl",
      messages: 3 + index
    }));

    const plugin = createPluginStub(
      { currentThreadId: threads[0].id, threads },
      createPathResolver(dir)
    );
    const view = createViewContext(plugin);

    work.fixture.reset();
    const { snapshot, elapsedMs, maxGapMs } = await renderAndSnapshot(view);

    // The whole point of the batch: painting the list reads nothing.
    expect(work.fixture.stats.readsSinceReset).toBe(0);
    expect(work.fixture.stats.bytesSinceReset).toBe(0);
    expect(snapshot).toHaveLength(12);
    // Rows are painted newest-first, so the newest thread (index 11, 14 messages)
    // leads and the oldest (index 0, 3 messages) trails. Every row already shows a
    // usable initial value from thread.messages.
    expect(snapshot[0]).toContain("14 messages");
    expect(snapshot[11]).toContain("3 messages");
    // No DOM repaint can have happened yet: the scan starts in a microtask.
    expect(scanRuns(plugin)).toBe(0);
    expect(elapsedMs).toBeLessThan(100);
    expect(maxGapMs).toBeLessThan(100);

    // The background scan then supplies the real count and repaints in place.
    const expected = referenceCountFile(sessionPath);
    expect(expected).toBeGreaterThan(14);
    expect(await waitForCachedCounts(plugin, threads)).toEqual(threads.map(() => expected));
    expect(await waitFor(() => rowMetaText(view, 0).includes(`${expected} messages`))).toBe(true);
    for (const text of rowMetaTexts(view)) {
      expect(text).toContain(`${expected} messages`);
    }
    expect(scanRuns(plugin)).toBe(1);

    console.log(
      `[A] first render: ${elapsedMs.toFixed(2)} ms, 0 synchronous reads, 12 rows; ` +
        `background scan reported ${expected} messages for all 12 rows with 1 scan`
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------
// B. Background refresh reaches the real count
// ---------------------------------------------------------------------------

describe("background refresh", () => {
  it("B: the initial thread.messages fallback is replaced by the real Pi session count", async () => {
    const dir = createSessionDir("b-refresh");
    const sessionPath = path.join(dir, "session.jsonl");
    const fixture = writeSessionFixture(sessionPath, 512 * 1024);
    const expected = referenceCountFile(sessionPath);
    expect(expected).toBeGreaterThan(50);
    expect(fixture.messages).toBe(expected);

    const threads = [
      { ...createThreads("b", 1, () => ({ piSessionId: "session.jsonl", messages: 7 }))[0] }
    ];
    const plugin = createPluginStub(
      { currentThreadId: threads[0].id, threads },
      createPathResolver(dir)
    );
    const view = createViewContext(plugin);

    const { snapshot } = await renderAndSnapshot(view);
    // Before the background scan finishes the row shows the thread's own count.
    expect(snapshot[0]).toContain("7 messages");

    expect(await waitFor(() => rowMetaText(view, 0).includes(`${expected} messages`))).toBe(true);
    expect(plugin.getCachedPiSessionMessageCount(threads[0])).toBe(expected);
    expect(plugin.getThreadDisplayMessageCount(threads[0])).toBe(expected);
    expect(work.fixture.stats.readsSinceReset).toBe(0);

    // The plugin's synchronous reader still agrees with the scanner: only the timing
    // changed, not the counting semantics.
    expect(plugin.countPiSessionChatMessages("session.jsonl")).toBe(expected);

    console.log(`[B] meta went 7 -> ${expected} messages; sync reader and streaming scanner agree`);
  }, 120_000);

  it("B2: counting semantics are unchanged for mixed, damaged and missing files", async () => {
    const dir = createSessionDir("b-semantics");
    const mixedPath = path.join(dir, "mixed.jsonl");
    const crlfPath = path.join(dir, "crlf.jsonl");
    const damagedPath = path.join(dir, "damaged.jsonl");

    const lines = [];
    for (let index = 0; index < 3_000; index += 1) {
      if (index % 9 === 0) lines.push(`{not json ${index}`);
      else if (index % 7 === 0) lines.push(JSON.stringify({ type: "event", id: `e${index}` }));
      else if (index % 11 === 0) lines.push("");
      else lines.push(messageLine("mixed", index));
    }
    fs.writeFileSync(mixedPath, `${lines.join("\n")}\n`);
    fs.writeFileSync(crlfPath, `${lines.join("\r\n")}\r\n`);
    // A truncated file with an unparsable tail must not throw or lose earlier lines.
    fs.writeFileSync(
      damagedPath,
      `${[0, 1, 2, 3, 4].map((i) => messageLine("d", i)).join("\n")}\n{"type":"mess`
    );

    const threads = createThreads("b2", 4, (index) => ({
      piSessionId: ["mixed.jsonl", "crlf.jsonl", "damaged.jsonl", "missing.jsonl"][index],
      messages: 2
    }));
    const plugin = createPluginStub(
      { currentThreadId: threads[0].id, threads },
      createPathResolver(dir)
    );
    const view = createViewContext(plugin);

    const { snapshot } = await renderAndSnapshot(view);
    // Every row starts from its own fallback while the scans run.
    expect(snapshot).toHaveLength(4);

    // mixed: same rule as a CRLF file; damaged: the good lines still count.
    const mixedCount = referenceCountFile(mixedPath);
    const crlfCount = referenceCountFile(crlfPath);
    const damagedCount = referenceCountFile(damagedPath);
    expect(await waitForCachedCounts(plugin, threads)).toEqual([
      mixedCount,
      crlfCount,
      damagedCount,
      0
    ]);
    // A missing file is 0, never a throw, so the thread falls back to its own count.
    expect(plugin.getThreadDisplayMessageCount(threads[3])).toBe(2);

    // Rows paint newest-first, so the missing session (index 3) is row 0.
    expect(await waitFor(() => rowMetaText(view, 0).includes("2 messages"))).toBe(true);
    expect(rowMetaText(view, 1)).toContain(`${damagedCount} messages`);
    expect(rowMetaText(view, 2)).toContain(`${crlfCount} messages`);
    expect(rowMetaText(view, 3)).toContain(`${mixedCount} messages`);

    console.log(
      `[B2] mixed ${mixedCount}, crlf ${crlfCount}, damaged ${damagedCount}, ` +
        `missing 0 (fallback 2); no throw`
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------
// C / D. Cache hits and invalidation
// ---------------------------------------------------------------------------

describe("session count cache", () => {
  it("C: a later render serves the cached count without re-reading the session", async () => {
    const dir = createSessionDir("c-cache");
    const sessionPath = path.join(dir, "session.jsonl");
    writeSessionFixture(sessionPath, 256 * 1024);
    const expected = referenceCountFile(sessionPath);

    const threads = createThreads("c", 8, () => ({ piSessionId: "session.jsonl", messages: 4 }));
    const plugin = createPluginStub(
      { currentThreadId: threads[0].id, threads },
      createPathResolver(dir)
    );
    const view = createViewContext(plugin);

    const { snapshot, elapsedMs } = await renderAndSnapshot(view);
    // Cache is cold: the first paint is the thread.messages fallback.
    expect(snapshot[0]).toContain("4 messages");
    // Warm the cache, then a later render is a pure cache hit.
    expect(await waitForCachedCounts(plugin, threads)).toEqual(threads.map(() => expected));

    const scansAfterFirst = scanRuns(plugin);
    work.fixture.reset();
    const { snapshot: secondSnapshot, elapsedMs: secondElapsedMs } = await renderAndSnapshot(view);
    // Let any refresh the second render scheduled actually run before counting scans.
    await waitForCachedCounts(plugin, threads);

    // The cached count is on screen in the same synchronous paint, and nothing was
    // read or scanned again.
    expect(secondSnapshot[0]).toContain(`${expected} messages`);
    expect(work.fixture.stats.readsSinceReset).toBe(0);
    expect(scanRuns(plugin)).toBe(scansAfterFirst);
    expect(secondElapsedMs).toBeLessThan(100);

    console.log(
      `[C] cold render ${elapsedMs.toFixed(2)} ms, second render ` +
        `${secondElapsedMs.toFixed(2)} ms with 0 reads and 0 new scans, ` +
        `${expected} messages served from cache into the same paint`
    );
  }, 120_000);

  it("D: a changed session file invalidates its cache entry and repaints that row", async () => {
    const dir = createSessionDir("d-invalid");
    const changedPath = path.join(dir, "changed.jsonl");
    const stablePath = path.join(dir, "stable.jsonl");
    writeSessionFixture(changedPath, 128 * 1024);
    writeSessionFixture(stablePath, 128 * 1024);
    const firstChangedCount = referenceCountFile(changedPath);
    const stableCount = referenceCountFile(stablePath);

    const threads = createThreads("d", 2, (index) => ({
      piSessionId: index === 0 ? "changed.jsonl" : "stable.jsonl",
      // Distinct fallbacks make it unambiguous which row was repainted with what.
      messages: index === 0 ? 3 : 4
    }));
    const plugin = createPluginStub(
      { currentThreadId: threads[0].id, threads },
      createPathResolver(dir)
    );
    const view = createViewContext(plugin);

    const { snapshot } = await renderAndSnapshot(view);
    // Rows paint newest-first: thread 1 (stable, 4 messages) then thread 0 (changed, 3).
    expect(snapshot[0]).toContain("4 messages");
    expect(snapshot[1]).toContain("3 messages");
    // Warm both cache entries before testing invalidation.
    expect(await waitForCachedCounts(plugin, threads)).toEqual([firstChangedCount, stableCount]);
    const scansAfterFirst = scanRuns(plugin);

    // Append more messages to one file: its size and mtime both move. The other file
    // is untouched, so only one cache entry may be considered stale.
    const additions = Array.from({ length: 40 }, (_, index) =>
      messageLine("appended", 10_000 + index)
    );
    fs.appendFileSync(changedPath, `${additions.join("\n")}\n`);
    const secondCount = referenceCountFile(changedPath);
    expect(secondCount).toBe(firstChangedCount + 40);
    expect(plugin.isSessionMessageCountCacheFresh(changedPath)).toBe(false);
    expect(plugin.isSessionMessageCountCacheFresh(stablePath)).toBe(true);

    // The stale count is rejected: neither render may honour a count for a revision
    // that is no longer on disk, and the changed row ends up showing the new count.
    const { snapshot: secondSnapshot } = await renderAndSnapshot(view);
    expect(secondSnapshot[0]).toContain(`${stableCount} messages`);

    expect(await waitForCachedCounts(plugin, threads)).toEqual([secondCount, stableCount]);
    expect(scanRuns(plugin)).toBe(scansAfterFirst + 1);
    expect(plugin.isSessionMessageCountCacheFresh(changedPath)).toBe(true);
    expect(plugin.getCachedPiSessionMessageCount(threads[0])).toBe(secondCount);
    expect(plugin.getCachedPiSessionMessageCount(threads[1])).toBe(stableCount);
    // The row now shows the new count; the untouched session kept its cached one.
    expect(await waitFor(() => rowMetaText(view, 1).includes(`${secondCount} messages`))).toBe(
      true
    );
    expect(rowMetaText(view, 0)).toContain(`${stableCount} messages`);

    // A stale entry with the wrong size is rejected outright.
    plugin.sessionMessageCountCache.set(changedPath, {
      size: 1,
      mtimeMs: 1,
      count: 999,
      fileKnown: true,
      scanKnown: true
    });
    expect(plugin.isSessionMessageCountCacheFresh(changedPath)).toBe(false);

    console.log(
      `[D] one changed session invalidated: ${firstChangedCount} -> ${secondCount} messages with ` +
        `1 re-scan; the untouched session stayed cached at ${stableCount}`
    );
  }, 120_000);

  it("D2: a same-size mtime change is enough to invalidate the cache", async () => {
    const dir = createSessionDir("d-mtime");
    const sessionPath = path.join(dir, "session.jsonl");
    writeSessionFixture(sessionPath, 64 * 1024);

    const plugin = createPluginStub(
      { currentThreadId: "none", threads: [] },
      createPathResolver(dir)
    );
    const count = await plugin.getPiSessionMessageCount(sessionPath);
    expect(plugin.isSessionMessageCountCacheFresh(sessionPath)).toBe(true);

    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(sessionPath, future, future);
    const after = fs.statSync(sessionPath);
    expect(after.size).toBe(fs.statSync(sessionPath).size);
    expect(plugin.isSessionMessageCountCacheFresh(sessionPath)).toBe(false);

    // A refresh re-scans and re-caches against the new mtime, same count.
    expect(await plugin.getPiSessionMessageCount(sessionPath)).toBe(count);
    expect(plugin.isSessionMessageCountCacheFresh(sessionPath)).toBe(true);

    console.log("[D2] mtime-only change invalidated the cache and forced exactly one re-scan");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// E. One session file, many threads
// ---------------------------------------------------------------------------

describe("shared session files", () => {
  it("E: five threads on one session path cause exactly one scan and one count", async () => {
    const dir = createSessionDir("e-shared");
    const sessionPath = path.join(dir, "shared.jsonl");
    writeSessionFixture(sessionPath, 512 * 1024);
    const expected = referenceCountFile(sessionPath);

    const threads = createThreads("e", 5, () => ({
      piSessionId: "shared.jsonl",
      messages: 2
    }));
    const plugin = createPluginStub(
      { currentThreadId: threads[0].id, threads },
      createPathResolver(dir)
    );
    const view = createViewContext(plugin);

    const streams = installStreamInstrumentation();
    let snapshot;
    try {
      ({ snapshot } = await renderAndSnapshot(view));
      expect(snapshot[4]).toContain("2 messages");
      expect(await waitForCachedCounts(plugin, threads)).toEqual(threads.map(() => expected));
    } finally {
      streams.restore();
    }
    expect(await waitFor(() => rowMetaText(view, 4).includes(`${expected} messages`))).toBe(true);

    // All five rows share the count, and the session file was opened exactly once.
    expect(scanRuns(plugin)).toBe(1);
    expect(streams.opens()).toBe(1);
    expect([...streams.byPath().values()]).toEqual([1]);
    expect(plugin.sessionMessageCountCache.size).toBe(1);
    for (const text of rowMetaTexts(view)) {
      expect(text).toContain(`${expected} messages`);
    }

    console.log(
      `[E] 5 threads -> 1 scan and 1 file open (${expected} messages shared by all 5 rows), ` +
        `cache holds 1 entry`
    );
  }, 120_000);

  it("E2: the scanner runs at most `concurrency` scans at once across many sessions", async () => {
    let active = 0;
    let peak = 0;
    const counter = createPiSessionMessageCounter({
      concurrency: 2,
      readSession: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
        active -= 1;
        return 1;
      }
    });

    const paths = Array.from({ length: 9 }, (_, index) => path.join(SESSION_ROOT, `cap-${index}`));
    const counts = await Promise.all(paths.map((sessionPath) => counter.scan(sessionPath)));
    expect(counts).toEqual(Array.from({ length: 9 }, () => 1));
    expect(counter.pendingCount()).toBe(0);
    expect(peak).toBe(2);
    expect(counter.scanCount()).toBe(9);

    // The same path joins the running scan instead of opening a second one.
    const deduped = createPiSessionMessageCounter({ concurrency: 2, readSession: async () => 5 });
    const results = await Promise.all(Array.from({ length: 6 }, () => deduped.scan(paths[0])));
    expect(results).toEqual(Array.from({ length: 6 }, () => 5));
    expect(deduped.scanCount()).toBe(1);

    console.log(`[E2] concurrency cap 2 honoured (peak ${peak}), 6 requests -> 1 scan per path`);
  }, 60_000);

  it("E3: concurrent refreshes of one session path share a single refresh", async () => {
    const dir = createSessionDir("e3-singleflight");
    const sessionPath = path.join(dir, "shared.jsonl");
    writeSessionFixture(sessionPath, 128 * 1024);
    const expected = referenceCountFile(sessionPath);

    const plugin = createPluginStub(
      { currentThreadId: "none", threads: [] },
      createPathResolver(dir)
    );

    // Hold the read open so every caller below arrives while the refresh is in flight.
    const gate = createScanGate(1);
    plugin.instrumentScan((path, scan) => gate.run(() => scan(path)));

    const first = plugin.getPiSessionMessageCount(sessionPath);
    const second = plugin.getPiSessionMessageCount(sessionPath);
    expect(await gate.waitForStart()).toBe(true);
    const third = plugin.getPiSessionMessageCount(sessionPath);

    // One in-flight refresh, handed to every caller: identity, not just equal values.
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(plugin.sessionMessageCountRefreshes.size).toBe(1);
    expect(plugin.sessionMessageCountRefreshes.get(sessionPath)).toBe(first);

    gate.release();
    expect(await Promise.all([first, second, third])).toEqual([expected, expected, expected]);
    // The entry is released once it settles, so a later ask starts a fresh lookup.
    expect(plugin.sessionMessageCountRefreshes.size).toBe(0);
    expect(plugin.getPiSessionMessageCount(sessionPath)).not.toBe(first);
    expect(await plugin.getPiSessionMessageCount(sessionPath)).toBe(expected);
    expect(scanRuns(plugin)).toBe(1);

    console.log(
      `[E3] 3 concurrent refreshes -> 1 shared promise, 1 scan, 1 file open (${expected} messages)`
    );
  }, 60_000);
});

// ---------------------------------------------------------------------------
// F. Stale results must not touch a newer render
// ---------------------------------------------------------------------------

describe("render generation guard", () => {
  it("F: a count from an abandoned render cannot repaint the live list", async () => {
    const dir = createSessionDir("f-generation");
    // Two different session files, so the stale and live scans are independent and
    // the test can choose which one finishes last.
    const stalePath = path.join(dir, "stale.jsonl");
    const livePath = path.join(dir, "live.jsonl");
    writeSessionFixture(stalePath, 128 * 1024);
    writeSessionFixture(livePath, 128 * 1024);
    const staleCount = referenceCountFile(stalePath);
    expect(staleCount).toBeGreaterThan(10);

    const renderAThreads = createThreads("f", 1, () => ({
      piSessionId: "stale.jsonl",
      messages: 4
    }));
    const plugin = createPluginStub(
      { currentThreadId: renderAThreads[0].id, threads: renderAThreads },
      createPathResolver(dir)
    );
    const view = createViewContext(plugin);

    // Both scans are gated so the abandoned one can be made to finish last -- that is
    // the only ordering in which a missing guard becomes visible.
    const staleGate = createScanGate(1);
    const liveGate = createScanGate(1);
    let scans = 0;
    plugin.instrumentScan((sessionPath, scan) => {
      scans += 1;
      const gate = sessionPath === stalePath ? staleGate : liveGate;
      return gate.run(() => scan(sessionPath));
    });

    const { snapshot: firstSnapshot } = await renderAndSnapshot(view);
    const firstGeneration = view.threadListRenderGeneration;
    expect(firstSnapshot[0]).toContain("4 messages");
    expect(await staleGate.waitForStart()).toBe(true);

    // The live render points at the other session file and gives the same thread 200
    // messages, so a stale repaint would replace a correct 200 with a wrong number.
    plugin.threadHistory.history.threads = renderAThreads.map((thread) => ({
      ...thread,
      piSessionId: "live.jsonl",
      messages: Array.from({ length: 200 }, (_, index) => ({
        role: index % 2 ? "user" : "assistant",
        content: "x",
        createdAt: thread.createdAt + index
      }))
    }));
    const { snapshot: secondSnapshot } = await renderAndSnapshot(view);

    expect(view.threadListRenderGeneration).toBe(firstGeneration + 1);
    expect(plugin.threadListRenderGeneration).toBe(firstGeneration + 1);
    expect(secondSnapshot[0]).toContain("200 messages");
    expect(staleGate.blocked()).toBe(true);
    expect(await liveGate.waitForStart()).toBe(true);

    // The live scan resolves first and paints the current revision...
    liveGate.release();
    expect(await waitFor(() => rowMetaText(view, 0).includes("200 messages"))).toBe(true);

    // ...and only then does the abandoned scan resolve. Its count belongs to the
    // generation that no longer owns the list, so it must not repaint this row.
    staleGate.release();
    await waitForCachedCounts(plugin, plugin.listThreads({ includeArchived: true }));
    expect(rowMetaText(view, 0)).toContain("200 messages");
    expect(rowMetaText(view, 0)).not.toContain("4 messages");
    // The abandoned scan still filled the cache: the cache is keyed by session path,
    // which does not depend on the render.
    expect(plugin.getCachedPiSessionMessageCount({ piSessionId: "stale.jsonl" })).toBe(staleCount);
    expect(scans).toBe(2);

    console.log(
      `[F] the abandoned generation-${firstGeneration} count (${staleCount} messages) finished ` +
        `last and painted nothing; the live row kept its own 200 messages`
    );
  }, 120_000);

  it("F2: the row update refuses a result from a render that is no longer current", async () => {
    const dir = createSessionDir("f-stale-row");
    const sessionPath = path.join(dir, "session.jsonl");
    writeSessionFixture(sessionPath, 64 * 1024);

    const threads = createThreads("f2r", 1, () => ({ piSessionId: "session.jsonl", messages: 4 }));
    const plugin = createPluginStub(
      { currentThreadId: threads[0].id, threads },
      createPathResolver(dir)
    );
    const view = createViewContext(plugin);

    const { snapshot } = await renderAndSnapshot(view);
    expect(snapshot[0]).toContain("4 messages");
    const liveGeneration = view.threadListRenderGeneration;
    const before = rowMetaText(view, 0);
    const thread = plugin.listThreads()[0];

    // A result carrying an older generation must not touch the row, even though the
    // row it names is still on screen and the thread is still the rendered thread.
    view.updateThreadListRowMeta.call(view, thread, 9999, liveGeneration - 1);
    expect(rowMetaText(view, 0)).toBe(before);
    view.updateThreadListRowMeta.call(view, thread, 9999, liveGeneration + 1);
    expect(rowMetaText(view, 0)).toBe(before);

    // The current generation may repaint it, so the guard is not simply blocking.
    view.updateThreadListRowMeta.call(view, thread, 4242, liveGeneration);
    expect(rowMetaText(view, 0)).toContain("4242 messages");
    expect(rowMetaText(view, 0)).not.toBe(before);

    console.log(
      `[F2] stale generations (${liveGeneration - 1}, ${liveGeneration + 1}) left the row at ` +
        `"${before}"; only the live generation ${liveGeneration} repainted it`
    );
  }, 120_000);

  it("F3: leaving the thread list stops background results from painting", async () => {
    const dir = createSessionDir("f-left");
    const sessionPath = path.join(dir, "session.jsonl");
    writeSessionFixture(sessionPath, 512 * 1024);
    const expected = referenceCountFile(sessionPath);

    const threads = createThreads("f2", 1, () => ({ piSessionId: "session.jsonl", messages: 5 }));
    const plugin = createPluginStub(
      { currentThreadId: threads[0].id, threads },
      createPathResolver(dir)
    );
    const view = createViewContext(plugin);

    const gate = createScanGate(1);
    plugin.instrumentScan((sessionPath, scan) => gate.run(() => scan(sessionPath)));

    const { snapshot } = await renderAndSnapshot(view);
    expect(snapshot[0]).toContain("5 messages");
    expect(await gate.waitForStart()).toBe(true);

    // Back to the chat view: `renderChatView()` bumps the generation so any result
    // still in flight is no longer allowed to touch the thread-list DOM.
    view.threadListRenderGeneration += 1;
    const metaBefore = rowMetaText(view, 0);
    expect(gate.blocked()).toBe(true);

    gate.release();
    expect(await waitForCachedCounts(plugin, threads)).toEqual([expected]);
    expect(rowMetaText(view, 0)).toBe(metaBefore);

    console.log(
      `[F3] after leaving the list the DOM keeps "${metaBefore}"; the ${expected}-message ` +
        `result only reached the cache`
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------
// G. Large sessions: the render no longer blocks on them
// ---------------------------------------------------------------------------

describe("large sessions", () => {
  it("G: a 100 MB-class session no longer blocks the render or the event loop", async () => {
    const dir = createSessionDir("g-large");

    /** @type {Array<{ label: string, bytes: number, renderMs: number, renderGapMs: number, ticks: number, scanMs: number, scanSliceMs: number, messages: number }>} */
    const records = [];

    for (const fixture of work.large) {
      // A private copy per measurement so one cache entry can never answer for a
      // different file.
      const target = path.join(dir, path.basename(fixture.path));
      fs.copyFileSync(fixture.path, target);
      const threads = createThreads("g", 1, () => ({
        piSessionId: path.basename(target),
        messages: 6
      }));
      const plugin = createPluginStub(
        { currentThreadId: threads[0].id, threads },
        createPathResolver(dir)
      );
      const view = createViewContext(plugin);
      const before = scanRuns(plugin);

      work.fixture.reset();
      const renderMeasurement = await measureEventLoopBlocking(() => {
        render(view);
      });

      // The render did not read the session, and it did not wait for the scan.
      expect(work.fixture.stats.readsSinceReset).toBe(0);
      expect(scanRuns(plugin)).toBe(before);
      expect(rowMetaText(view, 0)).toContain("6 messages");

      // Measure the host's responsiveness for the whole background scan.
      const scanMeasurement = await measureScanResponsiveness(waitForCachedCounts(plugin, threads));
      expect(scanRuns(plugin)).toBe(before + 1);
      expect(work.fixture.stats.readsSinceReset).toBe(0);
      expect(rowMetaText(view, 0)).toContain(`${fixture.messages} messages`);

      records.push({
        label: fixture.label,
        bytes: fixture.bytes,
        renderMs: renderMeasurement.elapsedMs,
        renderGapMs: renderMeasurement.maxGapMs,
        ticks: renderMeasurement.ticks,
        scanMs: scanMeasurement.elapsedMs,
        scanSliceMs: scanMeasurement.maxSliceMs,
        messages: fixture.messages
      });
    }

    for (const record of records) {
      // The synchronous render is now independent of session size.
      expect(record.renderMs).toBeLessThan(150);
      expect(record.renderGapMs).toBeLessThan(150);
      // The async scan may take time, but it must not monopolise the loop.
      expect(record.scanSliceMs).toBeLessThan(150);
      console.log(
        `[G] ${record.label} (${record.bytes} bytes): render ${record.renderMs.toFixed(1)} ms ` +
          `(gap ${record.renderGapMs.toFixed(1)} ms, ${record.ticks} ticks), async scan ` +
          `${record.scanMs.toFixed(0)} ms with a longest host slice of ` +
          `${record.scanSliceMs.toFixed(1)} ms -> ${record.messages} messages`
      );
    }
  }, 600_000);
});

// ---------------------------------------------------------------------------
// H. 10 / 20-thread lists
// ---------------------------------------------------------------------------

describe("thread list scale", () => {
  it("H: 20 threads with 10 large sessions render instantly, settle correctly and cache", async () => {
    const dir = createSessionDir("h-scale");
    const large = work.large.at(-1);
    const mid = work.large[Math.floor(work.large.length / 2)];
    const largeCopy = path.join(dir, path.basename(large.path));
    const midCopy = path.join(dir, path.basename(mid.path));
    fs.copyFileSync(large.path, largeCopy);
    fs.copyFileSync(mid.path, midCopy);

    const smallSessions = Array.from({ length: 10 }, (_, index) => {
      const filePath = path.join(dir, `small-${index}.jsonl`);
      const lines = Array.from({ length: 100 + index * 40 }, (_, lineIndex) =>
        messageLine(`small-${index}`, lineIndex)
      );
      fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
      return { path: filePath, messages: referenceCountFile(filePath) };
    });

    const threads = createThreads("h", 20, (index) =>
      index < 10
        ? {
            piSessionId: path.basename(index % 2 === 0 ? largeCopy : midCopy),
            messages: 6
          }
        : { piSessionId: `small-${index - 10}.jsonl`, messages: 6 }
    );
    const plugin = createPluginStub(
      { currentThreadId: threads[0].id, threads },
      createPathResolver(dir)
    );
    const view = createViewContext(plugin);

    work.fixture.reset();
    const first = await renderAndSnapshot(view);

    expect(work.fixture.stats.readsSinceReset).toBe(0);
    expect(first.snapshot).toHaveLength(20);
    // Every row shows its own fallback count on the first paint.
    expect(first.snapshot[0]).toContain("6 messages");
    expect(first.snapshot[19]).toContain("6 messages");
    expect(scanRuns(plugin)).toBe(0);
    expect(first.elapsedMs).toBeLessThan(150);
    expect(first.maxGapMs).toBeLessThan(150);

    // The scan set is deduplicated by path: 10 large threads resolve to 2 files.
    const listed = plugin.listThreads({ includeArchived: true });
    expect(await waitForCachedCounts(plugin, listed)).toHaveLength(20);
    expect(scanRuns(plugin)).toBe(12);
    expect(plugin.sessionMessageCountCache.size).toBe(12);

    // `listed` is the render order (newest first), so the row index is its index.
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const expectations = listed.map((thread) => {
      const index = Number(byId.get(thread.id).id.split("-").at(-1));
      return index < 10
        ? referenceCountFile(index % 2 === 0 ? largeCopy : midCopy)
        : smallSessions[index - 10].messages;
    });
    for (const [index, expected] of expectations.entries()) {
      expect(plugin.getCachedPiSessionMessageCount(listed[index])).toBe(expected);
      expect(rowMetaText(view, index)).toContain(`${expected} messages`);
    }
    // Ten rows share two large counts; no work was repeated for them.
    expect(new Set(expectations.slice(0, 2)).size).toBeLessThanOrEqual(2);

    // A second render of the same list is a pure cache hit.
    const scansBefore = scanRuns(plugin);
    work.fixture.reset();
    const second = await renderAndSnapshot(view);
    expect(second.elapsedMs).toBeLessThan(150);
    expect(work.fixture.stats.readsSinceReset).toBe(0);
    expect(scanRuns(plugin)).toBe(scansBefore);
    expect(plugin.piSessionMessageCounter.pendingCount()).toBe(0);
    for (const [index, expected] of expectations.entries()) {
      expect(second.snapshot[index]).toContain(`${expected} messages`);
      expect(rowMetaText(view, index)).toContain(`${expected} messages`);
    }

    console.log(
      `[H] 20 threads (10 large, 10 small): first render ${first.elapsedMs.toFixed(1)} ms with ` +
        `0 reads, 12 deduplicated background scans, second render ${second.elapsedMs.toFixed(
          1
        )} ms with 0 reads and 0 new scans, no pending tasks`
    );
  }, 600_000);

  it("H2: a plain 10-thread list with small sessions settles with one scan each", async () => {
    const dir = createSessionDir("h-small");
    const sessions = Array.from({ length: 10 }, (_, index) => {
      const filePath = path.join(dir, `small-${index}.jsonl`);
      const lines = Array.from({ length: 100 + index * 50 }, (_, lineIndex) =>
        messageLine(`s${index}`, lineIndex)
      );
      fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
      return { name: `small-${index}.jsonl`, messages: referenceCountFile(filePath) };
    });

    const threads = createThreads("h2", 10, (index) => ({
      piSessionId: sessions[index].name,
      messages: 4
    }));
    const plugin = createPluginStub(
      { currentThreadId: threads[0].id, threads },
      createPathResolver(dir)
    );
    const view = createViewContext(plugin);

    const first = await renderAndSnapshot(view);
    expect(first.elapsedMs).toBeLessThan(100);
    expect(scanRuns(plugin)).toBe(0);
    expect(first.snapshot[0]).toContain("4 messages");
    expect(
      await waitForCachedCounts(plugin, plugin.listThreads({ includeArchived: true }))
    ).toEqual(
      sessions
        .map((session) => session.messages)
        .slice()
        .reverse()
    );
    expect(scanRuns(plugin)).toBe(10);
    for (const [index, session] of sessions.entries()) {
      // Newest thread first: row 0 is the last session built.
      expect(rowMetaText(view, 9 - index)).toContain(`${session.messages} messages`);
    }
    expect(plugin.piSessionMessageCounter.isScanning()).toBe(false);

    console.log(
      `[H2] 10 small threads: render ${first.elapsedMs.toFixed(2)} ms, 10 scans, all rows correct`
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe("failure tolerance", () => {
  it("keeps the list working when a session is unreadable, damaged or missing", async () => {
    const dir = createSessionDir("robust");
    const damaged = path.join(dir, "damaged.jsonl");
    const directoryAsSession = path.join(dir, "a-directory");
    fs.writeFileSync(damaged, `{"type":"message","message":{"role":"user"}}\n{oops\n`);
    fs.mkdirSync(directoryAsSession);

    const threads = createThreads("r", 3, (index) => ({
      piSessionId: ["damaged.jsonl", "a-directory", "nope.jsonl"][index],
      messages: 5
    }));
    const plugin = createPluginStub(
      { currentThreadId: threads[0].id, threads },
      createPathResolver(dir)
    );
    const view = createViewContext(plugin);

    const initial = await renderAndSnapshot(view);
    expect(initial.snapshot[0]).toContain("5 messages");

    // One good line counts; the unreadable and missing sessions stay at 0 and the
    // rows keep their thread.messages fallback.
    expect(await waitForCachedCounts(plugin, threads)).toEqual([1, 0, 0]);
    expect(rowMetaText(view, 0)).toContain("5 messages");
    expect(rowMetaText(view, 1)).toContain("5 messages");
    expect(rowMetaText(view, 2)).toContain("5 messages");

    // A thread list with only broken sessions still renders and never throws.
    const brokenOnly = createThreads("r2", 2, () => ({
      piSessionId: "nope.jsonl",
      messages: 1
    }));
    const plugin2 = createPluginStub(
      { currentThreadId: brokenOnly[0].id, threads: brokenOnly },
      createPathResolver(dir)
    );
    const view2 = createViewContext(plugin2);
    const broken = await renderAndSnapshot(view2);
    expect(broken.snapshot).toHaveLength(2);
    expect(await waitForCachedCounts(plugin2, brokenOnly)).toEqual([0, 0]);

    console.log("[robustness] damaged/missing/unreadable sessions counted as 0 and never threw");
  }, 120_000);

  it("settles a session that fails to read instead of hanging or throwing", async () => {
    const dir = createSessionDir("robust-stream");
    const vanishing = path.join(dir, "vanishing.jsonl");
    writeSessionFixture(vanishing, 64 * 1024);

    // Delete the file while the scan is held open, so the read stream itself fails.
    // A stream failure must settle the count at 0 and must not surface as an
    // unhandled error event.
    const unhandledErrors = [];
    const onUnhandled = (error) => unhandledErrors.push(error);
    process.on("uncaughtException", onUnhandled);

    const plugin = createPluginStub(
      { currentThreadId: "none", threads: [] },
      createPathResolver(dir)
    );
    const gate = createScanGate(1);
    plugin.instrumentScan((sessionPath, scan) =>
      gate.run(() => {
        fs.rmSync(sessionPath, { force: true });
        return scan(sessionPath);
      })
    );

    let settled;
    try {
      const pending = plugin.getPiSessionMessageCount(vanishing);
      expect(await gate.waitForStart()).toBe(true);
      gate.release();
      settled = await Promise.race([
        pending,
        new Promise((resolve) => globalThis.setTimeout(() => resolve("timeout"), 5_000))
      ]);
    } finally {
      process.off("uncaughtException", onUnhandled);
    }

    expect(settled).toBe(0);
    expect(plugin.piSessionMessageCounter.pendingCount()).toBe(0);
    expect(unhandledErrors).toEqual([]);

    console.log("[robustness] a read failure settled at 0 with no unhandled error");
  }, 60_000);
});
