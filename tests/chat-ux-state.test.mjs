import { afterEach, describe, expect, it } from "vitest";
import { getSendActionState } from "../src/ui/send-state.mjs";
import { formatBulkDeleteResult, planBulkThreadDeletion } from "../src/ui/thread-bulk-actions.mjs";
import { setLocale } from "../src/shared/i18n/index.mjs";

afterEach(() => setLocale("en"));

describe("chat UX state", () => {
  it("keeps send, queue, cancel, and canceling actions distinct", () => {
    expect(getSendActionState({ running: false, canceling: false, hasInput: true }).state).toBe(
      "send"
    );
    expect(getSendActionState({ running: true, canceling: false, hasInput: true }).state).toBe(
      "queue"
    );
    expect(getSendActionState({ running: true, canceling: false, hasInput: false }).state).toBe(
      "cancel"
    );
    expect(getSendActionState({ running: true, canceling: true, hasInput: false })).toMatchObject({
      state: "canceling",
      disabled: true
    });
  });

  it("plans bulk deletion with favorite protection and active-run safety", () => {
    const plan = planBulkThreadDeletion(
      [
        { id: "ready", favorite: false },
        { id: "favorite", favorite: true },
        { id: "running", favorite: false },
        { id: "running-favorite", favorite: true }
      ],
      ["running", "running-favorite"]
    );

    expect(plan).toEqual({
      all: {
        deleteIds: ["ready", "favorite"],
        skippedIds: ["running", "running-favorite"],
        deleteCount: 2,
        skippedCount: 2
      },
      exceptFavorites: {
        deleteIds: ["ready"],
        skippedIds: ["running"],
        deleteCount: 1,
        skippedCount: 1
      },
      favoriteCount: 2
    });
    expect(
      formatBulkDeleteResult({ deletedCount: 1, skippedCount: 1, createdEmptyChat: true })
    ).toBe(
      "1 chat deleted; 1 active chat was skipped; a new empty chat was created. Local Pi sessions were kept."
    );
  });

  it("localizes send action labels, queued suffix, and bulk delete results", () => {
    const idle = { running: false, canceling: false, hasInput: false };
    expect(getSendActionState(idle)).toMatchObject({
      label: "Send",
      ariaLabel: "Send message",
      titleSuffix: ""
    });
    expect(getSendActionState({ ...idle, queuedCount: 2 })).toMatchObject({
      titleSuffix: "2 queued."
    });
    expect(getSendActionState({ running: true, canceling: false, hasInput: true })).toMatchObject({
      label: "Queue",
      ariaLabel: "Queue message"
    });
    expect(getSendActionState({ running: true, canceling: false, hasInput: false })).toMatchObject({
      label: "Cancel",
      ariaLabel: "Cancel agent run"
    });
    expect(getSendActionState({ running: true, canceling: true, hasInput: false })).toMatchObject({
      label: "Canceling",
      ariaLabel: "Canceling agent run"
    });

    setLocale("zh-cn");
    expect(getSendActionState(idle)).toMatchObject({ label: "发送", ariaLabel: "发送消息" });
    expect(getSendActionState({ ...idle, queuedCount: 2 })).toMatchObject({
      titleSuffix: "已排队 2 条。"
    });
    expect(getSendActionState({ running: true, canceling: false, hasInput: true })).toMatchObject({
      label: "排队",
      ariaLabel: "消息加入队列"
    });
    expect(getSendActionState({ running: true, canceling: false, hasInput: false })).toMatchObject({
      label: "取消",
      ariaLabel: "取消代理运行"
    });
    expect(getSendActionState({ running: true, canceling: true, hasInput: false })).toMatchObject({
      label: "正在取消",
      ariaLabel: "正在取消代理运行"
    });
    expect(
      formatBulkDeleteResult({ deletedCount: 2, skippedCount: 1, createdEmptyChat: true })
    ).toBe("2 个对话已删除；1 个进行中的对话已跳过；已新建一个空对话。本地 Pi 会话已保留。");

    setLocale("en");
    expect(
      formatBulkDeleteResult({ deletedCount: 1, skippedCount: 1, createdEmptyChat: true })
    ).toBe(
      "1 chat deleted; 1 active chat was skipped; a new empty chat was created. Local Pi sessions were kept."
    );
  });

  it("handles zero favorites and all-favorite histories", () => {
    expect(
      planBulkThreadDeletion([
        { id: "one", favorite: false },
        { id: "two", favorite: false }
      ]).exceptFavorites.deleteIds
    ).toEqual(["one", "two"]);

    const allFavorites = planBulkThreadDeletion([
      { id: "one", favorite: true },
      { id: "two", favorite: true }
    ]);
    expect(allFavorites.exceptFavorites.deleteCount).toBe(0);
    expect(allFavorites.all.deleteIds).toEqual(["one", "two"]);
  });
});
