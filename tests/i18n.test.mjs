import { describe, expect, it } from "vitest";
import en from "../src/shared/i18n/en.mjs";
import zhCn from "../src/shared/i18n/zh-cn.mjs";
import {
  DEFAULT_LOCALE,
  getDictionary,
  getLocale,
  hasTranslation,
  normalizeLocale,
  setLocale,
  t,
  tCount,
  translatedValues
} from "../src/shared/i18n/index.mjs";

describe("i18n locale resolution", () => {
  it("maps Obsidian language codes to supported locales", () => {
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("en-GB")).toBe("en");
    expect(normalizeLocale("EN")).toBe("en");
    expect(normalizeLocale("zh")).toBe("zh-cn");
    expect(normalizeLocale("zh-CN")).toBe("zh-cn");
    expect(normalizeLocale("zh-TW")).toBe("zh-cn");
    expect(normalizeLocale("zh-Hans")).toBe("zh-cn");
    expect(normalizeLocale("fr")).toBe("en");
    expect(normalizeLocale("")).toBe("en");
    expect(normalizeLocale(undefined)).toBe("en");
    expect(normalizeLocale(null)).toBe("en");
  });

  it("defaults to English and tracks the active locale", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(getLocale()).toBe("en");

    expect(setLocale("zh-CN")).toBe("zh-cn");
    expect(getLocale()).toBe("zh-cn");

    setLocale("en");
    expect(getLocale()).toBe("en");
  });
});

describe("i18n dictionaries", () => {
  it("exposes the same non-empty keys in every locale", () => {
    const englishKeys = Object.keys(en).sort();
    expect(englishKeys.length).toBeGreaterThan(0);
    expect(Object.keys(zhCn).sort()).toEqual(englishKeys);

    for (const [locale, dictionary] of Object.entries({ en, "zh-cn": zhCn })) {
      for (const [key, value] of Object.entries(dictionary)) {
        expect(typeof value, `${locale}:${key}`).toBe("string");
        expect(value.trim(), `${locale}:${key}`).not.toBe("");
      }
    }
  });

  it("translates known keys and interpolates parameters", () => {
    expect(t("settings.model.name", {}, "en")).toBe("Model");
    expect(t("settings.model.name", {}, "zh-cn")).toBe("模型");
    expect(t("notice.cliAvailable", { version: "1.2.3" }, "en")).toBe("Pi CLI is available: 1.2.3");
    expect(t("notice.cliAvailable", { version: "1.2.3" }, "zh-cn")).toBe("Pi CLI 可用：1.2.3");
    expect(t("picker.effectiveFor", { model: "GPT-5" }, "zh-cn")).toBe("对 GPT-5 生效");
    expect(t("notice.modelsLoaded", { count: 3, model: "openai/gpt-5" }, "zh-cn")).toBe(
      "已加载 3 个 Pi 模型；默认 openai/gpt-5。"
    );
  });

  it("leaves unknown placeholders intact and falls back safely", () => {
    expect(t("notice.cliAvailable", {}, "en")).toBe("Pi CLI is available: {version}");
    expect(t("missing.key", {}, "zh-cn")).toBe("missing.key");
    expect(t("settings.model.name", {}, "de")).toBe("Model");
    expect(getDictionary("zh-cn")).toBe(zhCn);
    expect(getDictionary("de")).toBe(en);
    expect(hasTranslation("settings.model.name", "zh-cn")).toBe(true);
    expect(hasTranslation("missing.key", "zh-cn")).toBe(false);
  });

  it("picks plural forms by count and lists every language variant of a key", () => {
    expect(tCount("threadList.count", 1, {}, "en")).toBe("1 chat");
    expect(tCount("threadList.count", 3, {}, "en")).toBe("3 chats");
    expect(tCount("threadList.count", 3, {}, "zh-cn")).toBe("3 个对话");
    expect(tCount("deleteThreads.result.skipped", 1, {}, "en")).toBe("1 active chat was skipped");
    expect(tCount("deleteThreads.result.skipped", 2, {}, "en")).toBe("2 active chats were skipped");

    expect(translatedValues("thread.defaultTitle").sort()).toEqual(["New chat", "新对话"]);
    expect(translatedValues("missing.key")).toEqual([]);
  });
});
