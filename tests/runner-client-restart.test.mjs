import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/plugin/settings.mjs";

const state = vi.hoisted(() => ({ instances: [], autoSettle: false }));

vi.mock("../src/pi/rpc-client.mjs", () => {
  class FakePiRpcClient {
    constructor(options) {
      this.options = options;
      this.disposed = false;
      this.listeners = new Set();
      this.child = { pid: state.instances.length + 1, exitCode: null, killed: false };
      state.instances.push(this);
    }

    get running() {
      return !!this.child && !this.disposed;
    }

    async start() {
      if (this.disposed) throw new Error("Pi RPC client is disposed.");
    }

    async request(type) {
      if (this.disposed || !this.child) throw new Error("Pi RPC stdin is not writable.");
      if (type === "prompt" && state.autoSettle) Promise.resolve().then(() => this.settle());
      return {};
    }

    notify() {}

    async abort() {
      this.terminate();
    }

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    settle() {
      for (const listener of this.listeners) listener({ type: "agent_settled" });
    }

    emit(event) {
      for (const listener of this.listeners) listener(event);
    }

    terminate() {
      this.child = undefined;
    }

    dispose() {
      this.disposed = true;
      this.child = undefined;
      for (const listener of this.listeners) listener({ type: "rpc_exit", error: "disposed" });
      this.listeners.clear();
    }
  }
  return { PiRpcClient: FakePiRpcClient };
});

const { PiRunner } = await import("../src/pi/runner.mjs");

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  state.instances.length = 0;
  state.autoSettle = false;
});

function createRunner() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-client-restart-"));
  tempDirs.push(tempDir);
  return new PiRunner(DEFAULT_SETTINGS, { formatPrompt: (prompt) => prompt }, tempDir, tempDir);
}

function callbacks() {
  return { isCanceled: () => false, onEvent: () => {}, onTextDelta: () => {} };
}

describe("runner client identity across force termination", () => {
  it("creates a fresh RPC client for the next run and never reuses the terminated one", async () => {
    const runner = createRunner();

    // Run A builds its own client through the runner's production path.
    state.autoSettle = false;
    const runA = runner.run("A", undefined, undefined, [], callbacks());
    await vi.waitFor(() => expect(state.instances).toHaveLength(1));
    const clientA = state.instances[0];
    expect(runner.rpcClient).toBe(clientA);
    const runAOutcome = runA.catch(() => {});

    runner.forceTerminate();
    expect(clientA.disposed).toBe(true);
    expect(runner.rpcClient).toBeUndefined();

    // Run B must build a different client, not inherit A's stopped process.
    const bDeltas = [];
    const runB = runner.run("B", undefined, undefined, [], {
      isCanceled: () => false,
      onTextDelta: (delta) => bDeltas.push(delta)
    });
    await vi.waitFor(() =>
      expect(state.instances.length === 2 && state.instances[1].listeners.size > 0).toBe(true)
    );
    const clientB = state.instances[1];
    expect(clientB).not.toBe(clientA);
    expect(runner.rpcClient).toBe(clientB);

    // Events on the old client cannot reach the run that owns the new client.
    clientA.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "old" }
    });
    clientA.emit({ type: "agent_settled" });
    expect(bDeltas).toEqual([]);
    expect(runner.isRunning).toBe(true);

    clientB.settle();
    await runB;
    await runAOutcome;
    expect(runner.isRunning).toBe(false);
  });
});
