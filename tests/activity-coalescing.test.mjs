import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as activityMethods from "../src/ui/run-activity-state.mjs";
import { performanceProfiler } from "../src/shared/performance-profiler.mjs";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function createView(overrides = {}) {
  return Object.assign({}, activityMethods, {
    running: true,
    activityText: "",
    activityKind: "thinking",
    activityDetail: "",
    activityStickyUntil: 0,
    pendingActivity: undefined,
    pendingActivityTimer: undefined,
    pendingActivityGuard: undefined,
    activityCoalesceTimer: undefined,
    activityCoalescePending: false,
    activityCoalesceGuard: undefined,
    activeToolCalls: new Map(),
    streamingAssistantContent: "",
    updateActivityDom: vi.fn(() => true),
    renderMessages: vi.fn(),
    renderPromptQueue: vi.fn(),
    renderToolBadges: vi.fn(),
    captureContextUsage: vi.fn(),
    normalizeRunEventType: (type) => type,
    getCurrentThreadRun: vi.fn(() => undefined),
    getCurrentThreadId: vi.fn(() => "thread-1"),
    captureUiCallbackGuard: vi.fn(() => ({
      threadId: "thread-1",
      threadGeneration: 1,
      runGeneration: 7
    })),
    isStaleUiCallback: vi.fn(() => false),
    noteStaleUiCallback: vi.fn(),
    ...overrides
  });
}

describe("PATCH 4 activity coalescing", () => {
  it("coalesces repeated tool_update events into one activity flush", () => {
    const view = createView();

    view.handleRunEvent({
      type: "tool_start",
      toolName: "read",
      toolKey: "r1",
      toolArgs: { path: "a.md" }
    });
    expect(view.updateActivityDom).toHaveBeenCalledTimes(1);
    expect(view.activityText).toBe("Reading a.md");

    for (let index = 0; index < 8; index++) {
      view.handleRunEvent({
        type: "tool_update",
        toolName: "read",
        toolKey: "r1",
        toolArgs: { path: `draft-${index}.md` }
      });
    }

    expect(vi.getTimerCount()).toBe(1);
    expect(view.updateActivityDom).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(149);
    expect(view.updateActivityDom).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(view.updateActivityDom).toHaveBeenCalledTimes(2);
    expect(view.activityText).toBe("Reading draft-7.md");
    expect(view.activityCoalescePending).toBe(false);
    expect(view.activityCoalesceTimer).toBeUndefined();
  });

  it("keeps tool_start, tool_end, error, agent_end, and cancel immediate", () => {
    const view = createView();

    view.handleRunEvent({
      type: "tool_start",
      toolName: "read",
      toolKey: "r1",
      toolArgs: { path: "a.md" }
    });
    view.handleRunEvent({
      type: "tool_update",
      toolName: "read",
      toolKey: "r1",
      toolArgs: { path: "b.md" }
    });
    expect(vi.getTimerCount()).toBe(1);

    // tool_end is immediate and drops the pending coalesced status. The
    // "Reviewing results" label then waits out the sticky window (existing UX).
    view.handleRunEvent({ type: "tool_end", toolName: "read", toolKey: "r1", isError: false });
    expect(view.activityCoalescePending).toBe(false);
    expect(view.activityCoalesceTimer).toBeUndefined();
    vi.advanceTimersByTime(1200);
    expect(view.activityText).toBe("Reviewing results");

    view.handleRunEvent({
      type: "tool_start",
      toolName: "bash",
      toolKey: "b1",
      toolArgs: { command: "npm test" }
    });
    view.handleRunEvent({
      type: "tool_update",
      toolName: "bash",
      toolKey: "b1",
      toolArgs: { command: "npm test --watch" }
    });
    view.handleRunEvent({ type: "agent_end", raw: {} });
    expect(view.activityCoalescePending).toBe(false);
    expect(view.activityCoalesceTimer).toBeUndefined();
    expect(view.pendingActivity).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);

    const errorView = createView();
    errorView.scheduleCoalescedActivity();
    errorView.handleRunEvent({ type: "extension_error", raw: { error: "boom" } });
    expect(errorView.activityCoalescePending).toBe(false);
    expect(errorView.activityCoalesceTimer).toBeUndefined();
    expect(errorView.activityText).toBe("Extension failed");
  });

  it("drops a stale coalesced flush and counts it", () => {
    const view = createView({ isStaleUiCallback: vi.fn(() => true) });

    view.handleRunEvent({
      type: "tool_update",
      toolName: "read",
      toolKey: "r1",
      toolArgs: { path: "a.md" }
    });
    vi.advanceTimersByTime(150);

    expect(view.isStaleUiCallback).toHaveBeenCalledOnce();
    expect(view.noteStaleUiCallback).toHaveBeenCalledOnce();
    expect(view.updateActivityDom).not.toHaveBeenCalled();
    expect(view.activityText).toBe("");
  });

  it("drops a stale pending-activity sticky flush and counts it", () => {
    const view = createView({ isStaleUiCallback: vi.fn(() => true) });
    view.pendingActivity = { text: "Thinking", kind: "thinking", detail: "" };

    view.schedulePendingActivity();
    vi.advanceTimersByTime(1);

    expect(view.isStaleUiCallback).toHaveBeenCalledOnce();
    expect(view.noteStaleUiCallback).toHaveBeenCalledOnce();
    expect(view.pendingActivity).toBeUndefined();
    expect(view.activityText).toBe("");
  });

  it("clearCoalescedActivity cancels the timer and pending state", () => {
    const view = createView();
    view.scheduleCoalescedActivity();
    expect(vi.getTimerCount()).toBe(1);

    view.clearCoalescedActivity();

    expect(vi.getTimerCount()).toBe(0);
    expect(view.activityCoalescePending).toBe(false);
    expect(view.activityCoalesceTimer).toBeUndefined();
    expect(view.activityCoalesceGuard).toBeUndefined();
  });

  it("records activity flush, coalescing, update, and stale-callback metrics", () => {
    performanceProfiler.reset();
    performanceProfiler.enabled = true;
    try {
      const view = createView({
        noteStaleUiCallback: () => performanceProfiler.incrementCounter("staleCallbackPrevented")
      });

      view.handleRunEvent({
        type: "tool_start",
        toolName: "read",
        toolKey: "r1",
        toolArgs: { path: "a.md" }
      });
      for (let index = 0; index < 3; index++) {
        view.handleRunEvent({
          type: "tool_update",
          toolName: "read",
          toolKey: "r1",
          toolArgs: { path: `note-${index}.md` }
        });
      }
      vi.advanceTimersByTime(150);

      const staleView = createView({
        isStaleUiCallback: () => true,
        noteStaleUiCallback: () => performanceProfiler.incrementCounter("staleCallbackPrevented")
      });
      staleView.scheduleCoalescedActivity();
      vi.advanceTimersByTime(150);

      const { metrics } = performanceProfiler.snapshot();
      expect(metrics.activityFlushCount).toBe(2);
      expect(metrics.activityCoalescedEvents).toBe(4);
      expect(metrics.activityCoalescedFlushes).toBe(1);
      expect(metrics.maxActivityUpdateDuration).toBeGreaterThanOrEqual(0);
      expect(metrics.staleCallbackPrevented).toBe(1);
    } finally {
      performanceProfiler.enabled = false;
      performanceProfiler.reset();
    }
  });

  it("owns its lifecycle cleanup in the view and guards delayed run callbacks", () => {
    const viewSource = readFileSync(new URL("../src/ui/PiAgentView.mjs", import.meta.url), "utf8");

    expect(viewSource).toMatch(/onClose\(\) \{[\s\S]*?this\.clearCoalescedActivity\(\)/);
    expect(viewSource).toMatch(
      /resetTransientRunUiState\(\) \{[\s\S]*?this\.clearCoalescedActivity\(\)/
    );
    expect(viewSource).toMatch(/cancelCurrentRun\(\) \{[\s\S]*?this\.clearCoalescedActivity\(\)/);
    expect(viewSource).toContain("this.threadGeneration += 1");
    expect(viewSource).toContain("runGeneration: ++this.runGenerationCounter");
    expect(viewSource).toContain("if (this.activeRuns.get(t) !== n)");
    expect(viewSource).toContain("isStaleUiCallback(guard)");
  });
});
