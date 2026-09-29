import { describe, expect, it } from "vitest";
import {
  CUSTOM_MODEL_VALUE,
  DEFAULT_SETTINGS,
  getLocalizedReasoningLabel,
  getLocalizedReasoningOptions,
  getLocalizedToolModeOptions,
  getLocalizedToolModePickerItems,
  getLocalizedToolModeShortLabel,
  getModelOptions,
  getReasoningOptions,
  getResolvedReasoning,
  getSelectedModelInfo,
  getToolModeOptions,
  getToolModePickerItems,
  normalizeSettings
} from "../src/plugin/settings.mjs";
import { setLocale } from "../src/shared/i18n/index.mjs";

describe("plugin settings helpers", () => {
  const model = {
    slug: "provider/model",
    displayName: "provider: model",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["low", "medium", "high", "max"],
    reasoning: true,
    supportsImages: true,
    contextWindow: 200000
  };

  it("builds model options", () => {
    expect(getModelOptions({ ...DEFAULT_SETTINGS, availableModels: [] })).toEqual({});
    expect(
      getModelOptions({
        ...DEFAULT_SETTINGS,
        availableModels: [model],
        effectiveModel: "provider/model"
      })
    ).toEqual({
      "": "provider: model",
      "provider/model": "provider: model — provider/model · thinking · images · 200K context"
    });
  });

  it("builds reasoning options from the selected model", () => {
    expect(
      getReasoningOptions({
        ...DEFAULT_SETTINGS,
        model: "provider/model",
        availableModels: [model]
      })
    ).toEqual({
      "": "Medium",
      low: "Low",
      medium: "Medium",
      high: "High",
      max: "Max - deepest"
    });
    expect(
      getReasoningOptions({
        ...DEFAULT_SETTINGS,
        effectiveReasoning: "high"
      })
    ).toEqual({ "": "High" });
  });

  it("does not offer another model's thinking levels for an unknown custom slug", () => {
    expect(
      getReasoningOptions({
        ...DEFAULT_SETTINGS,
        model: CUSTOM_MODEL_VALUE,
        customModel: "unknown/model",
        effectiveModel: "provider/model",
        effectiveReasoning: "high",
        availableModels: [model]
      })
    ).toEqual({ "": "High" });
  });

  it("resolves reasoning defaults", () => {
    expect(getResolvedReasoning({ ...DEFAULT_SETTINGS, reasoningEffort: "high" })).toBe("high");
    expect(
      getResolvedReasoning({
        ...DEFAULT_SETTINGS,
        model: "provider/model",
        availableModels: [model]
      })
    ).toBe("medium");
    expect(getResolvedReasoning({ ...DEFAULT_SETTINGS, effectiveReasoning: "low" })).toBe("low");
    expect(
      getResolvedReasoning({
        ...DEFAULT_SETTINGS,
        effectiveModel: "provider/model",
        effectiveReasoning: "high",
        availableModels: [model]
      })
    ).toBe("high");
  });

  it("normalizes loaded settings", () => {
    const settings = normalizeSettings({
      sandboxMode: "danger-full-access",
      maxSearchResults: "999",
      maxSearchFiles: "bad",
      maxFileChars: 10,
      maxChangeSnapshotFiles: 0,
      ignoredFolders: ["", ".git"],
      piExecutablePath: " /custom/bin/pi ",
      includeDefaultSkills: undefined,
      dismissedPiSetup: true
    });

    expect(settings).toMatchObject({
      sandboxMode: "edit",
      ignoredFolders: [".git"],
      piExecutablePath: "/custom/bin/pi",
      includeDefaultSkills: true,
      dismissedPiSetup: true,
      desktopNotifications: true,
      showExtensionStatus: true
    });
    expect(settings).not.toHaveProperty("maxSearchResults");
    expect(settings).not.toHaveProperty("maxSearchFiles");
    expect(settings).not.toHaveProperty("maxFileChars");
    expect(settings).not.toHaveProperty("maxChangeSnapshotFiles");
    expect(normalizeSettings({ desktopNotifications: false }).desktopNotifications).toBe(false);
    expect(normalizeSettings({ showExtensionStatus: false }).showExtensionStatus).toBe(false);
  });

  it("finds custom selected model info and exposes tool modes", () => {
    expect(
      getSelectedModelInfo({
        ...DEFAULT_SETTINGS,
        model: CUSTOM_MODEL_VALUE,
        customModel: "provider/model",
        availableModels: [model]
      })
    ).toBe(model);
    expect(getToolModeOptions()).toHaveProperty("full-agent", "Full agent — edit/write and shell");
  });

  it("localizes settings-only tool mode and reasoning labels", () => {
    setLocale("en");
    expect(getLocalizedToolModeOptions()).toEqual(getToolModeOptions());
    expect(getLocalizedToolModePickerItems()).toEqual(getToolModePickerItems());
    expect(getLocalizedToolModeShortLabel("read-only")).toBe("Review");
    expect(getLocalizedToolModeShortLabel("unknown")).toBe("");
    expect(
      getLocalizedReasoningOptions({
        ...DEFAULT_SETTINGS,
        model: "provider/model",
        availableModels: [model]
      })
    ).toEqual(
      getReasoningOptions({
        ...DEFAULT_SETTINGS,
        model: "provider/model",
        availableModels: [model]
      })
    );
    expect(getLocalizedReasoningOptions({ ...DEFAULT_SETTINGS })).toEqual({ "": "Automatic" });
    expect(getLocalizedReasoningLabel("max")).toBe("Max - deepest");
    expect(getLocalizedReasoningLabel("max", { short: true })).toBe("Max");
    expect(getLocalizedReasoningLabel("minimal", { short: true })).toBe("Minimal");
    expect(getLocalizedReasoningLabel("mystery")).toBe("mystery");

    setLocale("zh-cn");
    expect(getLocalizedToolModeOptions()).toEqual({
      chat: "对话 — 不使用 Pi CLI 工具",
      "read-only": "审阅 — 只读/搜索/列表",
      edit: "编辑 — 编辑/写入，不使用 shell",
      "full-agent": "完整代理 — 编辑/写入与 shell"
    });
    expect(
      getLocalizedReasoningOptions({
        ...DEFAULT_SETTINGS,
        model: "provider/model",
        availableModels: [model]
      })
    ).toEqual({ "": "中", low: "低", medium: "中", high: "高", max: "最高 - 最深" });
    expect(getLocalizedReasoningOptions({ ...DEFAULT_SETTINGS })).toEqual({ "": "自动" });
    expect(getLocalizedReasoningLabel("xhigh")).toBe("极高");
    expect(getLocalizedReasoningLabel("max", { short: true })).toBe("最高");
    expect(getLocalizedToolModePickerItems()).toEqual([
      { value: "chat", primary: "对话", secondary: "不使用 Pi CLI 工具" },
      { value: "read-only", primary: "审阅", secondary: "只读/搜索/列表" },
      { value: "edit", primary: "编辑", secondary: "编辑/写入，不使用 shell" },
      { value: "full-agent", primary: "完整代理", secondary: "编辑/写入与 shell" }
    ]);
    expect(getLocalizedToolModeShortLabel("read-only")).toBe("审阅");
    expect(getLocalizedToolModeShortLabel("full-agent")).toBe("完整代理");

    setLocale("en");
  });
});
