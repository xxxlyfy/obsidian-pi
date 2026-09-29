import { afterEach, describe, expect, it, vi } from "vitest";

const { getLanguageMock } = vi.hoisted(() => ({ getLanguageMock: vi.fn(() => "en") }));

vi.mock("obsidian", () => {
  class PluginSettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = { empty: vi.fn() };
    }
  }

  class Setting {
    setName() {
      return this;
    }

    setHeading() {
      return this;
    }
  }

  return {
    FuzzySuggestModal: class {},
    Modal: class {},
    Notice: class {},
    PluginSettingTab,
    Setting,
    SuggestModal: class {},
    getLanguage: () => getLanguageMock()
  };
});

const { PiAgentSettingTab } = await import("../src/plugin/settings-tab.mjs");
const { setLocale } = await import("../src/shared/i18n/index.mjs");

const ENGLISH_ITEM_NAMES = [
  "Model",
  "Thinking level",
  "Tool mode",
  "Desktop completion notifications",
  "Show extension status",
  "Custom instructions",
  "Custom model slug",
  "Pi executable path",
  "Check Pi installation",
  "Include default Pi skills",
  "Additional skill folders",
  "Ignored folders/directories"
];

const CHINESE_ITEM_NAMES = [
  "模型",
  "思考等级",
  "工具模式",
  "桌面完成通知",
  "显示扩展状态",
  "自定义指令",
  "自定义模型标识",
  "Pi 可执行文件路径",
  "检查 Pi 安装",
  "包含默认 Pi 技能",
  "附加技能文件夹",
  "忽略的文件夹/目录"
];

function createTab() {
  return new PiAgentSettingTab(
    { vault: { configDir: ".config" } },
    {
      settings: { ignoredFolders: [".git"], showExtensionStatus: true },
      setShowExtensionStatus: vi.fn()
    }
  );
}

function flattenDefinitions(definitions) {
  return definitions.flatMap((definition) =>
    definition.type === "group" ? (definition.items ?? []) : [definition]
  );
}

afterEach(() => {
  getLanguageMock.mockReturnValue("en");
  setLocale("en");
});

describe("Pi agent settings tab API compatibility", () => {
  it("uses the vault's configured settings folder instead of a hardcoded path", () => {
    const tab = createTab();

    expect(tab.plugin.settings.ignoredFolders).toEqual([".config", ".git"]);
  });

  it("exposes every setting through searchable 1.13 definitions", () => {
    const definitions = createTab().getSettingDefinitions();
    const items = flattenDefinitions(definitions);

    expect(items.map((item) => item.name)).toEqual(ENGLISH_ITEM_NAMES);
    expect(items.every((item) => typeof item.render === "function")).toBe(true);
  });

  it("follows the Obsidian app language for settings text", () => {
    getLanguageMock.mockReturnValue("zh-CN");
    const definitions = createTab().getSettingDefinitions();
    const items = flattenDefinitions(definitions);

    expect(items.map((item) => item.name)).toEqual(CHINESE_ITEM_NAMES);
    expect(
      definitions.filter((definition) => definition.type === "group").map((group) => group.heading)
    ).toEqual(["高级", "Pi CLI", "技能", "上下文与文件访问"]);
    expect(items[0].desc).toContain("模型注册表");
    expect(items[4].name).toBe("显示扩展状态");
  });

  it("keeps English when Obsidian uses any other language", () => {
    getLanguageMock.mockReturnValue("de");
    const items = flattenDefinitions(createTab().getSettingDefinitions());

    expect(items.map((item) => item.name)).toEqual(ENGLISH_ITEM_NAMES);
  });

  it("delegates extension status toggle changes to the plugin", async () => {
    const tab = createTab();
    let onChange;
    const toggle = {
      setValue: vi.fn(() => toggle),
      onChange: vi.fn((callback) => {
        onChange = callback;
        return toggle;
      })
    };

    tab.getExtensionStatusDefinition().render({ addToggle: (callback) => callback(toggle) });
    await onChange(false);

    expect(toggle.setValue).toHaveBeenCalledWith(true);
    expect(tab.plugin.setShowExtensionStatus).toHaveBeenCalledWith(false);
  });

  it("keeps legacy display rendering while routing 1.13 refreshes through update", () => {
    const tab = createTab();
    tab.renderLegacyDefinition = vi.fn();

    tab.display();
    expect(tab.containerEl.empty).toHaveBeenCalledOnce();
    expect(tab.renderLegacyDefinition).toHaveBeenCalledTimes(12);

    tab.containerEl.empty.mockClear();
    tab.update = vi.fn();
    tab.display();
    expect(tab.update).toHaveBeenCalledOnce();
    expect(tab.containerEl.empty).not.toHaveBeenCalled();
  });
});
