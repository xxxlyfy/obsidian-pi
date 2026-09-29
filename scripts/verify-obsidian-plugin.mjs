// End-to-end verification of the Pi Agent plugin inside a running Obsidian.
//
// Launches nothing: it attaches to Obsidian over the DevTools protocol (start
// Obsidian with --remote-debugging-port=9222) and drives the real plugin.
//
// Usage: node scripts/verify-obsidian.mjs [--port 9222] [--run]
//   --run  also sends one real prompt to Pi and waits for the answer
import { withRenderer, sleep } from "./verify-obsidian.mjs";

const args = process.argv.slice(2);
const shouldRun = args.includes("--run");

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const viewProbe = `(() => {
  const app = window.app;
  const leaves = app.workspace.getLeavesOfType("pi-agent-view");
  const view = leaves[0]?.view;
  return {
    leaves: leaves.length,
    hasDom: Boolean(view?.messagesEl && view?.inputEl),
    timers: [view?.pendingActivityTimer, view?.activityCoalesceTimer, view?.streamingFlushRaf]
      .filter(Boolean).length,
    guardFields: [view?.pendingActivityGuard, view?.activityCoalesceGuard, view?.streamingFlushGuard]
      .filter(Boolean).length,
    heap: window.performance?.memory?.usedJSHeapSize ?? 0
  };
})()`;

await withRenderer(async ({ evaluate, consoleErrors }) => {
  // 0. Load the build that is on disk right now, not whatever was loaded at
  //    app start, then make sure the chat view exists for the DOM checks below.
  const reloaded = await evaluate(`(async () => {
    const app = window.app;
    const plugins = app.plugins;
    if (plugins.enabledPlugins?.has?.("pi-agent")) plugins.disablePlugin("pi-agent");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await plugins.enablePlugin("pi-agent");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const plugin = plugins.plugins["pi-agent"];
    // The view is closed with the plugin, so open a fresh one.
    await plugin.activateView();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      enabled: Boolean(plugin),
      version: plugin?.manifest?.version ?? null,
      leaves: app.workspace.getLeavesOfType("pi-agent-view").length
    };
  })()`);
  record(
    "plugin reloaded from the current build",
    reloaded.enabled && reloaded.leaves > 0,
    `version ${reloaded.version}, leaves ${reloaded.leaves}`
  );
  // Console history from the previously loaded (stale) build is not evidence
  // about the current one, so only count what happens from here on.
  consoleErrors.length = 0;

  // 1. Plugin loaded and current build live.
  const loaded = await evaluate(
    `(() => { const p = window.app.plugins.plugins["pi-agent"]; return Boolean(p) && p.manifest.version; })()`
  );
  record("plugin loaded", Boolean(loaded), `version ${loaded}`);

  // 2. dryRun removal survived a real settings load.
  const settings = await evaluate(
    `(() => Object.keys(window.app.plugins.plugins["pi-agent"].settings))()`
  );
  record(
    "settings normalized without the retired dryRun flag",
    !settings.includes("dryRun"),
    `${settings.length} keys`
  );

  // 3. Active view has DOM before the cycle.
  const before = await evaluate(viewProbe);
  record("view rendered", before.hasDom, `leaves=${before.leaves}`);

  // 4. Repeated open/close: no leaked timers, no growing DOM, bounded heap.
  await evaluate(`(() => {
    const app = window.app;
    const plugin = app.plugins.plugins["pi-agent"];
    const view = app.workspace.getLeavesOfType("pi-agent-view")[0]?.view;
    window.__piVerify = { errors: [], closeCount: 0 };
    const originalClose = view.onClose.bind(view);
    view.onClose = async function (...closeArgs) {
      window.__piVerify.closeCount += 1;
      try {
        return await originalClose(...closeArgs);
      } catch (error) {
        window.__piVerify.errors.push(String(error));
        throw error;
      }
    };
    return true;
  })()`);

  for (let i = 0; i < 20; i += 1) {
    await evaluate(`(async () => {
      const view = window.app.workspace.getLeavesOfType("pi-agent-view")[0]?.view;
      view?.renderChatView?.();
      await view?.onClose?.();
      return true;
    })()`);
    await sleep(15);
  }

  const after = await evaluate(`(() => {
    const view = window.app.workspace.getLeavesOfType("pi-agent-view")[0]?.view;
    return {
      closeCount: window.__piVerify?.closeCount ?? 0,
      errors: window.__piVerify?.errors ?? [],
      timers: [view?.pendingActivityTimer, view?.activityCoalesceTimer, view?.streamingFlushRaf]
        .filter(Boolean).length,
      guards: [view?.pendingActivityGuard, view?.activityCoalesceGuard, view?.streamingFlushGuard]
        .filter(Boolean).length,
      messageComponents: view?.messageRenderComponents?.length ?? 0,
      heap: window.performance?.memory?.usedJSHeapSize ?? 0
    };
  })()`);

  record("20 open/close cycles ran without throwing", after.errors.length === 0, after.errors[0]);
  record("no timer left running after teardown", after.timers === 0, `timers=${after.timers}`);
  record("no stale-callback guard left set", after.guards === 0, `guards=${after.guards}`);
  record(
    "render components unloaded",
    after.messageComponents === 0,
    `components=${after.messageComponents}`
  );
  const heapGrowthMb = (after.heap - before.heap) / (1024 * 1024);
  record(
    "heap did not grow unboundedly",
    heapGrowthMb < 40,
    `${heapGrowthMb.toFixed(1)} MiB over 20 cycles`
  );

  // 4b. A timer registered with the view lifecycle must not survive a teardown,
  //     which is the guarantee the lifecycle exists to provide. Runs after the
  //     reopen so the lifecycle under test is a fresh, live one.
  const lifecycleCheck = await evaluate(`(async () => {
    const view = window.app.workspace.getLeavesOfType("pi-agent-view")[0]?.view;
    view.renderChatView();
    const lifecycle = view.lifecycle;
    let fired = false;
    lifecycle.setTimer(() => { fired = true; }, 150);
    const registeredBefore = lifecycle.pendingTimers;
    view.renderChatView();
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      registeredBefore,
      oldTimerFired: fired,
      oldDisposed: lifecycle.disposed,
      newLifecycle: view.lifecycle !== lifecycle
    };
  })()`);
  record(
    "a timer from the replaced lifecycle never fires",
    lifecycleCheck.registeredBefore === 1 &&
      lifecycleCheck.oldTimerFired === false &&
      lifecycleCheck.oldDisposed === true &&
      lifecycleCheck.newLifecycle === true,
    JSON.stringify(lifecycleCheck)
  );

  // 5. Reopen and render a full chat view again (proves teardown is recoverable).
  const reopened = await evaluate(`(async () => {
    const view = window.app.workspace.getLeavesOfType("pi-agent-view")[0]?.view;
    view.renderChatView();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { hasDom: Boolean(view.messagesEl && view.inputEl), messages: view.messagesEl?.childElementCount ?? -1 };
  })()`);
  record(
    "view reopens after teardown",
    reopened.hasDom,
    `messages container children=${reopened.messages}`
  );

  // 6. Settings round-trip through the refactored save path.
  const settingRoundTrip = await evaluate(`(async () => {
    const plugin = window.app.plugins.plugins["pi-agent"];
    const original = plugin.settings.showExtensionStatus;
    await plugin.setShowExtensionStatus(!original);
    const toggled = plugin.settings.showExtensionStatus;
    await plugin.setShowExtensionStatus(original);
    const restored = plugin.settings.showExtensionStatus;
    return { toggled, restored, original, catalogGeneration: plugin.modelCatalogGeneration };
  })()`);
  record(
    "settings save path round-trips",
    settingRoundTrip.toggled !== settingRoundTrip.original &&
      settingRoundTrip.restored === settingRoundTrip.original,
    `restored=${settingRoundTrip.restored}`
  );

  // 7. Reasoning labels come from the dictionaries (1.3) in the live UI.
  const labels = await evaluate(`(() => {
    const settings = window.app.plugins.plugins["pi-agent"].settings;
    return Object.values(window.app.plugins.plugins["pi-agent"].settingsTab
      ? window.app.plugins.plugins["pi-agent"].settingsTab.getReasoningOptions()
      : {});
  })()`);
  record(
    "reasoning labels resolve from the dictionary",
    labels.length === 0 || labels.every((label) => typeof label === "string" && label.length > 0),
    JSON.stringify(labels)
  );

  // 8. Optional: one real prompt through the refactored RPC + render pipeline.
  if (shouldRun) {
    const runResult = await evaluate(`(async () => {
      const app = window.app;
      const plugin = app.plugins.plugins["pi-agent"];
      const view = app.workspace.getLeavesOfType("pi-agent-view")[0]?.view;
      if (!view) return { skipped: "no view" };
      const started = Date.now();
      let failure = null;
      const run = view
        .runPrompt("Reply with exactly: OK", undefined, [], undefined, [], undefined, undefined)
        .catch((error) => {
          failure = error instanceof Error ? error.message : String(error);
        });
      const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 180000));
      const raced = await Promise.race([run.then(() => "done"), timeout]);
      return {
        outcome: failure ? "error" : raced,
        failure,
        settledMs: Date.now() - started,
        running: view.running,
        messages: plugin.messages.length,
        renderedChars: view.messagesEl?.textContent?.length ?? 0,
        activityText: view.activityText,
        contextUsage: view.currentRunContextUsage ? "present" : "absent",
        streamingFlushRafCleared: view.streamingFlushRaf === undefined
      };
    })()`);
    record(
      "real Pi run completes through RPC and renders",
      runResult.outcome === "done" &&
        runResult.running === false &&
        runResult.messages > 0 &&
        runResult.renderedChars > 0,
      JSON.stringify(runResult)
    );

    // 9. Cancel a run mid-stream. This is the path the view lifecycle exists to
    //    protect: the streaming frame and the activity timers are in flight while
    //    the run is live, and cancelling must release them rather than leave them
    //    to fire against the next render.
    //
    //    Timers are observed by polling, not by sampling one instant: a frame is
    //    pending for about one animation frame, so a single sample would be a
    //    coin flip. The run is cancelled as soon as it is live and the answer has
    //    started arriving.
    const cancelCheck = await evaluate(`(async () => {
      const app = window.app;
      const plugin = app.plugins.plugins["pi-agent"];
      const view = app.workspace.getLeavesOfType("pi-agent-view")[0]?.view;
      if (!view) return { skipped: "no view" };
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const settle = async (limitMs) => {
        const done = () => view.running === false && view.canceling === false;
        const startedAt = Date.now();
        while (!done() && Date.now() - startedAt < limitMs) await sleep(50);
        return done() ? "settled" : "timeout";
      };

      const prompt =
        "Write about 600 words explaining how a binary search works, in plain prose.";
      const run = view
        .runPrompt(prompt, undefined, [], undefined, [], undefined, undefined)
        .then(() => "resolved")
        .catch((error) => "rejected: " + (error instanceof Error ? error.message : String(error)));

      // Note: view.running is a render flag for the displayed thread, so it is
      // not a reliable "a run is in flight" signal. The run itself registers in
      // activeRuns as soon as it starts, and that is what cancelling needs.
      let answerChars = 0;
      let thinkingChars = 0;
      let everFlushFrame = false;
      let everTimer = false;
      let liveForMs = 0;
      const waitStartedAt = Date.now();
      while (Date.now() - waitStartedAt < 60000) {
        await sleep(75);
        answerChars = Math.max(answerChars, (view.streamingAssistantContent || "").length);
        thinkingChars = Math.max(thinkingChars, (view.streamingThinkingContent || "").length);
        if (view.streamingFlushRaf !== undefined && view.streamingFlushRaf !== null)
          everFlushFrame = true;
        if (view.pendingActivityTimer !== undefined || view.activityCoalesceTimer !== undefined)
          everTimer = true;
        if (view.activeRuns.size > 0) liveForMs += 75;
        // Cancel while the run is live, either once the model is producing text
        // or after it has been running long enough that cancellation is a real
        // mid-run cancel rather than a no-op.
        if (view.activeRuns.size > 0 && (answerChars >= 80 || liveForMs >= 1500)) break;
      }
      const wasRunningAtCancel = view.activeRuns.size > 0;

      // Plant a genuinely pending activity timer, the same kind a run schedules
      // when a sticky activity is waiting to flush. Whether one happens to be
      // pending at cancel time is a matter of animation-frame timing, so the
      // harness creates the condition instead of hoping for it. If teardown
      // misses it, it fires after the run and the flag below becomes true.
      let plantedTimerFired = false;
      view.activityStickyUntil = Date.now() + 1500;
      view.setActivity("Verification sticky flush", "thinking", "");
      const plantedTimer = view.pendingActivityTimer !== undefined;

      const midRun = {
        answerChars,
        thinkingChars,
        everFlushFrame,
        everTimer,
        liveForMs,
        wasRunningAtCancel,
        activeRuns: view.activeRuns.size,
        plantedTimer,
        pendingCleanups: view.lifecycle?.pendingCleanups ?? -1
      };

      view.cancelCurrentRun();
      const cancelingImmediately = view.canceling === true;
      const cancelOutcome = await settle(60000);
      const timersAtSettle = view.lifecycle?.pendingTimers ?? -1;
      await sleep(2500);
      const runOutcome = await run;
      // The planted timer must never apply its activity: if teardown missed it,
      // it fires during the wait above and this becomes true.
      plantedTimerFired = view.activityText === "Verification sticky flush";

      return {
        midRun,
        cancelingImmediately,
        cancelOutcome,
        runOutcome,
        timersAtSettle,
        plantedTimerFired,
        afterCancel: {
          running: view.running,
          canceling: view.canceling,
          timer: view.pendingActivityTimer !== undefined || view.activityCoalesceTimer !== undefined,
          flushFrame: view.streamingFlushRaf !== undefined && view.streamingFlushRaf !== null,
          flushGuard: view.streamingFlushGuard !== undefined,
          pendingActivity: view.pendingActivity !== undefined,
          pendingTimers: view.lifecycle?.pendingTimers ?? -1,
          // A live view legitimately holds one: the composer-bar observer. What
          // matters is that cancelling a run does not add more.
          pendingCleanups: view.lifecycle?.pendingCleanups ?? -1,
          activeRuns: view.activeRuns.size
        }
      };
    })()`);

    const mid = cancelCheck.midRun ?? {};
    const after = cancelCheck.afterCancel ?? {};
    record(
      "cancel happened while a run was genuinely in flight",
      !cancelCheck.skipped &&
        mid.wasRunningAtCancel === true &&
        mid.activeRuns >= 1 &&
        mid.liveForMs >= 1500,
      JSON.stringify(mid)
    );
    record(
      "a pending activity timer existed and was cancelled before it fired",
      mid.plantedTimer === true &&
        cancelCheck.timersAtSettle === 0 &&
        cancelCheck.plantedTimerFired === false,
      JSON.stringify({
        planted: mid.plantedTimer,
        timersAtSettle: cancelCheck.timersAtSettle,
        fired: cancelCheck.plantedTimerFired,
        activityText: after.activityText
      })
    );
    record(
      "cancel is immediate and the run settles",
      cancelCheck.cancelingImmediately === true &&
        cancelCheck.cancelOutcome === "settled" &&
        after.running === false &&
        after.canceling === false,
      JSON.stringify({
        immediately: cancelCheck.cancelingImmediately,
        settle: cancelCheck.cancelOutcome,
        run: cancelCheck.runOutcome
      })
    );
    record(
      "cancelled run leaves no timer, frame or guard behind",
      after.timer === false &&
        after.flushFrame === false &&
        after.flushGuard === false &&
        after.pendingActivity === false &&
        after.pendingTimers === 0 &&
        after.pendingCleanups <= mid.pendingCleanups &&
        after.activeRuns === 0,
      JSON.stringify({ mid: mid.pendingCleanups, after })
    );

    // 10. The view must still be usable after the cancelled run.
    const recovery = await evaluate(`(async () => {
      const app = window.app;
      const plugin = app.plugins.plugins["pi-agent"];
      const view = app.workspace.getLeavesOfType("pi-agent-view")[0]?.view;
      const before = plugin.messages.length;
      const result = await view
        .runPrompt("Reply with exactly: OK", undefined, [], undefined, [], undefined, undefined)
        .then(() => "done")
        .catch((error) => "error: " + (error instanceof Error ? error.message : String(error)));
      return {
        result,
        before,
        after: plugin.messages.length,
        running: view.running,
        flushFrame: view.streamingFlushRaf !== undefined && view.streamingFlushRaf !== null
      };
    })()`);
    record(
      "view runs a fresh prompt after the cancelled one",
      recovery.result === "done" &&
        recovery.after > recovery.before &&
        recovery.running === false &&
        recovery.flushFrame === false,
      JSON.stringify(recovery)
    );
  }

  const realErrors = consoleErrors.filter(
    (entry) => !/favicon|DevTools|Autofill|deprecated/i.test(entry)
  );
  record(
    "no console errors during verification",
    realErrors.length === 0,
    realErrors.slice(0, 3).join(" | ")
  );
});

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
