import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunState, finishToolEvent, trackToolEvent } from "../src/pi/run-state.mjs";
import { handlePiEvent } from "../src/pi/events.mjs";
import { PiRpcClient } from "../src/pi/rpc-client.mjs";
import { performanceProfiler } from "../src/shared/performance-profiler.mjs";

const markdownRender = vi.fn().mockResolvedValue(undefined);

vi.mock("obsidian", () => ({
  Component: class {
    load = vi.fn();
    unload = vi.fn();
  },
  MarkdownRenderer: { render: markdownRender },
  setIcon: vi.fn()
}));

let streamingMethods;

beforeAll(async () => {
  streamingMethods = await import("../src/ui/message-renderer.mjs");
});

beforeEach(() => {
  markdownRender.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

class FakeElement {
  constructor(tag = "div", options = {}) {
    this.tag = tag;
    this.cls = options.cls ?? "";
    this.text = options.text ?? "";
    this.children = [];
    this.isConnected = true;
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

  setText(value) {
    this.children.length = 0;
    this.text = value ?? "";
    return this;
  }

  addClass() {}
}

function stubAnimationFrame() {
  const callbacks = new Map();
  let nextId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback) => {
    callbacks.set(++nextId, callback);
    return nextId;
  });
  const cancelAnimationFrame = vi.fn();
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
  return { callbacks, cancelAnimationFrame };
}

function createStreamingView() {
  const view = Object.assign({}, streamingMethods, {
    messagesEl: new FakeElement("div"),
    stickToBottom: true,
    streamingAssistantContent: "",
    streamingThinkingContent: "",
    streamingAnswerDirty: false,
    streamingThinkingDirty: false,
    streamingFlushRaf: undefined,
    streamingTextEl: new FakeElement("div"),
    liveThinkingTextEl: new FakeElement("div"),
    activityText: "",
    messageRenderComponents: [],
    messageRenderComponentByElement: new WeakMap(),
    plugin: { app: {} },
    getLinkSourcePath: () => "",
    updateActivityDom: vi.fn(),
    clearPendingActivityTimer: vi.fn(),
    renderMessages: vi.fn(),
    renderRoleLabel: vi.fn(),
    setLiveThinkingExpanded: vi.fn()
  });
  return view;
}

function feed(client, text, chunkSize) {
  const bytes = Buffer.from(text, "utf8");
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    client.handleStdoutChunk(bytes.subarray(offset, offset + chunkSize));
  }
}

describe("PATCH 5 synthetic tests", () => {
  it("Test C: tool lookup stays exact and fast across 20,000 track/finish cycles", () => {
    const state = createRunState();
    let mismatches = 0;
    const startedAt = globalThis.performance.now();

    for (let index = 0; index < 20_000; index += 1) {
      trackToolEvent(state, {
        toolCallId: `c${index}`,
        toolName: "read",
        toolArgs: { path: `note-${index}.md` },
        isStart: true
      });
      const { entry } = finishToolEvent(state, { toolCallId: `c${index}`, toolName: "read" });
      if (entry?.toolArgs?.path !== `note-${index}.md`) mismatches += 1;
    }

    const elapsedMs = globalThis.performance.now() - startedAt;
    expect(mismatches).toBe(0);
    expect(state.activeTools.size).toBe(0);
    // Generous sanity bound: O(1) Map lookups must not accumulate into seconds.
    expect(elapsedMs).toBeLessThan(2_000);

    // Concurrent scale: 2,000 open tools, then finish one specific id.
    for (let index = 0; index < 2_000; index += 1) {
      trackToolEvent(state, {
        toolCallId: `open-${index}`,
        toolName: "bash",
        toolArgs: { command: `echo ${index}` },
        isStart: true
      });
    }
    const { entry } = finishToolEvent(state, { toolCallId: "open-1337", toolName: "bash" });
    expect(entry.toolArgs).toEqual({ command: "echo 1337" });
    expect(state.activeTools.size).toBe(1_999);
  });

  it("Test F: 1,000 text deltas keep content exact, coalesce flushes, and finalize once", () => {
    const { callbacks, cancelAnimationFrame } = stubAnimationFrame();
    const view = createStreamingView();

    performanceProfiler.reset();
    performanceProfiler.enabled = true;
    try {
      const deltas = Array.from({ length: 1_000 }, (_, index) => `d${index};`);
      const runFrame = () => {
        const [id, callback] = callbacks.entries().next().value ?? [];
        if (callback) {
          callbacks.delete(id);
          callback();
        }
      };

      for (let index = 0; index < deltas.length; index += 1) {
        view.appendStreamingDelta(deltas[index]);
        if ((index + 1) % 100 === 0) runFrame();
      }

      expect(view.streamingTextEl.text).toBe(deltas.join(""));
      const duringStream = performanceProfiler.snapshot().metrics;
      expect(duringStream.streamFlushCount).toBeLessThanOrEqual(11);
      expect(duringStream.streamFlushCount * 10).toBeLessThan(1_000);
      expect(duringStream.markdownRenderCount).toBe(0);

      // agent_end: a pending frame must be cancelled and the final Markdown
      // render must happen synchronously from the complete single source.
      view.appendStreamingDelta("tail;");
      const pendingFrame = callbacks.keys().next().value;
      expect(pendingFrame).toBeDefined();

      const finalized = view.finalizeStreamingContent();

      expect(finalized).toBe(true);
      expect(cancelAnimationFrame).toHaveBeenCalledWith(pendingFrame);
      expect(view.streamingFlushRaf).toBeUndefined();
      const finalMetrics = performanceProfiler.snapshot().metrics;
      expect(finalMetrics.markdownRenderCount).toBe(1);
      expect(markdownRender).toHaveBeenCalledTimes(1);
      expect(markdownRender.mock.calls[0][1]).toBe(`${deltas.join("")}tail;`);

      // The cancelled frame is a no-op even if it runs afterwards.
      view.flushStreaming();
      expect(markdownRender).toHaveBeenCalledTimes(1);
      expect(performanceProfiler.snapshot().metrics.streamFlushCount).toBeLessThanOrEqual(11);
    } finally {
      performanceProfiler.enabled = false;
      performanceProfiler.reset();
    }
  });

  it("Test G: compaction success/abort/error update RunState consistently", () => {
    const success = createRunState();
    handlePiEvent({ type: "auto_compaction_end", result: { tokensBefore: 1_000 } }, success, {});
    expect(success.sawSuccessfulCompaction).toBe(true);
    expect(success.lastCompactionEnd.result).toEqual({ tokensBefore: 1_000 });

    const aborted = createRunState();
    handlePiEvent({ type: "session_compact", aborted: true }, aborted, {});
    expect(aborted.sawSuccessfulCompaction).toBe(false);
    expect(aborted.sawAbortedCompaction).toBe(true);

    const failed = createRunState();
    handlePiEvent({ type: "auto_compaction_end", errorMessage: "compaction failed" }, failed, {});
    expect(failed.sawSuccessfulCompaction).toBe(false);
    expect(failed.lastCompactionEnd.errorMessage).toBe("compaction failed");
  });

  it("CI regression: a 2,000-event burst yields within the batch budget without loss", async () => {
    let processedSinceYield = 0;
    let maxSyncBatch = 0;
    const yieldSpy = vi.fn(async () => {
      maxSyncBatch = Math.max(maxSyncBatch, processedSinceYield);
      processedSinceYield = 0;
    });
    const client = new PiRpcClient({
      yieldScheduler: { yield: yieldSpy, dispose: vi.fn() },
      drainBudget: { maxEvents: 40, maxMs: 10_000 }
    });

    try {
      const notices = [];
      client.subscribe((event) => {
        if (event.type !== "notice") return;
        notices.push(event.n);
        processedSinceYield += 1;
      });

      const lines = Array.from({ length: 2_000 }, (_, index) =>
        JSON.stringify({ type: "notice", n: index })
      );
      feed(client, `${lines.join("\n")}\n`, 65_536);
      await client.whenDrainIdle();

      expect(notices).toHaveLength(2_000);
      expect(new Set(notices).size).toBe(2_000);
      expect(notices[0]).toBe(0);
      expect(notices.at(-1)).toBe(1_999);
      expect(yieldSpy.mock.calls.length).toBeGreaterThanOrEqual(Math.floor(2_000 / 40) - 1);
      // No unbounded synchronous drain: every batch stops at the event budget.
      expect(maxSyncBatch).toBeLessThanOrEqual(40);
    } finally {
      client.dispose();
    }
  });

  it("records queue depth/bytes and raw JSON line size when profiling is enabled", async () => {
    const yieldSpy = vi.fn(async () => {});
    const client = new PiRpcClient({
      yieldScheduler: { yield: yieldSpy, dispose: vi.fn() },
      drainBudget: { maxEvents: 5, maxMs: 10_000 }
    });

    const noticed = [];
    client.subscribe((event) => {
      if (event.type === "notice") noticed.push(event.n);
    });

    performanceProfiler.reset();
    performanceProfiler.enabled = true;
    try {
      feed(
        client,
        `${Array.from({ length: 12 }, (_, index) =>
          JSON.stringify({ type: "notice", n: index, text: "x".repeat(64) })
        ).join("\n")}\n`,
        4_096
      );
      await client.whenDrainIdle();

      expect(noticed).toHaveLength(12);
      const { metrics } = performanceProfiler.snapshot();
      expect(metrics.maxRpcQueueDepth).toBeGreaterThanOrEqual(2);
      expect(metrics.maxRpcQueueBytes).toBeGreaterThan(0);
      expect(metrics.maxJsonLineBytes).toBeGreaterThan(80);
      expect(metrics.maxJsonParseDuration).toBeGreaterThanOrEqual(0);
    } finally {
      performanceProfiler.enabled = false;
      performanceProfiler.reset();
      client.dispose();
    }
  });
});
