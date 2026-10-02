/**
 * Pointer targets from another window.
 *
 * The annotation pick resolves the CodeMirror line under the pointer with
 * `closestLineElement()`. It used to test `target instanceof Element` first, which is
 * false for an element that belongs to a popout window - `Element` here is this realm's
 * constructor, and only a target from this realm is an instance of it. The hover
 * highlight and the empty-selection block pick then stopped responding in a popout while
 * the rest of the picker kept working. The helper now narrows by the `closest` method the
 * call site actually uses, which is realm-independent.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  Decoration: { mark: () => ({ range: () => ({}) }) },
  EditorView: { decorations: { from: () => ({}) }, theme: () => ({}) },
  MarkdownView: class MarkdownView {},
  Notice: class Notice {},
  setIcon() {}
}));

const { closestLineElement } = await import("../src/annotations/markdown-annotation-extension.mjs");

/** An element from another realm: not shaped like this realm's Element, but usable. */
function foreignLineElement() {
  return {
    tagName: "DIV",
    closest(selector) {
      return selector === ".cm-line" ? { selector, foreign: true } : null;
    }
  };
}

describe("closestLineElement", () => {
  it("accepts a line element from another window", () => {
    const line = closestLineElement(foreignLineElement());

    expect(line).toMatchObject({ foreign: true });
  });

  it("accepts a line element from this realm", () => {
    const element = {
      closest: (selector) => (selector === ".cm-line" ? { local: true } : null)
    };

    expect(closestLineElement(element)).toMatchObject({ local: true });
  });

  it("returns null for targets that are not elements", () => {
    expect(closestLineElement(null)).toBeNull();
    expect(closestLineElement(undefined)).toBeNull();
    expect(closestLineElement({ type: "text" })).toBeNull();
    expect(closestLineElement("string")).toBeNull();
    expect(closestLineElement({ closest: "not a function" })).toBeNull();
  });

  it("asks for the line, not just any ancestor", () => {
    const closest = vi.fn(() => null);
    closestLineElement({ closest });

    expect(closest).toHaveBeenCalledWith(".cm-line");
  });
});
