import { performanceProfiler } from "../shared/performance-profiler.mjs";
import {
  applyCompactionEnd,
  finishToolEvent,
  normalizeCompactionEventType,
  retainEvent,
  trackToolEvent
} from "./run-state.mjs";
import { normalizeTokenUsage } from "./token-usage.mjs";

/**
 * PATCH 2 object path: the persistent RPC client already delivers parsed
 * objects, so no JSON.stringify -> JSON.parse round trip is needed (spec §5.3).
 * `state` is a RunState instance from ./run-state.mjs.
 */
export function handlePiEvent(event, state, callbacks) {
  const profiler = performanceProfiler;
  const profiling = profiler.enabled;
  const startedAt = profiling ? globalThis.performance.now() : 0;
  const normalizeStartedAt = profiling ? globalThis.performance.now() : 0;

  if (profiling) profiler.incrementCounter("rpcEventsProcessed");
  try {
    normalizePiEvent(event, state, callbacks);
  } finally {
    if (profiling) {
      const now = globalThis.performance.now();
      profiler.recordDuration("normalize", now - normalizeStartedAt);
      profiler.recordDuration("event", now - startedAt);
    }
  }
}

/**
 * String path for true JSONL sources (Pi CLI `--mode json` output and tests).
 */
export function handlePiJsonEventLine(line, state, callbacks) {
  if (!line.trim()) return;

  const profiler = performanceProfiler;
  const profiling = profiler.enabled;
  const parseStartedAt = profiling ? globalThis.performance.now() : 0;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (profiling) {
    profiler.recordJsonEvent(line);
    profiler.recordDuration("jsonParse", globalThis.performance.now() - parseStartedAt);
  }

  handlePiEvent(event, state, callbacks);
}

function publishEvent(state, callbacks, normalizedEvent) {
  retainEvent(state, normalizedEvent);
  callbacks?.onEvent?.(normalizedEvent);
}

function captureRunStateIfNeeded(state, event) {
  if (!needsRunStateCapture(event)) return;

  const profiler = performanceProfiler;
  const profiling = profiler.enabled;
  const startedAt = profiling ? globalThis.performance.now() : 0;
  if (profiling) profiler.incrementCounter("runStateCaptures");

  const runState = getAssistantRunState(event.message ?? event.messages);
  if (runState) {
    state.fallbackText = runState.fallbackText;
    state.errorMessage = runState.errorMessage;
    state.tokenUsage = runState.tokenUsage;
  }

  if (profiling) profiler.recordDuration("runState", globalThis.performance.now() - startedAt);
}

function needsRunStateCapture(event) {
  if (Array.isArray(event.messages)) return true;

  const message = event.message;
  if (!message) return false;
  if (message.usage || message.stopReason || message.errorMessage) return true;
  // High-frequency streaming updates must not trigger full text extraction or
  // token parsing on every delta (spec §5.7). Boundary events still capture.
  return event.type !== "message_update";
}

function normalizePiEvent(event, state, callbacks) {
  const type = String(event.type ?? "event");
  captureRunStateIfNeeded(state, event);

  if (type === "tool_execution_start" || type === "tool_execution_update") {
    const toolName = String(event.toolName ?? "tool");
    const toolCallId = String(event.toolCallId ?? "");
    const toolArgs = event.args ?? {};

    const profiler = performanceProfiler;
    const profiling = profiler.enabled;
    const startedAt = profiling ? globalThis.performance.now() : 0;
    const toolKey = trackToolEvent(state, {
      toolCallId,
      toolName,
      toolArgs,
      isStart: type === "tool_execution_start"
    });
    if (profiling) profiler.recordDuration("toolLookup", globalThis.performance.now() - startedAt);

    publishEvent(state, callbacks, {
      type: type === "tool_execution_start" ? "tool_start" : "tool_update",
      toolName,
      toolCallId,
      toolKey,
      toolArgs
    });
    return;
  }

  if (type === "tool_execution_end") {
    const toolCallId = String(event.toolCallId ?? "");
    const eventToolName = String(event.toolName ?? "tool");

    const profiler = performanceProfiler;
    const profiling = profiler.enabled;
    const startedAt = profiling ? globalThis.performance.now() : 0;
    const { key: toolKey, entry } = finishToolEvent(state, {
      toolCallId,
      toolName: eventToolName
    });
    if (profiling) profiler.recordDuration("toolLookup", globalThis.performance.now() - startedAt);

    publishEvent(state, callbacks, {
      type: "tool_end",
      toolName: String(event.toolName ?? entry?.toolName ?? "tool"),
      toolCallId,
      toolKey,
      toolArgs: event.args ?? entry?.toolArgs ?? {},
      isError: event.isError === true,
      errorMessage:
        event.isError === true
          ? String(event.errorMessage ?? event.error ?? event.result?.error ?? "")
          : undefined
    });
    return;
  }

  const assistantEvent = event.assistantMessageEvent;
  if (type === "message_update" && assistantEvent) {
    if (assistantEvent.type === "text_delta") {
      const delta = assistantEvent.delta ?? "";
      state.finalResponse += delta;
      const textEvent = { type: "text_delta", raw: event, textDelta: delta, assistantEvent };
      publishEvent(state, callbacks, textEvent);
      callbacks?.onTextDelta?.(delta, textEvent);
      return;
    }

    const toolCall = extractToolCallFromAssistantEvent(assistantEvent);
    publishEvent(state, callbacks, {
      type: assistantEvent.type,
      raw: event,
      assistantEvent,
      thinkingDelta:
        assistantEvent.type === "thinking_delta" ? String(assistantEvent.delta ?? "") : undefined,
      toolName: toolCall?.name ?? undefined,
      toolArgs: toolCall?.arguments ?? undefined,
      toolCallId: toolCall?.id ?? undefined
    });
    return;
  }

  if (type === "message_end") {
    publishEvent(state, callbacks, {
      type: "message_end",
      raw: event,
      fallbackText: extractAssistantText(event.message)
    });
    return;
  }

  if (type === "turn_end") {
    publishEvent(state, callbacks, {
      type: "turn_end",
      raw: event,
      fallbackText: extractAssistantText(event.message)
    });
    return;
  }

  if (type === "agent_end") {
    const agentEndEvent = {
      type: "agent_end",
      raw: event,
      fallbackText: extractLatestAssistantText(event.messages)
    };
    publishEvent(state, callbacks, agentEndEvent);
    state.fallbackText = agentEndEvent.fallbackText?.trim() ?? "";
    return;
  }

  publishEvent(state, callbacks, { type, raw: event });
  if (normalizeCompactionEventType(type) === "compaction_end") {
    applyCompactionEnd(state, event);
  }
}

export function extractAssistantText(message) {
  if (!message || message.role !== "assistant") return "";

  const content = message.content ?? [];
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((part) => part && part.type === "text")
          .map((part) => String(part.text || ""))
          .join("")
      : "";
}

export function extractLatestAssistantText(messages) {
  if (!Array.isArray(messages)) return "";

  for (let index = messages.length - 1; index >= 0; index--) {
    const text = extractAssistantText(messages[index]);
    if (text.trim()) return text;
  }

  return "";
}

export function getAssistantRunState(messageOrMessages) {
  const message = Array.isArray(messageOrMessages)
    ? findLatestAssistantMessage(messageOrMessages)
    : messageOrMessages;
  if (!message || message.role !== "assistant") return undefined;

  const tokenUsage = normalizeTokenUsage(message.usage);
  if (tokenUsage) {
    tokenUsage.provider = typeof message.provider === "string" ? message.provider : "";
    tokenUsage.model = typeof message.model === "string" ? message.model : "";
    tokenUsage.modelId =
      tokenUsage.provider && tokenUsage.model ? `${tokenUsage.provider}/${tokenUsage.model}` : "";
  }

  return {
    fallbackText: extractAssistantText(message).trim(),
    errorMessage:
      message.stopReason === "error" || message.stopReason === "aborted"
        ? message.errorMessage || `Request ${message.stopReason}`
        : undefined,
    tokenUsage
  };
}

export function extractEventTokenUsage(event) {
  if (!event) return undefined;

  const runState = getAssistantRunState(
    event.message ?? (Array.isArray(event.messages) ? event.messages : undefined)
  );
  return runState?.tokenUsage;
}

export function extractToolCallFromAssistantEvent(event) {
  const toolCall = event?.toolCall;
  if (toolCall) return toolCall;

  const content = event?.partial?.content?.[event.contentIndex];
  return content && content.type === "toolCall"
    ? {
        id: content.id ?? content.toolCallId,
        name: content.name,
        arguments: content.arguments ?? content.args
      }
    : undefined;
}

function findLatestAssistantMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "assistant") return messages[index];
  }

  return undefined;
}
