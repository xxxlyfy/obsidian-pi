import { FuzzySuggestModal, Notice, SuggestModal } from "obsidian";
import {
  getLocalizedReasoningLabel,
  getLocalizedReasoningOptions,
  getReasoningOptions,
  getResolvedReasoning
} from "../../plugin/settings.mjs";
import { t } from "../../shared/i18n/index.mjs";
import {
  buildModelPickerItems,
  getModelPickerPrimary,
  getModelPickerSecondary
} from "../model-picker.mjs";
import { renderProviderIcon } from "../provider-icons.mjs";

// Modals opened from the Pi Agent settings tab follow the app language. Instances
// opened from the chat composer keep English until that surface is localized too.
function createText(localize) {
  return (key, params) => t(key, params, localize ? undefined : "en");
}

export class ModelPickerModal extends FuzzySuggestModal {
  constructor(app, settings, onChoose, options = {}) {
    super(app);
    this.settings = settings;
    this.onChoose = onChoose;
    this.localize = options.localize === true;
    this.text = createText(this.localize);
    this.limit = 1000;
    this.emptyStateText = this.text("modelPicker.empty");
    this.setPlaceholder(this.text("modelPicker.placeholder"));
    this.setInstructions([
      { command: "↑↓", purpose: this.text("picker.navigate") },
      { command: "↵", purpose: this.text("picker.select") },
      { command: "esc", purpose: this.text("picker.close") }
    ]);
  }

  getItems() {
    return buildModelPickerItems(this.settings);
  }

  getItemText(item) {
    return `${getModelPickerPrimary(item)} ${getModelPickerSecondary(item)}`;
  }

  renderSuggestion(match, el) {
    const item = match.item;
    const primary = getModelPickerPrimary(item);
    const secondary = getModelPickerSecondary(item);
    const row = el.createDiv({ cls: "pi-agent-model-suggestion" });
    renderProviderIcon(row, item.model);
    const copy = row.createDiv({ cls: "pi-agent-model-suggestion-copy" });
    copy.createDiv({ cls: "pi-agent-suggestion-title", text: primary });
    copy.createDiv({ cls: "pi-agent-suggestion-detail", text: secondary });
    el.setAttribute(
      "aria-label",
      `${primary}, ${secondary}${
        this.settings.model === item.value ? `, ${this.text("picker.selected")}` : ""
      }`
    );
  }

  onChooseItem(item) {
    Promise.resolve(this.onChoose(item.value)).catch((error) => {
      new Notice(error instanceof Error ? error.message : String(error));
    });
  }
}

export class ThinkingPickerModal extends SuggestModal {
  constructor(app, settings, onChoose, options = {}) {
    super(app);
    this.settings = settings;
    this.onChoose = onChoose;
    this.localize = options.localize === true;
    this.text = createText(this.localize);
    this.emptyStateText = this.text("thinkingPicker.empty");
    this.setPlaceholder(this.text("thinkingPicker.placeholder"));
    this.setInstructions([
      { command: "↑↓", purpose: this.text("picker.navigate") },
      { command: "↵", purpose: this.text("picker.select") },
      { command: "esc", purpose: this.text("picker.close") }
    ]);
  }

  getSuggestions(query) {
    const normalized = query.trim().toLowerCase();
    return this.getItems().filter((item) =>
      `${item.primary} ${item.secondary}`.toLowerCase().includes(normalized)
    );
  }

  getItems() {
    const options = this.localize
      ? getLocalizedReasoningOptions(this.settings)
      : getReasoningOptions(this.settings);
    return Object.entries(options).flatMap(([value, label]) => {
      const resolved = value === "" ? getResolvedReasoning(this.settings) : "";
      if (value === "" && (resolved === "pi-default" || resolved === "cli-default")) return [];
      return [
        {
          value,
          primary: value === "" ? this.formatReasoningPrimary(resolved) : label,
          secondary:
            value === ""
              ? this.text("picker.effectiveFor", { model: formatEffectiveModel(this.settings) })
              : ""
        }
      ];
    });
  }

  renderSuggestion(item, el) {
    el.createDiv({ cls: "pi-agent-suggestion-title", text: item.primary });
    if (item.secondary) {
      el.createDiv({ cls: "pi-agent-suggestion-detail", text: item.secondary });
    }
    el.setAttribute(
      "aria-label",
      `${item.primary}${item.secondary ? `, ${item.secondary}` : ""}${
        this.settings.reasoningEffort === item.value ? `, ${this.text("picker.selected")}` : ""
      }`
    );
  }

  onChooseSuggestion(item) {
    Promise.resolve(this.onChoose(item.value)).catch((error) => {
      new Notice(error instanceof Error ? error.message : String(error));
    });
  }

  formatReasoningPrimary(value) {
    return this.localize
      ? getLocalizedReasoningLabel(value, { short: true })
      : formatReasoningLabel(value);
  }
}

function formatEffectiveModel(settings) {
  const slug = settings.model || settings.effectiveModel;
  const model = settings.availableModels.find((candidate) => candidate.slug === slug);
  return model?.displayName || slug;
}

function formatReasoningLabel(value) {
  if (value === "xhigh") return "XHigh";
  return value.charAt(0).toUpperCase() + value.slice(1);
}
