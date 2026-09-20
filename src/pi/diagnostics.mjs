const PI_INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent";

export const PI_CLI_MISSING_MESSAGE = `Pi CLI was not found. Install it with \`${PI_INSTALL_COMMAND}\`, then restart Obsidian so it can find \`pi\` on PATH.`;

export const NODE_RUNTIME_MISSING_MESSAGE =
  "Pi CLI was found, but Node.js is not available to Obsidian. Install Node.js, then fully restart Obsidian. If you use nvm, fnm, asdf, or another version manager, make sure its Node bin directory is available to GUI apps or install Node with Homebrew/the official installer.";

const NODE_RUNTIME_MISSING_PATTERNS = [
  /env:\s*node:\s*No such file or directory/i,
  /usr\/bin\/env:\s*['"]?node['"]?:\s*No such file or directory/i,
  /\/usr\/bin\/env:\s*node:\s*No such file or directory/i,
  /spawn\s+node\s+ENOENT/i
];

/**
 * @typedef {object} PiCliFailureDetails
 * @property {string} [context]
 * @property {unknown} [error]
 * @property {string} [stderr]
 * @property {string} [stdout]
 * @property {number | null} [exitCode]
 */

/**
 * @param {PiCliFailureDetails} [options]
 */
export function createPiCliError(options = {}) {
  return new Error(formatPiCliFailure(options));
}

/**
 * @param {PiCliFailureDetails} [options]
 */
export function formatPiCliFailure(options = {}) {
  return diagnosePiCliFailure(options).message;
}

/**
 * @param {PiCliFailureDetails} [options]
 */
export function diagnosePiCliFailure({
  context = "Could not run Pi CLI",
  error,
  stderr,
  stdout,
  exitCode
} = {}) {
  const text = getCombinedErrorText(error, stderr, stdout);

  if (isPiCliMissing(error)) return { kind: "pi-missing", message: PI_CLI_MISSING_MESSAGE };
  if (isNodeRuntimeMissing(text)) {
    return { kind: "node-missing", message: NODE_RUNTIME_MISSING_MESSAGE };
  }

  const detail =
    text || (typeof exitCode === "number" ? `Pi exited with code ${exitCode}.` : "Unknown error.");
  return { kind: "generic", message: `${context}: ${detail}` };
}

export function isNodeRuntimeMissing(text = "") {
  return NODE_RUNTIME_MISSING_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * @param {unknown} error
 */
export function isPiCliMissing(error) {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

/**
 * @param {unknown} error
 * @param {string} [stderr]
 * @param {string} [stdout]
 */
function getCombinedErrorText(error, stderr, stdout) {
  return [getErrorMessage(error), stderr, stdout]
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * @param {unknown} error
 */
function getErrorMessage(error) {
  if (!error) return "";
  return error instanceof Error ? error.message : String(error);
}
