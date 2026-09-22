import { describe, expect, it, vi } from "vitest";

const obsidian = vi.hoisted(() => {
  class TFile {
    constructor(path) {
      this.path = path;
      this.name = path.split("/").pop();
      this.basename = this.name.replace(/\.md$/i, "");
      this.extension = path.split(".").pop();
    }
  }
  return { TFile };
});

vi.mock("obsidian", () => ({
  Component: class {},
  FuzzySuggestModal: class {},
  ItemView: class {},
  MarkdownRenderChild: class {},
  MarkdownRenderer: { render: vi.fn() },
  MarkdownView: class {},
  Menu: class {},
  Modal: class {},
  Notice: class {},
  Plugin: class {},
  PluginSettingTab: class {},
  Setting: class {},
  SuggestModal: class {},
  TFile: obsidian.TFile,
  normalizePath: (value) => value,
  setIcon: () => {}
}));

const { AnnotationStore } = await import("../src/annotations/annotation-store.mjs");
const { ContextBuilder } = await import("../src/context/context-builder.mjs");
const { VaultGraph } = await import("../src/context/vault-graph.mjs");
const { DEFAULT_SETTINGS } = await import("../src/plugin/settings.mjs");

const ACTIVE_CONTENT = [
  "Alpha introduction paragraph.",
  "",
  "Some exact target text here.",
  "",
  "Tail paragraph mentioning alpha again."
].join("\n");

function createVaultApp(noteSources) {
  const files = {};
  const readCounts = {};
  for (const [path, source] of Object.entries(noteSources)) {
    files[path] = {
      file: new obsidian.TFile(path),
      content: source.content,
      cache: {
        frontmatter: source.frontmatter ?? {},
        tags: source.tags ?? [],
        headings: source.headings ?? []
      }
    };
  }

  const resolvedLinks = {
    "Back.md": { "Active.md": 2, "Other.md": 1 },
    "Active.md": { "Other.md": 1 }
  };
  const app = {
    vault: {
      getMarkdownFiles: () => Object.values(files).map((entry) => entry.file),
      getAbstractFileByPath: (path) => files[path]?.file,
      cachedRead: async (file) => {
        readCounts[file.path] = (readCounts[file.path] ?? 0) + 1;
        return files[file.path].content;
      },
      adapter: { getBasePath: () => "/vault" }
    },
    metadataCache: {
      getFileCache: (file) => files[file.path]?.cache,
      resolvedLinks,
      unresolvedLinks: { "Active.md": { "Missing note": 1 } },
      getFirstLinkpathDest: (linkpath) => files[`${linkpath}.md`]?.file ?? files[linkpath]?.file
    },
    workspace: { getActiveFile: () => files["Active.md"].file }
  };

  return { app, readCounts };
}

function noteSources() {
  return {
    "Active.md": {
      content: ACTIVE_CONTENT,
      frontmatter: { tags: ["pi"] },
      tags: [{ tag: "#pi" }],
      headings: [{ heading: "Alpha introduction" }]
    },
    "Back.md": { content: "Backlink to [[Active]] with alpha mention.", tags: [{ tag: "#link" }] },
    "Other.md": { content: "Another alpha note.", tags: [] },
    "Noise.md": { content: "Nothing relevant here.", tags: [] },
    "Notes/Nested.md": { content: "Nested note without the query term.", tags: [] }
  };
}

function createWorkspace() {
  const { app, readCounts } = createVaultApp(noteSources());
  const settings = { ...DEFAULT_SETTINGS };
  const graph = new VaultGraph(app, settings, () => app.workspace.getActiveFile());
  const annotationStore = new AnnotationStore();
  const from = ACTIVE_CONTENT.indexOf("exact target");
  const annotation = annotationStore.create({
    path: "Active.md",
    intent: "change",
    context: "Make this clearer",
    quote: "exact target",
    prefix: "",
    suffix: "",
    range: {
      from,
      to: from + "exact target".length,
      start: { line: 2, ch: 5 },
      end: { line: 2, ch: 17 }
    },
    targetKind: "selection",
    status: "attached"
  });
  const contextBuilder = new ContextBuilder(
    graph,
    settings,
    "Bundled",
    "/vault",
    () => [],
    (path) => annotationStore.list(path)
  );

  return { app, graph, annotationStore, contextBuilder, annotation, readCounts };
}

describe("golden path 5: active note + selection + annotation -> context -> prompt", () => {
  it("attaches note content, selection, annotations, and linked notes to the formatted prompt", async () => {
    const { annotationStore, contextBuilder, annotation } = createWorkspace();
    const annotations = annotationStore.reanchorPath("Active.md", ACTIVE_CONTENT);

    const context = await contextBuilder.build("Explain this", "Some exact target", {
      activeNotePath: "Active.md",
      includeActiveNote: true,
      annotations
    });

    expect(annotation).toMatchObject({ status: "attached", id: expect.any(String) });
    expect(context.userPrompt).toBe("Explain this");
    expect(context.activeNote).toMatchObject({
      path: "Active.md",
      title: "Active",
      content: ACTIVE_CONTENT,
      selection: "Some exact target",
      tags: ["#pi", "pi"],
      aliases: [],
      headings: ["Alpha introduction"]
    });
    expect(context.activeNote.backlinks).toEqual([
      { path: "Back.md", display: "Back", count: 2, excerpt: expect.any(String) }
    ]);
    expect(context.activeNote.outgoingLinks).toEqual([
      { path: "Other.md", display: "Other", count: 1 }
    ]);
    expect(context.activeNote.unresolvedLinks).toEqual([
      { path: "Missing note", display: "Missing note", count: 1 }
    ]);
    expect(context.linkedNeighborhood.map((note) => note.path)).toEqual(["Other.md", "Back.md"]);
    expect(context.annotations).toEqual([
      expect.objectContaining({ path: "Active.md", status: "attached", intent: "change" })
    ]);
    expect(context.inspection).toMatchObject({
      activeNote: {
        path: "Active.md",
        hasSelection: true,
        selectionLength: "Some exact target".length,
        backlinkCount: 1,
        outgoingLinkCount: 1,
        unresolvedLinkCount: 1,
        tagCount: 2,
        headingCount: 1
      },
      activeNoteStatus: "attached",
      annotations: { total: 1, attached: 1, detached: 0 }
    });

    const formatted = contextBuilder.formatPrompt("Explain this", context);

    expect(formatted.startsWith("## User prompt\nExplain this")).toBe(true);
    expect(formatted).toContain("## Active note");
    expect(formatted).toContain('"path": "Active.md"');
    expect(formatted).toContain('"selection": "Some exact target"');
    expect(formatted).toContain("Alpha introduction paragraph.");
    expect(formatted).toContain("## Annotations");
    expect(formatted).toContain('"request": "Make this clearer"');
    expect(formatted).toContain('"quote": "exact target"');
    expect(formatted).toContain("## Linked neighborhood");
    expect(formatted).toContain("Another alpha note.");
    expect(formatted).toContain("Backlink to [[Active]] with alpha mention.");
  });

  it("excludes the active note and its annotations when the composer note badge is off", async () => {
    const { contextBuilder, annotationStore } = createWorkspace();
    const annotations = annotationStore.reanchorPath("Active.md", ACTIVE_CONTENT);

    const context = await contextBuilder.build("Explain this", "selection", {
      activeNotePath: "Active.md",
      includeActiveNote: false,
      annotations
    });

    expect(context.activeNote).toBeUndefined();
    expect(context.linkedNeighborhood).toEqual([]);
    // The explicit snapshot still wins: the caller decides which annotations to
    // send, and the view passes an empty list when it consumed none.
    expect(context.annotations).toHaveLength(1);
    expect(context.inspection.activeNoteStatus).toBe("excluded with the composer note badge");
  });
});

describe("context search characterization", () => {
  it("scans every markdown file and ranks content matches today", async () => {
    const { graph, readCounts } = createWorkspace();

    const results = await graph.searchNotes("alpha");

    expect(results.map((result) => [result.path, result.score])).toEqual([
      ["Active.md", 2],
      ["Back.md", 1],
      ["Other.md", 1]
    ]);
    expect(results[0]).toMatchObject({
      title: "Active",
      tags: ["#pi", "pi"],
      excerpt: expect.stringContaining("Alpha introduction paragraph.")
    });
    // Full-vault read is the pre-refactor baseline. Phase 5 must only read the
    // metadata-filtered candidates instead of every markdown file.
    expect(Object.keys(readCounts).sort()).toEqual([
      "Active.md",
      "Back.md",
      "Noise.md",
      "Notes/Nested.md",
      "Other.md"
    ]);
    expect(readCounts["Noise.md"]).toBe(1);
  });

  it("returns no results for a too-short query", async () => {
    const { graph } = createWorkspace();

    await expect(graph.searchNotes("a")).resolves.toEqual([]);
  });

  it("attaches /search results to the prompt through the command attachment", async () => {
    const { contextBuilder } = createWorkspace();

    const context = await contextBuilder.build("/search alpha", "", {
      activeNotePath: "Active.md",
      includeActiveNote: false,
      annotations: []
    });

    expect(context.attachments).toEqual([
      {
        type: "command",
        label: "/search",
        content: [
          expect.objectContaining({ path: "Active.md" }),
          expect.objectContaining({ path: "Back.md" }),
          expect.objectContaining({ path: "Other.md" })
        ]
      }
    ]);
    const formatted = contextBuilder.formatPrompt("/search alpha", context);
    expect(formatted).toContain("## Explicit prompt attachments");
    expect(formatted).toContain('"label": "/search"');
  });

  it("looks up backlinks from resolvedLinks and reads each source for an excerpt", async () => {
    const { graph, readCounts } = createWorkspace();

    const backlinks = await graph.getBacklinks("Active.md");

    expect(backlinks).toEqual([
      { path: "Back.md", display: "Back", count: 2, excerpt: expect.stringContaining("Backlink") }
    ]);
    expect(readCounts["Back.md"]).toBe(1);
  });

  it("lists tag matches and folder summaries from the same full-scan path", async () => {
    const { graph } = createWorkspace();

    expect(await graph.getNotesByTag("#pi")).toEqual([
      expect.objectContaining({ path: "Active.md", tags: ["#pi", "pi"] })
    ]);
    expect(await graph.getFolderSummary("Notes")).toEqual([
      expect.objectContaining({ path: "Notes/Nested.md", title: "Nested", score: 1 })
    ]);
    expect(await graph.getFolderSummary(".")).toEqual([]);
  });
});
