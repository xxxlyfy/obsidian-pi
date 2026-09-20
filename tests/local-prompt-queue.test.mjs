import { describe, expect, it } from "vitest";
import { captureAnchor } from "../src/annotations/annotation-anchors.mjs";
import {
  claimLocalPrompt,
  enqueueLocalPrompt,
  invalidateLocalPromptPaths,
  migrateLocalPromptPaths,
  nextDeliverablePrompt,
  normalizeLocalPromptQueue,
  releaseLocalPrompt,
  removeLocalPrompt,
  restoreLocalPrompt,
  restorePersistedLocalPromptQueue,
  takeLocalPrompt,
  updateLocalPrompt
} from "../src/ui/local-prompt-queue.mjs";

function queue() {
  return [
    { id: "one", prompt: "first", images: [], threadId: "a", createdAt: 1 },
    { id: "two", prompt: "second", images: [], threadId: "b", createdAt: 2 }
  ];
}

describe("local prompt queue", () => {
  it("preserves strict order while the first item's thread is running", () => {
    const normalized = normalizeLocalPromptQueue(queue());
    expect(nextDeliverablePrompt(normalized, (thread) => thread === "a")).toBeUndefined();
    expect(nextDeliverablePrompt(normalized, () => false)?.id).toBe("one");
    expect(
      enqueueLocalPrompt(normalized, { prompt: "third", threadId: "a" }).map((x) => x.prompt)
    ).toEqual(["first", "second", "third"]);
  });

  it("claims steering exactly once and can release it after an RPC failure", () => {
    const firstClaim = claimLocalPrompt(normalizeLocalPromptQueue(queue()), "one");
    expect(firstClaim.item?.state).toBe("steering");
    expect(claimLocalPrompt(firstClaim.queue, "one").item).toBeUndefined();
    expect(releaseLocalPrompt(firstClaim.queue, "one")[0].state).toBe("pending");
  });

  it("recovers interrupted steering without duplicating persisted items", () => {
    const restored = restorePersistedLocalPromptQueue(queue().slice(1), [queue()[0], queue()[1]]);
    expect(restored.map((item) => item.id)).toEqual(["one", "two"]);
    expect(restored.every((item) => item.state === "pending")).toBe(true);
  });

  it("atomically removes steering items and restores their queue position on rejection", () => {
    const taken = takeLocalPrompt(normalizeLocalPromptQueue(queue()), "one");
    expect(taken.queue.map((item) => item.id)).toEqual(["two"]);
    expect(takeLocalPrompt(taken.queue, "one").item).toBeUndefined();
    expect(restoreLocalPrompt(taken.queue, taken.item, taken.index).map((item) => item.id)).toEqual(
      ["one", "two"]
    );
  });

  it("persists text attachments through claim, restore, retrieve-style edit, and one-time take", () => {
    const attachment = {
      id: "file-1",
      kind: "text",
      fileName: "config.yaml",
      mimeType: "application/yaml",
      content: "enabled: true",
      originalSize: 13,
      includedBytes: 13,
      truncated: false,
      source: "vault",
      path: "config.yaml"
    };
    const normalized = normalizeLocalPromptQueue([
      {
        id: "files",
        prompt: "review",
        images: [],
        attachments: [attachment],
        threadId: "a",
        createdAt: 1
      }
    ]);
    expect(normalized[0].attachments).toEqual([attachment]);
    const taken = takeLocalPrompt(normalized, "files");
    expect(taken.item.attachments[0].fileName).toBe("config.yaml");
    expect(takeLocalPrompt(taken.queue, "files").item).toBeUndefined();
    const restored = restoreLocalPrompt(taken.queue, taken.item, taken.index);
    expect(claimLocalPrompt(restored, "files", "delivering").item.state).toBe("delivering");
  });

  it("persists a consumed annotation snapshot through queue claims and restoration", () => {
    const annotation = {
      id: "annotation-1",
      path: "Note.md",
      intent: "change",
      context: "Rewrite this",
      targetKind: "selection",
      ...captureAnchor("before target after", 7, 13)
    };
    const normalized = normalizeLocalPromptQueue([
      {
        id: "annotated",
        prompt: "Apply annotations",
        annotations: [annotation],
        threadId: "a",
        createdAt: 1
      }
    ]);

    expect(normalized[0].annotations).toHaveLength(1);
    expect(normalized[0]).not.toHaveProperty("annotationBatchId");
    annotation.context = "mutated after enqueue";
    expect(normalized[0].annotations[0].context).toBe("Rewrite this");
    const taken = takeLocalPrompt(normalized, "annotated");
    const restored = restoreLocalPrompt(taken.queue, taken.item, taken.index);
    expect(restored[0].annotations[0]).toMatchObject({
      id: "annotation-1",
      path: "Note.md",
      context: "Rewrite this"
    });
  });

  it("supports safe edit and removal by stable id", () => {
    const edited = updateLocalPrompt(normalizeLocalPromptQueue(queue()), "two", {
      prompt: "changed"
    });
    expect(edited[1].prompt).toBe("changed");
    expect(removeLocalPrompt(edited, "one").map((item) => item.id)).toEqual(["two"]);
  });

  it("migrates queued annotation, attachment, and image paths when a note is renamed", () => {
    const annotation = {
      id: "annotation-1",
      path: "A.md",
      intent: "change",
      context: "Rewrite this",
      targetKind: "selection",
      ...captureAnchor("before target after", 7, 13)
    };
    const image = {
      id: "image-1",
      fileName: "pic.png",
      mimeType: "image/png",
      data: "aGk=",
      size: 3,
      source: "vault",
      path: "A.md"
    };
    const attachment = {
      id: "file-1",
      kind: "text",
      fileName: "config.yaml",
      mimeType: "application/yaml",
      content: "enabled: true",
      originalSize: 13,
      includedBytes: 13,
      truncated: false,
      source: "vault",
      path: "A.md"
    };
    const normalized = normalizeLocalPromptQueue([
      {
        id: "annotated",
        prompt: "Apply annotations",
        annotations: [annotation],
        images: [image],
        attachments: [attachment],
        contextFilePath: "A.md",
        threadId: "a",
        createdAt: 1
      },
      { id: "plain", prompt: "plain", threadId: "a", createdAt: 2 }
    ]);

    const migrated = migrateLocalPromptPaths(normalized, "A.md", "B.md");

    expect(migrated[0].contextFilePath).toBe("B.md");
    expect(migrated[0].annotations[0].path).toBe("B.md");
    expect(migrated[0].images[0].path).toBe("B.md");
    expect(migrated[0].attachments[0].path).toBe("B.md");
    expect(migrated[0].state).toBe("pending");
    expect(migrated[1].contextFilePath).toBeUndefined();
    expect(migrated[1].annotations).toEqual([]);
    expect(normalized[0].contextFilePath).toBe("A.md");
    expect(normalized[0].annotations[0].path).toBe("A.md");
    expect(normalized[0].images[0].path).toBe("A.md");
    expect(normalized[0].attachments[0].path).toBe("A.md");
  });

  it("drops queued annotations and clears queued attachment paths for a deleted note", () => {
    const normalized = normalizeLocalPromptQueue([
      {
        id: "annotated",
        prompt: "Apply annotations",
        annotations: [
          {
            id: "annotation-1",
            path: "A.md",
            intent: "change",
            context: "Rewrite this",
            targetKind: "selection",
            ...captureAnchor("before target after", 7, 13)
          },
          {
            id: "annotation-2",
            path: "B.md",
            intent: "change",
            context: "Rewrite that",
            targetKind: "selection",
            ...captureAnchor("before target after", 7, 13)
          }
        ],
        images: [
          {
            id: "image-1",
            fileName: "pic.png",
            mimeType: "image/png",
            data: "aGk=",
            size: 3,
            source: "vault",
            path: "A.md"
          }
        ],
        attachments: [
          {
            id: "file-1",
            kind: "text",
            fileName: "config.yaml",
            mimeType: "application/yaml",
            content: "enabled: true",
            originalSize: 13,
            includedBytes: 13,
            truncated: false,
            source: "vault",
            path: "A.md"
          }
        ],
        contextFilePath: "A.md",
        threadId: "a",
        createdAt: 1
      }
    ]);

    const invalidated = invalidateLocalPromptPaths(normalized, "A.md");

    expect(invalidated[0].contextFilePath).toBeUndefined();
    expect(invalidated[0].annotations.map((annotation) => annotation.id)).toEqual(["annotation-2"]);
    expect(invalidated[0].images[0].path).toBeUndefined();
    expect(invalidated[0].attachments[0].path).toBeUndefined();
    expect(normalized[0].annotations).toHaveLength(2);
    expect(normalized[0].contextFilePath).toBe("A.md");
    expect(normalized[0].images[0].path).toBe("A.md");
    expect(normalized[0].attachments[0].path).toBe("A.md");
  });
});
