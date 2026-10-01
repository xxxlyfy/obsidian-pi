import * as f from "obsidian";
import { chooseThreadDeletion } from "./modals/delete-thread-modal.mjs";
import { chooseBulkThreadDeletion } from "./modals/delete-threads-modal.mjs";
import { formatBulkDeleteResult, planBulkThreadDeletion } from "./thread-bulk-actions.mjs";
// Aliased: `t` is already a local identifier throughout this view.
import { t as tr, tCount as trCount } from "../shared/i18n/index.mjs";

const PI_BRAND_NAME = "Pi";

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function showThreadList() {
  this.showingThreadList = !0;
  this.renderThreadList();
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function renderThreadList() {
  var a;
  let e = this.containerEl.children[1],
    t = this.plugin.listThreads({ includeArchived: !0 }),
    n = this.plugin.getCurrentThread();
  // Every render claims a generation. A background session count is only allowed to
  // touch the DOM while its generation is still the current one, so a result that
  // arrives after the list was re-rendered (or left) cannot update stale rows.
  this.threadListRenderGeneration += 1;
  this.threadListRows = new Map();
  if ((a = this.suggestions) != null) a.close();
  this.cleanupComposerBarObserver();
  this.messagesEl = void 0;
  this.inputEl = void 0;
  this.sendButtonEl = void 0;
  this.composerBarEl = void 0;
  this.runSettings = void 0;
  this.toolBadgesEl = void 0;
  this.threadTitleEl = void 0;
  this.threadFavoriteEl = void 0;
  e.empty();
  e.addClass("pi-agent-view");
  let s = e.createDiv({ cls: "pi-agent-thread-list-header" }),
    o = s.createEl("button", {
      cls: "clickable-icon pi-agent-header-action",
      attr: { "aria-label": tr("threadList.back"), title: tr("threadList.back") }
    });
  (0, f.setIcon)(o, "arrow-left");
  o.addEventListener("click", () => this.renderChatView());
  let l = s.createDiv({ cls: "pi-agent-thread-list-heading" });
  l.createDiv({ cls: "pi-agent-thread-list-title-heading", text: tr("threadList.title") });
  l.createDiv({
    cls: "pi-agent-thread-list-subtitle",
    text: trCount("threadList.count", t.length)
  });
  let deleteChatsButton = s.createEl("button", {
    cls: "clickable-icon pi-agent-header-action",
    attr: { "aria-label": tr("threadList.deleteChats"), title: tr("threadList.deleteChats") }
  });
  (0, f.setIcon)(deleteChatsButton, "trash-2");
  deleteChatsButton.addEventListener("click", () => this.deleteChats());
  let d = s.createEl("button", {
    cls: "clickable-icon pi-agent-header-action",
    attr: { "aria-label": tr("threadList.newChat"), title: tr("threadList.newChat") }
  });
  (0, f.setIcon)(d, "plus");
  d.addEventListener("click", () => {
    this.plugin.startNewThread();
    this.renderChatView();
  });
  let h = e.createDiv({ cls: "pi-agent-thread-list" });
  if (t.length === 0) {
    h.createDiv({ cls: "pi-agent-empty", text: tr("threadList.empty") });
    return;
  }
  // `formatThreadMeta` reads the session count cache only, so this whole loop is
  // synchronous and never blocks on session files.
  const renderGeneration = this.threadListRenderGeneration;
  t.forEach((m) => this.renderThreadListRow(h, m, m.id === n.id));
  // The callback runs later, from the plugin's async refresh, so it carries its own
  // view binding instead of relying on how the plugin calls it.
  const repaintRow = (thread, count) =>
    this.updateThreadListRowMeta(thread, count, renderGeneration);
  this.plugin.refreshThreadListSessionCounts(t, renderGeneration, repaintRow);
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function renderThreadListRow(e, t, n) {
  let s = e.createDiv({
      cls: `pi-agent-thread-list-row${n ? " is-current" : ""}`
    }),
    a = s.createDiv({ cls: "pi-agent-thread-list-info" }),
    o = a.createDiv({
      cls: "pi-agent-thread-list-title",
      attr: { title: tr("threadList.openChat") }
    });
  if (this.isThreadRunning(t.id)) {
    let h = o.createSpan({
      cls: "pi-agent-thread-list-running",
      attr: { title: tr("threadList.running") }
    });
    (0, f.setIcon)(h, "loader");
  }
  o.createSpan({ text: t.title });
  s.addEventListener("click", () => {
    this.plugin.switchThread(t.id);
    this.renderChatView();
  });
  const metaEl = a.createDiv({
    cls: "pi-agent-thread-list-meta",
    text: this.formatThreadMeta(t, n)
  });
  // The background session count refresh updates exactly this element through
  // `updateThreadListRowMeta`, so the row has to remember it and the thread it
  // belongs to. The map is rebuilt by every render.
  this.threadListRows.set(t.id, { row: s, metaEl });
  let l = s.createDiv({ cls: "pi-agent-thread-list-actions" }),
    d = l.createEl("button", {
      cls: `clickable-icon pi-agent-thread-list-action pi-agent-thread-favorite${t.favorite ? " is-favorite" : ""}`,
      attr: {
        "aria-label": tr(t.favorite ? "view.favoriteRemove" : "view.favoriteAdd"),
        title: tr(t.favorite ? "view.favoriteRemove" : "view.favoriteAdd"),
        "aria-pressed": String(t.favorite === true)
      }
    }),
    deleteButton = l.createEl("button", {
      cls: "clickable-icon pi-agent-thread-list-action pi-agent-thread-delete",
      attr: { "aria-label": tr("threadList.deleteChat"), title: tr("threadList.deleteChat") }
    }),
    h = l.createEl("button", {
      cls: "clickable-icon pi-agent-thread-list-action",
      attr: { "aria-label": tr("threadList.actions"), title: tr("threadList.actions") }
    });
  (0, f.setIcon)(d, "star");
  d.addEventListener("click", (u) => {
    u.preventDefault();
    u.stopPropagation();
    this.toggleThreadFavorite(t);
  });
  (0, f.setIcon)(deleteButton, "trash-2");
  deleteButton.addEventListener("click", (u) => {
    u.preventDefault();
    u.stopPropagation();
    this.deleteThreadFromList(t);
  });
  (0, f.setIcon)(h, "more-horizontal");
  h.addEventListener("click", (u) => {
    u.preventDefault();
    u.stopPropagation();
    this.showThreadRowMenu(u, t, n, o);
  });
}

export async function deleteChats() {
  const threads = this.plugin.listThreads({ includeArchived: true });
  const plan = planBulkThreadDeletion(threads, [...this.state.activeRuns.keys()]);
  if (plan.all.deleteCount === 0) {
    new f.Notice(
      tr(plan.all.skippedCount > 0 ? "threadList.deleteBlocked" : "threadList.deleteNothing")
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

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function showThreadRowMenu(e, t, n, s) {
  let a = new f.Menu();
  a.addItem((o) =>
    o
      .setTitle(tr(n ? "threadList.currentChat" : "threadList.open"))
      .setIcon(n ? "check" : "arrow-right")
      .setDisabled(n)
      .onClick(() => {
        this.plugin.switchThread(t.id);
        this.renderChatView();
      })
  );
  a.addItem((o) =>
    o
      .setTitle(tr(t.favorite ? "view.favoriteRemove" : "view.favoriteAdd"))
      .setIcon("star")
      .onClick(() => this.toggleThreadFavorite(t))
  );
  a.addItem((o) =>
    o
      .setTitle(tr("threadList.rename"))
      .setIcon("pencil")
      .onClick(() => this.startThreadListRename(t, s))
  );
  if (t.piSessionId) {
    a.addItem((o) =>
      o
        .setTitle(tr("threadList.sessionInfo", { brand: PI_BRAND_NAME }))
        .setIcon("info")
        .onClick(async () => {
          try {
            const [stats, tree] = await Promise.all([
              this.plugin.getThreadSessionStats(t.id),
              this.plugin.getThreadSessionTree(t.id)
            ]);
            const entryCount = countSessionEntries(/** @type {any} */ (tree?.tree ?? []));
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
    a.addItem((o) =>
      o
        .setTitle(tr("threadList.exportSession", { brand: PI_BRAND_NAME }))
        .setIcon("download")
        .onClick(async () => {
          try {
            const result = await this.plugin.exportThreadSession(t.id);
            new f.Notice(result?.path ? `Exported to ${result.path}` : "Session export failed.");
          } catch (error) {
            new f.Notice(error instanceof Error ? error.message : String(error));
          }
        })
    );
  }
  a.addSeparator();
  a.addItem((o) =>
    o
      .setTitle(tr("threadList.delete"))
      .setIcon("trash-2")
      .onClick(() => this.deleteThreadFromList(t))
  );
  a.showAtMouseEvent(e);
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function startThreadListRename(e, t) {
  let n = document.createElement("input");
  n.addClass("pi-agent-thread-list-title-input");
  n.setAttr("type", "text");
  n.setAttr("aria-label", tr("view.chatTitle"));
  n.value = e.title;
  t.replaceWith(n);
  let s = (a) => {
    let o = n.value.trim();
    if (a && o && o !== e.title) this.plugin.renameThread(e.id, o);
    this.renderThreadList();
  };
  n.addEventListener("click", (a) => a.stopPropagation());
  n.addEventListener("keydown", (a) => {
    if (a.key === "Enter") {
      a.preventDefault();
      s(!0);
    } else if (a.key === "Escape") {
      a.preventDefault();
      s(!1);
    }
  });
  n.addEventListener("blur", () => s(!0));
  n.focus();
  n.select();
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function toggleThreadFavorite(e) {
  this.plugin.toggleThreadFavorite(e.id)
    ? this.renderThreadList()
    : new f.Notice(tr("view.threadMissing"));
}

export async function deleteThreadFromList(e) {
  if (this.isThreadRunning(e.id)) {
    new f.Notice(tr("threadList.deleteRunning"));
    return;
  }
  const choice = await chooseThreadDeletion(this.plugin.app, e);
  if (choice === "cancel") return;
  if (this.plugin.deleteThread(e.id, { deletePiSession: choice === "both" })) {
    new f.Notice(tr(choice === "both" ? "threadList.deletedBoth" : "threadList.deletedChat"));
    this.renderThreadList();
  } else {
    new f.Notice(tr("threadList.deleteFailed"));
  }
}

/**
 * Paint one row's meta from the session count cache.
 *
 * Called synchronously while the row is created, which is why it may only use the
 * cache: a thread whose session file has not been counted yet falls back to its own
 * message count, and the background refresh repaints the row when the real count
 * arrives.
 *
 * @this {import("./view/view-surface.mjs").PiAgentViewSurface}
 */
export function formatThreadMeta(e, t) {
  let n = this.plugin.getThreadDisplayMessageCount
      ? this.plugin.getThreadDisplayMessageCount(e)
      : e.messages.length,
    s = trCount("threadList.meta", n, { date: this.formatThreadDate(e.updatedAt) });
  return t ? tr("threadList.currentMeta", { meta: s }) : s;
}

/**
 * Repaint one row's meta after its session count came back.
 *
 * Deliberately not a re-render: rebuilding the list would recreate every row and
 * flicker. The row is still updated only when it is the row this render created for
 * this thread and the render is still current, so a late count cannot land on a
 * rebuilt list, on another thread's row, or on rows that are gone.
 *
 * @this {import("./view/view-surface.mjs").PiAgentViewSurface}
 * @param {any} thread The thread this count belongs to.
 * @param {number} count The scanned Pi session message count.
 * @param {number} renderGeneration The generation of the render that asked.
 */
export function updateThreadListRowMeta(thread, count, renderGeneration) {
  if (renderGeneration !== this.threadListRenderGeneration) return;
  const entry = this.threadListRows?.get(thread.id);
  if (!entry) return;

  // Same rule as `getThreadDisplayMessageCount`, now that the count is cached.
  const displayed = Math.max(thread.messages?.length ?? 0, count);
  const meta = trCount("threadList.meta", displayed, {
    date: this.formatThreadDate(thread.updatedAt)
  });
  // `threadListRows` only ever holds the rows this render created, so a surviving
  // entry is the row for this thread; the generation check above covers the render
  // this row came from.
  entry.metaEl.setText(
    this.isCurrentThread(thread.id) ? tr("threadList.currentMeta", { meta }) : meta
  );
}

export function countSessionEntries(nodes) {
  return nodes.reduce(
    (count, node) =>
      count +
      1 +
      countSessionEntries(/** @type {any} */ (Array.isArray(node.children) ? node.children : [])),
    0
  );
}

/** @this {import("./view/view-surface.mjs").PiAgentViewSurface} */
export function formatThreadDate(e) {
  try {
    return new Date(e).toLocaleString();
  } catch {
    return tr("threadList.unknownDate");
  }
}
