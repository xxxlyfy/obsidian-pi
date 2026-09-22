import { describe, expect, it, vi } from "vitest";

const obsidian = vi.hoisted(() => {
  class TFile {
    constructor(path, content = "") {
      this.path = path;
      this.name = path.split("/").pop();
      this.basename = this.name.replace(/\.md$/i, "");
      this.extension = path.split(".").pop();
      this.stat = { mtime: 42 };
      this.content = content;
    }
  }
  return { TFile };
});

vi.mock("obsidian", () => ({ TFile: obsidian.TFile }));

const { VaultAdapter } = await import("../src/obsidian/vault-adapter.mjs");
const { WorkspaceAdapter } = await import("../src/obsidian/workspace-adapter.mjs");
const { EditorAdapter } = await import("../src/obsidian/editor-adapter.mjs");

function createApp({ files = {}, resolved = {}, unresolved = {} } = {}) {
  const byPath = new Map(Object.entries(files));
  const app = {
    vault: {
      adapter: { getBasePath: () => "/vault" },
      configDir: ".obsidian",
      getMarkdownFiles: () => [...byPath.values()].filter((file) => file.extension === "md"),
      getAbstractFileByPath: (path) => byPath.get(path),
      cachedRead: vi.fn(async (file) => `${file.content}-cached`),
      read: vi.fn(async (file) => file.content),
      delete: vi.fn(async () => {}),
      on: vi.fn((eventName, callback) => ({ eventName, callback }))
    },
    metadataCache: {
      getFileCache: (file) => file.cache,
      resolvedLinks: resolved,
      unresolvedLinks: unresolved,
      getFirstLinkpathDest: (linkpath) => byPath.get(`${linkpath}.md`),
      on: vi.fn((eventName, callback) => ({ eventName, callback }))
    },
    workspace: {
      getActiveFile: () => app.workspace.activeFile,
      activeEditor: undefined,
      getLeavesOfType: vi.fn(() => []),
      getLeaf: vi.fn(() => ({ openFile: vi.fn(async () => {}) })),
      on: vi.fn((eventName, callback) => ({ eventName, callback })),
      activeFile: undefined
    }
  };
  return app;
}

describe("VaultAdapter", () => {
  it("lists, describes, reads, and deletes notes by path", async () => {
    const file = new obsidian.TFile("Notes/A.md", "body");
    file.cache = {
      frontmatter: { aliases: ["Alpha"], tags: ["one"] },
      tags: [{ tag: "#two" }],
      headings: [{ heading: "H1" }]
    };
    const app = createApp({ files: { "Notes/A.md": file } });
    const vault = new VaultAdapter(app);

    expect(vault.getBasePath()).toBe("/vault");
    expect(vault.getConfigDir()).toBe(".obsidian");
    expect(vault.listNotes()).toEqual([{ path: "Notes/A.md", title: "A", mtime: 42 }]);
    expect(vault.note("Notes/A.md")).toMatchObject({ path: "Notes/A.md" });
    expect(vault.note("Missing.md")).toBeUndefined();
    expect(vault.exists("Notes/A.md")).toBe(true);
    await expect(vault.read("Notes/A.md")).resolves.toBe("body-cached");
    await expect(vault.read("Notes/A.md", 2)).resolves.toBe("bo\n...[truncated]");
    await expect(vault.readFresh("Notes/A.md")).resolves.toBe("body");
    await expect(vault.read("Missing.md")).rejects.toThrow("File not found");
    await expect(vault.delete("Missing.md")).rejects.toThrow("File not found");
    await expect(vault.delete("Notes/A.md")).resolves.toBeUndefined();
    expect(app.vault.delete).toHaveBeenCalledOnce();
  });

  it("normalizes metadata from the cache", () => {
    const file = new obsidian.TFile("Notes/A.md");
    file.cache = {
      frontmatter: { aliases: ["Alpha"], tags: ["one", "two"] },
      tags: [{ tag: "#three" }],
      headings: Array.from({ length: 25 }, (_, index) => ({ heading: `H${index}` }))
    };
    const vault = new VaultAdapter(createApp({ files: { "Notes/A.md": file } }));

    const metadata = vault.getMetadata("Notes/A.md");

    expect(metadata.tags.sort()).toEqual(["#three", "one", "two"]);
    expect(metadata.aliases).toEqual(["Alpha"]);
    expect(metadata.headings).toHaveLength(20);
    expect(metadata.frontmatter).toEqual({ aliases: ["Alpha"], tags: ["one", "two"] });
    expect(vault.getMetadata("Missing.md")).toEqual({
      tags: [],
      aliases: [],
      headings: [],
      frontmatter: {}
    });
  });

  it("exposes link indexes, link resolution, and event refs", () => {
    const vault = new VaultAdapter(
      createApp({
        files: { "Notes/A.md": new obsidian.TFile("Notes/A.md") },
        resolved: { "Notes/A.md": { "Notes/B.md": 2 } },
        unresolved: { "Notes/A.md": { Missing: 1 } }
      })
    );

    expect(vault.resolvedLinks()).toEqual({ "Notes/A.md": { "Notes/B.md": 2 } });
    expect(vault.unresolvedLinks()).toEqual({ "Notes/A.md": { Missing: 1 } });
    expect(vault.resolveLinkPath("Notes/A")).toBe("Notes/A.md");
    expect(vault.resolveLinkPath("Nope")).toBeUndefined();
    expect(vault.on("create", () => {}).eventName).toBe("create");
    expect(vault.onMetadataChanged(() => {}).eventName).toBe("changed");
    expect(vault.onMetadataResolved(() => {}).eventName).toBe("resolved");
  });
});

describe("WorkspaceAdapter", () => {
  it("reports the active markdown note and the current selection", () => {
    const app = createApp();
    app.workspace.activeFile = new obsidian.TFile("Notes/A.md");
    app.workspace.activeEditor = {
      file: app.workspace.activeFile,
      editor: { getSelection: () => "picked" }
    };
    const workspace = new WorkspaceAdapter(app);

    expect(workspace.activeNotePath()).toBe("Notes/A.md");
    expect(workspace.activeSelection()).toBe("picked");

    app.workspace.activeFile = { path: "image.png", extension: "png" };
    expect(workspace.activeNotePath()).toBeUndefined();

    app.workspace.activeFile = undefined;
    app.workspace.activeEditor = undefined;
    expect(workspace.activeSelection()).toBe("");
  });

  it("opens a note and forwards workspace events", async () => {
    const app = createApp({ files: { "Notes/A.md": new obsidian.TFile("Notes/A.md") } });
    const workspace = new WorkspaceAdapter(app);

    await workspace.openNote("Notes/A.md");

    const leaf = app.workspace.getLeaf.mock.results[0].value;
    expect(leaf.openFile).toHaveBeenCalledOnce();
    expect(workspace.on("file-open", () => {}).eventName).toBe("file-open");
  });
});

describe("EditorAdapter", () => {
  it("prefers the active editor, then any open markdown leaf, then nothing", () => {
    const app = createApp();
    const editor = new EditorAdapter(app);

    app.workspace.activeEditor = {
      file: { path: "Notes/A.md" },
      editor: { getValue: () => "live" }
    };
    expect(editor.valueForOpenNote("Notes/A.md")).toBe("live");
    expect(editor.valueForOpenNote("Notes/B.md")).toBeUndefined();

    app.workspace.activeEditor = undefined;
    app.workspace.getLeavesOfType = () => [
      { view: { file: { path: "Notes/B.md" }, editor: { getValue: () => "leaf value" } } }
    ];
    expect(editor.valueForOpenNote("Notes/B.md")).toBe("leaf value");
    expect(editor.valueForOpenNote("Notes/A.md")).toBeUndefined();
  });
});
