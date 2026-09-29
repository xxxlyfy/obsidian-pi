import { DEFAULT_LOCALE, t } from "../shared/i18n/index.mjs";

export const CUSTOM_MODEL_VALUE = "__custom";

export const DEFAULT_SETTINGS = {
  model: "",
  customModel: "",
  reasoningEffort: "",
  sandboxMode: "read-only",
  acknowledgedToolRisk: false,
  availableModels: [],
  ignoredFolders: [".git", "node_modules", "Templates"],
  customInstructions: "",
  piExecutablePath: "",
  includeDefaultSkills: true,
  additionalSkillFolders: [],
  effectiveModel: "",
  effectiveReasoning: "",
  dismissedPiSetup: false,
  desktopNotifications: true,
  showExtensionStatus: true
};

export function normalizeSettings(rawSettings = {}) {
  // Settings removed from earlier versions, plus the retired dry-run flag, are
  // dropped here so an existing data.json keeps loading. This is deliberate
  // compatibility reading, not dead code to clean up.
  const {
    maxSearchResults: _maxSearchResults,
    maxSearchFiles: _maxSearchFiles,
    maxFileChars: _maxFileChars,
    maxChangeSnapshotFiles: _maxChangeSnapshotFiles,
    dryRun: _dryRun,
    ...supportedSettings
  } = rawSettings;
  const settings = { ...DEFAULT_SETTINGS, ...supportedSettings };

  settings.model = normalizeString(settings.model);
  settings.customModel = normalizeString(settings.customModel);
  settings.reasoningEffort = normalizeString(settings.reasoningEffort);
  settings.sandboxMode = normalizeToolMode(settings.sandboxMode);
  settings.acknowledgedToolRisk = settings.acknowledgedToolRisk === true;
  settings.availableModels = Array.isArray(settings.availableModels)
    ? settings.availableModels
    : [];
  settings.ignoredFolders = normalizeStringList(
    settings.ignoredFolders,
    DEFAULT_SETTINGS.ignoredFolders
  );
  settings.customInstructions = normalizeString(settings.customInstructions);
  settings.piExecutablePath = normalizeString(settings.piExecutablePath);
  settings.includeDefaultSkills = settings.includeDefaultSkills !== false;
  settings.additionalSkillFolders = normalizeStringList(settings.additionalSkillFolders, []);
  settings.effectiveModel = normalizeString(settings.effectiveModel);
  settings.effectiveReasoning = normalizeString(settings.effectiveReasoning);
  settings.dismissedPiSetup = settings.dismissedPiSetup === true;
  settings.desktopNotifications = settings.desktopNotifications !== false;
  settings.showExtensionStatus = settings.showExtensionStatus !== false;

  return settings;
}

export function getModelOptions(settings) {
  const models = settings.availableModels;
  const effectiveModel = getEffectiveModelInfo(settings);
  const effective = effectiveModel?.displayName || settings.effectiveModel;
  const options = effective ? { "": effective } : {};

  for (const model of models) options[model.slug] = formatModelOptionLabel(model);
  return options;
}

export function getReasoningOptions(settings) {
  const model = getReasoningModelInfo(settings);
  const supportedReasoningLevels = model?.supportedReasoningLevels ?? [];
  const resolvedDefault = settings.model
    ? model?.defaultReasoningLevel || settings.effectiveReasoning
    : settings.effectiveReasoning || model?.defaultReasoningLevel;
  // Labels come from the dictionaries only. Surfaces that are not localized yet
  // ask for English explicitly, so there is one place to edit a label.
  const effective = resolvedDefault
    ? getLocalizedReasoningLabel(resolvedDefault, { locale: DEFAULT_LOCALE })
    : t("reasoning.automatic", {}, DEFAULT_LOCALE);

  if (supportedReasoningLevels.length === 0) return { "": effective };

  const options = { "": effective };
  for (const reasoningLevel of supportedReasoningLevels) {
    options[reasoningLevel] = getLocalizedReasoningLabel(reasoningLevel, {
      locale: DEFAULT_LOCALE
    });
  }

  return options;
}

const REASONING_KEYS = {
  off: "reasoning.off",
  minimal: "reasoning.minimal",
  low: "reasoning.low",
  medium: "reasoning.medium",
  high: "reasoning.high",
  xhigh: "reasoning.xhigh",
  max: "reasoning.max"
};

const REASONING_SHORT_KEYS = {
  minimal: "reasoning.minimal.short",
  max: "reasoning.max.short"
};

export function getLocalizedReasoningLabel(value, options = {}) {
  const key = REASONING_KEYS[value];
  if (!key) return value;
  const shortKey = options.short ? REASONING_SHORT_KEYS[value] : undefined;
  return t(shortKey ?? key, {}, options.locale);
}

export function getLocalizedReasoningOptions(settings) {
  const options = getReasoningOptions(settings);
  const resolved = getResolvedReasoning(settings);
  return Object.fromEntries(
    Object.entries(options).map(([value]) => [
      value,
      value
        ? getLocalizedReasoningLabel(value)
        : REASONING_KEYS[resolved]
          ? t(REASONING_KEYS[resolved])
          : t("reasoning.automatic")
    ])
  );
}

export function getResolvedReasoning(settings) {
  if (settings.reasoningEffort) return settings.reasoningEffort;

  const model = getReasoningModelInfo(settings);
  return settings.model
    ? model?.defaultReasoningLevel || settings.effectiveReasoning || "pi-default"
    : settings.effectiveReasoning || model?.defaultReasoningLevel || "pi-default";
}

export function getEffectiveModelInfo(settings) {
  return settings.effectiveModel
    ? settings.availableModels.find((model) => model.slug === settings.effectiveModel)
    : undefined;
}

export function getSelectedModelInfo(settings) {
  const modelId = settings.model === CUSTOM_MODEL_VALUE ? settings.customModel : settings.model;
  return settings.availableModels.find((model) => model.slug === modelId);
}

function getReasoningModelInfo(settings) {
  return (
    getSelectedModelInfo(settings) ?? (settings.model ? undefined : getEffectiveModelInfo(settings))
  );
}

export function getToolModeOptions() {
  return {
    chat: "Chat — no Pi CLI tools",
    "read-only": "Review — read/search/list only",
    edit: "Edit — edit/write, no shell",
    "full-agent": "Full agent — edit/write and shell"
  };
}

export function getToolModePickerItems() {
  return Object.entries(getToolModeOptions()).map(([value, label]) => {
    const separatorIndex = label.indexOf(" — ");
    return separatorIndex === -1
      ? { value, primary: label, secondary: "" }
      : {
          value,
          primary: label.slice(0, separatorIndex),
          secondary: label.slice(separatorIndex + 3)
        };
  });
}

export function getToolModeShortLabel(value) {
  return getToolModePickerItems().find((item) => item.value === value)?.primary ?? "";
}

const TOOL_MODE_KEYS = {
  chat: "toolMode.chat",
  "read-only": "toolMode.readOnly",
  edit: "toolMode.edit",
  "full-agent": "toolMode.fullAgent"
};

// Localized variants. The English builders above stay untouched for callers that
// have not been localized yet.
export function getLocalizedToolModeOptions() {
  return Object.fromEntries(
    Object.entries(TOOL_MODE_KEYS).map(([value, key]) => [
      value,
      `${t(`${key}.primary`)} — ${t(`${key}.secondary`)}`
    ])
  );
}

export function getLocalizedToolModePickerItems() {
  return Object.entries(TOOL_MODE_KEYS).map(([value, key]) => ({
    value,
    primary: t(`${key}.primary`),
    secondary: t(`${key}.secondary`)
  }));
}

export function getLocalizedToolModeShortLabel(value) {
  const key = TOOL_MODE_KEYS[value];
  return key ? t(`${key}.primary`) : "";
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value, fallback) {
  const source = Array.isArray(value) ? value : fallback;
  return source.map((item) => normalizeString(item)).filter(Boolean);
}

function normalizeToolMode(value) {
  return value === "chat" || value === "read-only" || value === "edit" || value === "full-agent"
    ? value
    : value === "workspace-write" || value === "danger-full-access"
      ? "edit"
      : DEFAULT_SETTINGS.sandboxMode;
}

function formatModelOptionLabel(model) {
  const details = [
    model.slug,
    model.reasoning ? "thinking" : "",
    model.supportsImages ? "images" : "",
    model.contextWindow ? `${formatTokenAmount(model.contextWindow)} context` : ""
  ].filter(Boolean);

  return `${model.displayName} — ${details.join(" · ")}`;
}

function formatTokenAmount(value) {
  return value >= 1_000_000
    ? `${Number((value / 1_000_000).toFixed(1))}M`
    : value >= 1_000
      ? `${Number((value / 1_000).toFixed(1))}K`
      : String(value);
}
