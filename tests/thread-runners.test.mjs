import { describe, expect, it, vi } from "vitest";
import { ThreadRunnerRegistry } from "../src/plugin/thread-runners.mjs";

function createRunner() {
  return { isRunning: false, rpcClient: { dispose: vi.fn() } };
}

describe("ThreadRunnerRegistry", () => {
  it("reuses an existing runner for the same thread", () => {
    const registry = new ThreadRunnerRegistry(() => createRunner());
    const first = registry.create("t1");

    expect(registry.create("t1")).toBe(first);
    expect(registry.get("t1")).toBe(first);
  });

  it("disposes temporary runners created through withRunner", async () => {
    const registry = new ThreadRunnerRegistry(() => createRunner());
    let created;

    const result = await registry.withRunner("t1", async (runner) => {
      created = runner;
      expect(registry.get("t1")).toBe(runner);
      return "done";
    });

    expect(result).toBe("done");
    expect(registry.get("t1")).toBeUndefined();
    expect(created.rpcClient.dispose).toHaveBeenCalledOnce();
  });

  it("keeps a pre-existing runner alive after withRunner", async () => {
    const registry = new ThreadRunnerRegistry(() => createRunner());
    const existing = registry.create("t1");

    await registry.withRunner("t1", async () => {});

    expect(registry.get("t1")).toBe(existing);
    expect(existing.rpcClient.dispose).not.toHaveBeenCalled();
  });

  it("reports active runs and disposes everything", () => {
    const runners = [];
    const registry = new ThreadRunnerRegistry(() => {
      const runner = createRunner();
      runners.push(runner);
      return runner;
    });
    registry.create("t1");
    registry.create("t2");

    expect(registry.hasActive()).toBe(false);
    runners[0].isRunning = true;
    expect(registry.hasActive()).toBe(true);

    registry.disposeAll();

    expect(runners.every((runner) => runner.rpcClient.dispose.mock.calls.length === 1)).toBe(true);
    expect(registry.get("t1")).toBeUndefined();
    expect(registry.hasActive()).toBe(false);
  });

  it("disposes a single runner by thread", () => {
    const registry = new ThreadRunnerRegistry(() => createRunner());
    const runner = registry.create("t1");

    registry.dispose("t1");

    expect(runner.rpcClient.dispose).toHaveBeenCalledOnce();
    expect(registry.get("t1")).toBeUndefined();
  });
});
