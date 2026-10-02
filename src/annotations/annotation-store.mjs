import { structuredCloneSafe } from "../shared/runtime.mjs";
import { reanchorAnnotation } from "./annotation-anchors.mjs";
import {
  ANNOTATION_LIMITS,
  annotationDataBytes,
  createAnnotation,
  normalizeAnnotation,
  normalizeAnnotationData
} from "./annotation-model.mjs";

export class AnnotationStore {
  /**
   * @param {unknown} rawData Persisted annotation data, normalized on load.
   * @param {(data: object) => void} [onChange] Called after every mutation with the new data.
   */
  constructor(rawData, onChange = () => {}) {
    this.data = normalizeAnnotationData(rawData);
    this.onChange = onChange;
  }

  toJSON() {
    return structuredCloneSafe(this.data);
  }

  list(path) {
    return structuredCloneSafe(this.data.annotations[String(path ?? "")] ?? []);
  }

  get(path, id) {
    return this.list(path).find((annotation) => annotation.id === id);
  }

  create(input) {
    const annotation = createAnnotation(input);
    if (!annotation) throw new Error("Invalid annotation.");
    const current = this.data.annotations[annotation.path] ?? [];
    if (current.length >= ANNOTATION_LIMITS.perPath)
      throw new Error(`A note can have at most ${ANNOTATION_LIMITS.perPath} annotations.`);
    if (
      !this.data.annotations[annotation.path] &&
      Object.keys(this.data.annotations).length >= ANNOTATION_LIMITS.paths
    )
      throw new Error(`Annotations can cover at most ${ANNOTATION_LIMITS.paths} notes.`);
    if (this.count() >= ANNOTATION_LIMITS.total)
      throw new Error(`At most ${ANNOTATION_LIMITS.total} annotations can be stored.`);
    if (current.some((item) => item.id === annotation.id))
      throw new Error("Annotation ID already exists.");

    this.assertStorageBudget({
      ...this.data.annotations,
      [annotation.path]: [...current, annotation]
    });
    this.data.annotations[annotation.path] = [...current, annotation];
    this.changed();
    return structuredCloneSafe(annotation);
  }

  update(path, id, patch) {
    const items = this.data.annotations[String(path ?? "")];
    const index = items?.findIndex((annotation) => annotation.id === id) ?? -1;
    if (index < 0) return undefined;
    const existing = items[index];
    const updated = normalizeAnnotation(
      {
        ...existing,
        ...patch,
        id: existing.id,
        path: existing.path,
        range: patch?.range ?? existing.range,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString()
      },
      existing.path
    );
    if (!updated) throw new Error("Invalid annotation update.");
    const updatedItems = items.map((item, itemIndex) => (itemIndex === index ? updated : item));
    this.assertStorageBudget({ ...this.data.annotations, [existing.path]: updatedItems });
    items[index] = updated;
    this.changed();
    return structuredCloneSafe(updated);
  }

  delete(path, id) {
    const key = String(path ?? "");
    const items = this.data.annotations[key];
    if (!items) return false;
    const remaining = items.filter((annotation) => annotation.id !== id);
    if (remaining.length === items.length) return false;
    if (remaining.length > 0) this.data.annotations[key] = remaining;
    else delete this.data.annotations[key];
    this.changed();
    return true;
  }

  /**
   * Move a path's annotations after Obsidian renames, merges, or replaces a note.
   *
   * The destination's existing records always win: they are never dropped or
   * reordered, and the moving records are appended after them up to the per-note
   * ceiling. Whatever does not fit stays on the old path, so the caller can report
   * it and a later rename can still carry it over. Nothing is ever dropped silently:
   * a moving record is discarded only when the destination already holds that exact
   * id (the same annotation reached the destination first), which is reported as
   * `droppedDuplicates`.
   *
   * @param {unknown} oldPath
   * @param {unknown} newPath
   * @returns {{
   *   status: "moved" | "partial" | "none",
   *   ok: boolean,
   *   from: string,
   *   to: string,
   *   moved: number,
   *   droppedDuplicates: number,
   *   retained: { path: string, count: number } | null,
   *   reason: "no-op" | "duplicate-ids" | "per-path" | "storage" | null
   * }}
   */
  renamePath(oldPath, newPath) {
    const oldKey = String(oldPath ?? "");
    const newKey = String(newPath ?? "");
    const empty = (/** @type {any} */ status, reason) => ({
      status,
      ok: false,
      from: oldKey,
      to: newKey,
      moved: 0,
      droppedDuplicates: 0,
      retained: null,
      reason
    });
    const moving = this.data.annotations[oldKey];
    if (!moving || !newKey || oldKey === newKey) return empty("none", "no-op");

    const existing = this.data.annotations[newKey] ?? [];
    const existingIds = new Set(existing.map((annotation) => annotation.id));
    // A moving record whose id the destination already holds is that same annotation
    // arriving twice, which is the only case where dropping a record loses nothing.
    const candidates = moving.filter((annotation) => !existingIds.has(annotation.id));
    const droppedDuplicates = moving.length - candidates.length;
    // Records past the note's own ceiling cannot follow, and the survivors of the
    // storage check are decided below because that budget is measured in bytes. What
    // stays behind is exactly the untouched suffix of `candidates`, so a later rename
    // can still carry it over.
    const roomLeft = Math.max(0, ANNOTATION_LIMITS.perPath - existing.length);

    /**
     * The persisted map for a given number of moved records, or undefined when that
     * much would exceed the serialized storage budget. Deliberately capacity-only:
     * `normalizeAnnotationData()` drops records past `perPath` and past the storage
     * budget on load, so a move that persisted more than fits would lose them on the
     * next read instead of keeping them at the old path.
     */
    const attempt = (count) => {
      const staying = candidates.slice(count);
      // Rebuilt rather than copied-and-deleted: the old key must disappear when
      // nothing stays behind, independent of how the persisted map object behaves
      // when a key is deleted from a copy of it.
      const next = {};
      for (const [key, items] of Object.entries(this.data.annotations)) {
        if (key !== oldKey && key !== newKey) next[key] = items;
      }
      if (staying.length > 0) next[oldKey] = staying;
      if (existing.length > 0 || count > 0)
        next[newKey] = [
          ...existing,
          ...candidates.slice(0, count).map((annotation) => ({ ...annotation, path: newKey }))
        ];
      try {
        this.assertStorageBudget(next);
      } catch {
        return undefined;
      }
      return next;
    };
    // Storage is bounded in bytes rather than in records, so the move starts from the
    // largest set the note's ceiling allows and steps back down until it fits.
    let movedCount = Math.min(candidates.length, roomLeft);
    let next;
    while (movedCount > 0) {
      next = attempt(movedCount);
      if (next) break;
      movedCount -= 1;
    }
    if (!next) next = attempt(0);
    // Not even the destination's own records fit the budget: leave both paths as they are.
    if (!next) return empty("none", "storage");

    const original = this.data.annotations;
    try {
      this.data.annotations = next;
      this.changed();
    } catch (error) {
      this.data.annotations = original;
      throw error;
    }

    const keptBack = candidates.length - movedCount;
    // A record that had to stay on the old path is a retention the caller has to know
    // about, even when the move also dropped a duplicate: reporting "moved" there told
    // the plugin everything followed, and the records left on a path with no note went
    // unmentioned until the next load.
    const status = keptBack === 0 ? "moved" : movedCount === 0 ? "none" : "partial";
    /** @type {Array<"storage" | "per-path" | "duplicate-ids">} */
    const reasons = [];
    if (movedCount < Math.min(candidates.length, roomLeft)) reasons.push("storage");
    if (candidates.length > roomLeft) reasons.push("per-path");
    if (droppedDuplicates > 0) reasons.push("duplicate-ids");
    return {
      status,
      ok: status !== "none",
      from: oldKey,
      to: newKey,
      moved: movedCount,
      droppedDuplicates,
      retained: keptBack > 0 ? { path: oldKey, count: keptBack } : null,
      // The blocker the caller should act on: storage first, then the note's own
      // ceiling, then duplicate ids (which lose nothing the destination does not hold).
      reason: status === "moved" ? null : (reasons[0] ?? null)
    };
  }

  /**
   * Paths whose annotations are persisted but that no longer have a note in the
   * vault: the records a refused or partial rename left behind. Read-only, and the
   * caller decides what to show, because a path can also be missing only while the
   * vault is still indexing.
   *
   * @param {Set<string> | Map<string, unknown> | ((path: string) => boolean)} vaultHasPath
   * @returns {string[]}
   */
  orphanedAnnotationPaths(vaultHasPath) {
    const has = (path) =>
      typeof vaultHasPath === "function"
        ? Boolean(vaultHasPath(path))
        : Boolean(vaultHasPath?.has(path));
    return Object.keys(this.data.annotations)
      .filter((path) => this.data.annotations[path].length > 0 && !has(path))
      .sort();
  }

  deletePath(path) {
    const key = String(path ?? "");
    if (!this.data.annotations[key]) return false;
    delete this.data.annotations[key];
    this.changed();
    return true;
  }

  /**
   * Remove exactly the named records from one path, so a consumer that could only take
   * part of them leaves the rest in place. `deletePath()` used to be the only way to
   * clear a consumed batch, which silently destroyed the records a prompt or a queue
   * entry had no room for.
   *
   * @param {unknown} path
   * @param {Iterable<string>} ids
   * @returns {number} How many records were removed.
   */
  removeByIds(path, ids) {
    const key = String(path ?? "");
    const items = this.data.annotations[key];
    if (!items) return 0;
    const removing = new Set(ids);
    if (removing.size === 0) return 0;
    const remaining = items.filter((annotation) => !removing.has(annotation.id));
    const removed = items.length - remaining.length;
    if (removed === 0) return 0;
    if (remaining.length > 0) this.data.annotations[key] = remaining;
    else delete this.data.annotations[key];
    this.changed();
    return removed;
  }

  reanchorPath(path, text) {
    const key = String(path ?? "");
    const items = this.data.annotations[key];
    if (!items) return [];

    let didChange = false;
    const now = new Date().toISOString();
    const reconciled = items.map((annotation) => {
      const result = reanchorAnnotation(annotation, text);
      const anchorChanged =
        result.status !== annotation.status ||
        result.range.from !== annotation.range.from ||
        result.range.to !== annotation.range.to ||
        result.range.start.line !== annotation.range.start.line ||
        result.range.start.ch !== annotation.range.start.ch ||
        result.range.end.line !== annotation.range.end.line ||
        result.range.end.ch !== annotation.range.end.ch;
      if (!anchorChanged) return annotation;
      didChange = true;
      return { ...result, updatedAt: now };
    });
    if (didChange) {
      this.data.annotations[key] = reconciled;
      this.changed();
    }
    return this.list(key);
  }

  replacePath(path, annotations) {
    const key = String(path ?? "");
    const incoming = Array.isArray(annotations) ? annotations.length : 0;
    // `normalizeAnnotationData()` keeps the first `perPath` records of a path and drops
    // the rest, so a write that is over that ceiling would silently lose records the
    // caller believes it restored. The total ceiling already throws here; this one has
    // to as well.
    if (incoming > ANNOTATION_LIMITS.perPath)
      throw new Error(`A note can have at most ${ANNOTATION_LIMITS.perPath} annotations.`);
    const normalized =
      normalizeAnnotationData({ annotations: { [key]: annotations } }).annotations[key] ?? [];
    // The same rule the loader applies to the whole document: a path the store does not
    // already carry cannot be added once `paths` is reached, or the next load drops the
    // last one - which is the record this call just wrote.
    if (
      !this.data.annotations[key] &&
      Object.keys(this.data.annotations).length >= ANNOTATION_LIMITS.paths
    )
      throw new Error(`Annotations can cover at most ${ANNOTATION_LIMITS.paths} notes.`);
    const next = { ...this.data.annotations };
    if (normalized.length > 0) next[key] = normalized;
    else delete next[key];
    const total = Object.values(next).reduce((sum, items) => sum + items.length, 0);
    if (total > ANNOTATION_LIMITS.total)
      throw new Error(`At most ${ANNOTATION_LIMITS.total} annotations can be stored.`);
    this.assertStorageBudget(next);
    this.data.annotations = next;
    this.changed();
    return this.list(key);
  }

  count() {
    return Object.values(this.data.annotations).reduce((total, items) => total + items.length, 0);
  }

  assertStorageBudget(annotations) {
    if (
      annotationDataBytes({ schemaVersion: this.data.schemaVersion, annotations }) >
      ANNOTATION_LIMITS.storageBytes
    )
      throw new Error("Annotation storage limit reached.");
  }

  changed() {
    this.onChange(this.toJSON());
  }
}
