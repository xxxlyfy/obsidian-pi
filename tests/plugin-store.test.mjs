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

  it("keeps the newest mutation pending when a write fails mid-flight", async () => {
    const dir = await createTempDir();
    const writes = [];
    let fail = true;
    const { store, state } = createStore({
      dir,
      saveData: async (data) => {
        writes.push(data.value);
        if (fail) throw new Error("disk full");
      }
    });

    state.value = "A";
    const first = store.saveNow();
    state.value = "B";
    store.schedule();
    await expect(first).rejects.toThrow("disk full");

    expect(store.hasPendingWrite).toBe(true);

    fail = false;
    await store.flush();

    expect(writes.at(-1)).toBe("B");
    expect(store.hasPendingWrite).toBe(false);
  });

  it("survives repeated failures and recovers on the next success", async () => {
    const dir = await createTempDir();
    const events = [];
    let remainingFailures = 3;
    const store = new PluginStore({
      loadData: async () => ({}),
      saveData: async () => {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error(`failure ${remainingFailures}`);
        }
        events.push("saved");
      },
      getPluginDirectory: () => dir,
      buildPayload: () => ({ value: 1, chatHistory: history() }),
      onSaved: () => events.push("saved-hook"),
      onSaveError: () => events.push("error")
    });

    // Scheduled writes report failures through onSaveError; each failure has to
    // keep the snapshot pending instead of clearing the dirty flag.
    for (let attempt = 0; attempt < 3; attempt++) {
      store.schedule();
      await vi.advanceTimersByTimeAsync(250);
      expect(store.hasPendingWrite).toBe(true);
    }
    expect(events).toEqual(["error", "error", "error"]);

    // The final attempt succeeds and clears the pending state exactly once.
    await store.flush();

    expect(events).toEqual(["error", "error", "error", "saved", "saved-hook"]);
    expect(store.hasPendingWrite).toBe(false);
  });

  it("coalesces 100 streamed mutations into a single write", async () => {
    const dir = await createTempDir();
    const { store, state, writes } = createStore({ dir });

    for (let index = 0; index < 100; index++) {
      state.value = index;
      store.schedule();
    }
    await vi.advanceTimersByTimeAsync(250);
    await store.flush();

    expect(writes).toHaveLength(1);
    expect(writes[0].value).toBe(99);
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
        console.log(
          "WRITE",
          data.value,
          "rev",
          store.pendingRevision,
          "dirty",
          store.dirty,
          "timer",
          store.timer !== undefined
        );
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

    // Invariants: writes never overlap, never regress to an older snapshot,
    // and the last write carries the newest state.
    expect(maxInFlight).toBe(1);
    expect(writes.at(-1).value).toBe(2);
    const values = writes.map((write) => write.value);
    expect(values).toEqual([...values].sort((left, right) => left - right));
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

  it("never persists an older snapshot over a newer one", async () => {
    const dir = await createTempDir();
    const writes = [];
    let releaseFirst;
    let inFlight = 0;
    const { store, state } = createStore({
      dir,
      saveData: async (data) => {
        inFlight += 1;
        if (writes.length === 0) await new Promise((resolve) => (releaseFirst = resolve));
        writes.push({ value: data.value, inFlight });
        inFlight -= 1;
      }
    });

    // A: scheduled, B: scheduled, then a write starts while C lands.
    state.value = "A";
    store.schedule();
    state.value = "B";
    store.schedule();
    await vi.advanceTimersByTimeAsync(250);
    state.value = "C";
    store.schedule();

    releaseFirst();
    await store.flush();

    expect(writes.at(-1).value).toBe("C");
    expect(writes.every((write) => write.inFlight === 1)).toBe(true);
    expect(writes.map((write) => write.value)).not.toContain("A");
  });

  it("calls onSaved after each successful write and onSaveError when it fails", async () => {
    const dir = await createTempDir();
    const saved = [];
    let failing = false;
    const store = new PluginStore({
      loadData: async () => ({}),
      saveData: async () => {
        if (failing) throw new Error("disk full");
      },
      getPluginDirectory: () => dir,
      buildPayload: () => ({ value: 1, chatHistory: history() }),
      onSaved: () => saved.push("saved"),
      onSaveError: () => saved.push("error")
    });

    await store.saveNow();
    expect(saved).toEqual(["saved"]);

    // saveNow reports to its caller; scheduled and flushed writes report
    // through onSaveError.
    failing = true;
    await expect(store.saveNow()).rejects.toThrow("disk full");
    store.schedule();
    await vi.advanceTimersByTimeAsync(250);
    expect(saved).toEqual(["saved", "error"]);

    // The next successful write clears the failure streak.
    failing = false;
    await store.saveNow();
    expect(saved).toEqual(["saved", "error", "saved"]);
  });

  it("keeps the save successful when only the chat-history backup fails", async () => {
    const dir = await createTempDir();
    const events = [];
    const store = new PluginStore({
      loadData: async () => ({}),
      saveData: async () => events.push("data"),
      getPluginDirectory: () => dir,
      buildPayload: () => ({
        value: 1,
        chatHistory: { currentThreadId: "broken", threads: "nope" }
      }),
      onSaved: () => events.push("saved"),
      onSaveError: () => events.push("save-error"),
      onBackupError: () => events.push("backup-error")
    });

    await store.saveNow();

    expect(events).toEqual(["data", "backup-error", "saved"]);
  });

  it("does not attempt the backup when data.json itself fails", async () => {
    const dir = await createTempDir();
    const events = [];
    const store = new PluginStore({
      loadData: async () => ({}),
      saveData: async () => {
        events.push("data");
        throw new Error("disk full");
      },
      getPluginDirectory: () => dir,
      buildPayload: () => ({ value: 1, chatHistory: history() }),
      onSaved: () => events.push("saved"),
      onBackupError: () => events.push("backup-error")
    });

    await expect(store.saveNow()).rejects.toThrow("disk full");

    expect(events).toEqual(["data"]);
    expect(await fs.promises.readdir(dir)).toEqual([]);
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
    let failing = true;
    const { store, state } = createStore({
      dir,
      saveData: async (data) => {
        if (failing) throw failure;
        writes.push(data);
      },
      onSaveError: (error) => errors.push(error)
    });
    const writes = [];

    // Case A: a failed saveNow keeps the snapshot pending for a later retry.
    await expect(store.saveNow()).rejects.toBe(failure);
    expect(store.hasPendingWrite).toBe(true);

    store.schedule();
    await vi.advanceTimersByTimeAsync(250);
    expect(errors).toEqual([failure]);

    // The failed snapshot stays pending: flushing retries it with the newest state.
    failing = false;
    state.value = 7;
    store.schedule();
    await store.flush();

    expect(writes).toEqual([expect.objectContaining({ value: 7 })]);
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

  it("cancels the pending timer on dispose without pretending the data is saved", async () => {
    const dir = await createTempDir();
    const { store, writes } = createStore({ dir });

    store.schedule();
    store.dispose();
    await vi.advanceTimersByTimeAsync(500);

    expect(writes).toEqual([]);
    // dispose() is local cleanup only: the mutation is still unsaved, which is
    // why the plugin flushes at unload instead of relying on dispose.
    expect(store.hasPendingWrite).toBe(true);
  });
});
