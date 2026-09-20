import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  Component: class {},
  FuzzySuggestModal: class {},
  ItemView: class {},
  MarkdownRenderChild: class {},
  MarkdownRenderer: { render: vi.fn() },
  MarkdownView: class {},
  Menu: class {},
  Modal: class {},
  Notice: class {},
  Plugin: class {},
  PluginSettingTab: class {},
  Setting: class {},
  SuggestModal: class {},
  TFile: class {},
  normalizePath: (value) => value,
  setIcon: () => {}
}));

const { PiAgentView } = await import("../src/ui/PiAgentView.mjs");
const { syncRunActivity, syncRunContextUsage } = await import("../src/ui/run-activity-state.mjs");

function createView(run) {
  return {
    activeRuns: new Map(run ? [["t1", run]] : []),
    getCurrentThreadId: () => "t1",
    streamingAssistantContent: "",
    streamingThinkingContent: "",
    thinkingDisclosureExpanded: false,
    thinkingDisclosureUserSet: false,
    currentRunContextUsage: undefined,
    activityText: "",
    activityKind: "",
    activityDetail: "",
    activityStickyUntil: 0
  };
}

describe("per-thread live run UI state", () => {
  it("restores streaming text, thinking, activity, and context usage from the run", () => {
    const view = createView({
      assistantContent: "partial answer",
      thinking: "reasoning so far",
      thinkingExpanded: true,
      thinkingUserSet: true,
      contextUsage: { tokens: 10 },
      activity: { text: "Responding", kind: "answer", detail: "detail", stickyUntil: 123 }
    });

    PiAgentView.prototype.restoreActiveRunUiState.call(view);

    expect(view.streamingAssistantContent).toBe("partial answer");
    expect(view.streamingThinkingContent).toBe("reasoning so far");
    expect(view.thinkingDisclosureExpanded).toBe(true);
    expect(view.thinkingDisclosureUserSet).toBe(true);
    expect(view.currentRunContextUsage).toEqual({ tokens: 10 });
    expect(view.activityText).toBe("Responding");
    expect(view.activityKind).toBe("answer");
    expect(view.activityDetail).toBe("detail");
    expect(view.activityStickyUntil).toBe(123);
  });

  it("leaves the view untouched when the current thread has no active run", () => {
    const view = createView(undefined);
    view.streamingAssistantContent = "keep";

    PiAgentView.prototype.restoreActiveRunUiState.call(view);

    expect(view.streamingAssistantContent).toBe("keep");
    expect(view.activityText).toBe("");
  });

  it("mirrors the current activity into the active run", () => {
    const run = {};
    const view = createView(run);
    view.activityText = "Thinking";
    view.activityKind = "thinking";
    view.activityDetail = "waiting";
    view.activityStickyUntil = 42;

    syncRunActivity.call(view, "t1");

    expect(run.activity).toEqual({
      text: "Thinking",
      kind: "thinking",
      detail: "waiting",
      stickyUntil: 42
    });
  });

  it("mirrors the current context usage into the active run", () => {
    const run = {};
    const view = createView(run);
    view.currentRunContextUsage = { compacted: true };

    syncRunContextUsage.call(view, "t1");

    expect(run.contextUsage).toEqual({ compacted: true });
  });

  it("writes activity and context usage to the event's thread, not the last started run", () => {
    const runA = {};
    const runB = {};
    const view = createView(runA);
    view.activeRuns = new Map([
      ["t1", runA],
      ["t2", runB]
    ]);
    view.activityText = "Responding";
    view.activityKind = "answer";
    view.activityDetail = "";
    view.activityStickyUntil = 0;
    view.currentRunContextUsage = { tokens: 5 };

    syncRunActivity.call(view, "t1");
    syncRunContextUsage.call(view, "t1");

    expect(runA.activity).toEqual({
      text: "Responding",
      kind: "answer",
      detail: "",
      stickyUntil: 0
    });
    expect(runA.contextUsage).toEqual({ tokens: 5 });
    expect(runB.activity).toBeUndefined();
    expect(runB.contextUsage).toBeUndefined();
  });
});
