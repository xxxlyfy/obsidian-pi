/**
 * What leaves the annotation store when a note's annotations are sent to Pi.
 *
 * A prompt carries a bounded part of a batch (`promptRecords` records within
 * `promptCharacters`), but the consume step used to clear the note's whole batch, so
 * every record the prompt had no room for was destroyed without being sent. These
 * cases drive the real `AnnotationStore` and the real `PiAgentPlugin.prototype` and
 * check the property that matters: records leave the store only if they are in the
 * payload, and `selectPromptAnnotations()` is the same decision the prompt builder
 * makes, so the two cannot drift apart.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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
      constructor(path, extension = "md") {
        this.path = path;
        this.extension = extension;
      }
    },
    addIcon: vi.fn(),
    getLanguage: () => "en",
    normalizePath: (value) => value,
    setIcon: vi.fn()
  };
});

const { PiAgentPlugin } = await import("../src/plugin/PiAgentPlugin.mjs");
const { selectPromptAnnotations } = await import("../src/context/context-builder.mjs");
const { ContextBuilder } = await import("../src/context/context-builder.mjs");
const { ANNOTATION_LIMITS } = await import("../src/annotations/annotation-model.mjs");
const { AnnotationStore } = await import("../src/annotations/annotation-store.mjs");

const NOTE_PATH = "Note.md";
const NOTE_TEXT = "before target after";

/** One annotation record with an explicit, unique id. */
function record(id, overrides = {}) {
  const from = NOTE_TEXT.indexOf("target");
  return {
    id,
    path: NOTE_PATH,
    intent: "change",
    context: `request ${id}`,
    quote: "target",
    prefix: "before ",
    suffix: " after",
    range: { from, to: from + 6, start: { line: 0, ch: 7 }, end: { line: 0, ch: 13 } },
    targetKind: "selection",
    ...overrides
  };
}

/** The prompt's own view of a batch, through the real formatter. */
function promptCarries(annotations) {
  const builder = Object.create(ContextBuilder.prototype);
  return builder.formatAnnotations(annotations);
}

afterEach(() => {
  harness.notices.length = 0;
});

function createHarness(annotations) {
  const plugin = Object.create(PiAgentPlugin.prototype);
  plugin.app = {
    vault: {
      getAbstractFileByPath: (path) => (path === NOTE_PATH ? { path, extension: "md" } : undefined),
      read: async () => NOTE_TEXT,
      on: () => ({})
    },
    workspace: {
      activeEditor: undefined,
      getLeavesOfType: () => [],
      getActiveFile: () => ({ path: NOTE_PATH, extension: "md" })
    }
  };
  plugin.annotationStore = new AnnotationStore({ schemaVersion: 1, annotations: {} });
  for (const annotation of annotations) plugin.annotationStore.create(annotation);
  plugin.annotationController = { cancelPick: vi.fn() };
  return plugin;
}

function storedIds(plugin) {
  return plugin.annotationStore.list(NOTE_PATH).map((annotation) => annotation.id);
}

describe("selectPromptAnnotations matches what the prompt carries", () => {
  it("selects exactly the records the formatter writes", () => {
    const annotations = [record("a"), record("b"), record("c")];

    const selected = selectPromptAnnotations(annotations);
    const formatted = promptCarries(annotations);

    expect(selected.map((annotation) => annotation.id)).toEqual(formatted.map((entry) => entry.id));
  });

  it("stops at the record ceiling and at the character budget", () => {
    const tooMany = Array.from({ length: ANNOTATION_LIMITS.promptRecords + 10 }, (_, index) =>
      record(`n${index}`)
    );
    expect(selectPromptAnnotations(tooMany)).toHaveLength(ANNOTATION_LIMITS.promptRecords);

    // Twelve records that each carry a large quote cannot all fit the character budget,
    // so the selector has to be the one that says how many do.
    const tooLarge = Array.from({ length: 12 }, (_, index) =>
      record(`l${index}`, {
        quote: "q".repeat(3_000),
        context: "c".repeat(2_000),
        renderedText: "r".repeat(1_000)
      })
    );
    const selected = selectPromptAnnotations(tooLarge);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(tooLarge.length);
    expect(promptCarries(tooLarge)).toHaveLength(selected.length);
  });
});

describe("consumeAnnotationsForPrompt keeps what it cannot send", () => {
  it("keeps the records the prompt has no room for", async () => {
    // A note may hold `perPath` records, which is more than one prompt carries.
    const annotations = Array.from({ length: ANNOTATION_LIMITS.promptRecords + 10 }, (_, index) =>
      record(`s${index}`)
    );
    const plugin = createHarness(annotations);
    expect(storedIds(plugin)).toHaveLength(ANNOTATION_LIMITS.promptRecords + 10);

    const carried = await plugin.consumeAnnotationsForPrompt(NOTE_PATH);

    expect(carried).toHaveLength(ANNOTATION_LIMITS.promptRecords);
    expect(storedIds(plugin)).toHaveLength(10);
    expect(storedIds(plugin)).toEqual(
      annotations.slice(ANNOTATION_LIMITS.promptRecords).map((annotation) => annotation.id)
    );
    // The user is told what stayed instead of losing it silently.
    expect(harness.notices.join(" ")).toContain("10 stayed on this note");
  });

  it("keeps the records a character budget leaves out", async () => {
    const annotations = Array.from({ length: 12 }, (_, index) =>
      record(`c${index}`, {
        quote: "q".repeat(3_000),
        context: "c".repeat(2_000),
        renderedText: "r".repeat(1_000)
      })
    );
    const plugin = createHarness(annotations);
    const carried = await plugin.consumeAnnotationsForPrompt(NOTE_PATH);
    const expectedCarried = selectPromptAnnotations(
      plugin.annotationStore.list(NOTE_PATH).length > 0
        ? annotations
        : annotations.slice(0, carried.length)
    ).length;

    expect(carried.length).toBe(expectedCarried);
    expect(carried.length).toBeLessThan(annotations.length);
    expect(storedIds(plugin)).toHaveLength(annotations.length - carried.length);
    expect(harness.notices.join(" ")).toContain(`stayed on this note`);
  });

  it("clears the note when everything fits, without a notice", async () => {
    const annotations = [record("a"), record("b")];
    const plugin = createHarness(annotations);

    const carried = await plugin.consumeAnnotationsForPrompt(NOTE_PATH);

    expect(carried.map((annotation) => annotation.id)).toEqual(["a", "b"]);
    expect(storedIds(plugin)).toEqual([]);
    expect(harness.notices).toEqual([]);
    expect(plugin.annotationStore.toJSON().annotations).toEqual({});
  });

  it("removes only the named records from the store", () => {
    const plugin = createHarness([record("a"), record("b"), record("c")]);

    expect(plugin.annotationStore.removeByIds(NOTE_PATH, ["a", "c"])).toBe(2);

    expect(storedIds(plugin)).toEqual(["b"]);
    expect(plugin.annotationStore.removeByIds(NOTE_PATH, ["missing"])).toBe(0);
    expect(plugin.annotationStore.removeByIds("Absent.md", ["b"])).toBe(0);
    expect(storedIds(plugin)).toEqual(["b"]);
  });
});
