import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../src/agent/agent-runtime.mjs";
import { RUN_STATUS } from "../src/agent/run-state.mjs";
import { PiRunCanceledError } from "../src/pi/run-canceled.mjs";

function createRuntime(runPrompt, overrides = {}) {
  const runners = [];
  const runtime = new AgentRuntime({
    runPrompt,
    createRunner: (threadId) => {
      const runner = {
        threadId,
        cancelCurrentRun: vi.fn(),
        steer: vi.fn(async () => {})
      };
      runners.push(runner);
      return runner;
    },
    cancelRunner: (runner) => runner?.cancelCurrentRun?.(),
    now: () => 1_000,
    ...overrides
  });
  return { runtime, runners };
}

describe("AgentRuntime", () => {
  it("runs a prompt through the port and drops the record before resolving", async () => {
    const statuses = [];
    const { runtime, runners } = createRuntime(async (request, callbacks) => {
      expect(request.threadId).toBe("t1");
      expect(request.runner).toBe(runners[0]);
      callbacks.onTextDelta("hello");
      return { finalResponse: "hello" };
    });
    const deltas = [];
    runtime.subscribe((event) => statuses.push(event.type));

    const { run, result } = await runtime.startPrompt(
      { threadId: "t1", prompt: "hi" },
      { onTextDelta: (delta) => deltas.push(delta) }
    );

    expect(result).toEqual({ finalResponse: "hello" });
    expect(deltas).toEqual(["hello"]);
    expect(run).toMatchObject({ threadId: "t1", status: RUN_STATUS.completed });
    expect(runtime.getRun("t1")).toBeUndefined();
    expect(runtime.hasRun("t1")).toBe(false);
    expect(statuses).toEqual(["run-started", "run-state", "run-state", "run-ended"]);
    expect(runners).toHaveLength(1);
  });

  it("ignores events that arrive after the run settled", async () => {
    let lateCallbacks;
    const { runtime } = createRuntime(async (request, callbacks) => {
      lateCallbacks = callbacks;
      callbacks.onTextDelta("first");
      return {};
    });
    const events = [];
    const deltas = [];

    await runtime.startPrompt(
      { threadId: "t1", prompt: "hi" },
      {
        onEvent: (event) => events.push(event.type),
        onTextDelta: (delta) => deltas.push(delta),
        onPromptAccepted: () => events.push("accepted")
      }
    );

    lateCallbacks.onTextDelta(" late");
    lateCallbacks.onEvent({ type: "tool_start" });
    lateCallbacks.onPromptAccepted();

    expect(deltas).toEqual(["first"]);
    expect(events).toEqual([]);
    expect(lateCallbacks.isCanceled()).toBe(true);
  });

  it("cancels through the cancel port and marks the run as cancelling", async () => {
    let capturedRun;
    let cancelAccepted;
    let lateCallbacks;
    const { runtime } = createRuntime(async (request, callbacks) => {
      lateCallbacks = callbacks;
      capturedRun = runtime.getRun("t1");
      cancelAccepted = runtime.requestCancel(capturedRun);
      throw new PiRunCanceledError();
    });
    const deltas = [];
    const promise = runtime.startPrompt(
      { threadId: "t1", prompt: "long" },
      { onTextDelta: (delta) => deltas.push(delta) }
    );
    expect(runtime.getRun("t1")).toBeDefined();

    await expect(promise).rejects.toBeInstanceOf(PiRunCanceledError);

    expect(cancelAccepted).toBe(true);
    expect(capturedRun).toMatchObject({ canceling: true, status: RUN_STATUS.cancelling });
    expect(capturedRun.runner.cancelCurrentRun).toHaveBeenCalledOnce();
    expect(runtime.getRun("t1")).toBeUndefined();

    lateCallbacks.onTextDelta(" late");
    expect(deltas).toEqual([]);
  });

  it("records the error message for a failed run and rethrows", async () => {
    const { runtime } = createRuntime(async () => {
      throw new Error("Pi RPC request timed out: prompt");
    });

    await expect(runtime.startPrompt({ threadId: "t1", prompt: "slow" })).rejects.toThrow(
      "Pi RPC request timed out: prompt"
    );

    expect(runtime.getRun("t1")).toBeUndefined();
    expect(runtime.lastRequests.get("t1")).toMatchObject({ prompt: "slow", threadId: "t1" });
  });

  it("rejects a second concurrent run for the same thread", async () => {
    let release;
    const { runtime } = createRuntime(
      async () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );

    const first = runtime.startPrompt({ threadId: "t1", prompt: "one" });
    await expect(runtime.startPrompt({ threadId: "t1", prompt: "two" })).rejects.toThrow(
      "already has an active run"
    );
    release({});
    await first;
  });

  it("replays the last request on a fresh runner when retrying", async () => {
    const attempts = [];
    const { runtime, runners } = createRuntime(async (request) => {
      attempts.push(request);
      if (attempts.length === 1) throw new Error("timed out");
      return { finalResponse: "recovered" };
    });

    await expect(runtime.startPrompt({ threadId: "t1", prompt: "slow" })).rejects.toThrow(
      "timed out"
    );
    const { result } = await runtime.retryRun("t1");

    expect(result).toEqual({ finalResponse: "recovered" });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({ prompt: "slow", threadId: "t1" });
    expect(runners).toHaveLength(2);
    expect(attempts[1].runner).toBe(runners[1]);
    expect(runners[1]).not.toBe(runners[0]);
  });

  it("does not keep a successful prompt replayable", async () => {
    const { runtime } = createRuntime(async () => ({ finalResponse: "done" }));

    await runtime.startPrompt({ threadId: "t1", prompt: "finished" });

    expect(runtime.lastRequests.has("t1")).toBe(false);
    await expect(runtime.retryRun("t1")).rejects.toThrow("no previous prompt");
  });

  it("keeps a failed prompt replayable and releases it on dispose", async () => {
    const { runtime } = createRuntime(async () => {
      throw new Error("timed out");
    });

    await expect(runtime.startPrompt({ threadId: "t1", prompt: "slow" })).rejects.toThrow(
      "timed out"
    );
    expect(runtime.lastRequests.has("t1")).toBe(true);

    runtime.dispose();
    expect(runtime.lastRequests.size).toBe(0);
  });

  it("refuses to retry a thread without a previous prompt", async () => {
    const { runtime } = createRuntime(async () => ({}));

    await expect(runtime.retryRun("t1")).rejects.toThrow("no previous prompt");
  });

  it("steers only the run that is still current", async () => {
    let release;
    const { runtime } = createRuntime(
      async () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const pending = runtime.startPrompt({ threadId: "t1", prompt: "long" });
    const run = runtime.getRun("t1");

    await expect(runtime.steerRun(run, "focus", [])).resolves.toBe(true);
    expect(run.runner.steer).toHaveBeenCalledWith("focus", []);

    release({});
    await pending;

    await expect(runtime.steerRun(run, "too late", [])).resolves.toBe(false);
    await expect(runtime.steerRun(undefined, "no run", [])).resolves.toBe(false);
  });

  it("routes compaction through the normal prompt path", async () => {
    const prompts = [];
    const { runtime } = createRuntime(async (request) => {
      prompts.push(request.prompt);
      return {};
    });

    await runtime.compactRun("t1");
    await runtime.compactRun("t1", "keep decisions");

    expect(prompts).toEqual(["/compact", "/compact keep decisions"]);
    expect(runtime.createCompactPrompt("  ")).toBe("/compact");
  });

  it("refuses to start after dispose", async () => {
    const { runtime } = createRuntime(async () => ({}));
    runtime.dispose();

    await expect(runtime.startPrompt({ threadId: "t1", prompt: "hi" })).rejects.toThrow(
      "runtime is disposed"
    );
    expect(runtime.isCurrent({ threadId: "t1", runId: "t1:1", generation: 1 })).toBe(false);
  });

  it("requires a thread id and a configured runner factory", async () => {
    const { runtime } = createRuntime(async () => ({}));

    await expect(runtime.startPrompt({ prompt: "no thread" })).rejects.toThrow(
      "requires a threadId"
    );

    const bare = new AgentRuntime({});
    await expect(bare.startPrompt({ threadId: "t1", prompt: "hi" })).rejects.toThrow(
      "createRunner is not configured"
    );
  });
});
