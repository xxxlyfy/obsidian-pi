import { readChatHistoryBackup, writeChatHistoryBackup } from "../threads/chat-history-backup.mjs";

const DEFAULT_FLUSH_DELAY_MS = 250;

/**
 * Owns plugin data persistence: writing `data.json`, keeping the checksummed
 * chat-history backup in sync, and coalescing frequent mutations into one write.
 *
 * Writes are serialized (never concurrent) and always use the payload built at
 * write time, so a burst of mutations collapses into the latest snapshot.
 */
export class PluginStore {
  /**
   * @param {object} options
   * @param {() => Promise<any>} options.loadData
   * @param {(data: any) => Promise<void>} options.saveData
   * @param {() => string | undefined} options.getPluginDirectory
   * @param {() => any} options.buildPayload Builds the current snapshot to persist.
   * @param {(error: unknown) => void} [options.onSaveError] For scheduled/flushed writes.
   * @param {number} [options.flushDelayMs]
   */
  constructor({
    loadData,
    saveData,
    getPluginDirectory,
    buildPayload,
    onSaveError = () => {},
    flushDelayMs = DEFAULT_FLUSH_DELAY_MS
  }) {
    this.loadData = loadData;
    this.saveData = saveData;
    this.getPluginDirectory = getPluginDirectory;
    this.buildPayload = buildPayload;
    this.onSaveError = onSaveError;
    this.flushDelayMs = flushDelayMs;
    this.timer = undefined;
    this.dirty = false;
    /** @type {Promise<void> | undefined} */
    this.writing = undefined;
  }

  /** @returns {Promise<any>} Raw plugin data, never undefined. */
  async load() {
    return (await this.loadData()) ?? {};
  }

  /** @returns {Promise<any>} Chat history recovered from the backup files. */
  async readBackupHistory() {
    return readChatHistoryBackup(this.getPluginDirectory());
  }

  get hasPendingWrite() {
    return this.dirty || this.timer !== undefined || this.writing !== undefined;
  }

  /**
   * Debounced write. Repeated calls inside one window result in a single write
   * with the latest snapshot.
   */
  schedule() {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.saveNow().catch((error) => this.onSaveError(error));
    }, this.flushDelayMs);
  }

  /**
   * Immediate serialized write. Rejects when the write fails so callers can
   * report the failure themselves (settings save, annotation save).
   *
   * @returns {Promise<void>}
   */
  saveNow() {
    this.clearTimer();
    this.dirty = true;
    if (!this.writing) this.writing = this.drain();
    return this.writing;
  }

  /**
   * Writes anything that is still pending, including a scheduled write and a
   * mutation that landed while a write was in flight.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    const hadScheduledWrite = this.timer !== undefined;
    this.clearTimer();
    if (this.writing) await this.writing.catch((error) => this.onSaveError(error));
    if (this.dirty || hadScheduledWrite)
      await this.saveNow().catch((error) => this.onSaveError(error));
  }

  async drain() {
    try {
      while (this.dirty) {
        this.dirty = false;
        const payload = this.buildPayload();
        await this.saveData(payload);
        await writeChatHistoryBackup(this.getPluginDirectory(), payload.chatHistory);
      }
    } finally {
      this.writing = undefined;
    }
  }

  clearTimer() {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose() {
    this.clearTimer();
  }
}
