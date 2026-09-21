import { Menu, Notice } from "obsidian";
import { STRINGS } from "../shared/strings.mjs";

export class MessageActions {
  constructor(plugin, callbacks) {
    this.plugin = plugin;
    this.callbacks = callbacks;
  }

  showMessageMenu(event, message, messageIndex) {
    const menu = new Menu();

    if (message.role === "user") {
      menu.addItem((item) =>
        item
          .setTitle(STRINGS.messages.editAndResend)
          .setIcon("pencil")
          .onClick(() => {
            const input = this.callbacks.getInput();
            if (input) {
              input.value = message.content;
              input.focus();
            }
          })
      );
      menu.addItem((item) =>
        item
          .setTitle(STRINGS.messages.searchVault)
          .setIcon("search")
          .onClick(() =>
            this.callbacks.runPrompt(`Search the vault for notes related to:\n\n${message.content}`)
          )
      );
    } else {
      menu.addItem((item) =>
        item
          .setTitle(STRINGS.messages.copyResponse)
          .setIcon("copy")
          .onClick(() => this.copyResponse(message.content))
      );
      menu.addItem((item) =>
        item
          .setTitle(STRINGS.messages.insertIntoNote)
          .setIcon("file-plus")
          .onClick(() =>
            this.runSafely(() => this.callbacks.insertIntoCurrentNote(message.content))
          )
      );
      menu.addItem((item) =>
        item
          .setTitle(STRINGS.messages.createNote)
          .setIcon("file-text")
          .onClick(() =>
            this.runSafely(() => this.callbacks.createNoteFromResponse(message.content))
          )
      );
      menu.addItem((item) =>
        item
          .setTitle(STRINGS.messages.openCitedNotes)
          .setIcon("links-coming-in")
          .setDisabled(this.callbacks.extractVaultLinks(message.content).length === 0)
          .onClick(() => this.runSafely(() => this.callbacks.openCitedNotes(message.content)))
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle(STRINGS.messages.regenerate)
          .setIcon("refresh-cw")
          .setDisabled(!this.callbacks.getPreviousUserPrompt(messageIndex))
          .onClick(() => {
            const prompt = this.callbacks.getPreviousUserPrompt(messageIndex);
            if (prompt) this.callbacks.runPrompt(prompt);
          })
      );
    }

    menu.showAtMouseEvent(event);
  }

  async copyResponse(content) {
    try {
      await navigator.clipboard.writeText(content);
      new Notice(STRINGS.messages.copied);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  runSafely(action) {
    Promise.resolve()
      .then(action)
      .catch((error) => new Notice(error instanceof Error ? error.message : String(error)));
  }
}
