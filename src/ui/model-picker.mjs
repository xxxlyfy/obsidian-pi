import { STRINGS } from "../shared/strings.mjs";
export class RuntimeCatalogRefreshGate {
  run(task) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = Promise.resolve()
      .then(task)
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }
}

export function needsRuntimeCatalogRefresh(
  settings,
  refreshedAt,
  now = Date.now(),
  maxAge = 30_000
) {
  return (
    !Array.isArray(settings.availableModels) ||
    settings.availableModels.length === 0 ||
    !refreshedAt ||
    now - refreshedAt >= maxAge
  );
}

export function createRuntimeCatalogSnapshot(models, effectiveConfig) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error(STRINGS.picker.noModelsReturned);
  }

  const reportedModel = String(effectiveConfig?.effectiveModel || "").trim();
  const effectiveModelInfo = models.find((model) => model.slug === reportedModel);
  const reportedReasoning = String(effectiveConfig?.effectiveReasoning || "").trim();
  const effectiveModel = effectiveModelInfo ? reportedModel : "";
  const effectiveReasoning = effectiveModelInfo?.supportedReasoningLevels?.includes(
    reportedReasoning
  )
    ? reportedReasoning
    : "";

  return { availableModels: models, effectiveModel, effectiveReasoning };
}

export function hasSafeRuntimeCatalog(settings) {
  return Array.isArray(settings.availableModels) && settings.availableModels.length > 0;
}

export function buildModelPickerItems(settings) {
  return settings.availableModels.map((model) => {
    const isDefault = model.slug === settings.effectiveModel;
    return { value: isDefault ? "" : model.slug, model, isDefault };
  });
}

export function getModelPickerPrimary(item) {
  return item.model.displayName || item.model.id || item.model.slug;
}

export function getModelPickerSecondary(item) {
  const capabilities = [
    item.isDefault ? "Pi 默认" : "",
    item.model.reasoning ? "思考" : "",
    item.model.supportsImages ? "图片" : "",
    item.model.contextWindow ? `${formatTokenAmount(item.model.contextWindow)} 上下文` : ""
  ].filter(Boolean);
  return [item.model.slug, ...capabilities].join(" · ");
}

function formatTokenAmount(value) {
  return value >= 1_000_000
    ? `${Number((value / 1_000_000).toFixed(1))}M`
    : value >= 1_000
      ? `${Number((value / 1_000).toFixed(1))}K`
      : String(value);
}
