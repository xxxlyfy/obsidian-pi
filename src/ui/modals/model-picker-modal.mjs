import { FuzzySuggestModal, Notice, SuggestModal } from "obsidian";
import { getReasoningOptions, getResolvedReasoning } from "../../plugin/settings.mjs";
import {
  buildModelPickerItems,
  getModelPickerPrimary,
  getModelPickerSecondary
} from "../model-picker.mjs";
import { renderProviderIcon } from "../provider-icons.mjs";

export class ModelPickerModal extends FuzzySuggestModal {
  constructor(app, settings, onChoose) {
    super(app);
    this.settings = settings;
    this.onChoose = onChoose;
    this.limit = 1000;
    this.emptyStateText = "没有匹配的 Pi 模型。";
    this.setPlaceholder("按名称、提供商、标识或能力搜索模型…");
    this.setInstructions([
      { command: "↑↓", purpose: "导航" },
      { command: "↵", purpose: "选择" },
      { command: "esc", purpose: "关闭" }
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
    const row = el.createDiv({ cls: "pi-agent-model-suggestion" });
    renderProviderIcon(row, item.model);
    const copy = row.createDiv({ cls: "pi-agent-model-suggestion-copy" });
    copy.createDiv({ cls: "pi-agent-suggestion-title", text: getModelPickerPrimary(item) });
    copy.createDiv({ cls: "pi-agent-suggestion-detail", text: getModelPickerSecondary(item) });
    el.setAttribute(
      "aria-label",
      `${getModelPickerPrimary(item)}, ${getModelPickerSecondary(item)}${
        this.settings.model === item.value ? ", 已选中" : ""
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
  constructor(app, settings, onChoose) {
    super(app);
    this.settings = settings;
    this.onChoose = onChoose;
    this.emptyStateText = "Pi 未解析出该模型的思考级别。";
    this.setPlaceholder("选择思考级别…");
    this.setInstructions([
      { command: "↑↓", purpose: "导航" },
      { command: "↵", purpose: "选择" },
      { command: "esc", purpose: "关闭" }
    ]);
  }

  getSuggestions(query) {
    const normalized = query.trim().toLowerCase();
    return this.getItems().filter((item) =>
      `${item.primary} ${item.secondary}`.toLowerCase().includes(normalized)
    );
  }

  getItems() {
    const options = getReasoningOptions(this.settings);
    return Object.entries(options).flatMap(([value, label]) => {
      const resolved = value === "" ? getResolvedReasoning(this.settings) : "";
      if (value === "" && (resolved === "pi-default" || resolved === "cli-default")) return [];
      return [
        {
          value,
          primary: label,
          secondary: value === "" ? `对 ${formatEffectiveModel(this.settings)} 生效` : ""
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
        this.settings.reasoningEffort === item.value ? ", 已选中" : ""
      }`
    );
  }

  onChooseSuggestion(item) {
    Promise.resolve(this.onChoose(item.value)).catch((error) => {
      new Notice(error instanceof Error ? error.message : String(error));
    });
  }
}

function formatEffectiveModel(settings) {
  const slug = settings.model || settings.effectiveModel;
  const model = settings.availableModels.find((candidate) => candidate.slug === slug);
  return model?.displayName || slug;
}
