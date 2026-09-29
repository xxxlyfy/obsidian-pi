import en from "./en.mjs";
import zhCn from "./zh-cn.mjs";

export const DEFAULT_LOCALE = "en";

const DICTIONARIES = {
  en,
  "zh-cn": zhCn
};

let currentLocale = DEFAULT_LOCALE;

// Obsidian reports codes such as "en", "en-GB", "zh", "zh-CN", "zh-TW", or
// "zh-Hans". Simplified Chinese covers every zh variant for now; anything else
// falls back to English so an unknown language never renders an empty label.
export function normalizeLocale(locale) {
  const normalized = typeof locale === "string" ? locale.trim().toLowerCase() : "";
  if (!normalized) return DEFAULT_LOCALE;
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-cn";
  return normalized === "en" || normalized.startsWith("en-") ? "en" : DEFAULT_LOCALE;
}

export function setLocale(locale) {
  currentLocale = normalizeLocale(locale);
  return currentLocale;
}

export function getLocale() {
  return currentLocale;
}

export function getDictionary(locale = currentLocale) {
  return DICTIONARIES[normalizeLocale(locale)] ?? DICTIONARIES[DEFAULT_LOCALE];
}

export function hasTranslation(key, locale = currentLocale) {
  return Object.prototype.hasOwnProperty.call(getDictionary(locale), key);
}

export function t(key, params = {}, locale = currentLocale) {
  const dictionary = getDictionary(locale);
  const template = dictionary[key] ?? DICTIONARIES[DEFAULT_LOCALE][key] ?? key;
  return formatTemplate(template, params);
}

// Plural-aware lookup: `keyBase.one` for a single item, `keyBase.other`
// otherwise, with `{count}` injected. Languages without plural forms define the
// same text for both keys.
export function tCount(keyBase, count, params = {}, locale = currentLocale) {
  const suffix = Number(count) === 1 ? "one" : "other";
  return t(`${keyBase}.${suffix}`, { count, ...params }, locale);
}

// Every value any dictionary defines for a key. Used where a stored value must
// stay recognizable across languages, such as a default thread title.
export function translatedValues(key) {
  return Object.values(DICTIONARIES)
    .map((dictionary) => dictionary[key])
    .filter((value) => typeof value === "string");
}

function formatTemplate(template, params) {
  if (typeof template !== "string") return String(template);
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
}
