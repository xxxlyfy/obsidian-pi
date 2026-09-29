// Cooperative yield scheduler for the RPC stdout drain.
//
// Strategy is chosen once at construction, because the cheapest available
// primitive does not change while the plugin is loaded:
//   1. scheduler.yield()  - primary (priority continuation, sub-millisecond)
//   2. MessageChannel     - fallback (reuses one channel for all yields)
//   3. setTimeout(0)      - last resort (clamped, so the slowest by far)
//
// The channel is created lazily on first use and is owned by this scheduler:
// dispose() closes it and resolves any pending yield callbacks.

import { hostGlobals, now, resolveActiveWindow } from "../shared/runtime.mjs";
import { performanceProfiler } from "../shared/performance-profiler.mjs";

function defaultChannelFactory() {
  const MessageChannelApi = resolveActiveWindow()?.MessageChannel ?? hostGlobals().MessageChannel;
  return typeof MessageChannelApi === "function" ? () => new MessageChannelApi() : undefined;
}

function defaultTimerHost() {
  return resolveActiveWindow() ?? hostGlobals();
}

function defaultScheduler() {
  return resolveActiveWindow()?.scheduler;
}

export class YieldScheduler {
  constructor(options = {}) {
    this.scheduler = "scheduler" in options ? options.scheduler : defaultScheduler();
    this.channelFactory =
      "channelFactory" in options ? options.channelFactory : defaultChannelFactory();
    this.timeoutHost = options.timeoutHost ?? defaultTimerHost();
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
    const startedAt = now();
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
      profiler.recordDuration("yield", now() - startedAt);
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
