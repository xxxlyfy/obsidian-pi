import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPiProcessEnv,
  buildPiProcessInvocation,
  buildPiProcessOptions,
  findPiExecutable,
  findWindowsPiExecutable,
  materializeSystemPromptArguments
} from "../src/pi/environment.mjs";

const originalEnv = {
  APPDATA: process.env.APPDATA,
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  USER: process.env.USER
};
const originalPlatform = process.platform;

afterEach(() => {
  setPlatform(originalPlatform);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setPlatform(platform) {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

describe("Pi process environment", () => {
  it("prepends the Pi executable directory so env can find node for GUI launches", () => {
    if (process.platform === "win32") return;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-env-"));
    const piExecutable = path.join(tempDir, "pi");
    fs.writeFileSync(piExecutable, "");
    process.env.PATH = "/usr/bin";

    const env = buildPiProcessEnv(piExecutable);

    expect(env.PATH.split(path.delimiter)[0]).toBe(tempDir);
  });

  it("uses a configured Pi executable path before auto-detection", () => {
    if (process.platform === "win32") return;

    const piExecutable = path.join(os.tmpdir(), "custom-pi");

    expect(findPiExecutable(piExecutable)).toBe(piExecutable);
  });

  it("expands home and environment variables in configured Pi executable paths", () => {
    if (process.platform === "win32") return;

    process.env.HOME = "/Users/tester";
    process.env.USER = "tester";

    expect(findPiExecutable("~/bin/pi")).toBe(path.join("/Users/tester", "bin", "pi"));
    expect(findPiExecutable("/etc/profiles/per-user/${USER}/bin/pi")).toBe(
      "/etc/profiles/per-user/tester/bin/pi"
    );
  });

  it("runs Pi launchers through cmd.exe on Windows so .cmd resolution works on Node 24+", () => {
    setPlatform("win32");

    expect(buildPiProcessInvocation("pi", ["--version"], { timeout: 1000 })).toMatchObject({
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", '""pi" "--version""'],
      options: {
        env: process.env,
        timeout: 1000,
        windowsVerbatimArguments: true
      }
    });
  });

  it("quotes Windows command arguments without backslash-escaped quotes", () => {
    setPlatform("win32");

    expect(buildPiProcessInvocation("pi.cmd", ['say "hi"']).args[3]).toBe(
      '""pi.cmd" "say ""hi""""'
    );
  });

  it("preserves spaces in Windows executable and argument paths", () => {
    setPlatform("win32");

    expect(
      buildPiProcessInvocation("C:\\Program Files\\nodejs\\pi.cmd", [
        "--session",
        "C:\\Users\\Test User\\Vault\\pi sessions\\chat.jsonl"
      ]).args[3]
    ).toBe(
      '""C:\\Program Files\\nodejs\\pi.cmd" "--session" "C:\\Users\\Test User\\Vault\\pi sessions\\chat.jsonl""'
    );
  });

  it("does not use a shell for Pi processes on POSIX", () => {
    setPlatform("darwin");

    expect(buildPiProcessOptions("pi", { timeout: 1000 })).not.toHaveProperty("shell");
  });

  it("materializes multi-line system prompts to files on Windows so later args survive", () => {
    setPlatform("win32");
    const instructions = "# Pi Agent\n\nline one\nline two";

    const original = ["--append-system-prompt", instructions, "--tools", "read,grep,find,ls"];
    const prepared = materializeSystemPromptArguments(original);

    expect(original[1]).toBe(instructions);
    expect(prepared[1]).not.toBe(instructions);
    expect(fs.existsSync(prepared[1])).toBe(true);
    expect(fs.readFileSync(prepared[1], "utf8")).toBe(instructions);
    expect(prepared[2]).toBe("--tools");
    expect(prepared[3]).toBe("read,grep,find,ls");

    const invocation = buildPiProcessInvocation("pi.cmd", prepared);
    expect(invocation.args[3]).not.toMatch(/\r|\n/);
    expect(invocation.args[3]).toContain('"--tools" "read,grep,find,ls"');
    expect(invocation.args[3]).toContain(`"${prepared[1]}"`);
  });

  it("leaves single-line prompts and unrelated multi-line arguments untouched", () => {
    const singleLine = materializeSystemPromptArguments(["--append-system-prompt", "one line"]);
    expect(singleLine[1]).toBe("one line");

    const unrelated = materializeSystemPromptArguments(["--message", "line one\nline two"]);
    expect(unrelated[1]).toBe("line one\nline two");
  });
});

describe("Windows Pi executable detection", () => {
  function createLauncherDirectory(name, files) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pi-${name}-`));
    for (const file of files) fs.writeFileSync(path.join(directory, file), "");
    return directory;
  }

  it("resolves the launcher to an absolute path so the batch wrapper keeps %~dp0", () => {
    setPlatform("win32");
    const directory = createLauncherDirectory("path", ["pi.cmd"]);
    process.env.PATH = directory;

    expect(findPiExecutable("")).toBe(path.join(directory, "pi.cmd"));
  });

  it("prefers pi.cmd, then pi.exe, then the extension-less candidate per directory", () => {
    const directory = createLauncherDirectory("order", ["pi.exe", "pi"]);
    const directories = { pathDirectories: [directory], fallbackDirectories: [] };

    expect(findWindowsPiExecutable(directories)).toBe(path.join(directory, "pi.exe"));

    fs.writeFileSync(path.join(directory, "pi.cmd"), "");

    expect(findWindowsPiExecutable(directories)).toBe(path.join(directory, "pi.cmd"));
  });

  it("keeps PATH order between directories", () => {
    const first = createLauncherDirectory("first", ["pi.cmd"]);
    const second = createLauncherDirectory("second", ["pi.cmd"]);

    expect(
      findWindowsPiExecutable({ pathDirectories: [first, second], fallbackDirectories: [] })
    ).toBe(path.join(first, "pi.cmd"));
  });

  it("ignores empty, duplicated, and quoted PATH entries", () => {
    setPlatform("win32");
    const directory = createLauncherDirectory("quoted", ["pi.cmd"]);
    process.env.PATH = [`"${directory}"`, directory, "", "   "].join(path.delimiter);

    expect(findPiExecutable("")).toBe(path.join(directory, "pi.cmd"));
  });

  it("searches the known install locations when PATH has no launcher", () => {
    const empty = createLauncherDirectory("empty", []);
    const managedInstall = createLauncherDirectory("managed", ["pi.cmd"]);

    expect(
      findWindowsPiExecutable({
        pathDirectories: [empty],
        fallbackDirectories: [managedInstall]
      })
    ).toBe(path.join(managedInstall, "pi.cmd"));
  });

  it("falls back to the bare launcher name when Pi is not installed anywhere", () => {
    const empty = createLauncherDirectory("nothing", []);

    expect(findWindowsPiExecutable({ pathDirectories: [empty], fallbackDirectories: [] })).toBe(
      "pi.cmd"
    );
  });

  it("still lets a configured Pi executable win on Windows", () => {
    setPlatform("win32");
    const configured = path.join(createLauncherDirectory("configured", []), "custom-pi.cmd");

    expect(findPiExecutable(configured)).toBe(configured);
  });

  it("hands cmd.exe a launcher path that carries its directory", () => {
    setPlatform("win32");
    const directory = createLauncherDirectory("invocation", ["pi.cmd"]);
    const resolved = findWindowsPiExecutable({
      pathDirectories: [directory],
      fallbackDirectories: []
    });

    expect(path.dirname(resolved)).toBe(directory);
    expect(buildPiProcessInvocation(resolved, ["--version"]).args[3]).toContain(`"${resolved}"`);
  });
});
