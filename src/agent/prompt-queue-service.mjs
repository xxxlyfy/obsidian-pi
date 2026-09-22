import {
  enqueueLocalPrompt,
  invalidateLocalPromptPaths,
  migrateLocalPromptPaths,
  normalizeLocalPromptQueue,
  removeLocalPrompt,
  updateLocalPrompt
} from "../shared/local-prompt-queue.mjs";

/**
 * Owns the pending prompt queue and the in-flight steering list.
 *
 * Persistence is injected, so queued prompts are saved with the rest of the
 * plugin data without this service knowing anything about storage.
 */
export class PromptQueueService {
  /**
   * @param {object} options
   * @param {any[]} [options.items]
   * @param {any[]} [options.steering]
   * @param {boolean} [options.paused]
   * @param {() => void} [options.persist]
   */
  constructor({ items, steering, paused, persist } = {}) {
    this.items = normalizeLocalPromptQueue(items ?? [], { preserveState: true });
    this.steering = Array.isArray(steering) ? steering.map(cloneItem) : [];
    this.paused = paused === true;
    this.persist = persist ?? (() => {});
  }

  /** Deep copies so callers can render or mutate without touching the queue. */
  getItems() {
    return this.items.map(cloneItem);
  }

  isPaused() {
    return this.paused;
  }

  resume() {
    this.paused = false;
  }

  /** @param {any} item */
  beginSteering(item) {
    if (!this.steering.some((candidate) => candidate.id === item.id)) {
      this.steering.push(cloneItem(item));
    }
    this.persist();
  }

  /** @param {string} id */
  finishSteering(id) {
    this.steering = this.steering.filter((item) => item.id !== id);
    this.persist();
  }

  /** @param {any[]} items */
  replace(items) {
    this.items = normalizeLocalPromptQueue(items, { preserveState: true });
    this.persist();
  }

  /**
   * @param {string} oldPath
   * @param {string} newPath
   */
  migratePaths(oldPath, newPath) {
    this.items = migrateLocalPromptPaths(this.items, oldPath, newPath);
    this.steering = migrateLocalPromptPaths(this.steering, oldPath, newPath);
    this.persist();
  }

  /** @param {string} path */
  invalidatePaths(path) {
    this.items = invalidateLocalPromptPaths(this.items, path);
    this.steering = invalidateLocalPromptPaths(this.steering, path);
    this.persist();
  }

  /** @param {any} item */
  enqueue(item) {
    this.items = enqueueLocalPrompt(this.items, item);
    this.persist();
    return this.items.at(-1);
  }

  /**
   * @param {string} id
   * @param {any} patch
   */
  update(id, patch) {
    this.items = updateLocalPrompt(this.items, id, patch);
    this.persist();
  }

  /** @param {string} id */
  remove(id) {
    this.items = removeLocalPrompt(this.items, id);
    this.persist();
  }

  /** Snapshot for plugin data persistence. */
  toJSON() {
    return {
      localPromptQueue: this.items.map(cloneItem),
      localPromptSteering: this.steering.map(cloneItem)
    };
  }
}

function cloneItem(item) {
  return {
    ...item,
    images: (item.images ?? []).map((image) => ({ ...image })),
    attachments: (item.attachments ?? []).map((attachment) => ({ ...attachment })),
    annotations: (item.annotations ?? []).map((annotation) => ({ ...annotation }))
  };
}
