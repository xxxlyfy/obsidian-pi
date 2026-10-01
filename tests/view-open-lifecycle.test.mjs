import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Records what Component.register() collected, so the test can also drive the
// unload backstop the way Obsidian would. Created with vi.hoisted because the
// vi.mock factory below is hoisted above these declarations.
const harness = vi.hoisted(() => ({ componentCleanups: [] }));

// The view, its mixins and the chat DOM builders all import from "obsidian".
// ItemView reproduces the part of Component that matters here: registerEvent()
// and registerDomEvent() clean up on unload, not on close.
vi.mock("obsidian", () => {
  class ItemView {
    constructor(leaf) {
      this.leaf = leaf;
      this.app = leaf?.app;
    }
    register(cleanup) {
      harness.componentCleanups.push(cleanup);
      return cleanup;
    }
    registerEvent(ref) {
      this.register(() => this.app?.workspace?.offref(ref));
    }
    registerDomEvent(target, type, handler) {
      target.addEventListener(type, handler);
      this.register(() => target.removeEventListener(type, handler));
    }
  }
  return {
    ItemView,
    Component: class {},
    FuzzySuggestModal: class {},
    MarkdownRenderChild: class {},
    MarkdownRenderer: { render: vi.fn().mockResolvedValue(undefined) },
    MarkdownView: class {},
    Menu: class {
      addItem() {
        return this;
      }
      addSeparator() {}
    },
    Modal: class {},
    Notice: class {},
    PluginSettingTab: class {},
    Setting: class {},
    SuggestModal: class {},
    TFile: class {},
    getLanguage: () => "en",
    normalizePath: (value) => value,
    setIcon: vi.fn()
  };
});

import { PiAgentView } from "../src/ui/PiAgentView.mjs";

const WORKSPACE_EVENTS = ["file-open", "active-leaf-change"];

function createFakeDocument() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    handlers(type) {
      return [...(listeners.get(type) ?? [])];
    }
  };
}

function createFakeWorkspace() {
  const listeners = new Map();
  return {
    on(event, callback) {
      const ref = { event, callback };
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(ref);
      return ref;
    },
    offref(ref) {
      listeners.get(ref?.event)?.delete(ref);
    },
    refs(event) {
      return [...(listeners.get(event) ?? [])];
    }
  };
}

function createView() {
  const dom = createFakeDocument();
  const workspace = createFakeWorkspace();
  vi.stubGlobal("document", dom);
  const plugin = {
    app: { workspace },
    extensionTitle: "Pi",
    getLocalPromptQueue: () => []
  };
  const view = new PiAgentView({ app: plugin.app }, plugin);
  // How the chat DOM is built is not what this test covers; how many listeners
  // onOpen leaves behind is.
  view.renderChatView = vi.fn();
  return { view, workspace, dom };
}

/** The three listeners this lifecycle owns, counted together. */
function listenerCount({ dom, workspace }) {
  return (
    dom.handlers("keydown").length +
    WORKSPACE_EVENTS.reduce((total, event) => total + workspace.refs(event).length, 0)
  );
}

beforeEach(() => {
  harness.componentCleanups.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PiAgentView open/close listener lifecycle", () => {
  it("installs exactly one set of the three listeners when opened", async () => {
    const harnessed = createView();

    await harnessed.view.onOpen();

    expect(harnessed.dom.handlers("keydown")).toHaveLength(1);
    for (const event of WORKSPACE_EVENTS) {
      expect(harnessed.workspace.refs(event), event).toHaveLength(1);
    }
    expect(listenerCount(harnessed)).toBe(3);
  });

  it("releases all three listeners as soon as the view closes", async () => {
    const harnessed = createView();
    await harnessed.view.onOpen();

    await harnessed.view.onClose();

    expect(harnessed.dom.handlers("keydown")).toHaveLength(0);
    for (const event of WORKSPACE_EVENTS) {
      expect(harnessed.workspace.refs(event), event).toHaveLength(0);
    }
  });

  it("does not accumulate listeners across repeated open/close cycles", async () => {
    const harnessed = createView();

    // The regression: registerDomEvent()/registerEvent() only cleaned up on
    // Component unload, so the closed view's handlers stayed subscribed and each
    // reopen added another set -- 3, then 6, then 9.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await harnessed.view.onOpen();
      expect(listenerCount(harnessed), `cycle ${cycle + 1} open`).toBe(3);
      await harnessed.view.onClose();
      expect(listenerCount(harnessed), `cycle ${cycle + 1} close`).toBe(0);
    }
  });

  it("replaces the previous set even if onOpen runs twice without a close", async () => {
    const harnessed = createView();

    await harnessed.view.onOpen();
    await harnessed.view.onOpen();

    expect(listenerCount(harnessed)).toBe(3);
  });

  it("keeps onClose idempotent", async () => {
    const harnessed = createView();
    await harnessed.view.onOpen();

    await harnessed.view.onClose();
    await expect(harnessed.view.onClose()).resolves.toBeUndefined();
    await expect(harnessed.view.onClose()).resolves.toBeUndefined();

    expect(listenerCount(harnessed)).toBe(0);
  });

  it("is safe to clean up before the view was ever opened", async () => {
    const harnessed = createView();

    await expect(harnessed.view.onClose()).resolves.toBeUndefined();

    expect(listenerCount(harnessed)).toBe(0);
  });

  it("still releases the listeners when the Component is unloaded without close", async () => {
    const harnessed = createView();
    await harnessed.view.onOpen();
    expect(listenerCount(harnessed)).toBe(3);

    // What Obsidian does on unload: run everything Component.register() collected.
    for (const cleanup of harness.componentCleanups) cleanup();

    expect(listenerCount(harnessed)).toBe(0);
  });

  it("keeps the behaviour of the listeners it installs", async () => {
    const harnessed = createView();
    const syncCurrentRunFlags = vi.fn();
    const cancelCurrentRun = vi.fn();
    const renderToolBadges = vi.fn();
    Object.assign(harnessed.view, { syncCurrentRunFlags, cancelCurrentRun, renderToolBadges });
    harnessed.view.state.running = true;

    await harnessed.view.onOpen();

    const [keydown] = harnessed.dom.handlers("keydown");
    const escape = { key: "Escape", preventDefault: vi.fn() };
    keydown(escape);
    expect(syncCurrentRunFlags).toHaveBeenCalledOnce();
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(cancelCurrentRun).toHaveBeenCalledOnce();

    // Any other key only re-syncs the run flags.
    keydown({ key: "a", preventDefault: vi.fn() });
    expect(syncCurrentRunFlags).toHaveBeenCalledTimes(2);
    expect(cancelCurrentRun).toHaveBeenCalledOnce();

    for (const event of WORKSPACE_EVENTS) {
      renderToolBadges.mockClear();
      harnessed.workspace.refs(event)[0].callback();
      expect(renderToolBadges, event).toHaveBeenCalledOnce();
    }
  });

  it("stops reacting to Escape once closed", async () => {
    const harnessed = createView();
    const cancelCurrentRun = vi.fn();
    Object.assign(harnessed.view, { cancelCurrentRun, syncCurrentRunFlags: vi.fn() });
    harnessed.view.state.running = true;
    // What the document does on keydown: dispatch to whatever is subscribed.
    const dispatchEscape = () => {
      for (const handler of harnessed.dom.handlers("keydown")) {
        handler({ key: "Escape", preventDefault: vi.fn() });
      }
    };

    await harnessed.view.onOpen();
    dispatchEscape();
    expect(cancelCurrentRun).toHaveBeenCalledOnce();

    await harnessed.view.onClose();
    dispatchEscape();

    // Still once: the closed view is no longer reachable from the document.
    expect(cancelCurrentRun).toHaveBeenCalledOnce();
  });
});
