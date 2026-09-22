import { describe, expect, it, vi } from "vitest";
import { PromptDelivery } from "../src/agent/prompt-delivery.mjs";
import { STRINGS } from "../src/shared/strings.mjs";

const IMAGE = { mimeType: "image/png", data: "AAAA" };

function createDelivery(overrides = {}) {
  const events = { enqueued: [], requeued: [], restored: [], notices: [] };
  const delivery = new PromptDelivery({
    consumeAnnotations: vi.fn(async () => [{ id: "a1", path: "Notes/A.md" }]),
    restoreAnnotations: (annotations) => events.restored.push(annotations),
    buildDelivery: vi.fn(async (request) => ({
      prompt: request.prompt,
      images: request.images,
      attachments: request.attachments,
      promptContext: { activeNote: { path: "Notes/A.md" } }
    })),
    isThreadRunning: () => false,
    enqueueQueuedPrompt: (item) => events.enqueued.push(item),
    requeueQueuedPrompt: (queuedId) => events.requeued.push(queuedId),
    ensureModelsLoaded: vi.fn(async () => {}),
    getSelectedModelInfo: () => ({ supportsImages: true }),
    shouldIncludeActiveNote: () => true,
    notify: (message) => events.notices.push(message),
    ...overrides
  });
  return { delivery, events };
}

const BASE_REQUEST = { prompt: "hello", threadId: "t1", images: [], attachments: [] };

describe("PromptDelivery.prepare", () => {
  it("consumes annotations once and returns the prepared run payload", async () => {
    const { delivery } = createDelivery();

    const result = await delivery.prepare(BASE_REQUEST);

    expect(result.ok).toBe(true);
    expect(result.prepared).toMatchObject({
      prompt: "hello",
      threadId: "t1",
      queuedId: undefined,
      annotationSnapshot: { annotations: [{ id: "a1", path: "Notes/A.md" }], sourcePath: undefined }
    });
    expect(delivery.consumeAnnotations).toHaveBeenCalledOnce();
  });

  it("uses a provided annotation snapshot instead of consuming notes again", async () => {
    const { delivery } = createDelivery();
    const annotations = [{ id: "given", path: "Notes/B.md" }];

    const result = await delivery.prepare({ ...BASE_REQUEST, annotations });

    expect(result.ok).toBe(true);
    expect(result.prepared.annotationSnapshot.annotations).toEqual(annotations);
    expect(delivery.consumeAnnotations).not.toHaveBeenCalled();
  });

  it("queues the prompt when the thread already has a run", async () => {
    const { delivery, events } = createDelivery({ isThreadRunning: () => true });

    const result = await delivery.prepare(BASE_REQUEST);

    expect(result).toEqual({ ok: false });
    expect(events.enqueued).toEqual([
      expect.objectContaining({ prompt: "hello", threadId: "t1", includeActiveNote: true })
    ]);
  });

  it("returns a queued delivery to the queue instead of duplicating it", async () => {
    const { delivery, events } = createDelivery({ isThreadRunning: () => true });

    const result = await delivery.prepare({ ...BASE_REQUEST, queuedId: "q1" });

    expect(result).toEqual({ ok: false });
    expect(events.requeued).toEqual(["q1"]);
    expect(events.enqueued).toEqual([]);
  });

  it("reports a consume failure and stops", async () => {
    const { delivery, events } = createDelivery({
      consumeAnnotations: async () => {
        throw new Error("annotation store down");
      }
    });

    const result = await delivery.prepare(BASE_REQUEST);

    expect(result).toEqual({ ok: false });
    expect(events.notices).toEqual(["annotation store down"]);
    expect(events.restored).toEqual([]);
  });

  it("restores consumed annotations when the delivery fails", async () => {
    const { delivery, events } = createDelivery({
      buildDelivery: async () => {
        throw new Error("context failed");
      }
    });

    const result = await delivery.prepare(BASE_REQUEST);

    expect(result).toEqual({ ok: false });
    expect(events.notices).toEqual(["context failed"]);
    expect(events.restored).toEqual([[{ id: "a1", path: "Notes/A.md" }]]);
  });

  it("treats an empty delivery as nothing to run and restores annotations", async () => {
    const { delivery, events } = createDelivery({
      buildDelivery: async () => ({ prompt: "   ", images: [], attachments: [] })
    });

    const result = await delivery.prepare(BASE_REQUEST);

    expect(result).toEqual({ ok: false });
    expect(events.notices).toEqual([]);
    expect(events.restored).toHaveLength(1);
  });

  it("reports an emptied queued prompt", async () => {
    const { delivery, events } = createDelivery({
      buildDelivery: async () => ({ prompt: "", images: [], attachments: [] })
    });

    const result = await delivery.prepare({ ...BASE_REQUEST, queuedId: "q1" });

    expect(result).toEqual({ ok: false });
    expect(events.notices).toEqual([STRINGS.view.queuedEmpty]);
    expect(events.requeued).toEqual(["q1"]);
  });

  it("loads the model catalog before accepting images", async () => {
    const { delivery } = createDelivery();

    const result = await delivery.prepare({ ...BASE_REQUEST, images: [IMAGE] });

    expect(result.ok).toBe(true);
    expect(delivery.ensureModelsLoaded).toHaveBeenCalledOnce();
  });

  it("rejects images when the selected model cannot read them", async () => {
    const { delivery, events } = createDelivery({ getSelectedModelInfo: () => ({}) });

    const result = await delivery.prepare({ ...BASE_REQUEST, images: [IMAGE] });

    expect(result).toEqual({ ok: false });
    expect(events.notices).toEqual([STRINGS.view.modelNoImage]);
    expect(events.restored).toHaveLength(1);
  });

  it("prefers the composer exclusion over the active-note default", async () => {
    const { delivery } = createDelivery();

    await delivery.prepare({ ...BASE_REQUEST, includeActiveNote: false });

    expect(delivery.buildDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ includeActiveNote: false }),
      { mode: "prompt", threadId: "t1" }
    );
  });

  it("falls back to the view default when no exclusion is given", async () => {
    const { delivery } = createDelivery({ shouldIncludeActiveNote: () => false });

    await delivery.prepare(BASE_REQUEST);

    expect(delivery.buildDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ includeActiveNote: false }),
      { mode: "prompt", threadId: "t1" }
    );
  });
});
