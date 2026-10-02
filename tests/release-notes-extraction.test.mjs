/**
 * What the release workflow publishes as the release body.
 *
 * `scripts/extract-release-notes.mjs` slices the CHANGELOG section for the version in
 * `manifest.json` and stops at the next `## ` line. A `## ` line inside a fenced code
 * block is content, not a heading - a release note that quotes a changelog snippet would
 * otherwise cut the body at that line and still exit 0, publishing a truncated release.
 * These cases run the real script against fixtures in a temporary directory.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/extract-release-notes.mjs");
const VERSION = "0.0.25";

let temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** A repository-shaped fixture: the script reads both files from its working directory. */
function createFixture(changelog) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-release-notes-"));
  temporaryDirectories.push(directory);
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({ version: VERSION }, null, 2)
  );
  fs.writeFileSync(path.join(directory, "CHANGELOG.md"), changelog);
  return directory;
}

function extract(changelog) {
  const directory = createFixture(changelog);
  const output = path.join(directory, "release-notes.out.md");
  const result = spawnSync(process.execPath, [SCRIPT, output], {
    cwd: directory,
    encoding: "utf8"
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    notes: fs.existsSync(output) ? fs.readFileSync(output, "utf8") : undefined
  };
}

const section = [
  "# Changelog",
  "",
  `## ${VERSION} - 2026-10-02`,
  "",
  "- First real bullet.",
  ""
].join("\n");

describe("extracting the release notes for the manifest version", () => {
  it("takes the section for that version and stops at the next version", () => {
    const result = extract(
      [section, "## 0.0.24 - 2026-10-02", "", "- Older bullet.", ""].join("\n")
    );

    expect(result.status).toBe(0);
    expect(result.notes).toContain("- First real bullet.");
    expect(result.notes).not.toContain("- Older bullet.");
  });

  it("ignores a version heading inside a fenced code block", () => {
    const fenced = [
      "# Changelog",
      "",
      `## ${VERSION} - 2026-10-02`,
      "",
      "- First real bullet.",
      "",
      "```markdown",
      "## 0.0.24 - 2026-10-02",
      "- This is quoted content inside a fence.",
      "```",
      "",
      "- A bullet after the fence.",
      "",
      "## 0.0.24 - 2026-10-02",
      "",
      "- Older bullet.",
      ""
    ].join("\n");

    const result = extract(fenced);

    expect(result.status).toBe(0);
    expect(result.notes).toContain("- First real bullet.");
    expect(result.notes).toContain("- This is quoted content inside a fence.");
    expect(result.notes).toContain("- A bullet after the fence.");
    // The section still ends at the real heading that follows the fence.
    expect(result.notes).not.toContain("- Older bullet.");
  });

  it("handles a tilde fence and a fence that opens inside the section", () => {
    const fenced = [
      "# Changelog",
      "",
      `## ${VERSION} - 2026-10-02`,
      "",
      "~~~",
      "## 0.0.24 - 2026-10-02",
      "~~~",
      "",
      "- Kept after the tilde fence.",
      ""
    ].join("\n");

    const result = extract(fenced);

    expect(result.status).toBe(0);
    expect(result.notes).toContain("- Kept after the tilde fence.");
  });

  it("fails without writing when the version has no section", () => {
    const result = extract(
      ["# Changelog", "", "## 0.0.24 - 2026-10-02", "", "- Old.", ""].join("\n")
    );

    expect(result.status).toBe(1);
    expect(result.notes).toBeUndefined();
    expect(result.stderr).toContain(VERSION);
  });

  it("fails without writing when the section is empty", () => {
    const result = extract(
      [`## ${VERSION} - 2026-10-02`, "", "## 0.0.24 - 2026-10-02", ""].join("\n")
    );

    expect(result.status).toBe(1);
    expect(result.notes).toBeUndefined();
    expect(result.stderr).toContain("empty");
  });
});
