import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  Notice: class {},
  SuggestModal: class {
    constructor(app) {
      this.app = app;
    }
    setPlaceholder() {
      return this;
    }
    setInstructions() {
      return this;
    }
  }
}));

const { ToolModePickerModal } = await import("../src/ui/modals/tool-mode-picker-modal.mjs");

describe("tool mode picker", () => {
  it("lists every tool mode with a short label and a description", () => {
    const modal = new ToolModePickerModal({}, { sandboxMode: "read-only" }, () => {});
    const items = modal.getItems();

    expect(items.map((item) => item.value)).toEqual(["chat", "read-only", "edit", "full-agent"]);
    expect(items.map((item) => item.primary)).toEqual(["Chat", "Review", "Edit", "Full agent"]);
    expect(items[1].secondary).toBe("read/search/list only");
  });

  it("filters suggestions and forwards the chosen mode", async () => {
    const chosen = [];
    const modal = new ToolModePickerModal({}, { sandboxMode: "chat" }, (value) => {
      chosen.push(value);
    });

    expect(modal.getSuggestions("write").map((item) => item.value)).toEqual(["edit", "full-agent"]);

    modal.onChooseSuggestion({ value: "full-agent" });
    await Promise.resolve();
    expect(chosen).toEqual(["full-agent"]);
  });
});
