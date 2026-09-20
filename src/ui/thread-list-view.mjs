import * as f from "obsidian";
import { chooseThreadDeletion } from "./modals/delete-thread-modal.mjs";
import { chooseBulkThreadDeletion } from "./modals/delete-threads-modal.mjs";
import { formatBulkDeleteResult, planBulkThreadDeletion } from "./thread-bulk-actions.mjs";

const PI_BRAND_NAME = "Pi";

export function showThreadList() {
  this.showingThreadList = true;
  this.renderThreadList();
}

export function renderThreadList() {
  let root = this.containerEl.children[1],
    threads = this.plugin.listThreads({ includeArchived: true }),
    currentThread = this.plugin.getCurrentThread();
  this.suggestions?.close();
  this.cleanupComposerBarObserver();
  this.messagesEl = undefined;
  this.inputEl = undefined;
  this.sendButtonEl = undefined;
  this.composerBarEl = undefined;
  this.composerBarExpandEl = undefined;
  this.runSettings = undefined;
  this.toolBadgesEl = undefined;
  this.threadTitleEl = undefined;
  this.threadFavoriteEl = undefined;
  root.empty();
  root.addClass("pi-agent-view");
  let header = root.createDiv({ cls: "pi-agent-thread-list-header" }),
    backButton = header.createEl("button", {
      cls: "clickable-icon pi-agent-header-action",
      attr: { "aria-label": "Back to chat", title: "Back to chat" }
    });
  (0, f.setIcon)(backButton, "arrow-left");
  backButton.addEventListener("click", () => this.renderChatView());
  let heading = header.createDiv({ cls: "pi-agent-thread-list-heading" });
  heading.createDiv({ cls: "pi-agent-thread-list-title-heading", text: "Threads" });
  heading.createDiv({
    cls: "pi-agent-thread-list-subtitle",
    text: `${threads.length} chat${threads.length === 1 ? "" : "s"}`
  });
  let deleteChatsButton = header.createEl("button", {
    cls: "clickable-icon pi-agent-header-action",
    attr: { "aria-label": "Delete chats", title: "Delete chats" }
  });
  (0, f.setIcon)(deleteChatsButton, "trash-2");
  deleteChatsButton.addEventListener("click", () => this.deleteChats());
  let newChatButton = header.createEl("button", {
    cls: "clickable-icon pi-agent-header-action",
    attr: { "aria-label": "New chat", title: "New chat" }
  });
  (0, f.setIcon)(newChatButton, "plus");
  newChatButton.addEventListener("click", () => {
    this.plugin.startNewThread();
    this.renderChatView();
  });
  let listEl = root.createDiv({ cls: "pi-agent-thread-list" });
  threads.length === 0
    ? listEl.createDiv({ cls: "pi-agent-empty", text: "No chat threads." })
    : threads.forEach((thread) =>
        this.renderThreadListRow(listEl, thread, thread.id === currentThread.id)
      );
}

export function renderThreadListRow(listEl, thread, isCurrent) {
  let row = listEl.createDiv({
      cls: `pi-agent-thread-list-row${isCurrent ? " is-current" : ""}`
    }),
    info = row.createDiv({ cls: "pi-agent-thread-list-info" }),
    titleEl = info.createDiv({
      cls: "pi-agent-thread-list-title",
      attr: { title: "Open chat" }
    });
  if (this.isThreadRunning(thread.id)) {
    let runningEl = titleEl.createSpan({
      cls: "pi-agent-thread-list-running",
      attr: { title: "Agent is running in this chat" }
    });
    (0, f.setIcon)(runningEl, "loader");
  }
  titleEl.createSpan({ text: thread.title });
  row.addEventListener("click", () => {
    this.plugin.switchThread(thread.id);
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
        "aria-label": thread.favorite ? "Remove favorite" : "Mark as favorite",
        title: thread.favorite ? "Remove favorite" : "Mark as favorite",
        "aria-pressed": String(thread.favorite === true)
      }
    }),
    deleteButton = actions.createEl("button", {
      cls: "clickable-icon pi-agent-thread-list-action pi-agent-thread-delete",
      attr: { "aria-label": "Delete chat", title: "Delete chat" }
    }),
    moreButton = actions.createEl("button", {
      cls: "clickable-icon pi-agent-thread-list-action",
      attr: { "aria-label": "Thread actions", title: "Thread actions" }
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

export async function deleteChats() {
  const threads = this.plugin.listThreads({ includeArchived: true });
  const plan = planBulkThreadDeletion(threads, [...this.activeRuns.keys()]);
  if (plan.all.deleteCount === 0) {
    new f.Notice(
      plan.all.skippedCount > 0
        ? "Wait for active agent runs to finish before deleting chats."
        : "There are no chats to delete."
    );
    return;
  }

  const choice = await chooseBulkThreadDeletion(this.plugin.app, plan);
  if (choice === "cancel") return;
  const scope = choice === "except-favorites" ? plan.exceptFavorites : plan.all;
  if (scope.deleteCount === 0) return;

  const newlyRunningIds = scope.deleteIds.filter((threadId) => this.isThreadRunning(threadId));
  const safeDeleteIds = scope.deleteIds.filter((threadId) => !this.isThreadRunning(threadId));
  const result = this.plugin.deleteThreads(safeDeleteIds);
  new f.Notice(
    formatBulkDeleteResult({
      deletedCount: result.deletedCount,
      skippedCount: scope.skippedCount + newlyRunningIds.length + result.skippedCount,
      createdEmptyChat: Boolean(result.createdThreadId)
    })
  );
  this.renderThreadList();
}

export function showThreadRowMenu(event, thread, isCurrent, titleEl) {
  let menu = new f.Menu();
  menu.addItem((item) =>
    item
      .setTitle(isCurrent ? "Current chat" : "Open")
      .setIcon(isCurrent ? "check" : "arrow-right")
      .setDisabled(isCurrent)
      .onClick(() => {
        this.plugin.switchThread(thread.id);
        this.renderChatView();
      })
  );
  menu.addItem((item) =>
    item
      .setTitle(thread.favorite ? "Remove favorite" : "Mark as favorite")
      .setIcon("star")
      .onClick(() => this.toggleThreadFavorite(thread))
  );
  menu.addItem((item) =>
    item
      .setTitle("Rename")
      .setIcon("pencil")
      .onClick(() => this.startThreadListRename(thread, titleEl))
  );
  if (thread.piSessionId) {
    menu.addItem((item) =>
      item
        .setTitle(`${PI_BRAND_NAME} session info`)
        .setIcon("info")
        .onClick(async () => {
          try {
            const [stats, tree] = await Promise.all([
              this.plugin.getThreadSessionStats(thread.id),
              this.plugin.getThreadSessionTree(thread.id)
            ]);
            const entryCount = countSessionEntries(tree?.tree ?? []);
            new f.Notice(
              stats
                ? `${stats.sessionFile}\n${stats.totalMessages} messages · ${entryCount} tree entries · ${stats.tokens?.total ?? 0} tokens · $${Number(stats.cost ?? 0).toFixed(4)}`
                : "No Pi session information is available."
            );
          } catch (error) {
            new f.Notice(error instanceof Error ? error.message : String(error));
          }
        })
    );
    menu.addItem((item) =>
      item
        .setTitle(`Export ${PI_BRAND_NAME} session to HTML`)
        .setIcon("download")
        .onClick(async () => {
          try {
            const result = await this.plugin.exportThreadSession(thread.id);
            new f.Notice(result?.path ? `Exported to ${result.path}` : "Session export failed.");
          } catch (error) {
            new f.Notice(error instanceof Error ? error.message : String(error));
          }
        })
    );
  }
  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle("Delete")
      .setIcon("trash-2")
      .onClick(() => this.deleteThreadFromList(thread))
  );
  menu.showAtMouseEvent(event);
}

export function startThreadListRename(thread, titleEl) {
  let input = document.createElement("input");
  input.addClass("pi-agent-thread-list-title-input");
  input.setAttr("type", "text");
  input.setAttr("aria-label", "Chat title");
  input.value = thread.title;
  titleEl.replaceWith(input);
  let commit = (event) => {
    let title = input.value.trim();
    if (event && title && title !== thread.title) this.plugin.renameThread(thread.id, title);
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

export function toggleThreadFavorite(thread) {
  this.plugin.toggleThreadFavorite(thread.id)
    ? this.renderThreadList()
    : new f.Notice("Chat thread was not found.");
}

export async function deleteThreadFromList(thread) {
  if (this.isThreadRunning(thread.id)) {
    new f.Notice("Wait for the agent run to finish before deleting this chat.");
    return;
  }
  const choice = await chooseThreadDeletion(this.plugin.app, thread);
  if (choice === "cancel") return;
  if (this.plugin.deleteThread(thread.id, { deletePiSession: choice === "both" })) {
    new f.Notice(choice === "both" ? "Chat and local Pi session deleted." : "Chat deleted.");
    this.renderThreadList();
  } else {
    new f.Notice("Chat or local Pi session could not be deleted.");
  }
}

export function formatThreadMeta(thread, isCurrent) {
  let messageCount = this.plugin.getThreadDisplayMessageCount
      ? this.plugin.getThreadDisplayMessageCount(thread)
      : thread.messages.length,
    meta = `${messageCount} message${messageCount === 1 ? "" : "s"} • Updated ${this.formatThreadDate(thread.updatedAt)}`;
  return isCurrent ? `Current • ${meta}` : meta;
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
    return "unknown date";
  }
}
