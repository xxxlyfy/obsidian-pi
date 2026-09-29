import { afterEach, describe, expect, it, vi } from "vitest";

const { getLanguageMock } = vi.hoisted(() => ({ getLanguageMock: vi.fn(() => "en") }));

vi.mock("obsidian", () => ({ getLanguage: () => getLanguageMock() }));

const { refreshUiLanguage } = await import("../src/plugin/ui-language.mjs");
const { getLocale } = await import("../src/shared/i18n/index.mjs");

afterEach(() => {
  getLanguageMock.mockReturnValue("en");
});

describe("UI language detection", () => {
  it("follows the Obsidian app language", () => {
    getLanguageMock.mockReturnValue("zh-CN");
    expect(refreshUiLanguage()).toBe("zh-cn");
    expect(getLocale()).toBe("zh-cn");

    getLanguageMock.mockReturnValue("en-GB");
    expect(refreshUiLanguage()).toBe("en");
    expect(getLocale()).toBe("en");
  });

  it("falls back to English for an unsupported app language", () => {
    getLanguageMock.mockReturnValue("fr");
    expect(refreshUiLanguage()).toBe("en");
  });

  it("falls back to English when the host does not expose getLanguage", async () => {
    vi.resetModules();
    vi.doMock("obsidian", () => ({ getLanguage: undefined }));
    const { refreshUiLanguage: refresh } = await import("../src/plugin/ui-language.mjs");

    expect(refresh()).toBe("en");
  });
});
