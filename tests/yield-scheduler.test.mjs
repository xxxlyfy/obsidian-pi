import { afterEach, describe, expect, it, vi } from "vitest";
import { YieldScheduler } from "../src/pi/yield-scheduler.mjs";
import { performanceProfiler } from "../src/shared/performance-profiler.mjs";

afterEach(() => {
  performanceProfiler.enabled = false;
  performanceProfiler.reset();
});

describe("YieldScheduler", () => {
  it("prefers scheduler.yield when available", async () => {
    const schedulerYield = vi.fn(async () => {});
    const scheduler = new YieldScheduler({
      scheduler: { yield: schedulerYield },
      channelFactory: undefined
    });

    expect(scheduler.strategy).toBe("scheduler");
    await scheduler.yield();
    expect(schedulerYield).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it("reuses a single MessageChannel when scheduler.yield is unavailable", async () => {
    let created = 0;
    const channels = [];
    const scheduler = new YieldScheduler({
      scheduler: {},
      channelFactory: () => {
        created += 1;
        const channel = new globalThis.MessageChannel();
        channels.push(channel);
        return channel;
      }
    });

    expect(scheduler.strategy).toBe("message-channel");
    await scheduler.yield();
    await scheduler.yield();
    expect(created).toBe(1);

    scheduler.dispose();
    expect(channels[0].port1.onmessage).toBe(null);
  });

  it("falls back to the timer strategy without scheduler.yield or MessageChannel", async () => {
    const setTimeout = vi.fn((resolve) => resolve());
    const scheduler = new YieldScheduler({
      scheduler: {},
      channelFactory: undefined,
      timeoutHost: { setTimeout }
    });

    expect(scheduler.strategy).toBe("timeout");
    await scheduler.yield();
    expect(setTimeout).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it("falls back to a timer when scheduler.yield rejects", async () => {
    const scheduler = new YieldScheduler({
      scheduler: {
        yield: async () => {
          throw new Error("scheduler.yield failed");
        }
      },
      timeoutHost: { setTimeout: (resolve) => resolve() }
    });

    await expect(scheduler.yield()).resolves.toBeUndefined();
    scheduler.dispose();
  });

  it("resolves pending yields and ignores further yields after dispose", async () => {
    const scheduler = new YieldScheduler({
      scheduler: {},
      channelFactory: () => new globalThis.MessageChannel()
    });

    const pending = scheduler.yield();
    scheduler.dispose();
    await expect(pending).resolves.toBeUndefined();
    await expect(scheduler.yield()).resolves.toBeUndefined();
  });

  it("records yieldCount and yieldLatency when the profiler is enabled", async () => {
    performanceProfiler.reset();
    performanceProfiler.enabled = true;

    const scheduler = new YieldScheduler({ scheduler: { yield: async () => {} } });
    await scheduler.yield();

    const { metrics } = performanceProfiler.snapshot();
    expect(metrics.yieldCount).toBe(1);
    expect(metrics.yieldLatency).toBeGreaterThanOrEqual(0);
    scheduler.dispose();
  });

  it("yields with the runtime default when no options are provided", async () => {
    const scheduler = new YieldScheduler();
    expect(["scheduler", "message-channel", "timeout"]).toContain(scheduler.strategy);
    await expect(scheduler.yield()).resolves.toBeUndefined();
    scheduler.dispose();
  });
});
