import { Notice, PluginSettingTab, Setting } from "obsidian";
import {
  CUSTOM_MODEL_VALUE,
  getLocalizedReasoningLabel,
  getLocalizedReasoningOptions,
  getLocalizedToolModeOptions,
  getResolvedReasoning,
  getSelectedModelInfo
} from "./settings.mjs";
import { normalizeSkillFolderList } from "../context/skills.mjs";
import { t } from "../shared/i18n/index.mjs";
import { confirmWithModal } from "../ui/modals/confirm-modal.mjs";
import { ModelPickerModal, ThinkingPickerModal } from "../ui/modals/model-picker-modal.mjs";
import { requestDesktopNotificationPermission } from "../ui/desktop-notifications.mjs";
import { refreshUiLanguage } from "./ui-language.mjs";

export class PiAgentSettingTab extends PluginSettingTab {
  /**
   * @param {import("obsidian").App} app
   * @param {import("./PiAgentPlugin.mjs").PiAgentPlugin} plugin
   */
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    refreshUiLanguage();

    const configDir = app.vault.configDir;
    if (configDir && !plugin.settings.ignoredFolders.includes(configDir)) {
      plugin.settings.ignoredFolders.unshift(configDir);
    }
  }

  // Obsidian 1.13.0+ uses these definitions for rendering and settings search.
  // Keeping display() below is the documented dual-support pattern for Obsidian 1.12.3.
  getSettingDefinitions() {
    return [
      this.getModelDefinition(),
      this.getThinkingDefinition(),
      this.getToolModeDefinition(),
      this.getDesktopNotificationsDefinition(),
      this.getExtensionStatusDefinition(),
      this.getCustomInstructionsDefinition(),
      {
        type: "group",
        heading: t("settings.group.advanced"),
        items: [this.getCustomModelDefinition()]
      },
      {
        type: "group",
        heading: t("settings.group.piCli"),
        items: [this.getPiExecutableDefinition(), this.getPiInstallationDefinition()]
      },
      {
        type: "group",
        heading: t("settings.group.skills"),
        items: [this.getDefaultSkillsDefinition(), this.getAdditionalSkillsDefinition()]
      },
      {
        type: "group",
        heading: t("settings.group.context"),
        items: [this.getIgnoredFoldersDefinition()]
      }
    ];
  }

  // Obsidian 1.12.3 and earlier render settings imperatively. On newer versions,
  // callers in the plugin may still request a refresh through display(), so route
  // those calls to the declarative update API instead of replacing its DOM.
  display() {
    // Present only on Obsidian builds that render settings declaratively.
    const declarativeUpdate = /** @type {any} */ (this).update;
    if (typeof declarativeUpdate === "function") {
      declarativeUpdate.call(this);
      return;
    }

    const { containerEl } = this;
    containerEl.empty();
    for (const definition of this.getSettingDefinitions()) {
      if (definition.type === "group") {
        new Setting(containerEl).setName(definition.heading).setHeading();
        for (const item of definition.items ?? []) this.renderLegacyDefinition(containerEl, item);
      } else {
        this.renderLegacyDefinition(containerEl, definition);
      }
    }
  }

  renderLegacyDefinition(containerEl, definition) {
    const setting = new Setting(containerEl).setName(definition.name);
    if (definition.desc) setting.setDesc(definition.desc);
    definition.render?.(setting);
  }

  getModelDefinition() {
    return {
      name: t("settings.model.name"),
      desc: t("settings.model.desc"),
      render: (setting) =>
        setting
          .addButton((button) =>
            button
              .setButtonText(this.getModelButtonLabel())
              .setTooltip(t("settings.model.chooseTooltip"))
              .onClick(async () => {
                const label = this.getModelButtonLabel();
                button.setButtonText(t("common.loading"));
                button.setDisabled(true);
                try {
                  await this.plugin.ensureRuntimeModelState();
                  new ModelPickerModal(
                    this.app,
                    this.plugin.settings,
                    async (value) => {
                      this.plugin.settings.model = value;
                      this.plugin.settings.reasoningEffort = "";
                      await this.plugin.saveSettings();
                      this.plugin.refreshOpenModelControls();
                    },
                    { localize: true }
                  ).open();
                } catch (error) {
                  new Notice(error instanceof Error ? error.message : String(error));
                } finally {
                  button.setButtonText(label);
                  button.setDisabled(false);
                }
              })
          )
          .addButton((button) =>
            button
              .setButtonText(t("settings.model.refresh"))
              .setTooltip(t("settings.model.refreshTooltip"))
              .onClick(async () => {
                button.setButtonText(t("settings.model.refreshing"));
                button.setDisabled(true);
                try {
                  await this.plugin.refreshModelCatalog(true);
                } catch (error) {
                  new Notice(error instanceof Error ? error.message : String(error));
                }
                this.display();
              })
          )
    };
  }

  getThinkingDefinition() {
    return {
      name: t("settings.thinking.name"),
      desc: t("settings.thinking.desc"),
      render: (setting) =>
        setting.addButton((button) =>
          button
            .setButtonText(this.getReasoningButtonLabel())
            .setTooltip(t("settings.thinking.chooseTooltip"))
            .onClick(async () => {
              const label = this.getReasoningButtonLabel();
              button.setButtonText(t("common.loading"));
              button.setDisabled(true);
              try {
                await this.plugin.ensureRuntimeModelState();
                new ThinkingPickerModal(
                  this.app,
                  this.plugin.settings,
                  async (value) => {
                    this.plugin.settings.reasoningEffort = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshOpenModelControls();
                  },
                  { localize: true }
                ).open();
              } catch (error) {
                new Notice(error instanceof Error ? error.message : String(error));
              } finally {
                button.setButtonText(label);
                button.setDisabled(false);
              }
            })
        )
    };
  }

  getToolModeDefinition() {
    return {
      name: t("settings.toolMode.name"),
      desc: t("settings.toolMode.desc"),
      render: (setting) =>
        setting.addDropdown((dropdown) =>
          dropdown
            .addOptions(getLocalizedToolModeOptions())
            .setValue(this.plugin.settings.sandboxMode)
            .onChange(async (value) => {
              if (
                (value === "edit" || value === "full-agent" || value === "workspace-write") &&
                !this.plugin.settings.acknowledgedToolRisk &&
                !(await confirmWithModal(this.app, {
                  title: t("confirm.writeTools.title"),
                  message: t("confirm.writeTools.message"),
                  confirmText: t("confirm.writeTools.confirm"),
                  cancelText: t("common.cancel"),
                  warning: true
                }))
              ) {
                this.display();
                return;
              }

              this.plugin.settings.sandboxMode = value;
              if (value === "edit" || value === "full-agent" || value === "workspace-write") {
                this.plugin.settings.acknowledgedToolRisk = true;
              }
              await this.plugin.saveSettings();
            })
        )
    };
  }

  getDesktopNotificationsDefinition() {
    return {
      name: t("settings.desktopNotifications.name"),
      desc: t("settings.desktopNotifications.desc"),
      render: (setting) =>
        setting.addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.desktopNotifications).onChange(async (value) => {
            if (value && !(await requestDesktopNotificationPermission())) {
              new Notice(t("settings.desktopNotifications.unavailable"));
            }
            this.plugin.settings.desktopNotifications = value;
            await this.plugin.saveSettings();
          })
        )
    };
  }

  getExtensionStatusDefinition() {
    return {
      name: t("settings.extensionStatus.name"),
      desc: t("settings.extensionStatus.desc"),
      render: (setting) =>
        setting.addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.showExtensionStatus)
            .onChange((value) => this.plugin.setShowExtensionStatus(value))
        )
    };
  }

  getCustomInstructionsDefinition() {
    return {
      name: t("settings.customInstructions.name"),
      desc: t("settings.customInstructions.desc"),
      render: (setting) =>
        setting.addTextArea((text) =>
          text
            .setPlaceholder(t("settings.customInstructions.placeholder"))
            .setValue(this.plugin.settings.customInstructions)
            .onChange(async (value) => {
              this.plugin.settings.customInstructions = value;
              await this.plugin.saveSettings();
            })
        )
    };
  }

  getCustomModelDefinition() {
    return {
      name: t("settings.customModel.name"),
      desc: t("settings.customModel.desc"),
      render: (setting) => {
        let useCustomButton;
        setting
          .addText((text) =>
            text
              .setPlaceholder(t("settings.customModel.placeholder"))
              .setValue(this.plugin.settings.customModel)
              .onChange(async (value) => {
                this.plugin.settings.customModel = value.trim();
                useCustomButton?.setDisabled(!this.plugin.settings.customModel);
                await this.plugin.saveSettings();
              })
          )
          .addButton((button) => {
            useCustomButton = button;
            button
              .setButtonText(
                this.plugin.settings.model === CUSTOM_MODEL_VALUE
                  ? t("settings.customModel.using")
                  : t("settings.customModel.use")
              )
              .setDisabled(!this.plugin.settings.customModel)
              .onClick(async () => {
                this.plugin.settings.model = CUSTOM_MODEL_VALUE;
                this.plugin.settings.reasoningEffort = "";
                await this.plugin.saveSettings();
                this.plugin.refreshOpenModelControls();
              });
          });
      }
    };
  }

  getPiExecutableDefinition() {
    return {
      name: t("settings.piExecutable.name"),
      desc: t("settings.piExecutable.desc"),
      render: (setting) =>
        setting.addText((text) =>
          text
            .setPlaceholder("/etc/profiles/per-user/${USER}/bin/pi")
            .setValue(this.plugin.settings.piExecutablePath)
            .onChange(async (value) => {
              this.plugin.settings.piExecutablePath = value.trim();
              await this.plugin.saveSettings();
            })
        )
    };
  }

  getPiInstallationDefinition() {
    return {
      name: t("settings.checkInstall.name"),
      desc: t("settings.checkInstall.desc"),
      render: (setting) =>
        setting.addButton((button) =>
          button.setButtonText(t("settings.checkInstall.button")).onClick(() => {
            this.plugin.checkPiInstallation(true);
          })
        )
    };
  }

  getDefaultSkillsDefinition() {
    return {
      name: t("settings.defaultSkills.name"),
      desc: t("settings.defaultSkills.desc"),
      render: (setting) =>
        setting.addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.includeDefaultSkills !== false)
            .onChange(async (value) => {
              this.plugin.settings.includeDefaultSkills = value;
              await this.plugin.saveSettings();
            })
        )
    };
  }

  getAdditionalSkillsDefinition() {
    return {
      name: t("settings.skillFolders.name"),
      desc: t("settings.skillFolders.desc"),
      render: (setting) =>
        setting.addTextArea((text) =>
          text
            .setPlaceholder([".pi/skills", "/path/to/my-skills"].join("\n"))
            .setValue(
              normalizeSkillFolderList(this.plugin.settings.additionalSkillFolders).join("\n")
            )
            .onChange(async (value) => {
              this.plugin.settings.additionalSkillFolders = value
                .split(/\r?\n/)
                .map((item) => item.trim())
                .filter(Boolean);
              await this.plugin.saveSettings();
            })
        )
    };
  }

  getIgnoredFoldersDefinition() {
    return {
      name: t("settings.ignoredFolders.name"),
      desc: t("settings.ignoredFolders.desc"),
      render: (setting) =>
        setting.addTextArea((text) =>
          text
            .setPlaceholder([this.app.vault.configDir, ".git", "node_modules"].join(", "))
            .setValue(this.plugin.settings.ignoredFolders.join(", "))
            .onChange(async (value) => {
              this.plugin.settings.ignoredFolders = value
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean);
              await this.plugin.saveSettings();
            })
        )
    };
  }

  getModelButtonLabel() {
    if (this.plugin.settings.model === CUSTOM_MODEL_VALUE) {
      return this.plugin.settings.customModel || t("settings.model.customFallback");
    }
    const selected = getSelectedModelInfo(this.plugin.settings);
    if (selected) return selected.displayName;
    const effective = this.plugin.settings.availableModels.find(
      (model) => model.slug === this.plugin.settings.effectiveModel
    );
    return (
      effective?.displayName || this.plugin.settings.effectiveModel || t("settings.model.piDefault")
    );
  }

  getReasoningButtonLabel() {
    const value = this.getReasoningDropdownValue();
    if (value) return this.getReasoningOptions()[value] || value;
    const resolved = getResolvedReasoning(this.plugin.settings);
    return resolved === "pi-default"
      ? t("common.loadingThinking")
      : getLocalizedReasoningLabel(resolved, { short: true });
  }

  getReasoningOptions() {
    return getLocalizedReasoningOptions(this.plugin.settings);
  }

  getReasoningDropdownValue() {
    const options = this.getReasoningOptions();
    const value = this.plugin.settings.reasoningEffort;
    return Object.prototype.hasOwnProperty.call(options, value) ? value : "";
  }
}
