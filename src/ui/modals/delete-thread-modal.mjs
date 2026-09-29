import { Modal } from "obsidian";
import { t } from "../../shared/i18n/index.mjs";

export function chooseThreadDeletion(app, thread) {
  return new Promise((resolve) => new DeleteThreadModal(app, thread, resolve).open());
}

export function getThreadDeletionChoices(thread) {
  return thread?.piSessionId ? ["cancel", "chat", "both"] : ["cancel", "chat"];
}

export class DeleteThreadModal extends Modal {
  constructor(app, thread, resolve) {
    super(app);
    this.thread = thread;
    this.resolve = resolve;
    this.choice = "cancel";
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: t("deleteThread.title") });
    this.contentEl.createEl("p", {
      text: this.thread.piSessionId
        ? t("deleteThread.keepSession", { title: this.thread.title })
        : t("deleteThread.remove", { title: this.thread.title })
    });

    const actions = this.contentEl.createDiv({ cls: "pi-agent-modal-actions" });
    const labels = {
      cancel: t("common.cancel"),
      chat: t("deleteThread.chatOnly"),
      both: t("deleteThread.both")
    };
    for (const choice of getThreadDeletionChoices(this.thread))
      this.addButton(actions, labels[choice], choice);
  }

  addButton(container, label, choice) {
    const button = container.createEl("button", { text: label });
    if (choice === "both") button.addClass("mod-warning");
    button.addEventListener("click", () => {
      this.choice = choice;
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
    this.resolve(this.choice);
  }
}
