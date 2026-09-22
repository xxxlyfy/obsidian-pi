import { describe, expect, it, vi } from "vitest";

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

const { AnnotationStore } = await import("../src/annotations/annotation-store.mjs");
const { ContextService } = await import("../src/context/context-service.mjs");
const { VaultGraph } = await import("../src/context/vault-graph.mjs");
const { VaultAdapter } = await import("../src/obsidian/vault-adapter.mjs");
const { WorkspaceAdapter } = await import("../src/obsidian/workspace-adapter.mjs");
const { DEFAULT_SETTINGS } = await import("../src/plugin/settings.mjs");

function createVault(sources) {
  const notes = new Map();
  const readCounts = new Map();
  for (const [path, source] of Object.entries(sources)) {
    notes.set(path, {
      file: new obsidian.TFile(path),
      content: source.content ?? "",
      cache: {
        frontmatter: source.frontmatter ?? {},
        tags: source.tags ?? [],
        headings: source.headings ?? []
      }
    });
  }
  const app = {
    vault: {
      adapter: { getBasePath: () => "/vault" },
      getMarkdownFiles: () => [...notes.values()].map((entry) => entry.file),
      getAbstractFileByPath: (path) => notes.get(path)?.file,
      cachedRead: async (file) => {
        readCounts.set(file.path, (readCounts.get(file.path) ?? 0) + 1);
        return notes.get(file.path)?.content ?? "";
      },
      read: async (file) => notes.get(file.path)?.content ?? "",
      on: () => ({})
    },
    metadataCache: {
      getFileCache: (file) => notes.get(file.path)?.cache,
      resolvedLinks: {},
      unresolvedLinks: {},
      getFirstLinkpathDest: (linkpath) => notes.get(`${linkpath}.md`)?.file,
      on: () => ({})
    },
    workspace: {
      activeFile: notes.get("A.md")?.file,
      getActiveFile: () => app.workspace.activeFile,
      on: () => ({})
    }
  };
  return { app, notes, readCounts };
}

function createContext(sources, graphOverrides = {}) {
  const vault = createVault(sources);
  const adapter = new VaultAdapter(vault.app);
  const graph = new VaultGraph({
    vault: adapter,
    workspace: new WorkspaceAdapter(vault.app),
    settings: { ...DEFAULT_SETTINGS },
    ...graphOverrides
  });
  const annotations = new AnnotationStore();
  const context = new ContextService(
    graph,
    { ...DEFAULT_SETTINGS },
    "Bundled",
    "/vault",
    () => [],
    (path) => annotations.list(path)
  );
  return { ...vault, adapter, graph, context, annotations };
}

describe("context snapshot stability", () => {
  it("keeps the snapshot unchanged when the vault changes after the build", async () => {
    const { context, notes } = createContext({
      "A.md": {
        content: "Alpha body",
        frontmatter: { tags: ["one"], status: "draft" },
        tags: [{ tag: "#one" }],
        headings: [{ heading: "Alpha" }]
      }
    });

    const snapshot = await context.build("question", "selection", { activeNotePath: "A.md" });

    // Obsidian replaces the cache/content after the snapshot was built.
    const entry = notes.get("A.md");
    entry.content = "Totally different body";
    entry.cache.frontmatter.status = "published";
    entry.cache.frontmatter.tags.push("two");
    entry.cache.headings[0].heading = "Renamed heading";

    expect(snapshot.activeNote.content).toBe("Alpha body");
    expect(snapshot.activeNote.headings).toEqual(["Alpha"]);
    expect(snapshot.activeNote.frontmatter).toEqual({ tags: ["one"], status: "draft" });
    expect(snapshot.activeNote.tags).toEqual(["#one", "one"]);
  });

  it("resolves active note and selection once, even if the user switches mid-build", async () => {
    const { context, app, notes } = createContext({
      "A.md": { content: "A body" },
      "B.md": { content: "B body" }
    });

    // Switch notes during the first read: A must still win end to end.
    const originalRead = app.vault.cachedRead;
    let switched = false;
    app.vault.cachedRead = async (file) => {
      if (!switched) {
        switched = true;
        app.workspace.activeFile = notes.get("B.md").file;
      }
      return originalRead(file);
    };

    const snapshot = await context.build("question", "picked", {});

    expect(snapshot.activeNote.path).toBe("A.md");
    expect(snapshot.activeNote.content).toBe("A body");
    expect(snapshot.activeNote.selection).toBe("picked");
  });

  it("produces a fresh attachment list for every build", async () => {
    const { context } = createContext({
      "A.md": { content: "Alpha body" },
      "Attached.md": { content: "Attached body" }
    });

    const first = await context.build("see @Attached", "", { activeNotePath: "A.md" });
    const second = await context.build("see @Attached", "", { activeNotePath: "A.md" });

    expect(first.attachments).toEqual(second.attachments);
    expect(first.attachments[0].content).toEqual(second.attachments[0].content);
    expect(first.attachments[0].content).not.toBe(second.attachments[0].content);
  });
});

describe("search correctness", () => {
  function createSearchVault() {
    return createContext({
      "Notes/Alpha Note.md": { content: "Body about alpha and beta." },
      "Notes/标签笔记.md": { content: "这是一个关于烟油配方的中文笔记，包含丙二醇。" },
      "Notes/Punctuation.md": { content: "Contains C++ and node.js and a.b.c tokens." },
      "Notes/Ünïcode.md": { content: "Naïve café résumé Ünïcode." },
      "Notes/Empty.md": { content: "" }
    });
  }

  it("matches titles, paths, and content case-insensitively", async () => {
    const { graph } = createSearchVault();

    await expect(graph.searchNotes("ALPHA")).resolves.toEqual([
      expect.objectContaining({ path: "Notes/Alpha Note.md" })
    ]);
    await expect(graph.searchNotes("Notes/")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: expect.any(String) })])
    );
    await expect(graph.searchNotes("BODY")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "Notes/Alpha Note.md" })])
    );
  });

  it("finds CJK content without whitespace tokenization", async () => {
    const { graph } = createSearchVault();

    const results = await graph.searchNotes("烟油配方");

    expect(results.map((result) => result.path)).toEqual(["Notes/标签笔记.md"]);
  });

  it("treats regex and punctuation characters literally", async () => {
    const { graph } = createSearchVault();

    const results = await graph.searchNotes("C++");

    expect(results.map((result) => result.path)).toEqual(["Notes/Punctuation.md"]);
    expect(results[0].excerpt).toContain("C++");

    await expect(graph.searchNotes("a.b.c")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "Notes/Punctuation.md" })])
    );
  });

  it("handles accented unicode", async () => {
    const { graph } = createSearchVault();

    const results = await graph.searchNotes("naïve");

    expect(results.map((result) => result.path)).toEqual(["Notes/Ünïcode.md"]);
  });

  it("ignores empty and one-character queries and survives very long ones", async () => {
    const { graph } = createSearchVault();

    await expect(graph.searchNotes("")).resolves.toEqual([]);
    await expect(graph.searchNotes("   ")).resolves.toEqual([]);
    await expect(graph.searchNotes("a")).resolves.toEqual([]);
    await expect(graph.searchNotes("x".repeat(500))).resolves.toEqual([]);
    await expect(graph.searchNotes("alpha ".repeat(200))).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "Notes/Alpha Note.md" })])
    );
  });
});
