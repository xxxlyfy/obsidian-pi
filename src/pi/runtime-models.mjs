import { STRINGS } from "../shared/strings.mjs";
import { CUSTOM_MODEL_VALUE } from "../plugin/settings.mjs";
import {
  createRuntimeCatalogSnapshot,
  hasSafeRuntimeCatalog,
  needsRuntimeCatalogRefresh,
  RuntimeCatalogRefreshGate
} from "./model-catalog-values.mjs";

/**
 * Owns the runtime model/thinking catalog: refreshing it from Pi, keeping the
 * selected model consistent with what Pi reports, and answering token-usage
 * lookups. It never touches the DOM; view refreshes go through `onCatalogChanged`.
 *
 * A generation counter invalidates in-flight refreshes so a settings save or a
 * service rebuild cannot be overwritten by an older catalog response.
 */
export class RuntimeModelService {
  /**
   * @param {object} options
   * @param {() => any} options.getSettings
   * @param {() => any} options.getCatalog
   * @param {() => string | undefined} [options.getVaultBasePath]
   * @param {() => Promise<void>} [options.save]
   * @param {() => void} [options.onCatalogChanged]
   * @param {(message: string) => void} [options.notify]
   * @param {() => number} [options.now]
   */
  constructor({
    getSettings,
    getCatalog,
    getVaultBasePath = () => undefined,
    save = async () => {},
    onCatalogChanged = () => {},
    notify = () => {},
    now = () => Date.now()
  }) {
    this.getSettings = getSettings;
    this.getCatalog = getCatalog;
    this.getVaultBasePath = getVaultBasePath;
    this.save = save;
    this.onCatalogChanged = onCatalogChanged;
    this.notify = notify;
    this.now = now;
    this.refreshGate = new RuntimeCatalogRefreshGate();
    this.refreshedAt = 0;
    this.generation = 0;
    this.error = "";
  }

  /**
   * Invalidates in-flight refreshes. Call before settings persistence or a
   * service rebuild so an older response cannot win the race.
   */
  invalidate() {
    this.generation += 1;
    this.refreshedAt = 0;
  }

  get lastError() {
    return this.error;
  }

  /** @param {boolean} [showNotice] */
  async refresh(showNotice = false, force = true) {
    const settings = this.getSettings();
    if (!force && !needsRuntimeCatalogRefresh(settings, this.refreshedAt, this.now())) {
      return { ok: true, stale: false };
    }
    const result = await this.refreshGate.run(() => this.performRefresh());
    if (showNotice) {
      this.notify(
        result.ok
          ? STRINGS.plugin.modelsLoaded(settings.availableModels.length, settings.effectiveModel)
          : this.error
      );
    }
    return result;
  }

  async performRefresh() {
    const settings = this.getSettings();
    try {
      while (true) {
        const generation = this.generation;
        const catalog = this.getCatalog();
        if (!catalog) throw new Error(STRINGS.plugin.modelServiceNotReady);

        let models;
        let effectiveConfig;
        try {
          models = await catalog.getAvailableModels(this.getVaultBasePath());
          effectiveConfig = catalog.getEffectiveConfig();
        } catch (error) {
          if (generation !== this.generation) continue;
          throw error;
        }
        if (generation !== this.generation) continue;

        const snapshot = createRuntimeCatalogSnapshot(models, effectiveConfig);
        settings.availableModels = snapshot.availableModels;
        settings.effectiveModel = snapshot.effectiveModel;
        settings.effectiveReasoning = snapshot.effectiveReasoning;
        if (
          settings.model === CUSTOM_MODEL_VALUE &&
          settings.customModel &&
          models.some((model) => model.slug === settings.customModel)
        ) {
          settings.model = settings.customModel;
        }
        if (
          settings.model &&
          settings.model !== CUSTOM_MODEL_VALUE &&
          !models.some((model) => model.slug === settings.model)
        ) {
          settings.model = "";
          settings.reasoningEffort = "";
        }

        this.refreshedAt = this.now();
        this.error = "";
        await this.save();
        if (generation !== this.generation) continue;

        this.onCatalogChanged();
        return { ok: true, stale: false };
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.error = `Could not refresh models from Pi. Check the Pi executable and configuration, then try again. ${detail}`;
      console.warn(STRINGS.plugin.modelCatalogFailed, error);
      this.onCatalogChanged();
      if (hasSafeRuntimeCatalog(this.getSettings())) return { ok: false, stale: true };
      throw new Error(this.error, { cause: error });
    }
  }

  /** Loads models on demand; reports the failure instead of throwing. */
  async ensureLoaded() {
    if (this.getSettings().availableModels.length > 0) return { ok: true, stale: false };
    const result = await this.refresh(false, false);
    if (!result.ok && this.error) this.notify(this.error);
    return result;
  }

  /** @param {any} tokenUsage */
  getInfoForTokenUsage(tokenUsage) {
    if (!tokenUsage) return undefined;
    const models = this.getSettings().availableModels;
    const modelId =
      tokenUsage.modelId ||
      (tokenUsage.provider && tokenUsage.model ? `${tokenUsage.provider}/${tokenUsage.model}` : "");
    if (modelId) {
      const match = models.find((model) => model.slug === modelId);
      if (match) return match;
    }
    return tokenUsage.model
      ? models.find((model) => model.slug.endsWith(`/${tokenUsage.model}`))
      : undefined;
  }

  /** @param {any} [tokenUsage] */
  getSelectedInfo(tokenUsage) {
    const tokenUsageModel = this.getInfoForTokenUsage(tokenUsage);
    if (tokenUsageModel) return tokenUsageModel;
    const settings = this.getSettings();
    let modelId = settings.model === CUSTOM_MODEL_VALUE ? settings.customModel : settings.model;
    if (!modelId) modelId = settings.effectiveModel;
    return modelId ? settings.availableModels.find((model) => model.slug === modelId) : undefined;
  }
}
