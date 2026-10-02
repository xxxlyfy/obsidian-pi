import { describe, expect, it, vi } from "vitest";
import { captureAnchor } from "../src/annotations/annotation-anchors.mjs";
import { ANNOTATION_LIMITS } from "../src/annotations/annotation-model.mjs";
import { AnnotationStore } from "../src/annotations/annotation-store.mjs";

function input(path = "Note.md", id = "a1") {
  const text = "before target after";
  return {
    id,
    path,
    intent: "change",
    context: "Rewrite this",
    targetKind: "selection",
    ...captureAnchor(text, 7, 13)
  };
}

describe("AnnotationStore", () => {
  it("supports CRUD and emits persistence changes", () => {
    const onChange = vi.fn();
    const store = new AnnotationStore(undefined, onChange);
    const created = store.create(input());
    expect(store.get("Note.md", created.id)?.context).toBe("Rewrite this");

    store.update("Note.md", created.id, { intent: "question", context: "Why?" });
    expect(store.list("Note.md")[0]).toMatchObject({ intent: "question", context: "Why?" });
    expect(store.delete("Note.md", created.id)).toBe(true);
    expect(store.list("Note.md")).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("moves records on rename, merges safely, and removes deleted-note records", () => {
    const store = new AnnotationStore({
      schemaVersion: 1,
      annotations: {
        "Old.md": [input("Old.md", "old")],
        "New.md": [input("New.md", "existing")]
      }
    });

    const result = store.renamePath("Old.md", "New.md");
    expect(result).toMatchObject({ status: "moved", ok: true, moved: 1, droppedDuplicates: 0 });
    expect(store.list("Old.md")).toEqual([]);
    expect(store.list("New.md").map((item) => item.id)).toEqual(["existing", "old"]);
    expect(store.list("New.md")[1].path).toBe("New.md");
    expect(store.deletePath("New.md")).toBe(true);
    expect(store.toJSON().annotations).toEqual({});
  });

  it("keeps the destination's record when a rename carries the same id, and reports the drop", () => {
    const store = new AnnotationStore({
      annotations: {
        "Old.md": [input("Old.md", "same")],
        "New.md": [input("New.md", "same")]
      }
    });

    // The id is the same annotation, so the move stores it once: the destination's copy
    // stays and the arrival is counted instead of failing the whole rename.
    const result = store.renamePath("Old.md", "New.md");
    expect(result).toMatchObject({ status: "moved", moved: 0, droppedDuplicates: 1 });
    expect(store.list("New.md").map((item) => item.id)).toEqual(["same"]);
    expect(store.list("Old.md")).toEqual([]);
  });

  it("reconciles persisted anchors and saves only when their attachment changes", () => {
    const onChange = vi.fn();
    const store = new AnnotationStore(undefined, onChange);
    store.create(input());
    onChange.mockClear();

    const shifted = store.reanchorPath("Note.md", "heading\nbefore target after");
    expect(shifted[0]).toMatchObject({ status: "attached", range: { from: 15, to: 21 } });
    expect(onChange).toHaveBeenCalledTimes(1);
    store.reanchorPath("Note.md", "heading\nbefore target after");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(store.reanchorPath("Note.md", "target elsewhere")[0].status).toBe("detached");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("bounds normalized total records and serialized storage", () => {
    const annotations = {};
    for (let pathIndex = 0; pathIndex < 30; pathIndex += 1) {
      const path = `Note-${pathIndex}.md`;
      annotations[path] = Array.from({ length: 100 }, (_, itemIndex) => ({
        ...input(path, `${pathIndex}-${itemIndex}`),
        context: "x".repeat(4_000),
        quote: "q".repeat(8_000)
      }));
    }
    const store = new AnnotationStore({ annotations });
    const data = store.toJSON();
    const count = Object.values(data.annotations).reduce((sum, items) => sum + items.length, 0);

    expect(count).toBeLessThanOrEqual(ANNOTATION_LIMITS.total);
    expect(new globalThis.TextEncoder().encode(JSON.stringify(data)).length).toBeLessThanOrEqual(
      ANNOTATION_LIMITS.storageBytes
    );
  });

  it("returns copies rather than exposing persisted state", () => {
    const store = new AnnotationStore();
    store.create(input());
    const listed = store.list("Note.md");
    listed[0].context = "mutated";
    expect(store.list("Note.md")[0].context).toBe("Rewrite this");
  });

  it("refuses a replace that would exceed the per-note ceiling instead of truncating", () => {
    const store = new AnnotationStore();
    const tooMany = Array.from({ length: ANNOTATION_LIMITS.perPath + 1 }, (_, index) =>
      input("Note.md", `n${index}`)
    );

    // The loader keeps only the first `perPath` records of a path, so accepting this
    // write would drop the overflow without telling anyone.
    expect(() => store.replacePath("Note.md", tooMany)).toThrow(
      new RegExp(`at most ${ANNOTATION_LIMITS.perPath}`)
    );
    expect(store.list("Note.md")).toEqual([]);

    const exact = tooMany.slice(0, ANNOTATION_LIMITS.perPath);
    expect(store.replacePath("Note.md", exact)).toHaveLength(ANNOTATION_LIMITS.perPath);
  });

  it("refuses a replace that would add a path past the paths ceiling", () => {
    const annotations = {};
    for (let index = 0; index < ANNOTATION_LIMITS.paths; index += 1) {
      annotations[`Note-${index}.md`] = [input(`Note-${index}.md`, `id-${index}`)];
    }
    const store = new AnnotationStore({ schemaVersion: 1, annotations });

    // The loader keeps only the first `paths` keys, so a 501st key is dropped on the
    // next load - together with the record this call just restored.
    expect(() => store.replacePath("Fresh.md", [input("Fresh.md", "fresh")])).toThrow(
      new RegExp(`at most ${ANNOTATION_LIMITS.paths}`)
    );
    expect(Object.keys(store.toJSON().annotations)).toHaveLength(ANNOTATION_LIMITS.paths);
    expect(store.list("Fresh.md")).toEqual([]);

    // Replacing a path the store already carries stays allowed: it adds no key.
    expect(store.replacePath("Note-0.md", [input("Note-0.md", "replaced")])).toHaveLength(1);
  });
});
