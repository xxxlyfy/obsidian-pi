import { Modal, Notice, Setting } from "obsidian";
import { STRINGS } from "../../shared/strings.mjs";

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
    new Setting(contentEl).setName(STRINGS.modals.setupHeading).setHeading();
    contentEl.createEl("p", {
      text: this.health?.message ?? STRINGS.modals.setupMissingCli
    });
    const needsNode = this.health?.kind === "node-missing";
    contentEl.createEl("p", {
      text: needsNode ? STRINGS.modals.setupNodeHint : STRINGS.modals.setupPathHint
    });
    const commandText = needsNode
      ? "node --version\npi --version"
      : `${INSTALL_COMMAND}\npi --version`;
    contentEl.createEl("pre", { text: commandText });
    contentEl.createEl("p", {
      text: STRINGS.modals.setupIntro
    });

    const actionsEl = contentEl.createDiv({ cls: "pi-agent-modal-actions" });
    actionsEl
      .createEl("button", {
        text: needsNode ? STRINGS.modals.copyDiagnostics : STRINGS.modals.copyInstall
      })
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(needsNode ? commandText : INSTALL_COMMAND);
          new Notice(needsNode ? STRINGS.modals.copiedDiagnostics : STRINGS.modals.copiedInstall);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
        }
      });
    actionsEl
      .createEl("button", { text: STRINGS.modals.doNotShowAgain })
      .addEventListener("click", async () => {
        this.plugin.settings.dismissedPiSetup = true;
        try {
          await this.plugin.saveSettings();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
        }
        this.close();
      });
    actionsEl
      .createEl("button", { text: STRINGS.common.close, cls: "mod-cta" })
      .addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}
