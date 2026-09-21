import { describe, expect, it } from "vitest";
import { formatContextShowResponse, isContextShowPrompt } from "../src/context/context-show.mjs";
import { STRINGS } from "../src/shared/strings.mjs";

describe("context show command", () => {
  it("matches slash and bare context show prompts", () => {
    expect(isContextShowPrompt("context show")).toBe(true);
    expect(isContextShowPrompt("/context show")).toBe(true);
    expect(isContextShowPrompt("context")).toBe(false);
    expect(isContextShowPrompt("/context hide")).toBe(false);
  });

  it("formats the context inspection as a readable response", () => {
    const inspection = { activeNote: { path: "Note.md" } };
    const expected = [
      STRINGS.commands.contextShowHeading,
      "",
      "```json",
      JSON.stringify(inspection, null, 2),
      "```"
    ].join("\n");

    expect(formatContextShowResponse(inspection)).toBe(expected);
  });
});
