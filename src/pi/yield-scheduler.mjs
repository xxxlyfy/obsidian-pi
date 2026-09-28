// Cooperative yield scheduler for the RPC stdout drain (spec PATCH 1 §4.3-4.4).
//
// Strategy is chosen once at construction, following the PATCH 0 runtime spike
// (perf/baseline.md):
//   1. scheduler.yield()  - primary (Chromium 150; p95 0.1ms, priority continuation OK)
//   2. MessageChannel     - fallback (reuses one channel for all yields)
//   3. setTimeout(0)      - last resort (clamped, ~15ms median in Obsidian)
//
// The channel is created lazily on first use and is owned by this scheduler:
// dispose() closes it and resolves any pending yield callbacks.

import { performanceProfiler } from "../shared/performance-profiler.mjs";

function defaultChannelFactory() {
  return typeof globalThis.MessageChannel === "function"
    ? () => new globalThis.MessageChannel()
    : undefined;
}

export class YieldScheduler {
  constructor(options = {}) {
    this.scheduler = "scheduler" in options ? options.scheduler : globalThis.scheduler;
    this.channelFactory =
      "channelFactory" in options ? options.channelFactory : defaultChannelFactory();
    this.timeoutHost = options.timeoutHost ?? globalThis;
    this.forceStrategy = options.strategy;
    this.disposed = false;
    this.channel = undefined;
    this.pendingYields = [];
    this.strategy = this.resolveStrategy();
  }

  resolveStrategy() {
    if (this.forceStrategy) return this.forceStrategy;
    if (typeof this.scheduler?.yield === "function") return "scheduler";
    if (typeof this.channelFactory === "function") return "message-channel";
    return "timeout";
  }

  async yield() {
    if (this.disposed) return;
    const profiler = performanceProfiler;
    const startedAt = globalThis.performance.now();
    try {
      if (this.strategy === "scheduler") {
        await this.scheduler.yield();
      } else if (this.strategy === "message-channel") {
        await this.channelYield();
      } else {
        await this.timeoutYield();
      }
    } catch {
      await this.timeoutYield();
    }
    if (profiler.enabled) {
      profiler.incrementCounter("yieldCount");
      profiler.recordDuration("yield", globalThis.performance.now() - startedAt);
    }
  }

  channelYield() {
    if (this.disposed) return Promise.resolve();
    const channel = this.getChannel();
    if (!channel) return this.timeoutYield();

    return new Promise((resolve) => {
      this.pendingYields.push(resolve);
      channel.port2.postMessage(0);
    });
  }

  getChannel() {
    if (this.channel || typeof this.channelFactory !== "function") return this.channel;
    const channel = this.channelFactory();
    channel.port1.onmessage = () => {
      const resolve = this.pendingYields.shift();
      resolve?.();
    };
    this.channel = channel;
    return channel;
  }

  timeoutYield() {
    return new Promise((resolve) => {
      this.timeoutHost.setTimeout(resolve, 0);
    });
  }

  dispose() {
    this.disposed = true;
    if (this.channel) {
      try {
        this.channel.port1.onmessage = null;
        this.channel.port1.close?.();
        this.channel.port2.close?.();
      } catch {
        // Channel already closed.
      }
      this.channel = undefined;
    }
    for (const resolve of this.pendingYields.splice(0)) resolve();
  }
}
