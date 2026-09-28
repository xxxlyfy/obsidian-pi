# Baseline — 环境与 CI

本文件记录性能修复前的运行环境与 CI 基线，供后续 PATCH 前后对比。

## Environment（规格 §3.1）

| 项                   | 值                                                                                                  | 获取方式                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Obsidian version     | **1.13.7**（运行时确认；installer 1.13.7）                                                          | `obsidian version`（官方 CLI，在运行实例中执行）                                                                               |
| Electron version     | **43.3.0**（运行时确认）                                                                            | `obsidian eval` → `process.versions.electron`                                                                                  |
| Chromium version     | **150.0.7871.212**（运行时确认）                                                                    | `obsidian eval` → `process.versions.chrome`                                                                                    |
| Node/runtime（宿主） | v24.21.0（npm 11.19.0；git 2.55.0.windows.3）                                                       | `node --version` / `npm --version` / `git --version`                                                                           |
| Electron 内建 Node   | **24.18.1**（运行时确认）                                                                           | `obsidian eval` → `process.versions.node`                                                                                      |
| Pi version           | 0.87.1                                                                                              | `pi --version`                                                                                                                 |
| Plugin version       | 0.0.16                                                                                              | `manifest.json` / `package.json`                                                                                               |
| OS                   | Windows 11 专业版，10.0.26200                                                                       | `Win32_OperatingSystem`                                                                                                        |
| 测试 Vault           | `C:\Users\zcooo\Desktop\3\test-vault`（新建专用；已由 Obsidian 打开，pi-agent 0.0.16 已启用并验证） | 主 Vault = `C:\Users\zcooo\OneDrive\Obsidian`（`obsidian.json` 唯一注册，禁用）；dev:install + sha256 校验；见「人工验证记录」 |

### 运行时采集结果（2026-09-28，已全部完成）

1. Obsidian：**1.13.7** — `obsidian version` 输出 `1.13.7 (installer 1.13.7)`。
2. Electron：**43.3.0** — `obsidian eval` → `process.versions.electron`。
3. Chromium：**150.0.7871.212** — `obsidian eval` → `process.versions.chrome`。
4. Electron 内建 Node：**24.18.1** — `obsidian eval` → `process.versions.node`。
5. 测试 Vault：`C:\Users\zcooo\Desktop\3\test-vault`（新建专用；主 Vault `OneDrive\Obsidian` 已排除）。

> 与磁盘 provisional 值一致（1.13.7 / 43.3.0 / 150.0.7871.212）；宿主 Node v24.21.0 与 Electron 内建 Node 24.18.1 是两个不同运行时，不要混淆。

## 仓库与分支

- 仓库：`C:\Users\zcooo\Desktop\3\obsidian-pi`（fork origin `https://github.com/xxxlyfy/obsidian-pi.git`）
- 分支：`perf/ui-responsiveness`，基线 commit `dc1031cd33eccca1704d14fb576f6bfa634b7ea0`（main 与 origin/main 同步）
- clone 路线：`git clone https://github.com/xxxlyfy/obsidian-pi.git`（未使用 `Desktop\2` 复制路线）

## Dev 安装（测试 Vault）

- 测试 Vault：`C:\Users\zcooo\Desktop\3\test-vault`（专用，本地磁盘，不涉 OneDrive）。
- 命令：`npm run dev:install -- <vault>\.obsidian\plugins\pi-agent`；行为是把 `main.js` / `manifest.json` / `styles.css` **复制**（非 symlink）到目标目录，**每次 `npm run build` 后必须重跑**。
- 首次安装校验（2026-09-28）：三文件 sha256 与仓库一致 — main.js `7820055959950c1354d84560149a421f9e26a274826a0087a4d0ea67edd122f2`、manifest.json `f338c41525bbf1001edb9eeca2ab5cd1f3c3a0e1a1dd7ec83346170d3fedcb40`、styles.css `ed692082aa35758d599494b653428913ce565b1f9c62c4a5aff39011b974ac78`。
- 预置 `community-plugins.json = ["pi-agent"]`；打开后关闭限制模式即自动加载（本机已通过 CLI 完成，见「人工验证记录」）。

## 人工验证记录（Step 1，2026-09-28）

- 控制方式：官方 Obsidian CLI（`obsidian`，需运行中的实例；本机由 `obsidian.json` 的 `"cli":true` 启用）。该版本 CLI **不支持直接打开任意文件夹为 Vault**，采用「注册到 `obsidian.json`（`open:true`）+ 启动」方式（原文件备份 `%TEMP%\opencode\obsidian.json.bak`）。后续步骤可继续用 `obsidian eval` / `dev:errors` / `dev:console` / `dev:screenshot` 自动取证。
- 限制模式：关闭（`obsidian plugins:restrict off`）；`pi-agent` 0.0.16 自动加载。
- 加载验证：`plugin:reload id=pi-agent` → `dev:errors` 无错误；`dev:console`（需先 `dev:debug on`）在配置模型后无任何输出。
- 冒烟：`pi-agent:check-pi-installation` 正常；`pi-agent:open-pi` 打开视图；配置模型后 3 个运行控件（Model / Think / Tool mode）+ Send 按钮齐全。
- 测试 Vault 已配置：`settings.model = "deepseek/deepseek-flash"`（= Pi 当前 effective model；模型目录共 2 个）。
- 证据截图：`%TEMP%\opencode\test-vault-pi-agent.png`（半初始化状态）、`%TEMP%\opencode\test-vault-pi-agent-clean.png`（配置模型后完整状态）。
- 验证后状态：Obsidian 当前停在测试 Vault（主 Vault 未打开）；如需回主 Vault，用仓库切换器即可。

### 发现 #1（既有 bug，2026-09-28 已在本地修复）

> 修复记录：`perf/PROGRESS.md`「Local fixes」；以下为发现时的原始记录。

- **现象**：全新 Vault 未配置模型时打开 Pi 视图，核心日志 `[ERROR] Failed to open view`，`message: "e.startsWith is not a function"`；视图半初始化（无 Send 按钮、消息区未渲染、composer 观察器未启动）。
- **根因**：`src/ui/run-settings.mjs:78-79` —— 无模型时 `getModelProvider()` 返回 `""`，`{ provider: "" }` 让 `icon?.provider` 为假，整个对象被当作图标名传给 `setIcon()`，Obsidian 核心对它调用 `.startsWith` 抛 `TypeError`；核心在 `view.open()` 处 catch 并只打 `console.error`。触发链：`PiAgentView.renderChatView → RunSettingsControls.render → populate → addPickerSetting`。0.0.16 release 产物同样存在（本仓库 `main.js` 与 release 字节一致）。
- **规避**：在测试 Vault 配置任意模型（已设 `deepseek/deepseek-flash`）后不再触发。
- **处置**：Step 1 约定 `src/` 零改动，本次不修；建议后续单独开 issue（不在性能 PATCH 范围，除非规格另有要求）。

### 发现 #2（Windows 参数截断，既有 bug，2026-09-28 已在本地修复）

> 修复记录：`perf/PROGRESS.md`「Local fixes」；以下为发现时的原始记录。

- **现象**：Windows 下插件经 `cmd.exe /d /s /c` 启动 `pi.cmd`（`src/pi/environment.mjs:76-120`）。`--append-system-prompt` 的插件指令是多行文本，cmd 按换行把 `/c` 字符串拆成多条命令，**只有第一个换行前的内容**到达子进程（实测 node 侧命令行止于 `--append-system-prompt "# Pi Agent`）；位于指令之后的参数全部丢失：`--no-skills`、`--skill`、**`--tools`**。
- **后果**：
  1. 插件注入的 system 指令被截断（session `addendum` 段实测只剩 `<addendum>\n# Pi Agent\n</addendum>`）。
  2. **工具模式在 Windows 失效**：read-only 会话实测仍暴露并执行 `bash`（PATCH 0 基线 run 12/12 次工具调用均为 bash）；chat/edit 模式同样不会生效。
  3. `includeDefaultSkills` 与附加 skill 路径设置同样失效。
- **验证**：绕过 cmd（用插件同款 RPC 客户端直连、不带多行参数）传同一 `--tools read,grep,find,ls`，Pi 正确只暴露 read/grep/find/ls；`--tools read` 亦正常 → 问题在参数传递链，不在 Pi。
- **性质**：0.0.16 release 同样存在（`main.js` 与 release 字节一致）；影响 Windows 的正确性/安全语义（“read-only 不执行 shell”承诺不成立），与本次性能改动无关。
- **处置**：本次不改（性能 PATCH 范围外）；建议单独开 issue。修法方向：避免用 cmd 传多行参数（用 `pi.exe`/`node bundle/cli.js` 直连），或利用 Pi 的 `--append-system-prompt <file>` 支持把指令写入临时文件。
- **对性能工作的影响**：PATCH 0 基线 run 实际以全量工具执行（agent 用 bash 扫描全库），工作负载仍有效，但 PATCH 5 基准与跨平台对比必须记录该差异。

## CI 基线（修改前，2026-09-28）

命令：`npm ci` → `npm run ci`

- `npm ci`：**通过**。added 370 packages, audited 371 packages，约 5.8s。有 npm audit 提示 7 vulnerabilities（3 moderate / 4 high，既有依赖问题，未处理）。
- `npm run ci`：**全绿**，墙钟约 15.3s。实际执行链：
  `build` → `build:check` → `format:check` → `lint` → `lint:obsidian:errors` → `typecheck` → `test` → `version:check`
  - `npm run build`：Built main.js from src/main.js.
  - `npm run build:check`：main.js is up to date.
  - `npm test`：**50 test files / 282 tests passed**（vitest Duration 1.95s；`rpc-integration.test.mjs` 最慢，约 786ms）。
  - `npm run version:check`：Version 0.0.16 is valid.
- `main.js`（生成的 release 入口）：
  - size 419205 bytes
  - sha256 `7820055959950c1354d84560149a421f9e26a274826a0087a4d0ea67edd122f2`
  - 未手改；由 `npm run build` 生成，`build:check` 确认与 `src/` 一致。
- 上游 CI 配置（`.github/workflows/ci.yml`）：ubuntu-latest + Node 24 + `npm ci` + `npm run ci`，与本地门禁一致。

## 性能基线（PATCH 0，未修改 0.0.16）

> 测量时间 2026-09-28；被测版本 = release 0.0.16（`main.js` 与 release 字节一致，未含 profiler）。
> 测量方式：官方 Obsidian CLI + `obsidian eval`（PerformanceObserver `longtask`），窗口前台可见（CDP 焦点模拟防后台节流）。

### 工作负载（全库健康检查）

- 测试语料：`perf/tools/seed-test-vault.mjs`（固定种子 20260928）生成 433 篇 Markdown、505,331 字节（0.48 MiB）：Notes/Area-0..7 ×350、Hubs ×15、Longform ×8、Daily ×60。生成后需 `obsidian reload` 使索引完整（实测 watcher 曾滞后于批量写入）。
- Prompt（原文固定，后续 patch 复用）：
  > 请对当前 vault 执行一次完整的全库健康检查：扫描所有 Markdown 笔记，统计笔记数量、目录结构、标签分布、链接与孤立笔记情况，找出断链、无标签笔记、重复标题等问题，最后输出一份简明的健康检查报告。请覆盖整个 vault，不要抽样。
- 工具模式：read-only（但 Windows 参数截断 bug 导致实际为全量工具，见「发现 #2」；agent 实际用 bash 扫描全库）。

### 测量结果（1 次运行）

| 指标                                           | 值                                                              |
| ---------------------------------------------- | --------------------------------------------------------------- |
| health-check total duration                    | **67,352 ms**（`runPrompt` 全程；session 时间戳跨度 63,169 ms） |
| longest main-thread task                       | **11,996 ms**                                                   |
| P95 task duration                              | 1,367 ms                                                        |
| P99 task duration                              | 11,996 ms（= max）                                              |
| 最长连续同步执行时间                           | 11,996 ms（定义：longtask 最大时长 = 主线程连续不可响应上限）   |
| longtask 数量（≥50ms）                         | 54                                                              |
| longtask 总时长                                | 31,105 ms（占全程约 46%）                                       |
| 平均 longtask                                  | 576 ms                                                          |
| JS heap（`performance.memory.usedJSHeapSize`） | 41.2 MB → 79.9 MB（+38.7 MB）                                   |
| CDP `Runtime.getHeapUsage`                     | 运行前 used 28.3 MB → 运行后 used 23.5 MB（空闲 GC 后）         |

### 同轮事件统计（session JSONL）

| 指标                                        | 值                                |
| ------------------------------------------- | --------------------------------- |
| tool 调用 / toolResult                      | 12 / 12（全部 `bash`）            |
| assistant 消息 / thinking / toolCall / text | 13 / 13 / 12 / 17                 |
| RPC events/sec                              | unavailable（未修改版本无计数器） |
| maximum event burst                         | unavailable                       |
| streaming delta count                       | unavailable                       |
| Markdown render count                       | unavailable                       |

> `unavailable` 项自 PATCH 0 profiler 落地起可测（已埋点），后续 patch 用同一 workload 对比。

### Profiler 验证运行（PATCH 0 代码，短 prompt）

- 启用方式：`app.plugins.plugins["pi-agent"].profiler.enabled = true`；结束已置回 `false`；`dev:errors` 无错误。
- `snapshot().metrics`：`rpcEventsProcessed: 12`、`rpcEventsPerSecond: 5.5`、`maxDrainDuration: 6.0 ms`、`maxEventDuration: 5.9 ms`、`maxJsonParseDuration: 0.3 ms`、`maxJsonLineBytes: 60,691`、`yieldCount: 0`、`yieldLatency: 0`（PATCH 1 填充）。

## Yield Runtime Spike（PATCH 0 §3.3）

> 环境：Obsidian 1.13.7 / Electron 43.3.0 / Chromium 150.0.7871.212；窗口前台（CDP `Emulation.setFocusEmulationEnabled`），N=50。

| 机制                | availability                                           | min / median / p95 / max (ms) | 结论                      |
| ------------------- | ------------------------------------------------------ | ----------------------------- | ------------------------- |
| `scheduler.yield()` | ✅ `typeof globalThis.scheduler?.yield === "function"` | 0 / 0 / 0.1 / 0.1             | **首选**                  |
| `MessageChannel`    | ✅                                                     | 0 / 0 / 0.1 / 1.8             | fallback                  |
| `setTimeout(0)`     | ✅                                                     | 0 / 15.4 / 16.7 / 17.1        | 最终 fallback（明显更差） |

优先级验证：`scheduler.yield()` 的续体先于此前入队的 MessageChannel 任务执行（实测顺序 `yield>message`），priority continuation 可用。

**结论（规格 §3.3 情况 A）**：`scheduler.yield()` 可用且实测行为可靠 → PATCH 1 的 `YieldScheduler` 主路径使用 `scheduler.yield()`，`MessageChannel` 为 fallback，`setTimeout(0)` 为最终 fallback；batch interval 验收标准按 scheduler.yield 实测延迟制定。

> 操作注意：Obsidian 窗口被遮挡/最小化时 Chromium 会节流定时器（实测链式 `setTimeout` 几乎停滞；`scheduler.yield` 与 `MessageChannel` 不受影响）。后续所有浏览器内测量必须保持窗口前台或开启焦点模拟。

## PATCH 1 验证运行（Cooperative Drain）

> 同一测试 Vault、同一 prompt（全库健康检查）。agent 行为存在模型随机性：本轮 tool 调用 23 次（基线 12 次）、RPC 事件 **19,497** 个，实际负载明显更高。

| 指标                        | PATCH 0 基线（未修改）     | PATCH 1                                | 说明                                                                            |
| --------------------------- | -------------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| health-check total duration | 67,352 ms（12 tool calls） | 209,142 ms（23 tool calls）            | 负载不同，墙钟不可直接比较                                                      |
| longest main-thread task    | **11,996 ms**              | **63 ms**                              | 关键指标                                                                        |
| longtask 数量（≥50ms）      | 54                         | **3**                                  |                                                                                 |
| longtask 总时长             | 31,105 ms                  | **176 ms**                             |                                                                                 |
| P95 / P99 task duration     | 1,367 / 11,996 ms          | 63 / 63 ms                             |                                                                                 |
| RPC events processed        | unavailable（未埋点）      | 19,497                                 |                                                                                 |
| RPC events/sec              | —                          | 93.2                                   |                                                                                 |
| yieldCount                  | —                          | 8,846                                  | 每 ~2.2 事件一次（单事件均 7.1ms，批次常为 1–2 事件）                           |
| yieldLatency（max / mean）  | —                          | 16.2 / 0.43 ms                         |                                                                                 |
| maxDrainDuration            | —                          | 63.2 ms（预算 6ms）                    | 超预算原因：预算只能在**事件之间**暂停；单条 `agent_end`（221,914B）处理占 63ms |
| maxEventDuration            | —                          | 63.1 ms                                | 同上；单事件成本是 PATCH 2/3 的目标                                             |
| maxJsonParseDuration        | —                          | 1.9 ms                                 |                                                                                 |
| maxJsonLineBytes            | —                          | 221,914                                |                                                                                 |
| 错误                        | 0                          | 0（`dev:errors` / `dev:console` 均空） |                                                                                 |

结论：主线程最长阻塞从 11.9s 级降到 **63ms 级**，且是在更高事件负载下取得；预算因单事件成本高而常退化为 1–2 事件/批，配合 `scheduler.yield`（Chromium 150）仍保持可响应。单事件处理成本留给 PATCH 2（RunState/coalescing）与 PATCH 3（streaming rendering）。

## PATCH 2 验证运行（Event Algorithm + RunState + Retention）

> 同一测试 Vault、同一 prompt。本轮 18,188 events（PATCH 1：19,497）。

| 指标                        | PATCH 1         | PATCH 2                                      | 说明                               |
| --------------------------- | --------------- | -------------------------------------------- | ---------------------------------- |
| longest main-thread task    | 63 ms           | **无 ≥50ms 任务（longtask 0）**              |                                    |
| longtask 数量 / 总时长      | 3 / 176 ms      | **0 / 0 ms**                                 |                                    |
| maxEventDuration            | 63.1 ms         | **28.2 ms**                                  | 单事件处理（含 UI 回调）           |
| maxNormalizeDuration        | —（未埋点）     | 28.2 ms（mean 3.3 ms）                       | 事件归一化（排除 parse）           |
| maxJsonParseDuration        | 1.9 ms          | **0**（RPC 路径不再 parse）                  | §5.3 往返消除生效                  |
| maxJsonLineBytes            | 221,914         | 0（RPC 对象路径）                            |                                    |
| maxRunStateDuration         | —               | **0.2 ms**（mean 0.009；108 次捕获）         | §5.7 gating：18k 事件仅 108 次捕获 |
| maxToolLookupDuration       | —               | **0.1 ms**（mean 0.008；112 次）             | ActiveTools Map                    |
| diagnosticBufferSize（max） | —               | 500（有界环形，饱和）                        | §5.9                               |
| retainedEvents（max）       | 无界（≈事件数） | **0**（本轮无 compaction 事件）              | §5.8；仅保留 compaction end 供断言 |
| yieldCount / max latency    | 8,846 / 16.2 ms | 5,479 / 3.6 ms（mean 0.23）                  |                                    |
| rpcEventsProcessed          | 19,497          | 18,188（118.2 events/sec）                   |                                    |
| 错误 / 告警                 | 0               | 0（无 compaction 断言告警、无 tool id 告警） | legacy 断言 gate：1/3              |

### tool lookup 前后对比（合成微基准，Node 24，500 次均值）

| 事件数 | 旧实现 best（命中最近） | 旧实现 worst（命中最早） | 新实现 Map.get |
| ------ | ----------------------- | ------------------------ | -------------- |
| 100    | 0.0004 ms               | 0.0017 ms                | 0.00004 ms     |
| 1,000  | 0.0021 ms               | 0.0076 ms                | 0.00003 ms     |
| 10,000 | **0.0122 ms**           | **0.0711 ms**            | **0.00001 ms** |

> 旧实现每次还额外执行 `events.slice().reverse()`（O(N) 复制、每次数十 KB 级分配，10k 事件时）；新实现 O(1) 且无分配。
> legacy compaction 断言（§5.6）仍在运行：需累计 **3 次真实全库健康检查、0 次告警**后才可删除，当前 **1/3**。

## PATCH 3 验证运行（Streaming Rendering）

> 同一测试 Vault、同一固定 prompt（全库健康检查）；profiler 受控运行；窗口前台。本轮 RPC events **15,636**（run 墙钟 71.5s；agent 用 14 次 bash、未写 vault，session `1790597596178-pnwzdy0tfqe.jsonl`）。运行结束后 profiler 又空闲约 76s 才取快照，`rpcEventsPerSecond` 快照值 105.9 因此被低估；按 run 墙钟约为 219/s。

| 指标                                    | PATCH 2                 | PATCH 3                                                       | 说明                                                                                |
| --------------------------------------- | ----------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| longest main-thread task                | 0（无 ≥50ms）           | streaming 阶段 **0**；结束边界 59ms + 92ms                    | 均为最终 Markdown 渲染（随最终文本大小增长）                                        |
| longtask 数量 / 总时长                  | 0 / 0                   | streaming **0**；结束边界 2 / 151ms                           | 本轮最终文本：thinking 18,723 + answer 3,995 字符                                   |
| streamDeltaCount（新增）                | unavailable             | **6,949**                                                     | text + thinking delta                                                               |
| streamFlushCount（新增）                | unavailable             | **1,625**                                                     | **0.23× delta**，4.28 delta/flush                                                   |
| markdownRenderCount（新增）             | 每 delta 1 次（未埋点） | **10**                                                        | **0.14% of delta**；运行中长文本流式期保持 1（仅用户消息）                          |
| maxUiCallbackDuration（新增）           | —                       | **57.6ms**（agent_end finalize；mean **0.011ms**，17,777 次） | 唯一 >1ms 的回调                                                                    |
| maxStreamFlushDuration（新增）          | —                       | **7.6ms**（mean 2.2ms，1,625 次，合计 3.57s）                 | 每帧纯文本更新 + 滚动                                                               |
| maxEventDuration / maxNormalizeDuration | 28.2 / 28.2ms           | **57.6 / 57.6ms**                                             | agent_end 同步 finalize（§6.4 要求）                                                |
| maxDrainDuration                        | —                       | 58.9ms                                                        | 预算只能事件间暂停；单事件成本主导                                                  |
| maxRunStateDuration                     | 0.2ms                   | 0.1ms（78 captures）                                          | §5.7 gating                                                                         |
| maxToolLookupDuration                   | 0.1ms                   | 0.1ms                                                         |                                                                                     |
| diagnosticBufferSize / retainedEvents   | 500 / 0                 | 500 / 0                                                       |                                                                                     |
| maxJsonParseDuration / maxJsonLineBytes | 0 / 0                   | 0 / 0                                                         | RPC 对象路径                                                                        |
| yieldCount / yieldLatency               | 5,479 / 3.6ms           | **0 / 0**                                                     | 本轮 stdout 批均 ~1.85 事件、批后无遗留（`hasDrainWork=false`）；调度器未变，非回归 |
| compaction 断言告警                     | 0                       | 0（counters 无 `compactionAssertionWarnings`）                | legacy gate：1/3 → **3/3**                                                          |
| 错误 / 告警                             | 0                       | 0（`dev:errors` 空）                                          |                                                                                     |

### 行为验证（规格 §12.3，2026-09-28，测试 Vault）

| 场景                  | 验证结果                                                                                                                                | 证据                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| streaming 阶段 DOM    | 回答/思考均为纯文本：`.pi-agent-message-content-streaming` 内无 `.markdown-rendered`（运行中 `markdownRenderCount` 保持 1，仅用户消息） | eval 采样（run A/E）          |
| final answer          | 完成后 `.pi-agent-message-answer.markdown-rendered`，无 typing cursor、无 streaming 容器残留                                            | run A/E                       |
| thinking              | 流式纯文本、无 `markdown-rendered`；完成后 `details .pi-agent-thinking-content.markdown-rendered`                                       | run A                         |
| auto-scroll           | stick=true 时 `scrollTop == scrollHeight − clientHeight`（实测 6374/6374）                                                              | run B（10,764 字符回答）      |
| manual scroll         | 上滚后 `stickToBottom=false`，后续 delta 不再拉回（保持 scrollTop 0）；最终 render 后仍为 0                                             | run B                         |
| thread switching      | 切到新对话：pending rAF 取消、streaming 状态清空；切回运行中线程：streamingEl + cursor 恢复、无错误；完成后消息完整（7,734 字符）       | run D                         |
| cancellation          | cancel 后 running=false；`streamingAssistantContent/ThinkingContent`、dirty 标记、rAF 句柄、`activeRuns` 全部清零，无 DOM 残留          | run C（全库 prompt 中途取消） |
| agent_end             | 同步 finalize（longtask 位于 `last.createdAt` 前 65ms 与 0ms）；activity 立即清空                                                       | run D 时间戳关联              |
| final Markdown render | 渲染发生在 agent_end（59ms longtask）与完成路径（92ms longtask），均不等待下一帧                                                        | run E                         |

- 证据截图：`%TEMP%\opencode\patch3-final.png`（运行结束后的 Pi 面板最终状态）。
- 说明：`window.__patch3` 的 longtask observer 在多次运行间被重复注册，因此同一 longtask 会重复记录；上表已按 epoch/duration 去重。

## PATCH 4 验证运行（Activity UI + Global Lifecycle Audit）

> 同一测试 Vault、同一固定 prompt（全库健康检查）；profiler 受控运行；窗口前台。本轮 RPC events **10,742**，run 墙钟 52.6s（session 记于测试 Vault `pi-sessions`）。另有一次短运行（8,716 events）作交叉验证。

| 指标                                | PATCH 3               | PATCH 4                                    | 说明                                                        |
| ----------------------------------- | --------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| RPC events / run 墙钟               | 15,636 / 71.5s        | 10,742 / 52.6s                             | 工作负载随机波动                                            |
| activityFlushCount（新增）          | —                     | **50**                                     | 活动 UI 实际应用次数 = RPC events 的 **0.47%**（§7.2 目标） |
| activityCoalescedEvents（新增）     | —                     | **30**                                     | 被合并的 tool_update 数（0.57/s）                           |
| activityCoalescedFlushes（新增）    | —                     | **11**                                     | 合并倍率 **2.73 events/flush**                              |
| maxActivityUpdateDuration（新增）   | —                     | **0.3ms**（mean 0.086ms；50 次合计 4.3ms） | 活动 DOM 更新 + 回退 renderMessages                         |
| staleCallbackPrevented（新增）      | —                     | **0**                                      | 正常路径先显式清理；陈旧场景由单测强制触发并计数            |
| streamDeltaCount → streamFlushCount | 6,949 → 1,625         | 5,323 → 1,345（0.25×）                     | PATCH 3 路径回归正常                                        |
| markdownRenderCount                 | 10                    | 10                                         |                                                             |
| maxUiCallbackDuration               | 57.6ms                | 35.0ms（mean 0.013ms / 12,154 次）         | 仍为 agent_end finalize                                     |
| maxStreamFlushDuration              | 7.6ms                 | 4.2ms（mean 1.78ms）                       |                                                             |
| longtask                            | 2（结束边界 59/92ms） | 1（完成路径整线程 render 60ms）            | 本轮最终文本较小（thinking 13.4k + answer 2.7k）            |
| yieldCount / compaction 告警 / 错误 | 0 / 0 / 0             | 0 / 0 / 0                                  | `dev:errors` 空                                             |

### 合并窗口决策（§7.1「最终窗口根据 profiler 数据决定」）

- 初始实验窗口：**150ms**（规格区间 100–200ms 的中值）。
- 数据：tool_update 仅 30 次 / 52.6s（0.57/s），合并倍率 2.73；`maxActivityUpdateDuration` 0.3ms——即使逐条更新成本也极低，窗口的价值在吸收突发与限制标签抖动，而非降本。
- 决策：**最终保持 150ms**。理由：突发合并实测 ~2.7×；标签延迟 ≤150ms 不可感知；sticky UX `ACTIVITY_STICKY_MS = 1200` 未改；100ms 减少合并收益、200ms 只增加延迟，均无数据支持。

### 运行时观察

- 运行中 30s 采样：RPC events 6,655 vs 活动刷新 53 + 合并 24 → 「RPC event frequency != activity render frequency」成立。
- 立即事件保持即时：tool_start / tool_end / error（含 compaction failed）/ agent_end / cancel；tool_update 只更新 ActiveTools 状态并调度合并窗口。
- `plugin:disable` → `plugin:enable` → `plugin:reload` 冒烟：`dev:errors` 空；`onunload` → `disposeThreadRunners()` → `PiRpcClient.dispose()`（含 `YieldScheduler.dispose()`）路径正常。
- 生命周期审计全文：`perf/patch4-lifecycle-audit.md`。

## PATCH 5 真实 Vault Benchmark（10,000 文件，规格 §8.4）

> 执行时间 2026-09-28；语料：`perf/tools/seed-test-vault.mjs <vault> --total=10000` → **10,000 篇 Markdown / 8.92 MiB**（Notes/Area-0..7 ×9,917 + Hubs 15 + Longform 8 + Daily 60）；`obsidian reload` 后 `app.vault.getMarkdownFiles() = 10000`。固定 prompt（全库健康检查）；profiler + 1 Hz 外部 heap 采样 + longtask observer；窗口前台。本轮 9,369 RPC events、15 次 bash tool 调用、run 墙钟 **57.9s**（run 内 ≈161.8 events/s；快照窗口 125.3/s）。

| 指标                            | PATCH 0（433 文件）     | PATCH 5（10,000 文件）                                                                       | 说明                                                                                        |
| ------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| total duration                  | 67.4s                   | **57.9s**                                                                                    | agent 用时；模型行为随机                                                                    |
| longest main-thread task        | 11,996ms                | **63ms**                                                                                     | 3 个 ≥50ms 任务全部在运行首尾                                                               |
| longtask count / total          | 54 / 31,105ms           | **3 / 175ms**                                                                                | 52ms 起点 context 构建、63ms agent_end finalize、60ms 完成整线程 render                     |
| P95 / P99 task                  | 1,367 / 11,996ms        | **63 / 63ms**                                                                                |                                                                                             |
| RPC events                      | unavailable             | **9,369**                                                                                    |                                                                                             |
| max queue depth / bytes（新增） | —                       | **44 行 / 98,052 B**                                                                         | 未超 64-event 批预算                                                                        |
| largest JSON line（新增）       | unavailable             | **98,051 B**                                                                                 | 对象路径 `jsonLineBytes` 埋点                                                               |
| max JSON.parse（新增对象路径）  | unavailable             | **0.4ms**（mean 0.006ms，9,374 次）                                                          | 单次 parse                                                                                  |
| max normalization               | —                       | **61.4ms**（mean 0.024ms）                                                                   | = agent_end finalize                                                                        |
| max drain batch                 | —                       | **62ms**（mean 0.064ms，5,233 批）                                                           | 单事件成本主导                                                                              |
| stream delta → flush            | —                       | **4,307 → 1,102（0.26×）**                                                                   |                                                                                             |
| markdown render                 | 基线每 delta 1 次       | **10（0.23% of deltas）**                                                                    |                                                                                             |
| activity flush                  | —                       | **74**；合并 41 events → 12 flushes（3.4×）                                                  | maxActivityUpdate 0.2ms                                                                     |
| max UI callback                 | 基线最长任务级          | **61.2ms**（agent_end；mean 0.0146ms，11,355 次）                                            |                                                                                             |
| stream flush max / mean         | —                       | **3.9ms / 1.41ms**                                                                           | 每帧纯文本更新                                                                              |
| yieldCount / latency            | —                       | 0 / 0                                                                                        | 队列峰值 44 < 64 批预算，未触发 yield；burst 场景由 CI 测试覆盖                             |
| heap first → peak → last        | 41.2→79.9MB（433 文件） | **100.8MB → 135.7MB（峰值 +36.6MB / +34.9MiB）→ 90.8MB**                                     | 1 Hz 外部采样；profiler mark 为 100.8 / 85.0 / 85.0 MiB（during 为 agent_end 单点，非峰值） |
| diagnostic buffer / retained    | —                       | 500 / 0                                                                                      |                                                                                             |
| compaction 告警 / 错误          | 0                       | 0 / 0（`dev:errors` 空）                                                                     |                                                                                             |
| 证据                            | —                       | 截图 `%TEMP%\opencode\patch5-benchmark.png`；原始快照 `%TEMP%\opencode\patch5-benchmark.txt` |                                                                                             |

### §9 诊断分级（PATCH 5 基准）

| 任务                                | 时长  | 等级                        |
| ----------------------------------- | ----- | --------------------------- |
| streaming 事件处理（最大 flush）    | 3.9ms | 正常（<16ms）               |
| 起点 context 构建                   | 52ms  | serious（50–200ms，一次性） |
| agent_end finalize（最终 Markdown） | 63ms  | serious（一次性）           |
| 完成整线程 render                   | 60ms  | serious（一次性）           |

结论：高 event volume 下**不存在持续数百毫秒/数秒的无界同步 RPC processing**——PATCH 0 的 11,996ms 持续阻塞已变为最大 63ms 的一次性边界渲染；57.9s 运行期（工具扫描 + 流式）**0 longtask**。

### 响应性探测（10,000 文件，另一轮运行）

- 运行中 rAF 连续 40 帧：total 271ms、**max gap 7.1ms、mean 6.9ms**（144Hz 正常刷新，无阻塞）；后续 30 帧 max 7.2ms；完成后 max 12.4ms。
- 自动滚动：报告流式/完成后 `scrollTop == scrollHeight − clientHeight`（2910/2910）；同轮 longtask 仅 2 个（52ms 起点、66ms 边界）。
- 手动滚动/线程切换/取消语义已在 PATCH 3/4 行为验证中覆盖（同代码路径）。

## 环境问题与处置记录

| 问题                       | 现象                                                                            | 根因                                                                                                     | 处置                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRLF 假红                  | 首次 `npm run ci` 在 `format:check` 阶段对 137 个文件报错                       | 系统 git `core.autocrlf=true` + 仓库无 `.gitattributes`，checkout 为 CRLF；prettier 默认 `endOfLine: lf` | 仓库本地 `git config core.autocrlf false` + `git rm --cached -r -q . && git reset --hard` 强制 LF 重新 checkout；重跑全绿。与上游代码无关，新克隆需重复此环境处置 |
| esbuild postinstall 未批准 | `npm ci` 输出 `npm warn install-scripts`：`esbuild@0.28.1 (postinstall)` 未覆盖 | npm 11.19 的 install-scripts 安全策略                                                                    | 暂不处理；构建与测试均正常（平台二进制来自 optionalDependencies）。若后续报二进制缺失，用 `npm install-scripts approve esbuild` 或 `npm rebuild esbuild`          |

## 已发现但未动的事项

- `C:\Users\zcooo\OneDrive\Obsidian` 经 `obsidian.json` 证实为**唯一注册的主 Vault**（真实插件 + pi-agent 活跃数据）→ 已排除，禁止 dev:install；其内 pi-agent 0.0.16 保持原样不动。
- `TESTING.md` 的 `ObsidianTesting` 路径为上游作者 macOS 路径，本机不存在。
- npm audit：3 moderate + 4 high（既有，未在本任务范围内处理）。
