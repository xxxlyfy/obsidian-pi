import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The view, its mixins and the chat DOM builders all import from "obsidian".
// This mock is the smallest set that lets PiAgentView.mjs finish evaluating so
// the send path can be driven for real instead of re-implemented here.
vi.mock("obsidian", () => {
  class ItemView {}
  class Modal {}
  return {
    ItemView,
    Component: class {},
    FuzzySuggestModal: class {},
    MarkdownRenderChild: class {},
    MarkdownRenderer: { render: vi.fn().mockResolvedValue(undefined) },
    MarkdownView: class {},
    Menu: class {
      addItem() {
        return this;
      }
      addSeparator() {}
    },
    Modal,
    Notice: class {},
    PluginSettingTab: class {},
    Setting: class {},
    SuggestModal: class {},
    TFile: class {},
    getLanguage: () => "en",
    normalizePath: (value) => value,
    setIcon: vi.fn()
  };
});

import { PiAgentView } from "../src/ui/PiAgentView.mjs";
import {
  removeQueuedPrompt,
  renderPromptQueue,
  retrieveQueuedPrompt
} from "../src/ui/prompt-queue.mjs";

const QUEUE_SOURCE = readFileSync(new URL("../src/ui/prompt-queue.mjs", import.meta.url), "utf8");

/**
 * The four fields that moved onto `view.state` (see view-state.mjs). None of
 * them may come back as an instance property on the view.
 */
const MIGRATED_FIELDS = ["promptQueue", "running", "composerImages", "composerAttachments"];

function createQueueItem(overrides = {}) {
  return {
    id: "queued-1",
    threadId: "thread-1",
    prompt: "Summarize this note",
    images: [],
    attachments: [],
    annotations: [],
    contextFilePath: undefined,
    state: "pending",
    ...overrides
  };
}

/**
 * A view with just enough surface for the real prompt-queue methods and the real
 * `submitInput`. `removeQueuedPrompt` and `renderPromptQueue` are the genuine
 * mixin implementations, so the test covers the queue bookkeeping too.
 */
function createView(queue) {
  const view = {
    plugin: {
      replaceLocalPromptQueue: vi.fn(),
      restoreConsumedAnnotations: vi.fn()
    },
    state: {
      promptQueue: queue,
      composerImages: [],
      composerAttachments: [],
      running: false
    },
    inputEl: { value: "", focus: vi.fn() },
    promptQueueEl: undefined,
    suggestions: { close: vi.fn() },
    isCurrentThread: vi.fn(() => true),
    renderComposerImages: vi.fn(),
    resizeInput: vi.fn(),
    setRunningState: vi.fn(),
    syncCurrentRunFlags: vi.fn(),
    runPrompt: vi.fn(),
    removeQueuedPrompt,
    renderPromptQueue
  };
  return view;
}

/** Attach the plugin surface the real `submitInput` needs, then run it. */
async function submitThroughRealSendPath(view) {
  view.plugin.getCurrentContextFile = () => ({ path: "Note.md" });
  view.plugin.ensureModelCatalogLoaded = vi.fn().mockResolvedValue(undefined);
  view.plugin.getSelectedModelInfo = () => ({ supportsImages: true, contextWindow: 200000 });
  await PiAgentView.prototype.submitInput.call(view);
  return view.runPrompt.mock.calls[0];
}

describe("prompt queue restores into view.state", () => {
  it("restores a plain queued prompt", () => {
    const item = createQueueItem();
    const view = createView([item]);

    retrieveQueuedPrompt.call(view, item.id);

    expect(view.inputEl.value).toBe("Summarize this note");
    expect(view.state.composerImages).toEqual([]);
    expect(view.state.composerAttachments).toEqual([]);
    expect(view.inputEl.focus).toHaveBeenCalledOnce();
    expect(view.renderComposerImages).toHaveBeenCalledOnce();
    expect(view.resizeInput).toHaveBeenCalledOnce();
  });

  it("takes the restored prompt out of the queue", () => {
    const item = createQueueItem();
    const view = createView([item, createQueueItem({ id: "queued-2" })]);

    retrieveQueuedPrompt.call(view, item.id);

    expect(view.state.promptQueue.map((entry) => entry.id)).toEqual(["queued-2"]);
    expect(view.plugin.replaceLocalPromptQueue).toHaveBeenCalledWith(view.state.promptQueue);
  });

  it("restores a queued prompt's images into state.composerImages", () => {
    const image = {
      id: "img-1",
      fileName: "shot.png",
      mimeType: "image/png",
      data: "AAA",
      size: 3,
      source: "local"
    };
    const item = createQueueItem({ images: [image] });
    const view = createView([item]);

    retrieveQueuedPrompt.call(view, item.id);

    expect(view.state.composerImages).toEqual([image]);
    expect(view.state.composerAttachments).toEqual([]);
    // Restored as a copy: mutating the composer must not rewrite the queue item.
    expect(view.state.composerImages[0]).not.toBe(image);
  });

  it("restores a queued prompt's attachments into state.composerAttachments", () => {
    const attachment = {
      id: "att-1",
      fileName: "notes.md",
      mimeType: "text/markdown",
      text: "body",
      originalSize: 4,
      includedBytes: 4,
      truncated: false,
      source: "vault"
    };
    const item = createQueueItem({ attachments: [attachment] });
    const view = createView([item]);

    retrieveQueuedPrompt.call(view, item.id);

    expect(view.state.composerAttachments).toEqual([attachment]);
    expect(view.state.composerImages).toEqual([]);
    expect(view.state.composerAttachments[0]).not.toBe(attachment);
  });

  it("never recreates the migrated fields as instance properties", () => {
    const item = createQueueItem({
      images: [{ id: "img-1", fileName: "shot.png", mimeType: "image/png", size: 3 }],
      attachments: [{ id: "att-1", fileName: "notes.md", mimeType: "text/markdown" }]
    });
    const view = createView([item]);

    retrieveQueuedPrompt.call(view, item.id);

    for (const field of MIGRATED_FIELDS) {
      expect(Object.hasOwn(view, field), `${field} must live on view.state`).toBe(false);
      expect(view[field]).toBeUndefined();
    }
  });
});

describe("the send path reads the restored state", () => {
  it("sends the restored images and attachments from state", async () => {
    const image = { id: "img-1", fileName: "shot.png", mimeType: "image/png", size: 3 };
    const attachment = { id: "att-1", fileName: "notes.md", mimeType: "text/markdown" };
    const item = createQueueItem({ images: [image], attachments: [attachment] });
    const view = createView([item]);

    retrieveQueuedPrompt.call(view, item.id);
    const [prompt, , images, , attachments, , contextFilePath] =
      await submitThroughRealSendPath(view);

    expect(view.plugin.ensureModelCatalogLoaded).toHaveBeenCalledOnce();
    expect(prompt).toBe("Summarize this note");
    expect(images).toEqual([image]);
    expect(attachments).toEqual([attachment]);
    expect(contextFilePath).toBe("Note.md");
  });

  it("clears the composer state it consumed from state", async () => {
    const item = createQueueItem({ images: [{ id: "img-1", fileName: "shot.png" }] });
    const view = createView([item]);

    retrieveQueuedPrompt.call(view, item.id);
    await submitThroughRealSendPath(view);

    expect(view.state.composerImages).toEqual([]);
    expect(view.state.composerAttachments).toEqual([]);
    expect(view.inputEl.value).toBe("");
    expect(view.renderComposerImages).toHaveBeenCalled();
    expect(view.setRunningState).toHaveBeenCalledWith(false);
  });

  it("restores an attachment-only prompt and sends it without a model image check", async () => {
    const attachment = { id: "att-1", fileName: "notes.md", mimeType: "text/markdown" };
    const item = createQueueItem({ prompt: "", attachments: [attachment] });
    const view = createView([item]);

    retrieveQueuedPrompt.call(view, item.id);
    const [prompt, , images, , attachments] = await submitThroughRealSendPath(view);

    expect(prompt).toBe("");
    expect(images).toEqual([]);
    expect(attachments).toEqual([attachment]);
    expect(view.plugin.ensureModelCatalogLoaded).not.toHaveBeenCalled();
  });
});

describe("prompt-queue.mjs has no stale field access", () => {
  it("reads every migrated field through this.state", () => {
    // Guards the functions the behavioural tests above do not drive, such as the
    // queue rendering paths. `promptQueueEl` is a DOM element, not view state,
    // so the trailing boundary keeps it out of the match.
    for (const field of MIGRATED_FIELDS) {
      const legacyAccess = new RegExp(`this\\.${field}\\b`, "g");
      expect(QUEUE_SOURCE.match(legacyAccess), `this.${field} is stale`).toBeNull();
    }
  });

  it("types its methods against the shared view surface", () => {
    const surfaceTags =
      QUEUE_SOURCE.match(/@this \{import\("\.\/view\/view-surface\.mjs"\)/g) ?? [];
    expect(surfaceTags.length).toBeGreaterThan(0);
    expect(QUEUE_SOURCE).not.toContain('import("./PiAgentView.mjs")');
  });
});
