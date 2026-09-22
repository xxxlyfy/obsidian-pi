import { describe, expect, it, vi } from "vitest";
import { createSyntheticVault } from "../fixtures/synthetic-vault.mjs";

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

const { VaultIndex, SEARCH_CANDIDATE_LIMIT } = await import("../../src/context/vault-index.mjs");
const { VaultGraph } = await import("../../src/context/vault-graph.mjs");
const { VaultAdapter } = await import("../../src/obsidian/vault-adapter.mjs");
const { WorkspaceAdapter } = await import("../../src/obsidian/workspace-adapter.mjs");
const { DEFAULT_SETTINGS } = await import("../../src/plugin/settings.mjs");

const SIZES = [500, 2_000, 5_000, 10_000];

function buildVault(notes) {
  const vault = createSyntheticVault(obsidian.TFile, { notes });
  const index = new VaultIndex({ vault: new VaultAdapter(vault.app) });
  const graph = new VaultGraph({
    vault: new VaultAdapter(vault.app),
    workspace: new WorkspaceAdapter(vault.app),
    settings: { ...DEFAULT_SETTINGS },
    index
  });
  return { ...vault, index, graph };
}

const now = () => Number(process.hrtime.bigint()) / 1e6;

async function measure(action) {
  const started = now();
  const value = await action();
  return { ms: now() - started, value };
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

describe("search and context performance", () => {
  it("keeps index, search, backlink, and context work bounded by candidate caps", async () => {
    const report = [];

    for (const notes of SIZES) {
      const vault = buildVault(notes);
      const target = vault.pathFor(0);

      const build = await measure(() => vault.index.rebuild());
      expect(vault.readCounts.size).toBe(0);

      const search = await measure(() => vault.graph.searchNotes("alpha"));
      const searchReads = vault.readCounts.size;

      vault.readCounts.clear();
      const backlinks = await measure(() => vault.graph.getBacklinks(target));
      const backlinkReads = vault.readCounts.size;

      vault.readCounts.clear();
      const context = await measure(() => vault.graph.getNoteContext(target));
      const contextReads = vault.readCounts.size;

      // Incremental index work: modify, rename, and delete one note.
      vault.readCounts.clear();
      const modify = await measure(() => {
        vault.caches.set(target, {
          frontmatter: { tags: ["#bench"] },
          tags: [{ tag: "#bench" }],
          headings: [{ heading: "bench" }]
        });
        vault.index.updatePath(target);
      });
      const renameTarget = `Notes/bench-renamed-${notes}.md`;
      const rename = await measure(() => vault.index.renamePath(target, renameTarget));
      const remove = await measure(() => vault.index.removePath(renameTarget));
      expect(vault.readCounts.size).toBe(0);

      // Search latency distribution over repeated runs.
      const samples = [];
      for (let index = 0; index < 20; index++) {
        const sample = await measure(() => vault.graph.searchNotes("alpha"));
        samples.push(sample.ms);
      }

      expect(searchReads).toBeLessThanOrEqual(SEARCH_CANDIDATE_LIMIT);
      expect(backlinkReads).toBeLessThanOrEqual(8);
      expect(contextReads).toBeLessThanOrEqual(9);
      expect(search.value.length).toBeGreaterThan(0);

      report.push({
        notes,
        indexBuildMs: Number(build.ms.toFixed(1)),
        searchMs: Number(search.ms.toFixed(1)),
        searchP50Ms: Number(percentile(samples, 0.5).toFixed(1)),
        searchP95Ms: Number(percentile(samples, 0.95).toFixed(1)),
        searchReads,
        backlinkMs: Number(backlinks.ms.toFixed(1)),
        backlinkReads: backlinks.value.length,
        contextMs: Number(context.ms.toFixed(1)),
        contextReads,
        modifyMs: Number(modify.ms.toFixed(2)),
        renameMs: Number(rename.ms.toFixed(2)),
        deleteMs: Number(remove.ms.toFixed(2))
      });
    }

    console.log("Pi Agent search/index benchmark");
    console.table(report);
    expect(report).toHaveLength(SIZES.length);
  }, 60_000);

  it("does not re-read the vault when the index was already built", async () => {
    const vault = buildVault(2_000);
    vault.index.rebuild();

    await vault.graph.searchNotes("beta");
    const first = vault.readCounts.size;
    vault.readCounts.clear();
    await vault.graph.searchNotes("beta");

    expect(vault.readCounts.size).toBe(first);
  });
});
