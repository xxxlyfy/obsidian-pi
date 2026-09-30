/**
 * The prompt-run stages that do not need the view's DOM.
 *
 * `PiAgentView.runPrompt` interleaved three kinds of work: resolving what to
 * send, deciding whether it can be sent now, and the view bookkeeping around a
 * live run. Only the first two move here. The event handlers and the
 * success/failure/settlement paths stay on the view, because they read and
 * write view state and DOM directly and their ordering is load-bearing (they
 * are what the stale-callback guards protect).
 *
 * Every function takes the view it is acting for. They read and write
 * `view.plugin` and `view.state`, exactly as the code they replace did.
 */
import { Notice } from "obsidian";

import { appendTextAttachmentContext, modelSupportsImages } from "../prompt-payload.mjs";

/**
 * Consume the annotations this prompt carries, when the caller has not already
 * resolved them.
 *
 * @param {any} view Chat view.
 * @param {string | undefined} annotationSourcePath Source file for the annotations.
 * @param {any} annotations Pre-resolved annotations, or `undefined` to consume them now.
 * @returns {Promise<{ annotations: any, failed: boolean }>} `failed` means a notice
 * was shown and the prompt must not be sent.
 */
export async function resolvePromptInput(view, annotationSourcePath, annotations) {
  if (annotations !== undefined) return { annotations, failed: false };
  try {
    return {
      annotations: await view.plugin.consumeAnnotationsForPrompt(annotationSourcePath),
      failed: false
    };
  } catch (error) {
    new Notice(error instanceof Error ? error.message : String(error));
    return { annotations: undefined, failed: true };
  }
}

/**
 * Run the pre-delivery enrichment the plugin owns: expand the prompt, resolve
 * attachments, and reject a model that cannot take the images.
 *
 * @param {any} view Chat view.
 * @param {{ prompt: any, images: any[], attachments: any[], annotations: any,
 *   annotationSourcePath: string | undefined, threadId: string }} request
 * @returns {Promise<{ ok: boolean, prompt?: any, images?: any[], attachments?: any[],
 *   promptContext?: any, failure?: string, notice?: boolean }>} On `ok: false`,
 * `failure` is the message; `notice` is false only for the empty-prompt case the
 * original code reported solely to a queued caller, so a typed-but-empty prompt
 * stays as silent as it was.
 */
export async function enrichPromptDelivery(view, request) {
  let delivery;
  try {
    delivery = await view.plugin.enrichPromptDelivery(
      {
        prompt: request.prompt,
        images: request.images,
        attachments: request.attachments,
        annotations: request.annotations,
        contextFilePath: request.annotationSourcePath
      },
      { mode: "prompt", threadId: request.threadId }
    );
  } catch (error) {
    return {
      ok: false,
      notice: true,
      failure: error instanceof Error ? error.message : String(error)
    };
  }
  const prompt = String(delivery.prompt || "").trim();
  const images = delivery.images || [];
  const attachments = delivery.attachments || [];
  if (delivery.promptContext && attachments.length > 0)
    delivery.promptContext.fileAttachmentsContext = appendTextAttachmentContext("", attachments);
  if (!prompt && images.length === 0 && attachments.length === 0)
    return {
      ok: false,
      failure: "The queued message became empty and was not sent.",
      notice: false
    };
  if (images.length > 0) await view.plugin.ensureModelCatalogLoaded();
  if (images.length > 0 && !modelSupportsImages(view.plugin.getSelectedModelInfo()))
    return {
      ok: false,
      notice: true,
      failure: "The selected Pi model does not support image input."
    };
  return { ok: true, prompt, images, attachments, promptContext: delivery.promptContext };
}

/**
 * Return a queued prompt to the pending state so the queue does not lose it.
 *
 * @param {any} view Chat view.
 * @param {string | undefined} queuedId Id of the queued prompt, when this run came from the queue.
 * @returns {void}
 */
export function requeuePendingPrompt(view, queuedId) {
  if (!queuedId) return;
  view.state.promptQueue = view.state.promptQueue.map((item) =>
    item.id === queuedId ? { ...item, state: "pending" } : item
  );
  view.plugin.replaceLocalPromptQueue(view.state.promptQueue);
  view.renderPromptQueue();
}
