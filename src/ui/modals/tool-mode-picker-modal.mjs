import { Notice, SuggestModal } from "obsidian";
import { getToolModePickerItems } from "../../plugin/settings.mjs";

export class ToolModePickerModal extends SuggestModal {
  constructor(app, settings, onChoose) {
    super(app);
    this.settings = settings;
    this.onChoose = onChoose;
    this.emptyStateText = "No tool modes available.";
    this.setPlaceholder("Choose tool mode…");
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "select" },
      { command: "esc", purpose: "close" }
    ]);
  }

  getSuggestions(query) {
    const normalized = query.trim().toLowerCase();
    return this.getItems().filter((item) =>
      `${item.primary} ${item.secondary}`.toLowerCase().includes(normalized)
    );
  }

  getItems() {
    return getToolModePickerItems();
  }

  renderSuggestion(item, el) {
    el.createDiv({ cls: "pi-agent-suggestion-title", text: item.primary });
    if (item.secondary) {
      el.createDiv({ cls: "pi-agent-suggestion-detail", text: item.secondary });
    }
    el.setAttribute(
      "aria-label",
      `${item.primary}${item.secondary ? `, ${item.secondary}` : ""}${
        this.settings.sandboxMode === item.value ? ", selected" : ""
      }`
    );
  }

  onChooseSuggestion(item) {
    Promise.resolve(this.onChoose(item.value)).catch((error) => {
      new Notice(error instanceof Error ? error.message : String(error));
    });
  }
}
