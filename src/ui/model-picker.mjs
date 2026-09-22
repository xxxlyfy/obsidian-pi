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
