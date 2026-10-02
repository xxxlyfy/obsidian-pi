/**
 * Which generation of a chat wins when two of them describe the same thread.
 *
 * `orderedSources()` reads the generation `data.json.chatHistoryStorageVersion` names
 * first, and the merge used to accept a later source whenever its `updatedAt` was
 * equal or newer (`>=`). Markdown `updated` is a millisecond ISO string, so it is
 * exactly equal to the JSON `updatedAt` the chat was migrated from - the normal state
 * of a half-finished migration - and the later, older generation won. The migrated
 * thread then lost its fields (`piSessionId`, `favorite`) and the import cleaned up
 * *both* generations from the vault, so the surviving JSON copy was gone too.
 *
 * These cases build both generations on disk in a temporary vault and import them
 * through the real module.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importVaultChatHistory } from "../src/threads/chat-history-import.mjs";

const STAMP = 1_741_064_767_089;
const CREATED = STAMP - 60_000;
const THREAD_ID = "tie-thread";

let temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function metadata(id, role) {
  return Buffer.from(JSON.stringify({ id, role, createdAt: CREATED })).toString("base64url");
}

/** The markdown generation: the authoritative one, and the richer of the two. */
function markdownThread() {
  return `---
pi_agent_chat: true
pi_agent_schema: 1
id: "${THREAD_ID}"
title: "Markdown generation"
created: "${new Date(CREATED).toISOString()}"
updated: "${new Date(STAMP).toISOString()}"
archived: false
favorite: true
pi_session: "session-a.jsonl"
---
<!-- pi-agent-message:start m1 ${metadata("m1", "user")} -->
hello from the markdown generation
<!-- pi-agent-message:end m1 -->
`;
}

/** The same thread as the older JSON generation left it: same id, same updatedAt. */
function jsonThread() {
  return JSON.stringify({
    thread: {
      id: THREAD_ID,
      title: "JSON generation",
      messages: [
        { id: "m1", role: "user", content: "hello from the json generation", createdAt: CREATED }
      ],
      createdAt: CREATED,
      updatedAt: STAMP
    }
  });
}

function createVault() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-import-tie-"));
  temporaryDirectories.push(base);
  const chats = path.join(base, "chats");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(path.join(chats, "chat.md"), markdownThread());
  fs.writeFileSync(path.join(chats, "chat.json"), jsonThread());
  return base;
}

const threadOf = (result) => result?.history?.threads?.[0];

describe("importing chat history from two generations of the same chat", () => {
  it("keeps the markdown generation when markdown is authoritative", async () => {
    const result = await importVaultChatHistory(createVault(), { chatHistoryStorageVersion: 3 });

    expect(threadOf(result)).toMatchObject({
      id: THREAD_ID,
      title: "Markdown generation",
      favorite: true,
      piSessionId: "session-a.jsonl",
      updatedAt: STAMP
    });
    expect(threadOf(result).messages[0].content).toBe("hello from the markdown generation");
  });

  it("keeps the json generation when json is authoritative", async () => {
    const result = await importVaultChatHistory(createVault(), { chatHistoryStorageVersion: 2 });

    expect(threadOf(result)).toMatchObject({ id: THREAD_ID, title: "JSON generation" });
    expect(threadOf(result).messages[0].content).toBe("hello from the json generation");
  });

  it("keeps the first generation that has the chat when no generation is named", async () => {
    const result = await importVaultChatHistory(createVault(), {});

    // No storage version means markdown, then json, then the indexed folder; the first
    // source that carries the chat keeps it.
    expect(threadOf(result).title).toBe("Markdown generation");
  });

  it("still takes a thread only one generation has", async () => {
    const base = createVault();
    fs.writeFileSync(
      path.join(base, "chats", "only-json.json"),
      JSON.stringify({
        thread: {
          id: "json-only",
          title: "JSON only",
          messages: [{ id: "j1", role: "user", content: "hi", createdAt: CREATED }],
          createdAt: CREATED,
          updatedAt: STAMP
        }
      })
    );

    const result = await importVaultChatHistory(base, { chatHistoryStorageVersion: 3 });
    const byId = new Map(result.history.threads.map((thread) => [thread.id, thread]));

    expect(byId.get(THREAD_ID).title).toBe("Markdown generation");
    expect(byId.get("json-only").title).toBe("JSON only");
  });
});
