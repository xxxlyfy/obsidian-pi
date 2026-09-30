import { beforeEach, describe, expect, it, vi } from "vitest";

const notices = [];
vi.mock("obsidian", () => ({
  Notice: class {
    constructor(message) {
      notices.push(message);
    }
  }
}));

import {
  enrichPromptDelivery,
  requeuePendingPrompt,
  resolvePromptInput
} from "../src/ui/view/run-prompt.mjs";
import { normalizeLocalPromptQueue } from "../src/ui/local-prompt-queue.mjs";

/** A view whose only state is the queue, so the stages can be observed. */
function createView(overrides = {}) {
  const queue = [];
  return {
    plugin: {
      replaceLocalPromptQueue: vi.fn((next) => {
        queue.length = 0;
        queue.push(...next);
      }),
      getLocalPromptQueue: () => queue,
      ...overrides.plugin
    },
    state: { promptQueue: queue },
    renderPromptQueue: vi.fn(),
    ...overrides.view
  };
}

beforeEach(() => {
  notices.length = 0;
});

describe("resolvePromptInput", () => {
  it("passes through annotations the caller already resolved", async () => {
    const view = createView();
    const consume = vi.fn();
    view.plugin.consumeAnnotationsForPrompt = consume;
    const annotations = [{ path: "a.md", id: "1" }];

    const result = await resolvePromptInput(view, "a.md", annotations);

    expect(result).toEqual({ annotations, failed: false });
    expect(consume).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it("consumes annotations when the caller did not resolve them", async () => {
    const view = createView();
    const annotations = [{ path: "a.md", id: "1" }];
    view.plugin.consumeAnnotationsForPrompt = vi.fn(async () => annotations);

    const result = await resolvePromptInput(view, "a.md", undefined);

    expect(result).toEqual({ annotations, failed: false });
    expect(view.plugin.consumeAnnotationsForPrompt).toHaveBeenCalledWith("a.md");
  });

  it("reports failure and shows the message when consumption throws", async () => {
    const view = createView();
    view.plugin.consumeAnnotationsForPrompt = vi.fn(async () => {
      throw new Error("annotation source is gone");
    });

    const result = await resolvePromptInput(view, "a.md", undefined);

    expect(result.failed).toBe(true);
    expect(result.annotations).toBeUndefined();
    expect(notices).toEqual(["annotation source is gone"]);
  });
});

describe("enrichPromptDelivery", () => {
  const request = () => ({
    prompt: "hello",
    images: [],
    attachments: [],
    annotations: [],
    annotationSourcePath: "note.md",
    threadId: "thread-1"
  });

  it("returns the enriched prompt, images and attachments on success", async () => {
    const view = createView();
    view.plugin.enrichPromptDelivery = vi.fn(async () => ({
      prompt: "  enriched  ",
      images: [{ id: "i1" }],
      attachments: [{ id: "a1" }],
      promptContext: { context: true }
    }));
    view.plugin.ensureModelCatalogLoaded = vi.fn(async () => {});
    view.plugin.getSelectedModelInfo = () => ({ supportsImages: true });

    const result = await enrichPromptDelivery(view, request());

    expect(result.ok).toBe(true);
    expect(result.prompt).toBe("enriched");
    expect(result.images).toEqual([{ id: "i1" }]);
    expect(result.attachments).toEqual([{ id: "a1" }]);
    // Same object the plugin produced, so the caller's promptContext is intact.
    expect(result.promptContext).toMatchObject({ context: true });
    // The delivery request carries the annotation source as the context path.
    expect(view.plugin.enrichPromptDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ contextFilePath: "note.md" }),
      { mode: "prompt", threadId: "thread-1" }
    );
  });

  it("passes the caller's images and attachments through to the plugin", async () => {
    const view = createView();
    const images = [{ id: "i1" }];
    const attachments = [{ id: "a1" }];
    view.plugin.enrichPromptDelivery = vi.fn(async () => ({
      prompt: "hello",
      images,
      attachments,
      promptContext: undefined
    }));
    view.plugin.ensureModelCatalogLoaded = vi.fn(async () => {});
    view.plugin.getSelectedModelInfo = () => ({ supportsImages: true });

    const result = await enrichPromptDelivery(view, {
      ...request(),
      images,
      attachments
    });

    expect(result.ok).toBe(true);
    expect(view.plugin.enrichPromptDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ images, attachments }),
      expect.anything()
    );
  });

  it("fails with the thrown message and asks for a notice", async () => {
    const view = createView();
    view.plugin.enrichPromptDelivery = vi.fn(async () => {
      throw new Error("enrichment exploded");
    });

    const result = await enrichPromptDelivery(view, request());

    expect(result).toEqual({ ok: false, notice: true, failure: "enrichment exploded" });
  });

  it("rejects an empty prompt but leaves the notice to the caller", async () => {
    const view = createView();
    view.plugin.enrichPromptDelivery = vi.fn(async () => ({
      prompt: "   ",
      images: [],
      attachments: [],
      promptContext: undefined
    }));

    const result = await enrichPromptDelivery(view, request());

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("The queued message became empty and was not sent.");
    // The original code only announced this to a queued caller, so the stage
    // must not claim a notice is wanted here.
    expect(result.notice).toBe(false);
  });

  it("rejects images when the selected model cannot take them", async () => {
    const view = createView();
    view.plugin.enrichPromptDelivery = vi.fn(async () => ({
      prompt: "look at this",
      images: [{ id: "i1" }],
      attachments: [],
      promptContext: undefined
    }));
    view.plugin.ensureModelCatalogLoaded = vi.fn(async () => {});
    view.plugin.getSelectedModelInfo = () => ({ supportsImages: false });

    const result = await enrichPromptDelivery(view, request());

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("The selected Pi model does not support image input.");
    expect(result.notice).toBe(true);
  });
});

describe("requeuePendingPrompt", () => {
  it("moves the queued item back to pending and persists the queue", () => {
    const view = createView();
    view.state.promptQueue = normalizeLocalPromptQueue([
      { id: "q1", prompt: "queued", images: [], threadId: "t", state: "delivering" }
    ]);

    requeuePendingPrompt(view, "q1");

    expect(view.state.promptQueue[0].state).toBe("pending");
    expect(view.plugin.replaceLocalPromptQueue).toHaveBeenCalledWith(view.state.promptQueue);
    expect(view.renderPromptQueue).toHaveBeenCalledOnce();
  });

  it("does nothing for a directly-typed prompt with no queue id", () => {
    const view = createView();

    requeuePendingPrompt(view, undefined);

    expect(view.plugin.replaceLocalPromptQueue).not.toHaveBeenCalled();
    expect(view.renderPromptQueue).not.toHaveBeenCalled();
  });
});
