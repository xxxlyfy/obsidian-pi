import fs from "node:fs";

const SRC = new URL("../../src/", import.meta.url);

/**
 * Read one source file's text, for structural assertions.
 *
 * @param {string} relativePath Path below `src/`, such as `ui/PiAgentView.mjs`.
 * @returns {string}
 */
export function readSource(relativePath) {
  return fs.readFileSync(new URL(relativePath, SRC), "utf8");
}

/**
 * Read several source files and join them, for "this code exists in this
 * subsystem" assertions. Joining rather than asserting per file keeps an
 * assertion valid when the code moves between the files that make up the
 * subsystem; list every file the logic could live in and say why in a comment
 * at the call site.
 *
 * @param {string[]} relativePaths Paths below `src/`.
 * @returns {string}
 */
export function readSources(relativePaths = []) {
  return relativePaths.map(readSource).join("\n");
}
