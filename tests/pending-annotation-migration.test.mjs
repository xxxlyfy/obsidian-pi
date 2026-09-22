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

function createView(overrides = {}) {
  const view = Object.create(PiAgentView.prototype);
  view.pendingAnnotationSnapshots = new Set();
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
    const view = createView({ pendingAnnotationSnapshots: new Set([snapshot]) });

    view.migrateInFlightAnnotationPaths("Notes/Old.md", "Notes/New.md");

    expect(snapshot.sourcePath).toBe("Notes/New.md");
    expect(snapshot.annotations[0].path).toBe("Notes/New.md");
  });

  it("invalidates a pending snapshot when its note is deleted mid-build", () => {
    const snapshot = { annotations: [{ path: "Notes/Old.md" }], sourcePath: "Notes/Old.md" };
    const view = createView({ pendingAnnotationSnapshots: new Set([snapshot]) });

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
    const view = createView({
      pendingAnnotationSnapshots: new Set([snapshot]),
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
    const view = createView();
    const snapshot = { annotations: [], sourcePath: "Notes/Old.md" };

    const release = view.trackPendingAnnotationSnapshot(snapshot);

    expect(view.pendingAnnotationSnapshots.has(snapshot)).toBe(true);

    release();

    expect(view.pendingAnnotationSnapshots.has(snapshot)).toBe(false);
  });

  it("retries the delivery once when a rename migrated the snapshot mid-build", async () => {
    const snapshot = { annotations: [], sourcePath: "Notes/Old.md" };
    const view = createView();
    const buildDelivery = vi.fn(async () => {
      if (snapshot.sourcePath === "Notes/Old.md") {
        view.migrateInFlightAnnotationPaths("Notes/Old.md", "Notes/New.md");
        return { promptContext: { activeNote: undefined } };
      }
      return { promptContext: { activeNote: { path: snapshot.sourcePath } } };
    });

    const delivery = await view.buildDeliveryWithSnapshotRetry(buildDelivery, snapshot);

    expect(buildDelivery).toHaveBeenCalledTimes(2);
    expect(delivery.promptContext.activeNote.path).toBe("Notes/New.md");
  });

  it("retries the delivery when the note was deleted mid-build", async () => {
    const snapshot = { annotations: [{ path: "Notes/Old.md" }], sourcePath: "Notes/Old.md" };
    const view = createView();
    const buildDelivery = vi.fn(async () => {
      view.invalidateInFlightAnnotationPaths("Notes/Old.md");
      return { promptContext: { activeNote: undefined } };
    });

    await view.buildDeliveryWithSnapshotRetry(buildDelivery, snapshot);

    expect(buildDelivery).toHaveBeenCalledTimes(2);
    expect(snapshot.sourcePath).toBeUndefined();
    expect(snapshot.annotations).toEqual([]);
  });

  it("does not re-deliver when the snapshot path did not change", async () => {
    const snapshot = { annotations: [], sourcePath: "Notes/Old.md" };
    const buildDelivery = vi.fn(async () => ({ promptContext: { activeNote: undefined } }));

    await createView().buildDeliveryWithSnapshotRetry(buildDelivery, snapshot);

    expect(buildDelivery).toHaveBeenCalledTimes(1);
  });
});
