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

## 环境问题与处置记录

| 问题 | 现象 | 根因 | 处置 |
| --- | --- | --- | --- |
| CRLF 假红 | 首次 `npm run ci` 在 `format:check` 阶段对 137 个文件报错 | 系统 git `core.autocrlf=true` + 仓库无 `.gitattributes`，checkout 为 CRLF；prettier 默认 `endOfLine: lf` | 仓库本地 `git config core.autocrlf false` + `git rm --cached -r -q . && git reset --hard` 强制 LF 重新 checkout；重跑全绿。与上游代码无关，新克隆需重复此环境处置 |
| esbuild postinstall 未批准 | `npm ci` 输出 `npm warn install-scripts`：`esbuild@0.28.1 (postinstall)` 未覆盖 | npm 11.19 的 install-scripts 安全策略 | 暂不处理；构建与测试均正常（平台二进制来自 optionalDependencies）。若后续报二进制缺失，用 `npm install-scripts approve esbuild` 或 `npm rebuild esbuild` |

## 已发现但未动的事项

- `C:\Users\zcooo\OneDrive\Obsidian` 经 `obsidian.json` 证实为**唯一注册的主 Vault**（真实插件 + pi-agent 活跃数据）→ 已排除，禁止 dev:install；其内 pi-agent 0.0.16 保持原样不动。
- `TESTING.md` 的 `ObsidianTesting` 路径为上游作者 macOS 路径，本机不存在。
- npm audit：3 moderate + 4 high（既有，未在本任务范围内处理）。
