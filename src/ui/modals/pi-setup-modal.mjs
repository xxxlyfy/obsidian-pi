import { Modal, Notice, Setting } from "obsidian";
import { t } from "../../shared/i18n/index.mjs";

const INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent";

export class PiSetupModal extends Modal {
  constructor(plugin, health) {
    super(plugin.app);
    this.plugin = plugin;
    this.health = health;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(t("setup.heading")).setHeading();
    contentEl.createEl("p", {
      text: this.health?.message ?? t("setup.missing")
    });
    const needsNode = this.health?.kind === "node-missing";
    contentEl.createEl("p", {
      text: needsNode ? t("setup.needsNode") : t("setup.installSteps")
    });
    const commandText = needsNode
      ? "node --version\npi --version"
      : `${INSTALL_COMMAND}\npi --version`;
    contentEl.createEl("pre", { text: commandText });
    contentEl.createEl("p", {
      text: t("setup.modeHint")
    });

    const actionsEl = contentEl.createDiv({ cls: "pi-agent-modal-actions" });
    actionsEl
      .createEl("button", {
        text: needsNode ? t("setup.copyDiagnostic") : t("setup.copyInstall")
      })
      .addEventListener("click", async () => {
        await navigator.clipboard.writeText(needsNode ? commandText : INSTALL_COMMAND);
        new Notice(needsNode ? t("setup.copiedDiagnostic") : t("setup.copiedInstall"));
      });
    actionsEl
      .createEl("button", { text: t("setup.dismiss") })
      .addEventListener("click", async () => {
        this.plugin.settings.dismissedPiSetup = true;
        await this.plugin.saveSettings();
        this.close();
      });
    actionsEl
      .createEl("button", { text: t("setup.close"), cls: "mod-cta" })
      .addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}
