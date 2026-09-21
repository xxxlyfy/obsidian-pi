import { Modal } from "obsidian";
import { STRINGS } from "../shared/strings.mjs";
import { ANNOTATION_LIMITS } from "./annotation-model.mjs";

export class AnnotationModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
    this.intent = options.annotation?.intent ?? "change";
  }

  onOpen() {
    this.titleEl.setText(
      this.options.annotation ? STRINGS.annotations.editTitle : STRINGS.annotations.addTitle
    );
    this.contentEl.empty();
    this.modalEl.addClass("pi-agent-annotation-modal");

    const controlId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const contextId = `pi-agent-annotation-context-${controlId}`;
    this.contentEl.createEl("label", {
      text: STRINGS.annotations.request,
      attr: { for: contextId }
    });
    this.contextEl = this.contentEl.createEl("textarea", {
      cls: "pi-agent-annotation-context",
      attr: {
        id: contextId,
        rows: "4",
        maxlength: String(ANNOTATION_LIMITS.context),
        placeholder: STRINGS.annotations.placeholder
      }
    });
    this.contextEl.value = this.options.annotation?.context ?? "";
    this.contextEl.addEventListener("input", () => {
      this.contextEl?.removeAttribute("aria-invalid");
      this.errorEl?.empty();
    });

    const fieldset = this.contentEl.createEl("fieldset", {
      cls: "pi-agent-annotation-intents",
      attr: { "aria-label": STRINGS.annotations.intent }
    });
    for (const intent of ["change", "question"]) {
      const option = fieldset.createEl("label", { cls: "pi-agent-annotation-intent" });
      const input = option.createEl("input", {
        attr: { type: "radio", name: `pi-agent-annotation-intent-${controlId}`, value: intent }
      });
      input.checked = this.intent === intent;
      input.addEventListener("change", () => {
        if (input.checked) this.intent = intent;
      });
      option.createSpan({
        text: intent === "change" ? STRINGS.annotations.change : STRINGS.annotations.question
      });
    }

    const errorId = `pi-agent-annotation-error-${controlId}`;
    this.contextEl.setAttr("aria-describedby", errorId);
    this.errorEl = this.contentEl.createDiv({
      cls: "pi-agent-annotation-error",
      attr: { id: errorId, role: "alert", "aria-live": "polite" }
    });
    const actions = this.contentEl.createDiv({ cls: "pi-agent-modal-actions" });
    actions
      .createEl("button", { text: STRINGS.common.cancel })
      .addEventListener("click", () => this.close());
    this.saveButton = actions.createEl("button", {
      text: STRINGS.common.save,
      cls: "mod-cta"
    });
    this.saveButton.addEventListener("click", () => this.submit());

    this.scope.register(["Mod"], "Enter", (event) => {
      event.preventDefault();
      this.submit();
      return false;
    });
    window.setTimeout(() => this.contextEl?.focus(), 0);
  }

  async submit() {
    if (this.submitting) return;
    const context = this.contextEl?.value.trim() ?? "";
    if (!context) {
      this.errorEl?.setText(STRINGS.annotations.requestRequired);
      this.contextEl?.setAttr("aria-invalid", "true");
      this.contextEl?.focus();
      return;
    }

    this.submitting = true;
    this.saveButton?.setAttr("disabled", "");
    try {
      await this.options.onSave({ context, intent: this.intent });
      this.close();
    } catch (error) {
      this.errorEl?.setText(
        error instanceof Error ? error.message : STRINGS.annotations.saveFailed
      );
      this.submitting = false;
      this.saveButton?.removeAttribute("disabled");
      this.contextEl?.focus();
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
