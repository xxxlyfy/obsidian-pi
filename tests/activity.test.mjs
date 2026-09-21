import { describe, expect, it, vi } from "vitest";
import { STRINGS } from "../src/shared/strings.mjs";
import {
  formatRetryDetail,
  formatToolError,
  formatToolStatus,
  getSkillCommandName,
  getThinkingDelta,
  getToolEventKey,
  getToolKind,
  isStickyActivityKind,
  shouldBypassActivityStickiness
} from "../src/ui/activity.mjs";
import { handleRunEvent } from "../src/ui/run-activity-state.mjs";

describe("activity helpers", () => {
  it("classifies tool kinds", () => {
    expect(getToolKind("bash")).toBe("shell");
    expect(getToolKind("edit")).toBe("edit");
    expect(getToolKind("grep")).toBe("search");
    expect(getToolKind("read")).toBe("read");
  });

  it("formats readable tool statuses", () => {
    expect(formatToolStatus("grep", { pattern: "TODO", path: "src/main.js" })).toEqual({
      label: `${STRINGS.activity.searching} "TODO" in main.js`,
      kind: "search",
      detail: ""
    });
    expect(formatToolStatus("bash", { command: "npm test" })).toEqual({
      label: `${STRINGS.activity.running} ${STRINGS.activity.command}`,
      kind: "shell",
      detail: ""
    });
  });

  it("recognizes explicit and on-demand skill usage", () => {
    expect(getSkillCommandName("/skill:github inspect issue 78")).toBe("github");
    expect(getSkillCommandName("ordinary prompt")).toBeUndefined();
    expect(
      formatToolStatus("read", { path: "/Users/example/.pi/agent/skills/github/SKILL.md" })
    ).toEqual({
      label: STRINGS.activity.skill("github"),
      kind: "skill",
      detail: STRINGS.activity.usingSkillInstructions
    });
    expect(
      formatToolStatus(
        "read",
        { path: "C:\\Users\\example\\.pi\\agent\\skills\\github\\SKILL.md" },
        "preparing"
      )
    ).toEqual({
      label: STRINGS.activity.skill("github"),
      kind: "skill",
      detail: STRINGS.activity.loadingSkillInstructions
    });
  });

  it("shows an explicit skill while Pi expands its command", () => {
    const setActivity = vi.fn();
    handleRunEvent.call(
      {
        captureContextUsage: vi.fn(),
        normalizeRunEventType: (type) => type,
        getCurrentThreadRun: () => ({ skillName: "github" }),
        setActivity
      },
      { type: "context_ready" }
    );
    expect(setActivity).toHaveBeenCalledWith(STRINGS.activity.skill("github"), "skill");
  });

  it("handles sticky and bypass activity kinds", () => {
    expect(isStickyActivityKind("edit")).toBe(true);
    expect(isStickyActivityKind("skill")).toBe(true);
    expect(isStickyActivityKind("thinking")).toBe(false);
    expect(shouldBypassActivityStickiness("answer")).toBe(true);
  });

  it("creates stable tool event and retry labels", () => {
    expect(getToolEventKey({ toolCallId: "call-1" })).toBe("call-1");
    expect(formatRetryDetail({ attempt: 2, maxAttempts: 3, errorMessage: "temporary" })).toBe(
      "第 2/3 次尝试 — temporary"
    );
  });

  it("extracts thinking deltas and concise visible tool errors", () => {
    expect(
      getThinkingDelta({ type: "thinking_delta", assistantEvent: { delta: "considering" } })
    ).toBe("considering");
    expect(getThinkingDelta({ type: "text_delta", assistantEvent: { delta: "answer" } })).toBe("");
    expect(
      formatToolError({
        type: "tool_end",
        toolName: "read",
        isError: true,
        errorMessage: "File not found"
      })
    ).toBe(STRINGS.activity.toolFailed("read", "File not found"));
  });
});
