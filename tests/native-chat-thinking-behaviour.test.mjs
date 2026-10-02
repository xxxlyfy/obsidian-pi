// Is the `native-chat-polish` failure a real runtime defect in the completed
// thinking path, or a stale white-box assertion?
//
// `tests/native-chat-polish.test.mjs` fails at its first source-string assertion
// (`expect(messageRendererSource).toContain("this.renderThinkingDisclosure(\n      response")`).
// That assertion is satisfied by a specific formatting of one statement, so it
// says nothing about what a user sees. This file pins the behaviour instead, by
// calling the real production renderers (`renderMessage()`,
// `renderThinkingDisclosure()`, `renderStreamingAssistantMessage()`,
// `finalizeStreamingContent()`) from `src/ui/message-renderer.mjs` and inspecting
// the DOM tree they build.
//
// Facts this file pins:
//   1 completed thinking -> the response box holds a collapsed thinking
//      disclosure followed by the answer div, both filled through
//      `renderPlainMessageContent()` (the Markdown path), and the thinking text
//      is preserved.
//   2 the completed disclosure exposes no live-only status UI.
//   3 expanding/collapsing a completed disclosure reports the new state through
//      the toggle callback, which is what the view stores per thread + message.
//   4 a completed live run flushes its thinking into the same disclosure instead
//      of losing it: the streaming thinking container ends up Markdown-rendered
//      with the accumulated reasoning.
//
// Note: this is not a real Obsidian runtime. The DOM is a minimal element stub with
// the same `createDiv`/`createEl`/`descendants`/`toggleAttribute` surface the
// production renderers use, and `obsidian` is mocked for `setIcon` and `Component`
// exactly as `tests/native-chat-polish.test.mjs` does. What is real here is the
// production rendering logic under test and the structure it produces; CSS
// painting is out of scope.

import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  setIcon(element, icon) {
    element.icon = icon;
  },
  Component: class Component {
    load() {}
    unload() {}
  },
  MarkdownRenderer: {
    render: async () => {}
  }
}));

import {
  cancelStreamingFlush,
  finalizeStreamingContent,
  releaseStreamingFlushCleanup,
  renderMessage,
  renderStreamingAnswer,
  renderStreamingAssistantMessage,
  renderThinkingDisclosure
} from "../src/ui/message-renderer.mjs";

class FakeElement {
  constructor(tag, options = {}) {
    this.tag = tag;
    this.cls = options.cls ?? "";
    this.text = options.text ?? "";
    this.attr = options.attr ?? {};
    this.children = [];
    this.listeners = new Map();
    this.open = false;
  }

  createEl(tag, options) {
    const child = new FakeElement(tag, options);
    this.children.push(child);
    return child;
  }

  createDiv(options) {
    return this.createEl("div", options);
  }

  createSpan(options) {
    return this.createEl("span", options);
  }

  // Obsidian's Element.setText/empty: replace this element's content.
  setText(text) {
    this.children.length = 0;
    this.text = String(text);
    return this;
  }

  empty() {
    this.children.length = 0;
    this.text = "";
    return this;
  }

  toggleAttribute(name, enabled) {
    if (name === "open") this.open = enabled;
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  find(cls) {
    return this.descendants().find((element) => element.cls.split(" ").includes(cls));
  }
}

/**
 * A view surface with only what the completed-message renderer reads, in the
 * shape the real view has it: `state.completedThinkingExpansion` is the per
 * thread + message map the plugin persists.
 */
function createView(state = {}) {
  const messagesEl = new FakeElement("div");
  const renderPlainMessageContent = vi.fn();
  const view = {
    messagesEl,
    state: { completedThinkingExpansion: new Map(), ...state },
    getCurrentThreadId: () => "thread",
    renderRoleLabel: vi.fn(),
    renderToolErrors: vi.fn(),
    renderThinkingDisclosure,
    renderPlainMessageContent,
    // The streaming renderer's own collaborators, as the real view provides them.
    renderStreamingAnswer,
    cancelStreamingFlush,
    releaseStreamingFlushCleanup,
    setLiveThinkingExpanded: vi.fn()
  };
  return { view, messagesEl, renderPlainMessageContent };
}

const assistantMessage = {
  role: "assistant",
  content: "Answer",
  thinking: "Reasoning",
  createdAt: 1
};

describe("completed thinking in the assistant response box (behaviour)", () => {
  it("renders a collapsed thinking disclosure followed by the rendered answer", () => {
    const { view, messagesEl, renderPlainMessageContent } = createView();

    renderMessage.call(view, assistantMessage, 0);

    const message = messagesEl.children[0];
    const response = message.children.find((element) =>
      element.cls.includes("pi-agent-message-content")
    );
    const disclosure = response.children[0];
    const answer = response.children[1];
    const thinkingContent = disclosure.find("pi-agent-thinking-content");

    // User-visible structure: thinking disclosure, then the answer.
    expect(disclosure.tag).toBe("details");
    expect(disclosure.cls.split(" ")).toContain("pi-agent-thinking-disclosure");
    expect(disclosure.open).toBe(false);
    expect(answer.cls.split(" ")).toContain("pi-agent-message-answer");

    // Both halves are filled through the Markdown render path, with the right
    // content: the thinking is not dropped and is not mixed into the answer.
    expect(renderPlainMessageContent).toHaveBeenCalledTimes(2);
    expect(renderPlainMessageContent).toHaveBeenNthCalledWith(1, thinkingContent, "Reasoning");
    expect(renderPlainMessageContent).toHaveBeenNthCalledWith(2, answer, "Answer");

    // The disclosure labels itself and offers an expand affordance.
    expect(disclosure.find("pi-agent-thinking-label").text).toBe("THINKING");
    expect(disclosure.find("pi-agent-thinking-chevron").icon).toBe("chevron-right");
  });

  it("shows no live-only status UI on a completed disclosure", () => {
    const { view, messagesEl } = createView();

    renderMessage.call(view, assistantMessage, 0);

    const response = messagesEl.children[0].children.find((element) =>
      element.cls.includes("pi-agent-message-content")
    );
    const disclosure = response.children[0];

    expect(disclosure.cls).not.toContain("is-live");
    expect(disclosure.descendants().some((element) => element.attr.role === "status")).toBe(false);
  });

  it("reports expansion changes through the toggle callback", () => {
    const root = new FakeElement("div");
    const onToggle = vi.fn();
    const rendered = renderThinkingDisclosure(
      root,
      "Reasoning",
      false,
      onToggle,
      false,
      "Thinking",
      vi.fn()
    );

    expect(rendered.details.open).toBe(false);
    rendered.details.open = true;
    rendered.details.listeners.get("toggle")();
    expect(onToggle).toHaveBeenCalledWith(true);

    // One user action reports one state change.
    rendered.details.listeners.get("toggle")();
    expect(onToggle).toHaveBeenCalledTimes(1);

    rendered.details.open = false;
    rendered.details.listeners.get("toggle")();
    expect(onToggle).toHaveBeenLastCalledWith(false);
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("keeps completed thinking when a live run flushes its streaming content", () => {
    const { view, messagesEl, renderPlainMessageContent } = createView({
      streamingAssistantContent: "Streamed answer",
      streamingThinkingContent: "Streamed reasoning",
      activityText: "Responding",
      streamingAnswerDirty: true,
      streamingThinkingDirty: true
    });

    renderStreamingAssistantMessage.call(view);
    const disclosure = messagesEl.children[0].children.find((element) =>
      element.cls.includes("pi-agent-message-content")
    ).children[0];
    const thinkingContent = disclosure.find("pi-agent-thinking-content");
    // The answer container is the one the renderer published on the view, which is
    // also the container `finalizeStreamingContent()` later re-renders.
    const answer = view.streamingTextEl;

    // Live thinking is plain text, and the answer container exists while streaming.
    expect(thinkingContent.text).toBe("Streamed reasoning");
    expect(answer.cls.split(" ")).toContain("pi-agent-message-answer");
    expect(answer.text).toBe("Streamed answer");
    // Still live: the streaming disclosure is marked as such and keeps status UI.
    expect(disclosure.cls).toContain("is-live");
    expect(disclosure.find("pi-agent-thinking-label").attr.role).toBe("status");

    // Final flush promotes both containers to Markdown with the accumulated text,
    // so the completed reasoning survives into the final (non-streaming) render.
    expect(finalizeStreamingContent.call(view)).toBe(true);
    expect(renderPlainMessageContent).toHaveBeenCalledWith(thinkingContent, "Streamed reasoning");
    expect(renderPlainMessageContent).toHaveBeenCalledWith(answer, "Streamed answer");
  });
});
