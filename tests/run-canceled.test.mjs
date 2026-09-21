import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { isPiRunCanceled, PiRunCanceledError } from "../src/pi/run-canceled.mjs";

const runnerSource = fs.readFileSync("src/pi/runner.mjs", "utf8");
const pluginSource = fs.readFileSync("src/plugin/PiAgentPlugin.mjs", "utf8");
const viewSource = fs.readFileSync("src/ui/PiAgentView.mjs", "utf8");

describe("run cancellation sentinel", () => {
  it("recognizes its own error", () => {
    expect(isPiRunCanceled(new PiRunCanceledError())).toBe(true);
    expect(new PiRunCanceledError().message).toBe("Pi run canceled.");
  });

  it("recognizes a cancel error that was re-wrapped on the way out", () => {
    const wrapped = new Error("RPC client failed", { cause: new PiRunCanceledError() });

    expect(isPiRunCanceled(wrapped)).toBe(true);
  });

  it("ignores unrelated errors and non-errors", () => {
    expect(isPiRunCanceled(new Error("Pi run canceled."))).toBe(false);
    expect(isPiRunCanceled(new Error("Pi RPC prompt timed out."))).toBe(false);
    expect(isPiRunCanceled(undefined)).toBe(false);
    expect(isPiRunCanceled("Pi run canceled.")).toBe(false);
  });

  it("never throws a plain error for cancellation", () => {
    expect(runnerSource).not.toContain('new Error("Pi run canceled."');
    expect(pluginSource).not.toContain('new Error("Pi run canceled."');
    expect(runnerSource).toContain("PiRunCanceledError");
    expect(pluginSource).toContain("PiRunCanceledError");
  });

  it("keeps the cancel path off the error message text", () => {
    expect(viewSource).not.toContain('message === "Pi run canceled."');
    expect(viewSource).toContain("isPiRunCanceled(error)");
  });
});
