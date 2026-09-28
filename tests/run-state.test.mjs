import { describe, expect, it, vi } from "vitest";
import {
  applyCompactionEnd,
  createRunState,
  DiagnosticRing,
  finishToolEvent,
  normalizeCompactionEventType,
  retainEvent,
  trackToolEvent
} from "../src/pi/run-state.mjs";

describe("DiagnosticRing", () => {
  it("keeps a bounded FIFO snapshot", () => {
    const ring = new DiagnosticRing(3);
    for (let index = 0; index < 5; index += 1) ring.push({ index });

    expect(ring.size).toBe(3);
    expect(ring.snapshot()).toEqual([{ index: 2 }, { index: 3 }, { index: 4 }]);

    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.snapshot()).toEqual([]);
  });
});

describe("ActiveTools lifecycle", () => {
  it("tracks and finishes tool events by toolCallId", () => {
    const state = createRunState();

    const key = trackToolEvent(state, {
      toolCallId: "c1",
      toolName: "read",
      toolArgs: { path: "a" }
    });
    expect(key).toBe("id:c1");
    expect(state.activeTools.size).toBe(1);

    const { key: endKey, entry } = finishToolEvent(state, { toolCallId: "c1", toolName: "read" });
    expect(endKey).toBe("id:c1");
    expect(entry).toMatchObject({ toolName: "read", toolArgs: { path: "a" } });
    expect(state.activeTools.size).toBe(0);
  });

  it("falls back to a unique same-name match when ids are missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createRunState();

    const startKey = trackToolEvent(state, {
      toolCallId: "",
      toolName: "bash",
      toolArgs: { command: "ls" },
      isStart: true
    });
    const updateKey = trackToolEvent(state, {
      toolCallId: "",
      toolName: "bash",
      toolArgs: { command: "ls -la" }
    });
    expect(updateKey).toBe(startKey);

    const { key: endKey, entry } = finishToolEvent(state, { toolCallId: "", toolName: "bash" });
    expect(endKey).toBe(startKey);
    expect(entry).toMatchObject({ toolArgs: { command: "ls -la" } });
    expect(state.activeTools.size).toBe(0);
    warn.mockRestore();
  });

  it("does not fake correlation when multiple same-name tools are active", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createRunState();

    trackToolEvent(state, { toolCallId: "", toolName: "bash", isStart: true });
    trackToolEvent(state, { toolCallId: "", toolName: "bash", isStart: true });
    const { key, entry } = finishToolEvent(state, { toolCallId: "", toolName: "bash" });

    expect(entry).toBeUndefined();
    expect(key).toMatch(/^tool:/);
    expect(state.activeTools.size).toBe(2);
    warn.mockRestore();
  });
});

describe("compaction state", () => {
  it("normalizes compaction event types", () => {
    expect(normalizeCompactionEventType("auto_compaction_start")).toBe("compaction_start");
    expect(normalizeCompactionEventType("session_before_compact")).toBe("compaction_start");
    expect(normalizeCompactionEventType("auto_compaction_end")).toBe("compaction_end");
    expect(normalizeCompactionEventType("session_compact")).toBe("compaction_end");
    expect(normalizeCompactionEventType("message_end")).toBe("message_end");
  });

  it("tracks successful, aborted, and failed compaction ends", () => {
    const success = createRunState();
    applyCompactionEnd(success, { result: { tokensBefore: 12_345 } });
    expect(success.sawSuccessfulCompaction).toBe(true);
    expect(success.sawAbortedCompaction).toBe(false);
    expect(success.lastCompactionEnd).toMatchObject({ result: { tokensBefore: 12_345 } });

    const aborted = createRunState();
    applyCompactionEnd(aborted, { aborted: true });
    expect(aborted.sawSuccessfulCompaction).toBe(false);
    expect(aborted.sawAbortedCompaction).toBe(true);
    expect(aborted.lastCompactionEnd).toMatchObject({ aborted: true });

    const failed = createRunState();
    applyCompactionEnd(failed, { errorMessage: "boom" });
    expect(failed.sawSuccessfulCompaction).toBe(false);
    expect(failed.lastCompactionEnd.errorMessage).toBe("boom");
  });

  it("retains bounded diagnostic copies without raw payloads", () => {
    const state = createRunState();

    retainEvent(state, {
      type: "tool_end",
      toolName: "bash",
      toolCallId: "c1",
      raw: { result: "x".repeat(10_000) }
    });

    const [retained] = state.diagnostics.snapshot();
    expect(retained).toMatchObject({ type: "tool_end", toolName: "bash", toolCallId: "c1" });
    expect(retained).not.toHaveProperty("raw");
  });
});
