import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const POSIX_PI_CANDIDATES = ["/opt/homebrew/bin/pi", "/usr/local/bin/pi", "/usr/bin/pi"];
const WINDOWS_PI_CANDIDATES = ["pi.cmd", "pi.exe", "pi"];
const POSIX_PATH_CANDIDATES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin"
];

export function findPiExecutable(configuredPath = "") {
  const configuredExecutable = normalizePiExecutablePath(configuredPath);
  if (configuredExecutable) return configuredExecutable;
  if (process.platform === "win32") return findWindowsPiExecutable();

  for (const candidate of POSIX_PI_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const piNode = findPiNodeExecutable();
  if (piNode) return piNode;

  return "pi";
}

/**
 * Resolve the Windows Pi launcher to an absolute path.
 *
 * Windows Pi entry points are batch files, and the launcher the pi.dev installer
 * generates runs `node "%~dp0pi-launcher.js" %*`. cmd.exe expands `%~dp0` to the
 * current directory instead of the launcher directory when a batch file is
 * invoked quoted and without a directory, and every invocation from this module
 * is quoted (see `quoteWindowsCommand`). Pi then resolves `pi-launcher.js`
 * against the plugin's working directory and dies with MODULE_NOT_FOUND before
 * the RPC handshake. Resolving the launcher through PATH keeps the executable
 * absolute, so the wrapper no longer depends on the child's working directory.
 *
 * @param {{ pathDirectories?: string[]; fallbackDirectories?: string[] }} [options]
 * @returns {string}
 */
export function findWindowsPiExecutable(options = {}) {
  const pathDirectories = options.pathDirectories ?? getWindowsPathDirectories();
  const fallbackDirectories = options.fallbackDirectories ?? getWindowsPiDirectories();
  const directories = uniqueDirectoryList([...pathDirectories, ...fallbackDirectories]);

  for (const directory of directories) {
    for (const candidate of WINDOWS_PI_CANDIDATES) {
      const executable = path.join(directory, candidate);
      if (fs.existsSync(executable)) return executable;
    }
  }

  return WINDOWS_PI_CANDIDATES[0];
}

/**
 * Windows install locations that a GUI process often misses on PATH: the pi.dev
 * installer uses `~/.pi/agent/bin`, `npm install -g` uses `%APPDATA%/npm`.
 *
 * @returns {string[]}
 */
function getWindowsPiDirectories() {
  const directories = [path.join(os.homedir(), ".pi", "agent", "bin")];
  if (process.env.APPDATA) directories.push(path.join(process.env.APPDATA, "npm"));
  return directories;
}

/**
 * @returns {string[]}
 */
function getWindowsPathDirectories() {
  return uniqueDirectoryList((process.env.PATH ?? "").split(path.delimiter).map(unquotePathEntry));
}

/**
 * PATH entries are routinely wrapped in double quotes on Windows.
 *
 * @param {unknown} entry
 * @returns {string}
 */
function unquotePathEntry(entry) {
  const trimmed = String(entry ?? "").trim();
  if (trimmed.length < 2) return trimmed;
  return /^".*"$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
}

/**
 * @param {string[]} directories
 * @returns {string[]}
 */
function uniqueDirectoryList(directories) {
  const seen = new Set();
  const result = [];
  for (const directory of directories) {
    if (!directory) continue;
    const key = directory.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(directory);
  }
  return result;
}

export function normalizePiExecutablePath(executablePath) {
  const normalizedPath = typeof executablePath === "string" ? executablePath.trim() : "";
  if (!normalizedPath) return "";

  return expandEnvironmentVariables(expandHomeDirectory(normalizedPath));
}

function expandHomeDirectory(executablePath) {
  const home = process.env.HOME;
  if (!home) return executablePath;
  if (executablePath === "~") return home;
  return executablePath.startsWith(`~${path.sep}`)
    ? path.join(home, executablePath.slice(2))
    : executablePath;
}

function expandEnvironmentVariables(executablePath) {
  return executablePath.replace(/\$(\w+)|\$\{([^}]+)\}/g, (match, name, bracedName) => {
    const value = process.env[name || bracedName];
    return value === undefined ? match : value;
  });
}

function findPiNodeExecutable() {
  const home = process.env.HOME;
  if (!home) return null;

  const root = path.join(home, ".local", "share", "pi-node");

  try {
    const versions = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));

    for (const v of versions) {
      const candidate = path.join(v, "bin", "pi");
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    return null;
  }

  return null;
}

export function buildPiProcessInvocation(piExecutable, args = [], options = {}) {
  const useWindowsCommandShell = shouldUseWindowsCommandShell(piExecutable);
  // cmd.exe treats newlines in /c as command separators, so a multi-line
  // --append-system-prompt truncates the launch and silently drops every later
  // argument. On Windows, hand Pi a file path instead (it reads existing paths
  // as file contents).
  const preparedArgs = useWindowsCommandShell ? materializeSystemPromptArguments(args) : args;
  const processOptions = buildPiProcessOptions(piExecutable, options);

  return useWindowsCommandShell
    ? {
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", quoteWindowsCommand([piExecutable, ...preparedArgs])],
        options: {
          ...processOptions,
          windowsVerbatimArguments: true
        }
      }
    : {
        command: piExecutable,
        args,
        options: processOptions
      };
}

const SYSTEM_PROMPT_FLAGS = new Set(["--system-prompt", "--append-system-prompt"]);

export function materializeSystemPromptArguments(args = []) {
  const result = [...args];
  for (let index = 0; index < result.length - 1; index += 1) {
    if (!SYSTEM_PROMPT_FLAGS.has(result[index])) continue;
    const value = result[index + 1];
    if (typeof value !== "string" || !/[\r\n]/.test(value)) continue;
    const filePath = writeSystemPromptTempFile(value);
    if (filePath) result[index + 1] = filePath;
  }
  return result;
}

function writeSystemPromptTempFile(contents) {
  try {
    const hash = createHash("sha1").update(contents, "utf8").digest("hex").slice(0, 16);
    const filePath = path.join(os.tmpdir(), `pi-agent-system-prompt-${hash}.md`);
    fs.writeFileSync(filePath, contents, "utf8");
    return filePath;
  } catch {
    return undefined;
  }
}

export function buildPiProcessOptions(piExecutable = findPiExecutable(), options = {}) {
  return {
    ...options,
    env: buildPiProcessEnv(piExecutable)
  };
}

export function buildPiProcessEnv(piExecutable = findPiExecutable()) {
  if (process.platform === "win32") return process.env;

  return {
    ...process.env,
    PATH: buildPosixPath(piExecutable)
  };
}

function shouldUseWindowsCommandShell(piExecutable) {
  return process.platform === "win32" && !/\.exe$/i.test(piExecutable);
}

function quoteWindowsCommand(parts) {
  const command = parts.map((part) => `"${String(part).replace(/"/g, '""')}"`).join(" ");
  // cmd.exe /s strips the first and last quote from the /c command string.
  // Add an outer quote pair so the inner executable/argument quotes survive parsing.
  return `"${command}"`;
}

function buildPosixPath(piExecutable) {
  return uniqueExistingDirectories([
    ...getExecutableDirectory(piExecutable),
    ...POSIX_PATH_CANDIDATES,
    ...getPiNodePaths(),
    ...getNodeVersionManagerDirectories(),
    ...getExistingPathEntries()
  ]).join(path.delimiter);
}

function getPiNodePaths() {
  const home = process.env.HOME;
  if (!home) return [];

  const root = path.join(home, ".local", "share", "pi-node");

  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name, "bin"));
  } catch {
    return [];
  }
}

function getExistingPathEntries() {
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
}

function getExecutableDirectory(executable) {
  return path.isAbsolute(executable) ? [path.dirname(executable)] : [];
}

function getNodeVersionManagerDirectories() {
  const home = process.env.HOME;
  if (!home) return [];

  return [
    ...getNvmNodeBinDirectories(path.join(home, ".nvm", "versions", "node")),
    ...getFnmNodeBinDirectories(path.join(home, ".fnm", "node-versions")),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".volta", "bin")
  ];
}

function getNvmNodeBinDirectories(root) {
  return getChildDirectories(root).map((directory) => path.join(directory, "bin"));
}

function getFnmNodeBinDirectories(root) {
  return getChildDirectories(root).map((directory) => path.join(directory, "installation", "bin"));
}

function getChildDirectories(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

function uniqueExistingDirectories(directories) {
  const seen = new Set();
  return directories.filter((directory) => {
    if (!directory || seen.has(directory) || !fs.existsSync(directory)) return false;
    seen.add(directory);
    return true;
  });
}
