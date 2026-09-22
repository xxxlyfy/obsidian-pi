import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginStore } from "../src/persistence/plugin-store.mjs";

const tempDirs = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

async function createTempDir() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-agent-store-"));
  tempDirs.push(dir);
  return dir;
}

function history() {
  return {
    currentThreadId: "t1",
    threads: [{ id: "t1", title: "T", messages: [], createdAt: 1, updatedAt: 1 }]
  };
}

function createStore({ dir, saveData, onSaveError } = {}) {
  const state = { value: 0 };
  const writes = [];
  const store = new PluginStore({
    loadData: async () => state,
    saveData: async (data) => {
      if (saveData) return saveData(data, writes.length);
      writes.push(JSON.parse(JSON.stringify(data)));
    },
    getPluginDirectory: () => dir,
    buildPayload: () => ({ value: state.value, chatHistory: history() }),
    onSaveError,
    flushDelayMs: 250
  });
  return { store, state, writes };
}

describe("PluginStore", () => {
  it("coalesces a burst of scheduled writes into one write", async () => {
    const dir = await createTempDir();
    const { store, state, writes } = createStore({ dir });

    state.value = 1;
    store.schedule();
    state.value = 2;
    store.schedule();
    state.value = 3;
    store.schedule();
    expect(writes).toHaveLength(0);
    expect(store.hasPendingWrite).toBe(true);

    await vi.advanceTimersByTimeAsync(250);
    await store.flush();

    expect(writes).toEqual([{ value: 3, chatHistory: history() }]);
    expect(store.hasPendingWrite).toBe(false);
  });

  it("writes immediately on saveNow and cancels the pending timer", async () => {
    const dir = await createTempDir();
    const { store, state, writes } = createStore({ dir });

    state.value = 1;
    store.schedule();
    state.value = 2;
    await store.saveNow();
    await vi.advanceTimersByTimeAsync(500);

    expect(writes).toEqual([{ value: 2, chatHistory: history() }]);
  });

  it("never writes concurrently and always writes the latest snapshot", async () => {
    const dir = await createTempDir();
    const writes = [];
    let releaseFirst;
    let inFlight = 0;
    let maxInFlight = 0;
    const { store, state } = createStore({
      dir,
      saveData: async (data) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (writes.length === 0) await new Promise((resolve) => (releaseFirst = resolve));
        writes.push(JSON.parse(JSON.stringify(data)));
        inFlight -= 1;
      }
    });

    state.value = 1;
    const first = store.saveNow();
    state.value = 2;
    store.schedule();
    releaseFirst();
    await first;
    await store.flush();

    expect(maxInFlight).toBe(1);
    expect(writes.map((write) => write.value)).toEqual([1, 2]);
  });

  it("flush writes a mutation that landed while a write was in flight", async () => {
    const dir = await createTempDir();
    const writes = [];
    let releaseFirst;
    const { store, state } = createStore({
      dir,
      saveData: async (data) => {
        if (writes.length === 0) await new Promise((resolve) => (releaseFirst = resolve));
        writes.push(JSON.parse(JSON.stringify(data)));
      }
    });

    state.value = 1;
    void store.saveNow();
    state.value = 2;
    store.schedule();
    releaseFirst();
    await store.flush();

    expect(writes.at(-1)).toMatchObject({ value: 2 });
    expect(store.hasPendingWrite).toBe(false);
  });

  it("does not write anything when nothing is pending", async () => {
    const dir = await createTempDir();
    const { store, writes } = createStore({ dir });

    await store.flush();

    expect(writes).toEqual([]);
  });

  it("rejects saveNow failures but reports scheduled and flushed failures", async () => {
    const dir = await createTempDir();
    const errors = [];
    const failure = new Error("disk full");
    const { store } = createStore({
      dir,
      saveData: async () => {
        throw failure;
      },
      onSaveError: (error) => errors.push(error)
    });

    await expect(store.saveNow()).rejects.toBe(failure);

    store.schedule();
    await vi.advanceTimersByTimeAsync(250);
    expect(errors).toEqual([failure]);

    await expect(store.flush()).resolves.toBeUndefined();
    expect(store.hasPendingWrite).toBe(false);
  });

  it("keeps the checksummed backup in sync and can restore from it", async () => {
    const dir = await createTempDir();
    const { store, state } = createStore({ dir });

    state.value = 1;
    await store.saveNow();

    await expect(store.readBackupHistory()).resolves.toEqual(history());
    await expect(store.load()).resolves.toEqual({ value: 1 });
  });

  it("returns empty data when the plugin has no stored state", async () => {
    const dir = await createTempDir();
    const store = new PluginStore({
      loadData: async () => undefined,
      saveData: async () => {},
      getPluginDirectory: () => dir,
      buildPayload: () => ({ chatHistory: history() })
    });

    await expect(store.load()).resolves.toEqual({});
  });

  it("cancels the pending timer on dispose", async () => {
    const dir = await createTempDir();
    const { store, writes } = createStore({ dir });

    store.schedule();
    store.dispose();
    await vi.advanceTimersByTimeAsync(500);

    expect(writes).toEqual([]);
    expect(store.hasPendingWrite).toBe(false);
  });
});
