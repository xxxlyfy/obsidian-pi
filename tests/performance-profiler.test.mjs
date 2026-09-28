import { beforeEach, describe, expect, it, vi } from "vitest";
import { PerformanceProfiler, performanceProfiler } from "../src/shared/performance-profiler.mjs";

describe("PerformanceProfiler", () => {
  let profiler;

  beforeEach(() => {
    profiler = new PerformanceProfiler();
  });

  it("is disabled by default and ignores records while disabled", () => {
    expect(profiler.enabled).toBe(false);

    profiler.incrementCounter("rpcEventsProcessed");
    profiler.recordDuration("event", 5);
    profiler.recordMax("jsonLineBytes", 10);
    profiler.recordJsonEvent("{}");

    const snapshot = profiler.snapshot();
    expect(snapshot.metrics.rpcEventsProcessed).toBe(0);
    expect(snapshot.counters).toEqual({});
    expect(snapshot.durations).toEqual({});
    expect(snapshot.maxima).toEqual({});
  });

  it("aggregates counters, durations, and maxima when enabled", () => {
    profiler.enabled = true;

    profiler.incrementCounter("rpcEventsProcessed", 2);
    profiler.incrementCounter("rpcEventsProcessed");
    profiler.recordDuration("event", 4);
    profiler.recordDuration("event", 10);
    profiler.recordMax("jsonLineBytes", 120);
    profiler.recordMax("jsonLineBytes", 64);

    const snapshot = profiler.snapshot();
    expect(snapshot.metrics.rpcEventsProcessed).toBe(3);
    expect(snapshot.durations.event).toEqual({
      count: 2,
      total: 14,
      max: 10,
      last: 10,
      mean: 7
    });
    expect(snapshot.maxima.jsonLineBytes).toBe(120);
  });

  it("ignores invalid durations, maxima, and counter deltas", () => {
    profiler.enabled = true;

    profiler.recordDuration("event", -1);
    profiler.recordDuration("event", Number.NaN);
    profiler.recordMax("jsonLineBytes", Number.POSITIVE_INFINITY);
    profiler.incrementCounter("rpcEventsProcessed", Number.NaN);

    const snapshot = profiler.snapshot();
    expect(snapshot.counters).toEqual({});
    expect(snapshot.durations).toEqual({});
    expect(snapshot.maxima).toEqual({});
  });

  it("reports the PATCH 0 metric set and the derived events-per-second rate", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const timed = new PerformanceProfiler();
    timed.enabled = true;
    timed.recordJsonEvent('{"type":"ping"}');
    timed.recordDuration("jsonParse", 1.5);
    timed.recordDuration("event", 3);
    timed.recordDuration("drain", 8);

    vi.setSystemTime(3_000);
    const { metrics } = timed.snapshot();
    expect(metrics.rpcEventsProcessed).toBe(1);
    expect(metrics.rpcEventsPerSecond).toBeCloseTo(0.5, 6);
    expect(metrics.maxDrainDuration).toBe(8);
    expect(metrics.maxEventDuration).toBe(3);
    expect(metrics.maxJsonParseDuration).toBe(1.5);
    expect(metrics.maxJsonLineBytes).toBeGreaterThan(0);
    expect(metrics.yieldCount).toBe(0);
    expect(metrics.yieldLatency).toBe(0);

    vi.useRealTimers();
  });

  it("reports PATCH 3 streaming metrics", () => {
    profiler.enabled = true;

    profiler.incrementCounter("streamDeltaCount", 120);
    profiler.incrementCounter("streamFlushCount", 3);
    profiler.incrementCounter("markdownRenderCount", 2);
    profiler.recordDuration("uiCallback", 12.5);
    profiler.recordDuration("streamFlush", 4.5);

    const { metrics } = profiler.snapshot();
    expect(metrics.streamDeltaCount).toBe(120);
    expect(metrics.streamFlushCount).toBe(3);
    expect(metrics.markdownRenderCount).toBe(2);
    expect(metrics.maxUiCallbackDuration).toBe(12.5);
    expect(metrics.maxStreamFlushDuration).toBe(4.5);
  });

  it("reset clears counters, durations, maxima, and the time window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);

    const timed = new PerformanceProfiler();
    timed.enabled = true;
    timed.incrementCounter("rpcEventsProcessed");
    timed.recordDuration("event", 2);
    timed.recordMax("jsonLineBytes", 1);

    vi.setSystemTime(6_000);
    timed.reset();
    const snapshot = timed.snapshot();
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.counters).toEqual({});
    expect(snapshot.durations).toEqual({});
    expect(snapshot.maxima).toEqual({});

    vi.useRealTimers();
  });

  it("exposes a shared singleton instance", () => {
    expect(performanceProfiler).toBeInstanceOf(PerformanceProfiler);
  });
});
