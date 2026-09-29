import { t, tCount } from "../shared/i18n/index.mjs";

export function planBulkThreadDeletion(threads, runningThreadIds = []) {
  const running = new Set(runningThreadIds);
  const createScope = (candidates) => {
    const deleteIds = candidates
      .filter((thread) => !running.has(thread.id))
      .map((thread) => thread.id);
    const skippedIds = candidates
      .filter((thread) => running.has(thread.id))
      .map((thread) => thread.id);

    return {
      deleteIds,
      skippedIds,
      deleteCount: deleteIds.length,
      skippedCount: skippedIds.length
    };
  };

  return {
    all: createScope(threads),
    exceptFavorites: createScope(threads.filter((thread) => thread.favorite !== true)),
    favoriteCount: threads.filter((thread) => thread.favorite === true).length
  };
}

export function formatBulkDeleteResult({ deletedCount, skippedCount, createdEmptyChat }) {
  const parts = [tCount("deleteThreads.result.deleted", deletedCount)];
  if (skippedCount > 0) parts.push(tCount("deleteThreads.result.skipped", skippedCount));
  if (createdEmptyChat) parts.push(t("deleteThreads.result.created"));

  const body = parts.join(t("deleteThreads.result.sep"));
  return `${body}${t("deleteThreads.result.tail")}${t("deleteThreads.result.suffix")}`;
}
