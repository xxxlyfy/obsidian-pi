import { describe, expect, it, vi } from "vitest";
import { RuntimeModelService } from "../src/pi/runtime-models.mjs";
import { DEFAULT_SETTINGS } from "../src/plugin/settings.mjs";

const MODELS = [
  {
    slug: "openai/gpt-5",
    displayName: "GPT-5",
    supportedReasoningLevels: ["low", "high"],
    contextWindow: 128_000
  },
  { slug: "anthropic/claude", displayName: "Claude", supportedReasoningLevels: ["high"] }
];

function createService({ models = MODELS, settings = {}, catalog } = {}) {
  const currentSettings = { ...DEFAULT_SETTINGS, availableModels: [], ...settings };
  const saves = [];
  const changes = [];
  const notices = [];
  const effectiveCatalog = catalog ?? {
    getAvailableModels: vi.fn(async () => models),
    getEffectiveConfig: () => ({
      effectiveModel: models[0]?.slug ?? "",
      effectiveReasoning: "high"
    })
  };
  const service = new RuntimeModelService({
    getSettings: () => currentSettings,
    getCatalog: () => effectiveCatalog,
    getVaultBasePath: () => "/vault",
    save: async () => {
      saves.push(1);
    },
    onCatalogChanged: () => changes.push(1),
    notify: (message) => notices.push(message),
    now: () => 1_000
  });
  return { service, settings: currentSettings, catalog: effectiveCatalog, saves, changes, notices };
}

describe("RuntimeModelService", () => {
  it("refreshes the catalog into settings and persists once", async () => {
    const { service, settings, saves, changes } = createService();

    const result = await service.refresh(false, true);

    expect(result).toEqual({ ok: true, stale: false });
    expect(settings.availableModels).toEqual(MODELS);
    expect(settings.effectiveModel).toBe("openai/gpt-5");
    expect(settings.effectiveReasoning).toBe("high");
    expect(saves).toHaveLength(1);
    expect(changes).toHaveLength(1);
  });

  it("reports the loaded model count when a notice is requested", async () => {
    const { service, notices } = createService();

    await service.refresh(true);

    expect(notices[0]).toContain("2");
  });

  it("skips the refresh while the catalog is still fresh", async () => {
    const { service, catalog } = createService({ settings: { availableModels: MODELS } });
    await service.refresh(false, true);

    const result = await service.refresh(false, false);

    expect(result).toEqual({ ok: true, stale: false });
    expect(catalog.getAvailableModels).toHaveBeenCalledTimes(1);
  });

  it("drops a response that a settings save invalidated mid-flight", async () => {
    let invalidated = false;
    const catalog = {
      getAvailableModels: vi.fn(async () => {
        if (!invalidated) {
          invalidated = true;
          service.invalidate();
        }
        return MODELS;
      }),
      getEffectiveConfig: () => ({ effectiveModel: "openai/gpt-5", effectiveReasoning: "high" })
    };
    const { service, settings, saves } = createService({ catalog });

    const result = await service.refresh(false, true);

    expect(result).toEqual({ ok: true, stale: false });
    expect(catalog.getAvailableModels).toHaveBeenCalledTimes(2);
    expect(saves).toHaveLength(1);
    expect(settings.availableModels).toEqual(MODELS);
  });

  it("resets a selected model that Pi no longer reports", async () => {
    const { service, settings } = createService({
      settings: { model: "gone/model", reasoningEffort: "high" }
    });

    await service.refresh(false, true);

    expect(settings.model).toBe("");
    expect(settings.reasoningEffort).toBe("");
  });

  it("upgrades a custom selection once the model is known", async () => {
    const { service, settings } = createService({
      settings: { model: "__custom", customModel: "anthropic/claude" }
    });

    await service.refresh(false, true);

    expect(settings.model).toBe("anthropic/claude");
  });

  it("keeps a safe catalog and reports a stale result when Pi fails", async () => {
    const catalog = {
      getAvailableModels: async () => {
        throw new Error("pi missing");
      },
      getEffectiveConfig: () => ({})
    };
    const { service, changes, notices } = createService({
      settings: { availableModels: MODELS },
      catalog
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await service.refresh(false, true);

    expect(result).toEqual({ ok: false, stale: true });
    expect(service.lastError).toContain("pi missing");
    expect(changes).toHaveLength(1);
    expect(notices).toEqual([]);
    warn.mockRestore();
  });

  it("throws when Pi fails and there is no usable catalog left", async () => {
    const catalog = {
      getAvailableModels: async () => {
        throw new Error("pi missing");
      },
      getEffectiveConfig: () => ({})
    };
    const { service } = createService({ catalog });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(service.refresh(false, true)).rejects.toThrow("Could not refresh models from Pi");
    warn.mockRestore();
  });

  it("loads models on demand only when none are known", async () => {
    const { service, catalog, notices } = createService();

    await service.ensureLoaded();
    expect(catalog.getAvailableModels).toHaveBeenCalledTimes(1);

    await service.ensureLoaded();
    expect(catalog.getAvailableModels).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
  });

  it("surfaces a hard load failure to the caller", async () => {
    const catalog = {
      getAvailableModels: async () => {
        throw new Error("pi missing");
      },
      getEffectiveConfig: () => ({})
    };
    const { service } = createService({ catalog });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(service.ensureLoaded()).rejects.toThrow("Could not refresh models from Pi");
    warn.mockRestore();
  });

  it("resolves token usage and selected model info", async () => {
    const { service, settings } = createService({ settings: { availableModels: MODELS } });

    expect(service.getInfoForTokenUsage({ provider: "openai", model: "gpt-5" })).toBe(MODELS[0]);
    expect(service.getInfoForTokenUsage({ modelId: "anthropic/claude" })).toBe(MODELS[1]);
    expect(service.getInfoForTokenUsage({ model: "unknown" })).toBeUndefined();
    expect(service.getInfoForTokenUsage(undefined)).toBeUndefined();
    expect(service.getSelectedInfo({ model: "gpt-5" })).toBe(MODELS[0]);

    settings.model = "anthropic/claude";
    expect(service.getSelectedInfo()).toBe(MODELS[1]);

    settings.model = "__custom";
    settings.customModel = "openai/gpt-5";
    expect(service.getSelectedInfo()).toBe(MODELS[0]);

    settings.model = "";
    settings.customModel = "";
    settings.effectiveModel = "openai/gpt-5";
    expect(service.getSelectedInfo()).toBe(MODELS[0]);
  });
});
