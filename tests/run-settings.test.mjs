import { beforeEach, describe, expect, it, vi } from "vitest";

const obsidian = vi.hoisted(() => {
  const menus = [];

  class FakeMenuItem {
    constructor() {
      this.title = "";
      this.checked = false;
      this.disabled = false;
      this.handler = undefined;
    }

    setTitle(title) {
      this.title = title;
      return this;
    }

    setChecked(checked) {
      this.checked = checked;
      return this;
    }

    setDisabled(disabled) {
      this.disabled = disabled;
      return this;
    }

    onClick(handler) {
      this.handler = handler;
      return this;
    }
  }

  class FakeMenu {
    constructor() {
      this.items = [];
      menus.push(this);
    }

    addItem(callback) {
      const item = new FakeMenuItem();
      this.items.push(item);
      callback(item);
      return this;
    }

    showAtMouseEvent() {}
  }

  return { menus, FakeMenu };
});

vi.mock("obsidian", () => ({
  Menu: obsidian.FakeMenu,
  Notice: class {},
  Modal: class {},
  Setting: class {},
  setIcon: (element) => {
    element.createEl("span", { cls: "svg-icon" });
  }
}));

const { RunSettingsControls } = await import("../src/ui/run-settings.mjs");

class FakeElement {
  constructor(tag, options = {}) {
    this.tag = tag;
    this.cls = options.cls ?? "";
    this.text = options.text ?? "";
    this.attr = { ...(options.attr ?? {}) };
    this.children = [];
    this.listeners = new Map();
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

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  setText(text) {
    this.text = String(text);
  }

  empty() {
    this.children = [];
  }

  setAttr(name, value) {
    this.attr[name] = value;
  }

  get childElementCount() {
    return this.children.length;
  }

  get isConnected() {
    return true;
  }

  click() {
    return this.listeners.get("click")?.({ preventDefault() {}, stopPropagation() {} });
  }
}

function createHarness() {
  const model = {
    slug: "customprov/somemodel",
    provider: "customprov",
    id: "somemodel",
    displayName: "Custom Model",
    defaultReasoningLevel: "off",
    supportedReasoningLevels: ["off", "low", "high", "max"],
    thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
    reasoning: true,
    supportsImages: false,
    contextWindow: 200_000
  };
  const settings = {
    model: "",
    customModel: "",
    reasoningEffort: "",
    sandboxMode: "read-only",
    acknowledgedToolRisk: true,
    availableModels: [model],
    effectiveModel: model.slug,
    effectiveReasoning: "off"
  };
  let controls;
  const plugin = {
    settings,
    app: {},
    async ensureRuntimeModelState() {},
    async saveSettings() {},
    refreshOpenModelControls() {
      controls.refresh();
    }
  };
  controls = new RunSettingsControls(plugin);
  controls.render(new FakeElement("div"));
  return { controls, settings };
}

beforeEach(() => {
  obsidian.menus.length = 0;
});

describe("composer run settings controls", () => {
  it("updates labels in place on refresh without throwing", () => {
    const { controls, settings } = createHarness();

    expect(controls.controls.Model.labelEl.text).toBe("Custom Model");
    expect(controls.controls.Think.labelEl.text).toBe("关闭");
    expect(controls.controls.Mode.labelEl.text).toBe("审阅");

    settings.sandboxMode = "full-agent";
    settings.reasoningEffort = "high";
    expect(() => controls.refresh()).not.toThrow();
    expect(controls.controls.Mode.labelEl.text).toBe("完整智能体");
    expect(controls.controls.Think.labelEl.text).toBe("高");
  });

  it("lists only the model's reasoning levels without a duplicate default", async () => {
    const { controls, settings } = createHarness();

    await controls.controls.Think.buttonEl.click();
    const menu = obsidian.menus.at(-1);
    const titles = menu.items.map((item) => item.title);

    expect(titles).toEqual(["关闭", "低", "高", "最高"]);
    expect(new Set(titles).size).toBe(titles.length);
    expect(menu.items.find((item) => item.title === "关闭").checked).toBe(true);

    const high = menu.items.find((item) => item.title === "高");
    await high.handler();
    expect(settings.reasoningEffort).toBe("high");
    expect(controls.controls.Think.labelEl.text).toBe("高");
  });

  it("applies a tool mode selection and updates the mode label", async () => {
    const { controls, settings } = createHarness();

    await controls.controls.Mode.buttonEl.click();
    const menu = obsidian.menus.at(-1);
    const fullAgent = menu.items.find((item) => item.title.includes("完整智能体"));

    await fullAgent.handler();
    expect(settings.sandboxMode).toBe("full-agent");
    expect(controls.controls.Mode.labelEl.text).toBe("完整智能体");
  });
});
