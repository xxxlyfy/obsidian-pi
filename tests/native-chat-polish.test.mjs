import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { readSources } from "./helpers/view-source.mjs";

vi.mock("obsidian", () => ({
  setIcon(element, icon) {
    element.icon = icon;
  }
}));

import {
  renderActivityMessage,
  renderMessage,
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

  toggleAttribute(name, enabled) {
    if (name === "open") this.open = enabled;
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

const threadListSource = readFileSync(
  new URL("../src/ui/thread-list-view.mjs", import.meta.url),
  "utf8"
);
const viewSource = readFileSync(new URL("../src/ui/PiAgentView.mjs", import.meta.url), "utf8");
// The chat DOM builders own the message-area listeners, so assertions about
// which listener is registered on which element have to cover both files.
const chatViewSources = readSources(["ui/PiAgentView.mjs", "ui/view/chat-dom.mjs"]);
const messageRendererSource = readFileSync(
  new URL("../src/ui/message-renderer.mjs", import.meta.url),
  "utf8"
);
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("native chat polish", () => {
  it("renders live thinking as an open native disclosure with an animated status label", () => {
    const root = new FakeElement("div");
    const rendered = renderThinkingDisclosure(
      root,
      "Readable\nwrapped reasoning",
      true,
      vi.fn(),
      true
    );
    const descendants = rendered.details.descendants();

    expect(rendered.details.tag).toBe("details");
    expect(rendered.details.open).toBe(true);
    expect(rendered.text.tag).toBe("div");
    expect(rendered.text.text).toContain("wrapped reasoning");
    expect(descendants.some((element) => element.tag === "pre")).toBe(false);
    expect(descendants.map((element) => element.icon).filter(Boolean)).toEqual(["chevron-right"]);
    expect(descendants.some((element) => element.text === "Live")).toBe(false);
    expect(descendants.some((element) => element.text === "THINKING")).toBe(true);
    expect(
      descendants.some(
        (element) => element.cls === "pi-agent-thinking-label" && element.attr.role === "status"
      )
    ).toBe(true);

    rendered.setExpanded(false);
    expect(rendered.details.open).toBe(false);
  });

  it("renders completed thinking collapsed with Markdown and without live-only status UI", () => {
    const root = new FakeElement("div");
    const onToggle = vi.fn();
    const renderMarkdown = vi.fn();
    const rendered = renderThinkingDisclosure(
      root,
      "**Finished reasoning**",
      false,
      onToggle,
      false,
      "Thinking",
      renderMarkdown
    );
    const descendants = rendered.details.descendants();

    expect(rendered.details.open).toBe(false);
    expect(descendants.map((element) => element.icon).filter(Boolean)).toEqual(["chevron-right"]);
    expect(descendants.some((element) => element.attr.role === "status")).toBe(false);
    expect(descendants.some((element) => element.text === "THINKING")).toBe(true);
    expect(renderMarkdown).toHaveBeenCalledWith(rendered.text, "**Finished reasoning**");

    rendered.details.open = true;
    rendered.details.listeners.get("toggle")();
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("renders tool activity inside the assistant response box as plain streaming thinking", () => {
    const messagesEl = new FakeElement("div");
    const view = {
      messagesEl,
      state: {
        activityText: "Editing note.md",
        streamingThinkingContent: "**Updating** the note",
        thinkingDisclosureExpanded: true
      },
      renderRoleLabel: vi.fn(),
      renderThinkingDisclosure,
      renderPlainMessageContent: vi.fn(),
      setLiveThinkingExpanded: vi.fn()
    };

    renderActivityMessage.call(view);

    const message = messagesEl.children[0];
    const response = message.children.find((element) => element.cls === "pi-agent-message-content");
    const disclosure = response.children[0];
    const label = disclosure
      .descendants()
      .find((element) => element.cls === "pi-agent-thinking-label");
    expect(view.renderRoleLabel).toHaveBeenCalledWith(message, "pi");
    expect(label.text).toBe("EDITING NOTE.MD");
    // PATCH 3: live thinking stays plain text until the final flush.
    expect(disclosure.children[1].text).toBe("**Updating** the note");
    expect(view.renderPlainMessageContent).not.toHaveBeenCalled();
  });

  it("renders the live response as plain text and leaves Markdown to the final render", () => {
    const messagesEl = new FakeElement("div");
    const renderStreamingAnswer = vi.fn();
    const view = {
      messagesEl,
      state: {
        streamingAssistantContent: "[Open note](Example.md)",
        streamingThinkingContent: "",
        thinkingDisclosureExpanded: false,
        activityText: "Responding"
      },
      renderRoleLabel: vi.fn(),
      renderThinkingDisclosure,
      renderPlainMessageContent: vi.fn(),
      renderStreamingAnswer,
      setLiveThinkingExpanded: vi.fn()
    };

    renderStreamingAssistantMessage.call(view);

    const disclosure = messagesEl.children[0].children.find((element) =>
      element.cls.includes("pi-agent-message-content")
    ).children[0];
    expect(disclosure.cls).toContain("is-live has-response");
    expect(view.streamingTextEl.cls).toBe("pi-agent-message-answer");
    expect(renderStreamingAnswer).toHaveBeenCalledOnce();
    expect(view.renderPlainMessageContent).not.toHaveBeenCalled();
    expect(messageRendererSource).toContain(
      'container.setText(this.state.streamingAssistantContent || "")'
    );
    expect(messageRendererSource).toContain(
      'container.setText(this.state.streamingThinkingContent || "")'
    );
    expect(messageRendererSource).not.toContain("this.streamingTextEl.appendText");
    expect(chatViewSources).toMatch(
      /addEventListener\("click", \(event\) => view\.handleMessageLinkClick\(event\), true\)/
    );
    expect(styles).toMatch(
      /\.pi-agent-message-content a \{\s*cursor: pointer;\s*pointer-events: auto;/
    );
  });

  it("integrates completed thinking into the assistant response box", () => {
    const messagesEl = new FakeElement("div");
    const renderPlainMessageContent = vi.fn();
    const view = {
      messagesEl,
      state: { completedThinkingExpansion: new Map() },
      getCurrentThreadId: () => "thread",
      renderRoleLabel: vi.fn(),
      renderToolErrors: vi.fn(),
      renderThinkingDisclosure,
      renderPlainMessageContent
    };

    renderMessage.call(
      view,
      { role: "assistant", content: "Answer", thinking: "Reasoning", createdAt: 1 },
      0
    );

    const message = messagesEl.children[0];
    const response = message.children.find((element) => element.cls === "pi-agent-message-content");
    expect(response.children[0].cls).toBe("pi-agent-thinking-disclosure");
    expect(response.children[1].cls).toBe("pi-agent-message-answer");
    expect(renderPlainMessageContent).toHaveBeenCalledWith(
      response.children[0].children[1],
      "Reasoning"
    );
    expect(renderPlainMessageContent).toHaveBeenCalledWith(response.children[1], "Answer");
    expect(messageRendererSource).toContain("this.renderThinkingDisclosure(\n      response");
    expect(messageRendererSource).toContain(
      'answer = response.createDiv({ cls: "pi-agent-message-answer" })'
    );
    expect(styles).toMatch(
      /\.pi-agent-thinking-disclosure \{[\s\S]*?border-bottom: 1px solid var\(--background-modifier-border-hover\)/
    );
    expect(styles).not.toMatch(
      /\.pi-agent-thinking-content \{[\s\S]*?background: var\(--background-primary-alt\);/
    );
    expect(styles).not.toMatch(
      /\.pi-agent-thinking-content \{[\s\S]*?border-top: 1px solid var\(--background-modifier-border\);/
    );
    expect(styles).toMatch(/\.pi-agent-thinking-disclosure summary \{[\s\S]*?padding: 0;/);
    expect(styles).toMatch(/\.pi-agent-thinking-disclosure \{[\s\S]*?padding-bottom: 6px;/);
    expect(styles).toMatch(
      /\.pi-agent-thinking-disclosure\.is-live \{\s*border-bottom-color: transparent;\s*margin-bottom: -4px;\s*padding-bottom: 0;/
    );
    expect(styles).toMatch(
      /\.pi-agent-thinking-disclosure\.is-live\.has-response \{\s*border-bottom-color: var\(--background-modifier-border-hover\);\s*margin-bottom: 6px;\s*padding-bottom: 6px;/
    );
    expect(styles).toMatch(/\.pi-agent-thinking-content \{[\s\S]*?padding: 0 0 0 18px;/);
    expect(styles).toMatch(
      /\.pi-agent-thinking-content\.markdown-rendered > \* \{\s*margin-block: 3px;/
    );
  });

  it("preserves a user-set thinking disclosure state when a run completes or fails", () => {
    // The completed-run thinking key is written on both the success and failure
    // paths of the prompt run, which now live partly in the prompt-run stages
    // module, so read the view and that module together.
    const runSources = readSources(["ui/PiAgentView.mjs", "ui/view/run-prompt.mjs"]);
    expect(runSources.match(/n\.thinkingUserSet \? n\.thinkingExpanded : false/g)).toHaveLength(2);
    expect(runSources).toContain("if (!n.thinkingUserSet) n.thinkingExpanded = false");
    expect(runSources).toContain("this.liveThinkingSetExpanded?.(n.thinkingExpanded)");
  });

  it("keeps guarded bulk deletion directly visible and removes archive-all", () => {
    expect(threadListSource).toContain('setIcon)(deleteChatsButton, "trash-2")');
    expect(threadListSource).toContain('tr("threadList.deleteChats")');
    expect(threadListSource).toContain("chooseBulkThreadDeletion");
    expect(threadListSource).not.toContain("Archive all chats");
    expect(threadListSource).not.toContain("archiveAllChats");
  });

  it("fills selected favorite stars with non-accent current color", () => {
    expect(styles).toMatch(
      /\.pi-agent-header-favorite\.is-favorite svg,[\s\S]*?fill: currentColor;/
    );
    expect(styles).toMatch(
      /\.pi-agent-header-favorite\.is-favorite \{\s*color: var\(--text-normal\);/
    );
    expect(styles).toMatch(
      /\.pi-agent-thread-favorite\.is-favorite \{\s*color: var\(--text-muted\);/
    );
  });

  it("keeps animated activity text inside the response disclosure with reduced-motion fallback", () => {
    expect(messageRendererSource).not.toContain("pi-agent-inline-activity");
    expect(styles).not.toContain(".pi-agent-inline-activity");
    expect(messageRendererSource).not.toContain("pi-agent-inline-activity-spinner");
    expect(messageRendererSource).not.toContain("pi-agent-thinking-spinner");
    expect(messageRendererSource).toContain('this.state.activityText || "Thinking"');
    expect(messageRendererSource).toContain('this.state.activityText || "Responding"');
    expect(messageRendererSource).toContain(".toUpperCase()");
    expect(styles).toMatch(
      /\.pi-agent-thinking-label \{[\s\S]*?font-weight: var\(--font-bold\);[\s\S]*?letter-spacing: 0\.04em;/
    );
    expect(styles).toContain("@keyframes pi-agent-activity-flow");
    expect(styles).toMatch(
      /\.pi-agent-thinking-disclosure\.is-live \.pi-agent-thinking-label \{[\s\S]*?animation: pi-agent-activity-flow 1\.2s linear infinite;/
    );
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.pi-agent-thinking-disclosure\.is-live \.pi-agent-thinking-label,[\s\S]*?animation: none;[\s\S]*?-webkit-text-fill-color: var\(--text-muted\);[\s\S]*?\.pi-agent-thinking-chevron \{\s*transition: none;/
    );
    expect(viewSource).not.toContain('setIcon)(icon, "brain")');
  });

  it("makes both user and assistant response bubbles visually distinct", () => {
    expect(styles).toMatch(
      /\.pi-agent-message-content \{[\s\S]*?background: var\(--background-secondary-alt\);[\s\S]*?border: 1px solid var\(--background-modifier-border\);/
    );
    expect(styles).toMatch(
      /\.pi-agent-message-assistant \.pi-agent-message-content \{[\s\S]*?border-color: var\(--background-modifier-border-hover\);/
    );
    expect(styles).toMatch(
      /\.pi-agent-message-user \.pi-agent-message-content \{[\s\S]*?interactive-accent\) 14%[\s\S]*?border-color:/
    );
  });
});
