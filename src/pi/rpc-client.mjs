import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import { performanceProfiler } from "../shared/performance-profiler.mjs";
import { terminateProcessTree } from "../shared/process-tree.mjs";
import { now, resolveActiveWindow } from "../shared/runtime.mjs";
import { YieldScheduler } from "./yield-scheduler.mjs";
import { buildPiProcessInvocation, findPiExecutable } from "./environment.mjs";
import { createPiCliError, formatPiCliFailure } from "./diagnostics.mjs";
import { isExtensionUiDialog, isExtensionUiMethod } from "./extension-ui.mjs";
import { MINIMUM_PI_VERSION } from "./health.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// Bounded drain budgets for one cooperative batch (64 events or 6ms, whichever
// comes first) so a burst of Pi output cannot block the Obsidian UI thread.
const DRAIN_BATCH_MAX_EVENTS = 64;
const DRAIN_BATCH_MAX_MS = 6;
const nodeTimerHost = { setTimeout: setNodeTimeout, clearTimeout: clearNodeTimeout };

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
 * One child's stdout parser and drain state.
 *
 * `generation` records the child this state belongs to; `buffer`, `decoder`,
 * `stdoutEnded`, `drainPending` and `drainPromise` are that child's alone, which
 * is what lets a replaced child finish draining its own trailing events while a
 * replacement child parses its own stream.
 *
 * @typedef {object} PiRpcStreamState
 * @property {number} generation Generation that owns this state.
 * @property {string} buffer Decoded stdout of this generation, not yet parsed.
 * @property {StringDecoder} decoder Incremental UTF-8 decoder for this generation.
 * @property {boolean} stdoutEnded Whether this generation's stdout reached EOF.
 * @property {boolean} drainPending Whether a drain task is currently scheduled.
 * @property {Promise<void> | undefined} drainPromise The scheduled drain, if any.
 */

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
    this.stdinError = undefined;
    this.timerHost = options.hostWindow;
    this.disposed = false;
    this.yieldScheduler = options.yieldScheduler ?? new YieldScheduler();
    this.drainBudget = {
      maxEvents: options.drainBudget?.maxEvents ?? DRAIN_BATCH_MAX_EVENTS,
      maxMs: options.drainBudget?.maxMs ?? DRAIN_BATCH_MAX_MS
    };
    this.generation = 0;
    // stdout parsing and draining belong to one child, never to the client as a
    // whole: a replacement child must not reset - and therefore lose - whatever
    // an older child still has buffered. `streamState` is the state of the child
    // this client currently owns (generation 0 before the first spawn);
    // `streamStates` keeps a replaced child's state reachable until that child's
    // stream has finished draining.
    this.streamState = this.createStreamState(0);
    this.streamStates = new Map();
  }

  /**
   * Create the stdout parser/drain state of exactly one child generation.
   *
   * Every field is owned by a single child, so a replacement child's `start()`
   * can neither clear an older child's buffered lines nor detach the drain that
   * is still consuming them.
   *
   * @param {number} generation Generation this state belongs to.
   * @returns {PiRpcStreamState} The new, empty state.
   */
  createStreamState(generation) {
    return {
      generation,
      buffer: "",
      decoder: new StringDecoder("utf8"),
      stdoutEnded: false,
      drainPending: false,
      drainPromise: undefined
    };
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
      this.stdinError = undefined;
      this.generation += 1;
      // Bind this child to the generation it owns for the rest of its life.
      // Re-reading this.generation inside the callbacks below would pick up a
      // replacement child's generation, and this child's exit could then reject
      // requests that the replacement child already owns.
      const childGeneration = this.generation;
      // This child's own parser/drain state, captured by every handler below.
      // Nothing here touches an older child's state: a replaced child keeps its
      // buffer and its in-flight drain until it has drained them itself.
      const state = this.createStreamState(childGeneration);
      this.streamState = state;
      this.streamStates.set(childGeneration, state);

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
      child.stdout.on("data", (chunk) => this.handleStdoutChunk(chunk, state));
      child.stdout.on("end", () => this.flushDecoder(state));
      child.stderr.on("data", (chunk) => {
        this.stderr += chunk.toString("utf8");
      });
      // A write to a child that has already exited fails with EPIPE, and Node
      // reports that failure twice: to the write callback in `request()` and as
      // an 'error' event on the stream. The callback rejects the one request that
      // lost the race, but an 'error' event with no listener is thrown as an
      // uncaught exception, which ended the whole run - and the whole host
      // process - instead of failing that request. Keep the reason for
      // diagnostics; the child's close handler still reports the run failure.
      child.stdin?.on?.("error", (error) => {
        this.stdinError = error;
      });
      child.once("error", (error) => {
        const normalized = createPiCliError({ error });
        failStart(normalized);
        this.handleExit(normalized, childGeneration);
      });
      child.once("close", async (exitCode) => {
        if (this.child === child) this.child = undefined;
        // Deliver this child's buffered lines before reporting its exit, so its
        // trailing agent events are not lost behind rpc_exit. Only this child's
        // own drain is awaited here; a replacement child's drain is never
        // involved, and waiting for it would delay this exit behind that child's
        // events.
        await this.whenDrainIdle(state);
        this.streamStates.delete(childGeneration);
        if (this.disposed) return;
        const error = new Error(
          formatPiCliFailure({ context: "Pi RPC process stopped", stderr: this.stderr, exitCode })
        );
        failStart(error);
        this.handleExit(error, childGeneration);
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
        // Ownership marker: handleExit() only fails the generation that exited,
        // so an exit that lands after a replacement child started cannot touch
        // this request.
        generation: this.generation,
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

  /**
   * @param {Buffer} chunk Bytes read from one child's stdout.
   * @param {PiRpcStreamState} state That child's own parser state.
   */
  handleStdoutChunk(chunk, state) {
    if (this.disposed) return;
    state.buffer += state.decoder.write(chunk);
    this.measureQueue(state);
    this.scheduleDrain(state);
  }

  /**
   * stdout reached EOF for one child: flush its decoder and mark only its own
   * stream as ended, so a late `end` from a replaced child cannot reinterpret the
   * replacement child's partial line.
   *
   * @param {PiRpcStreamState} state That child's own parser state.
   */
  flushDecoder(state) {
    state.buffer += state.decoder.end();
    state.stdoutEnded = true;
    this.measureQueue(state);
    this.scheduleDrain(state);
  }

  // Bounded queue observations (enabled-only; O(chunk) scan of buffered lines).
  measureQueue(state) {
    const profiler = performanceProfiler;
    const buffer = state.buffer;
    if (!profiler.enabled || !buffer) return;
    let depth = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer.charCodeAt(index) === 10) depth += 1;
    }
    if (buffer.charCodeAt(buffer.length - 1) !== 10) depth += 1;
    profiler.recordMax("rpcQueueDepth", depth);
    profiler.recordMax("rpcQueueBytes", Buffer.byteLength(buffer, "utf8"));
  }

  // At most one pending drain PER CHILD; new chunks only append to that child's
  // parser buffer. Batches are bounded by event count and time, and yields happen
  // only between complete JSONL lines (partial lines stay in the buffer).
  //
  // The loop is deliberately not gated on `this.generation`: a replaced child
  // still owns the lines in its own buffer, and its close handler is waiting for
  // exactly this drain to finish before it reports the exit. Stopping here on a
  // generation change is what used to drop that child's trailing events.
  scheduleDrain(state) {
    if (this.disposed || state.drainPending) return;
    state.drainPending = true;
    const drain = (async () => {
      while (!this.disposed) {
        this.drainBatch(state);
        if (!this.hasDrainWork(state)) break;
        await this.yieldScheduler.yield();
      }
    })();
    state.drainPromise = drain;
    const settle = (error) => {
      if (error) console.error("Pi Agent: RPC drain failed", error);
      if (state.drainPromise !== drain) return;
      state.drainPromise = undefined;
      state.drainPending = false;
      // Work can arrive between the loop exit and this microtask; reschedule.
      if (!this.disposed && this.hasDrainWork(state)) this.scheduleDrain(state);
    };
    drain.then(
      () => settle(undefined),
      (error) => settle(error)
    );
  }

  drainBatch(state) {
    const profiler = performanceProfiler;
    const startedAt = now();
    let processed = 0;
    while (processed < this.drainBudget.maxEvents) {
      let line;
      const newlineIndex = state.buffer.indexOf("\n");
      if (newlineIndex >= 0) {
        line = state.buffer.slice(0, newlineIndex);
        state.buffer = state.buffer.slice(newlineIndex + 1);
      } else if (state.stdoutEnded && state.buffer.length > 0) {
        line = state.buffer;
        state.buffer = "";
      } else {
        break;
      }
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.handleLine(line);
      processed += 1;
      if (now() - startedAt >= this.drainBudget.maxMs) break;
    }
    if (profiler.enabled && processed > 0) profiler.recordDuration("drain", now() - startedAt);
  }

  hasDrainWork(state) {
    if (state.buffer.includes("\n")) return true;
    return state.stdoutEnded && state.buffer.length > 0;
  }

  /**
   * Wait until the given child's own drain is idle. Reading a client-level slot
   * here would make one generation's close handler wait for another generation's
   * drain.
   *
   * @param {PiRpcStreamState} state The child whose drain must finish.
   */
  async whenDrainIdle(state) {
    while (state.drainPromise) {
      const current = state.drainPromise;
      try {
        await current;
      } catch {
        // Drain failures are reported by scheduleDrain().
      }
      if (state.drainPromise === current) return;
    }
  }

  handleLine(line) {
    if (!line.trim()) return;
    // Measure the unavoidable single JSON.parse and the raw line size
    // (enabled-only).
    const profiler = performanceProfiler;
    const profiling = profiler.enabled;
    const parseStartedAt = profiling ? now() : 0;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit({ type: "rpc_parse_error", raw: line });
      return;
    }
    if (profiling) {
      profiler.recordMax("jsonLineBytes", Buffer.byteLength(line, "utf8"));
      profiler.recordDuration("jsonParse", now() - parseStartedAt);
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

  /**
   * Fail the pending requests owned by one exiting child generation.
   *
   * The generation is a required parameter on purpose: the caller must state
   * which child exited. Reading `this.generation` here would be wrong, because a
   * close/error callback can run after a replacement child already started, and
   * that child's requests must keep waiting for their own responses.
   *
   * @param {Error} error Failure reported to each affected request.
   * @param {number} generation Generation of the child that exited.
   */
  handleExit(error, generation) {
    // Collect first, then delete: only the affected generation leaves the map,
    // and rpc_exit is emitted even when nothing matched.
    const affected = [];
    for (const [id, pending] of this.pending) {
      if (pending.generation === generation) affected.push([id, pending]);
    }
    for (const [id, pending] of affected) {
      this.pending.delete(id);
      pending.reject(error);
    }
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
    terminateProcessTree(this.child, { signal });
  }

  dispose() {
    this.disposed = true;
    this.generation += 1;
    this.terminate();
    this.listeners.clear();
    this.yieldScheduler.dispose();
    // Parked drains wake up on the scheduler dispose above and stop on
    // `disposed`, so every child's state can be released here.
    this.streamStates.clear();
    const error = new Error("Pi RPC client disposed.");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
