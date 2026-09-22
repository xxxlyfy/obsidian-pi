/**
 * Reads note content that must reflect what the user sees, preferring an open
 * editor over the on-disk copy. Annotation reanchoring depends on this.
 */
export class EditorAdapter {
  /** @param {any} app Obsidian app. */
  constructor(app) {
    this.app = app;
  }

  /**
   * Returns the live editor value for a note when that note is open.
   *
   * @param {string} path
   * @returns {string | undefined}
   */
  valueForOpenNote(path) {
    const activeEditor = this.app.workspace.activeEditor;
    if (activeEditor?.file?.path === path) {
      const value = activeEditor.editor?.getValue?.();
      if (typeof value === "string") return value;
    }

    const leaf = this.app.workspace.getLeavesOfType("markdown").find((candidate) => {
      const view = /** @type {any} */ (candidate.view);
      return view?.file?.path === path && typeof view?.editor?.getValue === "function";
    });
    const value = /** @type {any} */ (leaf?.view)?.editor?.getValue?.();
    return typeof value === "string" ? value : undefined;
  }
}
