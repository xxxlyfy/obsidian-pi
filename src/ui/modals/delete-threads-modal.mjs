import { Modal } from "obsidian";
import { STRINGS } from "../../shared/strings.mjs";

export function chooseBulkThreadDeletion(app, plan) {
  return new Promise((resolve) => new DeleteThreadsModal(app, plan, resolve).open());
}

export function getBulkThreadDeletionChoices(plan) {
  return [
    {
      id: "except-favorites",
      label: STRINGS.modals.deleteAllExceptFavorites(plan.exceptFavorites.deleteCount),
      disabled: plan.exceptFavorites.deleteCount === 0
    },
    {
      id: "all",
      label: STRINGS.modals.deleteAllChats(plan.all.deleteCount),
      disabled: plan.all.deleteCount === 0
    }
  ];
}

export class DeleteThreadsModal extends Modal {
  constructor(app, plan, resolve) {
    super(app);
    this.plan = plan;
    this.resolve = resolve;
    this.choice = "cancel";
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: STRINGS.modals.deleteChatsTitle });
    this.contentEl.createEl("p", {
      text: STRINGS.modals.deleteChatsDescription
    });

    if (this.plan.favoriteCount > 0) {
      this.contentEl.createEl("p", {
        text: STRINGS.modals.favoriteProtected(this.plan.favoriteCount)
      });
    }
    if (this.plan.all.skippedCount > 0) {
      this.contentEl.createEl("p", {
        text: STRINGS.modals.activeRunBlocked(this.plan.all.skippedCount)
      });
    }

    const actions = this.contentEl.createDiv({ cls: "pi-agent-modal-actions" });
    this.addButton(actions, STRINGS.common.cancel, "cancel");
    for (const choice of getBulkThreadDeletionChoices(this.plan))
      this.addButton(actions, choice.label, choice.id, choice.disabled);
  }

  addButton(container, label, choice, disabled = false) {
    const button = container.createEl("button", {
      text: label,
      ...(disabled ? { attr: { disabled: "" } } : {})
    });
    if (choice !== "cancel") button.addClass("mod-warning");
    button.addEventListener("click", () => {
      if (disabled) return;
      this.choice = choice;
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
    this.resolve(this.choice);
  }
}
