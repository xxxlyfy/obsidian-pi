import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../src/agent/agent-runtime.mjs";
import { PromptDelivery } from "../src/agent/prompt-delivery.mjs";
import { PiRunCanceledError } from "../src/pi/run-canceled.mjs";
import { DEFAULT_SETTINGS } from "../src/plugin/settings.mjs";
import { ThreadService } from "../src/threads/thread-service.mjs";
import { ThreadStore } from "../src/threads/thread-store.mjs";
import { createViewHarness } from "./fixtures/view-harness.mjs";

const notices = vi.hoisted(() => ({ messages: [] }));

vi.mock("obsidian", () => ({
  Component: class {},
  FuzzySuggestModal: class {},
  ItemView: class {},
  MarkdownRenderChild: class {},
  MarkdownRenderer: { render: vi.fn() },
  MarkdownView: class {},
  Menu: class {},
  Modal: class {},
  Notice: class {
    constructor(message) {
      notices.messages.push(String(message));
    }
  },
  Plugin: class {},
  PluginSettingTab: class {},
  Setting: class {},
  SuggestModal: class {},
  TFile: class {},
  normalizePath: (value) => value,
  setIcon: () => {}
}));

globalThis.window ??= {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
  addEventListener() {},
  removeEventListener() {}
};

const { PiAgentView } = await import("../src/ui/PiAgentView.mjs");

const { createScriptedRunner, createPluginDouble, createViewDouble } = createViewHarness({
  PiAgentView,
  AgentRuntime,
  PromptDelivery,
  ThreadService,
  ThreadStore,
  DEFAULT_SETTINGS,
  notices
});

function result(finalResponse, threadId) {
  return {
    finalResponse,
    sessionId: "session-1",
    threadId,
    events: [],
    contextUsage: undefined,
    contextCompacted: false,
    tokenUsage: undefined,
    runtimeState: undefined
  };
}

describe("race: cancel then start a new run", () => {
  it("drops late events from the cancelled run and keeps the new run intact", async () => {
    let view;
    let threadId;
    let cancelledRun;
    let cancelCallbacks;
    const first = createScriptedRunner(async ({ callbacks }) => {
      cancelCallbacks = callbacks;
      callbacks.onEvent({ type: "agent_start" });
      callbacks.onTextDelta("first run text");
      view.cancelCurrentRun();
      throw new PiRunCanceledError();
    });
    const plugin = createPluginDouble(first);
    threadId = plugin.threads.currentThreadId;
    view = createViewDouble(plugin);

    await view.runPrompt("first", threadId);
    cancelledRun = first.calls.length;

    // A new run on the same thread must not see anything from the cancelled one.
    const second = createScriptedRunner(async ({ callbacks }) => {
      callbacks.onTextDelta("second run text");
      return result("second run text", threadId);
    });
    plugin.createPiRunner = () => second;

    await view.runPrompt("second", threadId);

    cancelCallbacks.onTextDelta(" late from cancelled run");
    cancelCallbacks.onEvent({ type: "tool_start", toolCallId: "late", toolName: "read" });

    expect(cancelledRun).toBe(1);
    expect(plugin.threads.currentMessages().map((message) => message.content)).toEqual([
      "first",
      "second",
      "second run text"
    ]);
    expect(notices.messages).toEqual([expect.stringContaining("取消")]);
    expect(view.runtime.listRuns()).toHaveLength(0);
    expect(view.streamingAssistantContent).toBe("");
    expect(view.activeToolCalls.size).toBe(0);
  });
});

describe("race: retry after a failure", () => {
  it("ignores late events from the failed run while the retry streams", async () => {
    let failedCallbacks;
    const failing = createScriptedRunner(async ({ callbacks }) => {
      failedCallbacks = callbacks;
      callbacks.onEvent({ type: "agent_start" });
      callbacks.onTextDelta("partial");
      throw new Error("Pi RPC prompt timed out");
    });
    const plugin = createPluginDouble(failing);
    const threadId = plugin.threads.currentThreadId;
    const view = createViewDouble(plugin);

    await view.runPrompt("slow", threadId);

    let releaseRetry;
    const retry = createScriptedRunner(
      async ({ callbacks }) =>
        new Promise((resolve) => {
          releaseRetry = () => {
            callbacks.onTextDelta("recovered");
            resolve(result("recovered", threadId));
          };
        })
    );
    plugin.createPiRunner = () => retry;
    const pending = view.runPrompt("slow", threadId);
    await vi.waitFor(() => expect(retry.calls).toHaveLength(1));

    failedCallbacks.onTextDelta(" late from failed run");
    failedCallbacks.onEvent({ type: "tool_start", toolCallId: "late", toolName: "read" });

    expect(view.streamingAssistantContent).toBe("");
    expect(view.activeToolCalls.size).toBe(0);

    releaseRetry();
    await pending;

    expect(view.streamingAssistantContent).toBe("");
    expect(plugin.threads.currentMessages().at(-1).content).toBe("recovered");
  });
});

describe("race: thread switch while a run streams", () => {
  it("keeps background events out of the newly selected thread and restores them on switch back", async () => {
    let view;
    let threadA;
    let threadB;
    let runCallbacks;
    let settle;
    const runner = createScriptedRunner(
      async ({ callbacks }) =>
        new Promise((resolve) => {
          runCallbacks = callbacks;
          settle = () => resolve(result("in thread A while B is open", threadA));
          callbacks.onTextDelta("in thread A");
        })
    );
    const plugin = createPluginDouble(runner);
    threadA = plugin.threads.currentThreadId;
    threadB = plugin.threads.startNewThread("B").id;
    plugin.threads.switchThread(threadA);
    view = createViewDouble(plugin);

    const pending = view.runPrompt("go", threadA);
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
    expect(view.streamingAssistantContent).toBe("in thread A");

    // Switch to B: the view must not adopt A's live state.
    plugin.threads.switchThread(threadB);
    view.renderChatView = vi.fn();
    view.restoreActiveRunUiState();
    view.streamingAssistantContent = "";

    runCallbacks.onTextDelta(" while B is open");
    runCallbacks.onEvent({ type: "tool_start", toolCallId: "t", toolName: "read" });

    expect(view.streamingAssistantContent).toBe("");
    expect(view.activeToolCalls.size).toBe(0);
    expect(view.currentRunContextUsage).toBeUndefined();

    // Switching back restores the run that is still active in thread A.
    view.getCurrentThreadId = () => threadA;
    view.restoreActiveRunUiState();
    expect(view.streamingAssistantContent).toBe("in thread A while B is open");

    settle();
    await pending;

    // The finished run writes to the thread it belongs to, not to the visible one.
    expect(plugin.threads.getThread(threadA).messages.at(-1).content).toBe(
      "in thread A while B is open"
    );
    expect(plugin.threads.getThread(threadB).messages).toEqual([]);
    expect(view.runtime.listRuns()).toHaveLength(0);
  });
});

describe("race: view closed while a run is active", () => {
  it("cancels the view's own run and ignores every late callback", async () => {
    let view;
    let threadId;
    let runCallbacks;
    let rejectWithCancellation;
    const runner = createScriptedRunner(
      async ({ callbacks }) =>
        new Promise((_resolve, reject) => {
          runCallbacks = callbacks;
          rejectWithCancellation = () => reject(new PiRunCanceledError());
        })
    );
    const plugin = createPluginDouble(runner);
    threadId = plugin.threads.currentThreadId;
    view = createViewDouble(plugin);

    const pending = view.runPrompt("go", threadId);
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
    expect(view.runtime.hasRun(threadId)).toBe(true);

    view.onClose();

    // Closing the view owns the outcome: the run is cancelled and released.
    expect(runner.cancelCurrentRun).toHaveBeenCalledOnce();
    expect(view.runtime.listRuns()).toHaveLength(0);
    expect(view.runtime.disposed).toBe(true);

    // Late callbacks must not throw, render, or resurrect the run.
    expect(() => {
      runCallbacks.onTextDelta("closed delta");
      runCallbacks.onEvent({ type: "tool_start", toolCallId: "t", toolName: "read" });
      runCallbacks.onEvent({ type: "agent_end" });
    }).not.toThrow();

    rejectWithCancellation();
    await pending;

    expect(view.streamingRenderTimer).toBeUndefined();
    expect(view.pendingActivityTimer).toBeUndefined();
    expect(view.activeToolCalls.size).toBe(0);
    expect(plugin.threads.getThread(threadId).messages.map((message) => message.role)).toEqual([
      "user"
    ]);
  });

  it("leaves other chatting views alone", async () => {
    let runCallbacks;
    const first = createScriptedRunner(
      async ({ callbacks }) =>
        new Promise((resolve) => {
          runCallbacks = callbacks;
          settleFirst = () => resolve(result("first done", firstThreadId));
        })
    );
    let settleFirst;
    let firstThreadId;
    const pluginA = createPluginDouble(first);
    firstThreadId = pluginA.threads.currentThreadId;
    const viewA = createViewDouble(pluginA);

    const pendingA = viewA.runPrompt("go", firstThreadId);
    await vi.waitFor(() => expect(first.calls).toHaveLength(1));

    // A second view with its own thread keeps running while the first closes.
    const second = createScriptedRunner(async ({ callbacks }) => {
      callbacks.onTextDelta("second view text");
      return result("second done", pluginB.threads.currentThreadId);
    });
    const pluginB = createPluginDouble(second);
    const viewB = createViewDouble(pluginB);
    await viewB.runPrompt("go", pluginB.threads.currentThreadId);
    expect(viewB.runtime.listRuns()).toHaveLength(0);

    viewA.onClose();
    expect(viewA.runtime.disposed).toBe(true);
    expect(viewB.runtime.disposed).toBe(false);

    runCallbacks.onTextDelta(" late");
    expect(viewB.streamingAssistantContent).toBe("");

    settleFirst();
    await pendingA;
  });
});

describe("race: RPC process restarted", () => {
  it("drops late events from the replaced process", async () => {
    let staleCallbacks;
    const staleRunner = createScriptedRunner(async ({ callbacks }) => {
      staleCallbacks = callbacks;
      callbacks.onTextDelta("old process");
      throw new Error("Pi RPC process stopped.");
    });
    const plugin = createPluginDouble(staleRunner);
    const threadId = plugin.threads.currentThreadId;
    const view = createViewDouble(plugin);

    await view.runPrompt("before restart", threadId);
    expect(view.runtime.listRuns()).toHaveLength(0);

    const restartedRunner = createScriptedRunner(async ({ callbacks }) => {
      callbacks.onTextDelta("new process");
      return result("new process", threadId);
    });
    plugin.createPiRunner = () => restartedRunner;
    await view.runPrompt("after restart", threadId);

    staleCallbacks.onTextDelta(" late from the old process");
    staleCallbacks.onEvent({ type: "tool_start", toolCallId: "old", toolName: "read" });
    staleCallbacks.onEvent({ type: "agent_end" });

    expect(view.streamingAssistantContent).toBe("");
    expect(view.activeToolCalls.size).toBe(0);
    expect(plugin.threads.currentMessages().at(-1).content).toBe("new process");
    expect(
      plugin.threads.currentMessages().some((message) => message.content.includes("late from"))
    ).toBe(false);
  });

  it("treats a prompt timeout as a settled error run and allows the next prompt", async () => {
    const timeoutRunner = createScriptedRunner(async () => {
      throw new Error(
        "Pi RPC prompt timed out. The agent process was restarted to avoid overlapping runs."
      );
    });
    const plugin = createPluginDouble(timeoutRunner);
    const threadId = plugin.threads.currentThreadId;
    const view = createViewDouble(plugin);

    await view.runPrompt("slow", threadId);

    expect(view.runtime.listRuns()).toHaveLength(0);
    expect(view.running).toBe(false);
    expect(view.canceling).toBe(false);
    expect(plugin.threads.currentMessages().map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
    expect(plugin.threads.currentMessages().at(-1).content).toContain("运行失败");

    const healthy = createScriptedRunner(async ({ callbacks }) => {
      callbacks.onTextDelta("recovered");
      return result("recovered", threadId);
    });
    plugin.createPiRunner = () => healthy;
    await view.runPrompt("try again", threadId);

    expect(plugin.threads.currentMessages().at(-1).content).toBe("recovered");
  });
});

describe("race: view close must not drain the queue", () => {
  function queuedItem(threadId, id) {
    return {
      id,
      prompt: `queued ${id}`,
      threadId,
      createdAt: 1,
      images: [],
      attachments: [],
      annotations: [],
      contextFilePath: undefined,
      includeActiveNote: true,
      state: "pending"
    };
  }

  it("does not start a queued prompt after the view is closed", async () => {
    let view;
    let threadId;
    let rejectWithCancellation;
    const runner = createScriptedRunner(
      async ({ callbacks }) =>
        new Promise((_resolve, reject) => {
          rejectWithCancellation = () => reject(new PiRunCanceledError());
          callbacks.onTextDelta("streaming");
        })
    );
    const plugin = createPluginDouble(runner);
    threadId = plugin.threads.currentThreadId;
    view = createViewDouble(plugin);
    view.promptQueue = [queuedItem(threadId, "q1"), queuedItem(threadId, "q2")];
    view.plugin.promptQueue.getItems = () => view.promptQueue;

    const pending = view.runPrompt("first", threadId);
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));

    view.onClose();
    rejectWithCancellation();
    await pending;

    // The closed view must not start the queued prompts, and they stay queued.
    expect(runner.calls).toHaveLength(1);
    expect(view.closed).toBe(true);
    expect(view.promptQueue.map((item) => item.id)).toEqual(["q1", "q2"]);
  });

  it("does not start a run when the view closes while the payload is prepared", async () => {
    let releaseDelivery;
    let view;
    const runner = createScriptedRunner(async ({ callbacks }) => {
      callbacks.onTextDelta("started");
      return result("started", runnerThreadId);
    });
    let runnerThreadId;
    const plugin = createPluginDouble(runner);
    runnerThreadId = plugin.threads.currentThreadId;
    plugin.enrichPromptDelivery = vi.fn(
      (delivery) =>
        new Promise((resolve) => {
          releaseDelivery = () => resolve({ ...delivery, promptContext: undefined });
        })
    );
    view = createViewDouble(plugin);

    const pending = view.runPrompt("prepared later", runnerThreadId);
    await vi.waitFor(() => expect(typeof releaseDelivery).toBe("function"));

    view.onClose();
    releaseDelivery();
    await pending;

    expect(runner.calls).toHaveLength(0);
    expect(view.runtime.listRuns()).toHaveLength(0);
    expect(plugin.threads.getThread(runnerThreadId).messages).toEqual([]);
  });

  it("still drains the queue normally while the view is open", async () => {
    const prompts = [];
    const runner = createScriptedRunner(async ({ callbacks, prompt }) => {
      prompts.push(prompt);
      callbacks.onTextDelta("done");
      return result("done", runnerThreadId);
    });
    let runnerThreadId;
    const plugin = createPluginDouble(runner);
    runnerThreadId = plugin.threads.currentThreadId;
    const view = createViewDouble(plugin);
    view.promptQueue = [queuedItem(runnerThreadId, "q1")];
    plugin.promptQueue.getItems = () => view.promptQueue;
    plugin.promptQueue.isPaused = () => false;

    await view.runPrompt("first", runnerThreadId);
    // The drain is fire-and-forget, so wait for the queued run to start.
    await vi.waitFor(() => expect(prompts).toHaveLength(2));

    expect(prompts).toEqual(["first", "queued q1"]);
  });

  it("lets a reopened view work while the old queue stays inactive", async () => {
    let rejectWithCancellation;
    const firstRunner = createScriptedRunner(
      async () =>
        new Promise((_resolve, reject) => {
          rejectWithCancellation = () => reject(new PiRunCanceledError());
        })
    );
    const plugin = createPluginDouble(firstRunner);
    const threadId = plugin.threads.currentThreadId;
    const oldView = createViewDouble(plugin);
    oldView.promptQueue = [queuedItem(threadId, "q1")];
    plugin.promptQueue.getItems = () => oldView.promptQueue;

    const pending = oldView.runPrompt("first", threadId);
    await vi.waitFor(() => expect(firstRunner.calls).toHaveLength(1));
    oldView.onClose();
    rejectWithCancellation();
    await pending;

    const secondRunner = createScriptedRunner(async ({ callbacks }) => {
      callbacks.onTextDelta("reopened");
      return result("reopened", threadId);
    });
    plugin.createPiRunner = () => secondRunner;
    const newView = createViewDouble(plugin);
    await newView.runPrompt("from the new view", threadId);

    expect(firstRunner.calls).toHaveLength(1);
    expect(plugin.threads.getThread(threadId).messages.at(-1).content).toBe("reopened");
    expect(newView.closed).toBe(false);
  });
});

describe("multi-view", () => {
  it("rejects a second run for a thread another view is already running", async () => {
    let releaseFirst;
    let firstCallbacks;
    const sharedRunner = {
      isRunning: false,
      cancelCurrentRun: vi.fn(),
      steer: vi.fn(async () => {}),
      run: vi.fn(async (prompt, context, sessionId, history, callbacks) => {
        if (sharedRunner.isRunning)
          throw new Error(
            "This chat already has an active run. Wait for it to finish or cancel it."
          );
        sharedRunner.isRunning = true;
        firstCallbacks = callbacks;
        try {
          callbacks.onTextDelta("view A streaming");
          await new Promise((resolve) => (releaseFirst = resolve));
          return result("view A done", plugin.threads.currentThreadId);
        } finally {
          sharedRunner.isRunning = false;
        }
      })
    };
    const plugin = createPluginDouble(sharedRunner);
    const threadId = plugin.threads.currentThreadId;
    const viewA = createViewDouble(plugin);
    const viewB = createViewDouble(plugin);

    const pendingA = viewA.runPrompt("from A", threadId);
    await vi.waitFor(() => expect(sharedRunner.run).toHaveBeenCalledTimes(1));

    await viewB.runPrompt("from B", threadId);

    // The second view gets a clear failure instead of interleaving on the same runner.
    expect(sharedRunner.run).toHaveBeenCalledTimes(2);
    expect(plugin.threads.getThread(threadId).messages.at(-1).content).toContain("运行失败");
    expect(plugin.threads.getThread(threadId).messages.at(-1).content).toContain(
      "already has an active run"
    );
    expect(viewA.runtime.hasRun(threadId)).toBe(true);
    expect(viewB.runtime.hasRun(threadId)).toBe(false);
    expect(viewA.streamingAssistantContent).toBe("view A streaming");

    firstCallbacks.onTextDelta(" still A only");
    expect(viewB.streamingAssistantContent).toBe("");
    expect(viewA.streamingAssistantContent).toBe("view A streaming still A only");

    releaseFirst();
    await pendingA;
    expect(plugin.threads.getThread(threadId).messages.at(-1).content).toBe("view A done");
  });

  it("lets two views stream different threads at the same time", async () => {
    const runners = new Map();
    const callbacksByThread = new Map();
    const releases = new Map();
    const plugin = createPluginDouble(null);
    plugin.createPiRunner = (threadId) => {
      if (!runners.has(threadId)) {
        runners.set(threadId, {
          cancelCurrentRun: vi.fn(),
          steer: vi.fn(async () => {}),
          run: vi.fn(async (prompt, context, sessionId, history, callbacks) => {
            callbacksByThread.set(threadId, callbacks);
            callbacks.onTextDelta(`${threadId}:`);
            await new Promise((resolve) => releases.set(threadId, resolve));
            return result(`${threadId} done`, threadId);
          })
        });
      }
      return runners.get(threadId);
    };
    const threadA = plugin.threads.currentThreadId;
    const threadB = plugin.threads.startNewThread("B").id;
    plugin.threads.switchThread(threadA);
    const viewA = createViewDouble(plugin);
    viewA.getCurrentThreadId = () => threadA;
    const viewB = createViewDouble(plugin);
    viewB.getCurrentThreadId = () => threadB;

    const pendingA = viewA.runPrompt("to A", threadA);
    const pendingB = viewB.runPrompt("to B", threadB);
    await vi.waitFor(() => expect(runners.size).toBe(2));

    expect(viewA.streamingAssistantContent).toBe(`${threadA}:`);
    expect(viewB.streamingAssistantContent).toBe(`${threadB}:`);

    // A delta that arrives for A must never show up in B's live buffer.
    callbacksByThread.get(threadA).onTextDelta("extra-A");
    expect(viewA.streamingAssistantContent).toBe(`${threadA}:extra-A`);
    expect(viewB.streamingAssistantContent).toBe(`${threadB}:`);

    releases.get(threadA)();
    releases.get(threadB)();
    await Promise.all([pendingA, pendingB]);

    expect(plugin.threads.getThread(threadA).messages.at(-1).content).toBe(`${threadA} done`);
    expect(plugin.threads.getThread(threadB).messages.at(-1).content).toBe(`${threadB} done`);
    expect(viewA.runtime.listRuns()).toHaveLength(0);
    expect(viewB.runtime.listRuns()).toHaveLength(0);
  });
});

describe("race: runtime refuses overlapping runs", () => {
  it("rejects a second run for the same thread instead of interleaving state", async () => {
    let release;
    const runner = createScriptedRunner(
      async ({ callbacks }) =>
        new Promise((resolve) => {
          release = () => resolve(result("done", "t1"));
          callbacks.onTextDelta("streaming");
        })
    );
    const plugin = createPluginDouble(runner);
    const view = createViewDouble(plugin);
    const threadId = plugin.threads.currentThreadId;

    const first = view.runtime.startPrompt({ threadId, prompt: "one" });
    await expect(view.runtime.startPrompt({ threadId, prompt: "two" })).rejects.toThrow(
      "already has an active run"
    );

    release();
    await first;
    expect(view.runtime.listRuns()).toHaveLength(0);
  });
});
