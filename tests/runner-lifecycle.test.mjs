import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/plugin/settings.mjs";
import { PiRunner } from "../src/pi/runner.mjs";
import { ThreadRunnerRegistry } from "../src/plugin/thread-runners.mjs";

/**
 * Lifecycle fakes modelled on the real contract:
 * - `isRunning` is true while a run is in flight
 * - `cancelCurrentRun()` requests an abort but the run settles later
 * - `forceTerminate()` drops the client and resets the runner
 */
function createFakeClient({ autoSettle = false } = {}) {
  const listeners = new Set();
  const client = {
    disposed: false,
    listeners,
    autoSettle,
    abort: vi.fn(async () => {}),
    terminate: vi.fn(() => {
      client.child = undefined;
    }),
    dispose: vi.fn(() => {
      client.disposed = true;
      client.child = undefined;
      for (const listener of listeners) listener({ type: "rpc_exit", error: "disposed" });
    }),
    start: vi.fn(async () => {
      if (client.disposed) throw new Error("Pi RPC client is disposed.");
      client.child = { pid: 1, exitCode: null, killed: false };
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    settle() {
      for (const listener of listeners) listener({ type: "agent_settled" });
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    async request(type) {
      if (!client.child || client.disposed) throw new Error("Pi RPC stdin is not writable.");
      if (type === "prompt" && client.autoSettle) client.settle();
      return {};
    }
  };
  return client;
}

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A real temp plugin directory: session files must not be written to a fake root. */
function createRunner({ client, autoSettle = false } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-runner-lifecycle-"));
  tempDirs.push(tempDir);
  return new PiRunner(
    DEFAULT_SETTINGS,
    { formatPrompt: (prompt) => prompt },
    tempDir,
    tempDir,
    client ?? createFakeClient({ autoSettle })
  );
}

function callbacks() {
  return { isCanceled: () => false, onEvent: () => {}, onTextDelta: () => {} };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for the expected lifecycle state");
}

/**
 * Starts a run and waits until it is actually streaming, i.e. the runner owns
 * the client and has subscribed to its events. The pending promise is returned
 * inside an object so awaiting the helper never waits for the run itself.
 */
async function startPendingRun(runner, client) {
  const pending = runner.run("prompt", undefined, undefined, [], callbacks());
  await waitFor(() => runner.isRunning === true && client.listeners.size > 0);
  return { pending };
}

describe("runner lifecycle: reuse rules", () => {
  it("Test 1 — a run whose cancel settled makes the runner reusable", async () => {
    const client = createFakeClient();
    const runner = createRunner({ client });

    const { pending } = await startPendingRun(runner, client);
    runner.cancelCurrentRun();
    expect(runner.isRunning).toBe(true);

    client.settle();
    await expect(pending).rejects.toBeInstanceOf(Error);

    expect(runner.isRunning).toBe(false);

    // A later run reuses the same runner and starts the client again.
    client.listeners.clear();
    const next = runner.run("again", undefined, undefined, [], callbacks());
    await waitFor(() => client.start.mock.calls.length === 2 && client.listeners.size > 0);
    client.settle();
    await next;
    expect(runner.isRunning).toBe(false);
  });

  it("Test 2 — a runner with a pending cancellation is not reusable", async () => {
    const client = createFakeClient();
    const runner = createRunner({ client });

    const { pending } = await startPendingRun(runner, client);
    runner.cancelCurrentRun();

    await expect(runner.run("second", undefined, undefined, [], callbacks())).rejects.toThrow(
      "already has an active run"
    );
    await expect(runner.run("/compact", undefined, undefined, [], callbacks())).rejects.toThrow(
      "already has an active run"
    );

    client.settle();
    await pending.catch(() => {});
  });

  it("Test 3 — force termination invalidates the client and leaves the runner reusable", async () => {
    const client = createFakeClient();
    const runner = createRunner({ client });

    const { pending } = await startPendingRun(runner, client);
    runner.forceTerminate();

    // The wedged client is disposed and dropped, so no later run can inherit it.
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(runner.rpcClient).toBeUndefined();
    expect(runner.rpcSession).toBeUndefined();
    expect(runner.isRunning).toBe(false);
    expect(runner.cancelRequested).toBe(false);
    await pending.catch(() => {});

    // Reusable: the guard no longer refuses a new run for this thread.
    expect(() => runner.forceTerminate()).not.toThrow();
    expect(runner.isRunning).toBe(false);
  });

  it("Test 4 — compaction claims the runner like any other run", async () => {
    const client = createFakeClient();
    const runner = createRunner({ client });

    const pending = runner.run("/compact", undefined, undefined, [], callbacks());
    await waitFor(() => runner.isRunning === true);

    await expect(runner.run("normal", undefined, undefined, [], callbacks())).rejects.toThrow(
      "already has an active run"
    );

    client.settle();
    await pending.catch(() => {});
    expect(runner.isRunning).toBe(false);
  });

  it("Test 5a — a late finalizer from a terminated run cannot clear the new run", async () => {
    const first = createFakeClient();
    const runner = createRunner({ client: first });
    const registry = new ThreadRunnerRegistry(() => runner);
    const runnerA = registry.create("t1");
    const runnerB = registry.create("t1");
    expect(runnerA).toBe(runnerB);
    expect(runnerA).toBe(runner);

    const { pending: runA } = await startPendingRun(runner, first);
    // Attach the rejection handler before force termination so the settling run
    // is never an unhandled rejection.
    const runAOutcome = runA.catch(() => {});
    runner.forceTerminate();
    expect(runner.rpcClient).toBeUndefined();

    // Run B starts on the same runner before A's continuation runs.
    const second = createFakeClient();
    runner.rpcClient = second;
    const bDeltas = [];
    const runB = runner.run("B", undefined, undefined, [], {
      isCanceled: () => false,
      onTextDelta: (delta) => bDeltas.push(delta)
    });
    await waitFor(() => runner.isRunning === true && second.listeners.size > 0);

    // A settles late: its finalizer must not mark the runner as idle.
    first.dispose();
    await runAOutcome;
    expect(runner.isRunning).toBe(true);
    expect(runner.cancelRequested).toBe(false);

    // The runner is still owned by B, so a third run is refused.
    await expect(runner.run("C", undefined, undefined, [], callbacks())).rejects.toThrow(
      "already has an active run"
    );

    // Events from A's client must not reach B's callbacks: different clients,
    // different listener sets.
    first.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "old" }
    });
    first.emit({ type: "agent_settled" });
    expect(bDeltas).toEqual([]);

    second.settle();
    await runB;
    expect(runner.isRunning).toBe(false);
  });

  it("Test 5b — the compact path has the same execution ownership", async () => {
    const first = createFakeClient();
    // Keep the compact request pending until released.
    const releases = [];
    first.request = vi.fn(async (type) => {
      if (type === "compact") await new Promise((resolve) => releases.push(resolve));
      return {};
    });
    const runner = createRunner({ client: first });

    const runA = runner.run("/compact", undefined, undefined, [], callbacks());
    await waitFor(() => runner.isRunning === true && first.listeners.size > 0);
    const runAOutcome = runA.catch(() => {});

    runner.forceTerminate();
    expect(runner.isRunning).toBe(false);

    const second = createFakeClient();
    second.request = vi.fn(async (type) => {
      if (type === "compact") await new Promise((resolve) => releases.push(resolve));
      return {};
    });
    runner.rpcClient = second;
    const runB = runner.run("/compact", undefined, undefined, [], callbacks());
    await waitFor(() => runner.isRunning === true && second.listeners.size > 0);

    // A's late finalizer must not release B's ownership.
    releases.shift()?.();
    await runAOutcome;
    expect(runner.isRunning).toBe(true);
    await expect(runner.run("C", undefined, undefined, [], callbacks())).rejects.toThrow(
      "already has an active run"
    );

    releases.shift()?.();
    await runB;
    expect(runner.isRunning).toBe(false);
  });

  it("Test 5 — a dead RPC process does not make the runner permanently unusable", async () => {
    const client = createFakeClient();
    const runner = createRunner({ client });

    const { pending } = await startPendingRun(runner, client);
    // The process dies: the client loses its child and reports rpc_exit.
    client.child = undefined;
    client.emit({ type: "rpc_exit", error: "Pi RPC process stopped." });
    await pending.catch(() => {});

    expect(runner.isRunning).toBe(false);

    // The same client restarts (a fresh process) and serves the next run.
    client.autoSettle = true;
    const next = runner.run("after death", undefined, undefined, [], callbacks());
    await waitFor(() => client.start.mock.calls.length === 2);
    await next;
    expect(runner.isRunning).toBe(false);
  });

  it("Test 6 — the registry keeps handing out a reusable runner after termination", async () => {
    const client = createFakeClient();
    const runner = createRunner({ client });
    const registry = new ThreadRunnerRegistry(() => runner);

    const { pending } = await startPendingRun(runner, client);
    registry.create("t1");
    runner.forceTerminate();
    await pending.catch(() => {});

    const reused = registry.create("t1");
    expect(reused).toBe(runner);
    expect(reusable(reused)).toBe(true);

    registry.dispose("t1");
    expect(registry.get("t1")).toBeUndefined();
  });
});

/** Mirrors the contract `PiRunner.run()` enforces at its entry. */
function reusable(runner) {
  return runner.isRunning !== true;
}
