import { describe, expect, it, vi } from "vitest";
import { STRINGS } from "../src/shared/strings.mjs";

vi.mock("obsidian", () => ({
  Modal: class {}
}));

const { getThreadDeletionChoices } = await import("../src/ui/modals/delete-thread-modal.mjs");
const { getBulkThreadDeletionChoices } = await import("../src/ui/modals/delete-threads-modal.mjs");

describe("DeleteThreadModal choices", () => {
  it("keeps Pi session deletion separate and opt-in", () => {
    expect(getThreadDeletionChoices({ title: "Chat", piSessionId: "session.jsonl" })).toEqual([
      "cancel",
      "chat",
      "both"
    ]);
  });

  it("does not offer local Pi cleanup when the chat has no session", () => {
    expect(getThreadDeletionChoices({ title: "Chat" })).toEqual(["cancel", "chat"]);
  });

  it("offers bulk deletion for all chats or all except favorites", () => {
    expect(
      getBulkThreadDeletionChoices({
        all: { deleteCount: 5 },
        exceptFavorites: { deleteCount: 3 }
      })
    ).toEqual([
      {
        id: "except-favorites",
        label: STRINGS.modals.deleteAllExceptFavorites(3),
        disabled: false
      },
      { id: "all", label: STRINGS.modals.deleteAllChats(5), disabled: false }
    ]);
  });

  it("disables an empty favorites-preserving scope", () => {
    expect(
      getBulkThreadDeletionChoices({
        all: { deleteCount: 2 },
        exceptFavorites: { deleteCount: 0 }
      })[0]
    ).toMatchObject({ id: "except-favorites", disabled: true });
  });
});
