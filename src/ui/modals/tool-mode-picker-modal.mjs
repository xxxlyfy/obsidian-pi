import { Notice, SuggestModal } from "obsidian";
import { getLocalizedToolModePickerItems } from "../../plugin/settings.mjs";
import { t } from "../../shared/i18n/index.mjs";

export class ToolModePickerModal extends SuggestModal {
  constructor(app, settings, onChoose) {
    super(app);
    this.settings = settings;
    this.onChoose = onChoose;
    this.emptyStateText = t("toolModePicker.empty");
    this.setPlaceholder(t("toolModePicker.placeholder"));
    this.setInstructions([
      { command: "↑↓", purpose: t("picker.navigate") },
      { command: "↵", purpose: t("picker.select") },
      { command: "esc", purpose: t("picker.close") }
    ]);
  }

  getSuggestions(query) {
    const normalized = query.trim().toLowerCase();
    return this.getItems().filter((item) =>
      `${item.primary} ${item.secondary}`.toLowerCase().includes(normalized)
    );
  }

  getItems() {
    return getLocalizedToolModePickerItems();
  }

  renderSuggestion(item, el) {
    el.createDiv({ cls: "pi-agent-suggestion-title", text: item.primary });
    if (item.secondary) {
      el.createDiv({ cls: "pi-agent-suggestion-detail", text: item.secondary });
    }
    el.setAttribute(
      "aria-label",
      `${item.primary}${item.secondary ? `, ${item.secondary}` : ""}${
        this.settings.sandboxMode === item.value ? `, ${t("picker.selected")}` : ""
      }`
    );
  }

  onChooseSuggestion(item) {
    Promise.resolve(this.onChoose(item.value)).catch((error) => {
      new Notice(error instanceof Error ? error.message : String(error));
    });
  }
}
