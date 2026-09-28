import { Notice, setIcon } from "obsidian";
import {
  CUSTOM_MODEL_VALUE,
  getResolvedReasoning,
  getSelectedModelInfo,
  getToolModeShortLabel
} from "../plugin/settings.mjs";
import { ModelPickerModal, ThinkingPickerModal } from "./modals/model-picker-modal.mjs";
import { ToolModePickerModal } from "./modals/tool-mode-picker-modal.mjs";
import { confirmWithModal } from "./modals/confirm-modal.mjs";
import { renderProviderIcon } from "./provider-icons.mjs";

export class RunSettingsControls {
  constructor(plugin) {
    this.plugin = plugin;
  }

  render(containerEl) {
    this.row = containerEl.createDiv({ cls: "pi-agent-run-settings" });
    this.populate(this.row);
  }

  refresh() {
    if (!this.row) return;
    this.row.empty();
    this.populate(this.row);
  }

  populate(containerEl) {
    this.addPickerSetting(
      containerEl,
      "Model",
      { provider: this.getModelProvider() },
      this.getModelLabel(),
      async () => {
        await this.openPicker(ModelPickerModal, async (value) => {
          this.plugin.settings.model = value;
          this.plugin.settings.reasoningEffort = "";
          await this.plugin.saveSettings();
          this.plugin.refreshOpenModelControls();
        });
      }
    );

    this.addPickerSetting(
      containerEl,
      "Think",
      "brain",
      this.formatDefaultReasoningLabel(),
      async () => {
        await this.openPicker(ThinkingPickerModal, async (value) => {
          this.plugin.settings.reasoningEffort = value;
          await this.plugin.saveSettings();
          this.plugin.refreshOpenModelControls();
        });
      }
    );

    this.addPickerSetting(
      containerEl,
      "Tool mode",
      this.getToolModeIcon(),
      getToolModeShortLabel(this.plugin.settings.sandboxMode),
      async () => {
        new ToolModePickerModal(this.plugin.app, this.plugin.settings, async (value) => {
          await this.applyToolMode(value);
        }).open();
      },
      this.getToolModeClass()
    );
  }

  addPickerSetting(containerEl, name, icon, label, onClick, extraClass) {
    const buttonEl = containerEl.createEl("button", {
      cls: `clickable-icon pi-agent-run-setting${extraClass ? ` ${extraClass}` : ""}`,
      attr: { "aria-label": `${name}: ${label}`, title: `${name}: ${label}` }
    });
    // Provider objects must never reach setIcon, which expects a string name
    // (an empty provider used to throw `startsWith is not a function`).
    if (icon && typeof icon === "object") renderProviderIcon(buttonEl, icon.provider);
    else setIcon(buttonEl, icon);
    const labelEl = buttonEl.createSpan({ cls: "pi-agent-control-label", text: label });
    buttonEl.addEventListener("click", async (event) => {
      event.preventDefault();
      buttonEl.disabled = true;
      labelEl.setText("Loading…");
      try {
        await onClick();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
      } finally {
        if (buttonEl.isConnected) {
          buttonEl.disabled = false;
          labelEl.setText(label);
        }
      }
    });
  }

  async openPicker(Picker, onChoose) {
    await this.plugin.ensureRuntimeModelState();
    new Picker(this.plugin.app, this.plugin.settings, onChoose).open();
  }

  getModelLabel() {
    if (this.plugin.settings.model === CUSTOM_MODEL_VALUE) {
      return this.plugin.settings.customModel.trim() || "Custom";
    }
    const model = getSelectedModelInfo(this.plugin.settings);
    if (model) return model.displayName;
    const effective = this.plugin.settings.availableModels.find(
      (candidate) => candidate.slug === this.plugin.settings.effectiveModel
    );
    return effective?.displayName || this.plugin.settings.effectiveModel || "Pi default";
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
      (this.plugin.settings.effectiveModel || "").split("/")[0]
    );
  }

  formatDefaultReasoningLabel() {
    const reasoning = getResolvedReasoning(this.plugin.settings);
    return reasoning === "pi-default" ? "Loading thinking…" : this.formatReasoningLabel(reasoning);
  }

  formatReasoningLabel(reasoning) {
    return reasoning === "xhigh" ? "XHigh" : reasoning.charAt(0).toUpperCase() + reasoning.slice(1);
  }

  getToolModeIcon() {
    const mode = this.plugin.settings.sandboxMode;
    if (mode === "chat") return "message-square";
    if (mode === "edit" || mode === "workspace-write") return "file-pen";
    if (mode === "full-agent") return "terminal";
    return "book-open";
  }

  getToolModeClass() {
    const mode = this.plugin.settings.sandboxMode;
    if (mode === "edit" || mode === "workspace-write") return "pi-agent-run-setting-mode-write";
    if (mode === "full-agent") return "pi-agent-run-setting-mode-full";
    return "pi-agent-run-setting-mode-read";
  }

  async applyToolMode(value) {
    const writeModes = ["edit", "full-agent", "workspace-write"];
    if (writeModes.includes(value) && !this.plugin.settings.acknowledgedToolRisk) {
      const confirmed = await confirmWithModal(this.plugin.app, {
        title: "Enable write tools?",
        message:
          "Pi tool modes are not an operating-system sandbox. Edit and full agent can modify vault/project files, and full agent can run shell commands.",
        confirmText: "Enable tools",
        warning: true
      });
      if (!confirmed) return;
    }

    this.plugin.settings.sandboxMode = value;
    if (writeModes.includes(value)) {
      this.plugin.settings.acknowledgedToolRisk = true;
    }
    await this.plugin.saveSettings();
    this.plugin.refreshOpenModelControls();
  }
}
