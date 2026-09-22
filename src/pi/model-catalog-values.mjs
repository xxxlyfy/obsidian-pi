import { STRINGS } from "../shared/strings.mjs";

/**
 * Pure helpers for Pi's runtime model catalog. They live in `src/pi` because
 * the runtime model service owns the catalog; the settings UI only renders it.
 */
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
