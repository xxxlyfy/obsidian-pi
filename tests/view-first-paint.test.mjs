/**
 * The chat view's first paint.
 *
 * `renderChatView()` builds the DOM through three builders and attaches what they return
 * with `Object.assign`. The builders used to call the view's repaint methods themselves,
 * and every one of those methods starts with a guard on the element it paints
 * (`if (!this.threadTitleEl) return;`). On the first paint that element did not exist yet,
 * so the title stayed empty and the favorite button kept no state; on a rebuild the text
 * went into the previous round's detached element. The repaints now run after the
 * assignments. These cases pin that behaviour, and the ordering itself, because moving a
 * repaint back into a builder is invisible to every other test.
 */
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  setIcon(element, icon) {
    element.icon = icon;
  },
  Component: class Component {
    load() {}
    unload() {}
  },
  MarkdownRenderer: {
    render: async () => {}
  }
}));

const { createHeader, renderThreadTitle, renderThreadFavorite } =
  await import("../src/ui/view/chat-dom.mjs");
const viewSource = fs.readFileSync("src/ui/PiAgentView.mjs", "utf8");
const chatDomSource = fs.readFileSync("src/ui/view/chat-dom.mjs", "utf8");

/** The element surface the header builder and the two repaints use. */
class FakeElement {
  constructor(tag, options = {}) {
    this.tag = tag;
    this.cls = options.cls ?? "";
    this.text = options.text ?? "";
    this.attr = { ...(options.attr ?? {}) };
    this.children = [];
    this.listeners = new Map();
    this.classes = new Set(String(this.cls).split(" ").filter(Boolean));
  }

  createEl(tag, options) {
    const child = new FakeElement(tag, options);
    this.children.push(child);
    return child;
  }

  createDiv(options) {
    return this.createEl("div", options);
  }

  createSpan(options) {
    return this.createEl("span", options);
  }

  empty() {
    this.children.length = 0;
    this.text = "";
    return this;
  }

  setAttr(name, value) {
    this.attr[name] = String(value);
    return this;
  }

  toggleClass(name, enabled) {
    if (enabled) this.classes.add(name);
    else this.classes.delete(name);
    return this;
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  find(cls) {
    return this.descendants().find((element) => element.classes.has(cls));
  }
}

/** Build the real header, with the two repaints recorded instead of painting. */
function buildHeader({ favorite = false } = {}) {
  const view = {
    plugin: {
      getCurrentThread: () => ({ id: "t1", title: "Thread title", favorite }),
      getCurrentContextFile: () => undefined,
      extensionWidgets: new Map()
    },
    state: { activeRuns: new Map(), composerImages: [], composerAttachments: [] },
    renderPiIcon: vi.fn(),
    renderThreadTitle: vi.fn(),
    renderThreadFavorite: vi.fn(),
    startThreadTitleRename: vi.fn(),
    toggleCurrentThreadFavorite: vi.fn(),
    showThreadList: vi.fn(),
    startNewChat: vi.fn(),
    renderToolBadges: vi.fn(),
    isThreadRunning: () => false
  };
  const root = new FakeElement("div");
  const built = createHeader(root, view);
  return { view, root, built };
}

const sliceFunction = (source, signature) => {
  const start = source.indexOf(signature);
  return start < 0 ? "" : source.slice(start, source.indexOf("\n}", start));
};

describe("the header the view builds", () => {
  it("hands back the title and favorite elements the repaints look for", () => {
    const { built, root } = buildHeader();

    expect(built.threadTitleEl).toBe(root.find("pi-agent-thread-title"));
    expect(built.threadFavoriteEl).toBe(root.find("pi-agent-header-favorite"));
  });

  it("does not repaint while it is being built, when its elements are not attached yet", () => {
    const { view } = buildHeader();

    expect(view.renderThreadTitle).not.toHaveBeenCalled();
    expect(view.renderThreadFavorite).not.toHaveBeenCalled();
  });

  it("paints the title and the favorite state once those elements are attached", () => {
    const { root, built } = buildHeader({ favorite: true });
    // The surface the real repaints run on: the elements the builder returned, as
    // `Object.assign(this, createHeader(...))` leaves them.
    const surface = {
      plugin: { getCurrentThread: () => ({ id: "t1", title: "Thread title", favorite: true }) },
      threadTitleEl: built.threadTitleEl,
      threadFavoriteEl: built.threadFavoriteEl,
      renderThreadFavorite
    };

    renderThreadTitle.call(surface);

    // `renderThreadTitle()` empties the element and writes the title as a child span.
    const titleEl = root.find("pi-agent-thread-title");
    expect(titleEl.children.map((child) => child.text)).toEqual(["Thread title"]);
    expect(root.find("pi-agent-header-favorite").classes.has("is-favorite")).toBe(true);
    expect(root.find("pi-agent-header-favorite").attr["aria-label"]).toBeTruthy();
  });
});

describe("where renderChatView runs its repaints", () => {
  const repaints = [
    "this.renderThreadTitle()",
    "this.renderToolBadges()",
    "this.renderComposerImages()",
    "this.renderPromptQueue()",
    "this.renderExtensionWidgets()",
    "this.resizeInput()"
  ];

  it("runs every repaint after all three builder results are attached", () => {
    const body = sliceFunction(viewSource, "  renderChatView() {");
    expect(body).not.toBe("");
    const attached = body.indexOf("Object.assign(this, createComposer(root, this))");
    expect(attached).toBeGreaterThan(-1);

    for (const repaint of repaints) {
      const at = body.indexOf(repaint);
      expect(at, `${repaint} is missing from renderChatView`).toBeGreaterThan(-1);
      expect(at, `${repaint} runs before the elements are attached`).toBeGreaterThan(attached);
    }
  });

  it("keeps those repaints out of the builders that run before the attachment", () => {
    for (const builder of ["export function createHeader", "export function createComposer"]) {
      const body = sliceFunction(chatDomSource, builder);
      expect(body, `${builder} is missing`).not.toBe("");
      for (const repaint of [
        "renderThreadTitle",
        "renderThreadFavorite",
        "renderToolBadges",
        "renderComposerImages",
        "renderPromptQueue",
        "renderExtensionWidgets",
        "resizeInput"
      ]) {
        // A repaint called while the builder runs stands on its own statement; a call
        // inside a listener or callback is indented behind another expression, so it
        // only runs long after the elements exist.
        const duringBuild = new RegExp(`^\\s{2}view\\.${repaint}\\(\\)`, "m");
        expect(
          duringBuild.test(body),
          `${builder} still calls view.${repaint}() while building`
        ).toBe(false);
      }
    }
  });
});
