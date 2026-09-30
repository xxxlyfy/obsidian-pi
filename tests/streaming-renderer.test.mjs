import { readFileSync } from "node:fs";
import { createViewLifecycle } from "../src/ui/view/lifecycle.mjs";
import { readSources } from "./helpers/view-source.mjs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
let handleRunEvent;

beforeAll(async () => {
  streamingMethods = await import("../src/ui/message-renderer.mjs");
  ({ handleRunEvent } = await import("../src/ui/run-activity-state.mjs"));
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
    this.attr = options.attr ?? {};
    this.children = [];
    this.listeners = new Map();
    this.open = false;
    this.isConnected = true;
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.classList = new Set(String(this.cls).split(" ").filter(Boolean));
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

  addClass(name) {
    this.classList.add(name);
  }

  toggleAttribute(name, enabled) {
    if (name === "open") this.open = enabled;
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
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

function createView(overrides = {}) {
  const view = Object.assign({}, streamingMethods);
  return Object.assign(
    view,
    {
      lifecycle: createViewLifecycle(),
      messagesEl: new FakeElement("div"),
      running: true,
      stickToBottom: true,
      streamingAssistantContent: "",
      streamingThinkingContent: "",
      streamingAnswerDirty: false,
      streamingThinkingDirty: false,
      streamingFlushRaf: undefined,
      streamingTextEl: new FakeElement("div"),
      liveThinkingTextEl: new FakeElement("div"),
      activityText: "Responding",
      messageRenderComponents: [],
      messageRenderComponentByElement: new WeakMap(),
      plugin: { app: {} },
      getLinkSourcePath: () => "",
      updateActivityDom: vi.fn(),
      clearPendingActivityTimer: vi.fn(),
      renderMessages: vi.fn(),
      renderRoleLabel: vi.fn(),
      setLiveThinkingExpanded: vi.fn()
    },
    overrides
  );
}

describe("PATCH 3 streaming renderer", () => {
  it("coalesces many assistant deltas into one frame and one plain-text update", () => {
    const { callbacks } = stubAnimationFrame();
    const view = createView();

    view.appendStreamingDelta("Hel");
    view.appendStreamingDelta("lo ");
    view.appendStreamingDelta("world");

    expect(callbacks.size).toBe(1);
    expect(view.streamingTextEl.text).toBe("");

    callbacks.get(1)();

    expect(view.streamingTextEl.text).toBe("Hello world");
    expect(view.streamingTextEl.children.map((child) => child.cls)).toEqual([
      "pi-agent-typing-cursor"
    ]);
    expect(markdownRender).not.toHaveBeenCalled();
    expect(view.streamingFlushRaf).toBeUndefined();
    expect(view.streamingAnswerDirty).toBe(false);
  });

  it("flushes assistant and thinking content in the same single frame", () => {
    const { callbacks } = stubAnimationFrame();
    const view = createView();

    view.appendStreamingDelta("answer");
    view.streamingThinkingContent = "reasoning";
    view.appendStreamingThinkingDelta("reasoning");

    expect(callbacks.size).toBe(1);

    callbacks.get(1)();

    expect(view.streamingTextEl.text).toBe("answer");
    expect(view.liveThinkingTextEl.text).toBe("reasoning");
    expect(markdownRender).not.toHaveBeenCalled();
  });

  it("falls back to a full message re-render when the streaming element is gone", () => {
    const { callbacks } = stubAnimationFrame();
    const view = createView({ streamingTextEl: undefined });

    view.appendStreamingDelta("stale element");
    callbacks.get(1)();

    expect(view.renderMessages).toHaveBeenCalledOnce();
  });

  it("finalizes agent_end synchronously: cancels the frame and renders Markdown once", () => {
    const { callbacks, cancelAnimationFrame } = stubAnimationFrame();
    const view = createView();

    view.appendStreamingDelta("**Final** answer");
    view.streamingThinkingContent = "deep thought";
    view.appendStreamingThinkingDelta("deep thought");
    const pendingFrame = callbacks.keys().next().value;

    const handled = view.finalizeStreamingContent();

    expect(handled).toBe(true);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(pendingFrame);
    expect(view.streamingFlushRaf).toBeUndefined();
    expect(markdownRender).toHaveBeenCalledTimes(2);
    expect(markdownRender.mock.calls[0][1]).toBe("deep thought");
    expect(markdownRender.mock.calls[0][2]).toBe(view.liveThinkingTextEl);
    expect(markdownRender.mock.calls[1][1]).toBe("**Final** answer");
    expect(markdownRender.mock.calls[1][2]).toBe(view.streamingTextEl);
    expect(view.streamingTextEl.classList.has("markdown-rendered")).toBe(true);
    expect(view.streamingTextEl.text).toBe("");
    expect(view.streamingTextEl.children).toEqual([]);

    // The cancelled frame is a no-op even if it somehow runs later.
    view.flushStreaming();
    expect(markdownRender).toHaveBeenCalledTimes(2);
  });

  it("runs the final Markdown render from the agent_end handler without a full re-render", () => {
    stubAnimationFrame();
    const view = createView({
      streamingAssistantContent: "final text",
      streamingAnswerDirty: true,
      normalizeRunEventType: (type) => type,
      captureContextUsage: vi.fn(),
      activeToolCalls: new Map()
    });

    handleRunEvent.call(view, { type: "agent_end" });

    expect(markdownRender).toHaveBeenCalledTimes(1);
    expect(markdownRender.mock.calls[0][1]).toBe("final text");
    expect(view.renderMessages).not.toHaveBeenCalled();
  });

  it("keeps the user's manual scroll position and follows the bottom when sticky", () => {
    const { callbacks } = stubAnimationFrame();
    const messagesEl = new FakeElement("div");
    messagesEl.scrollHeight = 500;
    const sticky = createView({ messagesEl });

    sticky.appendStreamingDelta("abc");
    callbacks.get(1)();
    expect(messagesEl.scrollTop).toBe(500);

    const scrolled = createView({ messagesEl, stickToBottom: false });
    messagesEl.scrollTop = 120;
    scrolled.appendStreamingDelta("def");
    scrolled.finalizeStreamingContent();
    expect(messagesEl.scrollTop).toBe(120);
  });

  it("cancels the pending frame exactly once and clears the handle", () => {
    const { cancelAnimationFrame } = stubAnimationFrame();
    const view = createView();

    view.scheduleStreamingFlush();
    const handle = view.streamingFlushRaf;
    view.cancelStreamingFlush();

    expect(cancelAnimationFrame).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(handle);
    expect(view.streamingFlushRaf).toBeUndefined();

    view.cancelStreamingFlush();
    expect(cancelAnimationFrame).toHaveBeenCalledOnce();
  });

  it("wires pending-rAF cleanup into unload, thread switch, cancel, and run teardown", () => {
    const viewSource = readFileSync(new URL("../src/ui/PiAgentView.mjs", import.meta.url), "utf8");
    const activitySource = readFileSync(
      new URL("../src/ui/run-activity-state.mjs", import.meta.url),
      "utf8"
    );
    // The four cancelStreamingFlush() call sites (onClose, thread switch,
    // cancel, and run teardown) are frame cancellation owned by the view and the
    // activity mixin, so count them across both files. A smaller number than
    // four means a teardown path lost its cleanup.
    const cancelFlushSources = readSources(["ui/PiAgentView.mjs", "ui/run-activity-state.mjs"]);

    expect(viewSource).toMatch(/onClose\(\) \{[\s\S]*?this\.cancelStreamingFlush\(\)/);
    expect(viewSource).toMatch(
      /resetTransientRunUiState\(\) \{[\s\S]*?this\.cancelStreamingFlush\(\)/
    );
    expect(
      cancelFlushSources.match(/this\.cancelStreamingFlush\(\)/g)?.length
    ).toBeGreaterThanOrEqual(4);
    expect(activitySource).toContain("this.finalizeStreamingContent?.() === true");
  });

  it("drops a stale frame via the run/thread generation guard", () => {
    const { callbacks } = stubAnimationFrame();
    const noteStaleUiCallback = vi.fn();
    const view = createView({
      captureUiCallbackGuard: () => ({
        threadId: "thread-1",
        threadGeneration: 1,
        runGeneration: 5
      }),
      isStaleUiCallback: () => true,
      noteStaleUiCallback
    });

    view.appendStreamingDelta("stale");
    expect(callbacks.size).toBe(1);

    callbacks.get(1)();

    expect(noteStaleUiCallback).toHaveBeenCalledOnce();
    expect(view.streamingTextEl.text).toBe("");
    expect(view.streamingAnswerDirty).toBe(false);
    expect(view.streamingFlushRaf).toBeUndefined();
    expect(view.streamingFlushGuard).toBeUndefined();
  });

  it("records flush and Markdown-render counts in the profiler", async () => {
    const { performanceProfiler } = await import("../src/shared/performance-profiler.mjs");
    const { callbacks } = stubAnimationFrame();
    const view = createView();

    performanceProfiler.reset();
    performanceProfiler.enabled = true;
    try {
      view.appendStreamingDelta("hello");
      callbacks.get(1)();
      expect(performanceProfiler.snapshot().metrics.streamFlushCount).toBe(1);
      expect(performanceProfiler.snapshot().metrics.markdownRenderCount).toBe(0);

      view.finalizeStreamingContent();
      expect(performanceProfiler.snapshot().metrics.markdownRenderCount).toBe(1);
      expect(performanceProfiler.snapshot().metrics.maxStreamFlushDuration).toBeGreaterThanOrEqual(
        0
      );
    } finally {
      performanceProfiler.enabled = false;
      performanceProfiler.reset();
    }
  });
});
