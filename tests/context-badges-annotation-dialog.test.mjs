import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { readSources } from "./helpers/view-source.mjs";

// The chat view's badge and prompt wiring spans the view class, the prompt-run
// stages, and the chat DOM builders it delegates to, so read them as one source.
const viewSource = readSources([
  "ui/PiAgentView.mjs",
  "ui/view/run-prompt.mjs",
  "ui/view/chat-dom.mjs"
]);
const pluginSource = fs.readFileSync("src/plugin/PiAgentPlugin.mjs", "utf8");
const controllerSource = fs.readFileSync(
  "src/annotations/markdown-annotations-controller.mjs",
  "utf8"
);
const modalSource = fs.readFileSync("src/annotations/annotation-modal.mjs", "utf8");
const graphSource = fs.readFileSync("src/context/vault-graph.mjs", "utf8");
const styles = fs.readFileSync("styles.css", "utf8");

describe("pending context badges", () => {
  it("uses compact badges without duplicate current-note prose", () => {
    expect(viewSource).not.toContain("Current:");
    expect(viewSource).not.toContain("No current note");
    expect(viewSource).toContain("pi-agent-context-badge-remove");
    expect(viewSource).toContain("this.renderPendingBadge(badges, contextFile.name, {");
    expect(viewSource).toContain("`Remove ${contextFile.name} from context`");
    expect(viewSource).toContain('`Remove ${image.fileName || "image"}`');
    expect(viewSource).toContain("`Remove ${attachment.fileName}`");
    expect(viewSource).toContain("`Clear ${label}`");
    expect(styles).toMatch(
      /\.pi-agent-context-badge \{[\s\S]*?background: var\(--background-secondary\);[\s\S]*?max-width:/
    );
  });

  it("keeps pending files and annotations removable while the current note can be excluded", () => {
    expect(pluginSource).toContain("excludedContextPath");
    expect(viewSource).not.toContain("includeActiveNote");
    expect(pluginSource).not.toContain("includeActiveNote");
    expect(viewSource).toContain("if (!onRemove) return");
    // Prettier wraps this assignment, so match the shape rather than one line.
    expect(viewSource).toMatch(
      /this\.state\.composerImages = this\.state\.composerImages\.filter\(\s*\(item\) => item\.id !== image\.id/
    );
    expect(viewSource).toContain("(item) => item.id !== attachment.id");
    expect(viewSource).toContain("this.plugin.annotationStore.deletePath(contextFile.path)");
    expect(viewSource).toContain("contextFilePath: request.annotationSourcePath");
    expect(pluginSource).toContain("this.refreshAnnotationBadges()");
    expect(pluginSource).toContain("Follow every annotation's user-authored request");
  });
});

describe("current note exclusion", () => {
  it("skips the excluded note wherever prompt context is resolved", () => {
    expect(pluginSource).toContain("this.isExcludedContextFile(this.currentContextFile)");
    expect(pluginSource).toContain("excludeContextFile(path) {");
    expect(graphSource).toContain("const file = this.getCurrentContextFile");
    expect(graphSource).not.toContain("this.getCurrentContextFile?.() ??");
  });

  it("restores the current note after another note opens or the chat changes", () => {
    expect(pluginSource).toContain("this.currentContextFile.path !== this.excludedContextPath");
    const clears = pluginSource.match(/this\.clearExcludedContextFile\(\)/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(4);
  });
});

describe("compact annotation controls", () => {
  it("deletes annotation metadata immediately without a confirmation modal", () => {
    expect(controllerSource).not.toContain("AnnotationDeleteModal");
    expect(controllerSource).toContain(
      "this.plugin.annotationStore.delete(annotation.path, annotation.id)"
    );
    expect(controllerSource).toContain('"Delete annotation"');
  });

  it("keeps labelled, validated, keyboard-accessible native-style dialog controls", () => {
    expect(modalSource).not.toContain("annotation-modal-quote");
    expect(modalSource).not.toContain("anchorLabel");
    expect(modalSource).toContain('text: "Request"');
    expect(modalSource).toContain('attr: { "aria-label": "Annotation intent" }');
    expect(modalSource).toContain('type: "radio"');
    expect(modalSource).toContain('text: "Save"');
    expect(modalSource).toContain('this.scope.register(["Mod"], "Enter"');
    expect(modalSource).toContain('this.contextEl.setAttr("aria-describedby", errorId)');
    expect(modalSource).toContain('this.contextEl?.setAttr("aria-invalid", "true")');
    expect(styles).toMatch(
      /\.pi-agent-annotation-intent input:checked \+ span[\s\S]*?background: var\(--interactive-accent\);/
    );
    expect(styles).toContain(".pi-agent-annotation-intent input:focus-visible + span");
    expect(styles).not.toContain(":has(");
  });
});
