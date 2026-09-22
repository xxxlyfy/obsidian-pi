import { TFile } from "obsidian";
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

export class VaultGraph {
  /**
   * @param {any} app
   * @param {any} settings
   * @param {() => any} getCurrentContextFile
   * @param {VaultIndex} [index] Shared metadata/link index. Created lazily when omitted.
   */
  constructor(app, settings, getCurrentContextFile, index = undefined) {
    this.app = app;
    this.settings = settings;
    this.getCurrentContextFile = getCurrentContextFile;
    this.index = index;
  }

  getIndex() {
    if (!this.index) this.index = new VaultIndex({ app: this.app }).ensureBuilt();
    return this.index;
  }

  getMarkdownFiles() {
    return this.app.vault.getMarkdownFiles().filter((file) => this.isPathAllowed(file.path));
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
      const file = this.app.vault.getAbstractFileByPath(candidate.path);
      if (!(file instanceof TFile)) continue;
      const content = await this.readFile(file, NOTE_CONTEXT_CHAR_LIMIT);
      const cache = this.app.metadataCache.getFileCache(file);
      results.push({
        path: file.path,
        title: file.basename,
        score: scoreSearchResult(file.path, content, terms),
        excerpt: createExcerpt(content, terms),
        tags: this.getTags(cache)
      });
    }

    return rankSearchResults(results, limit);
  }

  async getActiveNoteContext(selection = "") {
    const file = this.getActiveFile();
    if (!file) return undefined;

    const content = await this.readFile(file, NOTE_CONTEXT_CHAR_LIMIT);
    return { ...(await this.getNoteContext(file)), content, selection };
  }

  async getNoteContext(fileOrPath) {
    const file =
      typeof fileOrPath === "string"
        ? this.app.vault.getAbstractFileByPath(fileOrPath)
        : fileOrPath;
    if (!(file instanceof TFile)) throw new Error(`Note not found: ${String(fileOrPath)}`);

    const cache = this.app.metadataCache.getFileCache(file);
    const content = await this.readFile(file, NOTE_CONTEXT_CHAR_LIMIT);

    return {
      path: file.path,
      title: file.basename,
      frontmatter: cache?.frontmatter ?? {},
      tags: this.getTags(cache),
      aliases: this.getAliases(cache),
      headings: this.getHeadings(cache),
      backlinks: await this.getBacklinks(file.path),
      outgoingLinks: this.getOutgoingLinks(file.path),
      unresolvedLinks: this.getUnresolvedLinks(file.path),
      excerpt: createExcerpt(content, tokenizeQuery(file.basename), 320)
    };
  }

  async findReferences(query) {
    const titleMatches = this.getIndex()
      .matchTitleOrAlias(query, { isPathAllowed: (path) => this.isPathAllowed(path) })
      .map((path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return undefined;
        return {
          path: file.path,
          title: file.basename,
          score: 20,
          excerpt: "Title match",
          tags: this.getTags(this.app.metadataCache.getFileCache(file))
        };
      })
      .filter(Boolean);
    const searchMatches = await this.searchNotes(query, { limit: CONTEXT_RESULT_LIMIT });

    return rankSearchResults([...titleMatches, ...searchMatches], CONTEXT_RESULT_LIMIT);
  }

  async getFolderSummary(folderPath) {
    const normalizedFolderPath = folderPath.replace(/^\/+|\/+$/g, "");
    const files = this.getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${normalizedFolderPath}/`))
      .slice(0, CONTEXT_RESULT_LIMIT);
    const results = [];

    for (const file of files) {
      const content = await this.readFile(file, NOTE_CONTEXT_CHAR_LIMIT);
      results.push({
        path: file.path,
        title: file.basename,
        score: 1,
        excerpt: createExcerpt(content, tokenizeQuery(file.basename), 260),
        tags: this.getTags(this.app.metadataCache.getFileCache(file))
      });
    }

    return results;
  }

  async getNotesByTag(tag) {
    const normalizedTag = tag.startsWith("#") ? tag : `#${tag}`;
    const paths = this.getIndex()
      .pathsWithTag(normalizedTag)
      .filter((path) => this.isPathAllowed(path))
      .slice(0, CONTEXT_RESULT_LIMIT);
    const results = [];

    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      const content = await this.readFile(file, NOTE_CONTEXT_CHAR_LIMIT);
      results.push({
        path: file.path,
        title: file.basename,
        score: 1,
        excerpt: createExcerpt(content, tokenizeQuery(normalizedTag), 260),
        tags: this.getTags(this.app.metadataCache.getFileCache(file))
      });
    }

    return results;
  }

  resolveNoteFile(notePath) {
    const normalizedPath = notePath.replace(/^\/+/, "").replace(/#.*$/, "");
    const candidates = [
      normalizedPath,
      normalizedPath.endsWith(".md") ? normalizedPath : `${normalizedPath}.md`,
      normalizedPath.replace(/\.md$/i, "")
    ];

    for (const candidate of candidates) {
      const directFile = this.app.vault.getAbstractFileByPath(candidate);
      if (directFile instanceof TFile && this.isPathAllowed(directFile.path)) return directFile;

      const linkedFile = this.app.metadataCache.getFirstLinkpathDest(
        candidate.replace(/\.md$/i, ""),
        ""
      );
      if (linkedFile && this.isPathAllowed(linkedFile.path)) return linkedFile;
    }

    return undefined;
  }

  async getBacklinks(filePath) {
    const backlinkEntries = this.getIndex()
      .getBacklinkCounts(filePath)
      .filter((backlink) => backlink.path !== filePath && this.isPathAllowed(backlink.path))
      .slice(0, CONTEXT_RESULT_LIMIT);
    const backlinks = [];

    for (const backlink of backlinkEntries) {
      const file = this.app.vault.getAbstractFileByPath(backlink.path);
      let excerpt = "";
      if (file instanceof TFile) {
        const content = await this.readFile(file, NOTE_CONTEXT_CHAR_LIMIT);
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

  getUnresolvedLinks(filePath) {
    return this.getIndex()
      .getUnresolvedCounts(filePath)
      .map((link) => ({ path: link.path, display: link.path, count: link.count }));
  }

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

  getActiveFile() {
    const file = this.getCurrentContextFile?.() ?? this.app.workspace.getActiveFile();
    return file && file.extension === "md" && this.isPathAllowed(file.path) ? file : undefined;
  }

  async readVaultFile(filePath) {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) throw new Error(`File not found: ${filePath}`);
    if (!this.isPathAllowed(file.path)) throw new Error(`Path is not allowed: ${filePath}`);

    return this.readFile(file, NOTE_CONTEXT_CHAR_LIMIT);
  }

  async readFile(file, maxChars = NOTE_CONTEXT_CHAR_LIMIT) {
    const content = await this.app.vault.cachedRead(file);
    return content.length > maxChars ? `${content.slice(0, maxChars)}\n...[truncated]` : content;
  }

  isPathAllowed(filePath) {
    const normalizedPath = filePath.replace(/\\/g, "/");

    return !this.settings.ignoredFolders.some((ignoredFolder) => {
      const normalizedIgnoredFolder = ignoredFolder.replace(/\/+$/, "");
      return (
        normalizedPath === normalizedIgnoredFolder ||
        normalizedPath.startsWith(`${normalizedIgnoredFolder}/`)
      );
    });
  }

  getTags(cache) {
    const tags = new Set();
    for (const tag of cache?.tags ?? []) tags.add(tag.tag);

    const frontmatterTags = cache?.frontmatter?.tags;
    if (Array.isArray(frontmatterTags)) {
      for (const tag of frontmatterTags) tags.add(String(tag));
    } else if (typeof frontmatterTags === "string") {
      tags.add(frontmatterTags);
    }

    return [...tags].sort();
  }

  getAliases(cache) {
    const aliases = cache?.frontmatter?.aliases;
    return Array.isArray(aliases)
      ? aliases.map(String)
      : typeof aliases === "string"
        ? [aliases]
        : [];
  }

  getHeadings(cache) {
    return (cache?.headings ?? [])
      .map((heading) => heading.heading)
      .filter(Boolean)
      .slice(0, 20);
  }
}
