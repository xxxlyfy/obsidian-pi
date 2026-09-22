import { Notice, PluginSettingTab, Setting } from "obsidian";
import {
  CUSTOM_MODEL_VALUE,
  getReasoningOptions,
  getResolvedReasoning,
  getSelectedModelInfo,
  getToolModeOptions
} from "./settings.mjs";
import { normalizeSkillFolderList } from "../context/skills.mjs";
import { confirmWithModal } from "../ui/modals/confirm-modal.mjs";
import { ModelPickerModal, ThinkingPickerModal } from "../ui/modals/model-picker-modal.mjs";
import { requestDesktopNotificationPermission } from "../ui/desktop-notifications.mjs";

export class PiAgentSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;

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
      this.getCustomInstructionsDefinition(),
      {
        type: "group",
        heading: "高级",
        items: [this.getCustomModelDefinition()]
      },
      {
        type: "group",
        heading: "Pi CLI",
        items: [this.getPiExecutableDefinition(), this.getPiInstallationDefinition()]
      },
      {
        type: "group",
        heading: "技能",
        items: [this.getDefaultSkillsDefinition(), this.getAdditionalSkillsDefinition()]
      },
      {
        type: "group",
        heading: "上下文与文件访问",
        items: [this.getIgnoredFoldersDefinition()]
      }
    ];
  }

  // Obsidian 1.12.3 and earlier render settings imperatively. On newer versions,
  // callers in the plugin may still request a refresh through display(), so route
  // those calls to the declarative update API instead of replacing its DOM.
  display() {
    if (typeof this.update === "function") {
      this.update();
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
      name: "模型",
      desc: "来自 Pi 内置及自定义模型注册表的「提供商/模型」。选择默认将遵循 ~/.pi/agent/settings.json 或 .pi/settings.json。",
      render: (setting) =>
        setting
          .addButton((button) =>
            button
              .setButtonText(this.getModelButtonLabel())
              .setTooltip("选择模型")
              .onClick(async () => {
                const label = this.getModelButtonLabel();
                button.setButtonText("加载中…");
                button.setDisabled(true);
                try {
                  await this.plugin.models.ensureLoaded();
                  new ModelPickerModal(this.app, this.plugin.settings, async (value) => {
                    this.plugin.settings.model = value;
                    this.plugin.settings.reasoningEffort = "";
                    await this.plugin.saveSettings();
                    this.plugin.refreshOpenModelControls();
                  }).open();
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
              .setButtonText("刷新")
              .setTooltip("从 Pi 刷新模型")
              .onClick(async () => {
                button.setButtonText("刷新中…");
                button.setDisabled(true);
                try {
                  await this.plugin.models.refresh(true);
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
      name: "思考级别",
      desc: "仅控制推理强度。可选值由 Pi 返回的所选模型决定。",
      render: (setting) =>
        setting.addButton((button) =>
          button
            .setButtonText(this.getReasoningButtonLabel())
            .setTooltip("选择思考级别")
            .onClick(async () => {
              const label = this.getReasoningButtonLabel();
              button.setButtonText("加载中…");
              button.setDisabled(true);
              try {
                await this.plugin.models.ensureLoaded();
                new ThinkingPickerModal(this.app, this.plugin.settings, async (value) => {
                  this.plugin.settings.reasoningEffort = value;
                  await this.plugin.saveSettings();
                  this.plugin.refreshOpenModelControls();
                }).open();
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
      name: "工具模式",
      desc: "控制启用哪些 Pi CLI 工具。工具模式并非操作系统级沙箱。",
      render: (setting) =>
        setting.addDropdown((dropdown) =>
          dropdown
            .addOptions(getToolModeOptions())
            .setValue(this.plugin.settings.sandboxMode)
            .onChange(async (value) => {
              if (
                (value === "edit" || value === "full-agent" || value === "workspace-write") &&
                !this.plugin.settings.acknowledgedToolRisk &&
                !(await confirmWithModal(this.app, {
                  title: "启用写入工具？",
                  message:
                    "Pi 工具模式并非操作系统级沙箱。编辑和完整智能体模式可以修改库或项目文件，完整智能体模式还可以执行 shell 命令。",
                  confirmText: "启用工具",
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
      name: "桌面完成通知",
      desc: "当 Obsidian 处于非焦点状态且智能体运行结束时发送通知。",
      render: (setting) =>
        setting.addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.desktopNotifications).onChange(async (value) => {
            if (value && !(await requestDesktopNotificationPermission())) {
              new Notice("桌面通知不可用或未获授权。你可以在操作系统的通知设置中启用它们。");
            }
            this.plugin.settings.desktopNotifications = value;
            await this.plugin.saveSettings();
          })
        )
    };
  }

  getCustomInstructionsDefinition() {
    return {
      name: "自定义指令",
      desc: "添加到每次 Pi 运行中的、针对当前库的指令。",
      render: (setting) =>
        setting.addTextArea((text) =>
          text
            .setPlaceholder("优先使用 PARA 文件夹。保持项目笔记简洁。")
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
      name: "自定义模型标识",
      desc: "当 Pi 的模型目录中没有所需的「提供商/模型」标识时使用的备用项。自定义标识只能在此处选用。",
      render: (setting) => {
        let useCustomButton;
        setting
          .addText((text) =>
            text
              .setPlaceholder("提供商/模型")
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
                this.plugin.settings.model === CUSTOM_MODEL_VALUE ? "使用中" : "使用自定义"
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
      name: "Pi 可执行文件路径",
      desc: "可选的 Pi CLI 路径。留空则自动检测常见安装位置。支持 ~ 以及诸如 ${USER} 的环境变量。",
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
      name: "检查 Pi 安装",
      desc: "验证 Obsidian 能否在当前环境中运行 Pi CLI。",
      render: (setting) =>
        setting.addButton((button) =>
          button.setButtonText("检查").onClick(() => {
            void this.plugin.checkPiInstallation(true);
          })
        )
    };
  }

  getDefaultSkillsDefinition() {
    return {
      name: "包含 Pi 默认技能",
      desc: "加载 Pi 从全局及库或项目技能位置发现的技能。关闭后仅使用下方的附加技能文件夹。",
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
      name: "附加技能文件夹",
      desc: "每行一个受信任的技能文件或文件夹，支持绝对路径和库相对路径。",
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
      name: "忽略的文件夹/目录",
      desc: "以逗号分隔的文件夹前缀；Pi 在预附加上下文和检索时会忽略这些目录。",
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
      return this.plugin.settings.customModel || "自定义模型";
    }
    const selected = getSelectedModelInfo(this.plugin.settings);
    if (selected) return selected.displayName;
    const effective = this.plugin.settings.availableModels.find(
      (model) => model.slug === this.plugin.settings.effectiveModel
    );
    return effective?.displayName || this.plugin.settings.effectiveModel || "Pi 默认";
  }

  getReasoningButtonLabel() {
    const options = this.getReasoningOptions();
    const value = this.getReasoningDropdownValue();
    if (value) return options[value] || value;
    const resolved = getResolvedReasoning(this.plugin.settings);
    return resolved === "pi-default" ? "加载思考级别…" : options[""] || resolved;
  }

  getReasoningOptions() {
    return getReasoningOptions(this.plugin.settings);
  }

  getReasoningDropdownValue() {
    const options = this.getReasoningOptions();
    const value = this.plugin.settings.reasoningEffort;
    return Object.prototype.hasOwnProperty.call(options, value) ? value : "";
  }
}
