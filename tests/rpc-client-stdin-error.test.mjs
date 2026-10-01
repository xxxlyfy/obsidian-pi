// Stdin write failure regression tests for PiRpcClient.
//
// Failure under test: a write to a child that has already exited fails with
// EPIPE. Node reports that one failure twice - to the write callback and as an
// 'error' event on `child.stdin` - and an 'error' event without a listener is
// thrown as an uncaught exception. The write callback rejected the request that
// lost the race, but the emitted event still escaped the request's promise and
// killed the whole host process. In the rename path that raced the early exit of
// a Pi launcher which stops right after the client starts
// (tests/thread-rename-runner-lifecycle.test.mjs), so one failed rename RPC
// surfaced as an unhandled error that failed the entire vitest run.
//
// The stdin here is a real Writable whose `_write` fails, so the callback and
// the event arrive through Node's own machinery instead of a hand-rolled emit.

import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the module mock below can reach it. `create` is assigned after the
// fake child class is declared; spawn() only runs inside tests.
const spawnRegistry = vi.hoisted(() => ({ create: undefined, children: [] }));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    spawn: (...args) => {
      const child = spawnRegistry.create(...args);
      spawnRegistry.children.push(child);
      return child;
    }
  };
});

import { PiRpcClient } from "../src/pi/rpc-client.mjs";

/** A stdin pipe that fails every write the way a closed pipe does. */
function createFailedStdin() {
  return new Writable({
    write(_chunk, _encoding, callback) {
      const error = new Error("write EPIPE");
      error.code = "EPIPE";
      callback(error);
    }
  });
}

/**
 * Deterministic stand-in for a spawned Pi process whose stdin is already gone:
 * no pid (so terminateProcessTree() falls back to child.kill()), LF-framed
 * stdout nobody writes to, and a real failing stdin.
 */
class ExitedPiChild extends EventEmitter {
  constructor() {
    super();
    this.pid = undefined;
    this.exitCode = null;
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = createFailedStdin();
  }

  /** @param {string} _signal */
  kill(_signal) {
    this.killed = true;
  }
}

spawnRegistry.create = () => {
  const child = new ExitedPiChild();
  // Node emits 'spawn' asynchronously, after start() registered its listeners.
  Promise.resolve().then(() => child.emit("spawn"));
  return child;
};

const clients = [];

beforeEach(() => {
  spawnRegistry.children.length = 0;
});

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

function createClient() {
  const client = new PiRpcClient({ piExecutablePath: process.execPath, cwd: process.cwd() });
  clients.push(client);
  return client;
}

/** The emitted 'error' arrives on its own tick; the reason is the observable. */
function expectStdinErrorRecorded(client) {
  return vi.waitFor(() => expect(client.stdinError).toMatchObject({ code: "EPIPE" }));
}

describe("PiRpcClient stdin write failures", () => {
  it("rejects the request that raced the child's exit without letting the stdin error escape", async () => {
    const client = createClient();

    const request = client.request("rename_session", {}, { timeoutMs: 0 });
    await expect(request).rejects.toThrow("write EPIPE");

    const child = spawnRegistry.children[0];
    // The client owns the event: this listener is what keeps Node from throwing
    // the emitted 'error' as an uncaught exception.
    expect(child.stdin.listenerCount("error")).toBe(1);
    // The write callback already rejected the request; the reason stays
    // available, and the child's close handler reports the run failure.
    await expectStdinErrorRecorded(client);
    expect(client.pending.size).toBe(0);
  });

  it("records a failed fire-and-forget notification instead of throwing it", async () => {
    const client = createClient();
    await client.start();

    const child = spawnRegistry.children[0];
    // notify() has no callback and no caller to report to, so this write is the
    // one path where nothing else could surface the failure.
    expect(client.notify("extension_ui_response", { id: "dialog-1", cancelled: true })).toBe(true);

    expect(child.stdin.listenerCount("error")).toBe(1);
    await expectStdinErrorRecorded(client);
  });

  it("clears the recorded reason when a replacement child starts", async () => {
    const client = createClient();
    await client.start();
    client.notify("extension_ui_response", { id: "dialog-1", cancelled: true });
    await expectStdinErrorRecorded(client);

    const failedChild = spawnRegistry.children[0];
    // The dead child closes, so the next request may start Pi again.
    failedChild.exitCode = 1;
    failedChild.emit("close", 1);
    expect(client.child).toBeUndefined();

    await client.start();
    expect(client.stdinError).toBeUndefined();
    expect(client.child).not.toBe(failedChild);

    // The replacement gets the same protection, not just a cleared field.
    client.notify("extension_ui_response", { id: "dialog-2", cancelled: true });
    await expectStdinErrorRecorded(client);
  });
});
