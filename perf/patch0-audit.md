# PATCH 0 审计 — `events[]` 消费点 + Tool Event Schema

> 规格 §3.4 / §3.5。审计基线：`dc1031c`（PATCH 0 开始时的 `perf/ui-responsiveness`）。
> 在 PATCH 2 重定义 `events[]` 之前，必须先完成本审计。

## 3.4 `events[]` 全消费点审计

### 创建与写入

| 位置 | 说明 |
| --- | --- |
| `src/pi/runner.mjs:153` | `runPiRpc` 每轮 run 新建 `const events = []`（前台主路径） |
| `src/pi/runner.mjs:259` | `runPiCli` 每轮 run 新建 |
| `src/pi/runner.mjs:366` | `runPiRpcCompact` 新建（`/compact`） |
| `src/pi/runner.mjs:56-62` | dry-run 直接返回 `events: []` |
| `src/pi/events.mjs:15` | **唯一写入点** `events.push(normalizedEvent)`；同一行同步调用 `callbacks.onEvent(normalizedEvent)`（无节流、无上限） |

说明：数组随 run 存续，保存每一条归一化事件（且事件对象内保留 `raw` 原文），一轮高强度 run 会持有全部事件直到 run 结果被丢弃 — 内存/GC 压力的来源之一。

### 数组消费者（grep 穷举：`.some/.find/.reverse/.slice/.length/[index]/.forEach/.map/.filter/传参/外部存储`）

| 位置 | 用途 | 读取形式 |
| --- | --- | --- |
| `src/pi/events.mjs:40-43` | `tool_execution_end` → 反向查找匹配的 `tool_start`，补齐 `toolName`/`toolArgs` | `events.slice().reverse().find(...)`，O(n)/次 |
| `src/pi/runner.mjs:405-417` | `getFinalResponse`：回答为空时回退到最后一个有效的 `compaction_end` | `[...events].reverse().find(...)`，O(n) |
| `src/pi/runner.mjs:419-432` | `didCompactContext`：判断本轮是否成功压缩过 | `events.some(...)`，O(n) |
| `src/pi/runner.mjs:202/206/207/344/345` | 将数组传给上述两个函数并把结果放入返回值 | 传参 |
| `src/pi/runner.mjs:205/343/388` | `result.events` 返回给调用方 | **全仓库无消费方**（`PiAgentPlugin` / `PiAgentView` 均未读取；grep 证实） |

### 单条事件消费者（经 `callbacks.onEvent` / `onTextDelta`，不经过数组）

- `src/ui/PiAgentView.mjs:980-1008`：`onEvent` → `handleSuccessfulToolMutation` / `handleRunEvent` / `captureContextUsage` / `formatToolError`；`onTextDelta` → `appendStreamingDelta`。
- `src/ui/run-activity-state.mjs:114-235` `handleRunEvent` 分支：`queue_update`、`context_ready`、`compaction_start/end`、`auto_retry_start`、`extension_error/extension_ui_error`、thinking 系列、`toolcall_start/delta/end`、`tool_start/update/end`、`text_start`、`message_end`、`turn_end`、`agent_end`。
- 派生状态：`activeToolCalls`（Map）、`streamingAssistantContent`、`streamingThinkingContent`、`nativePiQueue`、`currentRunContextUsage`、`invalidatedContextThreadIds`、`toolErrors`（activeRuns 内）、runner 内 `finalResponse`/`runState`。

### 持久化与外部存储

- `events[]` **不持久化**。持久化的是：chat history（thread store / data.json）与 Pi 自身 session JSONL（`<pluginDir>/pi-sessions/*.jsonl`，由 Pi CLI 写入，只含消息级记录，不含逐条 RPC 事件）。
- `result.events` 目前是“生成但无人读”的死数据，仅增加内存占用。

### 迁移表（规格 §3.4 要求的输出）

| 旧 events 用途 | 迁移目标 |
| --- | --- |
| `tool_end` 反查 `tool_start` 补 name/args | **ActiveTools**（`toolCallId → entry` 的 Map；fallback 见 §3.5） |
| `didCompactContext`（some + normalize 类型） | **CompactionState**（`didCompact` 布尔） |
| `getFinalResponse` 的 compaction 回退 | **CompactionState.lastValidEnd** + FinalResponse 组装 |
| `result.events` 返回值（无消费者） | 删除（PATCH 2 落地前用测试确认无隐式依赖） |
| `callbacks.onEvent` 的同步 UI 处理 | **RunState**（增量 reducer）+ UI coalescing |
| runner 内 `finalResponse` / `runState` / token usage 累积 | 保留（与 `events[]` 解耦后仍需要；不是数组消费者） |
| dry-run 返回 `events: []` | 保留占位或随 result 结构调整 |

---

## 3.5 Tool Event Schema 审计

### 归一化事实（`src/pi/events.mjs:26-58`）

| Pi 原始事件 | 归一化后 | 关键字段 |
| --- | --- | --- |
| `tool_execution_start` | `tool_start` | `toolName: String(event.toolName ?? "tool")`、`toolCallId: String(event.toolCallId ?? "")`、`toolArgs: event.args ?? {}` |
| `tool_execution_update` | `tool_update` | 同上 |
| `tool_execution_end` | `tool_end` | `toolCallId: String(event.toolCallId ?? "")`；`toolName`/`toolArgs` 缺失时从匹配的 `tool_start` 补齐 |
| assistant `toolcall_*` | 同名 | `toolCallId: toolCall?.id`（来自 `event.toolCall.id` 或 `partial.content[i].id ?? toolCallId`） |

### 问题回答

1. **`toolCallId` 是否全生命周期稳定存在？**
   代码层面：不保证 — 全部用 `?? ""` 兜底；测试仅覆盖有 ID 的情形（`tests/events.test.mjs:94-144`）。
   实测（PATCH 0 基线 run，session JSONL）：12/12 个 `toolResult` 均带 `toolCallId`（形如 `call_00_…`），与 assistant `toolCall.id` 一致。样本内未出现缺失，但 Pi 未承诺必带。
2. **哪些事件可能没有 ID？**
   理论上 `tool_execution_start/update/end` 都可能缺 `toolCallId`（代码已按可能缺失处理）；assistant `toolcall_*` 的 id 来自 `content.id ?? content.toolCallId`，两者都缺时 `toolCallId: undefined`。
3. **无 ID 时是否有协议保证的稳定关联字段？**
   有更可靠的来源：assistant 消息内的 `toolCall.id`（与后续 `toolResult.toolCallId` 一致，实测 12/12）。PATCH 2 的 `ActiveTools` fallback 应优先用该协议 ID（从 assistant `message`/`toolcall_*` 事件取），**不得**用 `JSON.stringify(toolArgs)` 之类的内容序列化做高频 key（违反硬性约束 §1）。
4. **当前代码如何处理缺失 ID？**
   - 归一化统一成空字符串 `""`；`tool_end` 的反向查找会让**所有缺 ID 的事件互相匹配**（多工具并发时会张冠李戴，把最近一个缺 ID `tool_start` 的 name/args 赋给 end）。
   - UI `ActiveTools` key：`src/ui/activity.mjs:79-87` 使用 `toolCallId || \`${name}:${JSON.stringify(toolArgs).slice(0,80)}\`` — 空 ID 时退化为 args 序列化前缀，既违反硬性约束，也会在“同名同参并发调用”时互相覆盖/误删。
   - 结论：当前缺 ID 路径不可靠，PATCH 2 必须替换 fallback。

### 附：PATCH 0 profiler 已埋点（供后续 patch 对照）

- `src/pi/events.mjs`：`rpcEventsProcessed`、`jsonParse`（耗时）、`jsonLineBytes`（max）、`event`（耗时）。
- `src/pi/rpc-client.mjs`：`drain`（单次 stdout chunk 同步排空耗时）。
- `yieldCount` / `yieldLatency` 已在 `snapshot().metrics` 中占位（当前 0），PATCH 1 的 `YieldScheduler` 落地后记录。
