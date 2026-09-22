import { TFile } from "obsidian";

/**
 * The only module that knows how to talk to Obsidian's vault and metadata
 * cache. Everything above it works with plain paths and note descriptors.
 *
 * @typedef {object} NoteDescriptor
 * @property {string} path
 * @property {string} title
 * @property {number} mtime
 *
 * @typedef {object} NoteMetadata
 * @property {string[]} tags
 * @property {string[]} aliases
 * @property {string[]} headings
 * @property {Record<string, any>} frontmatter
 */
export class VaultAdapter {
  /** @param {any} app Obsidian app. */
  constructor(app) {
    this.app = app;
  }

  getBasePath() {
    return /** @type {any} */ (this.app.vault.adapter)?.getBasePath?.();
  }

  getConfigDir() {
    return this.app.vault.configDir;
  }

  /** @returns {NoteDescriptor[]} */
  listNotes() {
    return this.app.vault.getMarkdownFiles().map((file) => this.describe(file));
  }

  /** @param {string} path */
  note(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? this.describe(file) : undefined;
  }

  /**
   * @param {string} path
   * @param {number} [maxChars]
   */
  async read(path, maxChars = Number.POSITIVE_INFINITY) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
    const content = await this.app.vault.cachedRead(file);
    return content.length > maxChars ? `${content.slice(0, maxChars)}\n...[truncated]` : content;
  }

  /** Uncached read, used when the caller must see the latest bytes on disk. */
  async readFresh(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
    return this.app.vault.read(file);
  }

  /**
   * @param {string} path
   * @returns {NoteMetadata}
   */
  getMetadata(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    const cache = file instanceof TFile ? this.app.metadataCache.getFileCache(file) : undefined;
    const tags = new Set();
    for (const tag of cache?.tags ?? []) if (tag?.tag) tags.add(String(tag.tag));
    const frontmatterTags = cache?.frontmatter?.tags;
    if (Array.isArray(frontmatterTags)) for (const tag of frontmatterTags) tags.add(String(tag));
    else if (typeof frontmatterTags === "string") tags.add(frontmatterTags);
    const aliases = cache?.frontmatter?.aliases;

    return {
      tags: [...tags],
      aliases: Array.isArray(aliases)
        ? aliases.map(String)
        : typeof aliases === "string"
          ? [aliases]
          : [],
      headings: (cache?.headings ?? [])
        .map((heading) => heading?.heading)
        .filter(Boolean)
        .slice(0, 20)
        .map(String),
      frontmatter: cache?.frontmatter ?? {}
    };
  }

  /** @returns {Record<string, Record<string, number>>} */
  resolvedLinks() {
    return this.app.metadataCache.resolvedLinks ?? {};
  }

  /** @returns {Record<string, Record<string, number>>} */
  unresolvedLinks() {
    return this.app.metadataCache.unresolvedLinks ?? {};
  }

  /**
   * @param {string} linkpath
   * @param {string} [sourcePath]
   * @returns {string | undefined}
   */
  resolveLinkPath(linkpath, sourcePath = "") {
    const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
    return file instanceof TFile ? file.path : undefined;
  }

  /** @returns {any} Obsidian EventRef, for `registerEvent`. */
  on(eventName, callback) {
    return this.app.vault.on(eventName, callback);
  }

  /** @returns {any} Obsidian EventRef, for `registerEvent`. */
  onMetadataChanged(callback) {
    return this.app.metadataCache.on("changed", callback);
  }

  /** @returns {any} Obsidian EventRef, for `registerEvent`. */
  onMetadataResolved(callback) {
    return this.app.metadataCache.on("resolved", callback);
  }

  /** @param {any} file */
  describe(file) {
    return {
      path: String(file.path),
      title: String(file.basename ?? file.name ?? ""),
      mtime: Number(file.stat?.mtime ?? 0)
    };
  }
}
