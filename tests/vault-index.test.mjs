import { describe, expect, it, vi } from "vitest";
import { createSyntheticVault } from "./fixtures/synthetic-vault.mjs";

const obsidian = vi.hoisted(() => {
  class TFile {
    constructor(path) {
      this.path = path;
      this.name = path.split("/").pop();
      this.basename = this.name.replace(/\.md$/i, "");
      this.extension = "md";
      this.stat = { mtime: 1_700_000_000_000 };
    }
  }
  return { TFile };
});

vi.mock("obsidian", () => ({ TFile: obsidian.TFile, Notice: class {} }));

const { VaultIndex, SEARCH_CANDIDATE_LIMIT } = await import("../src/context/vault-index.mjs");
const { VaultGraph } = await import("../src/context/vault-graph.mjs");
const { DEFAULT_SETTINGS } = await import("../src/plugin/settings.mjs");

function createFixture(notes = 300) {
  const vault = createSyntheticVault(obsidian.TFile, { notes });
  const index = new VaultIndex({ app: vault.app }).ensureBuilt();
  const graph = new VaultGraph(
    vault.app,
    { ...DEFAULT_SETTINGS },
    () => vault.app.workspace.getActiveFile(),
    index
  );
  return { ...vault, index, graph };
}

describe("VaultIndex", () => {
  it("builds metadata and link indexes without reading note content", () => {
    const { index, files, readCounts } = createFixture(200);
    const firstPath = [...files.keys()][0];

    expect(index.size).toBe(200);
    expect(readCounts.size).toBe(0);
    expect(index.getMetadata(firstPath)).toMatchObject({
      path: firstPath,
      title: expect.stringContaining("Note"),
      tags: expect.arrayContaining([expect.stringMatching(/^#tag\d+$/)]),
      headings: expect.arrayContaining([expect.any(String)])
    });
  });

  it("keeps a reverse backlink index that matches a full recompute", () => {
    const { index, resolvedLinks, pathFor } = createFixture(300);

    for (const targetIndex of [0, 7, 25, 101]) {
      const target = pathFor(targetIndex);
      const expected = Object.entries(resolvedLinks)
        .filter(([, links]) => links[target])
        .map(([source, links]) => [source, links[target]])
        .filter(([source]) => source !== target)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

      expect(index.getBacklinkCounts(target).map((entry) => [entry.path, entry.count])).toEqual(
        expected
      );
      expect(index.getOutgoingCounts(target).map((entry) => entry.path)).toEqual(
        Object.keys(resolvedLinks[target] ?? {}).sort()
      );
    }
  });

  it("updates metadata, links, and backlinks incrementally", () => {
    const { index, resolvedLinks, pathFor, caches, files } = createFixture(50);
    const source = pathFor(3);
    const oldTarget = Object.keys(resolvedLinks[source])[0];
    const newTarget = pathFor(20);

    index.updateFile(files.get(source));
    expect(index.getBacklinkCounts(oldTarget)).toContainEqual({ path: source, count: 1 });

    caches.set(source, {
      frontmatter: { tags: ["#reindexed"] },
      tags: [{ tag: "#reindexed" }],
      headings: []
    });
    resolvedLinks[source] = { [newTarget]: 5 };
    index.updateFile(files.get(source));

    expect(index.getMetadata(source).tags).toEqual(["#reindexed"]);
    expect(index.getBacklinkCounts(oldTarget).some((entry) => entry.path === source)).toBe(false);
    expect(index.getBacklinkCounts(newTarget)).toContainEqual({ path: source, count: 5 });

    index.removePath(source);

    expect(index.getMetadata(source)).toBeUndefined();
    expect(index.getBacklinkCounts(newTarget)).not.toContainEqual({ path: source, count: 5 });
  });

  it("moves metadata on rename without touching link indexes", () => {
    const { index, pathFor } = createFixture(20);
    const oldPath = pathFor(4);
    const newPath = "Notes/Renamed/Note 4.md";

    index.renamePath(oldPath, newPath);

    expect(index.getMetadata(oldPath)).toBeUndefined();
    expect(index.getMetadata(newPath)).toMatchObject({ path: newPath });
  });

  it("finds tags and title or alias matches from metadata only", () => {
    const { index, readCounts } = createFixture(120);

    const tagged = index.pathsWithTag("#tag7");
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every((path) => index.getMetadata(path).tags.includes("#tag7"))).toBe(true);
    expect(index.pathsWithTag("tag7").length).toBe(tagged.length);
    expect(index.pathsWithTag("")).toEqual([]);
    expect(index.matchTitleOrAlias("Note 12").length).toBeGreaterThan(0);
    expect(readCounts.size).toBe(0);
  });

  it("caps search candidates on a large vault", () => {
    const { index } = createFixture(2_000);

    const candidates = index.candidatesForTerms(["alpha"], { limit: SEARCH_CANDIDATE_LIMIT });

    expect(candidates.length).toBe(SEARCH_CANDIDATE_LIMIT);
    expect(candidates[0].score).toBeGreaterThanOrEqual(candidates[1].score);
  });
});

describe("VaultGraph with the metadata index", () => {
  it("reads only search candidates instead of the whole vault", async () => {
    const { graph, readCounts } = createFixture(2_000);

    const results = await graph.searchNotes("alpha");

    expect(results.length).toBeGreaterThan(0);
    expect(readCounts.size).toBeLessThanOrEqual(SEARCH_CANDIDATE_LIMIT);
    expect(readCounts.size).toBeLessThan(2_000);
  });

  it("answers backlink lookups by reading only the backlink sources", async () => {
    const { graph, index, readCounts, pathFor } = createFixture(2_000);
    const target = pathFor(0);

    const backlinks = await graph.getBacklinks(target);

    expect(backlinks.length).toBeGreaterThan(0);
    expect(readCounts.size).toBe(backlinks.length);
    expect(index.getBacklinkCounts(target).length).toBeGreaterThanOrEqual(backlinks.length);
  });

  it("builds a linked neighborhood without rescanning resolvedLinks per hop", async () => {
    const { graph, readCounts, pathFor } = createFixture(2_000);

    const neighborhood = await graph.getLinkedNeighborhood(pathFor(10), 2);

    // Two levels of an 8-note frontier plus the backlink excerpts those notes
    // build. The point is that a 2,000-note vault is never scanned.
    expect(neighborhood.length).toBeGreaterThan(0);
    expect(readCounts.size).toBeLessThan(100);
  });

  it("lists tag matches without scanning every file", async () => {
    const { graph, readCounts } = createFixture(2_000);

    const results = await graph.getNotesByTag("#tag7");

    expect(results.length).toBeGreaterThan(0);
    expect(readCounts.size).toBe(results.length);
  });
});
