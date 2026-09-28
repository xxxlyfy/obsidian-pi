// PATCH 2: RunState / ActiveTools / DiagnosticRing (spec §5.1-5.9).
//
// Business state is updated incrementally per event and never derived from
// retained history. The retained `events` log is transitional: it exists only
// for the legacy compaction consistency assertion (spec §5.6) and must be
// deleted after three clean real full-vault health checks.

import { performanceProfiler } from "../shared/performance-profiler.mjs";

export const DIAGNOSTIC_RING_CAPACITY = 500;

export class DiagnosticRing {
  constructor(capacity = DIAGNOSTIC_RING_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.entries = new Array(this.capacity);
    this.startIndex = 0;
    this.count = 0;
  }

  get size() {
    return this.count;
  }

  push(entry) {
    const index = (this.startIndex + this.count) % this.capacity;
    this.entries[index] = entry;
    if (this.count < this.capacity) this.count += 1;
    else this.startIndex = (this.startIndex + 1) % this.capacity;
  }

  snapshot() {
    const result = new Array(this.count);
    for (let index = 0; index < this.count; index += 1) {
      result[index] = this.entries[(this.startIndex + index) % this.capacity];
    }
    return result;
  }

  clear() {
    this.startIndex = 0;
    this.count = 0;
  }
}

// Fields kept in the bounded diagnostic copy of an event. Raw payloads (and
// large tool results) are intentionally dropped (spec §5.8).
const RETAINED_EVENT_KEYS = [
  "toolName",
  "toolCallId",
  "toolKey",
  "isError",
  "errorMessage",
  "textDelta",
  "thinkingDelta",
  "fallbackText",
  "method",
  "error"
];

export function createRunState() {
  return {
    fallbackText: "",
    finalResponse: "",
    tokenUsage: undefined,
    errorMessage: undefined,
    sawSuccessfulCompaction: false,
    sawAbortedCompaction: false,
    lastCompactionEnd: undefined,
    activeTools: new Map(),
    diagnostics: new DiagnosticRing(),
    events: [],
    toolSequence: 0,
    warnedToolIdFallback: false,
    warnedToolIdAmbiguous: false
  };
}

export function normalizeCompactionEventType(type) {
  return type === "auto_compaction_start" || type === "session_before_compact"
    ? "compaction_start"
    : type === "auto_compaction_end" || type === "session_compact"
      ? "compaction_end"
      : type;
}

export function retainEvent(state, event) {
  const copy = { type: event.type };
  for (const key of RETAINED_EVENT_KEYS) {
    if (event[key] !== undefined) copy[key] = event[key];
  }
  if (event.toolArgs !== undefined) copy.toolArgs = event.toolArgs;
  if (event.assistantEvent?.type) copy.assistantEventType = event.assistantEvent.type;

  if (normalizeCompactionEventType(String(event.type ?? "")) === "compaction_end") {
    copy.compactionError = event.raw?.errorMessage;
    copy.compactionAborted = event.raw?.aborted === true;
    // Legacy assertion input: keep every compaction end event for this run.
    state.events.push(copy);
  }

  state.diagnostics.push(copy);
  const profiler = performanceProfiler;
  if (profiler.enabled) {
    profiler.recordMax("diagnosticsSize", state.diagnostics.size);
    profiler.recordMax("retainedEvents", state.events.length);
    profiler.recordMax("activeTools", state.activeTools.size);
  }
}

function fallbackToolKey(state) {
  state.toolSequence += 1;
  return `tool:${state.toolSequence}`;
}

function findUniqueActiveToolKey(state, toolName) {
  let matchKey;
  let matches = 0;
  for (const [key, entry] of state.activeTools) {
    if (entry.toolName !== toolName) continue;
    matches += 1;
    matchKey = key;
  }
  return matches === 1 ? matchKey : undefined;
}

function countActiveTools(state, toolName) {
  let matches = 0;
  for (const entry of state.activeTools.values()) {
    if (entry.toolName === toolName) matches += 1;
  }
  return matches;
}

function warnToolIdFallback(state) {
  if (state.warnedToolIdFallback) return;
  state.warnedToolIdFallback = true;
  console.warn(
    "Pi Agent: tool event without toolCallId; using lifecycle fallback keys for correlation."
  );
}

function warnToolIdAmbiguous(state, toolName) {
  if (state.warnedToolIdAmbiguous) return;
  state.warnedToolIdAmbiguous = true;
  console.warn(
    `Pi Agent: cannot correlate tool event without toolCallId (name: ${toolName}); no lifecycle relation was assumed.`
  );
}

export function trackToolEvent(state, { toolCallId, toolName, toolArgs, isStart = false }) {
  const profiler = performanceProfiler;
  if (!toolCallId) {
    profiler.incrementCounter("toolIdFallbacks");
    warnToolIdFallback(state);
  }

  // A start without an id always opens a new lifecycle; only updates may adopt
  // a unique same-name active tool, otherwise correlation is never faked.
  const key = toolCallId
    ? `id:${toolCallId}`
    : isStart
      ? fallbackToolKey(state)
      : (findUniqueActiveToolKey(state, toolName) ?? fallbackToolKey(state));
  const entry = state.activeTools.get(key);
  if (entry) {
    if (toolName !== undefined) entry.toolName = toolName;
    if (toolArgs !== undefined) entry.toolArgs = toolArgs;
  } else {
    state.activeTools.set(key, { toolCallId, toolName, toolArgs });
  }
  return key;
}

export function finishToolEvent(state, { toolCallId, toolName }) {
  const profiler = performanceProfiler;
  if (toolCallId) {
    const key = `id:${toolCallId}`;
    const entry = state.activeTools.get(key);
    if (entry) state.activeTools.delete(key);
    return { key, entry };
  }

  profiler.incrementCounter("toolIdFallbacks");
  warnToolIdFallback(state);
  const uniqueKey = findUniqueActiveToolKey(state, toolName);
  if (uniqueKey) {
    const entry = state.activeTools.get(uniqueKey);
    state.activeTools.delete(uniqueKey);
    return { key: uniqueKey, entry };
  }

  if (countActiveTools(state, toolName) > 1) {
    profiler.incrementCounter("toolIdAmbiguous");
    warnToolIdAmbiguous(state, toolName);
  }
  return { key: fallbackToolKey(state), entry: undefined };
}

export function applyCompactionEnd(state, rawEvent) {
  const end = {
    errorMessage: rawEvent?.errorMessage,
    aborted: rawEvent?.aborted === true,
    result: rawEvent?.result
  };
  state.lastCompactionEnd = end;
  const successful = !end.errorMessage && !end.aborted;
  if (successful) state.sawSuccessfulCompaction = true;
  if (end.aborted) state.sawAbortedCompaction = true;
  assertCompactionConsistency(state);
}

export function legacySawSuccessfulCompaction(events) {
  return events.some(
    (entry) =>
      normalizeCompactionEventType(String(entry.type ?? "")) === "compaction_end" &&
      !entry.compactionError &&
      !entry.compactionAborted
  );
}

function assertCompactionConsistency(state) {
  const legacy = legacySawSuccessfulCompaction(state.events);
  if (legacy === state.sawSuccessfulCompaction) return;

  performanceProfiler.incrementCounter("compactionAssertionWarnings");
  console.warn("Pi Agent: compaction RunState assertion mismatch", {
    incremental: state.sawSuccessfulCompaction,
    legacy
  });
}
