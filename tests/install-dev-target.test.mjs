/**
 * What `scripts/install-dev.mjs` is allowed to overwrite.
 *
 * The script copies `main.js`, `manifest.json` and `styles.css` into whatever directory it
 * is pointed at. Pointed at another plugin's folder it replaced that plugin's files and
 * destroyed it, so it now refuses any target whose `manifest.json` names a different
 * plugin. These cases run the real script against a temporary directory.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/install-dev.mjs");

let temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-install-dev-"));
  temporaryDirectories.push(directory);
  return directory;
}

function run(target) {
  const result = spawnSync(process.execPath, [SCRIPT, target], {
    cwd: path.resolve("."),
    encoding: "utf8"
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("install-dev target checking", () => {
  it("refuses a directory that holds another plugin, and leaves it untouched", () => {
    const target = createDirectory();
    const otherManifest = { id: "other-plugin", name: "Other", version: "3.1.4" };
    fs.writeFileSync(path.join(target, "manifest.json"), JSON.stringify(otherManifest));
    fs.writeFileSync(path.join(target, "main.js"), "// other plugin bundle");

    const result = run(target);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("other-plugin");
    expect(JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf8"))).toEqual(
      otherManifest
    );
    expect(fs.readFileSync(path.join(target, "main.js"), "utf8")).toBe("// other plugin bundle");
    expect(fs.existsSync(path.join(target, "styles.css"))).toBe(false);
  });

  it("refuses a directory whose manifest cannot be read", () => {
    const target = createDirectory();
    fs.writeFileSync(path.join(target, "manifest.json"), "{ not json");

    const result = run(target);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot be read");
    expect(fs.readFileSync(path.join(target, "manifest.json"), "utf8")).toBe("{ not json");
  });

  it("installs into this plugin's own folder", () => {
    const target = createDirectory();
    const ownManifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
    fs.writeFileSync(path.join(target, "manifest.json"), JSON.stringify(ownManifest, null, 2));

    const result = run(target);

    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(target, "main.js"), "utf8")).toBe(
      fs.readFileSync("main.js", "utf8")
    );
    expect(fs.existsSync(path.join(target, "styles.css"))).toBe(true);
  });

  it("installs into an empty folder", () => {
    const target = createDirectory();

    const result = run(target);

    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf8")).id).toBe(
      "pi-agent"
    );
  });
});
