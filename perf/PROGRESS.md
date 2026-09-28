# obsidian-pi 性能修复 — 进度追踪

> 本文件随 git 提交，用于跨对话/跨步骤追踪。每个 Step 完成后追加记录。

## 约定

- 规格文件：`C:\Users\zcooo\Desktop\3\1.md`；严格按 PATCH 顺序执行，每一步只阅读该步允许的章节。
- 仓库：`C:\Users\zcooo\Desktop\3\obsidian-pi`
  - fork origin：`https://github.com/xxxlyfy/obsidian-pi.git`
  - 基线 commit：`dc1031c`（"Prepare release 0.0.16"）
- 工作分支：`perf/ui-responsiveness`
- 每步一个 commit；message 格式 `perf(stepN): <summary>`。
- 只允许修改 `src/` 等源码与测试、文档；`main.js` 是生成物，必须用 `npm run build` 重新生成，禁止手改。
- 每步收尾流程：
  1. `npm run build`（确认生成 `main.js`）；
  2. `npm run ci` 全绿（仓库真实命令，见 `package.json`；CI 在 ubuntu-latest / Node 24 上跑同一命令）；
  3. `git add` + commit；
  4. 追加本文件 Step 记录（状态 / commit / 改动文件 / 关键测量 / 人工验证 / 风险与未决 / 下一步入口条件）；
  5. 输出 ≤15 行「交接摘要」给下一轮对话。
- 测量数据必须真实；取不到写 `unavailable`，禁止伪造。
- 硬性约束（规格 §1）：不丢 RPC event、不降功能、不限制工作强度、不碰生成物、本阶段不引入 Worker、不用 `WeakMap(event)` 做 lifecycle key、不用 `JSON.stringify(toolArgs)` 做高频 key；保持 event ordering / response correlation / cancellation / compaction / session 持久化 / tool 能力 / 最终答案 / UTF-8+JSONL 边界语义。

### 本机环境注意（每个新克隆都要处理）

- 系统 git 配置 `core.autocrlf=true` 且仓库无 `.gitattributes`，会让 checkout 变成 CRLF，导致 `format:check` 对所有文件报错（实测 137 files）。
- 处理方式（本仓库已设置）：`git config core.autocrlf false`，然后 `git rm --cached -r -q . && git reset --hard` 强制以 LF 重新 checkout。
- npm 11.19 未批准 `esbuild@0.28.1` 的 postinstall（`npm warn install-scripts`）；当前构建正常（平台二进制来自 optionalDependencies）。若后续构建报 esbuild 二进制缺失，用 `npm install-scripts approve esbuild` 或 `npm rebuild esbuild`。

## Step 记录模板

```text
### Step N — <标题>
- 状态：
- commit：
- 改动文件：
- 关键测量：
- 人工验证：
- 风险与未决：
- 下一步入口条件：
```

---

### Step 1 — 准备与 CI 基线

- 状态：**完成（本步无生产逻辑改动）**；测试 Vault 已建、`dev:install` 已完成并校验哈希，Obsidian 内人工验证已通过（通过官方 `obsidian` CLI 自动执行）；发现 1 个既有 bug（见「风险与未决」与 `perf/baseline.md`「发现 #1」），未修。
- commit：`perf(step1): baseline workspace and ci gate`（hash 见 `git log`，避免自引用不写回本文件）。
- 仓库就位：选择 **clone 路线**（`git clone https://github.com/xxxlyfy/obsidian-pi.git`）。理由：收尾必须运行 `npm ci`，复制 `Desktop\2` 的 `node_modules` 会被 `npm ci` 清掉、没有收益；clone 后与 `Desktop\2` 核对为同一 commit `dc1031c`，remote 指向 fork，工作分支 `perf/ui-responsiveness` 创建成功。
- 改动文件：仅新增 `perf/PROGRESS.md`、`perf/baseline.md`；`src/` 零改动；`main.js` 仅由 `npm run build` 重新生成（内容与仓库内版本一致，`build:check` 通过）。
- 关键测量（详见 `perf/baseline.md`）：
  - `npm ci`：通过，added 370 packages，约 5.8s（npm 缓存已热）。
  - `npm run ci` 基线：**全绿**，墙钟约 15.3s；50 test files / 282 tests passed（vitest 1.95s）；`version:check` 0.0.16 valid。
  - 首次运行曾在 `format:check` 失败（137 个文件，CRLF 导致，环境问题非代码问题），修复 checkout 后重跑全绿。
  - `main.js`：sha256 `7820055959950c1354d84560149a421f9e26a274826a0087a4d0ea67edd122f2`，419205 bytes。
- 人工验证（按顺序）：
  1. ✅ 测试 Vault 已确定：`C:\Users\zcooo\OneDrive\Obsidian` 经 `%APPDATA%\obsidian\obsidian.json` 证实为**唯一注册且当前打开的主 Vault**（含真实插件与 pi-agent 活跃数据），按约束排除；用户选定并新建专用测试 Vault `C:\Users\zcooo\Desktop\3\test-vault`。
  2. ✅ `npm run dev:install -- C:\Users\zcooo\Desktop\3\test-vault\.obsidian\plugins\pi-agent` 执行成功；三文件 sha256 与仓库一致（main.js `7820055…`、manifest.json `F338C4…`、styles.css `ED6920…`）；预置 `community-plugins.json = ["pi-agent"]`（关闭限制模式后自动加载）。
  3. ✅ 测试 Vault 已由 Obsidian 打开（`obsidian.json` 注册 + 启动；该版本 CLI 不支持直接打开任意文件夹为 Vault），关闭限制模式后 pi-agent 0.0.16 自动加载；`plugin:reload` + `dev:errors` / `dev:console` 确认无错误（配置模型后）；证据截图见 `perf/baseline.md`「人工验证记录」。
  4. ✅ 运行时版本已确认：Obsidian 1.13.7 / Electron 43.3.0 / Chromium 150.0.7871.212 / Electron 内建 Node 24.18.1（`obsidian version` + `obsidian eval`）。
- 风险与未决：
  - **CRLF 环境**：新克隆/新机器必须按上文设置 `core.autocrlf=false` 并强制 LF checkout，否则 `npm run ci` 会假红。这是本机环境修复，与上游代码无关。
  - **esbuild install script 未批准**（npm 11.19 warn）：当前正常；若 PATCH 5 引入 benchmark 需要重新构建工具链，留意。
  - **测试 Vault 已就位**：主 Vault（经 `obsidian.json` 证实为唯一注册的主 Vault）永久排除，禁止对其 dev:install；测试 Vault 固定为 `C:\Users\zcooo\Desktop\3\test-vault`。注意 `dev:install` 是**复制**而非链接，每次 `npm run build` 后需重跑才能在 Obsidian 中看到新产物（PATCH 阶段注意）。
  - **既有 bug（0.0.16，与本次无关）**：全新 Vault 未配置模型时打开 Pi 视图抛 `e.startsWith is not a function`（`src/ui/run-settings.mjs:78-79` 将 `{ provider: "" }` 当图标名传给 `setIcon`），核心吞异常导致视图半初始化（无 Send 按钮等）。测试 Vault 已配置 `deepseek/deepseek-flash` 规避；不在性能 PATCH 范围，建议单独开 issue（详见 `perf/baseline.md`「发现 #1」）。
  - **测试 Vault 已配置**：`pi-agent` 设置 `model = deepseek/deepseek-flash`（Pi 当前 effective model，目录共 2 个），后续 PATCH 基线可直接使用。
  - TESTING.md 引用的 `ObsidianTesting` 路径是上游 macOS 路径，本机不存在；本机测试 Vault 已确定为 `Desktop\3\test-vault`，人工检查清单以 `TESTING.md` + 规格后续步骤为准。
  - `TESTING.md` 记录上一次发布是 0.0.12 / 47 files / 262 tests，当前 0.0.16 基线为 50 files / 282 tests（差异属正常版本演进）。
- 下一步入口条件：**已满足** → 开始 PATCH 0（Baseline + Runtime Spike + Audit + Minimal Profiler）。

---

### PATCH 0 — Baseline / Runtime / Audit / Minimal Profiler

- 状态：**完成**。
- 改动文件：
  - 新增 `src/shared/performance-profiler.mjs`、`tests/performance-profiler.test.mjs`（6 tests）；
  - 接线：`src/pi/events.mjs`（`rpcEventsProcessed` / `jsonParse` / `jsonLineBytes` / `event`）、`src/pi/rpc-client.mjs`（`drain`）、`src/plugin/PiAgentPlugin.mjs`（`this.profiler = performanceProfiler`，默认关闭、显式启用）；
  - `main.js` 由 `npm run build` 重新生成（`build:check` 通过）；新增 `perf/patch0-audit.md`、`perf/tools/seed-test-vault.mjs`；更新 `perf/baseline.md`。
- 关键测量（详见 `perf/baseline.md`）：
  - 未修改版本全库健康检查（433 笔记 / 0.48 MiB）：total **67.35s**；longest task **11,996ms**；P95 1,367ms；P99 11,996ms；longtask 54 个、合计 31.1s；heap 41.2→79.9MB；无错误。
  - Yield spike：`scheduler.yield` 可用（p95 0.1ms）、priority continuation 正常 → **情况 A**。
  - Profiler 验证运行（PATCH 0 代码）：events 12、drain max 6.0ms、event max 5.9ms、jsonParse max 0.3ms、jsonLineBytes max 60,691。
- 人工验证：`npm run ci` 全绿（**51 files / 288 tests**）；dev:install → `plugin:reload` → profiler 启用/快照/关闭 → `dev:errors` 无错误。审计：`perf/patch0-audit.md`（events[] 迁移表 + tool schema 四问）。
- 风险与未决：
  - **发现 #2（既有，Windows）**：`cmd.exe /c` 多行参数截断 → `--tools` / `--skill` / `--no-skills` 丢失、system 指令被截断；工具模式在 Windows 不生效（基线 run 实际为全量工具 + bash）。不影响本 PATCH 验收，PATCH 5 基准与跨平台对比必须记录。
  - 发现 #1（空 Vault 视图渲染 TypeError）已记录，未修。
  - 性能对比基线取自未修改版本（合规）；profiler 验证运行不计入对比基线。
- 下一步入口条件：**已满足** → PATCH 1（RPC Cooperative Drain；`YieldScheduler` 主路径 `scheduler.yield()`）。

---

### PATCH 1 — RPC Cooperative Drain

- 状态：**完成**。
- 改动文件：
  - 新增 `src/pi/yield-scheduler.mjs`：主路径 `scheduler.yield()`（依据 PATCH 0 spike 情况 A）→ 复用单例 MessageChannel → `setTimeout(0)`；`dispose()` 关闭 channel 并结算 pending yield；profiler 记录 `yieldCount` / `yield` 耗时。
  - `src/pi/rpc-client.mjs`：有界 drain（初值 64 events / 6ms，可注入 `drainBudget`）、`stdout` 只追加不重复调度（单 pending drain + 退出重查防 tick 竞态）、UTF-8 半字符与半行 JSONL 语义保持、`generation` 防陈旧回调、`close` 前先排空缓冲区、`dispose` 清理调度器。
  - 测试：新增 `tests/yield-scheduler.test.mjs`（7）、`tests/rpc-cooperative-drain.test.mjs`（规格 Test A–E：1k/10k burst、UTF-8 跨 chunk、半行跨 chunk、dispose during backlog，共 6）；更新 `tests/rpc-client.test.mjs`（等待排空）。
- 关键测量（同 prompt 真实运行，详见 `perf/baseline.md`）：longest main-thread task **11,996ms → 63ms**；longtask **54 → 3**；总阻塞 **31.1s → 0.18s**；本轮 19,497 events、93.2 events/sec、8,846 yields（max 16.2ms / mean 0.43ms）；`maxEventDuration` 63.1ms（221,914B 的 `agent_end` 单事件，PATCH 2/3 继续优化）；0 错误。
- 验证：`npm run ci` 全绿（**53 files / 301 tests**）；dev:install → `plugin:reload` → profiler 快照 → `dev:errors` 空。CI 合成测试用注入 spy 验证 yield 次数下限（不依赖 wall-clock）。
- 风险与未决：
  - `maxDrainDuration`（63ms）暂高于 6ms 预算：预算只能在事件之间暂停，单事件成本高；记录在案，PATCH 2/3 处理。
  - 真实运行受模型随机性影响（tool calls 23 vs 12），跨 patch 对比以“主线程阻塞/事件级指标”为准。
  - 发现 #1/#2 仍未处理（范围外）。
- 下一步入口条件：**已满足** → PATCH 2（Event Algorithm + RunState + Retention）。

---

### PATCH 2 — Event Algorithm + RunState + Retention

- 状态：**完成**。
- 改动文件：
  - 新增 `src/pi/run-state.mjs`：RunState（fallbackText / finalResponse / tokenUsage / errorMessage / compaction 状态）、ActiveTools Map（`toolCallId → state`；无 id 时仅唯一同名匹配，不确定时**不伪造关系**并 warning）、`DiagnosticRing`（容量 500 环形缓冲）、保留策略（高频事件只留最小字段，tool raw/大结果不进保留区）、compaction 一致性断言（incremental vs legacy `events.some`）。
  - `src/pi/events.mjs`：新增 `handlePiEvent(eventObject, state, callbacks)`；RPC 路径彻底消除 `JSON.stringify → JSON.parse` 往返（实测 `maxJsonParseDuration = 0`）；`handlePiJsonEventLine` 仅服务真正的字符串路径（CLI JSON / 测试）；§5.7 gating（`message_update` 无 usage/stop 不再触发全文提取与 token 解析）。
  - `src/pi/runner.mjs`：三处 run 路径改用 RunState；`getFinalResponse` / `getRunContextUsage` / compaction 判定全部状态化；结果移除无消费者的 `events` 字段、新增有界 `diagnostics` 快照。
  - `src/ui/activity.mjs`：`getToolEventKey` 改用生命周期 `toolKey`，删除 `JSON.stringify(toolArgs)` 高频 fallback（§5.2）。
  - 测试：新增 `tests/run-state.test.mjs`（8）；重写 `tests/events.test.mjs`（10）。
- 关键测量（详见 `perf/baseline.md`）：同负载真实运行 18,188 events 下 **longtask 0 个**（PATCH 1：3 个 / 176ms）；`maxEventDuration` 63.1 → **28.2ms**；RunState 更新 max 0.2ms（18k 事件仅 108 次捕获）；tool lookup max 0.1ms；诊断缓冲有界 500；compaction 断言 0 告警（**gate 1/3**）；0 错误/告警。
- 验证：`npm run ci` 全绿（**54 files / 312 tests**）；合成微基准给出 tool lookup before/after（10k 事件：0.012–0.071ms → 0.00001ms）。
- 风险与未决：
  - `maxDrainDuration` 仍可能被单事件成本抬到 ~28ms（>6ms 预算）——预算只能在事件之间暂停；单事件成本（UI 回调/DOM 更新）留给 PATCH 3。
  - legacy compaction 断言按规格保留，**删除前不得移除**；需 3 次真实运行 0 告警，当前 1/3（本轮无 compaction 事件）。
  - 发现 #1/#2 仍未处理（范围外）。
- 下一步入口条件：**已满足** → PATCH 3（Streaming Rendering）。

---

### PATCH 3 — Streaming Rendering

- 状态：**完成**。
- 改动文件：
  - `src/ui/message-renderer.mjs`：流式阶段改纯文本 + rAF 合并。新增 `appendStreamingDelta` / `appendStreamingThinkingDelta`（只追加单真相源 + dirty 标记 + `scheduleStreamingFlush`；由 `Object.assign` 混入 View 原型，方法从 PiAgentView 移入）、`scheduleStreamingFlush` / `cancelStreamingFlush` / `flushStreaming`（每帧至多一次 `setText` 低开销更新，DOM 缺失时回退 `renderMessages`）、`finalizeStreamingContent`（取消 pending rAF → 同步 flush → 单真相源一次最终 Markdown render，完全替换纯文本容器，含滚动恢复）；`renderStreamingAnswer` / `renderStreamingThinking` 改纯文本；`renderActivityMessage` / `renderStreamingAssistantMessage` 的 live thinking 不再走 Markdown；`renderPlainMessageContent` 计 `markdownRenderCount`。
  - `src/ui/PiAgentView.mjs`：onEvent/onTextDelta 包 uiCallback 计时并计 `streamDeltaCount`；onClose / resetTransientRunUiState（线程切换）/ finishCanceledRun / run 成功收尾 / finally 均调用 `cancelStreamingFlush` 并重置 dirty；新增 `streamingFlushRaf` 等字段。
  - `src/ui/run-activity-state.mjs`：`agent_end` 先 `finalizeStreamingContent()`（§6.4），无可用 DOM 才回退 `renderMessages()`。
  - `src/shared/performance-profiler.mjs`：新增 `streamDeltaCount` / `streamFlushCount` / `markdownRenderCount` / `maxUiCallbackDuration` / `maxStreamFlushDuration`。
  - 测试：新增 `tests/streaming-renderer.test.mjs`（9，覆盖合并、agent_end 同步 finalize、回退、滚动、生命周期、profiler 计数）；更新 `tests/native-chat-polish.test.mjs`（流式纯文本契约）、`tests/performance-profiler.test.mjs`。
- 关键测量（同 prompt 受控运行，详见 `perf/baseline.md`）：
  - 15,636 RPC events / 71.5s；`streamDeltaCount` **6,949** → `streamFlushCount` **1,625**（0.23×；4.28 delta/flush）；`markdownRenderCount` **10**（0.14% of delta，基线为每 delta 一次）。
  - streaming 阶段 longtask **0**、`maxStreamFlushDuration` 7.6ms（mean 2.2ms）、UI 回调 mean **0.011ms**；唯一 >1ms 回调为 agent_end finalize **57.6ms**（§6.4 同步要求），结束边界另有完成渲染 92ms longtask（均随最终文本 18.7k+4.0k 字符增长）。
  - `maxEventDuration` 28.2 → 57.6ms（agent_end 同步 finalize 的代价）；`yieldCount` 0（本轮 stdout 批均 ~1.85 事件、批后无遗留，非回归）；compaction 告警 0。
- 人工验证：`npm run ci` 全绿（**55 files / 322 tests**）；dev:install → `plugin:reload` → `dev:errors` 空；真实运行逐项验证 §12.3：final answer / thinking 完成态为 Markdown、流式为纯文本；自动滚动跟随；手动上滚不被拉回且结束后保持；线程切换（切走取消 rAF、切回恢复流式）；取消（content/rAF/dirty/activeRuns 清零）；agent_end 时间戳关联确认 59ms/92ms longtask 均在运行结束边界。截图 `%TEMP%\opencode\patch3-final.png`。
- 风险与未决：
  - agent_end 同步 finalize 按 §6.4 是硬要求，会产生一次性 57.6ms UI 回调 + 59ms longtask；随后完成路径整线程 render 为 92ms。二者都随最终文本长度增长，streaming 阶段仍 0 longtask；若要消除边界峰值需改变「final = 完整 Markdown」语义，建议后续独立评估。
  - legacy compaction 断言门禁：PATCH 2 run（1）+ 本轮 run A / run E（session JSONL 无 compaction 事件、profiler 无告警）= **3/3**；断言代码仍保留未删（清理属 PATCH 2 退出条件，本步未触碰）。
  - 发现 #1/#2 仍未处理（范围外）。
- 下一步入口条件：**已满足** → PATCH 4（Activity UI + Global Lifecycle Audit）。

---

### PATCH 4 — Activity UI + Global Lifecycle Audit

- 状态：**完成**。
- 改动文件：
  - `src/ui/run-activity-state.mjs`：`tool_update` 活动状态合并（`ACTIVITY_COALESCE_MS = 150`，规则见「合并窗口决策」）；`tool_start` / `tool_end` / error（含 compaction failed）/ `agent_end` / cancel 立即更新并清除 pending 合并；新增 `scheduleCoalescedActivity` / `flushCoalescedActivity` / `clearCoalescedActivity`；sticky 队列 timer 增加 generation 守卫；`applyActivity` 记 `activityFlushCount` / `activityUpdate`，守卫拒绝记 `staleCallbackPrevented`。
  - `src/ui/PiAgentView.mjs`：`runGeneration`（每 run 分配）/ `threadGeneration`（线程重置 +1）与 `captureUiCallbackGuard` / `isStaleUiCallback` / `noteStaleUiCallback`；run 回调 UI 段增加 stale-run 检查；`onClose` / `resetTransientRunUiState` / `finishCanceledRun` / `cancelCurrentRun` / run `finally` 清理合并状态。
  - `src/ui/message-renderer.mjs`：streaming rAF 增加同一 generation 守卫（陈旧帧丢弃并计数）。
  - `src/shared/performance-profiler.mjs`：新增 `activityFlushCount` / `activityCoalescedEvents` / `activityCoalescedFlushes` / `maxActivityUpdateDuration` / `staleCallbackPrevented`。
  - 新增 `perf/patch4-lifecycle-audit.md`；测试新增 `tests/activity-coalescing.test.mjs`（7），`tests/streaming-renderer.test.mjs` 加 stale 帧用例，`tests/performance-profiler.test.mjs` 加 PATCH 4 指标。
- 关键测量（固定 prompt 受控运行，详见 `perf/baseline.md`）：
  - 10,742 RPC events / 52.6s；`activityFlushCount` **50**（events 的 **0.47%**，§7.2 目标达成）；`activityCoalescedEvents` 30 → `activityCoalescedFlushes` **11**（2.73× 合并）；`maxActivityUpdateDuration` **0.3ms**（mean 0.086ms）；`staleCallbackPrevented` 0（正常路径先行清理，陈旧场景单测强制验证）。
  - 窗口决策：初始 150ms（100–200 区间中值）→ 数据支持**保持 150ms**（合并 2.73×、单次更新 <0.5ms、tool_update 0.57/s、sticky 1200ms 未改）。
  - 同轮回归：5,323 deltas → 1,345 flushes（0.25×）、markdownRenderCount 10、maxUiCallback 35ms（agent_end finalize）、stream flush max 4.2ms；longtask 1 × 60ms（完成路径整线程 render）。
- 人工验证：`npm run ci` 全绿（**56 files / 331 tests**）；dev:install → reload → `dev:errors` 空；真实运行 + `plugin:disable → enable → reload` 冒烟（覆盖 `onClose`/`onunload` → `disposeThreadRunners()` → RPC/YieldScheduler 清理）；运行时 30s 采样确认活动刷新远低于事件频率。
- 风险与未决：
  - generation 守卫为第二道防线：正常取消/切换路径已显式清理，真实运行未触发 `staleCallbackPrevented`（=0）；仅在单测的人造陈旧场景中触发。
  - `finishCanceledRun()` 无调用方（历史遗留）；取消清理实际在 `finally` 中执行并已接入 PATCH 4 清理；是否删除该方法留作后续清理项。
  - 发现 #1/#2 仍未处理（范围外）。
- 下一步入口条件：**已满足** → PATCH 5（Benchmark + Performance Regression + CI）。

---

### PATCH 5 — Benchmark + Performance Regression + CI

- 状态：**完成**。
- 改动文件：
  - `src/shared/performance-profiler.mjs`：新增 `markHeap`（before / during 取峰值 / after）与 `maxRpcQueueDepth` / `maxRpcQueueBytes` / `heapUsedBefore` / `heapUsedDuring` / `heapUsedAfter` 指标。
  - `src/pi/rpc-client.mjs`：`measureQueue()` 记录队列深度/字节（启用时，O(chunk) 扫描）；`handleLine` 在对象路径记录 `jsonLineBytes` 与单次 `jsonParse` 时长（§9「largest JSON line / longest JSON.parse」）。
  - `src/ui/PiAgentView.mjs` / `src/ui/run-activity-state.mjs`：run 起点 / agent_end / finally 调用 `markHeap("before"|"during"|"after")`。
  - `perf/tools/seed-test-vault.mjs`：新增 `--total=N`（默认 433；PATCH 5 基准用 10000）。
  - 测试：新增 `tests/perf-synthetic.test.mjs`（Test C/F/G + CI burst 回归 + 队列埋点，5 项）；`tests/performance-profiler.test.mjs` 加 PATCH 5 指标。
- 合成测试覆盖（§8.2/§8.3）：
  - Test A/B/D/E 已有（`tests/rpc-cooperative-drain.test.mjs`：1k/10k burst、UTF-8 跨 chunk、半行跨 chunk、backlog 中 dispose）。
  - Test C：20,000 次 track/finish + 2,000 并发 ActiveTools 关联零错、O(1)（<2s 宽松上界）。
  - Test F：1,000 text deltas → 内容精确一致、flush ≤11（<< 1000）、finalize 后 markdown 恰 1 次、被取消的 pending 帧为 no-op（agent_end 顺序正确）。
  - Test G：compaction success/abort/error 与 legacy scan 一致、0 告警。
  - CI 回归：2,000-event burst 经 FakeYieldScheduler（注入 spy），0 丢失/重复/乱序、yield ≥ floor(2000/40)-1、单批同步处理 ≤40（无无限同步 drain）。
- 真实 Vault Benchmark（§8.4，10,000 篇 / 8.92 MiB，详见 `perf/baseline.md`）：
  - run 57.9s / 9,369 events；longtask **3 / 175ms**（52ms 起点 context、63ms agent_end finalize、60ms 完成 render）；**P95/P99 = 63/63ms**（PATCH 0：1,367 / 11,996ms、54 个 longtask / 31.1s）。
  - max queue depth/bytes **44 / 98,052 B**；largest JSON line **98,051 B**；max JSON.parse **0.4ms**；max normalize **61.4ms**；max drain **62ms**。
  - stream 4,307 → flush 1,102（0.26×）；markdown 10（0.23% of deltas）；activity flush 74（合并 41 → 12，3.4×）；heap 100.8 → 峰值 135.7（+36.6MB）→ 90.8 MiB。
  - 响应性：运行中 rAF 40 帧 mean 6.9ms / max 7.1ms；完成后自动滚动到底（2910/2910）。
- 验证：`npm run ci` 全绿（**57 files / 337 tests**）；dev:install → reload → 10,000 文件索引（`getMarkdownFiles() = 10000`）→ profiler 基准运行 → `dev:errors` 空；证据截图 `%TEMP%\opencode\patch5-benchmark.png`、原始快照 `%TEMP%\opencode\patch5-benchmark.txt`。
- 风险与未决：
  - 63ms 边界任务按 §9 属「serious（50–200ms）」，但为一次性最终 Markdown 渲染；streaming 期 0 longtask、每帧 ≤3.9ms。是否进一步降边界峰值作为 PATCH 6/7 决策输入（提供 profiling 依据）。
  - `yieldCount 0` 属负载特性（队列峰值 44 < 批预算 64）；burst 场景由 CI 注入测试证明调度器可用。
  - 发现 #1/#2 仍未处理（范围外）。
- 下一步入口条件：**已满足** → 最终报告（规格 ch.14）+ PATCH 6/7 条件评估（届时读 1.md 第 10/11 章）。

---

### Final — 条件补丁决策 + 最终报告

- 状态：**完成（无生产代码变更）**。
- 交付：`perf/FINAL-REPORT.md`（规格 ch.14 全部章节：Environment / Baseline / 每个 Patch / Before-After / Conditional Patch / 成功标准对照 / 遗留事项）。
- 条件决策：
  - **PATCH 6（Application/Pipe Backpressure）：Not Implemented**。依据：max queue depth **44 行** / max queue bytes **98,052 B** 未增长（低于 64-event 批预算，drain 实时消费）；longtask **3 / 175ms** 全在运行首尾、流式期 0；heap 峰值 +36.6MB 后回落至低于起点；Pi ~162 events/s 远低于 renderer 消费能力（单批 mean 0.064ms）→ §10.3 三项达标，不实施。
  - **PATCH 7（Worker）：Evaluated: Yes / Implemented: No**。依据：max JSON.parse **0.4ms**（mean 0.006ms / 9,374 次）远低于 >16ms 进入门槛；唯一 >50ms 的 normalization 样本是 DOM 绑定的 `agent_end` finalize（61.4ms，§11.1 Worker 禁止且无法下放）→ 进入条件不满足，未做 Worker 全成本对比即不实施。
- 验证：`npm run ci` 全绿（57 files / 337 tests，PATCH 5 最终状态）；报告全部数据来自 PATCH 0-5 受控真实运行（见 `perf/baseline.md`）。
- 未决：见报告「遗留事项」——发现 #1/#2（范围外）、legacy compaction 断言门禁 3/3 可清理、`finishCanceledRun()` 死代码、63ms 边界渲染可选优化。
- 下一步：项目规格内步骤全部完成；如需继续可跟进遗留事项或按要求发布到 fork。

---

### Cleanup — legacy compaction 断言与死代码移除

- 状态：**完成**（规格 §12.2 门禁达成后的清理；无行为变化）。
- 背景：legacy compaction 一致性断言需「≥3 次真实全库健康检查 + 0 告警」才可删除；门禁已于 PATCH 3/4 达到 **3/3**（session JSONL 无 compaction 事件、profiler 0 告警）。
- 改动文件：
  - `src/pi/run-state.mjs`：删除 `legacySawSuccessfulCompaction` / `assertCompactionConsistency` / `state.events` 保留区及其 compaction 专用字段拷贝；`retainEvent` 只维护有界 `DiagnosticRing`。`sawSuccessfulCompaction` / `sawAbortedCompaction` / `lastCompactionEnd` 语义不变。
  - `src/shared/performance-profiler.mjs`：移除已无生产者的 `retainedEvents` 指标。
  - `src/ui/PiAgentView.mjs`：删除无调用方的 `finishCanceledRun()`；取消清理保持在 `cancelCurrentRun` + `runPrompt` `finally`。
  - 测试：`tests/run-state.test.mjs`（改为 success/abort/failed 三态跟踪，移除 legacy 告警用例）、`tests/events.test.mjs`（compaction 保留断言改为 diagnostics ring）、`tests/perf-synthetic.test.mjs` Test G、`tests/activity-coalescing.test.mjs` / `tests/streaming-renderer.test.mjs` 源断言同步。
- 验证：`npm run ci` 全绿（57 files / **336 tests**，差值为删除的 legacy 告警测试）；dev:install → reload → `dev:errors` 空；短 prompt 真实运行：final answer Markdown ✅、stream 194 → flush 65、`diagnosticBufferSize 209`（有界）、metrics 不再含 `retainedEvents`、0 错误。
- 未决：发现 #1/#2（范围外）；63ms 边界渲染可选优化（本项目未做，PATCH 6/7 决策不因此改变）。

---

### Local fixes — 发现 #1 / #2（2026-09-28，本地自用分支）

- 状态：**完成**；按用户确认（个人自用、不反馈上游、不同步上游）本地直接修复，无 issue。
- 变更：
  - `src/ui/run-settings.mjs`（发现 #1）：provider 对象一律走 `renderProviderIcon`（无 provider 时显示 AI monogram），不再把 `{ provider: "" }` 传给 `setIcon`；`getModelProvider` 对空 `effectiveModel` 加防护。
  - `src/pi/environment.mjs`（发现 #2）：Windows 下 `buildPiProcessInvocation` 把多行 `--system-prompt` / `--append-system-prompt` 值改写为临时文件路径（Pi 对存在的路径读取文件内容，`resource-loader.resolvePromptInput`），避免 cmd.exe 按换行拆分 `/c` 命令导致后续参数（`--tools` / `--skill` / `--no-skills`）丢失；文件按内容 SHA-1 命名（幂等去重），写失败回退内联文本；POSIX 行为不变。
  - 测试：`tests/environment.test.mjs`（多行改写 + 后续参数保留 + 单行/无关参数不动）、`tests/composer-run-settings.test.mjs`（无 provider 时 monogram、`setIcon` 仅接收字符串）。
- 验证：`npm run ci` 全绿（57 files / **339 tests**）。
  - #1 真实运行：清空 model/effectiveModel/availableModels 后刷新控件 → 3 控件正常、Model 显示 `AI` monogram、`dev:errors` 空；随后恢复 `deepseek/deepseek-flash`。
  - #2 真实运行：read-only 模式执行「列出 vault 根目录结构」，session `1790600219097-b985irhbtw9.jsonl`：33 次工具调用全部为 `ls` / `find`（**0 bash、0 写入**；修复前 12/12 为 bash）；session 内含完整系统指令（`## Vault behavior`、`user-owned knowledge`），不再截断；结束答案 986 字符、0 错误。
- 备注：临时文件位于 `%TEMP%\pi-agent-system-prompt-<hash>.md`，按内容去重、随系统临时目录清理；内容为插件 system 指令 + 用户「自定义指令」设置，不含 vault 笔记内容。

---

### Release — 0.0.17

- 状态：**已发布**（2026-09-28）。
- 动作：`perf/ui-responsiveness`（10 commits + 发布准备 `774fcdc`）→ fast-forward 合并 `main` → annotated tag `0.0.17` → 推送 fork（`origin`）；tag 触发 `Release Obsidian plugin` workflow 自动发布。
- 版本文件：`manifest.json` / `package.json` = **0.0.17**；`versions.json` 增加 `"0.0.17": "1.12.3"`；`CHANGELOG.md` 写入 0.0.17 发布条目。
- 结果：CI（main push）success；Release workflow success；Release 资产 `main.js`（445,301 B）/ `manifest.json` / `styles.css`。
- 链接：https://github.com/xxxlyfy/obsidian-pi/releases/tag/0.0.17
- 备注：主 Vault（OneDrive\Obsidian）未改动，由用户自行安装；测试 Vault 已 `dev:install` 到 0.0.17。
