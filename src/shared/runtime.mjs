/**
 * Shared identity and window helpers.
 *
 * Both concerns live here because they answer the same question: which window
 * is this code acting on, and what identity should its artifacts carry. IDs are
 * persisted in plugin data and queue payloads, so every call site must use the
 * same shape: a UUID when the host exposes one, otherwise a timestamp/random
 * pair. Keeping one implementation avoids two colliding conventions drifting
 * apart.
 */
export function createId() {
  const activeWindow = resolveActiveWindow();
  return (
    activeWindow?.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

/**
 * The window the UI should act on. Obsidian can move a view into a popout
 * window, so `window.activeWindow` (the focused window) wins over the main one.
 * Returns undefined outside a DOM environment, such as unit tests.
 */
export function resolveActiveWindow() {
  return typeof window === "undefined" ? undefined : (window.activeWindow ?? window);
}

/**
 * The window that owns a view, falling back to the focused window when the view
 * does not expose one. Obsidian's workspace container is per window, so this is
 * the reliable way to reach the window a leaf actually lives in.
 */
export function resolveViewWindow(view) {
  return view?.app?.workspace?.containerEl?.ownerDocument?.defaultView ?? resolveActiveWindow();
}

/**
 * Structured clone through the window that owns the value. Obsidian popout
 * windows carry their own `structuredClone`, and falling back to JSON keeps the
 * call safe in environments that do not provide one.
 */
export function structuredCloneSafe(value) {
  const activeWindow = resolveActiveWindow();
  return typeof activeWindow?.structuredClone === "function"
    ? activeWindow.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

/**
 * Host globals, used only as a fallback for environments without a DOM window
 * (unit tests under Node). Every UI path must go through resolveActiveWindow()
 * instead, so a view in a popout window keeps working.
 *
 * @returns {Record<string, any>} The host global, typed loosely because the
 * fallback reaches for platform APIs that the DOM lib does not declare.
 */
export function hostGlobals() {
  return globalThis;
}

/**
 * High-resolution timestamp for profiling and drain budgets. Prefers the active
 * window's `performance` so measurements stay correct when a view lives in a
 * popout window, and falls back to the host global or `Date.now()` so Node
 * based tests keep working.
 */
export function now() {
  const performanceApi = resolveActiveWindow()?.performance ?? hostGlobals().performance;
  return performanceApi?.now ? performanceApi.now() : Date.now();
}

/**
 * Schedule a callback for the next animation frame in the active window, with a
 * timer fallback for environments without `requestAnimationFrame`.
 */
export function requestFrame(callback) {
  const activeWindow = resolveActiveWindow();
  if (typeof activeWindow?.requestAnimationFrame === "function") {
    return activeWindow.requestAnimationFrame(callback);
  }
  const frameApi = hostGlobals().requestAnimationFrame;
  return typeof frameApi === "function"
    ? frameApi(callback)
    : hostGlobals().setTimeout(callback, 16);
}

/**
 * Cancel a frame scheduled by requestFrame().
 */
export function cancelFrame(handle) {
  const activeWindow = resolveActiveWindow();
  if (typeof activeWindow?.cancelAnimationFrame === "function") {
    activeWindow.cancelAnimationFrame(handle);
    return;
  }
  const cancelApi = hostGlobals().cancelAnimationFrame;
  if (typeof cancelApi === "function") cancelApi(handle);
  else hostGlobals().clearTimeout(handle);
}

/**
 * Current JavaScript heap usage in bytes, when the host exposes it. Chromium
 * reports it through the non-standard `performance.memory`; other hosts return
 * undefined.
 */
export function heapUsedBytes() {
  const performanceApi = /** @type {Record<string, any> | undefined} */ (
    resolveActiveWindow()?.performance ?? hostGlobals().performance
  );
  const used = performanceApi?.memory?.usedJSHeapSize;
  return Number.isFinite(used) ? used : undefined;
}
