/**
 * Composer attachments: picking, reading, and removing images and text files.
 *
 * These methods were the largest self-contained cluster left in
 * `PiAgentView.mjs`. They only touch the composer's own state
 * (`state.composerImages`, `state.composerAttachments`) and the `toolBadgesEl`
 * repaint, so they do not need to sit next to the run lifecycle.
 *
 * They are mixed into `PiAgentView.prototype`, so they still run with `this` as
 * the view and no call site changed.
 */
import { FuzzySuggestModal, Menu, Notice } from "obsidian";

import { t as tr } from "../../shared/i18n/index.mjs";
import {
  bytesToPromptImage,
  createPromptTextAttachment,
  fileToPromptImage,
  isSupportedTextFile,
  modelSupportsImages,
  SUPPORTED_IMAGE_MIME_TYPES,
  textAttachmentBytes,
  MAX_TOTAL_TEXT_ATTACHMENT_BYTES
} from "../prompt-payload.mjs";

/**
 * The MIME type implied by a file name, for vault files that have no `type`.
 *
 * @param {string} name File name.
 * @returns {string} MIME type, or an empty string when the extension is unknown.
 */
function mimeForName(name) {
  const extension = String(name || "")
    .toLowerCase()
    .split(".")
    .pop();
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      md: "text/markdown",
      txt: "text/plain",
      csv: "text/csv",
      json: "application/json",
      yaml: "application/yaml",
      yml: "application/yaml",
      xml: "application/xml",
      html: "text/html",
      css: "text/css",
      js: "text/javascript",
      mjs: "text/javascript",
      ts: "text/typescript",
      py: "text/x-python"
    }[extension] || ""
  );
}

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export function showAttachmentMenu(event) {
  const menu = new Menu();
  menu.addItem((item) =>
    item
      .setTitle(tr("composer.vaultFile"))
      .setIcon("vault")
      .onClick(() => this.showVaultFilePicker())
  );
  menu.addItem((item) =>
    item
      .setTitle(tr("composer.localFile"))
      .setIcon("hard-drive")
      .onClick(() => this.imageInputEl?.click())
  );
  menu.showAtMouseEvent(event);
}

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export function showVaultFilePicker() {
  const getAttachableFiles = () =>
    this.plugin.app.vault
      .getFiles()
      .filter((file) => this.isAttachableFile(file.name, mimeForName(file.name)));
  const addVaultFile = (file) => this.addVaultFile(file);
  class VaultFileModal extends FuzzySuggestModal {
    getItems() {
      return getAttachableFiles();
    }
    getItemText(file) {
      return file.path;
    }
    onChooseItem(file) {
      addVaultFile(file);
    }
  }
  const modal = new VaultFileModal(this.plugin.app);
  modal.setPlaceholder(tr("composer.chooseFile"));
  modal.open();
}

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export function isAttachableFile(name, mimeType) {
  return SUPPORTED_IMAGE_MIME_TYPES.includes(mimeType) || isSupportedTextFile(name, mimeType);
}

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export function getImageFiles(files) {
  return [...(files || [])].filter((file) => SUPPORTED_IMAGE_MIME_TYPES.includes(file.type));
}

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export async function addLocalFiles(files) {
  for (const file of [...(files || [])]) {
    try {
      if (SUPPORTED_IMAGE_MIME_TYPES.includes(file.type)) await this.addImageFiles([file]);
      else {
        const remaining =
          MAX_TOTAL_TEXT_ATTACHMENT_BYTES - textAttachmentBytes(this.state.composerAttachments);
        const bytes = new Uint8Array(
          await file.slice(0, Math.min(file.size, remaining + 4)).arrayBuffer()
        );
        const attachment = createPromptTextAttachment(
          /** @type {any} */ ({
            bytes,
            fileName: file.name,
            mimeType: file.type,
            source: "local",
            originalSize: file.size
          }),
          remaining
        );
        this.state.composerAttachments.push(attachment);
      }
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }
  this.renderComposerImages();
  this.setRunningState(this.state.running);
}

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export async function addVaultFile(file) {
  try {
    const mimeType = mimeForName(file.name);
    const bytes = new Uint8Array(await this.plugin.app.vault.readBinary(file));
    if (SUPPORTED_IMAGE_MIME_TYPES.includes(mimeType)) {
      await this.plugin.ensureModelCatalogLoaded();
      if (!modelSupportsImages(this.plugin.getSelectedModelInfo()))
        throw new Error("The selected Pi model does not support image input.");
      this.state.composerImages.push(
        bytesToPromptImage({
          bytes,
          fileName: file.name,
          mimeType,
          source: "vault",
          path: file.path
        })
      );
    } else {
      this.state.composerAttachments.push(
        createPromptTextAttachment(
          /** @type {any} */ ({
            bytes,
            fileName: file.name,
            mimeType,
            source: "vault",
            path: file.path
          }),
          MAX_TOTAL_TEXT_ATTACHMENT_BYTES - textAttachmentBytes(this.state.composerAttachments)
        )
      );
    }
    this.renderComposerImages();
    this.setRunningState(this.state.running);
  } catch (error) {
    new Notice(error instanceof Error ? error.message : String(error));
  }
}

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export async function addImageFiles(files) {
  const imageFiles = [...(files || [])];
  if (imageFiles.length === 0) return;
  await this.plugin.ensureModelCatalogLoaded();
  if (!modelSupportsImages(this.plugin.getSelectedModelInfo())) {
    new Notice("The selected Pi model does not support image input.");
    return;
  }
  try {
    const images = await Promise.all(imageFiles.map(fileToPromptImage));
    this.state.composerImages.push(...images);
    this.renderComposerImages();
    this.setRunningState(this.state.running);
  } catch (error) {
    new Notice(error instanceof Error ? error.message : String(error));
  }
}

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export function handleImagePaste(event) {
  const files = this.getImageFiles(event.clipboardData?.files);
  if (files.length === 0) return;
  event.preventDefault();
  this.addImageFiles(files);
}

/** @this {import("./view-surface.mjs").PiAgentViewSurface} */
export function handleImageDrop(event) {
  const files = [...(event.dataTransfer?.files || [])];
  if (files.length === 0) return;
  event.preventDefault();
  this.addLocalFiles(files);
}

/**
 * The attachment methods as one object, mixed into the view's prototype.
 */
export const composerAttachmentMethods = {
  addImageFiles,
  addLocalFiles,
  addVaultFile,
  getImageFiles,
  handleImageDrop,
  handleImagePaste,
  isAttachableFile,
  showAttachmentMenu,
  showVaultFilePicker
};
