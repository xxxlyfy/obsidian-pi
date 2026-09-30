import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSources } from "./helpers/view-source.mjs";

vi.mock("obsidian", () => ({
  FuzzySuggestModal: class {},
  Modal: class {},
  Notice: class {},
  Setting: class {},
  SuggestModal: class {},
  setIcon: vi.fn()
}));

import { setIcon } from "obsidian";
import { RunSettingsControls } from "../src/ui/run-settings.mjs";

beforeEach(() => {
  setIcon.mockClear();
});

function createFakeIconElement(options = {}) {
  return {
    cls: options.cls ?? "",
    attr: options.attr ?? {},
    text: options.text ?? "",
    children: [],
    setText(value) {
      this.text = value ?? "";
    },
    append(child) {
      this.children.push(child);
    },
    ownerDocument: {
      createElementNS: () => {
        const el = {
          children: [],
          setAttribute() {},
          append(child) {
            el.children.push(child);
          }
        };
        return el;
      }
    }
  };
}

function createIconHost() {
  return {
    children: [],
    createSpan(options = {}) {
      const span = createFakeIconElement(options);
      this.children.push(span);
      return span;
    },
    createEl(tag, options = {}) {
      const el = createFakeIconElement(options);
      el.tag = tag;
      el.listeners = [];
      el.disabled = false;
      el.isConnected = true;
      el.addEventListener = (type, listener) => el.listeners.push({ type, listener });
      el.createSpan = (childOptions = {}) => {
        const child = createFakeIconElement(childOptions);
        el.children.push(child);
        return child;
      };
      this.children.push(el);
      return el;
    }
  };
}

// The composer bar is created by the chat DOM builders and configured by the
// view, so the retired-expansion assertions below have to cover both.
const viewSource = readSources(["ui/PiAgentView.mjs", "ui/view/chat-dom.mjs"]);
const threadListSource = readFileSync(
  new URL("../src/ui/thread-list-view.mjs", import.meta.url),
  "utf8"
);
const runSettingsSource = readFileSync(
  new URL("../src/ui/run-settings.mjs", import.meta.url),
  "utf8"
);
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("compact composer run settings", () => {
  it("keeps the full current model and thinking values available to the picker labels", () => {
    const controls = new RunSettingsControls({
      settings: {
        model: "acme/long",
        reasoningEffort: "xhigh",
        effectiveModel: "acme/long",
        effectiveReasoning: "low",
        availableModels: [
          {
            slug: "acme/long",
            provider: "acme",
            displayName: "A very long readable model name"
          }
        ]
      }
    });

    expect(controls.getModelLabel()).toBe("A very long readable model name");
    expect(controls.formatDefaultReasoningLabel()).toBe("XHigh");
  });

  it("renders an AI monogram instead of crashing when no model provider is configured", () => {
    const controls = new RunSettingsControls({
      settings: { model: "", customModel: "", effectiveModel: "", availableModels: [] }
    });
    const container = createIconHost();

    expect(() =>
      controls.addPickerSetting(
        container,
        "Model",
        { provider: controls.getModelProvider() },
        controls.getModelLabel(),
        () => {}
      )
    ).not.toThrow();

    const button = container.children[0];
    const monogram = button.children.find((child) => child.text === "AI");
    expect(monogram).toBeDefined();
    expect(monogram.cls).toContain("is-monogram");
    for (const call of setIcon.mock.calls) {
      expect(typeof call[1]).toBe("string");
    }
  });

  it("keeps accessible picker labels and refresh callbacks without dead expansion state", () => {
    expect(runSettingsSource).toContain('"aria-label": `${name}: ${label}`');
    expect(runSettingsSource).toContain(
      'createSpan({ cls: "pi-agent-control-label", text: label })'
    );
    expect(runSettingsSource.match(/this\.plugin\.refreshOpenModelControls\(\)/g)).toHaveLength(3);
    expect(`${viewSource}\n${threadListSource}`).not.toMatch(
      /composerBarExpanded|composerBarExpandEl|updateComposerBarExpansion/
    );
  });

  it("adds a tool mode picker with the write-risk confirmation and mode colors", () => {
    expect(runSettingsSource).toContain('t("runSettings.toolMode")');
    expect(runSettingsSource).toContain("ToolModePickerModal");
    expect(runSettingsSource).toContain(
      "getLocalizedToolModeShortLabel(this.plugin.settings.sandboxMode)"
    );
    expect(runSettingsSource).toContain('t("confirm.writeTools.title")');
    expect(runSettingsSource).toContain("confirmWithModal(this.plugin.app");
    expect(runSettingsSource).toContain("pi-agent-run-setting-mode-write");
    expect(runSettingsSource).toContain("pi-agent-run-setting-mode-full");
  });

  it("uses a distinct icon per tool mode", () => {
    expect(runSettingsSource).toContain('"message-square"');
    expect(runSettingsSource).toContain('"book-open"');
    expect(runSettingsSource).toContain('"file-pen"');
    expect(runSettingsSource).toContain('"terminal"');
    expect(runSettingsSource).not.toContain('"shield"');
  });

  it("keeps every tool mode label visually identical", () => {
    expect(styles).toMatch(
      /\.pi-agent-run-setting-mode-read,\s*\.pi-agent-run-setting-mode-write,\s*\.pi-agent-run-setting-mode-full \{[^}]*color: var\(--text-normal\);/
    );
    expect(styles).not.toMatch(/mode-(write|full) \{[^}]*font-weight/);
    expect(styles).not.toMatch(/mode-(write|full) \{[^}]*color: var\(--text-(warning|error)\)/);
  });

  it("keeps compact labels visible while run settings can wrap, shrink, and ellipsize", () => {
    expect(styles).toMatch(/\.pi-agent-run-settings \{[^}]*flex-wrap: wrap;/);
    expect(styles).toMatch(/button\.pi-agent-run-setting \{[^}]*flex: 0 1 auto;[^}]*min-width: 0;/);
    expect(styles).toMatch(/\.pi-agent-composer-bar \{[^}]*flex-wrap: wrap;/);
    expect(styles).toMatch(
      /\.pi-agent-control-label \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/
    );
    expect(styles).not.toMatch(
      /\.pi-agent-composer-bar\.is-compact[^{]*\.pi-agent-control-label\s*\{[^}]*display:\s*none/
    );
    expect(styles).not.toContain("is-expanded");
  });

  it("lets picker labels show the full value instead of a fixed-width ellipsis", () => {
    expect(styles).toMatch(/\.pi-agent-control-label \{[^}]*max-width: none;/);
    expect(styles).not.toMatch(/\.pi-agent-control-label \{[^}]*max-width: 78px/);
  });

  it("keeps control label glyphs fully visible", () => {
    expect(styles).toMatch(
      /\.pi-agent-control-label \{[^}]*line-height: var\(--line-height-normal\)/
    );
    expect(styles).not.toMatch(/\.pi-agent-control-label \{[^}]*line-height: 1;/);
  });
});
