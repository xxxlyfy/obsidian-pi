import { describe, expect, it, vi } from "vitest";
import { PromptQueueService } from "../src/agent/prompt-queue-service.mjs";

function createQueue(overrides = {}) {
  const persist = vi.fn();
  const queue = new PromptQueueService({ persist, ...overrides });
  return { queue, persist };
}

function item(overrides = {}) {
  return {
    id: "q1",
    prompt: "follow up",
    threadId: "t1",
    createdAt: 1,
    images: [{ mimeType: "image/png", data: "AAAA", fileName: "shot.png" }],
    contextFilePath: "A.md",
    includeActiveNote: true,
    ...overrides
  };
}

describe("PromptQueueService", () => {
  it("enqueues items, persists, and returns the stored copy", () => {
    const { queue, persist } = createQueue();

    const stored = queue.enqueue(item());

    expect(stored).toMatchObject({ id: "q1", prompt: "follow up" });
    expect(queue.getItems()).toHaveLength(1);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("hands out deep copies so callers cannot mutate stored items", () => {
    const { queue } = createQueue();
    queue.enqueue(item());

    const [copy] = queue.getItems();
    copy.images[0].data = "changed";
    copy.prompt = "changed";

    expect(queue.getItems()[0].images[0].data).toBe("AAAA");
    expect(queue.getItems()[0].prompt).toBe("follow up");
  });

  it("updates and removes items by id", () => {
    const { queue, persist } = createQueue();
    queue.enqueue(item());

    queue.update("q1", { prompt: "edited prompt" });
    expect(queue.getItems()[0].prompt).toBe("edited prompt");

    queue.remove("q1");
    expect(queue.getItems()).toEqual([]);
    expect(persist).toHaveBeenCalledTimes(3);
  });

  it("replaces the queue with a normalized copy", () => {
    const { queue } = createQueue();

    queue.replace([item({ id: "q2" }), { prompt: "" }]);

    expect(queue.getItems().map((entry) => entry.id)).toEqual(["q2"]);
  });

  it("tracks steering items once each", () => {
    const { queue, persist } = createQueue();

    queue.beginSteering(item());
    queue.beginSteering(item());

    expect(queue.toJSON().localPromptSteering).toHaveLength(1);

    queue.finishSteering("q1");
    expect(queue.toJSON().localPromptSteering).toEqual([]);
    expect(persist).toHaveBeenCalledTimes(3);
  });

  it("migrates and invalidates queued paths in both lists", () => {
    const { queue } = createQueue();
    queue.enqueue(item({ contextFilePath: "Notes/Old.md", images: [] }));
    queue.beginSteering(item({ contextFilePath: "Notes/Old.md", images: [] }));

    queue.migratePaths("Notes/Old.md", "Notes/New.md");
    expect(queue.getItems()[0].contextFilePath).toBe("Notes/New.md");
    expect(queue.toJSON().localPromptSteering[0].contextFilePath).toBe("Notes/New.md");

    queue.invalidatePaths("Notes/New.md");
    expect(queue.getItems()[0].contextFilePath).toBeUndefined();
    expect(queue.toJSON().localPromptSteering[0].contextFilePath).toBeUndefined();
  });

  it("keeps the pause flag in memory without persisting it", () => {
    const { queue, persist } = createQueue({ paused: true });

    expect(queue.isPaused()).toBe(true);
    queue.resume();

    expect(queue.isPaused()).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it("serializes queue and steering for plugin data", () => {
    const { queue } = createQueue({
      items: [item()],
      steering: [item({ id: "s1" })],
      paused: true
    });

    expect(queue.toJSON()).toEqual({
      localPromptQueue: [expect.objectContaining({ id: "q1" })],
      localPromptSteering: [expect.objectContaining({ id: "s1" })]
    });
    expect(queue.isPaused()).toBe(true);
  });
});
