import { Notice } from "obsidian";
import { STRINGS } from "../shared/strings.mjs";

export class ThreadActions {
  constructor(plugin, callbacks) {
    this.plugin = plugin;
    this.callbacks = callbacks;
  }

  startNewChat() {
    this.plugin.threads.startNewThread();
    this.callbacks.resetThreadUiState?.();
    this.callbacks.renderThreadTitle();
    this.callbacks.renderMessages();
    this.callbacks.renderToolBadges?.();
  }

  async forkChat() {
    try {
      const fork = await this.plugin.threads.forkCurrentThread();
      if (fork) {
        this.callbacks.resetThreadUiState?.();
        this.callbacks.renderThreadTitle();
        this.callbacks.renderMessages();
        this.callbacks.renderToolBadges?.();
      } else {
        new Notice(STRINGS.threads.nothingToFork);
      }
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }
}
