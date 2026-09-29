// Minimal Chrome DevTools Protocol client for driving the running Obsidian app.
// Text frames only; enough to evaluate JS in the renderer and collect results.
import net from "node:net";
import crypto from "node:crypto";

const HOST = "127.0.0.1";
const PORT = Number(process.env.CDP_PORT || 9222);

async function httpJson(path) {
  const response = await fetch(`http://${HOST}:${PORT}${path}`);
  return response.json();
}

function connectWebSocket(wsUrl) {
  const url = new URL(wsUrl);
  const key = crypto.randomBytes(16).toString("base64");
  const socket = net.connect({ host: url.hostname, port: Number(url.port) });

  let buffer = Buffer.alloc(0);
  const pending = new Map();
  let nextId = 1;
  let handshakeDone = false;
  let onMessage = () => {};

  const decodeFrames = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const first = buffer[0];
      const second = buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) === 0x80;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      let maskKey = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      if (maskKey) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
      }
      buffer = buffer.subarray(offset + length);

      if (opcode === 0x8) {
        socket.end();
        return;
      }
      if (opcode === 0x1) onMessage(payload.toString("utf8"));
      if (opcode === 0x0) onMessage(payload.toString("utf8"));
    }
  };

  const send = (method, params = {}) => {
    const id = nextId++;
    const payload = JSON.stringify({ id, method, params });
    const data = Buffer.from(payload, "utf8");
    const header = Buffer.alloc(2 + (data.length > 125 ? 2 : 0));
    header[0] = 0x81;
    if (data.length <= 125) {
      header[1] = 0x80 | data.length;
      header.writeUInt8(0x80 | data.length, 1);
    } else {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    }
    const maskKey = crypto.randomBytes(4);
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= maskKey[i % 4];
    const frame =
      data.length <= 125
        ? Buffer.concat([header.subarray(0, 2), maskKey, masked])
        : Buffer.concat([header.subarray(0, 4), maskKey, masked]);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.write(frame);
    });
  };

  const listeners = new Set();

  onMessage = (text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.method) {
      for (const listener of listeners) listener(message);
      return;
    }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  };

  return new Promise((resolve, reject) => {
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      if (!handshakeDone) {
        const end = chunk.indexOf("\r\n\r\n");
        if (end < 0) {
          buffer = Buffer.concat([buffer, chunk]);
          return;
        }
        const head = Buffer.concat([buffer, chunk]).subarray(0, end).toString("utf8");
        if (!head.includes("101")) {
          reject(new Error(`WebSocket handshake failed: ${head.split("\r\n")[0]}`));
          return;
        }
        handshakeDone = true;
        buffer = Buffer.alloc(0);
        const rest = chunk.subarray(end + 4);
        resolve({
          send,
          close: () => socket.end(),
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          }
        });
        if (rest.length) decodeFrames(rest);
        return;
      }
      decodeFrames(chunk);
    });
    socket.on("connect", () => {
      socket.write(
        [
          `GET ${url.pathname} HTTP/1.1`,
          `Host: ${url.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          ""
        ].join("\r\n")
      );
    });
  });
}

export async function withRenderer(fn) {
  const targets = await httpJson("/json/list");
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!page) throw new Error("No Obsidian renderer target found over CDP.");
  const client = await connectWebSocket(page.webSocketDebuggerUrl);
  try {
    const consoleErrors = [];
    client.subscribe((message) => {
      if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
        consoleErrors.push(
          (message.params.args || []).map((arg) => arg.value ?? arg.description).join(" ")
        );
      }
      if (message.method === "Runtime.exceptionThrown") {
        consoleErrors.push(
          message.params?.exceptionDetails?.exception?.description ||
            message.params?.exceptionDetails?.text ||
            "Unknown exception"
        );
      }
    });
    await client.send("Runtime.enable", {});
    const evaluate = async (expression, { awaitPromise = true } = {}) => {
      const result = await client.send("Runtime.evaluate", {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: true
      });
      if (result.exceptionDetails) {
        throw new Error(
          `Evaluation failed: ${
            result.exceptionDetails.exception?.description || result.exceptionDetails.text
          }`
        );
      }
      return result.result.value;
    };
    return await fn({ evaluate, consoleErrors });
  } finally {
    client.close();
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
