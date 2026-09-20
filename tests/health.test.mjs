import { describe, expect, it, vi } from "vitest";
import {
  checkPiInstallation,
  compareVersions,
  extractVersion,
  MINIMUM_PI_VERSION,
  TESTED_PI_VERSION
} from "../src/pi/health.mjs";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, execFile: vi.fn() };
});

import { execFile } from "node:child_process";

function mockVersion(stdout, { code = 0, stderr = "" } = {}) {
  execFile.mockImplementationOnce((_command, _args, _options, callback) => {
    if (code === 0) callback(null, stdout, stderr);
    else callback(Object.assign(new Error("command failed"), { code }), stdout, stderr);
  });
}

describe("Pi compatibility helpers", () => {
  it("extracts and compares semantic Pi versions", () => {
    expect(extractVersion("pi 0.80.7")).toBe(TESTED_PI_VERSION);
    expect(extractVersion("pi 0.80.0-beta.2+build.4")).toBe("0.80.0-beta.2+build.4");
    expect(compareVersions(TESTED_PI_VERSION, MINIMUM_PI_VERSION)).toBe(1);
    expect(compareVersions("0.80.0+build.4", MINIMUM_PI_VERSION)).toBe(0);
    expect(compareVersions("0.80.0-beta.2", MINIMUM_PI_VERSION)).toBe(-1);
    expect(compareVersions("0.80.0-beta.10", "0.80.0-beta.2")).toBe(1);
    expect(compareVersions("0.80.0-beta", "0.80.0-2")).toBe(1);
    expect(compareVersions("0.79.9", MINIMUM_PI_VERSION)).toBe(-1);
  });

  it("returns actionable diagnostics for unsupported Pi versions", async () => {
    mockVersion("pi 0.79.9\n");

    await expect(checkPiInstallation()).resolves.toMatchObject({
      ok: false,
      kind: "pi-unsupported",
      version: "0.79.9",
      supported: false,
      message: expect.stringContaining(`requires Pi ${MINIMUM_PI_VERSION} or newer`)
    });
  });

  it("accepts the minimum version and preserves unparseable successful output", async () => {
    mockVersion(`pi ${MINIMUM_PI_VERSION}\n`);
    await expect(checkPiInstallation()).resolves.toMatchObject({
      ok: true,
      version: MINIMUM_PI_VERSION,
      supported: true
    });

    mockVersion(`pi ${MINIMUM_PI_VERSION}-beta.1\n`);
    await expect(checkPiInstallation()).resolves.toMatchObject({
      ok: false,
      kind: "pi-unsupported",
      version: `${MINIMUM_PI_VERSION}-beta.1`
    });

    mockVersion("Pi development build\n");
    await expect(checkPiInstallation()).resolves.toMatchObject({
      ok: true,
      version: "Pi development build",
      supported: true
    });
  });
});
