import { describe, expect, it, vi } from "vitest";
import { createSyntheticVault } from "./fixtures/synthetic-vault.mjs";

const obsidian = vi.hoisted(() => {
  class TFile {
    constructor(path) {
      this.path = path;
      this.name = path.split("/").pop();
      this.basename = this.name.replace(/\.md$/i, "");
      this.extension = "md";
      this.stat = { mtime: 1 };
    }
  }
  return { TFile };
});

vi.mock("obsidian", () => ({ TFile: obsidian.TFile, Notice: class {} }));

const { VaultIndex } = await import("../src/context/vault-index.mjs");
const { VaultAdapter } = await import("../src/obsidian/vault-adapter.mjs");

/**
 * A tiny writable vault so link/metadata changes can be applied the same way
 * Obsidian would (metadata cache + resolvedLinks + vault events).
 */
function createVault() {
  const notes = new Map();
  const resolved = {};
  const unresolved = {};
  const events = {};
  const app = {
    vault: {
      adapter: { getBasePath: () => "/vault" },
      getMarkdownFiles: () => [...notes.values()].map((entry) => entry.file),
      getAbstractFileByPath: (path) => notes.get(path)?.file,
      cachedRead: async (file) => notes.get(file.path)?.content ?? "",
      read: async (file) => notes.get(file.path)?.content ?? "",
      on: (name, callback) => {
        events[name] = callback;
        return { name, callback };
      }
    },
    metadataCache: {
      getFileCache: (file) => notes.get(file.path)?.cache,
      resolvedLinks: resolved,
      unresolvedLinks: unresolved,
      getFirstLinkpathDest: (linkpath) => notes.get(`${linkpath}.md`)?.file,
      on: (name, callback) => {
        events[`metadata:${name}`] = callback;
        return { name, callback };
      }
    }
  };
  const adapter = new VaultAdapter(app);
  const index = new VaultIndex({ vault: adapter }).ensureBuilt();

  return {
    app,
    adapter,
    index,
    events,
    notes,
    resolved,
    unresolved,
    /** Creates or replaces a note, then tells the index like Obsidian would. */
    writeNote(
      path,
      { content = "", tags = [], headings = [], links = {}, unresolvedLinks = {} } = {}
    ) {
      const file = new obsidian.TFile(path);
      const cache = {
        frontmatter: tags.length > 0 ? { tags } : {},
        tags: tags.map((tag) => ({ tag })),
        headings: headings.map((heading) => ({ heading }))
      };
      notes.set(path, { file, content, cache });
      if (Object.keys(links).length > 0) resolved[path] = links;
      else delete resolved[path];
      if (Object.keys(unresolvedLinks).length > 0) unresolved[path] = unresolvedLinks;
      else delete unresolved[path];
      index.updatePath(path);
      return file;
    },
    renameNote(oldPath, newPath) {
      const entry = notes.get(oldPath);
      notes.delete(oldPath);
      notes.set(newPath, { ...entry, file: new obsidian.TFile(newPath) });
      if (resolved[oldPath]) {
        resolved[newPath] = resolved[oldPath];
        delete resolved[oldPath];
      }
      if (unresolved[oldPath]) {
        unresolved[newPath] = unresolved[oldPath];
        delete unresolved[oldPath];
      }
      index.renamePath(oldPath, newPath);
      index.updatePath(newPath);
    },
    deleteNote(path) {
      notes.delete(path);
      delete resolved[path];
      delete unresolved[path];
      index.removePath(path);
    },
    /** Incremental updates replayed on a fresh index for equivalence checks. */
    replayOnFreshIndex(actions) {
      const fresh = createVault();
      for (const action of actions) action(fresh);
      return fresh;
    }
  };
}

describe("VaultIndex link consistency", () => {
  it("follows the plan fixture through link removal, rename, and delete", () => {
    const vault = createVault();
    vault.writeNote("A.md", { links: { "B.md": 1 } });
    vault.writeNote("C.md", { links: { "B.md": 2 } });
    vault.writeNote("D.md", { links: { "A.md": 1 } });
    vault.writeNote("B.md", {});

    expect(vault.index.getBacklinkCounts("B.md")).toEqual([
      { path: "C.md", count: 2 },
      { path: "A.md", count: 1 }
    ]);

    // C removes the B link.
    vault.writeNote("C.md", { links: { "B.md": 1 } });
    expect(vault.index.getBacklinkCounts("B.md")).toEqual([
      { path: "A.md", count: 1 },
      { path: "C.md", count: 1 }
    ]);

    // C is renamed to E: the backlink index must follow the source path.
    vault.renameNote("C.md", "E.md");
    expect(vault.index.getBacklinkCounts("B.md")).toEqual([
      { path: "A.md", count: 1 },
      { path: "E.md", count: 1 }
    ]);

    // B is deleted: nobody may still report it as a backlink target.
    vault.deleteNote("B.md");
    expect(vault.index.getBacklinkCounts("B.md")).toEqual([]);
    expect(vault.index.getMetadata("B.md")).toBeUndefined();

    // Obsidian refreshes the sources whose links now dangle; until it does, the
    // source's own link table still lists the deleted target (same as before).
    vault.writeNote("E.md", {});
    vault.writeNote("A.md", {});
    expect(vault.index.getOutgoingCounts("E.md")).toEqual([]);
    expect(vault.index.getBacklinkCounts("B.md")).toEqual([]);
  });

  it("drops backlinks that pointed at a deleted target", () => {
    const vault = createVault();
    vault.writeNote("Target.md", {});
    vault.writeNote("Source.md", { links: { "Target.md": 3 } });

    expect(vault.index.getBacklinkCounts("Target.md")).toEqual([{ path: "Source.md", count: 3 }]);

    vault.deleteNote("Target.md");

    expect(vault.index.getBacklinkCounts("Target.md")).toEqual([]);
    expect(vault.index.getMetadata("Target.md")).toBeUndefined();
  });

  it("follows links when the target is renamed", () => {
    const vault = createVault();
    vault.writeNote("Target.md", {});
    vault.writeNote("Source.md", { links: { "Target.md": 2 } });

    // Obsidian rewrites resolvedLinks for the renamed file and updates the
    // source's link table when the target path changes.
    vault.renameNote("Target.md", "Renamed.md");
    vault.writeNote("Source.md", { links: { "Renamed.md": 2 } });

    expect(vault.index.getBacklinkCounts("Renamed.md")).toEqual([{ path: "Source.md", count: 2 }]);
    expect(vault.index.getBacklinkCounts("Target.md")).toEqual([]);
  });

  it("keeps unresolved links and removes them when they resolve", () => {
    const vault = createVault();
    vault.writeNote("Note.md", { unresolvedLinks: { Missing: 1 } });

    expect(vault.index.getUnresolvedCounts("Note.md")).toEqual([{ path: "Missing", count: 1 }]);

    vault.writeNote("Missing.md", {});
    vault.writeNote("Note.md", { links: { "Missing.md": 1 } });

    expect(vault.index.getUnresolvedCounts("Note.md")).toEqual([]);
    expect(vault.index.getBacklinkCounts("Missing.md")).toEqual([{ path: "Note.md", count: 1 }]);
  });
});

describe("VaultIndex equivalence: incremental vs full rebuild", () => {
  it("matches a fresh full rebuild after a sequence of vault changes", () => {
    const actions = [
      (vault) => vault.writeNote("A.md", { tags: ["#one"], links: { "B.md": 1 } }),
      (vault) => vault.writeNote("B.md", { headings: ["Heading"] }),
      (vault) => vault.writeNote("C.md", { unresolvedLinks: { Missing: 1 } }),
      (vault) => vault.writeNote("A.md", { tags: ["#two"], links: { "C.md": 2 } }),
      (vault) => vault.renameNote("C.md", "Renamed.md"),
      (vault) => vault.writeNote("D.md", { links: { "B.md": 1, "Renamed.md": 1 } }),
      (vault) => vault.deleteNote("A.md"),
      (vault) => vault.writeNote("B.md", { tags: ["#b"], headings: ["Renamed heading"] })
    ];

    const incremental = createVault();
    for (const action of actions) action(incremental);
    const fresh = createVault();
    for (const action of actions) action(fresh);
    fresh.index.rebuild();

    const snapshot = (index) => ({
      metadata: [...index.metadata.entries()].sort(),
      outgoing: [...index.outgoing.entries()].map(([k, v]) => [k, [...v.entries()].sort()]).sort(),
      backlinks: [...index.backlinks.entries()]
        .map(([k, v]) => [k, [...v.entries()].sort()])
        .sort(),
      unresolved: [...index.unresolved.entries()]
        .map(([k, v]) => [k, [...v.entries()].sort()])
        .sort()
    });

    expect(snapshot(incremental.index)).toEqual(snapshot(fresh.index));
  });
});

describe("VaultIndex handles the synthetic vault", () => {
  it("answers searches and backlink lookups without reading content for the index", () => {
    const vault = createSyntheticVault(obsidian.TFile, { notes: 500 });
    const index = new VaultIndex({ vault: new VaultAdapter(vault.app) });

    index.rebuild();

    expect(index.size).toBe(500);
    expect(vault.readCounts.size).toBe(0);
    expect(index.candidatesForTerms(["alpha"]).length).toBeGreaterThan(0);
  });
});
