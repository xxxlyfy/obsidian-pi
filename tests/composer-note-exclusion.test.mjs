import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  Component: class {},
  FuzzySuggestModal: class {},
  ItemView: class {},
  MarkdownRenderChild: class {},
  MarkdownRenderer: { render: vi.fn() },
  MarkdownView: class {},
  Menu: class {},
  Modal: class {},
  Notice: class {},
  Plugin: class {},
  PluginSettingTab: class {},
  Setting: class {},
  SuggestModal: class {},
  TFile: class {},
  normalizePath: (value) => value,
  setIcon: () => {}
}));

const { PiAgentView } = await import("../src/ui/PiAgentView.mjs");
const { enqueuePrompt, retrieveQueuedPrompt, runNextQueuedPrompt } =
  await import("../src/ui/prompt-queue.mjs");
const { createQueuedPrompt } = await import("../src/ui/prompt-payload.mjs");
const { normalizeLocalPromptQueue } = await import("../src/ui/local-prompt-queue.mjs");

const viewSource = fs.readFileSync("src/ui/PiAgentView.mjs", "utf8");
const contextSource = fs.readFileSync("src/context/context-service.mjs", "utf8");
const pluginSource = fs.readFileSync("src/plugin/PiAgentPlugin.mjs", "utf8");

function createView({ currentFile = "Notes/A.md", ...overrides } = {}) {
  const view = {
    excludedContextPath: undefined,
    plugin: { getCurrentContextPath: () => currentFile },
    ...overrides
  };
  view.resolveActiveNoteInclusion = (contextFile) =>
    PiAgentView.prototype.resolveActiveNoteInclusion.call(view, contextFile);
  return view;
}

function createQueuedItem(overrides = {}) {
  return {
    id: "q1",
    prompt: "later",
    threadId: "t1",
    images: [],
    attachments: [],
    annotations: [],
    contextFilePath: "Notes/A.md",
    includeActiveNote: false,
    state: "pending",
    ...overrides
  };
}

describe("composer current-note exclusion", () => {
  it("keeps the exclusion while the same note stays open", () => {
    const view = createView({ excludedContextPath: "Notes/A.md" });

    expect(PiAgentView.prototype.resolveActiveNoteInclusion.call(view, "Notes/A.md")).toBe(false);
    expect(view.excludedContextPath).toBe("Notes/A.md");
  });

  it("clears the exclusion as soon as another note becomes active", () => {
    const view = createView({ excludedContextPath: "Notes/A.md" });

    expect(PiAgentView.prototype.resolveActiveNoteInclusion.call(view, "Notes/B.md")).toBe(true);
    expect(view.excludedContextPath).toBeUndefined();
  });

  it("includes the note by default and skips the badge when no note is open", () => {
    const view = createView();

    expect(PiAgentView.prototype.resolveActiveNoteInclusion.call(view, "Notes/A.md")).toBe(true);
    expect(PiAgentView.prototype.resolveActiveNoteInclusion.call(view, undefined)).toBe(false);
  });

  it("keeps the exclusion when no markdown note is open", () => {
    const view = createView({ currentFile: undefined, excludedContextPath: "Notes/A.md" });

    expect(PiAgentView.prototype.resolveActiveNoteInclusion.call(view, undefined)).toBe(false);
    expect(view.excludedContextPath).toBe("Notes/A.md");
    expect(PiAgentView.prototype.shouldIncludeActiveNote.call(view)).toBe(false);
  });

  it("reports the inclusion state used by prompt delivery", () => {
    const view = createView({ excludedContextPath: "Notes/A.md" });

    expect(PiAgentView.prototype.shouldIncludeActiveNote.call(view)).toBe(false);

    view.excludedContextPath = undefined;

    expect(PiAgentView.prototype.shouldIncludeActiveNote.call(view)).toBe(true);
  });

  it("persists the exclusion on queued follow-ups", () => {
    const excluded = createQueuedPrompt({
      prompt: "later",
      contextFilePath: "Notes/A.md",
      includeActiveNote: false
    });

    expect(excluded.includeActiveNote).toBe(false);
    expect(normalizeLocalPromptQueue([excluded])[0].includeActiveNote).toBe(false);

    const included = createQueuedPrompt({ prompt: "later" });

    expect(included.includeActiveNote).toBe(true);
    expect(normalizeLocalPromptQueue([included])[0].includeActiveNote).toBe(true);
  });

  it("forwards the exclusion when a message is queued", () => {
    const enqueue = vi.fn(() => ({ id: "q1" }));
    const view = {
      promptQueue: [],
      plugin: {
        threads: { currentThreadId: "t1" },
        promptQueue: { enqueue, getItems: () => [] }
      },
      renderPromptQueue: () => {},
      syncCurrentRunFlags: () => {},
      setRunningState: () => {}
    };

    enqueuePrompt.call(view, "later", "t1", [], [], [], "Notes/A.md", false);

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ contextFilePath: "Notes/A.md", includeActiveNote: false })
    );
  });

  it("sends queued follow-ups with their stored exclusion", () => {
    const startPrompt = vi.fn();
    const view = {
      canceling: false,
      steeringPromptIds: new Set(),
      promptQueue: [createQueuedItem()],
      isThreadRunning: () => false,
      plugin: { promptQueue: { isPaused: () => false, replace: () => {} } },
      renderPromptQueue: () => {},
      startPrompt
    };

    runNextQueuedPrompt.call(view);

    expect(startPrompt).toHaveBeenCalledWith("later", "t1", [], "q1", [], [], "Notes/A.md", false);
  });

  it("restores the exclusion when a queued follow-up returns to the composer", () => {
    const view = {
      excludedContextPath: undefined,
      inputEl: { value: "", focus: () => {} },
      composerImages: [],
      composerAttachments: [],
      promptQueue: [createQueuedItem()],
      isCurrentThread: () => true,
      removeQueuedPrompt: () => {},
      renderComposerImages: () => {},
      resizeInput: () => {}
    };

    retrieveQueuedPrompt.call(view, "q1");

    expect(view.excludedContextPath).toBe("Notes/A.md");
  });

  it("wires the removable note badge into the prompt plumbing", () => {
    expect(viewSource).toContain(
      "const includeActiveNote = this.resolveActiveNoteInclusion(contextFilePath);"
    );
    expect(fs.readFileSync("src/agent/prompt-delivery.mjs", "utf8")).toContain(
      "if (includeActiveNote === undefined) includeActiveNote = this.shouldIncludeActiveNote();"
    );
    expect(viewSource).toContain(
      "removeLabel: STRINGS.view.removeNote(noteTitleFromPath(contextFilePath))"
    );
    expect(pluginSource).toContain("includeActiveNote: enriched.includeActiveNote !== false");
    expect(contextSource).toContain("if (options?.includeActiveNote === false) return undefined;");
  });
});
