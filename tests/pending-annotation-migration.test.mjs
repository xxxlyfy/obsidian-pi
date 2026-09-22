import { describe, expect, it, vi } from "vitest";
import { PromptDelivery } from "../src/agent/prompt-delivery.mjs";

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

function createDelivery(overrides = {}) {
  return new PromptDelivery({
    consumeAnnotations: async () => [],
    restoreAnnotations: () => {},
    buildDelivery: async (delivery) => delivery,
    isThreadRunning: () => false,
    enqueueQueuedPrompt: () => {},
    requeueQueuedPrompt: () => {},
    ensureModelsLoaded: async () => {},
    getSelectedModelInfo: () => undefined,
    shouldIncludeActiveNote: () => true,
    notify: () => {},
    ...overrides
  });
}

function createView({ delivery = createDelivery(), ...overrides } = {}) {
  const view = Object.create(PiAgentView.prototype);
  view.delivery = delivery;
  view.runtime = {
    getRun: () => undefined,
    listRuns: () => [],
    activeThreadIds: () => []
  };
  Object.assign(view, overrides);
  return view;
}

describe("annotation snapshot migration during prompt delivery", () => {
  it("migrates a pending snapshot that is not registered as a run yet", () => {
    const snapshot = { annotations: [{ path: "Notes/Old.md" }], sourcePath: "Notes/Old.md" };
    const delivery = createDelivery();
    delivery.trackPendingSnapshot(snapshot);
    const view = createView({ delivery });

    view.migrateInFlightAnnotationPaths("Notes/Old.md", "Notes/New.md");

    expect(snapshot.sourcePath).toBe("Notes/New.md");
    expect(snapshot.annotations[0].path).toBe("Notes/New.md");
  });

  it("invalidates a pending snapshot when its note is deleted mid-build", () => {
    const snapshot = { annotations: [{ path: "Notes/Old.md" }], sourcePath: "Notes/Old.md" };
    const delivery = createDelivery();
    delivery.trackPendingSnapshot(snapshot);
    const view = createView({ delivery });

    view.invalidateInFlightAnnotationPaths("Notes/Old.md");

    expect(snapshot.sourcePath).toBeUndefined();
    expect(snapshot.annotations).toEqual([]);
  });

  it("still migrates snapshots that belong to a running chat", () => {
    const snapshot = { annotations: [], sourcePath: "Notes/Old.md" };
    const view = createView({
      runtime: {
        getRun: () => undefined,
        listRuns: () => [{ annotationSnapshot: snapshot }],
        activeThreadIds: () => ["t1"]
      }
    });

    view.migrateInFlightAnnotationPaths("Notes/Old.md", "Notes/New.md");

    expect(snapshot.sourcePath).toBe("Notes/New.md");
  });

  it("migrates a snapshot only once when it is pending and registered at the same time", () => {
    const snapshot = { annotations: [], sourcePath: "Notes/Old.md" };
    const delivery = createDelivery();
    delivery.trackPendingSnapshot(snapshot);
    const view = createView({
      delivery,
      runtime: {
        getRun: () => undefined,
        listRuns: () => [{ annotationSnapshot: snapshot }],
        activeThreadIds: () => ["t1"]
      }
    });

    view.migrateInFlightAnnotationPaths("Notes/Old.md", "Notes/New.md");

    expect(snapshot.sourcePath).toBe("Notes/New.md");
  });

  it("releases the pending snapshot when delivery settles", () => {
    const delivery = createDelivery();
    const snapshot = { annotations: [], sourcePath: "Notes/Old.md" };

    const release = delivery.trackPendingSnapshot(snapshot);

    expect(delivery.pendingSnapshots.has(snapshot)).toBe(true);
    release();
    expect(delivery.pendingSnapshots.has(snapshot)).toBe(false);
  });

  it("rebuilds the delivery once when the note was renamed mid-build", async () => {
    const delivery = createDelivery();
    const snapshot = { annotations: [], sourcePath: "Notes/Old.md" };
    const builds = [];
    const buildDelivery = async () => {
      builds.push(snapshot.sourcePath);
      if (builds.length === 1) snapshot.sourcePath = "Notes/New.md";
      return builds.length === 1
        ? { prompt: "first", promptContext: undefined }
        : { prompt: "second", promptContext: { activeNote: { path: "Notes/New.md" } } };
    };

    const built = await delivery.buildWithSnapshotRetry(buildDelivery, snapshot);

    expect(builds).toHaveLength(2);
    expect(built.prompt).toBe("second");
    expect(delivery.pendingSnapshots.has(snapshot)).toBe(false);
  });

  it("keeps the first delivery when the renamed note is still attached", async () => {
    const delivery = createDelivery();
    const snapshot = { annotations: [], sourcePath: "Notes/Old.md" };
    let builds = 0;
    const buildDelivery = async () => {
      builds += 1;
      snapshot.sourcePath = "Notes/New.md";
      return { prompt: "first", promptContext: { activeNote: { path: "Notes/New.md" } } };
    };

    const built = await delivery.buildWithSnapshotRetry(buildDelivery, snapshot);

    expect(builds).toBe(1);
    expect(built.prompt).toBe("first");
  });
});
