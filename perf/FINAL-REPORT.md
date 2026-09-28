# Pi Agent 性能修复 — 最终报告（规格 ch.14）

> 分支：`perf/ui-responsiveness`；提交：`b878862`（Step 1）→ `84e6654`（PATCH 0）→ `86819d8`（PATCH 1）→ `64976e8`（PATCH 2）→ `2d1ed3f`（PATCH 3）→ `cf45c38`（PATCH 4）→ `8bb43d5`（PATCH 5）。
> 完整过程数据与证据：`perf/PROGRESS.md`、`perf/baseline.md`、`perf/patch0-audit.md`、`perf/patch4-lifecycle-audit.md`。

## Environment

| 项 | 值 | 来源 |
| --- | --- | --- |
| Obsidian | 1.13.7（installer 1.13.7） | `obsidian version` |
| Electron | 43.3.0 | `obsidian eval` |
| Chromium | 150.0.7871.212 | `obsidian eval` |
| Pi | 0.87.1 | `pi --version` |
| Plugin | 0.0.16（`main.js` 由 `npm run build` 生成，禁止手改） | `manifest.json` |
| OS | Windows 11 专业版 10.0.26200 | `Win32_OperatingSystem` |
| 宿主 Node / Electron 内建 Node | v24.21.0 / 24.18.1 | `node --version` / `obsidian eval` |
| 测试 Vault | `C:\Users\zcooo\Desktop\3\test-vault`（专用；PATCH 0-4 语料 433 篇，PATCH 5 扩至 **10,000 篇 / 8.92 MiB**） | `seed-test-vault.mjs` |

## Baseline（PATCH 0，433 文件 / 0.48 MiB，未修改的 0.0.16）

| 指标 | 值 |
| --- | --- |
| Longest Task | **11,996 ms** |
| P95 | 1,367 ms |
| P99 | 11,996 ms |
| longtask 数量 / 总时长 | 54 / 31,105 ms（占全程 46%） |
| Heap | 41.2 → 79.9 MB（+38.7 MB） |
| Events/sec | unavailable（无计数器） |
| Markdown renders | unavailable（基线为每 delta 调 `MarkdownRenderer.render`） |
| 人工复现 | 全库健康检查（固定 prompt）67.35s、0 错误 |

## 每个 Patch

### Step 1 — 准备与 CI 基线（`b878862`）

- **Modified files**：新增 `perf/PROGRESS.md`、`perf/baseline.md`；`src/` 零改动。
- **Problem solved**：建立可复现的测试环境、CI 门禁与测量方法（GitHub fork clone、专用测试 Vault、官方 Obsidian CLI、CRLF 环境修复）。
- **Implementation summary**：`git config core.autocrlf false` 修复 CI 假红；测试 Vault `dev:install`；运行时版本采集；`obsidian eval` / `dev:errors` 验证流程固化。
- **Tests**：`npm run ci` 全绿（50 files / 282 tests）。
- **Profiler measurements**：无（PATCH 0 前）。
- **Performance result**：基线（见上表）。
- **Regression risk**：无源码改动；记录既有 bug 发现 #1（空 Vault 视图 TypeError）/ #2（Windows `cmd.exe` 多行参数截断）。

### PATCH 0 — Baseline / Runtime / Audit / Minimal Profiler（`84e6654`）

- **Modified files**：`src/shared/performance-profiler.mjs`（+6 tests）、`src/pi/events.mjs`、`src/pi/rpc-client.mjs`、`src/plugin/PiAgentPlugin.mjs`；`perf/patch0-audit.md`；`perf/tools/seed-test-vault.mjs`。
- **Problem solved**：无基线数据、无埋点，无法定位 RPC 主线程阻塞来源。
- **Implementation summary**：默认关闭的 opt-in profiler（counters/durations/maxima）；`scheduler.yield()` runtime spike（情况 A：p95 0.1ms）；events[] 迁移审计 + tool schema 四问。
- **Tests**：51 files / 288 tests。
- **Profiler measurements**：验证运行 events 12、maxDrain 6.0ms、maxEvent 5.9ms、maxJsonParse 0.3ms。
- **Performance result**：确认最大阻塞 **11,996ms**（同步 RPC drain + 每 delta Markdown）。
- **Regression risk**：发现 #2 导致 Windows 下工具模式失效（实际全量工具 + bash），跨 patch 负载需记录。

### PATCH 1 — RPC Cooperative Drain（`86819d8`）

- **Modified files**：新增 `src/pi/yield-scheduler.mjs`（+7 tests）、`src/pi/rpc-client.mjs` 有界 drain、`tests/rpc-cooperative-drain.test.mjs`（6，规格 Test A–E）。
- **Problem solved**：stdout 单批同步解析全部事件 → 11.9s 主线程不可响应。
- **Implementation summary**：每批 ≤64 events / 6ms；单 pending drain + 退出重查；`scheduler.yield()` 主路径（fallback MessageChannel / timeout）；UTF-8 半字符、半行 JSONL、generation 防陈旧、dispose 排空。
- **Tests**：53 files / 301 tests（yield 次数用注入 spy 断言，不依赖 wall-clock）。
- **Profiler measurements**：19,497 events（93.2/s）、yield 8,846（max 16.2ms）、maxDrain 63.2ms、maxEvent 63.1ms（221,914B 的 `agent_end`）。
- **Performance result**：longest **11,996 → 63ms**；longtask 54 → 3（31.1s → 0.18s）。
- **Regression risk**：预算只能在事件之间暂停，单事件成本仍可超预算；留给 PATCH 2/3。

### PATCH 2 — Event Algorithm + RunState + Retention（`64976e8`）

- **Modified files**：新增 `src/pi/run-state.mjs`（+8 tests）；`src/pi/events.mjs`（`handlePiEvent`、消除 JSON 往返、§5.7 gating）；`src/pi/runner.mjs`（三路径 RunState）；`src/ui/activity.mjs`（`toolKey`，删除 `JSON.stringify(toolArgs)`）；重写 `tests/events.test.mjs`（10）。
- **Problem solved**：per-event O(N) 扫描/复制、`JSON.stringify → JSON.parse` 往返、无界事件保留、tool 关联伪造风险。
- **Implementation summary**：RunState（fallback/final/token/compaction）、ActiveTools Map（无 id 时仅唯一匹配，不伪造）、DiagnosticRing 500、保留策略、legacy compaction 一致性断言。
- **Tests**：54 files / 312 tests；合成微基准 10k 事件 tool lookup 0.0122/0.0711ms → **0.00001ms**。
- **Profiler measurements**：18,188 events；longtask **0**；maxEvent 28.2ms；maxRunState 0.2ms（108 次捕获）；toolLookup 0.1ms；diagnostics 500 有界；retainedEvents 0。
- **Performance result**：单事件成本 63 → 28ms；RPC 路径 `maxJsonParse = 0`。
- **Regression risk**：maxDrain 仍可被单事件抬到 ~28ms；legacy 断言保留（门禁 1/3）。

### PATCH 3 — Streaming Rendering（`2d1ed3f`）

- **Modified files**：`src/ui/message-renderer.mjs`（流式管线重写）、`src/ui/PiAgentView.mjs`（回调接入/清理）、`src/ui/run-activity-state.mjs`（agent_end finalize）、`src/shared/performance-profiler.mjs`；新增 `tests/streaming-renderer.test.mjs`（9）。
- **Problem solved**：每个 delta 触发完整 `MarkdownRenderer.render` + Component 创建/卸载 + 全量 DOM 替换。
- **Implementation summary**：单真相源 `streamingAssistantContent` → rAF 合并（每帧至多一次）→ `textContent` 纯文本 + 光标；thinking 同管线；`agent_end` 取消 pending rAF → 同步 flush → 一次最终 Markdown render；滚动语义保持（用户上滚不拉回）；生命周期清理（卸载/切换/取消/结束）。
- **Tests**：55 files / 322 tests。
- **Profiler measurements**（固定 prompt）：15,636 events / 71.5s；stream 6,949 → flush 1,625（**0.23×**）；markdownRender 10（**0.14% of deltas**）；maxUiCallback 57.6ms（agent_end）；stream flush max 7.6ms / mean 2.2ms；streaming 期 longtask 0。
- **Performance result**：流式阶段主线程仅纯文本更新；最终 Markdown 一次完成（不等待下一帧）。
- **Regression risk**：agent_end 同步 finalize 产生一次性 ~57ms 回调/长任务（随最终文本大小）；final = 完整 Markdown 语义不可拆。

### PATCH 4 — Activity UI + Global Lifecycle Audit（`cf45c38`）

- **Modified files**：`src/ui/run-activity-state.mjs`（activity 合并 + 守卫）、`src/ui/PiAgentView.mjs`（run/thread generation）、`src/ui/message-renderer.mjs`（rAF 守卫）、`src/shared/performance-profiler.mjs`；新增 `tests/activity-coalescing.test.mjs`（7）、`perf/patch4-lifecycle-audit.md`。
- **Problem solved**：tool_update 状态刷新随事件线性增长；延迟回调可能更新陈旧 run/thread 的 UI。
- **Implementation summary**：`tool_update` 合并（150ms，区间 100–200ms 由数据定）；tool_start/end/error/agent_end/cancel 立即；`runGeneration`/`threadGeneration` 统一守卫 activity timer、sticky timer、streaming rAF，陈旧回调丢弃并计数；PATCH 0/1/3 资源 owner 审计。
- **Tests**：56 files / 331 tests。
- **Profiler measurements**（固定 prompt）：10,742 events / 52.6s；activityFlush 50（**0.47% of events**）；合并 30 → 11（**2.73×**）；maxActivityUpdate 0.3ms；staleCallbackPrevented 0；stream 5,323 → 1,345（0.25×）。
- **Performance result**：RPC event frequency != activity render frequency 成立；sticky UX（1200ms）不变。
- **Regression risk**：守卫为第二道防线（正常路径显式清理）；`finishCanceledRun()` 为历史遗留死代码。

### PATCH 5 — Benchmark + Performance Regression + CI（`8bb43d5`）

- **Modified files**：`src/shared/performance-profiler.mjs`（queue/heap 指标 + `markHeap`）、`src/pi/rpc-client.mjs`（`measureQueue`、对象路径 `jsonLineBytes`/`jsonParse`）、`src/ui/PiAgentView.mjs` / `src/ui/run-activity-state.mjs`（heap 标记）、`perf/tools/seed-test-vault.mjs`（`--total`）；新增 `tests/perf-synthetic.test.mjs`（5）。
- **Problem solved**：无 CI 性能回归测试、无 5,000+（规格要求，最好 10,000+）真实 Vault 基准、队列/内存不可见。
- **Implementation summary**：合成 Test A–G（A/B/D/E 沿用 PATCH 1，新增 C/F/G）；CI 轻量回归：2,000-event burst + 注入 FakeYieldScheduler，断言 0 丢失/重复/乱序、yield ≥ 下限、单批 ≤40（无无限同步 drain）；10,000 篇语料基准。
- **Tests**：57 files / 337 tests。
- **Profiler measurements**（10,000 篇 / 8.92 MiB，固定 prompt）：9,369 events / **57.9s**；longtask **3 / 175ms**（52ms 起点 context、63ms agent_end finalize、60ms 完成 render）；**P95/P99 = 63/63ms**；max queue **44 行 / 98,052 B**；largest JSON line 98,051 B；max JSON.parse **0.4ms**；max normalize 61.4ms；stream 4,307 → 1,102（0.26×）；markdown 10；activity 74（41 → 12，3.4×）；heap 100.8 → 峰值 135.7（+36.6MB）→ 90.8 MiB；运行中 rAF mean 6.9ms / max 7.1ms。
- **Performance result**：高负载下无持续数百毫秒/数秒的无界同步 processing；UI 保持可交互（§16）。
- **Regression risk**：63ms 边界渲染按 §9 属「serious（50–200ms）」，为一次性且随最终文本增长；`yieldCount 0` 属负载特性（队列未超批预算），burst 由 CI 注入测试覆盖。

## Before / After

| 指标 | Baseline（PATCH 0） | PATCH 5（10,000 文件） | 改善 |
| --- | --- | --- | --- |
| Longest main-thread task | 11,996 ms | **63 ms** | ~190× |
| P95 task duration | 1,367 ms | **63 ms** | ~22× |
| P99 task duration | 11,996 ms | **63 ms** | ~190× |
| Max drain duration | 无界（单批全量） | **62 ms**（含 61ms 单事件） | 有界 |
| Max JSON.parse | 1.9 ms（PATCH 1，往返） | **0.4 ms**（单次 parse；PATCH 2 已消除往返） | 消除重复解析 |
| RPC event throughput | unavailable | **161.8/s**（run 内；PATCH 2 记录 118.2/s） | 可测且稳定 |
| Stream flush count | 每 delta 1 次 Markdown | **1,102**（4,307 deltas 的 0.26×） | 线性 → 合并 |
| Markdown render count | 每 delta + 历史消息 | **10**（0.23% of deltas） | 线性 → 常数级 |
| Activity flush count | 随事件线性 | **74**（events 的 0.7%；合并 41 → 12） | 线性 → 合并 |
| Heap growth | +38.7 MB（433 文件） | **峰值 +36.6 MB → 回落到低于起点**（10k 文件） | 无持续增长 |
| longtask 数 / 总时长 | 54 / 31,105 ms | **3 / 175 ms**（全部首尾边界） | 持续阻塞 → 一次性边界 |

## Conditional Patch

### PATCH 6 — Application / Pipe Backpressure：**Not Implemented**

进入条件（规格 ch.10）：backlog 持续增长 / queue bytes 持续增长 / renderer 内存压力明显 / Pi 输出速度持续远高于消费速度。PATCH 5 真实基准数据：

- max queue depth **44 行**、max queue bytes **98,052 B**（约 96 KiB），未持续增长；运行期间队列峰值低于 64-event 批预算，drain 实时消费（未触发 yield，5,233 批 mean 0.064ms）。
- renderer longtask 仅 **3 / 175ms**，全部在运行首尾（起点 context、finalize、完成 render）；57.9s 工具+流式期间 **0 longtask**。
- heap 峰值 +36.6MB 后回落至 90.8MB（低于起点 100.8MB），无内存压力迹象。
- Pi 输出 ~162 events/s，renderer 单事件 mean 0.024ms、单批 mean 0.064ms，消费能力远高于输出速度。

三项目标指标均已达标 → 按规格 §10.3 **不实施 PATCH 6**（不引入 application queue，也不需要 `stdout.pause()/resume()` 的 liveness 改造）。

### PATCH 7 — Worker Evaluation：**Evaluated: Yes / Implemented: No**

进入条件（规格 ch.11）：`JSON.parse` 或 normalization 经常单次 >16ms（甚至 >50ms）。PATCH 5 真实基准数据：

- max JSON.parse **0.4ms**（mean 0.006ms / 9,374 次）——远低于 16ms 门槛。
- normalization max 61.4ms / mean 0.024ms：唯一 >16ms 的样本是 `agent_end` 的 finalize（**DOM 绑定**的最终 Markdown 渲染，规格 §11.1 明确 Worker 禁止 DOM/MarkdownRenderer/View/插件状态变更），无法也不应下放。
- 纯事件归一化路径（capture/normalize/state 更新）在 9,369 events 下 total 228ms、mean 0.024ms，无单次 >1ms 的常态开销。

进入条件不满足，因此未做 Worker 全成本（structured clone + 往返）对比；按规格 **不实施 PATCH 7**。

## 最终成功标准对照（规格 §16）

| 标准 | 结果 |
| --- | --- |
| Pi 可以高吞吐工作 | ✅ 10,000 文件扫描 + 15 次 bash，57.9s 完成 |
| RPC 可以高吞吐传输 | ✅ 9,369 events / 57.9s（~162/s），队列有界（44 行 / 96 KiB） |
| Renderer 不会同步无限消费 RPC events | ✅ 有界 drain（64 events / 6ms 预算）+ 单事件成本 ≤63ms 且仅边界 |
| UI Rendering 不跟 RPC event frequency 线性增长 | ✅ stream flush 0.26× deltas、markdown 0.23%、activity 0.7% |
| 高强度全库健康检查期间 Obsidian 保持可交互 | ✅ 运行中 rAF mean 6.9ms / max 7.1ms；边界外 0 longtask |
| 不改变 RPC protocol / ordering / correlation / cancellation / compaction / session persistence / tool 能力 / 最终答案 | ✅ 全部约束由回归测试与真实运行覆盖（0 丢失/重复/乱序、取消/切换/compaction 一致性测试） |

## 遗留事项（不在本任务范围）

1. **发现 #1**：空 Vault 未配置模型时打开 Pi 视图抛 `e.startsWith is not a function`（`src/ui/run-settings.mjs`），建议单独 issue。
2. **发现 #2**：Windows `cmd.exe /c` 多行参数截断导致 `--tools` 等丢失、工具模式失效，建议单独 issue（修法方向已记录在 `perf/baseline.md`）。
3. legacy compaction 断言门禁已达 **3/3**（0 告警），断言代码可后续清理（归属 PATCH 2 退出条件）。
4. `finishCanceledRun()` 无调用方（历史遗留），可后续清理。
5. 63ms 边界渲染（finalize/完成 render）为一次性成本；若未来改变「final = 完整 Markdown」语义可继续优化。
