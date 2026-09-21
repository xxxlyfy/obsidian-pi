import { Menu, Notice, setIcon } from "obsidian";
import { STRINGS } from "../shared/strings.mjs";
import {
  buildReasoningMenuItems,
  CUSTOM_MODEL_VALUE,
  formatReasoningLevel,
  getResolvedReasoning,
  getSelectedModelInfo,
  getToolModeOptions
} from "../plugin/settings.mjs";
import { confirmWithModal } from "./modals/confirm-modal.mjs";
import {
  buildModelPickerItems,
  getModelPickerPrimary,
  hasSafeRuntimeCatalog
} from "./model-picker.mjs";
import { renderProviderIcon } from "./provider-icons.mjs";
import { formatToolModeLabel } from "./view/run-metadata.mjs";

export class RunSettingsControls {
  constructor(plugin) {
    this.plugin = plugin;
    this.controls = {};
  }

  render(containerEl) {
    this.row = containerEl.createDiv({ cls: "pi-agent-run-settings" });
    this.controls = {};
    this.populate(this.row);
  }

  refresh() {
    if (!this.row) return;
    this.updateControl("Model", { provider: this.getModelProvider() }, this.getModelLabel());
    this.updateControl("Think", "brain", this.formatDefaultReasoningLabel());
    this.updateControl("Mode", this.getToolModeIcon(), this.getToolModeLabel());
  }

  updateControl(name, icon, label) {
    const control = this.controls?.[name];
    if (!control || !control.buttonEl.isConnected) return;
    control.labelEl.setText(label);
    control.buttonEl.setAttr(
      "aria-label",
      STRINGS.controls.label(STRINGS.controls[name.toLowerCase()], label)
    );
    control.buttonEl.setAttr(
      "title",
      STRINGS.controls.label(STRINGS.controls[name.toLowerCase()], label)
    );
    this.renderControlIcon(control.iconEl, icon, control);
  }

  populate(containerEl) {
    this.addPickerSetting(
      containerEl,
      "Model",
      { provider: this.getModelProvider() },
      this.getModelLabel(),
      async (event) => {
        await this.ensureCatalog();
        const menu = new Menu();
        const items = buildModelPickerItems(this.plugin.settings);
        if (items.length === 0) {
          menu.addItem((menuItem) =>
            menuItem.setTitle(STRINGS.controls.noModels).setDisabled(true)
          );
        }
        for (const item of items) {
          menu.addItem((menuItem) =>
            menuItem
              .setTitle(getModelPickerPrimary(item))
              .setChecked(this.plugin.settings.model === item.value)
              .onClick(() =>
                this.applySettingChange(async () => {
                  this.plugin.settings.model = item.value;
                  this.plugin.settings.reasoningEffort = "";
                  await this.plugin.saveSettings();
                  this.plugin.refreshOpenModelControls();
                })
              )
          );
        }
        menu.showAtMouseEvent(event);
      }
    );

    this.addPickerSetting(
      containerEl,
      "Think",
      "brain",
      this.formatDefaultReasoningLabel(),
      async (event) => {
        await this.ensureCatalog();
        const menu = new Menu();
        for (const item of buildReasoningMenuItems(this.plugin.settings)) {
          menu.addItem((menuItem) =>
            menuItem
              .setTitle(item.label)
              .setChecked(item.selected)
              .onClick(() =>
                this.applySettingChange(async () => {
                  this.plugin.settings.reasoningEffort = item.value;
                  await this.plugin.saveSettings();
                  this.plugin.refreshOpenModelControls();
                })
              )
          );
        }
        menu.showAtMouseEvent(event);
      }
    );

    this.addPickerSetting(
      containerEl,
      "Mode",
      this.getToolModeIcon(),
      this.getToolModeLabel(),
      (event) => {
        const menu = new Menu();
        for (const [value, label] of Object.entries(getToolModeOptions())) {
          menu.addItem((menuItem) =>
            menuItem
              .setTitle(label)
              .setChecked(this.plugin.settings.sandboxMode === value)
              .onClick(() => this.applySettingChange(() => this.applyToolMode(value)))
          );
        }
        menu.showAtMouseEvent(event);
      }
    );
  }

  async ensureCatalog() {
    if (!hasSafeRuntimeCatalog(this.plugin.settings)) {
      await this.plugin.ensureRuntimeModelState();
    }
  }

  async applySettingChange(action) {
    try {
      await action();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  async applyToolMode(value) {
    if (value === this.plugin.settings.sandboxMode) return;
    if (
      (value === "edit" || value === "full-agent" || value === "workspace-write") &&
      !this.plugin.settings.acknowledgedToolRisk &&
      !(await confirmWithModal(this.plugin.app, {
        title: "启用写入工具？",
        message:
          "Pi 工具模式并非操作系统级沙箱。编辑和完整智能体模式可以修改库或项目文件，完整智能体模式还可以执行 shell 命令。",
        confirmText: "启用工具",
        warning: true
      }))
    ) {
      return;
    }
    this.plugin.settings.sandboxMode = value;
    if (value === "edit" || value === "full-agent" || value === "workspace-write") {
      this.plugin.settings.acknowledgedToolRisk = true;
    }
    await this.plugin.saveSettings();
    this.plugin.refreshOpenModelControls();
  }

  addPickerSetting(containerEl, name, icon, label, onClick) {
    const buttonEl = containerEl.createEl("button", {
      cls: `clickable-icon pi-agent-run-setting pi-agent-run-setting-${name.toLowerCase()}`,
      attr: {
        "aria-label": STRINGS.controls.label(STRINGS.controls[name.toLowerCase()], label),
        title: STRINGS.controls.label(STRINGS.controls[name.toLowerCase()], label)
      }
    });
    const iconEl = buttonEl.createSpan({ cls: "pi-agent-run-setting-icon" });
    const labelEl = buttonEl.createSpan({ cls: "pi-agent-control-label", text: label });
    const control = { buttonEl, iconEl, labelEl, iconKey: "" };
    this.controls[name] = control;
    this.renderControlIcon(iconEl, icon, control);
    buttonEl.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await onClick(event);
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
      }
    });
  }

  renderControlIcon(iconEl, icon, control) {
    if (!control) return;
    const key = icon?.provider ? `provider:${icon.provider}` : `icon:${icon}`;
    if (control.iconKey === key && iconEl.childElementCount > 0) return;
    control.iconKey = key;
    iconEl.empty();
    if (icon?.provider) renderProviderIcon(iconEl, icon.provider);
    else setIcon(iconEl, icon);
  }

  getModelLabel() {
    if (this.plugin.settings.model === CUSTOM_MODEL_VALUE) {
      return this.plugin.settings.customModel.trim() || "自定义模型";
    }
    const model = getSelectedModelInfo(this.plugin.settings);
    if (model) return model.displayName;
    const effective = this.plugin.settings.availableModels.find(
      (candidate) => candidate.slug === this.plugin.settings.effectiveModel
    );
    return effective?.displayName || this.plugin.settings.effectiveModel || "Pi 默认";
  }

  getModelProvider() {
    if (this.plugin.settings.model === CUSTOM_MODEL_VALUE) {
      return this.plugin.settings.customModel.split("/")[0];
    }
    const selected = getSelectedModelInfo(this.plugin.settings);
    const effective = this.plugin.settings.availableModels.find(
      (candidate) => candidate.slug === this.plugin.settings.effectiveModel
    );
    return (
      selected?.provider ||
      selected?.slug?.split("/")[0] ||
      effective?.provider ||
      effective?.slug?.split("/")[0] ||
      this.plugin.settings.effectiveModel.split("/")[0]
    );
  }

  getToolModeLabel() {
    return formatToolModeLabel(this.plugin.settings.sandboxMode);
  }

  getToolModeIcon() {
    const mode = this.plugin.settings.sandboxMode;
    return mode === "chat"
      ? "message-square"
      : mode === "edit" || mode === "workspace-write"
        ? "pencil"
        : mode === "full-agent"
          ? "terminal"
          : "book-open";
  }

  formatDefaultReasoningLabel() {
    const reasoning = getResolvedReasoning(this.plugin.settings);
    return reasoning === "pi-default" ? "加载思考级别…" : formatReasoningLevel(reasoning);
  }
}
