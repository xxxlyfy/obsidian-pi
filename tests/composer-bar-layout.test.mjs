import fs from "node:fs";
import { describe, expect, it } from "vitest";

const viewSource = fs.readFileSync("src/ui/PiAgentView.mjs", "utf8");
const styles = fs.readFileSync("styles.css", "utf8");

describe("single-row composer bar", () => {
  it("never wraps the composer bar and keeps the run-setting labels visible", () => {
    expect(styles).toMatch(/\.pi-agent-composer-bar \{[^}]*flex-wrap: nowrap;/);
    expect(styles).not.toMatch(/\.pi-agent-control-label \{[^}]*display: none;/);
    expect(styles).not.toContain("pi-agent-composer-expand");
    expect(styles).not.toContain("is-expanded");
    expect(styles).not.toMatch(/\.pi-agent-composer-bar \{[^}]*flex-wrap: wrap;/);
  });

  it("tightens the compact spacing instead of hiding the labels", () => {
    expect(styles).toMatch(/\.pi-agent-composer-bar\.is-compact \{[^}]*gap: 8px;/);
    expect(styles).toMatch(
      /\.pi-agent-composer-bar\.is-compact \.pi-agent-run-settings \{[^}]*gap: 8px;/
    );
    expect(styles).toMatch(
      /\.pi-agent-composer-bar\.is-compact \.pi-agent-run-setting \{[^}]*gap: 3px;[^}]*min-width: 0;/
    );
    expect(styles).toMatch(
      /\.pi-agent-composer-bar\.is-compact \.pi-agent-run-setting-model \.pi-agent-control-label \{[^}]*max-width: 120px;/
    );
  });

  it("shrinks controls in narrow panes so one row still fits", () => {
    expect(styles).toMatch(/\.pi-agent-composer-bar\.is-narrow \{[^}]*gap: 5px;/);
    expect(styles).toMatch(
      /\.pi-agent-composer-bar\.is-narrow \.pi-agent-run-setting \.pi-agent-control-label \{[^}]*max-width: 62px;/
    );
    expect(styles).toMatch(
      /\.pi-agent-composer-bar\.is-narrow \.pi-agent-send-button \{[^}]*margin-left: auto;/
    );
    expect(styles).toMatch(
      /\.pi-agent-composer-bar\.is-compact \.pi-agent-run-setting \{[^}]*flex: 0 1 auto;[^}]*overflow: hidden;/
    );
  });

  it("keeps only the responsive class toggles in the view", () => {
    expect(viewSource).toContain('bar.toggleClass("is-compact", isCompact);');
    expect(viewSource).toContain('bar.toggleClass("is-narrow", isNarrow);');
    expect(viewSource).not.toContain("composerBarExpanded");
    expect(viewSource).not.toContain("updateComposerBarExpansion");
  });
});
