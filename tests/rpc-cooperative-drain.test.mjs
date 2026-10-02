import { afterEach, describe, expect, it, vi } from "vitest";
import { PiRpcClient } from "../src/pi/rpc-client.mjs";

const clients = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

function createClient(options = {}) {
  const yieldSpy = vi.fn(async () => {});
  const disposeSpy = vi.fn();
  const client = new PiRpcClient({
    yieldScheduler: { yield: yieldSpy, dispose: disposeSpy },
    drainBudget: { maxEvents: 25, maxMs: 10_000 },
    ...options
  });
  clients.push(client);
  return { client, yieldSpy, disposeSpy };
}

function feed(client, lines, chunkSize) {
  const bytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    client.handleStdoutChunk(bytes.subarray(offset, offset + chunkSize), client.streamState);
  }
}

function noticeLines(count) {
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(JSON.stringify({ type: "notice", n: index }));
  }
  return lines;
}

describe("PiRpcClient cooperative drain", () => {
  it("drains a 1,000 event burst without loss, duplication, or reordering", async () => {
    const { client, yieldSpy } = createClient();
    const events = [];
    client.subscribe((event) => events.push(event));
    const resolve = vi.fn();
    client.pending.set("req-burst", { resolve, reject: vi.fn() });

    const lines = noticeLines(1000);
    lines.splice(
      500,
      0,
      JSON.stringify({ id: "req-burst", type: "response", success: true, data: { ok: true } })
    );
    feed(client, lines, 4096);
    await client.whenDrainIdle(client.streamState);

    const notices = events.filter((event) => event.type === "notice");
    expect(notices).toHaveLength(1000);
    expect(notices.map((event) => event.n)).toEqual(
      Array.from({ length: 1000 }, (_, index) => index)
    );
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: { ok: true } })
    );
    expect(yieldSpy.mock.calls.length).toBeGreaterThanOrEqual(Math.floor(1000 / 25) - 1);
  });

  it("drains a 10,000 event burst and yields repeatedly", async () => {
    const { client, yieldSpy } = createClient({
      drainBudget: { maxEvents: 50, maxMs: 10_000 }
    });
    const events = [];
    client.subscribe((event) => events.push(event));

    feed(client, noticeLines(10_000), 65_536);
    await client.whenDrainIdle(client.streamState);

    const notices = events.filter((event) => event.type === "notice");
    expect(notices).toHaveLength(10_000);
    expect(new Set(notices.map((event) => event.n)).size).toBe(10_000);
    expect(notices[0].n).toBe(0);
    expect(notices.at(-1).n).toBe(9_999);
    expect(yieldSpy.mock.calls.length).toBeGreaterThanOrEqual(Math.floor(10_000 / 50) - 1);
  });

  it("honors the time budget between complete lines", async () => {
    const { client, yieldSpy } = createClient({
      drainBudget: { maxEvents: 1000, maxMs: 0 }
    });
    const events = [];
    client.subscribe((event) => events.push(event));

    feed(client, noticeLines(10), 4096);
    await client.whenDrainIdle(client.streamState);

    expect(events).toHaveLength(10);
    expect(yieldSpy.mock.calls.length).toBeGreaterThanOrEqual(9);
  });

  it("preserves multi-byte characters split across stdout chunks", async () => {
    const { client } = createClient();
    const events = [];
    client.subscribe((event) => events.push(event));

    const text = "abc中def";
    const bytes = Buffer.from(`${JSON.stringify({ type: "notice", text })}\n`, "utf8");
    const splitAt = bytes.indexOf(Buffer.from("中", "utf8")) + 1;

    client.handleStdoutChunk(bytes.subarray(0, splitAt), client.streamState);
    client.handleStdoutChunk(bytes.subarray(splitAt), client.streamState);
    await client.whenDrainIdle(client.streamState);

    expect(events).toEqual([{ type: "notice", text }]);
  });

  it("keeps partial JSON lines across chunks and parses them once complete", async () => {
    const { client } = createClient();
    const events = [];
    client.subscribe((event) => events.push(event));

    const bytes = Buffer.from(
      `${JSON.stringify({ type: "notice", text: "hello 世界" })}\n`,
      "utf8"
    );
    const middle = Math.floor(bytes.length / 2);

    client.handleStdoutChunk(bytes.subarray(0, middle), client.streamState);
    await client.whenDrainIdle(client.streamState);
    expect(events).toEqual([]);

    client.handleStdoutChunk(bytes.subarray(middle), client.streamState);
    await client.whenDrainIdle(client.streamState);
    expect(events).toEqual([{ type: "notice", text: "hello 世界" }]);
  });

  it("stops delivering events and disposes the scheduler when disposed mid-backlog", async () => {
    const { client, disposeSpy } = createClient({
      drainBudget: { maxEvents: 5, maxMs: 10_000 }
    });
    const events = [];
    client.subscribe((event) => events.push(event));

    feed(client, noticeLines(5000), 65_536);
    const deliveredBeforeDispose = events.length;

    client.dispose();
    await client.whenDrainIdle(client.streamState);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(events.length).toBe(deliveredBeforeDispose);
    expect(client.streamState.drainPending).toBe(false);
  });
});
