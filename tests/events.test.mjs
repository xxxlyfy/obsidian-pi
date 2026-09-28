import { describe, expect, it, vi } from "vitest";
import {
  extractAssistantText,
  extractEventTokenUsage,
  extractToolCallFromAssistantEvent,
  getAssistantRunState,
  handlePiEvent,
  handlePiJsonEventLine
} from "../src/pi/events.mjs";
import { createRunState } from "../src/pi/run-state.mjs";

function createContext() {
  const state = createRunState();
  const onEvent = vi.fn();
  const onTextDelta = vi.fn();
  return { state, callbacks: { onEvent, onTextDelta }, onEvent, onTextDelta };
}

describe("Pi event helpers", () => {
  it("extracts assistant text from string and structured content", () => {
    expect(extractAssistantText({ role: "assistant", content: "hello" })).toBe("hello");
    expect(
      extractAssistantText({
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "toolCall", name: "read" },
          { type: "text", text: " world" }
        ]
      })
    ).toBe("hello world");
  });

  it("normalizes run state and token usage", () => {
    expect(
      getAssistantRunState({
        role: "assistant",
        content: "done",
        usage: { input: 10, output: 2, cacheRead: 3 },
        provider: "openai-codex",
        model: "gpt-5.5"
      })
    ).toMatchObject({
      fallbackText: "done",
      tokenUsage: {
        input: 10,
        output: 2,
        cacheRead: 3,
        cacheWrite: 0,
        totalTokens: 0,
        provider: "openai-codex",
        model: "gpt-5.5",
        modelId: "openai-codex/gpt-5.5"
      }
    });
    expect(
      extractEventTokenUsage({ message: { role: "assistant", usage: { input: 1 } } })
    ).toMatchObject({
      input: 1
    });
  });

  it("emits text deltas through the string path and accumulates the final response", () => {
    const { state, callbacks, onEvent, onTextDelta } = createContext();

    handlePiJsonEventLine(
      JSON.stringify({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", delta: "hi" }
      }),
      state,
      callbacks
    );

    expect(state.finalResponse).toBe("hi");
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "text_delta", textDelta: "hi" })
    );
    expect(onTextDelta).toHaveBeenCalledWith("hi", expect.objectContaining({ type: "text_delta" }));
  });

  it("emits thinking deltas without treating them as answer text", () => {
    const { state, callbacks, onEvent } = createContext();

    handlePiEvent(
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" }
      },
      state,
      callbacks
    );

    expect(state.finalResponse).toBe("");
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thinking_delta", thinkingDelta: "reasoning" })
    );
  });

  it("emits tool execution events and tracks active tools by id", () => {
    const { state, callbacks, onEvent } = createContext();

    handlePiEvent(
      { type: "tool_execution_start", toolName: "read", toolCallId: "1", args: { path: "a.md" } },
      state,
      callbacks
    );

    expect(state.activeTools.size).toBe(1);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool_start",
        toolName: "read",
        toolCallId: "1",
        toolKey: "id:1",
        toolArgs: { path: "a.md" }
      })
    );
  });

  it("carries start arguments into tool completion events that omit them", () => {
    const { state, callbacks, onEvent } = createContext();
    const edits = [{ oldText: "old", newText: "new" }];

    handlePiEvent(
      {
        type: "tool_execution_start",
        toolName: "edit",
        toolCallId: "edit-1",
        args: { path: "Note.md", edits }
      },
      state,
      callbacks
    );
    handlePiEvent(
      {
        type: "tool_execution_end",
        toolName: "edit",
        toolCallId: "edit-1",
        result: { content: [{ type: "text", text: "Successfully replaced 1 block." }] },
        isError: false
      },
      state,
      callbacks
    );

    expect(state.activeTools.size).toBe(0);
    expect(onEvent.mock.calls[1][0]).toMatchObject({
      type: "tool_end",
      toolName: "edit",
      toolCallId: "edit-1",
      toolKey: "id:edit-1",
      toolArgs: { path: "Note.md", edits },
      isError: false
    });
  });

  it("correlates tool events without ids through the lifecycle map", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { state, callbacks, onEvent } = createContext();

    handlePiEvent(
      { type: "tool_execution_start", toolName: "bash", args: { command: "ls" } },
      state,
      callbacks
    );
    handlePiEvent({ type: "tool_execution_end", toolName: "bash" }, state, callbacks);

    expect(onEvent.mock.calls[1][0]).toMatchObject({
      type: "tool_end",
      toolName: "bash",
      toolArgs: { command: "ls" }
    });
    expect(onEvent.mock.calls[1][0].toolKey).toBe(onEvent.mock.calls[0][0].toolKey);
    expect(state.activeTools.size).toBe(0);
    warn.mockRestore();
  });

  it("extracts tool calls from assistant events", () => {
    expect(
      extractToolCallFromAssistantEvent({
        partial: {
          content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "a.md" } }]
        },
        contentIndex: 0
      })
    ).toEqual({ id: "call", name: "read", arguments: { path: "a.md" } });
  });

  it("gates run-state capture away from high-frequency streaming updates", () => {
    const { state, callbacks } = createContext();

    handlePiEvent(
      {
        type: "message_update",
        message: { role: "assistant", content: "partial answer" },
        assistantMessageEvent: { type: "text_delta", delta: "partial" }
      },
      state,
      callbacks
    );
    expect(state.fallbackText).toBe("");

    handlePiEvent(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: "final answer",
          usage: { input: 10, output: 2 }
        }
      },
      state,
      callbacks
    );
    expect(state.fallbackText).toBe("final answer");
    expect(state.tokenUsage).toMatchObject({ input: 10 });
  });

  it("keeps compaction ends in the bounded diagnostics ring without raw payloads", () => {
    const { state, callbacks, onEvent } = createContext();

    handlePiEvent(
      { type: "auto_compaction_end", aborted: false, result: { tokensBefore: 12345 } },
      state,
      callbacks
    );

    expect(state.sawSuccessfulCompaction).toBe(true);
    const [retained] = state.diagnostics.snapshot();
    expect(retained).toMatchObject({ type: "auto_compaction_end" });
    expect(retained).not.toHaveProperty("raw");

    handlePiEvent(
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "x" }
      },
      state,
      callbacks
    );
    expect(state.diagnostics.snapshot()).toHaveLength(2);
    expect(onEvent).toHaveBeenCalledTimes(2);
  });
});
