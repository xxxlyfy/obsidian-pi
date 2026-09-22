import {
  createExcerpt,
  rankSearchResults,
  scoreSearchResult,
  tokenizeQuery
} from "../shared/text.mjs";
import { SEARCH_CANDIDATE_LIMIT, VaultIndex } from "./vault-index.mjs";

// Internal context budgets keep pre-attached prompts bounded without exposing
// low-level numeric controls in the settings UI.
export const CONTEXT_RESULT_LIMIT = 8;
export const NOTE_CONTEXT_CHAR_LIMIT = 12_000;

/**
 * Turns vault content into prompt context. It speaks in paths and descriptors
 * only: all Obsidian access goes through the vault/workspace adapters, so this
 * module has no Obsidian dependency and can be tested with a fake vault.
 */
export class VaultGraph {
  /**
   * @param {object} options
   * @param {import("../obsidian/vault-adapter.mjs").VaultAdapter} options.vault
   * @param {import("../obsidian/workspace-adapter.mjs").WorkspaceAdapter} options.workspace
   * @param {any} options.settings
   * @param {() => string | undefined} [options.getActiveNotePath]
   * @param {VaultIndex} [options.index] Shared index. Created lazily when omitted.
   */
  constructor({ vault, workspace, settings, getActiveNotePath, index }) {
    this.vault = vault;
    this.workspace = workspace;
    this.settings = settings;
    this.getActiveNotePath = getActiveNotePath;
    this.index = index;
  }

  getIndex() {
    if (!this.index) this.index = new VaultIndex({ vault: this.vault }).ensureBuilt();
    return this.index;
  }

  /** @returns {Array<{ path: string, title: string, mtime: number }>} */
  getNotes() {
    return this.vault.listNotes().filter((note) => this.isPathAllowed(note.path));
  }

  async searchNotes(query, options = {}) {
    const terms = tokenizeQuery(query);
    if (terms.length === 0) return [];

    const limit = options.limit ?? CONTEXT_RESULT_LIMIT;
    const isCandidatePath = (path) =>
      this.isPathAllowed(path) && (!options.folder || path.startsWith(options.folder));
    // Stage 1 reads no content: metadata matches first, then the most recent
    // notes, capped at SEARCH_CANDIDATE_LIMIT regardless of vault size.
    const candidates = this.getIndex().candidatesForTerms(terms, {
      limit: SEARCH_CANDIDATE_LIMIT,
      isPathAllowed: isCandidatePath
    });
    const results = [];

    for (const candidate of candidates) {
      const note = this.vault.note(candidate.path);
      if (!note) continue;
      const content = await this.readFile(note.path, NOTE_CONTEXT_CHAR_LIMIT);
      results.push({
        path: note.path,
        title: note.title,
        score: scoreSearchResult(note.path, content, terms),
        excerpt: createExcerpt(content, terms),
        tags: this.vault.getMetadata(note.path).tags.sort()
      });
    }

    return rankSearchResults(results, limit);
  }

  /**
   * @param {string} [selection]
   */
  async getActiveNoteContext(selection = "") {
    const path = this.getActivePath();
    if (!path) return undefined;

    const content = await this.readFile(path, NOTE_CONTEXT_CHAR_LIMIT);
    return { ...(await this.getNoteContext(path)), content, selection };
  }

  /** @param {string} path */
  async getNoteContext(path) {
    const note = this.vault.note(path);
    if (!note) throw new Error(`Note not found: ${String(path)}`);

    const metadata = this.vault.getMetadata(note.path);
    const content = await this.readFile(note.path, NOTE_CONTEXT_CHAR_LIMIT);

    return {
      path: note.path,
      title: note.title,
      frontmatter: metadata.frontmatter,
      tags: metadata.tags.sort(),
      aliases: metadata.aliases,
      headings: metadata.headings,
      backlinks: await this.getBacklinks(note.path),
      outgoingLinks: this.getOutgoingLinks(note.path),
      unresolvedLinks: this.getUnresolvedLinks(note.path),
      excerpt: createExcerpt(content, tokenizeQuery(note.title), 320)
    };
  }

  /** @param {string} folderPath */
  async getFolderSummary(folderPath) {
    const normalizedFolderPath = folderPath.replace(/^\/+|\/+$/g, "");
    const notes = this.getNotes()
      .filter((note) => note.path.startsWith(`${normalizedFolderPath}/`))
      .slice(0, CONTEXT_RESULT_LIMIT);
    const results = [];

    for (const note of notes) {
      const content = await this.readFile(note.path, NOTE_CONTEXT_CHAR_LIMIT);
      results.push({
        path: note.path,
        title: note.title,
        score: 1,
        excerpt: createExcerpt(content, tokenizeQuery(note.title), 260),
        tags: this.vault.getMetadata(note.path).tags.sort()
      });
    }

    return results;
  }

  /** @param {string} tag */
  async getNotesByTag(tag) {
    const normalizedTag = tag.startsWith("#") ? tag : `#${tag}`;
    const paths = this.getIndex()
      .pathsWithTag(normalizedTag)
      .filter((path) => this.isPathAllowed(path))
      .slice(0, CONTEXT_RESULT_LIMIT);
    const results = [];

    for (const path of paths) {
      const note = this.vault.note(path);
      if (!note) continue;
      const content = await this.readFile(note.path, NOTE_CONTEXT_CHAR_LIMIT);
      results.push({
        path: note.path,
        title: note.title,
        score: 1,
        excerpt: createExcerpt(content, tokenizeQuery(normalizedTag), 260),
        tags: this.vault.getMetadata(note.path).tags.sort()
      });
    }

    return results;
  }

  /**
   * Resolves a wikilink-style reference to a vault path.
   *
   * @param {string} notePath
   * @returns {string | undefined}
   */
  resolveNotePath(notePath) {
    const normalizedPath = notePath.replace(/^\/+/, "").replace(/#.*$/, "");
    const candidates = [
      normalizedPath,
      normalizedPath.endsWith(".md") ? normalizedPath : `${normalizedPath}.md`,
      normalizedPath.replace(/\.md$/i, "")
    ];

    for (const candidate of candidates) {
      const note = this.vault.note(candidate);
      if (note && this.isPathAllowed(note.path)) return note.path;

      const linkedPath = this.vault.resolveLinkPath(candidate.replace(/\.md$/i, ""), "");
      if (linkedPath && this.isPathAllowed(linkedPath)) return linkedPath;
    }

    return undefined;
  }

  /** @param {string} filePath */
  async getBacklinks(filePath) {
    const backlinkEntries = this.getIndex()
      .getBacklinkCounts(filePath)
      .filter((backlink) => backlink.path !== filePath && this.isPathAllowed(backlink.path))
      .slice(0, CONTEXT_RESULT_LIMIT);
    const backlinks = [];

    for (const backlink of backlinkEntries) {
      const note = this.vault.note(backlink.path);
      let excerpt = "";
      if (note) {
        const content = await this.readFile(note.path, NOTE_CONTEXT_CHAR_LIMIT);
        excerpt = createExcerpt(content, tokenizeQuery(filePath.replace(/\.md$/i, "")), 220);
      }

      backlinks.push({
        path: backlink.path,
        display: backlink.path.replace(/\.md$/i, ""),
        count: backlink.count,
        excerpt
      });
    }

    return backlinks;
  }

  /** @param {string} filePath */
  getOutgoingLinks(filePath) {
    return this.getIndex()
      .getOutgoingCounts(filePath)
      .filter((link) => this.isPathAllowed(link.path))
      .map((link) => ({
        path: link.path,
        display: link.path.replace(/\.md$/i, ""),
        count: link.count
      }));
  }

  /** @param {string} filePath */
  getUnresolvedLinks(filePath) {
    return this.getIndex()
      .getUnresolvedCounts(filePath)
      .map((link) => ({ path: link.path, display: link.path, count: link.count }));
  }

  /**
   * @param {string} filePath
   * @param {number} [depth]
   */
  async getLinkedNeighborhood(filePath, depth = 1) {
    const index = this.getIndex();
    const seen = new Set([filePath]);
    let frontier = [filePath];
    const notes = [];

    for (let level = 0; level < depth; level++) {
      const nextFrontier = new Set();

      for (const path of frontier) {
        const links = [...index.getOutgoingCounts(path), ...index.getBacklinkCounts(path)];
        for (const link of links) {
          if (!seen.has(link.path) && link.path.endsWith(".md")) {
            seen.add(link.path);
            nextFrontier.add(link.path);
          }
        }
      }

      const limitedNextFrontier = [...nextFrontier].slice(0, CONTEXT_RESULT_LIMIT);
      for (const path of limitedNextFrontier) {
        try {
          notes.push(await this.getNoteContext(path));
        } catch {
          // Ignore stale metadata links.
        }
      }

      frontier = limitedNextFrontier;
    }

    return notes.slice(0, CONTEXT_RESULT_LIMIT);
  }

  /** @returns {string | undefined} */
  getActivePath() {
    return this.getActiveNotePath?.() ?? this.workspace.activeNotePath();
  }

  /** @param {string} filePath */
  async readVaultFile(filePath) {
    if (!this.vault.note(filePath)) throw new Error(`File not found: ${filePath}`);
    if (!this.isPathAllowed(filePath)) throw new Error(`Path is not allowed: ${filePath}`);

    return this.readFile(filePath, NOTE_CONTEXT_CHAR_LIMIT);
  }

  /**
   * @param {string} path
   * @param {number} [maxChars]
   */
  async readFile(path, maxChars = NOTE_CONTEXT_CHAR_LIMIT) {
    return this.vault.read(path, maxChars);
  }

  /** @param {string} filePath */
  isPathAllowed(filePath) {
    const normalizedPath = String(filePath).replace(/\\/g, "/");

    return !this.settings.ignoredFolders.some((ignoredFolder) => {
      const normalizedIgnoredFolder = ignoredFolder.replace(/\/+$/, "");
      return (
        normalizedPath === normalizedIgnoredFolder ||
        normalizedPath.startsWith(`${normalizedIgnoredFolder}/`)
      );
    });
  }
}
