export const SEARCH_CANDIDATE_LIMIT = 128;

/**
 * Metadata and link index for the vault.
 *
 * Everything here comes from Obsidian's `metadataCache`, so building or
 * updating the index never re-reads note content. Content is only read later
 * for the candidates a query actually needs.
 *
 * Shape:
 * - `metadata`: `Map<path, { path, title, aliases, tags, headings, mtime }>`
 * - `outgoing`: `Map<sourcePath, Map<targetPath, count>>`
 * - `backlinks`: `Map<targetPath, Map<sourcePath, count>>`
 * - `unresolved`: `Map<sourcePath, Map<linkText, count>>`
 */
export class VaultIndex {
  /**
   * @param {object} options
   * @param {any} options.app Obsidian app (vault + metadataCache).
   */
  constructor({ app }) {
    this.app = app;
    /** @type {Map<string, { path: string, title: string, aliases: string[], tags: string[], headings: string[], mtime: number }>} */
    this.metadata = new Map();
    /** @type {Map<string, Map<string, number>>} */
    this.outgoing = new Map();
    /** @type {Map<string, Map<string, number>>} */
    this.backlinks = new Map();
    /** @type {Map<string, Map<string, number>>} */
    this.unresolved = new Map();
    this.built = false;
  }

  get size() {
    return this.metadata.size;
  }

  /**
   * Attaches incremental updates. `register` should be Obsidian's
   * `Plugin.registerEvent` so everything is torn down with the plugin.
   *
   * @param {(eventRef: any) => void} [register]
   */
  start(register = () => {}) {
    this.ensureBuilt();
    const cache = this.app.metadataCache;
    register(cache.on("changed", (file) => this.updateFile(file)));
    register(cache.on("resolved", () => this.rebuild()));
    const vault = this.app.vault;
    register(vault.on("create", (file) => this.updateFile(file)));
    register(vault.on("modify", (file) => this.updateFile(file)));
    register(vault.on("delete", (file) => this.removePath(file?.path)));
    register(
      vault.on("rename", (file, oldPath) => {
        this.renamePath(oldPath, file?.path);
        this.updateFile(file);
      })
    );
  }

  ensureBuilt() {
    if (!this.built) this.rebuild();
    return this;
  }

  rebuild() {
    this.metadata.clear();
    this.outgoing.clear();
    this.backlinks.clear();
    this.unresolved.clear();

    for (const file of this.app.vault.getMarkdownFiles()) this.indexFileMetadata(file);

    const resolvedLinks = this.app.metadataCache.resolvedLinks ?? {};
    for (const [source, links] of Object.entries(resolvedLinks)) {
      const counts = toCountMap(links);
      if (counts.size > 0) this.setOutgoing(source, counts);
    }
    const unresolvedLinks = this.app.metadataCache.unresolvedLinks ?? {};
    for (const [source, links] of Object.entries(unresolvedLinks)) {
      const counts = toCountMap(links);
      if (counts.size > 0) this.unresolved.set(source, counts);
    }

    this.built = true;
  }

  /** @param {any} file */
  updateFile(file) {
    if (!file?.path) return;
    this.ensureBuilt();
    this.indexFileMetadata(file);
    const links = /** @type {Record<string, number>} */ (
      this.app.metadataCache.resolvedLinks?.[file.path] ?? {}
    );
    this.setOutgoing(file.path, toCountMap(links));
    const unresolved = /** @type {Record<string, number>} */ (
      this.app.metadataCache.unresolvedLinks?.[file.path] ?? {}
    );
    if (unresolved && Object.keys(unresolved).length > 0)
      this.unresolved.set(file.path, toCountMap(unresolved));
    else this.unresolved.delete(file.path);
  }

  /** @param {string} path */
  removePath(path) {
    if (!path) return;
    this.metadata.delete(path);
    this.setOutgoing(path, new Map());
    this.unresolved.delete(path);
  }

  /**
   * @param {string} oldPath
   * @param {string} newPath
   */
  renamePath(oldPath, newPath) {
    if (!oldPath || !newPath || oldPath === newPath) return;
    const entry = this.metadata.get(oldPath);
    this.removePath(oldPath);
    if (entry) this.metadata.set(newPath, { ...entry, path: newPath });
  }

  /** @param {any} file */
  indexFileMetadata(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    const entry = {
      path: file.path,
      title: String(file.basename ?? ""),
      aliases: readAliases(cache),
      tags: readTags(cache),
      headings: readHeadings(cache),
      mtime: Number(file.stat?.mtime ?? 0)
    };
    if (entry.path) this.metadata.set(entry.path, entry);
    return entry;
  }

  /**
   * @param {string} source
   * @param {Map<string, number>} targets
   */
  setOutgoing(source, targets) {
    const previous = this.outgoing.get(source);
    if (previous) {
      for (const target of previous.keys()) {
        if (targets.has(target) && targets.get(target) === previous.get(target)) continue;
        this.removeBacklink(target, source);
      }
    }
    if (targets.size === 0) {
      this.outgoing.delete(source);
      return;
    }
    this.outgoing.set(source, targets);
    for (const [target, count] of targets) this.addBacklink(target, source, count);
  }

  /**
   * @param {string} target
   * @param {string} source
   * @param {number} count
   */
  addBacklink(target, source, count) {
    if (!target || target === source) return;
    let sources = this.backlinks.get(target);
    if (!sources) {
      sources = new Map();
      this.backlinks.set(target, sources);
    }
    sources.set(source, count);
  }

  /**
   * @param {string} target
   * @param {string} source
   */
  removeBacklink(target, source) {
    const sources = this.backlinks.get(target);
    if (!sources) return;
    sources.delete(source);
    if (sources.size === 0) this.backlinks.delete(target);
  }

  /** @param {string} path */
  getMetadata(path) {
    this.ensureBuilt();
    return this.metadata.get(path);
  }

  /** @returns {Array<{ path: string, count: number }>} */
  getBacklinkCounts(targetPath) {
    this.ensureBuilt();
    const sources = this.backlinks.get(targetPath);
    if (!sources) return [];
    return [...sources.entries()]
      .map(([path, count]) => ({ path, count }))
      .sort((left, right) => right.count - left.count || left.path.localeCompare(right.path));
  }

  /** @returns {Array<{ path: string, count: number }>} */
  getOutgoingCounts(sourcePath) {
    this.ensureBuilt();
    const targets = this.outgoing.get(sourcePath);
    if (!targets) return [];
    return [...targets.entries()]
      .map(([path, count]) => ({ path, count }))
      .sort((left, right) => right.count - left.count || left.path.localeCompare(right.path));
  }

  /** @returns {Array<{ path: string, count: number }>} */
  getUnresolvedCounts(sourcePath) {
    this.ensureBuilt();
    const links = this.unresolved.get(sourcePath);
    if (!links) return [];
    return [...links.entries()]
      .map(([path, count]) => ({ path, count }))
      .sort((left, right) => right.count - left.count || left.path.localeCompare(right.path));
  }

  /** @param {string} tag */
  pathsWithTag(tag) {
    this.ensureBuilt();
    const normalized = String(tag ?? "").toLowerCase();
    if (!normalized) return [];
    const withHash = normalized.startsWith("#") ? normalized : `#${normalized}`;
    return [...this.metadata.values()]
      .filter((entry) =>
        entry.tags.some((candidate) => {
          const value = candidate.toLowerCase();
          return value === withHash || value === withHash.slice(1);
        })
      )
      .map((entry) => entry.path);
  }

  /**
   * Stage 1 of search: metadata-only scoring plus a bounded recent-note top-up,
   * so a query never reads the whole vault.
   *
   * @param {string[]} terms
   * @param {{ limit?: number, isPathAllowed?: (path: string) => boolean }} [options]
   * @returns {Array<{ path: string, score: number }>}
   */
  candidatesForTerms(terms, options = {}) {
    this.ensureBuilt();
    const limit = options.limit ?? SEARCH_CANDIDATE_LIMIT;
    const isPathAllowed = options.isPathAllowed ?? (() => true);
    const scored = [];
    const rest = [];

    for (const entry of this.metadata.values()) {
      if (!isPathAllowed(entry.path)) continue;
      const score = scoreMetadataEntry(entry, terms);
      if (score > 0) scored.push({ path: entry.path, score, mtime: entry.mtime });
      else rest.push({ path: entry.path, score: 0, mtime: entry.mtime });
    }

    scored.sort(
      (left, right) =>
        right.score - left.score || right.mtime - left.mtime || left.path.localeCompare(right.path)
    );
    if (scored.length >= limit) return scored.slice(0, limit).map(stripMtime);

    const byRecency = (left, right) =>
      right.mtime - left.mtime || left.path.localeCompare(right.path);
    rest.sort(byRecency);
    const remaining = limit - scored.length;
    return [...scored, ...rest.slice(0, Math.max(0, remaining))].map(stripMtime);
  }

  /**
   * @param {string} query
   * @param {{ limit?: number, isPathAllowed?: (path: string) => boolean }} [options]
   */
  matchTitleOrAlias(query, options = {}) {
    this.ensureBuilt();
    const needle = String(query ?? "").toLowerCase();
    if (!needle) return [];
    const isPathAllowed = options.isPathAllowed ?? (() => true);
    const limit = options.limit ?? SEARCH_CANDIDATE_LIMIT;
    return [...this.metadata.values()]
      .filter(
        (entry) =>
          isPathAllowed(entry.path) &&
          (entry.title.toLowerCase().includes(needle) ||
            entry.aliases.some((alias) => alias.toLowerCase().includes(needle)))
      )
      .slice(0, limit)
      .map((entry) => entry.path);
  }
}

function stripMtime(candidate) {
  return { path: candidate.path, score: candidate.score };
}

function scoreMetadataEntry(entry, terms) {
  const title = entry.title.toLowerCase();
  const path = entry.path.toLowerCase();
  const aliases = entry.aliases.map((alias) => alias.toLowerCase());
  const tags = entry.tags.map((tag) => tag.toLowerCase());
  const headings = entry.headings.map((heading) => heading.toLowerCase());
  let score = 0;

  for (const term of terms) {
    if (title.includes(term)) score += 12;
    if (path.includes(term)) score += 4;
    if (
      aliases.some((value) => value.includes(term)) ||
      tags.some((value) => value.includes(term)) ||
      headings.some((value) => value.includes(term))
    )
      score += 8;
  }

  return score;
}

/** @param {Record<string, number> | undefined} links */
function toCountMap(links) {
  const counts = new Map();
  for (const [path, count] of Object.entries(links ?? {})) {
    if (!path) continue;
    counts.set(path, Number(count) || 1);
  }
  return counts;
}

function readAliases(cache) {
  const aliases = cache?.frontmatter?.aliases;
  if (Array.isArray(aliases)) return aliases.map(String);
  return typeof aliases === "string" ? [aliases] : [];
}

function readTags(cache) {
  const tags = new Set();
  for (const tag of cache?.tags ?? []) if (tag?.tag) tags.add(String(tag.tag));
  const frontmatterTags = cache?.frontmatter?.tags;
  if (Array.isArray(frontmatterTags)) for (const tag of frontmatterTags) tags.add(String(tag));
  else if (typeof frontmatterTags === "string") tags.add(frontmatterTags);
  return [...tags];
}

function readHeadings(cache) {
  return (cache?.headings ?? [])
    .map((heading) => heading?.heading)
    .filter(Boolean)
    .map(String);
}
