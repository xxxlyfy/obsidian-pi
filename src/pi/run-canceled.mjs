/**
 * Cancellation is detected from the error identity, never from its message, so
 * the text can change or be translated without breaking the cancel path.
 */
const RUN_CANCELED_NAME = "PiRunCanceledError";

export class PiRunCanceledError extends Error {
  /** @param {unknown} [cause] */
  constructor(cause = undefined) {
    super("Pi run canceled.", cause === undefined ? undefined : { cause });
    this.name = RUN_CANCELED_NAME;
  }
}

/**
 * Walks the error cause chain so a cancel error stays recognizable after it was
 * re-wrapped on its way out of the runner.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isPiRunCanceled(error) {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 10; depth++) {
    if (current instanceof PiRunCanceledError || current.name === RUN_CANCELED_NAME) return true;
    current = current.cause;
  }
  return false;
}
