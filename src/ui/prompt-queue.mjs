import * as f from "obsidian";
import { STRINGS } from "../shared/strings.mjs";
import {
  claimLocalPrompt,
  nextDeliverablePrompt,
  removeLocalPrompt,
  restoreLocalPrompt,
  takeLocalPrompt
} from "../shared/local-prompt-queue.mjs";
import {
  appendTextAttachmentContext,
  imagePreviewUrl,
  modelSupportsImages
} from "../shared/prompt-payload.mjs";

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function enqueuePrompt(
  prompt,
  threadId,
  images = [],
  attachments = [],
  annotations = [],
  contextFilePath,
  includeActiveNote
) {
  const targetThreadId = threadId ?? this.plugin.threads.currentThreadId;
  const item = this.plugin.promptQueue.enqueue({
    prompt,
    images,
    attachments,
    annotations,
    contextFilePath,
    includeActiveNote,
    threadId: targetThreadId
  });
  if (!item) return;
  this.promptQueue = this.plugin.promptQueue.getItems();
  this.renderPromptQueue();
  this.syncCurrentRunFlags();
  this.setRunningState(this.running);
  new f.Notice(STRINGS.queue.queuedNotice(this.promptQueue.length));
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function runNextQueuedPrompt() {
  if (this.canceling || this.plugin.promptQueue.isPaused() || this.steeringPromptIds.size > 0)
    return;
  const item = nextDeliverablePrompt(this.promptQueue, (threadId) =>
    this.isThreadRunning(threadId)
  );
  if (!item) return;
  const claimed = claimLocalPrompt(this.promptQueue, item.id, "delivering");
  this.promptQueue = claimed.queue;
  this.plugin.promptQueue.replace(this.promptQueue);
  this.renderPromptQueue();
  this.startPrompt(
    item.prompt,
    item.threadId,
    item.images,
    item.id,
    item.attachments,
    item.annotations,
    item.contextFilePath,
    item.includeActiveNote !== false
  );
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function removeQueuedPrompt(id) {
  const item = this.promptQueue.find((candidate) => candidate.id === id);
  if (!item || item.state !== "pending") return;
  this.plugin.restoreConsumedAnnotations(item.annotations);
  this.promptQueue = removeLocalPrompt(this.promptQueue, id);
  this.plugin.promptQueue.replace(this.promptQueue);
  this.renderPromptQueue();
  this.setRunningState(this.running);
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function retrieveQueuedPrompt(id) {
  const item = this.promptQueue.find((candidate) => candidate.id === id);
  if (!item || item.state !== "pending" || !this.isCurrentThread(item.threadId)) return;
  if (this.inputEl) this.inputEl.value = item.prompt;
  this.composerImages = item.images.map((image) => ({ ...image }));
  this.composerAttachments = item.attachments.map((attachment) => ({ ...attachment }));
  this.excludedContextPath = item.includeActiveNote === false ? item.contextFilePath : undefined;
  this.removeQueuedPrompt(id);
  this.renderComposerImages();
  this.resizeInput();
  this.inputEl?.focus();
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export async function steerQueuedPrompt(id) {
  const taken = takeLocalPrompt(this.promptQueue, id);
  if (!taken.item) return;
  this.promptQueue = taken.queue;
  this.steeringPromptIds.add(id);
  this.plugin.promptQueue.beginSteering(taken.item);
  this.plugin.promptQueue.replace(this.promptQueue);
  this.renderPromptQueue();
  try {
    const run = this.runtime.getRun(taken.item.threadId);
    if (!run) throw new Error(STRINGS.queue.settledNotice);
    const delivery = await this.plugin.enrichPromptDelivery(taken.item, {
      mode: "steer",
      threadId: taken.item.threadId
    });
    if (delivery.images?.length > 0) await this.plugin.models.ensureLoaded();
    if (delivery.images?.length > 0 && !modelSupportsImages(this.plugin.models.getSelectedInfo()))
      throw new Error(STRINGS.view.modelNoImage);
    const formattedPrompt = delivery.promptContext
      ? (this.plugin.contextBuilder?.formatPrompt(delivery.prompt, delivery.promptContext) ??
        delivery.prompt)
      : delivery.prompt;
    const steerPrompt = appendTextAttachmentContext(formattedPrompt, delivery.attachments);
    await run.runner.steer(steerPrompt, delivery.images);
    if (this.runtime.getRun(taken.item.threadId) === run)
      this.plugin.beginAnnotationProcessing(taken.item.threadId, taken.item.annotations);
    new f.Notice(STRINGS.queue.steeringSent);
  } catch (error) {
    this.promptQueue = restoreLocalPrompt(this.promptQueue, taken.item, taken.index);
    this.plugin.promptQueue.replace(this.promptQueue);
    new f.Notice(error instanceof Error ? error.message : String(error));
  } finally {
    this.steeringPromptIds.delete(id);
    this.plugin.promptQueue.finishSteering(id);
  }
  this.renderPromptQueue();
  this.runNextQueuedPrompt();
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function renderPromptQueue() {
  if (!this.promptQueueEl) return;
  const root = this.promptQueueEl;
  root.empty();
  root.toggleClass("is-empty", this.promptQueue.length === 0 && !this.nativePiQueue);
  if (this.promptQueue.length > 0) {
    const heading = root.createDiv({ cls: "pi-agent-prompt-queue-heading" });
    heading.createSpan({
      text: STRINGS.queue.followUpCount(this.promptQueue.length)
    });
    heading.createSpan({
      cls: "pi-agent-prompt-queue-hint",
      text: this.plugin.promptQueue.isPaused()
        ? STRINGS.queue.savedFromPreviousSession
        : STRINGS.queue.runsAfterSettlement
    });
    if (this.plugin.promptQueue.isPaused()) {
      const controls = root.createDiv({ cls: "pi-agent-prompt-queue-actions" });
      addTextAction(controls, STRINGS.queue.resumeSaved, STRINGS.queue.resume, () => {
        this.plugin.promptQueue.resume();
        this.renderPromptQueue();
        this.runNextQueuedPrompt();
      });
      addTextAction(controls, STRINGS.queue.discardSaved, STRINGS.queue.discard, () => {
        for (const item of this.promptQueue)
          this.plugin.restoreConsumedAnnotations(item.annotations);
        this.promptQueue = [];
        this.plugin.promptQueue.resume();
        this.plugin.promptQueue.replace([]);
        this.renderPromptQueue();
        this.setRunningState(this.running);
      });
    }
  }

  for (const item of this.promptQueue) {
    const row = root.createDiv({ cls: "pi-agent-prompt-queue-item" });
    row.setAttr("aria-label", STRINGS.queue.queuedFollowUp(item.prompt || attachmentSummary(item)));
    const content = row.createDiv({ cls: "pi-agent-prompt-queue-content" });
    content.createDiv({
      cls: "pi-agent-prompt-queue-text",
      text: item.prompt || attachmentSummary(item)
    });
    renderQueueAttachments(content, item.images, item.attachments);
    const actions = row.createDiv({ cls: "pi-agent-prompt-queue-actions" });
    addAction(
      actions,
      "corner-up-right",
      STRINGS.queue.steerNow,
      () => this.steerQueuedPrompt(item.id),
      item.state !== "pending"
    );
    if (this.isCurrentThread(item.threadId))
      addAction(
        actions,
        "pencil",
        STRINGS.queue.editQueued,
        () => this.retrieveQueuedPrompt(item.id),
        item.state !== "pending"
      );
    addAction(
      actions,
      "x",
      STRINGS.queue.removeQueued,
      () => this.removeQueuedPrompt(item.id),
      item.state !== "pending"
    );
  }

  if (this.nativePiQueue?.steering?.length || this.nativePiQueue?.followUp?.length) {
    const native = root.createDiv({ cls: "pi-agent-native-queue", attr: { role: "status" } });
    native.createDiv({ cls: "pi-agent-prompt-queue-heading", text: STRINGS.queue.handedToPi });
    const handedToPi = [
      ...(this.nativePiQueue.steering || []),
      ...(this.nativePiQueue.followUp || [])
    ];
    for (const text of handedToPi)
      native.createDiv({ cls: "pi-agent-prompt-queue-text", text: String(text) });
  }
}

function addTextAction(parent, label, text, callback) {
  const button = parent.createEl("button", {
    cls: "pi-agent-prompt-queue-action is-text",
    text,
    attr: { "aria-label": label, title: label }
  });
  button.addEventListener("click", callback);
}

function addAction(parent, icon, label, callback, disabled) {
  const button = parent.createEl("button", {
    cls: "clickable-icon pi-agent-prompt-queue-action",
    attr: { "aria-label": label, title: label }
  });
  f.setIcon(button, icon);
  button.toggleAttribute("disabled", disabled);
  button.addEventListener("click", callback);
}

function renderQueueAttachments(parent, images = [], attachments = []) {
  if (!images.length && !attachments.length) return;
  const previews = parent.createDiv({ cls: "pi-agent-queue-image-previews" });
  for (const image of images) {
    const item = previews.createDiv({ cls: "pi-agent-queue-attachment" });
    item.createEl("img", {
      cls: "pi-agent-queue-image-preview",
      attr: { src: imagePreviewUrl(image), alt: image.fileName || STRINGS.queue.queuedImage }
    });
    item.createSpan({
      text: STRINGS.queue.imageSummary(
        image.fileName || STRINGS.queue.queuedImage,
        formatBytes(image.size)
      )
    });
  }
  for (const attachment of attachments) {
    const item = previews.createDiv({ cls: "pi-agent-queue-attachment" });
    const icon = item.createSpan({ cls: "pi-agent-attachment-icon" });
    f.setIcon(icon, "file-text");
    item.createSpan({
      text: STRINGS.queue.attachmentSummary(
        attachment.fileName,
        attachment.mimeType,
        formatBytes(attachment.originalSize),
        attachment.truncated
      )
    });
  }
}

function attachmentSummary(item) {
  const count = (item.images?.length || 0) + (item.attachments?.length || 0);
  return STRINGS.queue.attachmentCount(count);
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return STRINGS.queue.unknownSize;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}
