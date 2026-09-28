// Minimal opt-in performance profiler for the UI-responsiveness work.
//
// Contract (spec PATCH 0 §3.6):
// - Disabled by default; enable explicitly via `profiler.enabled = true`.
// - Never keyed off NODE_ENV.
// - Counters and durations only; no UI.
//
// Wired into the RPC event path in PATCH 0. Later patches add queue/stream/
// activity metrics as they land (see perf/PROGRESS.md).

const textEncoder = new globalThis.TextEncoder();

export class PerformanceProfiler {
  constructor() {
    this.enabled = false;
    this.reset();
  }

  reset() {
    this.counters = new Map();
    this.durations = new Map();
    this.maxima = new Map();
    this.heap = {};
    this.startedAt = Date.now();
  }

  /**
   * PATCH 5 §8.1: mark JS-heap samples for the run lifecycle. `before`/`after`
   * store the latest sample, `during` keeps the peak between marks. Chromium
   * exposes `performance.memory`; other hosts are silently ignored.
   */
  markHeap(stage) {
    if (!this.enabled) return;
    const used = globalThis.performance?.memory?.usedJSHeapSize;
    if (!Number.isFinite(used)) return;
    const key = String(stage);
    if (key === "during") this.heap[key] = Math.max(this.heap[key] ?? 0, used);
    else this.heap[key] = used;
  }

  incrementCounter(name, delta = 1) {
    if (!this.enabled || !Number.isFinite(delta)) return;
    const key = String(name);
    this.counters.set(key, (this.counters.get(key) ?? 0) + delta);
  }

  recordDuration(name, duration) {
    if (!this.enabled || !Number.isFinite(duration) || duration < 0) return;
    const key = String(name);
    const stats = this.durations.get(key) ?? { count: 0, total: 0, max: 0, last: 0 };
    stats.count += 1;
    stats.total += duration;
    stats.max = Math.max(stats.max, duration);
    stats.last = duration;
    this.durations.set(key, stats);
  }

  recordMax(name, value) {
    if (!this.enabled || !Number.isFinite(value)) return;
    const key = String(name);
    this.maxima.set(key, Math.max(this.maxima.get(key) ?? 0, value));
  }

  recordJsonEvent(line) {
    if (!this.enabled) return;
    this.incrementCounter("rpcEventsProcessed");
    this.recordMax("jsonLineBytes", textEncoder.encode(line).length);
  }

  snapshot() {
    const elapsedMs = Math.max(0, Date.now() - this.startedAt);
    const counters = Object.fromEntries(this.counters);
    const durations = {};
    for (const [name, stats] of this.durations) {
      durations[name] = {
        count: stats.count,
        total: stats.total,
        max: stats.max,
        last: stats.last,
        mean: stats.count > 0 ? stats.total / stats.count : 0
      };
    }
    const maxima = Object.fromEntries(this.maxima);
    const rpcEventsProcessed = counters.rpcEventsProcessed ?? 0;

    return {
      enabled: this.enabled,
      elapsedMs,
      counters,
      durations,
      maxima,
      metrics: {
        rpcEventsProcessed,
        rpcEventsPerSecond: elapsedMs > 0 ? (rpcEventsProcessed * 1000) / elapsedMs : 0,
        maxDrainDuration: durations.drain?.max ?? 0,
        maxEventDuration: durations.event?.max ?? 0,
        maxJsonParseDuration: durations.jsonParse?.max ?? 0,
        maxJsonLineBytes: maxima.jsonLineBytes ?? 0,
        yieldCount: counters.yieldCount ?? 0,
        yieldLatency: durations.yield?.max ?? 0,
        maxToolLookupDuration: durations.toolLookup?.max ?? 0,
        maxNormalizeDuration: durations.normalize?.max ?? 0,
        maxRunStateDuration: durations.runState?.max ?? 0,
        diagnosticBufferSize: maxima.diagnosticsSize ?? 0,
        // PATCH 3 streaming rendering metrics (spec §6.9).
        streamDeltaCount: counters.streamDeltaCount ?? 0,
        streamFlushCount: counters.streamFlushCount ?? 0,
        markdownRenderCount: counters.markdownRenderCount ?? 0,
        maxUiCallbackDuration: durations.uiCallback?.max ?? 0,
        maxStreamFlushDuration: durations.streamFlush?.max ?? 0,
        // PATCH 4 activity coalescing + stale callback metrics (spec §7.6).
        activityFlushCount: counters.activityFlushCount ?? 0,
        activityCoalescedEvents: counters.activityCoalescedEvents ?? 0,
        activityCoalescedFlushes: counters.activityCoalescedFlushes ?? 0,
        maxActivityUpdateDuration: durations.activityUpdate?.max ?? 0,
        staleCallbackPrevented: counters.staleCallbackPrevented ?? 0,
        // PATCH 5 queue + heap metrics (spec §8.1).
        maxRpcQueueDepth: maxima.rpcQueueDepth ?? 0,
        maxRpcQueueBytes: maxima.rpcQueueBytes ?? 0,
        heapUsedBefore: this.heap.before ?? 0,
        heapUsedDuring: this.heap.during ?? 0,
        heapUsedAfter: this.heap.after ?? 0
      }
    };
  }
}

export const performanceProfiler = new PerformanceProfiler();
