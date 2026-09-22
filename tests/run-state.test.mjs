import { describe, expect, it, vi } from "vitest";
import { isTerminalStatus, RUN_STATUS, RunStateStore } from "../src/agent/run-state.mjs";

function createStore(now = () => 1_000) {
  return new RunStateStore({ now });
}

describe("RunStateStore", () => {
  it("starts a run with a generation-based identity", () => {
    const store = createStore();

    const run = store.begin("t1");

    expect(run).toMatchObject({
      runId: "t1:1",
      generation: 1,
      threadId: "t1",
      status: RUN_STATUS.starting,
      revision: 1,
      startedAt: 1_000,
      completedAt: undefined
    });
    expect(store.has("t1")).toBe(true);
    expect(store.size).toBe(1);
    expect(store.get("t1")).toBe(run);
    expect(store.getSnapshot("t1")).toEqual(run);
    expect(store.getSnapshot("t1")).not.toBe(run);
  });

  it("bumps the revision on every transition and stamps completion", () => {
    let now = 1_000;
    const store = createStore(() => now);
    store.begin("t1");

    now = 1_500;
    store.transition("t1", RUN_STATUS.running);
    const completed = store.transition("t1", RUN_STATUS.completed);

    expect(completed).toMatchObject({
      status: RUN_STATUS.completed,
      revision: 3,
      completedAt: 1_500
    });
    expect(isTerminalStatus(RUN_STATUS.completed)).toBe(true);
    expect(isTerminalStatus(RUN_STATUS.running)).toBe(false);
  });

  it("ignores transitions for unknown threads", () => {
    const store = createStore();

    expect(store.transition("missing", RUN_STATUS.running)).toBeUndefined();
    expect(store.get("missing")).toBeUndefined();
  });

  it("keeps generations increasing so a new run can never be mistaken for an old one", () => {
    const store = createStore();

    const first = store.begin("t1");
    store.end("t1");
    const second = store.begin("t1");

    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(store.isCurrent("t1", first.runId, first.generation)).toBe(false);
    expect(store.isCurrent("t1", second.runId, second.generation)).toBe(true);
  });

  it("only ends the record that is still active", () => {
    const store = createStore();
    const first = store.begin("t1");

    expect(store.end("t1", "t1:999")).toBe(false);
    expect(store.has("t1")).toBe(true);
    expect(store.end("t1", first.runId)).toBe(true);
    expect(store.has("t1")).toBe(false);
    expect(store.end("t1")).toBe(false);
  });

  it("notifies subscribers and survives a failing listener", () => {
    const store = createStore();
    const events = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const unsubscribe = store.subscribe((event) => events.push(event.type));
    store.subscribe(() => {
      throw new Error("listener down");
    });

    store.begin("t1");
    store.transition("t1", RUN_STATUS.running);
    unsubscribe();
    store.end("t1");

    expect(events).toEqual(["run-started", "run-state"]);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("clears runs and listeners on dispose", () => {
    const store = createStore();
    const events = [];
    store.subscribe((event) => events.push(event.type));
    store.begin("t1");

    store.dispose();
    expect(store.size).toBe(0);

    store.begin("t2");

    expect(store.size).toBe(1);
    expect(events).toEqual(["run-started"]);
  });
});
