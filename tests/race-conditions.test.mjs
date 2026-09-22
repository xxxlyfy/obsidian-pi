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
  it("does not throw and does not touch detached DOM when callbacks arrive after close", async () => {
    let view;
    let threadId;
    let runCallbacks;
    let settle;
    const runner = createScriptedRunner(
      async ({ callbacks }) =>
        new Promise((resolve) => {
          runCallbacks = callbacks;
          settle = () => resolve(result("finished after close", threadId));
        })
    );
    const plugin = createPluginDouble(runner);
    threadId = plugin.threads.currentThreadId;
    view = createViewDouble(plugin);

    const pending = view.runPrompt("go", threadId);
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));

    view.onClose();
    expect(view.messagesEl).toBeUndefined();
    expect(view.inputEl).toBeUndefined();
    expect(view.promptQueueEl).toBeUndefined();
    expect(view.sendButtonEl).toBeUndefined();

    // The run keeps going: streaming, tools, and settle must not throw or render.
    expect(() => {
      runCallbacks.onTextDelta("closed delta");
      runCallbacks.onEvent({ type: "tool_start", toolCallId: "t", toolName: "read" });
      runCallbacks.onEvent({ type: "agent_end" });
    }).not.toThrow();

    settle();
    await expect(pending).resolves.toBeUndefined();

    expect(plugin.threads.currentMessages().at(-1).content).toBe("finished after close");
    expect(view.streamingRenderTimer).toBeUndefined();
    expect(view.pendingActivityTimer).toBeUndefined();
    expect(view.activeToolCalls.size).toBe(0);
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
