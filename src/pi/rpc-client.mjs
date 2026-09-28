import { execFileSync, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import { performanceProfiler } from "../shared/performance-profiler.mjs";
import { YieldScheduler } from "./yield-scheduler.mjs";
import { buildPiProcessInvocation, findPiExecutable } from "./environment.mjs";
import { createPiCliError, formatPiCliFailure } from "./diagnostics.mjs";
import { isExtensionUiDialog, isExtensionUiMethod } from "./extension-ui.mjs";
import { MINIMUM_PI_VERSION } from "./health.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// PATCH 1 bounded drain budgets (spec initial values: 32-64 events / 4-8ms).
const DRAIN_BATCH_MAX_EVENTS = 64;
const DRAIN_BATCH_MAX_MS = 6;
const nodeTimerHost = { setTimeout: setNodeTimeout, clearTimeout: clearNodeTimeout };

function resolveActiveWindow() {
  return typeof window === "undefined" ? undefined : (window.activeWindow ?? window);
}
const UNSUPPORTED_COMMAND_PATTERNS = [
  /unknown (?:rpc )?command/i,
  /unsupported (?:rpc )?command/i,
  /command .+ (?:is )?not supported/i,
  /invalid command type/i
];

export function isUnsupportedPiRpcCommandError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return UNSUPPORTED_COMMAND_PATTERNS.some((pattern) => pattern.test(message));
}

export function formatPiCapabilityFailure(command, error) {
  const detail = error instanceof Error ? error.message : String(error || "Unknown RPC error.");
  return `Installed Pi does not provide the required RPC capability \`${command}\`. Pi Agent requires Pi ${MINIMUM_PI_VERSION} or newer; upgrade Pi and retry. (${detail})`;
}

/**
 * Persistent client for Pi's LF-delimited RPC protocol.
 * One client owns one Pi process/session and processes one agent run at a time.
 */
export class PiRpcClient {
  constructor(options = {}) {
    this.options = options;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.stderr = "";
    this.stdoutBuffer = "";
    this.decoder = new StringDecoder("utf8");
    this.timerHost = options.hostWindow;
    this.disposed = false;
    this.yieldScheduler = options.yieldScheduler ?? new YieldScheduler();
    this.drainBudget = {
      maxEvents: options.drainBudget?.maxEvents ?? DRAIN_BATCH_MAX_EVENTS,
      maxMs: options.drainBudget?.maxMs ?? DRAIN_BATCH_MAX_MS
    };
    this.generation = 0;
    this.drainPending = false;
    this.drainPromise = undefined;
    this.stdoutEnded = false;
  }

  get running() {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start() {
    if (this.disposed) throw new Error("Pi RPC client is disposed.");
    if (this.running) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise((resolve, reject) => {
      const piExecutable = findPiExecutable(this.options.piExecutablePath);
      const invocation = buildPiProcessInvocation(
        piExecutable,
        this.options.args ?? ["--mode", "rpc"],
        {
          cwd: this.options.cwd,
          detached: process.platform !== "win32"
        }
      );
      const child = spawn(invocation.command, invocation.args, invocation.options);
      this.child = child;
      this.stderr = "";
      this.stdoutBuffer = "";
      this.decoder = new StringDecoder("utf8");
      this.generation += 1;
      this.stdoutEnded = false;
      this.drainPending = false;
      this.drainPromise = undefined;

      let started = false;
      const failStart = (error) => {
        if (started) return;
        started = true;
        this.startPromise = undefined;
        reject(error);
      };

      child.once("spawn", () => {
        if (started) return;
        started = true;
        this.startPromise = undefined;
        resolve();
      });
      child.stdout.on("data", (chunk) => this.handleStdoutChunk(chunk));
      child.stdout.on("end", () => this.flushDecoder());
      child.stderr.on("data", (chunk) => {
        this.stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => {
        const normalized = createPiCliError({ error });
        failStart(normalized);
        this.handleExit(normalized);
      });
      child.once("close", async (exitCode) => {
        if (this.child === child) this.child = undefined;
        // Deliver buffered lines from this process before reporting exit, so
        // trailing agent events are not lost behind rpc_exit.
        await this.whenDrainIdle();
        if (this.disposed) return;
        const error = new Error(
          formatPiCliFailure({ context: "Pi RPC process stopped", stderr: this.stderr, exitCode })
        );
        failStart(error);
        this.handleExit(error);
      });
    });

    return this.startPromise;
  }

  async request(type, payload = {}, options = {}) {
    if (!this.running) await this.start();
    if (!this.child?.stdin?.writable) throw new Error("Pi RPC stdin is not writable.");

    const id = `obsidian-pi-${this.nextRequestId++}`;
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const command = { id, type, ...payload };

    return new Promise((resolve, reject) => {
      const timerHost = this.timerHost ?? resolveActiveWindow() ?? nodeTimerHost;
      const timeout =
        timeoutMs > 0
          ? timerHost.setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Pi RPC ${type} timed out after ${timeoutMs}ms.`));
            }, timeoutMs)
          : undefined;

      this.pending.set(id, {
        type,
        resolve: (response) => {
          if (timeout) timerHost.clearTimeout(timeout);
          response.success
            ? resolve(response.data)
            : reject(new Error(response.error || `Pi RPC ${type} failed.`));
        },
        reject: (error) => {
          if (timeout) timerHost.clearTimeout(timeout);
          reject(error);
        }
      });

      this.child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(error);
      });
    });
  }

  /**
   * Probe a version-dependent RPC command. Optional callers can provide a fallback;
   * required callers receive an actionable compatibility error instead of Pi's raw error.
   */
  async requestCapability(type, payload = {}, options = {}) {
    try {
      return { available: true, data: await this.request(type, payload, options) };
    } catch (error) {
      if (!isUnsupportedPiRpcCommandError(error)) throw error;
      const diagnostic = formatPiCapabilityFailure(type, error);
      if (!Object.hasOwn(options, "fallback")) throw new Error(diagnostic, { cause: error });
      return { available: false, data: options.fallback, diagnostic };
    }
  }

  notify(type, payload = {}) {
    if (!this.child?.stdin?.writable) return false;
    this.child.stdin.write(`${JSON.stringify({ type, ...payload })}\n`);
    return true;
  }

  handleStdoutChunk(chunk) {
    if (this.disposed) return;
    this.stdoutBuffer += this.decoder.write(chunk);
    this.measureQueue();
    this.scheduleDrain();
  }

  flushDecoder() {
    this.stdoutBuffer += this.decoder.end();
    this.stdoutEnded = true;
    this.measureQueue();
    this.scheduleDrain();
  }

  // PATCH 5 §8.1: bounded queue observations (enabled-only; O(chunk) scan).
  measureQueue() {
    const profiler = performanceProfiler;
    if (!profiler.enabled || !this.stdoutBuffer) return;
    const buffer = this.stdoutBuffer;
    let depth = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer.charCodeAt(index) === 10) depth += 1;
    }
    if (buffer.charCodeAt(buffer.length - 1) !== 10) depth += 1;
    profiler.recordMax("rpcQueueDepth", depth);
    profiler.recordMax("rpcQueueBytes", Buffer.byteLength(buffer, "utf8"));
  }

  // PATCH 1: at most one pending drain; new chunks only append to the parser
  // buffer. Batches are bounded by event count and time, and yields happen only
  // between complete JSONL lines (partial lines stay in the buffer).
  scheduleDrain() {
    if (this.disposed || this.drainPending) return;
    this.drainPending = true;
    const generation = this.generation;
    const drain = (async () => {
      while (!this.disposed && generation === this.generation) {
        this.drainBatch();
        if (!this.hasDrainWork()) break;
        await this.yieldScheduler.yield();
      }
    })();
    this.drainPromise = drain;
    const settle = (error) => {
      if (error) console.error("Pi Agent: RPC drain failed", error);
      if (this.drainPromise !== drain) return;
      this.drainPromise = undefined;
      this.drainPending = false;
      // Work can arrive between the loop exit and this microtask; reschedule.
      if (!this.disposed && generation === this.generation && this.hasDrainWork())
        this.scheduleDrain();
    };
    drain.then(
      () => settle(undefined),
      (error) => settle(error)
    );
  }

  drainBatch() {
    const profiler = performanceProfiler;
    const startedAt = globalThis.performance.now();
    let processed = 0;
    while (processed < this.drainBudget.maxEvents) {
      let line;
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex >= 0) {
        line = this.stdoutBuffer.slice(0, newlineIndex);
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      } else if (this.stdoutEnded && this.stdoutBuffer.length > 0) {
        line = this.stdoutBuffer;
        this.stdoutBuffer = "";
      } else {
        break;
      }
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.handleLine(line);
      processed += 1;
      if (globalThis.performance.now() - startedAt >= this.drainBudget.maxMs) break;
    }
    if (profiler.enabled && processed > 0)
      profiler.recordDuration("drain", globalThis.performance.now() - startedAt);
  }

  hasDrainWork() {
    if (this.stdoutBuffer.includes("\n")) return true;
    return this.stdoutEnded && this.stdoutBuffer.length > 0;
  }

  async whenDrainIdle() {
    while (this.drainPromise) {
      const current = this.drainPromise;
      try {
        await current;
      } catch {
        // Drain failures are reported by scheduleDrain().
      }
      if (this.drainPromise === current) return;
    }
  }

  handleLine(line) {
    if (!line.trim()) return;
    // PATCH 5 §9: measure the unavoidable single JSON.parse and the raw line
    // size on the object path too (enabled-only).
    const profiler = performanceProfiler;
    const profiling = profiler.enabled;
    const parseStartedAt = profiling ? globalThis.performance.now() : 0;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit({ type: "rpc_parse_error", raw: line });
      return;
    }
    if (profiling) {
      profiler.recordMax("jsonLineBytes", Buffer.byteLength(line, "utf8"));
      profiler.recordDuration("jsonParse", globalThis.performance.now() - parseStartedAt);
    }

    if (message.type === "response" && message.id) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        pending.resolve(message);
      }
      return;
    }

    if (message.type === "extension_ui_request") {
      this.handleExtensionUiRequest(message);
      return;
    }

    this.emit(message);
  }

  async handleExtensionUiRequest(request) {
    const method = String(request.method ?? "");
    try {
      if (!isExtensionUiMethod(method))
        throw new Error(`Unsupported Pi extension UI method: ${method || "unknown"}`);
      const response = await this.options.extensionUiHandler?.(request);
      if (isExtensionUiDialog(method)) {
        this.notify("extension_ui_response", {
          id: request.id,
          ...(response ?? { cancelled: true })
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isExtensionUiDialog(method))
        this.notify("extension_ui_response", { id: request.id, cancelled: true });
      this.emit({ type: "extension_ui_error", method, error: message, request });
    }
  }

  emit(message) {
    for (const listener of [...this.listeners]) {
      try {
        listener(message);
      } catch (error) {
        console.error("Pi Agent: RPC event listener failed", error);
      }
    }
  }

  handleExit(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.emit({ type: "rpc_exit", error: error.message });
  }

  async abort() {
    if (!this.running) return;
    try {
      await this.request("abort", {}, { timeoutMs: 5_000 });
    } catch {
      this.terminate();
    }
  }

  terminate(signal = "SIGTERM") {
    const child = this.child;
    if (!child) return;
    try {
      if (process.platform === "win32" && child.pid) {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          timeout: 2_000,
          windowsHide: true
        });
      } else if (child.pid) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Process already exited.
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.generation += 1;
    this.terminate();
    this.listeners.clear();
    this.yieldScheduler.dispose();
    const error = new Error("Pi RPC client disposed.");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
