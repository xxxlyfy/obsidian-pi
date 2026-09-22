/**
 * Read-only workspace facts the agent layer needs: which note is active, what
 * the user selected, and how to open a note. View creation and reveal stay in
 * the plugin's ViewRegistry, which is composition, not business logic.
 */
export class WorkspaceAdapter {
  /** @param {any} app Obsidian app. */
  constructor(app) {
    this.app = app;
  }

  /** @returns {string | undefined} Path of the active markdown note. */
  activeNotePath() {
    const file = this.app.workspace.getActiveFile();
    return file && file.extension === "md" ? String(file.path) : undefined;
  }

  /** @returns {string} Currently selected text in the active editor. */
  activeSelection() {
    return this.app.workspace.activeEditor?.editor?.getSelection() ?? "";
  }

  /** @param {string} path */
  async openNote(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file) await this.app.workspace.getLeaf(false).openFile(file);
  }

  /**
   * @param {string} eventName
   * @param {(...args: any[]) => void} callback
   */
  on(eventName, callback) {
    return this.app.workspace.on(eventName, callback);
  }
}
