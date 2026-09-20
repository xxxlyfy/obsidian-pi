import { describe, expect, it, vi } from "vitest";
import { PiRpcClient } from "../src/pi/rpc-client.mjs";

describe("PiRpcClient protocol framing", () => {
  it("splits records only on LF and preserves Unicode line separators in JSON strings", () => {
    const client = new PiRpcClient();
    const events = [];
    client.subscribe((event) => events.push(event));

    const payload = `${JSON.stringify({ type: "notice", text: "a\u2028b\u2029c" })}\n${JSON.stringify({ type: "agent_settled" })}\n`;
    const bytes = Buffer.from(payload, "utf8");
    client.handleStdoutChunk(bytes.subarray(0, 17));
    client.handleStdoutChunk(bytes.subarray(17, 31));
    client.handleStdoutChunk(bytes.subarray(31));

    expect(events).toEqual([{ type: "notice", text: "a b c" }, { type: "agent_settled" }]);
  });

  it("correlates responses without emitting them as events", () => {
    const client = new PiRpcClient();
    const resolve = vi.fn();
    const events = [];
    client.subscribe((event) => events.push(event));
    client.pending.set("request-1", { resolve, reject: vi.fn() });

    client.handleLine(
      JSON.stringify({
        id: "request-1",
        type: "response",
        command: "get_state",
        success: true,
        data: { isStreaming: false }
      })
    );

    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: { isStreaming: false } })
    );
    expect(client.pending.size).toBe(0);
    expect(events).toEqual([]);
  });

  it("responds to extension dialogs and reports handler failures", async () => {
    const writes = [];
    const client = new PiRpcClient({
      extensionUiHandler: async (request) => {
        if (request.method === "select") return { value: "Allow" };
        throw new Error("unsupported UI");
      }
    });
    client.child = { stdin: { writable: true, write: (line) => writes.push(JSON.parse(line)) } };
    const events = [];
    client.subscribe((event) => events.push(event));

    client.handleLine(
      JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "select" })
    );
    client.handleLine(
      JSON.stringify({ type: "extension_ui_request", id: "ui-2", method: "input" })
    );
    await vi.waitFor(() => expect(writes).toHaveLength(2));

    expect(writes).toEqual([
      { type: "extension_ui_response", id: "ui-1", value: "Allow" },
      { type: "extension_ui_response", id: "ui-2", cancelled: true }
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "extension_ui_error", method: "input" })
    );
  });

  it("emits parse errors without crashing the process", () => {
    const client = new PiRpcClient();
    const events = [];
    client.subscribe((event) => events.push(event));
    client.handleLine("not json");
    expect(events).toEqual([{ type: "rpc_parse_error", raw: "not json" }]);
  });

  it("marks timed out stateful requests as uncertain", async () => {
    const client = new PiRpcClient();
    client.child = {
      exitCode: null,
      killed: false,
      kill: () => {},
      stdin: { writable: true, write: () => {} }
    };

    const error = await client
      .request("prompt", { message: "hello" }, { timeoutMs: 5 })
      .catch((caught) => caught);

    expect(error.piRpcUncertain).toBe(true);
    expect(error.piRpcRequestType).toBe("prompt");
    expect(client.isUncertain()).toBe(true);
  });

  it("does not mark read-only request timeouts as uncertain", async () => {
    const client = new PiRpcClient();
    client.child = {
      exitCode: null,
      killed: false,
      kill: () => {},
      stdin: { writable: true, write: () => {} }
    };

    const error = await client.request("get_state", {}, { timeoutMs: 5 }).catch((caught) => caught);

    expect(error.piRpcUncertain).toBeUndefined();
    expect(client.isUncertain()).toBe(false);
  });

  it("fails in-flight requests and emits an exit event when disposed", async () => {
    const client = new PiRpcClient();
    const events = [];
    client.subscribe((event) => events.push(event));
    client.child = {
      exitCode: null,
      killed: false,
      kill: () => {},
      stdin: { writable: true, write: () => {} }
    };

    const pending = client.request("hang", {}, { timeoutMs: 0 });
    client.dispose();

    await expect(pending).rejects.toThrow("Pi RPC client disposed.");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "rpc_exit", error: "Pi RPC client disposed." })
    );
  });
});
