import { describe, expect, it, vi } from "vitest";
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

function createRunner({ client, autoSettle = false } = {}) {
  const runner = new PiRunner(
    DEFAULT_SETTINGS,
    { formatPrompt: (prompt) => prompt },
    "/vault",
    "/vault/.obsidian/plugins/pi-agent",
    client ?? createFakeClient({ autoSettle })
  );
  return runner;
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
