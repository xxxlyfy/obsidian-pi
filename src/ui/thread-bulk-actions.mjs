import { STRINGS } from "../shared/strings.mjs";
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
  const parts = [STRINGS.threads.bulkDeleted(deletedCount)];
  if (skippedCount > 0) parts.push(STRINGS.threads.bulkSkipped(skippedCount));
  if (createdEmptyChat) parts.push(STRINGS.threads.bulkCreatedEmpty);
  return `${parts.join("；")}。${STRINGS.threads.bulkSessionsKept}`;
}
