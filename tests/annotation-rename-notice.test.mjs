/**
 * What the plugin tells the user after a rename could not take every annotation.
 *
 * `AnnotationStore.renamePath()` now moves whatever fits and keeps the rest, so the
 * plugin's job is to report the difference: nothing when every record followed, and an
 * actionable message naming the retained count when the destination note is already at
 * its annotation ceiling. `describeAnnotationRename()` is the one place that wording
 * lives, `reportOrphanedAnnotations()` is what surfaces records whose note is gone, and
 * both hang off the real `PiAgentPlugin.prototype` with the real `AnnotationStore`.
 *
 * Only Obsidian and the plugin's own service construction are stubbed: the store, the
 * rename handler, and the notices under test are the production ones.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/** Test-owned state the hoisted module mock reads. */
const harness = vi.hoisted(() => ({ notices: [] }));

vi.mock("obsidian", () => {
  class ObsidianBase {}
  return {
    Component: ObsidianBase,
    FuzzySuggestModal: ObsidianBase,
    ItemView: ObsidianBase,
    MarkdownRenderChild: ObsidianBase,
    MarkdownRenderer: { render: vi.fn().mockResolvedValue(undefined) },
    MarkdownView: ObsidianBase,
    Menu: ObsidianBase,
    Modal: ObsidianBase,
    Notice: class Notice {
      constructor(message) {
        harness.notices.push(String(message));
      }
    },
    Platform: { isDesktopApp: true },
    Plugin: ObsidianBase,
    PluginSettingTab: ObsidianBase,
    Setting: ObsidianBase,
    SuggestModal: ObsidianBase,
    TFile: class TFile {
      constructor(path) {
        this.path = path;
      }
    },
    addIcon: vi.fn(),
    getLanguage: () => "en",
    normalizePath: (value) => value,
    setIcon: vi.fn()
  };
});

const { PiAgentPlugin } = await import("../src/plugin/PiAgentPlugin.mjs");
const { ANNOTATION_LIMITS } = await import("../src/annotations/annotation-model.mjs");
const { AnnotationStore } = await import("../src/annotations/annotation-store.mjs");

const anchor = {
  quote: "target",
  prefix: "before ",
  suffix: " after",
  range: { from: 7, to: 13, start: { line: 0, ch: 7 }, end: { line: 0, ch: 13 } }
};

const record = (path, id, context = "Rewrite this") => ({
  id,
  path,
  intent: "change",
  context,
  targetKind: "selection",
  ...anchor
});

const fillPath = (path, count) =>
  Array.from({ length: count }, (_, index) => record(path, `${path}:n${index}`));

afterEach(() => {
  harness.notices.length = 0;
});

/**
 * A plugin object with the real prototype and the real annotation store. Every vault
 * event the rename handler registers is captured so the test can drive it with the
 * same arguments Obsidian passes.
 */
function createHarness({ files = [], annotationData } = {}) {
  const vaultFiles = new Map(files.map((path) => [path, { path, extension: "md" }]));
  const events = new Map();
  const plugin = Object.create(PiAgentPlugin.prototype);
  plugin.app = {
    vault: {
      getAbstractFileByPath: (path) => vaultFiles.get(path),
      on: (name, handler) => {
        events.set(name, handler);
        return { name };
      }
    }
  };
  plugin.annotationStore = new AnnotationStore(
    annotationData ?? { schemaVersion: 1, annotations: {} }
  );
  plugin.registerEvent = vi.fn();

  plugin.app.vault.on("rename", (file, oldPath) => plugin.handleVaultRename(file, oldPath));
  return {
    plugin,
    events,
    vaultFiles,
    rename: (from, to) => {
      const file = { path: to, extension: "md" };
      vaultFiles.set(to, file);
      vaultFiles.delete(from);
      plugin.handleVaultRename(file, from);
    },
    notices: () => harness.notices
  };
}

describe("the plugin's rename handler reports what the store did", () => {
  it("says nothing when every annotation followed the note", () => {
    const harness = createHarness({
      annotationData: {
        schemaVersion: 1,
        annotations: { "Old.md": [record("Old.md", "a")] }
      }
    });

    harness.rename("Old.md", "New.md");

    expect(harness.notices()).toEqual([]);
    expect(harness.plugin.annotationStore.list("New.md")).toHaveLength(1);
    expect(harness.plugin.annotationStore.list("Old.md")).toEqual([]);
  });

  it("reports the records that stayed when the destination is at its ceiling", () => {
    const harness = createHarness({
      annotationData: {
        schemaVersion: 1,
        annotations: {
          "Old.md": [record("Old.md", "a"), record("Old.md", "b")],
          "New.md": fillPath("New.md", ANNOTATION_LIMITS.perPath)
        }
      }
    });

    harness.rename("Old.md", "New.md");

    const messages = harness.notices();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("2 annotations");
    expect(messages[0]).toContain(`${ANNOTATION_LIMITS.perPath} annotations`);
    expect(messages[0]).toContain("rename again");
    // The message describes a retention, not a loss: the records are still there.
    expect(harness.plugin.annotationStore.list("Old.md")).toHaveLength(2);
  });

  it("reports a partial move with both counts", () => {
    const harness = createHarness({
      annotationData: {
        schemaVersion: 1,
        annotations: {
          "Old.md": [record("Old.md", "a"), record("Old.md", "b"), record("Old.md", "c")],
          "New.md": fillPath("New.md", ANNOTATION_LIMITS.perPath - 1)
        }
      }
    });

    harness.rename("Old.md", "New.md");

    const messages = harness.notices();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Moved 1 annotation");
    expect(messages[0]).toContain("2 annotations stayed");
    expect(harness.plugin.annotationStore.list("New.md")).toHaveLength(ANNOTATION_LIMITS.perPath);
  });

  it("reports a duplicate that did not move twice", () => {
    const harness = createHarness({
      annotationData: {
        schemaVersion: 1,
        annotations: {
          "Old.md": [record("Old.md", "shared")],
          "New.md": [record("New.md", "shared")]
        }
      }
    });

    harness.rename("Old.md", "New.md");

    const messages = harness.notices();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("not stored twice");
    expect(harness.plugin.annotationStore.list("New.md")).toHaveLength(1);
  });

  it("stays silent for a note with no annotations and for a non-markdown file", () => {
    const harness = createHarness({
      annotationData: { schemaVersion: 1, annotations: { "Other.md": [record("Other.md", "x")] } }
    });

    harness.rename("Old.md", "New.md");
    harness.plugin.handleVaultRename({ path: "image.png", extension: "png" }, "image.png");

    expect(harness.notices()).toEqual([]);
  });
});

describe("the plugin's startup report for annotations whose note is gone", () => {
  it("names the count when records no longer have a note", () => {
    const harness = createHarness({
      files: ["New.md"],
      annotationData: {
        schemaVersion: 1,
        annotations: {
          "Old.md": [record("Old.md", "a"), record("Old.md", "b")],
          "New.md": fillPath("New.md", ANNOTATION_LIMITS.perPath)
        }
      }
    });
    harness.plugin.annotationStore.renamePath("Old.md", "New.md");

    harness.plugin.reportOrphanedAnnotations();

    const messages = harness.notices();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("2 annotations");
    expect(messages[0]).toContain("no longer in the vault");
    // Reported, never deleted: the note may only be missing while the vault indexes.
    expect(harness.plugin.annotationStore.list("Old.md")).toHaveLength(2);
  });

  it("says nothing when every annotated note still exists", () => {
    const harness = createHarness({
      files: ["Here.md"],
      annotationData: { schemaVersion: 1, annotations: { "Here.md": [record("Here.md", "a")] } }
    });

    harness.plugin.reportOrphanedAnnotations();

    expect(harness.notices()).toEqual([]);
  });
});
