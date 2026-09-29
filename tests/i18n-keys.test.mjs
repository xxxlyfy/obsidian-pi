import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import en from "../src/shared/i18n/en.mjs";
import zhCn from "../src/shared/i18n/zh-cn.mjs";

const DICTIONARIES = { en, "zh-cn": zhCn };
// Matches t("key"), tr("key"), tCount("key"), and trCount("key") calls.
const KEY_PATTERN = /(?<![A-Za-z0-9_$.])(?:t|tr|tCount|trCount)\(\s*"([^"]+)"/g;
const COUNT_PATTERN = /(?:tCount|trCount)\(\s*"/;

// Keys assembled at call time from these maps, so the literal scan cannot see them.
const SUFFIXED_KEYS = [
  "toolMode.chat.primary",
  "toolMode.chat.secondary",
  "toolMode.readOnly.primary",
  "toolMode.readOnly.secondary",
  "toolMode.edit.primary",
  "toolMode.edit.secondary",
  "toolMode.fullAgent.primary",
  "toolMode.fullAgent.secondary"
];

function listSourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return entry.name.endsWith(".mjs") ? [full] : [];
  });
}

describe("translation key coverage", () => {
  it("defines every key referenced from the source in both languages", () => {
    const missing = [];

    for (const file of listSourceFiles("src")) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(KEY_PATTERN)) {
        const key = match[1];
        const candidates = COUNT_PATTERN.test(match[0]) ? [`${key}.one`, `${key}.other`] : [key];

        for (const candidate of candidates) {
          for (const [locale, dictionary] of Object.entries(DICTIONARIES)) {
            if (!Object.prototype.hasOwnProperty.call(dictionary, candidate)) {
              missing.push(`${file} -> ${candidate} (${locale})`);
            }
          }
        }
      }
    }

    for (const key of SUFFIXED_KEYS) {
      for (const [locale, dictionary] of Object.entries(DICTIONARIES)) {
        if (!Object.prototype.hasOwnProperty.call(dictionary, key)) {
          missing.push(`dynamic key -> ${key} (${locale})`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
