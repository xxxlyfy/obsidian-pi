import { afterEach, describe, expect, it, vi } from "vitest";
import { createViewLifecycle } from "../src/ui/view/lifecycle.mjs";

afterEach(() => {
  vi.useRealTimers();
});

describe("view lifecycle", () => {
  it("runs a registered timer", () => {
    vi.useFakeTimers();
    const lifecycle = createViewLifecycle();
    const callback = vi.fn();

    lifecycle.setTimer(callback, 100);
    expect(lifecycle.pendingTimers).toBe(1);

    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledOnce();
    expect(lifecycle.pendingTimers).toBe(0);
  });

  it("drops a pending timer when the view is disposed first", () => {
    vi.useFakeTimers();
    const lifecycle = createViewLifecycle();
    const callback = vi.fn();

    lifecycle.setTimer(callback, 100);
    lifecycle.dispose();
    vi.advanceTimersByTime(500);

    // This is the whole point: a timer that outlives its view must not run.
    expect(callback).not.toHaveBeenCalled();
    expect(lifecycle.pendingTimers).toBe(0);
  });

  it("clears one timer without touching the others", () => {
    vi.useFakeTimers();
    const lifecycle = createViewLifecycle();
    const first = vi.fn();
    const second = vi.fn();

    const handle = lifecycle.setTimer(first, 50);
    lifecycle.setTimer(second, 80);
    lifecycle.clearTimer(handle);

    vi.advanceTimersByTime(200);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("runs every cleanup exactly once across repeated disposals", () => {
    const lifecycle = createViewLifecycle();
    const cleanup = vi.fn();

    lifecycle.addCleanup(cleanup);
    lifecycle.addCleanup(cleanup);

    lifecycle.dispose();
    lifecycle.dispose();

    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(lifecycle.pendingCleanups).toBe(0);
    expect(lifecycle.disposed).toBe(true);
  });

  it("releases a single cleanup without disposing the rest", () => {
    const lifecycle = createViewLifecycle();
    const released = vi.fn();
    const kept = vi.fn();

    const release = lifecycle.addCleanup(released);
    lifecycle.addCleanup(kept);

    release();
    release();
    expect(released).toHaveBeenCalledOnce();
    expect(lifecycle.pendingCleanups).toBe(1);

    lifecycle.dispose();
    expect(kept).toHaveBeenCalledOnce();
    expect(released).toHaveBeenCalledOnce();
  });

  it("refuses new work after disposal and cleans up immediately", () => {
    vi.useFakeTimers();
    const lifecycle = createViewLifecycle();
    const lateTimer = vi.fn();
    const lateCleanup = vi.fn();

    lifecycle.dispose();
    expect(lifecycle.setTimer(lateTimer, 10)).toBeUndefined();
    lifecycle.addCleanup(lateCleanup);
    vi.advanceTimersByTime(50);

    expect(lateTimer).not.toHaveBeenCalled();
    expect(lateCleanup).toHaveBeenCalledOnce();
  });

  it("keeps going when one cleanup throws", () => {
    const lifecycle = createViewLifecycle();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn();

    lifecycle.addCleanup(() => {
      throw new Error("cleanup blew up");
    });
    lifecycle.addCleanup(after);

    expect(() => lifecycle.dispose()).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });
});
