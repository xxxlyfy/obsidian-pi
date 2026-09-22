/**
 * Enumerates and reveals the plugin's views without the rest of the plugin
 * reaching into view internals. Views expose small named hooks; everything a
 * caller needs from a view goes through one of them.
 */
export class ViewRegistry {
  /**
   * @param {object} options
   * @param {any} options.app
   * @param {string} options.viewType
   * @param {() => string | undefined} [options.getTitle] Reserved for future view creation hooks.
   * @param {(message: string) => void} [options.notify]
   */
  constructor({ app, viewType, notify = () => {} }) {
    this.app = app;
    this.viewType = viewType;
    this.notify = notify;
  }

  /** @returns {any[]} Open views of this plugin. */
  list() {
    const views = [];
    for (const leaf of this.app.workspace.getLeavesOfType(this.viewType)) {
      if (leaf?.view) views.push(leaf.view);
    }
    return views;
  }

  /** @returns {any} First open view, if any. */
  first() {
    return this.list()[0];
  }

  /** @param {(view: any) => void} callback */
  forEach(callback) {
    for (const view of this.list()) callback(view);
  }

  /**
   * Calls a named hook on every open view. Hooks are optional so a partially
   * initialized view is skipped instead of crashing the caller.
   *
   * @param {string} hook
   * @param {...any} args
   */
  call(hook, ...args) {
    for (const view of this.list()) {
      const method = view?.[hook];
      if (typeof method === "function") method.apply(view, args);
    }
  }

  /** Opens or reveals the plugin view. */
  async activate() {
    let leaf = this.app.workspace.getLeavesOfType(this.viewType)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        this.notify("could not open view");
        return undefined;
      }
      await leaf.setViewState({ type: this.viewType, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }
}
