import { execFileSync } from "node:child_process";

/**
 * Force a spawned Pi process and its descendants to stop.
 *
 * Pi runs tools in child processes, so signalling only the direct child can
 * leave grandchildren running after a cancel. On Windows `taskkill /T /F` is the
 * only reliable way to take down the tree; on POSIX the child is spawned in its
 * own process group (detached), so the negative PID signals the whole group.
 * Falling back to `child.kill()` keeps the call useful when neither applies,
 * for example when the process already exited or was never detached.
 */
export function terminateProcessTree(child, { signal = "SIGTERM", timeoutMs = 2_000 } = {}) {
  if (!child) return;

  try {
    if (process.platform === "win32" && child.pid) {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        timeout: timeoutMs,
        windowsHide: true
      });
    } else if (child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited; there is nothing left to stop.
    }
  }
}
