# PATCH 4 — Global Lifecycle Audit（规格 §7.5）

> 审计日期：2026-09-28；被测版本：PATCH 4 工作树（`perf/ui-responsiveness`，见 `git log`）。
> 本审计是「验证与统一规则」，不接管 PATCH 0/1/3 的清理实现；只确认每个资源有正确 owner、清理点与验证证据。

## 1. 资源所有权总表

| 来源    | 资源                                                                          | Owner                                     | 创建 / 使用                                                                          | 清理点                                                                                                                                           | 证据                                                                                                        |
| ------- | ----------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| PATCH 0 | `PerformanceProfiler`（单例；counters / durations / maxima Map）              | 模块单例；plugin 暴露 `this.profiler`     | 显式 `enabled = true`；仅在事件路径累加                                              | 无计时器 / 无 OS 句柄 / 无 UI；`reset()` 清空；默认关闭                                                                                          | `tests/performance-profiler.test.mjs`（8）；PATCH 0-4 运行中多次 enable/reset/disable 无残留                |
| PATCH 1 | RPC drain（`drainPromise` / `drainPending` / `scheduleDrain`）                | `PiRpcClient`                             | stdout chunk 调度；单 pending；`generation` 防陈旧循环                               | `dispose()`：`disposed = true`、`generation += 1`；插件在 cancel / fork / 删除线程 / `onunload` 调 `runner.rpcClient?.dispose()`                 | `tests/rpc-cooperative-drain.test.mjs`、`tests/rpc-client.test.mjs`；`PiAgentPlugin.mjs:536/686/972`        |
| PATCH 1 | `YieldScheduler` + 单例 `MessageChannel`                                      | `YieldScheduler`（由 `PiRpcClient` 持有） | 首次 yield 惰性建 channel 并复用                                                     | `dispose()`：`port1.onmessage = null`、关闭两 port、结算 pending yields；由 `PiRpcClient.dispose()` 调用                                         | `tests/yield-scheduler.test.mjs`（7）；`rpc-client.dispose()`                                               |
| PATCH 1 | 子进程与 stdio                                                                | `PiRpcClient`                             | `start()` spawn                                                                      | `dispose()` → `terminate()`：Windows `taskkill /T /F`，否则 kill；退出时 reject pending requests                                                 | `rpc-client` 测试；PATCH 4 运行后 disable/enable 冒烟                                                       |
| PATCH 2 | `RunState` / ActiveTools Map / `DiagnosticRing`（容量 500）                   | run 闭包（每次 run 新建；`PiRunner` 内）  | run 生命周期内                                                                       | run settle 后随闭包与结果失效，无全局持有；DiagnosticRing 有界                                                                                   | `tests/run-state.test.mjs`；运行时 `diagnosticBufferSize = 500` 有界；`retainedEvents` 指标已随断言清理移除 |
| PATCH 3 | streaming rAF（`streamingFlushRaf` / `streamingFlushGuard`）                  | `PiAgentView`                             | `scheduleStreamingFlush`（每帧至多一个）                                             | `onClose` / `resetTransientRunUiState`（线程切换）/ run 成功收尾 / `finally` / `agent_end` finalize；PATCH 4 增加 generation 守卫                | `tests/streaming-renderer.test.mjs`（10）；PATCH 3/4 真实运行                                               |
| PATCH 3 | 最终 Markdown render 的 `Component`（`messageRenderComponents` + WeakMap）    | `PiAgentView`                             | `renderPlainMessageContent`                                                          | `unloadMessageRenderComponents()`：`onClose` 及每次 `renderMessages`                                                                             | `tests/message-renderer.test.mjs`；disable/enable 冒烟                                                      |
| PATCH 4 | `activityCoalesceTimer` / `activityCoalescePending` / `activityCoalesceGuard` | `PiAgentView`                             | `scheduleCoalescedActivity()`（tool_update 合并）                                    | `clearCoalescedActivity()`：立即事件（tool_start / tool_end / error / agent_end / cancel）、`resetTransientRunUiState`、`onClose`、run `finally` | `tests/activity-coalescing.test.mjs`（7）                                                                   |
| PATCH 4 | sticky 队列 `pendingActivityTimer` 的 generation 守卫                         | `PiAgentView`                             | `schedulePendingActivity()`                                                          | `clearPendingActivityTimer()`（apply / 清理路径）；守卫不匹配即丢弃并计数                                                                        | `tests/activity-coalescing.test.mjs`                                                                        |
| PATCH 4 | `runGeneration` / `threadGeneration` 守卫                                     | `PiAgentView`                             | 每个 run 分配 `runGeneration`；`resetTransientRunUiState` 时 `threadGeneration += 1` | 不持有资源；仅做判定                                                                                                                             | `captureUiCallbackGuard` / `isStaleUiCallback` / `noteStaleUiCallback`；单测 + 源断言                       |

## 2. 统一规则（PATCH 4 落地）

1. 所有延迟 UI 回调（activity 合并 timer、sticky 队列 timer、streaming rAF）执行前检查 `isStaleUiCallback(guard)`：`threadGeneration` + `threadId` + `runGeneration`；DOM 更新路径各自再检查 `element.isConnected`（`updateActivityDom`、`renderStreamingAnswer`、`renderStreamingThinking`）。
2. 被丢弃的陈旧回调统一计入 profiler `staleCallbackPrevented`。
3. 立即事件不等待 timer，并清除 pending 合并状态；`agent_end` 同时做 PATCH 3 的同步 finalize。
4. PATCH 0/1/3 的清理实现保持原样（本审计未改动其代码路径，只新增守卫检查）。

## 3. 运行时验证（2026-09-28，测试 Vault）

- 固定 prompt 全库健康检查（PATCH 4 测量运行）：`staleCallbackPrevented = 0`——正常路径先经显式 cancel/clear，守卫未被触发；合成单测强制 guard 不匹配时，合并 flush / sticky flush / streaming rAF 均被丢弃并计数。
- `plugin:disable` → `plugin:enable` → `plugin:reload` 冒烟：`dev:errors` 空，覆盖 `onClose` → `onunload` → `disposeThreadRunners()` → `PiRpcClient.dispose()`（含 `YieldScheduler.dispose()`）。
- 视图关闭后无 streaming/activity 计时器残留（`streamingFlushRaf`、`activityCoalesceTimer` 均为 undefined）。

## 4. 遗留说明

- `finishCanceledRun()` 已在 Cleanup 轮移除（无调用方的历史遗留方法）；取消路径的清理保持在 `runPrompt` 的 `finally`（含 PATCH 4 的 `clearCoalescedActivity()`）。
- 发现 #1 / #2（PATCH 0 记录）仍为范围外事项，未处理。
