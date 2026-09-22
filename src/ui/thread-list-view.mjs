import * as f from "obsidian";
import { STRINGS } from "../shared/strings.mjs";
import { chooseThreadDeletion } from "./modals/delete-thread-modal.mjs";
import { chooseBulkThreadDeletion } from "./modals/delete-threads-modal.mjs";
import { formatBulkDeleteResult, planBulkThreadDeletion } from "./thread-bulk-actions.mjs";

const PI_BRAND_NAME = "Pi";

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function showThreadList() {
  this.showingThreadList = true;
  this.renderThreadList();
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function renderThreadList() {
  let root = this.containerEl.children[1],
    threads = this.plugin.threads.listThreads({ includeArchived: true }),
    currentThread = this.plugin.threads.currentThread;
  this.suggestions?.close();
  this.cleanupComposerBarObserver();
  this.messagesEl = undefined;
  this.inputEl = undefined;
  this.sendButtonEl = undefined;
  this.composerBarEl = undefined;
  this.runSettings = undefined;
  this.toolBadgesEl = undefined;
  this.threadTitleEl = undefined;
  this.threadFavoriteEl = undefined;
  root.empty();
  root.addClass("pi-agent-view");
  let header = root.createDiv({ cls: "pi-agent-thread-list-header" }),
    backButton = header.createEl("button", {
      cls: "clickable-icon pi-agent-header-action",
      attr: { "aria-label": STRINGS.threads.backToChat, title: STRINGS.threads.backToChat }
    });
  (0, f.setIcon)(backButton, "arrow-left");
  backButton.addEventListener("click", () => this.renderChatView());
  let heading = header.createDiv({ cls: "pi-agent-thread-list-heading" });
  heading.createDiv({ cls: "pi-agent-thread-list-title-heading", text: STRINGS.threads.heading });
  heading.createDiv({
    cls: "pi-agent-thread-list-subtitle",
    text: STRINGS.threads.count(threads.length)
  });
  let deleteChatsButton = header.createEl("button", {
    cls: "clickable-icon pi-agent-header-action",
    attr: { "aria-label": STRINGS.threads.deleteChats, title: STRINGS.threads.deleteChats }
  });
  (0, f.setIcon)(deleteChatsButton, "trash-2");
  deleteChatsButton.addEventListener("click", () => this.deleteChats());
  let newChatButton = header.createEl("button", {
    cls: "clickable-icon pi-agent-header-action",
    attr: { "aria-label": STRINGS.threads.newChat, title: STRINGS.threads.newChat }
  });
  (0, f.setIcon)(newChatButton, "plus");
  newChatButton.addEventListener("click", () => {
    this.plugin.threads.startNewThread();
    this.renderChatView();
  });
  let listEl = root.createDiv({ cls: "pi-agent-thread-list" });
  threads.length === 0
    ? listEl.createDiv({ cls: "pi-agent-empty", text: STRINGS.threads.empty })
    : threads.forEach((thread) =>
        this.renderThreadListRow(listEl, thread, thread.id === currentThread.id)
      );
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function renderThreadListRow(listEl, thread, isCurrent) {
  let row = listEl.createDiv({
      cls: `pi-agent-thread-list-row${isCurrent ? " is-current" : ""}`
    }),
    info = row.createDiv({ cls: "pi-agent-thread-list-info" }),
    titleEl = info.createDiv({
      cls: "pi-agent-thread-list-title",
      attr: { title: STRINGS.threads.openChat }
    });
  if (this.isThreadRunning(thread.id)) {
    let runningEl = titleEl.createSpan({
      cls: "pi-agent-thread-list-running",
      attr: { title: STRINGS.threads.agentRunningInChat }
    });
    (0, f.setIcon)(runningEl, "loader");
  }
  titleEl.createSpan({ text: thread.title });
  row.addEventListener("click", () => {
    this.plugin.threads.switchThread(thread.id);
    this.renderChatView();
  });
  info.createDiv({
    cls: "pi-agent-thread-list-meta",
    text: this.formatThreadMeta(thread, isCurrent)
  });
  let actions = row.createDiv({ cls: "pi-agent-thread-list-actions" }),
    favoriteButton = actions.createEl("button", {
      cls: `clickable-icon pi-agent-thread-list-action pi-agent-thread-favorite${thread.favorite ? " is-favorite" : ""}`,
      attr: {
        "aria-label": thread.favorite
          ? STRINGS.threads.removeFavorite
          : STRINGS.threads.markFavorite,
        title: thread.favorite ? STRINGS.threads.removeFavorite : STRINGS.threads.markFavorite,
        "aria-pressed": String(thread.favorite === true)
      }
    }),
    deleteButton = actions.createEl("button", {
      cls: "clickable-icon pi-agent-thread-list-action pi-agent-thread-delete",
      attr: { "aria-label": STRINGS.threads.deleteChat, title: STRINGS.threads.deleteChat }
    }),
    moreButton = actions.createEl("button", {
      cls: "clickable-icon pi-agent-thread-list-action",
      attr: { "aria-label": STRINGS.threads.rowActions, title: STRINGS.threads.rowActions }
    });
  (0, f.setIcon)(favoriteButton, "star");
  favoriteButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    this.toggleThreadFavorite(thread);
  });
  (0, f.setIcon)(deleteButton, "trash-2");
  deleteButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    this.deleteThreadFromList(thread);
  });
  (0, f.setIcon)(moreButton, "more-horizontal");
  moreButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    this.showThreadRowMenu(event, thread, isCurrent, titleEl);
  });
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export async function deleteChats() {
  const threads = this.plugin.threads.listThreads({ includeArchived: true });
  const plan = planBulkThreadDeletion(threads, this.runtime.activeThreadIds());
  if (plan.all.deleteCount === 0) {
    new f.Notice(
      plan.all.skippedCount > 0
        ? STRINGS.threads.deleteBlockedByActiveRuns
        : STRINGS.threads.nothingToDelete
    );
    return;
  }

  const choice = await chooseBulkThreadDeletion(this.plugin.app, plan);
  if (choice === "cancel") return;
  const scope = choice === "except-favorites" ? plan.exceptFavorites : plan.all;
  if (scope.deleteCount === 0) return;

  const newlyRunningIds = scope.deleteIds.filter((threadId) => this.isThreadRunning(threadId));
  const safeDeleteIds = scope.deleteIds.filter((threadId) => !this.isThreadRunning(threadId));
  const result = this.plugin.threads.deleteThreads(safeDeleteIds);
  new f.Notice(
    formatBulkDeleteResult({
      deletedCount: result.deletedCount,
      skippedCount: scope.skippedCount + newlyRunningIds.length + result.skippedCount,
      createdEmptyChat: Boolean(result.createdThreadId)
    })
  );
  this.renderThreadList();
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function showThreadRowMenu(event, thread, isCurrent, titleEl) {
  let menu = new f.Menu();
  menu.addItem((item) =>
    item
      .setTitle(isCurrent ? STRINGS.threads.currentChat : STRINGS.threads.open)
      .setIcon(isCurrent ? "check" : "arrow-right")
      .setDisabled(isCurrent)
      .onClick(() => {
        this.plugin.threads.switchThread(thread.id);
        this.renderChatView();
      })
  );
  menu.addItem((item) =>
    item
      .setTitle(thread.favorite ? STRINGS.threads.removeFavorite : STRINGS.threads.markFavorite)
      .setIcon("star")
      .onClick(() => this.toggleThreadFavorite(thread))
  );
  menu.addItem((item) =>
    item
      .setTitle(STRINGS.common.rename)
      .setIcon("pencil")
      .onClick(() => this.startThreadListRename(thread, titleEl))
  );
  if (thread.piSessionId) {
    menu.addItem((item) =>
      item
        .setTitle(STRINGS.threads.sessionInfo(PI_BRAND_NAME))
        .setIcon("info")
        .onClick(async () => {
          try {
            const [stats, tree] = await Promise.all([
              this.plugin.threads.getThreadSessionStats(thread.id),
              this.plugin.threads.getThreadSessionTree(thread.id)
            ]);
            const entryCount = countSessionEntries(tree?.tree ?? []);
            new f.Notice(
              stats
                ? STRINGS.threads.sessionStats(
                    stats.sessionFile,
                    stats.totalMessages,
                    entryCount,
                    stats.tokens?.total ?? 0,
                    Number(stats.cost ?? 0).toFixed(4)
                  )
                : STRINGS.threads.noSessionInfo
            );
          } catch (error) {
            new f.Notice(error instanceof Error ? error.message : String(error));
          }
        })
    );
    menu.addItem((item) =>
      item
        .setTitle(STRINGS.threads.exportSession(PI_BRAND_NAME))
        .setIcon("download")
        .onClick(async () => {
          try {
            const result = await this.plugin.threads.exportThreadSession(thread.id);
            new f.Notice(
              result?.path ? STRINGS.threads.exportTo(result.path) : STRINGS.threads.exportFailed
            );
          } catch (error) {
            new f.Notice(error instanceof Error ? error.message : String(error));
          }
        })
    );
  }
  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle(STRINGS.common.delete)
      .setIcon("trash-2")
      .onClick(() => this.deleteThreadFromList(thread))
  );
  menu.showAtMouseEvent(event);
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function startThreadListRename(thread, titleEl) {
  let input = document.createElement("input");
  input.addClass("pi-agent-thread-list-title-input");
  input.setAttr("type", "text");
  input.setAttr("aria-label", STRINGS.threads.chatTitle);
  input.value = thread.title;
  titleEl.replaceWith(input);
  let commit = (event) => {
    let title = input.value.trim();
    if (event && title && title !== thread.title)
      this.plugin.threads.renameThread(thread.id, title);
    this.renderThreadList();
  };
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      commit(false);
    }
  });
  input.addEventListener("blur", () => commit(true));
  input.focus();
  input.select();
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function toggleThreadFavorite(thread) {
  this.plugin.threads.toggleThreadFavorite(thread.id)
    ? this.renderThreadList()
    : new f.Notice(STRINGS.threads.threadNotFound);
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export async function deleteThreadFromList(thread) {
  if (this.isThreadRunning(thread.id)) {
    new f.Notice(STRINGS.threads.activeRunDeleteBlocked);
    return;
  }
  const choice = await chooseThreadDeletion(this.plugin.app, thread);
  if (choice === "cancel") return;
  if (this.plugin.threads.deleteThread(thread.id, { deletePiSession: choice === "both" })) {
    new f.Notice(
      choice === "both" ? STRINGS.threads.deletedChatAndSession : STRINGS.threads.deletedChat
    );
    this.renderThreadList();
  } else {
    new f.Notice(STRINGS.threads.deleteFailed);
  }
}

/** @this {import("./PiAgentView.mjs").PiAgentView} */
export function formatThreadMeta(thread, isCurrent) {
  let messageCount = this.plugin.threads.getThreadDisplayMessageCount
      ? this.plugin.threads.getThreadDisplayMessageCount(thread)
      : thread.messages.length,
    meta = `${STRINGS.threads.messageCount(messageCount)} • ${STRINGS.threads.updatedAt(
      this.formatThreadDate(thread.updatedAt)
    )}`;
  return isCurrent ? `${STRINGS.threads.currentPrefix} • ${meta}` : meta;
}

export function countSessionEntries(nodes) {
  return nodes.reduce(
    (count, node) =>
      count + 1 + countSessionEntries(Array.isArray(node.children) ? node.children : []),
    0
  );
}

export function formatThreadDate(value) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return STRINGS.threads.unknownDate;
  }
}
