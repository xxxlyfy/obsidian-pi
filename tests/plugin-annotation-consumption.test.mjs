import { describe, expect, it, vi } from "vitest";
import { STRINGS } from "../src/shared/strings.mjs";

const obsidian = vi.hoisted(() => {
  class TFile {
    constructor(path = "", extension = "md") {
      this.path = path;
      this.extension = extension;
    }
  }
  class Notice {
    constructor(message) {
      Notice.messages.push(String(message));
    }
  }
  Notice.messages = [];
  return { Notice, TFile };
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
  Notice: obsidian.Notice,
  Plugin: class {},
  PluginSettingTab: class {},
  Setting: class {},
  SuggestModal: class {},
  TFile: obsidian.TFile,
  normalizePath: (value) => value,
  setIcon: () => {}
}));

const { PiAgentPlugin } = await import("../src/plugin/PiAgentPlugin.mjs");

function createPlugin({ files = {}, currentFile, annotationsByPath = {} } = {}) {
  const deletedPaths = [];
  const replacedPaths = [];
  return {
    annotationController: { cancelPick: vi.fn() },
    app: {
      vault: {
        getAbstractFileByPath: (path) => files[path]
      }
    },
    getCurrentContextFile: () => currentFile,
    getAnnotationsForContext: vi.fn(async (path) => annotationsByPath[path] ?? []),
    annotationStore: {
      deletePath: (path) => deletedPaths.push(path),
      list: (path) => annotationsByPath[path] ?? [],
      replacePath: (path, annotations) => replacedPaths.push({ path, annotations })
    },
    deletedPaths,
    replacedPaths
  };
}

function consumeAnnotations(plugin, sourcePath) {
  return PiAgentPlugin.prototype.consumeAnnotationsForPrompt.call(plugin, sourcePath);
}

describe("PiAgentPlugin annotation consumption", () => {
  it("does not fall back to the current note when an explicit source path is gone", async () => {
    const plugin = createPlugin({
      currentFile: new obsidian.TFile("B.md", "md"),
      annotationsByPath: { "B.md": [{ id: "b1", path: "B.md" }] }
    });
    obsidian.Notice.messages.length = 0;

    await expect(consumeAnnotations(plugin, "A.md")).resolves.toEqual([]);

    expect(plugin.deletedPaths).toEqual([]);
    expect(plugin.getAnnotationsForContext).not.toHaveBeenCalled();
    expect(obsidian.Notice.messages.join(" ")).toContain(STRINGS.plugin.annotationNoteGone);
  });

  it("treats non-markdown explicit source paths as missing", async () => {
    const plugin = createPlugin({
      files: { "A.png": new obsidian.TFile("A.png", "png") },
      currentFile: new obsidian.TFile("B.md", "md"),
      annotationsByPath: { "B.md": [{ id: "b1", path: "B.md" }] }
    });
    obsidian.Notice.messages.length = 0;

    await expect(consumeAnnotations(plugin, "A.png")).resolves.toEqual([]);

    expect(plugin.deletedPaths).toEqual([]);
    expect(plugin.getAnnotationsForContext).not.toHaveBeenCalled();
  });

  it("consumes annotations for the explicit source path when it still exists", async () => {
    const explicit = [{ id: "a1", path: "A.md" }];
    const plugin = createPlugin({
      files: { "A.md": new obsidian.TFile("A.md", "md") },
      currentFile: new obsidian.TFile("B.md", "md"),
      annotationsByPath: { "A.md": explicit, "B.md": [{ id: "b1", path: "B.md" }] }
    });

    await expect(consumeAnnotations(plugin, "A.md")).resolves.toEqual(explicit);

    expect(plugin.deletedPaths).toEqual(["A.md"]);
  });

  it("falls back to the current note only when no source path is provided", async () => {
    const current = [{ id: "b1", path: "B.md" }];
    const plugin = createPlugin({
      currentFile: new obsidian.TFile("B.md", "md"),
      annotationsByPath: { "B.md": current }
    });

    await expect(consumeAnnotations(plugin, undefined)).resolves.toEqual(current);

    expect(plugin.deletedPaths).toEqual(["B.md"]);
  });

  it("restores consumed annotations only for notes that still exist", () => {
    const plugin = createPlugin({
      files: { "B.md": new obsidian.TFile("B.md", "md") }
    });

    PiAgentPlugin.prototype.restoreConsumedAnnotations.call(plugin, [
      { id: "a1", path: "A.md" },
      { id: "b1", path: "B.md" }
    ]);

    expect(plugin.replacedPaths).toEqual([
      { path: "B.md", annotations: [{ id: "b1", path: "B.md" }] }
    ]);
  });

  it("skips restoring consumed annotations for non-markdown paths", () => {
    const plugin = createPlugin({
      files: { "A.png": new obsidian.TFile("A.png", "png") }
    });

    PiAgentPlugin.prototype.restoreConsumedAnnotations.call(plugin, [{ id: "a1", path: "A.png" }]);

    expect(plugin.replacedPaths).toEqual([]);
  });
});
