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
    this.startedAt = Date.now();
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
        retainedEvents: maxima.retainedEvents ?? 0
      }
    };
  }
}

export const performanceProfiler = new PerformanceProfiler();
