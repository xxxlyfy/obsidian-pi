import { hostTimers } from "../../shared/runtime.mjs";

/**
 * @typedef {object} ViewLifecycle
 * @property {boolean} disposed Whether teardown already ran.
 * @property {number} pendingTimers Timers still scheduled.
 * @property {number} pendingCleanups Cleanup handles still registered.
 * @property {(callback: () => void, delayMs: number) => any} setTimer
 * @property {(handle: any) => void} clearTimer
 * @property {(cleanup: () => void) => (() => void)} addCleanup
 * @property {() => void} dispose
 */

/**
 * Timers and cleanup handles owned by one chat view.
 *
 * Without this, every timer and observer a mixin creates has to be remembered
 * and released by hand in `onClose`. Forgetting one leaves a callback running
 * after the view is gone, which shows up as background work and slowly growing
 * memory instead of an error. Registering a handle here means teardown is
 * automatic: `dispose()` stops everything that is still outstanding.
 *
 * @returns {ViewLifecycle}
 */
export function createViewLifecycle() {
  const timers = new Set();
  const cleanups = new Set();
  let disposed = false;

  return {
    get disposed() {
      return disposed;
    },

    get pendingTimers() {
      return timers.size;
    },

    get pendingCleanups() {
      return cleanups.size;
    },

    /**
     * Schedule a callback and remember its handle. The callback is skipped if
     * the view was disposed while the timer was pending, so a late timer can
     * never touch torn-down DOM.
     *
     * @param {() => void} callback
     * @param {number} delayMs
     * @returns {any} The timer handle.
     */
    setTimer(callback, delayMs) {
      if (disposed) return undefined;
      const timersApi = hostTimers();
      const handle = timersApi.setTimeout(() => {
        timers.delete(handle);
        if (disposed) return;
        callback();
      }, delayMs);
      timers.add(handle);
      return handle;
    },

    /**
     * @param {any} handle
     */
    clearTimer(handle) {
      if (handle === undefined || handle === null) return;
      timers.delete(handle);
      hostTimers().clearTimeout(handle);
    },

    /**
     * Register a disconnect/release function to run on dispose.
     *
     * @param {() => void} cleanup
     * @returns {() => void} An idempotent release function for this cleanup.
     */
    addCleanup(cleanup) {
      if (disposed) {
        cleanup();
        return () => {};
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        cleanups.delete(release);
        cleanup();
      };
      cleanups.add(release);
      return release;
    },

    /**
     * Stop every outstanding timer and run every registered cleanup. Safe to
     * call more than once; a view is disposed once but teardown paths overlap.
     */
    dispose() {
      if (disposed) return;
      disposed = true;
      const timersApi = hostTimers();
      for (const handle of [...timers]) {
        timers.delete(handle);
        timersApi.clearTimeout(handle);
      }
      for (const release of [...cleanups]) {
        cleanups.delete(release);
        try {
          release();
        } catch (error) {
          console.error("Pi Agent: view cleanup failed", error);
        }
      }
    }
  };
}
