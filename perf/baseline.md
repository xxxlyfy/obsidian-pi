# Baseline — 环境与 CI

本文件记录性能修复前的运行环境与 CI 基线，供后续 PATCH 前后对比。

## Environment（规格 §3.1）

| 项 | 值 | 获取方式 |
| --- | --- | --- |
| Obsidian version | **1.13.7**（运行时确认；installer 1.13.7） | `obsidian version`（官方 CLI，在运行实例中执行） |
| Electron version | **43.3.0**（运行时确认） | `obsidian eval` → `process.versions.electron` |
| Chromium version | **150.0.7871.212**（运行时确认） | `obsidian eval` → `process.versions.chrome` |
| Node/runtime（宿主） | v24.21.0（npm 11.19.0；git 2.55.0.windows.3） | `node --version` / `npm --version` / `git --version` |
| Electron 内建 Node | **24.18.1**（运行时确认） | `obsidian eval` → `process.versions.node` |
| Pi version | 0.87.1 | `pi --version` |
| Plugin version | 0.0.16 | `manifest.json` / `package.json` |
| OS | Windows 11 专业版，10.0.26200 | `Win32_OperatingSystem` |
| 测试 Vault | `C:\Users\zcooo\Desktop\3\test-vault`（新建专用；已由 Obsidian 打开，pi-agent 0.0.16 已启用并验证） | 主 Vault = `C:\Users\zcooo\OneDrive\Obsidian`（`obsidian.json` 唯一注册，禁用）；dev:install + sha256 校验；见「人工验证记录」 |

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

### 发现 #1（既有 bug，与本次改动无关，未修）

- **现象**：全新 Vault 未配置模型时打开 Pi 视图，核心日志 `[ERROR] Failed to open view`，`message: "e.startsWith is not a function"`；视图半初始化（无 Send 按钮、消息区未渲染、composer 观察器未启动）。
- **根因**：`src/ui/run-settings.mjs:78-79` —— 无模型时 `getModelProvider()` 返回 `""`，`{ provider: "" }` 让 `icon?.provider` 为假，整个对象被当作图标名传给 `setIcon()`，Obsidian 核心对它调用 `.startsWith` 抛 `TypeError`；核心在 `view.open()` 处 catch 并只打 `console.error`。触发链：`PiAgentView.renderChatView → RunSettingsControls.render → populate → addPickerSetting`。0.0.16 release 产物同样存在（本仓库 `main.js` 与 release 字节一致）。
- **规避**：在测试 Vault 配置任意模型（已设 `deepseek/deepseek-flash`）后不再触发。
- **处置**：Step 1 约定 `src/` 零改动，本次不修；建议后续单独开 issue（不在性能 PATCH 范围，除非规格另有要求）。

### 发现 #2（Windows 参数截断，既有 bug，未修）

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

| 指标 | 值 |
| --- | --- |
| health-check total duration | **67,352 ms**（`runPrompt` 全程；session 时间戳跨度 63,169 ms） |
| longest main-thread task | **11,996 ms** |
| P95 task duration | 1,367 ms |
| P99 task duration | 11,996 ms（= max） |
| 最长连续同步执行时间 | 11,996 ms（定义：longtask 最大时长 = 主线程连续不可响应上限） |
| longtask 数量（≥50ms） | 54 |
| longtask 总时长 | 31,105 ms（占全程约 46%） |
| 平均 longtask | 576 ms |
| JS heap（`performance.memory.usedJSHeapSize`） | 41.2 MB → 79.9 MB（+38.7 MB） |
| CDP `Runtime.getHeapUsage` | 运行前 used 28.3 MB → 运行后 used 23.5 MB（空闲 GC 后） |

### 同轮事件统计（session JSONL）

| 指标 | 值 |
| --- | --- |
| tool 调用 / toolResult | 12 / 12（全部 `bash`） |
| assistant 消息 / thinking / toolCall / text | 13 / 13 / 12 / 17 |
| RPC events/sec | unavailable（未修改版本无计数器） |
| maximum event burst | unavailable |
| streaming delta count | unavailable |
| Markdown render count | unavailable |

> `unavailable` 项自 PATCH 0 profiler 落地起可测（已埋点），后续 patch 用同一 workload 对比。

### Profiler 验证运行（PATCH 0 代码，短 prompt）

- 启用方式：`app.plugins.plugins["pi-agent"].profiler.enabled = true`；结束已置回 `false`；`dev:errors` 无错误。
- `snapshot().metrics`：`rpcEventsProcessed: 12`、`rpcEventsPerSecond: 5.5`、`maxDrainDuration: 6.0 ms`、`maxEventDuration: 5.9 ms`、`maxJsonParseDuration: 0.3 ms`、`maxJsonLineBytes: 60,691`、`yieldCount: 0`、`yieldLatency: 0`（PATCH 1 填充）。

## Yield Runtime Spike（PATCH 0 §3.3）

> 环境：Obsidian 1.13.7 / Electron 43.3.0 / Chromium 150.0.7871.212；窗口前台（CDP `Emulation.setFocusEmulationEnabled`），N=50。

| 机制 | availability | min / median / p95 / max (ms) | 结论 |
| --- | --- | --- | --- |
| `scheduler.yield()` | ✅ `typeof globalThis.scheduler?.yield === "function"` | 0 / 0 / 0.1 / 0.1 | **首选** |
| `MessageChannel` | ✅ | 0 / 0 / 0.1 / 1.8 | fallback |
| `setTimeout(0)` | ✅ | 0 / 15.4 / 16.7 / 17.1 | 最终 fallback（明显更差） |

优先级验证：`scheduler.yield()` 的续体先于此前入队的 MessageChannel 任务执行（实测顺序 `yield>message`），priority continuation 可用。

**结论（规格 §3.3 情况 A）**：`scheduler.yield()` 可用且实测行为可靠 → PATCH 1 的 `YieldScheduler` 主路径使用 `scheduler.yield()`，`MessageChannel` 为 fallback，`setTimeout(0)` 为最终 fallback；batch interval 验收标准按 scheduler.yield 实测延迟制定。

> 操作注意：Obsidian 窗口被遮挡/最小化时 Chromium 会节流定时器（实测链式 `setTimeout` 几乎停滞；`scheduler.yield` 与 `MessageChannel` 不受影响）。后续所有浏览器内测量必须保持窗口前台或开启焦点模拟。

## PATCH 1 验证运行（Cooperative Drain）

> 同一测试 Vault、同一 prompt（全库健康检查）。agent 行为存在模型随机性：本轮 tool 调用 23 次（基线 12 次）、RPC 事件 **19,497** 个，实际负载明显更高。

| 指标 | PATCH 0 基线（未修改） | PATCH 1 | 说明 |
| --- | --- | --- | --- |
| health-check total duration | 67,352 ms（12 tool calls） | 209,142 ms（23 tool calls） | 负载不同，墙钟不可直接比较 |
| longest main-thread task | **11,996 ms** | **63 ms** | 关键指标 |
| longtask 数量（≥50ms） | 54 | **3** | |
| longtask 总时长 | 31,105 ms | **176 ms** | |
| P95 / P99 task duration | 1,367 / 11,996 ms | 63 / 63 ms | |
| RPC events processed | unavailable（未埋点） | 19,497 | |
| RPC events/sec | — | 93.2 | |
| yieldCount | — | 8,846 | 每 ~2.2 事件一次（单事件均 7.1ms，批次常为 1–2 事件） |
| yieldLatency（max / mean） | — | 16.2 / 0.43 ms | |
| maxDrainDuration | — | 63.2 ms（预算 6ms） | 超预算原因：预算只能在**事件之间**暂停；单条 `agent_end`（221,914B）处理占 63ms |
| maxEventDuration | — | 63.1 ms | 同上；单事件成本是 PATCH 2/3 的目标 |
| maxJsonParseDuration | — | 1.9 ms | |
| maxJsonLineBytes | — | 221,914 | |
| 错误 | 0 | 0（`dev:errors` / `dev:console` 均空） | |

结论：主线程最长阻塞从 11.9s 级降到 **63ms 级**，且是在更高事件负载下取得；预算因单事件成本高而常退化为 1–2 事件/批，配合 `scheduler.yield`（Chromium 150）仍保持可响应。单事件处理成本留给 PATCH 2（RunState/coalescing）与 PATCH 3（streaming rendering）。

## 环境问题与处置记录

| 问题 | 现象 | 根因 | 处置 |
| --- | --- | --- | --- |
| CRLF 假红 | 首次 `npm run ci` 在 `format:check` 阶段对 137 个文件报错 | 系统 git `core.autocrlf=true` + 仓库无 `.gitattributes`，checkout 为 CRLF；prettier 默认 `endOfLine: lf` | 仓库本地 `git config core.autocrlf false` + `git rm --cached -r -q . && git reset --hard` 强制 LF 重新 checkout；重跑全绿。与上游代码无关，新克隆需重复此环境处置 |
| esbuild postinstall 未批准 | `npm ci` 输出 `npm warn install-scripts`：`esbuild@0.28.1 (postinstall)` 未覆盖 | npm 11.19 的 install-scripts 安全策略 | 暂不处理；构建与测试均正常（平台二进制来自 optionalDependencies）。若后续报二进制缺失，用 `npm install-scripts approve esbuild` 或 `npm rebuild esbuild` |

## 已发现但未动的事项

- `C:\Users\zcooo\OneDrive\Obsidian` 经 `obsidian.json` 证实为**唯一注册的主 Vault**（真实插件 + pi-agent 活跃数据）→ 已排除，禁止 dev:install；其内 pi-agent 0.0.16 保持原样不动。
- `TESTING.md` 的 `ObsidianTesting` 路径为上游作者 macOS 路径，本机不存在。
- npm audit：3 moderate + 4 high（既有，未在本任务范围内处理）。
