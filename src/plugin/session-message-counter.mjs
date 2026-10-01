import fs from "node:fs";
import { createInterface } from "node:readline";

/**
 * Streaming Pi session message counter.
 *
 * Counting a session used to happen inside `renderThreadList()`: `readFileSync()`
 * pulled the whole file into memory, `split()` cut it into lines, and every line
 * paid a `JSON.parse()`. That put hundreds of milliseconds of file I/O and parsing
 * on the main thread for one large session, and seconds for a thread list with
 * several of them. This counter moves the identical counting rule off the render
 * path: the file is read once with `createReadStream()` and split into lines by
 * `readline`, so only one line is ever resident and the event loop keeps running
 * between chunks.
 *
 * The rule itself is unchanged from `countPiSessionChatMessages()`: a line counts
 * when it parses as JSON, has `type === "message"`, and carries a `user` or
 * `assistant` message role. A line that does not parse is skipped, and a file that
 * cannot be read at all counts as zero; no failure reaches the caller.
 *
 * Two properties matter for the thread list:
 *
 * - The same session file may be referenced by any number of threads, so scans are
 *   deduplicated by resolved path: one path is never scanned twice at the same time.
 * - A thread list can reference dozens of large sessions, so at most `concurrency`
 *   scans run at once. The rest wait their turn instead of opening every file at once.
 *
 * @typedef {object} PiSessionMessageCounter
 * @property {(sessionPath: string | undefined) => Promise<number>} scan
 *   Resolves to the count for `sessionPath`, joining an in-flight scan of the same
 *   path instead of starting a second one. Never rejects.
 * @property {() => number} pendingCount Scans queued or running right now.
 * @property {() => boolean} isScanning Whether any scan is queued or running.
 * @property {() => number} scanCount Scans this counter has started.
 * @property {() => void} dispose Cancels queued scans and destroys open streams.
 */

/**
 * @param {object} [options]
 * @param {number} [options.concurrency] Maximum scans running at once.
 * @param {() => void} [options.onScan] Called when a scan actually starts.
 * @param {(sessionPath: string) => Promise<number>} [options.readSession]
 *   The reader used for one path. Overridable so a caller can supply an instrumented
 *   or fake reader; defaults to the streaming reader.
 * @returns {PiSessionMessageCounter}
 */
export function createPiSessionMessageCounter(options = {}) {
  const concurrency = Math.max(1, Number(options.concurrency ?? 2));
  const onScan = options.onScan;
  /** Streams this counter opened and has not released yet. */
  const activeStreams = new Set();
  const readSession =
    options.readSession ??
    ((sessionPath) =>
      countSessionMessagesStreaming(sessionPath, (stream) => activeStreams.add(stream)));

  /** In-flight or queued scans by resolved path, so one file is scanned once. */
  const scheduled = new Map();
  const queue = [];
  const running = new Set();
  let disposed = false;
  let scans = 0;

  function startNext() {
    while (!disposed && running.size < concurrency && queue.length > 0) {
      const sessionPath = queue.shift();
      const entry = scheduled.get(sessionPath);
      if (!entry) continue;
      running.add(sessionPath);

      // The scan starts in a microtask, never synchronously: the caller that asked
      // for the count (the render) is guaranteed to finish first.
      Promise.resolve()
        .then(() => {
          if (disposed) return 0;
          scans += 1;
          onScan?.();
          return readSession(sessionPath);
        })
        .then(
          (count) => entry.resolve(typeof count === "number" ? count : 0),
          () => entry.resolve(0)
        )
        .then(() => {
          running.delete(sessionPath);
          scheduled.delete(sessionPath);
          startNext();
        });
    }
  }

  return {
    scan(sessionPath) {
      if (!sessionPath || disposed) return Promise.resolve(0);

      const existing = scheduled.get(sessionPath);
      if (existing) return existing.promise;

      /** @type {{ promise: Promise<number>, resolve: (count: number) => void }} */
      const entry = { promise: undefined, resolve: undefined };
      entry.promise = new Promise((resolve) => {
        entry.resolve = resolve;
      });
      scheduled.set(sessionPath, entry);
      queue.push(sessionPath);
      startNext();
      return entry.promise;
    },

    pendingCount() {
      return queue.length + running.size;
    },

    isScanning() {
      return this.pendingCount() > 0;
    },

    scanCount() {
      return scans;
    },

    dispose() {
      disposed = true;
      for (const sessionPath of queue) {
        scheduled.get(sessionPath)?.resolve(0);
        scheduled.delete(sessionPath);
      }
      queue.length = 0;
      for (const stream of activeStreams) {
        try {
          stream.destroy();
        } catch {
          // A stream that is already gone needs no cleanup; nothing may throw here.
        }
      }
      activeStreams.clear();
    }
  };
}

/**
 * Count chat messages in one session file by streaming it line by line.
 *
 * @param {string} sessionPath
 * @param {(stream: import("node:fs").ReadStream) => void} [onStream]
 *   Called with the stream this reader opens, so an owner can destroy it later.
 * @returns {Promise<number>}
 */
export function countSessionMessagesStreaming(sessionPath, onStream) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (stream, count) => {
      if (settled) return;
      settled = true;
      stream?.destroy();
      resolve(count);
    };

    /** @type {import("node:fs").ReadStream} */
    let stream;
    try {
      stream = fs.createReadStream(sessionPath, { encoding: "utf8" });
    } catch {
      // A path that cannot be turned into a stream has no messages to count.
      resolve(0);
      return;
    }
    onStream?.(stream);

    stream.once("error", () => settle(stream, 0));

    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    // `readline` re-emits an input error on the interface, and an unhandled "error"
    // event would take the whole process down. A session file that disappears
    // mid-read counts as zero, exactly like a file that was never there.
    lines.once("error", () => settle(stream, 0));
    let count = 0;
    lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const record = JSON.parse(line);
        const message = record?.message;
        if (
          record?.type === "message" &&
          (message?.role === "user" || message?.role === "assistant")
        ) {
          count += 1;
        }
      } catch {
        // A malformed line is skipped exactly like the previous counting rule.
      }
    });
    lines.once("close", () => settle(stream, count));
  });
}
