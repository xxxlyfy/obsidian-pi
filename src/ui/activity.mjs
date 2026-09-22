import { STRINGS } from "../shared/strings.mjs";
export function isStickyActivityKind(kind) {
  return (
    kind === "skill" || kind === "read" || kind === "search" || kind === "edit" || kind === "shell"
  );
}

export function shouldBypassActivityStickiness(kind) {
  return kind === "answer" || kind === "finishing" || kind === "error";
}

export function getToolKind(toolName) {
  const name = String(toolName || "").toLowerCase();

  return name === "bash"
    ? "shell"
    : name === "edit" || name === "write"
      ? "edit"
      : name === "grep" || name === "find" || name === "ls"
        ? "search"
        : name === "read"
          ? "read"
          : "thinking";
}

export function formatToolStatus(toolName, toolArgs, phase = "running") {
  const name = String(toolName || "tool").toLowerCase();
  const skillName = getReadSkillName(name, toolArgs);
  if (skillName) {
    return {
      label: truncateActivityText(STRINGS.activity.skill(skillName)),
      kind: "skill",
      detail:
        phase === "preparing"
          ? STRINGS.activity.loadingSkillInstructions
          : STRINGS.activity.usingSkillInstructions
    };
  }
  const kind = getToolKind(name);
  const target = formatToolTarget(name, toolArgs);
  const verb = getToolVerb(name, phase);
  const label = target ? `${verb} ${target}` : verb;

  return { label: truncateActivityText(label), kind, detail: "" };
}

export function getSkillCommandName(prompt) {
  return String(prompt ?? "")
    .trimStart()
    .match(/^\/skill:([a-z0-9-]+)(?:\s|$)/i)?.[1];
}

export function getToolEventKey(event) {
  return String(
    event.toolCallId ||
      `${event.toolName || event.message || "tool"}:${JSON.stringify(event.toolArgs || {}).slice(
        0,
        80
      )}`
  );
}

export function getThinkingDelta(event) {
  if (event?.type !== "thinking_delta") return "";
  return String(event.thinkingDelta ?? event.assistantEvent?.delta ?? event.raw?.delta ?? "");
}

export function formatToolError(event) {
  if (event?.type !== "tool_end" || event.isError !== true) return "";
  const name = String(event.toolName || event.message || STRINGS.activity.tool);
  const detail = sanitizeActivityDetail(
    event.errorMessage ?? event.raw?.errorMessage ?? event.raw?.error ?? event.raw?.result?.error
  );
  return truncateActivityText(STRINGS.activity.toolFailed(name, detail));
}

export function formatRetryDetail(event) {
  if (!event || typeof event !== "object") return "";

  const attempt =
    event.attempt && event.maxAttempts ? `第 ${event.attempt}/${event.maxAttempts} 次尝试` : "";

  return [attempt, event.errorMessage ? String(event.errorMessage).slice(0, 120) : ""]
    .filter(Boolean)
    .join(" — ");
}

function getReadSkillName(toolName, toolArgs) {
  if (toolName !== "read") return "";
  const target = pickNestedString(toolArgs, ["path", "filePath", "file", "target"])
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  const segments = target.split("/").filter(Boolean);
  if (segments.at(-1)?.toLowerCase() !== "skill.md") return "";
  return segments.at(-2) || "skill";
}

function getToolVerb(toolName, phase) {
  if (phase === "preparing") {
    return toolName === "bash"
      ? STRINGS.activity.preparingCommand
      : toolName === "edit"
        ? STRINGS.activity.preparingEdit
        : toolName === "write"
          ? STRINGS.activity.preparingWrite
          : toolName === "grep" || toolName === "find" || toolName === "ls"
            ? STRINGS.activity.preparingSearch
            : toolName === "read"
              ? STRINGS.activity.preparingRead
              : STRINGS.activity.preparingAction;
  }

  return toolName === "bash"
    ? STRINGS.activity.running
    : toolName === "edit"
      ? STRINGS.activity.editing
      : toolName === "write"
        ? STRINGS.activity.writing
        : toolName === "grep"
          ? STRINGS.activity.searching
          : toolName === "find"
            ? STRINGS.activity.finding
            : toolName === "ls"
              ? STRINGS.activity.listing
              : toolName === "read"
                ? STRINGS.activity.reading
                : STRINGS.activity.using;
}

function formatToolTarget(toolName, toolArgs) {
  if (toolName === "bash") return STRINGS.activity.command;

  if (toolName === "grep") {
    const pattern = sanitizeActivityDetail(pickNestedString(toolArgs, ["pattern", "query"]));
    const path = formatPathForActivity(pickNestedString(toolArgs, ["path", "directory", "dir"]));

    return pattern && path ? `"${pattern}" in ${path}` : pattern ? `"${pattern}"` : path;
  }

  if (toolName === "find") {
    return sanitizeActivityDetail(pickNestedString(toolArgs, ["glob", "pattern", "query", "path"]));
  }

  if (toolName === "ls") {
    return formatPathForActivity(pickNestedString(toolArgs, ["path", "directory", "dir"]));
  }

  return formatPathForActivity(
    pickNestedString(toolArgs, [
      "path",
      "filePath",
      "file",
      "target",
      "command",
      "cmd",
      "pattern",
      "query"
    ])
  );
}

function formatPathForActivity(value) {
  const path = sanitizeActivityDetail(value).replace(/\\/g, "/").replace(/\/$/, "");
  return path ? path.split("/").pop() || path : "";
}

function sanitizeActivityDetail(value) {
  return value ? String(value).replace(/\s+/g, " ").trim() : "";
}

function truncateActivityText(value) {
  const detail = sanitizeActivityDetail(value);
  return detail.length > 120 ? `${detail.slice(0, 117)}…` : detail;
}

function pickNestedString(value, keys, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return "";

  seen.add(value);

  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key];
  }

  for (const key of ["input", "args", "arguments", "parameters", "params", "toolInput", "data"]) {
    if (!value[key]) continue;

    const nested = pickNestedString(value[key], keys, seen);
    if (nested) return nested;
  }

  for (const nestedValue of Object.values(value)) {
    const nested = pickNestedString(nestedValue, keys, seen);
    if (nested) return nested;
  }

  return "";
}
