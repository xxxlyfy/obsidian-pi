import { getLanguage } from "obsidian";
import { normalizeLocale, setLocale } from "../shared/i18n/index.mjs";

// `getLanguage` exists since Obsidian 1.8.0 and this plugin requires 1.12.3, but
// the guard keeps older or stubbed hosts on English instead of throwing.
export function refreshUiLanguage() {
  const detected = typeof getLanguage === "function" ? getLanguage() : "";
  return setLocale(normalizeLocale(detected));
}
