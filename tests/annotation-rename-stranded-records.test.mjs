// What happens to a renamed note's annotations when they cannot all come along?
//
// `PiAgentPlugin.mjs` follows Obsidian's vault rename event with
// `annotationStore.renamePath(oldPath, file.path)` and reports the outcome. This file
// pins that contract with the real `AnnotationStore` and the real production limits
// from `annotation-model.mjs`. Only the store layer is exercised - see the
// environment note at the bottom of this file.
//
// Facts this file pins:
//   1 baseline       -> a move that fits takes every record: the new path owns them
//                       and the old path keeps none.
//   2 partial move   -> when the destination cannot take them all, the records that
//                       fit move anyway, the destination's own records are never
//                       dropped or reordered, and the rest stay where they were.
//   3 no room        -> when the destination is already at its ceiling nothing moves,
//                       but nothing is lost either: every record is still persisted.
//   4 duplicates     -> a moving record whose id the destination already holds is that
//                       same annotation arriving twice, and only then is it dropped.
//   5 persistence    -> whatever stayed behind is what `data.json` keeps, it survives
//                       a reload unchanged, and it still answers for the budget it
//                       occupies.
//   6 reclaimable    -> the retention is recoverable rather than permanent: a later
//                       rename of the same path moves the records the destination now
//                       has room for, so a refused move is a delay, not a loss.
//   7 visible        -> `orphanedAnnotationPaths()` names exactly the paths whose
//                       records no longer have a note, which is what the plugin reports
//                       on load.

import { describe, expect, it } from "vitest";
import { captureAnchor } from "../src/annotations/annotation-anchors.mjs";
import { ANNOTATION_LIMITS, annotationDataBytes } from "../src/annotations/annotation-model.mjs";
import { AnnotationStore } from "../src/annotations/annotation-store.mjs";

const NOTE_TEXT = "before target after";
const anchor = captureAnchor(NOTE_TEXT, 7, 13);

function input(path, id, context = "Rewrite this") {
  return {
    id,
    path,
    intent: "change",
    context,
    targetKind: "selection",
    ...anchor
  };
}

/** A note's records, as the store would hold them. */
const records = (path, ids, context) => ids.map((id) => input(path, `${path}:${id}`, context));

/** Fill a path to its own per-path ceiling, as a heavily annotated note is. */
function fillPath(path, count, context) {
  return records(
    path,
    Array.from({ length: count }, (_, index) => `n${index}`),
    context
  );
}

const countAll = (store) =>
  Object.values(store.toJSON().annotations).reduce((sum, items) => sum + items.length, 0);

describe("AnnotationStore rename when the destination cannot take every annotation", () => {
  it("1 (baseline): a rename that fits moves every record to the new path", () => {
    const store = new AnnotationStore({
      schemaVersion: 1,
      annotations: { "Old.md": records("Old.md", ["a"]) }
    });

    const result = store.renamePath("Old.md", "New.md");

    expect(result).toMatchObject({ status: "moved", ok: true, moved: 1, retained: null });
    expect(store.list("Old.md")).toEqual([]);
    expect(Object.keys(store.toJSON().annotations)).toEqual(["New.md"]);
    const moved = store.list("New.md");
    expect(moved.map((item) => item.id)).toEqual(["Old.md:a"]);
    expect(moved[0].path).toBe("New.md");
  });

  it("2 (partial): the destination keeps its own records and takes what fits", () => {
    // The destination is one record below its ceiling, so exactly one of the three
    // incoming records can follow the rename. Before the fix a single such rename
    // moved nothing at all and left the whole note's annotations behind.
    const store = new AnnotationStore({
      schemaVersion: 1,
      annotations: {
        "Old.md": records("Old.md", ["s1", "s2", "s3"]),
        "New.md": fillPath("New.md", ANNOTATION_LIMITS.perPath - 1, "destination")
      }
    });

    const result = store.renamePath("Old.md", "New.md");

    expect(result).toMatchObject({
      status: "partial",
      ok: true,
      moved: 1,
      droppedDuplicates: 0,
      reason: "per-path",
      retained: { path: "Old.md", count: 2 }
    });
    // Every destination record survived, in place, ahead of the one that arrived.
    const destination = store.list("New.md");
    expect(destination).toHaveLength(ANNOTATION_LIMITS.perPath);
    expect(destination.slice(0, -1).every((item) => item.context === "destination")).toBe(true);
    expect(destination.at(-1)).toMatchObject({ id: "Old.md:s1", path: "New.md" });
    // The rest stay exactly as they were, so a later rename can still carry them.
    expect(store.list("Old.md").map((item) => item.id)).toEqual(["Old.md:s2", "Old.md:s3"]);
    expect(store.list("Old.md").every((item) => item.path === "Old.md")).toBe(true);
  });

  it("3 (no room): a full destination moves nothing but loses nothing", () => {
    const store = new AnnotationStore({
      schemaVersion: 1,
      annotations: {
        "Old.md": records("Old.md", ["s1", "s2"]),
        "New.md": fillPath("New.md", ANNOTATION_LIMITS.perPath, "destination")
      }
    });
    const before = store.toJSON();

    const result = store.renamePath("Old.md", "New.md");

    expect(result).toMatchObject({
      status: "none",
      ok: false,
      moved: 0,
      reason: "per-path",
      retained: { path: "Old.md", count: 2 }
    });
    // Refusing must not half-apply: nothing moved, nothing was dropped.
    expect(store.list("Old.md").map((item) => item.id)).toEqual(["Old.md:s1", "Old.md:s2"]);
    expect(store.list("New.md")).toHaveLength(ANNOTATION_LIMITS.perPath);
    expect(store.toJSON()).toEqual(before);
  });

  it("4 (duplicates): only an id the destination already holds is dropped", () => {
    const store = new AnnotationStore({
      schemaVersion: 1,
      annotations: {
        "Old.md": [input("Old.md", "shared"), input("Old.md", "unique")],
        "New.md": [input("New.md", "shared")]
      }
    });

    const result = store.renamePath("Old.md", "New.md");

    expect(result).toMatchObject({ status: "moved", moved: 1, droppedDuplicates: 1 });
    expect(store.list("New.md").map((item) => item.id)).toEqual(["shared", "unique"]);
    // Dropping the duplicate leaves nothing behind on the old path.
    expect(store.list("Old.md")).toEqual([]);
    expect(Object.keys(store.toJSON().annotations)).toEqual(["New.md"]);
  });

  it("4b (duplicates): an all-duplicate rename still clears the old path", () => {
    const store = new AnnotationStore({
      schemaVersion: 1,
      annotations: {
        "Old.md": [input("Old.md", "shared")],
        "New.md": [input("New.md", "shared")]
      }
    });

    const result = store.renamePath("Old.md", "New.md");

    expect(result).toMatchObject({ status: "moved", ok: true, moved: 0, droppedDuplicates: 1 });
    expect(store.list("Old.md")).toEqual([]);
    expect(store.list("New.md")).toHaveLength(1);
  });

  it("5 (persistence): what stayed behind is what data.json keeps, and it survives a reload", () => {
    const store = new AnnotationStore({
      schemaVersion: 1,
      annotations: {
        "Old.md": records("Old.md", ["s1", "s2", "s3"]),
        "New.md": fillPath("New.md", ANNOTATION_LIMITS.perPath - 1, "destination")
      }
    });

    expect(store.renamePath("Old.md", "New.md").status).toBe("partial");

    // What `PiAgentPlugin.savePluginData()` serializes into `data.json`.
    const persisted = store.toJSON();
    expect(persisted.annotations["Old.md"]?.map((item) => item.id)).toEqual([
      "Old.md:s2",
      "Old.md:s3"
    ]);
    expect(persisted.annotations["Old.md"].every((item) => item.path === "Old.md")).toBe(true);

    // `data.json` is JSON, and the plugin re-normalizes it on load. The partial write
    // must not push the destination past the ceiling the loader enforces, or the
    // reload would silently drop records instead of keeping them at the old path.
    const reloaded = new AnnotationStore(JSON.parse(JSON.stringify(persisted)));
    expect(reloaded.list("Old.md")).toEqual(store.list("Old.md"));
    expect(reloaded.list("New.md")).toEqual(store.list("New.md"));
    expect(reloaded.list("New.md")).toHaveLength(ANNOTATION_LIMITS.perPath);
    expect(reloaded.count()).toBe(store.count());
  });

  it("5b (budget): the records that stayed keep consuming annotation capacity", () => {
    const store = new AnnotationStore({
      schemaVersion: 1,
      annotations: {
        "Old.md": records("Old.md", ["s1", "s2"]),
        "New.md": fillPath("New.md", ANNOTATION_LIMITS.perPath, "destination")
      }
    });
    const totalBefore = countAll(store);
    expect(store.renamePath("Old.md", "New.md").status).toBe("none");

    // The store's own accounting still includes them...
    expect(countAll(store)).toBe(totalBefore);
    expect(countAll(store)).toBe(store.count());

    // ...and so does the serialized storage the byte budget is measured on: the
    // retained records are real data that a later move has to fit.
    const persisted = store.toJSON();
    const strandedBytes = annotationDataBytes(persisted) - annotationDataBytes({ annotations: [] });
    expect(strandedBytes).toBeGreaterThan(0);
  });

  it("6 (reclaimable): a later rename moves the records the destination now has room for", () => {
    const store = new AnnotationStore({
      schemaVersion: 1,
      annotations: {
        "Old.md": records("Old.md", ["s1", "s2", "s3"]),
        "New.md": fillPath("New.md", ANNOTATION_LIMITS.perPath, "destination")
      }
    });

    // Nothing fits yet...
    expect(store.renamePath("Old.md", "New.md")).toMatchObject({
      status: "none",
      retained: { path: "Old.md", count: 3 }
    });

    // ...and as soon as the destination frees two slots, the retry takes them. This is
    // the property the old all-or-nothing refusal did not have: the records were kept,
    // but no ordinary lifecycle ever moved them again.
    store.delete("New.md", "New.md:n0");
    store.delete("New.md", "New.md:n1");
    const retry = store.renamePath("Old.md", "New.md");

    expect(retry).toMatchObject({
      status: "partial",
      moved: 2,
      retained: { path: "Old.md", count: 1 }
    });
    expect(store.list("Old.md").map((item) => item.id)).toEqual(["Old.md:s3"]);

    // A note that moves to a fresh path takes the remainder with it.
    const final = store.renamePath("Old.md", "Final.md");
    expect(final).toMatchObject({ status: "moved", moved: 1, retained: null });
    expect(store.list("Final.md").map((item) => item.id)).toEqual(["Old.md:s3"]);
    expect(store.list("Old.md")).toEqual([]);
  });

  it("6b (reclaimable): a note renamed on keeps carrying the records it took", () => {
    const store = new AnnotationStore({
      schemaVersion: 1,
      annotations: {
        "Old.md": records("Old.md", ["s1"]),
        "New.md": fillPath("New.md", ANNOTATION_LIMITS.perPath - 1, "destination")
      }
    });
    expect(store.renamePath("Old.md", "New.md").moved).toBe(1);

    // The destination moves on again: the record that followed it follows this time too.
    const next = store.renamePath("New.md", "Final.md");
    expect(next).toMatchObject({ status: "moved", moved: ANNOTATION_LIMITS.perPath });
    expect(store.list("Final.md")).toHaveLength(ANNOTATION_LIMITS.perPath);
    expect(store.list("New.md")).toEqual([]);
  });

  it("7 (visible): orphanedAnnotationPaths names the paths that no longer have a note", () => {
    const store = new AnnotationStore({
      schemaVersion: 1,
      annotations: {
        "Old.md": records("Old.md", ["s1", "s2"]),
        "New.md": fillPath("New.md", ANNOTATION_LIMITS.perPath, "destination")
      }
    });
    expect(store.renamePath("Old.md", "New.md").status).toBe("none");

    // The renamed note left `Old.md` without a note, and its two records are what the
    // plugin reports on load. `New.md` still exists and is not reported.
    const vaultPaths = new Set(["New.md"]);
    expect(store.orphanedAnnotationPaths(vaultPaths)).toEqual(["Old.md"]);

    // Once a note is back at that path the records are reachable again.
    expect(store.orphanedAnnotationPaths(new Set(["New.md", "Old.md"]))).toEqual([]);
    expect(store.list("Old.md")).toHaveLength(2);
  });

  it("7b (visible): annotations on a note that exists are never reported", () => {
    const store = new AnnotationStore({
      schemaVersion: 1,
      annotations: { "Here.md": records("Here.md", ["h"]) }
    });
    expect(store.orphanedAnnotationPaths((path) => path === "Here.md")).toEqual([]);
    expect(store.orphanedAnnotationPaths((path) => path === "Elsewhere.md")).toEqual(["Here.md"]);
  });
});

// Environment note: this file exercises the annotation store and its persisted
// representation - the layer that owns the records and the budget. It does not run
// Obsidian, so it does not prove that Obsidian's vault `rename` event fires for a
// rename whose destination already has annotations, nor that the plugin's Notice
// appears; `tests/annotation-rename-notice.test.mjs` covers the plugin's reporting.
// What it does prove is the store-level outcome the plugin's handler defers to: the
// destination's records are never dropped, whatever does not fit stays in the data
// that gets written to `data.json`, and a later rename of the same path moves it.
