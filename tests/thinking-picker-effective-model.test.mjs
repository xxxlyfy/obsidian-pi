/**
 * The label the thinking picker shows for the model a setting applies to.
 *
 * `settings.model` stores the sentinel `__custom` when the user picks "Use custom model",
 * with the slug they typed in `settings.customModel`. Every other surface resolves that
 * branch before formatting a label (`run-settings.mjs`, `run-metadata.mjs`), but the
 * thinking picker's `formatEffectiveModel()` did not, so its default row read
 * "Effective for __custom" / "对 __custom 生效" - an internal marker in a user-facing,
 * already-localized sentence.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  FuzzySuggestModal: class {
    constructor() {}
    setPlaceholder() {}
    setInstructions() {}
  },
  Notice: class {},
  SuggestModal: class {
    constructor() {}
    setPlaceholder() {}
    setInstructions() {}
  }
}));

const { ThinkingPickerModal } = await import("../src/ui/modals/model-picker-modal.mjs");
const { CUSTOM_MODEL_VALUE } = await import("../src/plugin/settings.mjs");

const catalog = [
  { slug: "deepseek/deepseek-flash", displayName: "DeepSeek Flash" },
  { slug: "openai/gpt-5", displayName: "GPT-5" }
];

/** The row the picker adds for the model the setting is currently resolved to. */
function effectiveRow(settings, localize = false) {
  const modal = new ThinkingPickerModal(undefined, settings, () => {}, { localize });
  return modal.getItems().find((item) => item.value === "");
}

describe("the thinking picker's effective-model row", () => {
  it("names the custom slug instead of the internal sentinel", () => {
    const row = effectiveRow({
      reasoningEffort: "medium",
      model: CUSTOM_MODEL_VALUE,
      customModel: "vendor/custom-model",
      effectiveModel: "vendor/custom-model",
      availableModels: catalog
    });

    expect(row.secondary).toContain("vendor/custom-model");
    expect(row.secondary).not.toContain(CUSTOM_MODEL_VALUE);
  });

  it("falls back to a readable label when the custom slug is empty", () => {
    const row = effectiveRow({
      reasoningEffort: "medium",
      model: CUSTOM_MODEL_VALUE,
      customModel: "",
      effectiveModel: "",
      availableModels: catalog
    });

    expect(row.secondary).toContain("Custom");
    expect(row.secondary).not.toContain(CUSTOM_MODEL_VALUE);
  });

  it("still names a catalog model", () => {
    const row = effectiveRow({
      reasoningEffort: "medium",
      model: "",
      customModel: "",
      effectiveModel: "openai/gpt-5",
      availableModels: catalog
    });

    expect(row.secondary).toContain("GPT-5");
  });
});
