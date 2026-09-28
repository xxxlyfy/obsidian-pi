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
