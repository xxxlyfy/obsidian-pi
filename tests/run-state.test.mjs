import { describe, expect, it, vi } from "vitest";
import {
  applyCompactionEnd,
  createRunState,
  DiagnosticRing,
  finishToolEvent,
  legacySawSuccessfulCompaction,
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

  it("flags successful and aborted compaction ends consistently", () => {
    const state = createRunState();

    retainEvent(state, { type: "auto_compaction_end", raw: { aborted: true } });
    applyCompactionEnd(state, { aborted: true });

    expect(state.sawSuccessfulCompaction).toBe(false);
    expect(state.sawAbortedCompaction).toBe(true);
    expect(state.lastCompactionEnd).toMatchObject({ aborted: true });
    expect(legacySawSuccessfulCompaction(state.events)).toBe(false);
  });

  it("warns when incremental state and the legacy scan disagree", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createRunState();
    state.sawSuccessfulCompaction = true;

    applyCompactionEnd(state, { aborted: true });

    expect(warn).toHaveBeenCalledWith(
      "Pi Agent: compaction RunState assertion mismatch",
      expect.objectContaining({ incremental: true, legacy: false })
    );
    warn.mockRestore();
  });

  it("retains bounded copies without raw payloads", () => {
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
    expect(state.events).toHaveLength(0);
  });
});
