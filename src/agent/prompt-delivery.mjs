import { STRINGS } from "../shared/strings.mjs";
import { appendTextAttachmentContext, modelSupportsImages } from "../shared/prompt-payload.mjs";

/**
 * A pending user request before the context is attached.
 *
 * @typedef {{
 *   prompt: string,
 *   threadId: string,
 *   images?: any[],
 *   attachments?: any[],
 *   annotations?: any[],
 *   annotationSourcePath?: string,
 *   includeActiveNote?: boolean,
 *   queuedId?: string
 * }} PromptDeliveryRequest
 */

/**
 * Turns a user request into the payload a run needs: annotations are consumed
 * once, context is built, and the queue/running-thread rules decide whether the
 * prompt runs now or waits.
 *
 * Everything user-visible goes through injected ports, so this module owns the
 * decisions and the view owns rendering, notices, and queue presentation.
 */
export class PromptDelivery {
  /**
   * @param {object} options
   * @param {(sourcePath: string | undefined) => Promise<any[]>} options.consumeAnnotations
   * @param {(annotations: any[]) => void} options.restoreAnnotations
   * @param {(delivery: any, context: any) => Promise<any>} options.buildDelivery
   * @param {(threadId: string) => boolean} options.isThreadRunning
   * @param {(item: any) => void} options.enqueueQueuedPrompt
   * @param {(queuedId: string) => void} options.requeueQueuedPrompt
   * @param {() => Promise<void>} options.ensureModelsLoaded
   * @param {() => any} options.getSelectedModelInfo
   * @param {() => boolean} options.shouldIncludeActiveNote
   * @param {(message: string) => void} options.notify
   */
  constructor({
    consumeAnnotations,
    restoreAnnotations,
    buildDelivery,
    isThreadRunning,
    enqueueQueuedPrompt,
    requeueQueuedPrompt,
    ensureModelsLoaded,
    getSelectedModelInfo,
    shouldIncludeActiveNote,
    notify
  }) {
    this.consumeAnnotations = consumeAnnotations;
    this.restoreAnnotations = restoreAnnotations;
    this.buildDelivery = buildDelivery;
    this.isThreadRunning = isThreadRunning;
    this.enqueueQueuedPrompt = enqueueQueuedPrompt;
    this.requeueQueuedPrompt = requeueQueuedPrompt;
    this.ensureModelsLoaded = ensureModelsLoaded;
    this.getSelectedModelInfo = getSelectedModelInfo;
    this.shouldIncludeActiveNote = shouldIncludeActiveNote;
    this.notify = notify;
    /** @type {Set<any>} */
    this.pendingSnapshots = new Set();
  }

  /**
   * @param {any} snapshot
   * @returns {() => void} release
   */
  trackPendingSnapshot(snapshot) {
    this.pendingSnapshots.add(snapshot);
    return () => this.pendingSnapshots.delete(snapshot);
  }

  /**
   * Snapshots of prompts that are still being prepared are not attached to a
   * run yet, but a rename or delete during delivery still has to reach them.
   *
   * @param {(snapshot: any) => void} callback
   */
  forEachSnapshot(callback) {
    for (const snapshot of this.pendingSnapshots) callback(snapshot);
  }

  /**
   * @param {string} oldPath
   * @param {string} newPath
   */
  migrateSnapshotPaths(oldPath, newPath) {
    if (!oldPath || !newPath || oldPath === newPath) return;
    this.forEachSnapshot((snapshot) => {
      if (snapshot.sourcePath === oldPath) snapshot.sourcePath = newPath;
      snapshot.annotations = snapshot.annotations.map((annotation) =>
        annotation?.path === oldPath ? { ...annotation, path: newPath } : annotation
      );
    });
  }

  /** @param {string} path */
  invalidateSnapshotPaths(path) {
    if (!path) return;
    this.forEachSnapshot((snapshot) => {
      if (snapshot.sourcePath === path) snapshot.sourcePath = undefined;
      snapshot.annotations = snapshot.annotations.filter((annotation) => annotation?.path !== path);
    });
  }

  /**
   * A rename or delete can migrate the annotation snapshot while the context is
   * still being built. Rebuild the delivery once so the prompt keeps its note.
   *
   * @param {() => Promise<any>} buildDelivery
   * @param {any} annotationSnapshot
   */
  async buildWithSnapshotRetry(buildDelivery, annotationSnapshot) {
    const releasePendingSnapshot = this.trackPendingSnapshot(annotationSnapshot);
    try {
      const deliverySourcePath = annotationSnapshot.sourcePath;
      const delivery = await buildDelivery();
      if (
        annotationSnapshot.sourcePath !== deliverySourcePath &&
        !delivery.promptContext?.activeNote
      )
        return buildDelivery();
      return delivery;
    } finally {
      releasePendingSnapshot();
    }
  }

  /**
   * @param {PromptDeliveryRequest} request
   * @returns {Promise<{ ok: true, prepared: any } | { ok: false }>}
   */
  async prepare(request) {
    let prompt = request.prompt;
    let images = request.images || [];
    let attachments = request.attachments || [];
    const threadId = request.threadId;
    const queuedId = request.queuedId;
    const annotationSourcePath = request.annotationSourcePath;
    let annotations = request.annotations;
    let includeActiveNote = request.includeActiveNote;
    if (includeActiveNote === undefined) includeActiveNote = this.shouldIncludeActiveNote();
    if (annotations === undefined) {
      try {
        annotations = await this.consumeAnnotations(annotationSourcePath);
      } catch (error) {
        this.notify(error instanceof Error ? error.message : String(error));
        return { ok: false };
      }
    }

    const annotationSnapshot = { annotations, sourcePath: annotationSourcePath };
    const restoreUnsentAnnotations = () => {
      const unsent = annotationSnapshot.annotations;
      if (!queuedId && unsent.length > 0) this.restoreAnnotations(unsent);
    };
    /** @returns {{ ok: false }} */
    const settleWithoutRunning = (notice) => {
      if (queuedId) this.requeueQueuedPrompt(queuedId);
      else restoreUnsentAnnotations();
      if (notice) this.notify(notice);
      return { ok: false };
    };
    const enqueueWhileRunning = () =>
      this.enqueueQueuedPrompt({
        prompt,
        threadId,
        images,
        attachments,
        annotations: annotationSnapshot.annotations,
        annotationSourcePath: annotationSnapshot.sourcePath,
        includeActiveNote
      });

    if (this.isThreadRunning(threadId)) {
      if (queuedId) this.requeueQueuedPrompt(queuedId);
      else enqueueWhileRunning();
      return { ok: false };
    }

    let delivery;
    try {
      delivery = await this.buildWithSnapshotRetry(
        () =>
          this.buildDelivery(
            {
              prompt,
              images,
              attachments,
              annotations: annotationSnapshot.annotations,
              contextFilePath: annotationSnapshot.sourcePath,
              includeActiveNote
            },
            { mode: "prompt", threadId }
          ),
        annotationSnapshot
      );
    } catch (error) {
      return settleWithoutRunning(error instanceof Error ? error.message : String(error));
    }

    prompt = String(delivery.prompt || "").trim();
    images = delivery.images || [];
    attachments = delivery.attachments || [];
    if (delivery.promptContext && attachments.length > 0)
      delivery.promptContext.fileAttachmentsContext = appendTextAttachmentContext("", attachments);
    if (!prompt && images.length === 0 && attachments.length === 0)
      return settleWithoutRunning(queuedId ? STRINGS.view.queuedEmpty : undefined);

    if (images.length > 0) await this.ensureModelsLoaded();
    if (images.length > 0 && !modelSupportsImages(this.getSelectedModelInfo()))
      return settleWithoutRunning(STRINGS.view.modelNoImage);

    if (this.isThreadRunning(threadId)) {
      if (queuedId) this.requeueQueuedPrompt(queuedId);
      else enqueueWhileRunning();
      return { ok: false };
    }

    return {
      ok: true,
      prepared: {
        prompt,
        threadId,
        images,
        attachments,
        queuedId,
        annotationSnapshot,
        restoreUnsentAnnotations,
        delivery
      }
    };
  }
}
