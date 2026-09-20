import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  Component: class {},
  MarkdownRenderer: { render: vi.fn() }
}));

import {
  flushStreamingRender,
  renderStreamingAnswer,
  renderStreamingThinking
} from "../src/ui/message-renderer.mjs";

function createElement() {
  return {
    isConnected: true,
    text: "",
    setText(value) {
      this.text = value;
    },
    createSpan() {
      return {};
    }
  };
}

function createView(overrides = {}) {
  return {
    running: true,
    streamingAssistantContent: "",
    streamingThinkingContent: "",
    stickToBottom: false,
    streamingTextEl: undefined,
    liveThinkingTextEl: undefined,
    renderMessages: vi.fn(),
    renderStreamingAnswer,
    renderStreamingThinking,
    ...overrides
  };
}

describe("streaming render flush", () => {
  it("creates the streaming answer element once answer text arrives", () => {
    const view = createView({
      streamingAssistantContent: "hello",
      streamingThinkingContent: "reasoning",
      liveThinkingTextEl: createElement(),
      renderMessages: vi.fn(function renderMessages() {
        this.streamingTextEl = createElement();
      })
    });

    flushStreamingRender.call(view);

    expect(view.renderMessages).toHaveBeenCalledOnce();
    expect(view.streamingTextEl).toBeDefined();
  });

  it("updates the streaming answer in place when the element exists", () => {
    const streamingTextEl = createElement();
    const view = createView({
      streamingAssistantContent: "hello world",
      streamingTextEl,
      liveThinkingTextEl: createElement()
    });

    flushStreamingRender.call(view);

    expect(view.renderMessages).not.toHaveBeenCalled();
    expect(streamingTextEl.text).toBe("hello world");
  });

  it("only refreshes thinking while no answer text is available", () => {
    const liveThinkingTextEl = createElement();
    const view = createView({
      streamingThinkingContent: "thinking",
      liveThinkingTextEl
    });

    flushStreamingRender.call(view);

    expect(view.renderMessages).not.toHaveBeenCalled();
    expect(liveThinkingTextEl.text).toBe("thinking");
  });

  it("does nothing when the run is no longer active", () => {
    const view = createView({ running: false, streamingAssistantContent: "hello" });

    flushStreamingRender.call(view);

    expect(view.renderMessages).not.toHaveBeenCalled();
  });
});
