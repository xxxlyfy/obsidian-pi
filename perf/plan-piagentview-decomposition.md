# PiAgentView 分解计划（可在新对话中直接实施）

> 本文件是自包含的实施计划。执行者无需阅读此前的对话记录，只需按步骤做，并在每一步后运行验证。

## 一、目标与成功标准

把 `src/ui/PiAgentView.mjs` 从 **1,269 行 / 48 个自有方法 / 96 个方法（含 mixin）** 的上帝类，按职责拆成若干显式模块，使"改一处功能不必读整个文件"。

**成功标准（全部可机械验证）：**

1. `src/ui/PiAgentView.mjs` ≤ 700 行，且**文件内不再出现任何 DOM 元素创建**（`createDiv` / `createEl` / `createSpan` 只应出现在新建的 builder 模块里）。
2. `renderChatView` 本体 ≤ 60 行（现为 217 行）：只剩"调用 builder + 接线协作者 + 渲染既有状态"。
3. `npm run ci` 退出码 0（构建、格式、lint、`checkJs`、61 文件 / 363 用例、版本一致）。
4. `npm run test:obsidian:run` **20/20**（真实 Obsidian：生命周期、设置、真实 Pi 对话、运行中取消）。
5. 没有断言被削弱：6 个对源码做正则断言的测试文件全部更新为"读该逻辑现在所在的文件"，且断言数量不减少。

## 二、当前状态的实测事实（执行前请先复核，行号可能因其它改动漂移）

| 事实 | 数值 |
|---|---|
| `PiAgentView.mjs` 总行数 | 1,269 |
| `renderChatView()` | 起 107 行，止于 `onClose()` 前（约 354 行），**248 行** |
| `runPrompt(...)` | 起 857 行，**315 行** |
| 文件自有方法 | 48 个 |
| 构造函数 | 58–69 行：`super` → `this.plugin` → `this.lifecycle` → `Object.assign(this, createViewState(t))` |
| `renderChatView` 内写入的 `this.*` 字段 | 21 个（见下） |
| `renderChatView` 内 `new` 的协作者 | `NoteActions`、`MessageActions`、`ThreadActions`、`RunSettingsControls`、`ComposerSuggestions`（另有一个 `f.` 命名空间调用） |
| `renderChatView` 内注册的事件监听 | 17 个 |
| 读取 `PiAgentView.mjs` 源码做断言的测试 | **6 个文件**（见第四节，这是最大约束） |
| `src/ui/view/` 现有模块 | `lifecycle.mjs`、`view-state.mjs`、`view-surface.mjs`、`run-metadata.mjs` |

`renderChatView` 写入的 21 个字段：
`lifecycle, showingThreadList, renderedThreadId, noteActions, messageActions, threadMenu, runSettings, suggestions, messagesEl, toolBadgesEl, promptQueueEl, extensionWidgetsAboveEl, extensionWidgetsBelowEl, inputEl, imageInputEl, composerBarEl, sendButtonEl, threadTitleEl, threadFavoriteEl, promptQueue, stickToBottom`

## 三、四条硬约束（违反其中任何一条都会造成运行时崩溃或假绿）

1. **本仓库的 `src/` 是被压缩/降级转译过的代码**（单字母变量、多行参数列表）。任何批量 codemod 都会在块边界识别上出错——已实测过一次，它把声明插进了 `if` 分支内部。**只允许逐处手工编辑**。
2. **Obsidian 直接加载未转译的 `main.js`**，因此不能使用 TypeScript 的 `declare` 类字段。任何在类体里裸写 `/** @type {any} */ foo;` 都会创建**真实实例字段**，把原型上的 mixin 方法遮蔽成 `undefined`——上一轮已因此造成过一次真实崩溃（`this.clearCoalescedActivity is not a function`）。**禁止在类体里声明 mixin 提供的成员。**
3. **6 个测试读 `PiAgentView.mjs` 的文本做正则断言。** 把代码移出该文件会让它们失败。必须同步更新为读取该逻辑现在所在的文件（做法见 Phase B）。
4. **不要顺手做 Phase C/D 之外的"优化"**。每一步只做一件事，做完即验证。

## 四、现状护城河：必须保留的验证手段

```bash
npm run ci                       # 构建 + 格式 + lint + checkJs + 单测 + 版本
npm run test:pi                  # Pi CLI 可用且协议符合预期
npm run test:obsidian            # 需要：Obsidian 已运行且开着 --remote-debugging-port=9222
npm run test:obsidian:run        # 追加：一次真实 Pi 对话 + 运行中取消压测
npm run dev:install -- "<vault>/.obsidian/plugins/pi-agent"   # 把构建装进 vault
```

**必须知道的两个信号陷阱**（`README.md` 的 "Verifying inside a real Obsidian" 一节也记了）：

- `view.running` 是**渲染标志**（针对当前显示的会话），不是"有运行在进行"。运行一开始会注册进 `view.activeRuns`，**要等的是 `activeRuns`**。
- 流式 rAF 帧只存在约一帧（16ms）。**不要在某个瞬间采样它**作为断言，否则测试是抛硬币。需要测定时器清理时，用 `lifecycle.setTimer` 主动"种"一个待触发定时器。

## 五、分阶段实施

### Phase A：抽出 DOM 构造（低风险，本计划的主干）

**为什么先做这个**：`renderChatView` 那 248 行里**没有业务逻辑**，全是手工搭 DOM 树。实测确认：**6 个源码正则断言没有一个匹配这段 DOM 构造代码**（它们匹配的是 `onClose`、`cancelCurrentRun`、`runPrompt`、`resetTransientRunUiState` 里的行为接线）。所以 Phase A 不会碰到第四节那个护城河。

**A1. 新建 `src/ui/view/chat-dom.mjs`**，导出纯构造函数，全部接收 `(container, deps)` 形式，**不访问 `this`**：

| 导出 | 负责创建 | 返回 |
|---|---|---|
| `createChatShell(container)` | `pi-agent-view` 根容器、清空、加 class | `{ root }` |
| `createHeader(root, deps)` | 品牌区、Pi 图标、标题元素、收藏按钮、新建/管理线程按钮 | `{ threadTitleEl, threadFavoriteEl, ... }` |
| `createMessagesArea(root)` | 消息容器、工具徽章容器、队列容器、extension widget 容器（上/下） | `{ messagesEl, toolBadgesEl, promptQueueEl, extensionWidgetsAboveEl, extensionWidgetsBelowEl }` |
| `createComposer(root, deps)` | 输入 textarea、图片 input、composer bar、发送按钮、附件菜单按钮 | `{ inputEl, imageInputEl, composerBarEl, sendButtonEl }` |

**约束**：`deps` 里只放**回调与只读数据**（如 `onRenameTitle`、`onSendClick`、`onAttachClick`、`strings: { sendAria, send }`）。构造函数**不得**读写 `this.lifecycle`、`this.plugin` 以外的状态，不得调用 `renderMessages()`／`setRunningState()` 这类渲染副作用。

**A2. 改写 `renderChatView` 为编排函数**，严格保持现有语句顺序，目标形态：

```js
renderChatView() {
  if (this.lifecycle) this.lifecycle.dispose();
  this.lifecycle = createViewLifecycle();
  this.showingThreadList = false;
  const currentThreadId = this.getCurrentThreadId();
  if (this.renderedThreadId !== currentThreadId) this.resetTransientRunUiState();
  this.renderedThreadId = currentThreadId;
  this.syncCurrentRunFlags();

  const container = this.containerEl.children[1];
  const { root } = createChatShell(container);
  Object.assign(this, createHeader(root, { /* callbacks */ }));
  Object.assign(this, createMessagesArea(root));

  this.noteActions = new NoteActions(this.plugin, { /* 原样搬移 */ });
  this.messageActions = new MessageActions(this.plugin, { /* 原样搬移 */ });
  this.threadMenu = new ThreadActions(this.plugin, { /* 原样搬移 */ });
  this.suggestions = new ComposerSuggestions(this.inputEl, this.plugin, () => this.resizeInput());
  this.runSettings = new RunSettingsControls(this.plugin);

  this.observeComposerBar(this.composerBarEl);
  this.renderMessages();
  this.setRunningState(this.running);
}
```

**A3. 顺序敏感点（必须逐条核对，这是本阶段唯一的高风险处）**：

- `observeComposerBar(this.composerBarEl)` 必须在 composer bar 创建之后、且在 `renderMessages()` 之前（现有顺序如此）。
- 所有 `this.inputEl.addEventListener(...)`（17 个监听）中依赖 `this.suggestions` 的那些（`input`、`click`、`blur`、`keydown`、`paste`、`drop`）在构造函数里注册回调没问题，**但不能在回调注册时立即求值 `this.suggestions`**——保持它们现在"回调内才访问"的写法。
- `this.stickToBottom`、`this.promptQueue` 的初值来自 `createViewState`，`renderChatView` 不得重新赋值（现在也没有）。
- `renderToolBadges()`、`renderPromptQueue()` 目前并非全部在 `renderChatView` 内调用；**不要**为了"整洁"新增调用。

**A4. 验收（每完成一个 builder 就做一次）**：

```bash
npm run ci
npm run build && npm run dev:install -- "<vault>/.obsidian/plugins/pi-agent"
npm run test:obsidian          # 期望 14/14
```

**A5. 预期结果**：`renderChatView` ≤ 60 行；`PiAgentView.mjs` 减少约 200 行；`chat-dom.mjs` 约 220 行。

---

### Phase B：把 6 处源码正则断言迁到"逻辑所在地"

**为什么必须做**：Phase A 移走 DOM 构造不影响它们，但 **Phase C/D 会**（`runPrompt`、`cancelCurrentRun`、`onClose` 里的代码会被移出）。

**6 个测试文件及其断言意图：**

| 文件 | 断言内容（意图） | 逻辑现在何处 |
|---|---|---|
| `tests/activity-coalescing.test.mjs` | `onClose` 清合并活动；`cancelCurrentRun` 清合并活动；`threadGeneration += 1`；`runGeneration: ++this.runGenerationCounter`；`activeRuns.get(t) !== n`；`isStaleUiCallback(guard)` | `PiAgentView.mjs`（重命名、取消、守卫） |
| `tests/streaming-renderer.test.mjs` | `onClose` 取消流式帧；`cancelStreamingFlush()` 在文件中出现 ≥4 次 | 部分在 `PiAgentView.mjs`，部分在 `message-renderer.mjs` |
| `tests/native-chat-polish.test.mjs` | `n.thinkingUserSet ? n.thinkingExpanded : false` 恰好 2 次；`liveThinkingSetExpanded?.()`；不得含 `setIcon)(icon, "brain")` | `PiAgentView.mjs`（`runPrompt` 内） |
| `tests/annotation-processing.test.mjs` | `beginAnnotationProcessing`、`handleSuccessfulToolMutation`、`completeAnnotationProcessingForPath`、`endAnnotationProcessingForThread`、`restoreUnsentAnnotations` 存在；且**不得**出现 `app.vault.on("modify"`、`handleVaultFileModify` 等 | `PiAgentView.mjs`（`runPrompt` 内） |
| `tests/context-badges-annotation-dialog.test.mjs` | 一批徽章文案与 `renderPendingBadge` 调用形态；不得含 `Current:`、`No current note`、`includeActiveNote` | `PiAgentView.mjs`（`renderToolBadges` 区） |
| `tests/composer-run-settings.test.mjs` | 与 `thread-list-view.mjs` 拼接后**不得**匹配某些模式 | 两个文件 |

**B1. 引入读取辅助模块** `tests/helpers/view-source.mjs`：

```js
import fs from "node:fs";
import path from "node:path";

const SRC = new URL("../../src/", import.meta.url);

/** 读取一个源文件的文本（用于结构性断言）。 */
export function readSource(relativePath) {
  return fs.readFileSync(new URL(relativePath, SRC), "utf8");
}

/**
 * 读取一组源文件的文本并拼接，用于"这段代码在本子系统里存在"的断言。
 * 拼接而不是逐文件断言，是为了让断言随代码搬家继续有效。
 */
export function readSources(relativePaths = []) {
  return relativePaths.map(readSource).join("\n");
}
```

**B2. 逐条改法**（每个测试只改读取来源，不改判定意图）：

- `readFileSync(new URL("../src/ui/PiAgentView.mjs", import.meta.url), "utf8")` → `readSources(["ui/PiAgentView.mjs"])`
- 断言的目标代码若将迁往 `message-renderer.mjs` / `run-activity-state.mjs`，改为 `readSources(["ui/PiAgentView.mjs", "ui/message-renderer.mjs"])` 之类，**在测试里写一行注释说明为什么列了这两个文件**。
- 对于"必须在某个文件里"的断言（如 `onClose` 必须在 `PiAgentView.mjs`），保留单文件读取。

**B3. 强化规则（防止假绿）**：

- 若某条断言只是"这段文本存在于某处"，而对应逻辑在 Phase C/D 后归某个 mixin 所有，**优先把它改写成行为断言**（import 该 mixin、构造最小 `this`、直接调用并断言效果），再保留一条"迁移后位置正确"的文本断言。
- 断言总数**不得减少**。每条改写的断言在提交信息里写清"原来断言什么、现在断言什么"。

**B4. 验收**：`npm run ci` 绿；并**故意制造一次回归**验证门禁有效——例如临时删掉 `onClose` 里的 `this.cancelStreamingFlush()`，确认对应测试失败，然后恢复。

---

### Phase C：`this.field` → `this.state.field`（Phase D 的前提）

**为什么是前提**：现在 30+ 字段与 96 个方法共享一个 `this`，跨文件隐式耦合，导致"改任何一处都可能碰到别处字段"。不先把访问路径显式化，Phase D 会在隐式耦合里反复踩坑。

**C1. 目标形态**：`createViewState(plugin)` 的返回值挂到 `this.state`，而不是 `Object.assign(this, ...)`：

```js
// 构造函数
this.state = createViewState(t);
```

访问处 `this.foo` → `this.state.foo`（`foo` ∈ `ViewState` 的字段）。

**C2. 判定"某个字段属于 state"的依据**：`src/ui/view/view-state.mjs` 里 `ViewState` 的 typedef。只迁移 typedef 里列出的字段；`plugin`、`lifecycle` 不属于 state。

**C3. 逐方法迁移流程（严禁批量改写）**：

1. 选定一个文件（建议顺序：`run-activity-state.mjs` → `message-renderer.mjs` → `prompt-queue.mjs` → `thread-list-view.mjs` → `PiAgentView.mjs`）。
2. 逐方法阅读，把该 `this` 上属于 `ViewState` 的字段访问改成 `this.state.xxx`。**一个方法一次**。
3. 每个文件改完立刻 `npm run ci`。
4. 全部文件改完后，移除 `PiAgentView.mjs` 顶部的 `// @ts-nocheck`，运行 `npx tsc -p tsconfig.src.json`，逐个修剩下的类型错误。
5. **若某文件的类型错误无法在合理时间内修完**：允许保留该文件的 `@ts-nocheck`，但必须在文件顶部写明具体原因与剩余错误数，并在 `tsconfig.src.json` 里不改动门禁。**不允许**放宽 `tsconfig.src.json` 或加 `any` 批量压制。

**C4. 测试影响**：`tests/streaming-renderer.test.mjs`、`tests/activity-coalescing.test.mjs`、`tests/perf-synthetic.test.mjs` 用对象字面量伪造 view（`Object.assign({}, streamingMethods, {...})`），它们把字段直接挂在假 view 上。迁移后需把这些 fixture 改成挂到 `state` 上，或给假 view 加一个 `state` 对象。**这是预期内的测试改动，不是降低标准**——改后断言强度必须不变。

**C5. 验收**：`npm run ci` 绿；`npx tsc -p tsconfig.src.json` 报错数 = 0（或在 C3.5 记录的例外内）；`npm run test:obsidian:run` 20/20。

---

### Phase D：把 `runPrompt`（315 行）按阶段切开

**只在 Phase C 完成后做。**

`runPrompt` 现有阶段（按出现顺序）：

| 阶段 | 现内容 | 建议归属 |
|---|---|---|
| 1. 解析输入 | 消费批注（`consumeAnnotationsForPrompt`）、准备 `restoreUnsentAnnotations` | `view/run-prompt.mjs` 的 `resolvePromptInput` |
| 2. 排队决策 | 若 `isThreadRunning(t)`：入队或把 `queuedId` 置回 pending | `queuePromptForRunningThread` |
| 3. 交付前富化 | `enrichPromptDelivery`、图片能力校验、写用户消息、注册 `activeRuns`、`beginAnnotationProcessing` | `startTrackedRun` |
| 4. 事件处理 | `onEvent` 回调：思考增量、工具错误、成功变更、陈旧守卫 | **保持在 `PiAgentView`**（它重度读写视图状态与 DOM） |
| 5. 收尾 | 结束批注处理、写回历史、桌面通知、`markHeap("after")` | `settleRun` |

**关键约束**：阶段 4 的回调**必须仍然是同一个闭包**（它捕获 `n`、`t`、视图状态）。如果为了"拆"而把 `onEvent` 挪进另一个模块，必须把 `n`/`t`/所需回调显式传入，并且**不得**改变事件处理顺序与守卫时机——这几处正是 `activeRuns.get(t) !== n` 与 `isStaleUiCallback` 断言覆盖的。

**D 的验收**：`runPrompt` ≤ 80 行；`npm run ci` 绿；`npm run test:obsidian:run` **20/20**；另外**手工再做一次真机检查**：在 Obsidian 里发一条消息、等它流式输出、点取消、再发一条——三条都要正常（这正是压测覆盖的路径）。

## 六、风险与回滚

| 风险 | 触发点 | 应对 |
|---|---|---|
| 实例字段遮蔽 mixin 方法 | 在类体里声明 mixin 成员 | 绝对不做；需要类型时改 `view-surface.mjs` 的 typedef |
| DOM 构造顺序改变导致监听失效或渲染错位 | Phase A | A3 的逐条顺序核对；每步跑 `test:obsidian` |
| 源码正则断言假绿 | Phase B | B3 的强化规则 + B4 的故意回归验证 |
| 200+ 处机械改写引入崩溃 | Phase C | C3 的"一个方法一次 + 每文件跑 ci"；禁止批量 |
| 事件回调语义漂移 | Phase D | D 的关键约束；真机手动三条路径 |
| 整个阶段失败 | 任意 | **每个 Phase 一个独立提交**，可单独 `git revert`。Phase A 独立成提交，即使 C/D 没做也是净收益 |

## 七、提交与验证节奏

1. 每个 Phase 一个提交，提交信息写清"移走了什么、为什么、验证了什么"。
2. 每次提交前必须：`npm run ci` → `npm run build` → `npm run dev:install -- <vault>` → `npm run test:obsidian`（Phase C/D 加 `--run`）。
3. **不要动** `src/ui/view/lifecycle.mjs`（已有 7 个单测 + 真机断言）与 `src/shared/process-tree.mjs`（已抽取，虽无直接测试但不在本计划范围）。
4. 计划外的发现（新的崩溃、新的覆盖缺口）**记录并单独处理**，不要塞进当前 Phase。

## 八、本计划**不**包含的事（避免范围蔓延）

- 补 `src/shared/process-tree.mjs` 的直接测试（需要 mock `execFileSync` 与 `process.kill`，是独立任务）
- 把 `test:obsidian` 自动化进 CI（需要脚本自行拉起 Obsidian，是独立任务）
- 消除最后 1 条 `prefer-window-timers` 警告（会退步弹出窗口支持，应保持现状）
- 任何 `src/pi/` 或 `src/shared/` 的重构
- 升级依赖、改版本号、发布

## 九、一句话摘要

先抽 DOM 构造（安全、立刻减 200 行），再迁 6 处源码正则断言（否则后面会假绿），再把 `this.field` 显式化成 `this.state.field`（否则拆不动），最后才切 `runPrompt`。每一步单独提交、单独可回滚，且每步都用真实 Obsidian 的 20 项检查兜底。
