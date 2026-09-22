# Changelog

## Unreleased

## 0.0.46

- No behavior change: this release completes the lifecycle cleanup. The force-termination contract is documented on the runner (a force-terminated runner becomes invalid, is never reusable, and the thread runner registry replaces it with a runner that starts its own Pi process), and two focused unit tests pin that contract for both the prompt and the compaction path.

## 0.0.45

- Fixed a stuck-chat case after closing a view: a cancel watchdog was disarmed when the view released its runtime, so a run whose cancellation never settled could leave the thread runner wedged. That runner stayed in the registry reporting "already running", and the chat refused every later prompt until the plugin was reloaded. The watchdog now completes even after the runtime is gone, force-retires the wedged runner (which the registry replaces), and the chat is usable again within the cancel deadline.
- Added an integration test that wires the real chain (thread runner registry, real runner, mocked RPC client, real agent runtime) and proves: a wedged cancellation retires the runner and the next run gets a fresh runner and a fresh Pi process; closing the view in that state releases the runner, keeps the queued prompts, and never starts them.
- Removed a duplicated line in the persistence "save recovered" handler.

## 0.0.44

- A force-stopped runner (cancel watchdog) is now retired instead of being reused: it is marked invalid, refuses every later run, and the thread runner registry disposes and replaces it. The replacement starts its own Pi process, so the previous run's late cleanup and late events can only touch the retired runner and can never disturb the chat that now owns it.
- This replaces the per-execution token from 0.0.42 with a single invalidation rule, so force termination, cancellation, timeout recovery, and process death keep one coherent lifecycle instead of two overlapping guards.
- Lifecycle tests were reworked around the real thread runner registry: force-terminate then replace (different runner object and different RPC client), late finalizer and late RPC events with a newer run active, the compaction path, cancel-timeout retry, and process-death recovery.

## 0.0.43

- Closing a chat view no longer starts work it can no longer show: the view stops draining its prompt queue, and the two remaining asynchronous continuations are guarded too (a prompt whose context was still being prepared is dropped instead of starting a run, and a queued "Steer now" no longer pushes a steering prompt into the agent). Queued prompts stay stored and are available again when that chat is reopened.
- Strengthened the lifecycle regression coverage for the force-termination path: the late-finalizer race now runs through the real thread runner registry and proves both runs share the same runner object while the second one keeps ownership, a dedicated test replaces the RPC client class to prove the next run builds a different client instance, and the compaction path got the same race test.

## 0.0.42

- Fixed a runner reuse race: a run that was force-terminated (cancel watchdog) and settled late could reset the runner state of the run that had already replaced it, making the runner look idle while it was still streaming and allowing a third run to overlap on the same Pi process. Each run now carries an execution token, and only the current execution may clear the runner state.
- A closed chat view no longer starts queued prompts. Closing a view cancels its own run and releases its runtime, and the settling run's continuation now also skips the queue drain. Queued prompts are kept in the stored queue and are still available when that chat is opened again.
- Regression tests cover both paths with the real runner/registry lifecycle: force-terminate then reuse with a late settle, and close-with-queue (including the unchanged normal drain behavior).
- `docs/state-ownership.md` documents the execution token and the closed-view queue rule.

## 0.0.41

- Compaction (`/compact`) now claims the chat while it runs, like any other run. Previously a compaction could stream while another run was already active on the same chat, letting two streams interleave on one Pi process.
- A cancelled run that had to be force-stopped no longer leaves the chat wedged. Force termination now disposes and drops the RPC client and clears the runner state, so the next message starts a fresh Pi process instead of inheriting the stopped one, and the chat is immediately usable again.
- Removed the unreachable CLI run path (`runPiCli` and its process-termination helpers) that had no callers and did not respect the one-run-per-chat rule. Cancel is RPC-only.
- Added a dedicated runner-lifecycle test suite that pins the reuse rules: reuse after a settled cancel, refusal while a cancel is pending (including compaction), invalidation after force termination, recovery after the Pi process dies, and registry reuse/removal. Runtime tests now cover dispose-ignores-late-events and retry-after-forced-termination.
- `docs/state-ownership.md` documents the Run, Runner, and RPC process lifecycles plus the runner reuse table.

## 0.0.40

- Fixed a persistence data-loss path: a failed save used to clear the pending flag before writing, so the unsaved change was only retried if another edit happened later. The pending state now survives a failed write, the next flush retries it, and the newest state is what gets written.
- Two views can no longer run the same chat at the same time. Each chat allows one active run, and a second send from another view is refused with a clear message instead of interleaving two streams on one Pi process. Different chats still run in parallel.
- Closing a chat view now ends the run that view started (`requestCancel` plus runtime release) instead of leaving an unattached run behind. Canceled runs report the usual cancellation notice and no partial answer is stored. If you relied on closing the view and letting the answer finish in the background, this is the one behavior change in this release.
- A failed chat-history backup is still reported separately from a successful `data.json` write, and a failed `data.json` write no longer attempts a backup.
- `TESTING.md` no longer contains machine-local vault paths; the manual checklist refers to a generic test-vault path.
- Internal: `docs/state-ownership.md` and `docs/identifiers.md` document run ownership, the one-run-per-thread lock, and the persistence revision counters.

## 0.0.39

- Cancelling a run can no longer wedge a chat. A cancel request that fails is reported and retried by the UI path, and a run that stays in `cancelling` past a short deadline (10 s) is released instead of blocking the chat: the agent process is force-stopped, the run is reported as failed, and the next prompt can start immediately.
- A chat-history backup write that fails no longer reports the whole save as failed. `data.json` is written first and stays authoritative, the backup failure surfaces as its own notice, and no backup is attempted when `data.json` itself failed.
- Added regression coverage for the remaining correctness scenarios from this phase: cancel failures (throwing cancel, repeated cancel, cancel after completion, cancellation that never settles), RPC process restarts with late events from the replaced process, prompt timeouts, `mutation -> schedule -> unload -> reload` round trips, vault index rename chains and freed-path reuse, per-step equivalence between the incremental index and a full rebuild, thread deletion fallback and fork isolation, context snapshot mutation isolation, and annotation rename/delete consistency.
- Internal: cancel, persistence-failure, and backup-failure paths are documented in `docs/state-ownership.md`, and the runtime exposes a `forceTerminate` port used only by the cancel watchdog.

## 0.0.38

- Fixed vault index drift after vault changes: deleting a note now removes its reverse backlink entry (previously it stayed forever, so backlink lookups could return links to a note that no longer exists and the index grew without bound), and renaming a note resyncs the link index so backlinks and outgoing links follow the new path even when Obsidian does not report a metadata change for every affected source.
- Prompt context snapshots now detach the note frontmatter from Obsidian's metadata cache. A later cache change can no longer silently alter a prompt that was already built and displayed.
- `retryRun()` no longer keeps a successful prompt replayable, so retrying can no longer resend the same prompt; failed and cancelled runs stay replayable, and the stored request is released on dispose.
- A failed save now shows a notice once per failure streak instead of only writing to the console, and the warning clears after the next successful write.
- The deferred Pi setup check is cancelled when the plugin unloads, so an unloaded plugin can no longer spawn a version check or open the setup modal.
- Long-lived views bound their per-message UI caches instead of growing with every finished run.
- Added regression coverage for cancel, retry, thread-switch, view-close, and overlapping-run races; vault index consistency (incremental index equals a full rebuild); context snapshot stability; annotation and queue rename/delete handling; corrupted persisted data; unload flushing; and coalesced persistence. The benchmark now reports search p50/p95 plus incremental modify/rename/delete latency.
- Internal: the agent and Pi layers no longer import from `src/ui` (prompt payload and queue helpers moved to `src/shared`, runtime model catalog helpers to `src/pi`), and core domain shapes have JSDoc typedefs (`RunRecord`, `RunCallbacks`, `RunHooks`, `RunResult`, `PromptDeliveryRequest`, `SearchResult`, `BacklinkEntry`).

## 0.0.37

- Agent runs now have a single owner: `AgentRuntime` keeps one `RunState` record per chat, and start, cancel, retry, steer, compaction, and event routing go through it. RPC events that arrive after a run was cancelled or already finished are dropped instead of leaking into the chat view.
- Search and backlinks are index-backed. `VaultIndex` builds metadata, tag, and reverse backlink indexes from Obsidian's metadata cache without reading note content, and search reads at most 128 candidate files instead of every note (10,000 notes: about 30 ms index build, 20 ms search, 128 file reads).
- Chat and queue changes are coalesced into one disk write over a 250 ms window and flushed on unload, instead of writing `data.json` and the chat-history backup on every mutation. Settings, annotations, and model changes are still written immediately.
- Thread, queue, model-catalog, prompt-delivery, and annotation-snapshot state moved into dedicated services, and `PiAgentPlugin` is now a composition root. Views read run state from the runtime and refresh through a `ViewRegistry` instead of reaching into view internals, and the view exposes explicit intents (`onSendClick`, `onCancelClick`, `onThreadSelect`).
- All Obsidian API access goes through `src/obsidian/*` adapters, so the agent, context, thread, and persistence modules no longer import Obsidian and can be tested against a fake vault.
- Removed the legacy vault chat-history import path (storage versions 1-3) and two unused helpers. The stored data format is unchanged: chat history, annotations, queued prompts, settings, and the checksummed backups keep working as before.
- Added golden-path tests for streaming, cancel with late events, failure and retry, persist and reload, and note-plus-annotation context, plus search and index benchmarks (`npm run bench:search`) and synthetic vault fixtures.

## 0.0.36

- Cancellation is now detected from the error identity instead of the `"Pi run canceled."` message text, so the runtime message can change without breaking the cancel path. `PiRunCanceledError` and `isPiRunCanceled()` walk the error cause chain, and the runner, the plugin, and the view no longer compare message strings.
- Translated the human-facing interface to Simplified Chinese: the composer, threads, queue, activity and thinking lines, modals, annotation dialog and notices, slash-command catalogue, suggestion details, plugin notices, ribbon tooltip, and command palette names now use one shared copy table in `src/shared/strings.mjs`. Prompt text that is sent to Pi (context packet, bundled instructions, `/context show` field names and status values) stays in English, and runtime diagnostics keep their messages.
- Tests that asserted interface copy now import the same copy table instead of duplicating literals, so the assertions follow the translated strings.
- The build now emits UTF-8 instead of ASCII escapes, so translated copy stays readable in the committed bundle and packaged release (about 7 KB smaller).

## 0.0.35

- Fixed the mid-build annotation retry that could never fire: the annotation snapshot of a prompt that is still being prepared is now tracked as pending, so a note rename or delete during context building reaches it and the delivery is rebuilt once with the resolved path.
- Split the 327-line `runPrompt` into `preparePromptPayload()`, `executePromptRun()`, and shared `requeueQueuedPrompt()` and `buildDeliveryWithSnapshotRetry()` helpers, and moved the streaming callbacks into `handleRunStreamEvent()` and `handleRunStreamDelta()`.
- Removed stylesheet rules that no longer match any class: the run-setting speed and tool-mode colors, the settings error line, and the composer image/file/attachment cards that pending-context badges replaced. Run-setting labels keep their `max-width` scoped to `.pi-agent-run-setting` so the shared `.pi-agent-control-label` no longer clips other labels.

## 0.0.34

- Kept the composer run settings on a single row in narrow panes: the Model, Think, and Mode labels are no longer hidden, compact and narrow layouts tighten the spacing instead, and the unreachable expand/collapse path (`composerBarExpanded`, `composerBarExpandEl`, `.is-expanded`, `chevrons-*`) was removed instead of leaving a non-functional contract in the stylesheet.
- Added a remove action to the current-note pending-context badge. Excluding the current note drops its content and its annotations from every prompt until another note is opened, and queued or steered follow-ups keep the exclusion they were created with.
- `/context show` now reports `activeNote: null` plus an explicit `activeNoteStatus` (`attached`, `excluded with the composer note badge`, or `no active markdown note`) instead of omitting the field, so an excluded note is no longer indistinguishable from an empty one.

## 0.0.33

- Tool activity is tracked per run, so switching back to a background chat now shows its running tool status instead of a stale activity line.
- Prompt delivery retries once when the annotated note was renamed while the context was being built, so the prompt keeps its active-note context.
- The view and mixin type surface is fully typed: the view references the real `PiAgentPlugin` type, DOM fields use element types, and the vault link target type is shared with the interface instead of `any`.
- Extracted a `ThreadRunnerRegistry` so per-thread runner creation, reuse, and disposal live in a dedicated class with unit tests.
- Refreshed dev dependencies (esbuild, eslint, eslint-plugin-obsidianmd, prettier, vitest), resolved all `npm audit` findings (7 to 0), renamed the source typecheck script to `typecheck:src`, and declared the Node engine requirement (`>=22`).

## 0.0.32

- Track Pi 0.86.0 as the last tested compatibility version in the upgrade diagnostics, README, and manual checklist; the version parser test now derives from the tracked constant.
- Refreshed the manual validation checklist for the current release: Windows validation vault paths, current test counts, Chinese settings labels, removed stale chat-archive and queue-reorder items, added coverage for note rename/delete annotation and queue behavior, and a validation record table with the 0.0.31 smoke-test results.

## 0.0.31

- Fixed run state ownership when two chats run at the same time: activity and context usage are now written to the run of the chat that produced the event instead of the last-started run, and context compaction invalidates the correct chat.
- Renaming a note or an attached file now migrates the queued prompt's attachment and image paths as well, and open chat views refresh their queue immediately so a later queue action cannot write the pre-rename paths back.
- Failed or canceled runs restore their annotation snapshot through the live run state, so annotations are no longer dropped when the note was renamed mid-run, and the prompt's active-note context follows the same snapshot.
- Removed the unused cancel-path helper that still relied on the last-started-thread field.

## 0.0.30

- Switching away from a running chat and back now restores its live run state: the streaming answer text, thinking disclosure, activity line, and context usage are kept per thread instead of resetting to an empty chat.
- Restored semantic names in the UI mixin modules (message renderer, run activity, and thread list).
- `checkJs` now type-checks the entire plugin source instead of only the core modules, with the view's runtime mixin surface declared under `src/types`. The wider check surfaced and fixed latent issues around constructor argument forwarding, vault rename/delete file guards, notification API access, and provider brand metadata.

## 0.0.29

- Fixed queued annotation snapshots going out of sync with note renames and deletes: renaming a note now migrates the queued `contextFilePath` and annotation paths to the new name, deleting a note drops its queued annotations instead of restoring them later, and restoring consumed annotations now skips paths whose Markdown file no longer exists.

## 0.0.28

- Fixed annotation sends silently falling back to the currently open note when the annotated note was renamed or deleted: the prompt now shows a notice and leaves the other note's annotations untouched instead of consuming the wrong note's annotations.
- Pi RPC `prompt` and `steer` requests that time out are now treated as uncertain: the run aborts the agent and restarts the Pi process, so a timed-out run can no longer overlap the next one, and disposing the RPC client now ends in-flight runs instead of leaving them hanging.
- Restored semantic names in `PiAgentPlugin` and `PiAgentView` (previously decompiled-style `e`/`t`/`n` identifiers), removed the duplicated cancellation check, and regenerated `main.js`.
- Added staged `checkJs` type checking for the core modules (`pi`, `threads`, `annotations`, `context`, `shared`) as `typecheck:core`, wired into `npm run ci`.
- Made the skill-path tests platform-agnostic so `npm test` passes on Windows as well as Linux.

## 0.0.27

- Hardened the plugin after a full code review: settings saves that fail now surface a notice instead of an unhandled promise rejection, and fire-and-forget prompt actions (composer, command palette, prompt queue, annotations, message actions, and modals) report failures through a notice instead of failing silently.
- Cached per-session message counts (validated by file mtime/size) so rendering the chat list no longer re-reads and re-parses every Pi session JSONL on each render.
- One-off session operations (stats, export, session tree/entries, and Pi session rename) now dispose the temporary Pi runner they create instead of leaving a persistent child process.
- Cleared the composer suggestion blur timer on close.
- Added `.gitattributes` (`* text=auto eol=lf`) so line endings and Prettier's format check are consistent across platforms.

## 0.0.26

- Fixed a streaming regression: when answer text started right after thinking, the throttled renderer kept updating only the thinking block and did not create the streaming answer element until the run finished. The flush now creates the streaming message as soon as answer text is available.
- Hardened `renderMessages` so the scroll-tracking guard is always reset (try/finally), and made the cancel SIGKILL fallback target the same child process so a late timeout can no longer kill a newly started run.
- Composer run-setting menu actions now surface save failures as a notice instead of an unhandled promise rejection. Added regression tests for the streaming flush and the run settings controls.

## 0.0.25

- The composer **Think** menu now lists only the reasoning levels the selected model actually supports, matching Pi (for example DeepSeek Flash shows 关闭/低/高/最高). The separate "default" entry was removed because it always duplicated one of those levels; the resolved default level is shown as selected instead. Reasoning labels were shortened to 关闭/最低/低/中/高/极高/最高.

## 0.0.24

- Fixed the composer **Think** and **Mode** controls not reflecting changes: the in-place refresh called its icon helper without the control, which threw and aborted every label update. The Think menu now also labels the Pi default option distinctly (for example "默认（中）") so it is no longer duplicated with an explicit level such as "中".

## 0.0.23

- Removed the flash when changing **Model**, **Think**, or **Mode** from the composer: the run settings controls now update their label and icon in place instead of rebuilding the whole row, and the model/thinking menus no longer show a transient loading label or refetch the catalog when it is already cached.

## 0.0.22

- The composer **Model**, **Think**, and **Mode** controls now open an anchored menu at the button instead of a full picker dialog, so you can switch options in place without leaving the chat view. The write-tools confirmation and settings persistence are unchanged.

## 0.0.21

- Translated the plugin settings interface to Simplified Chinese: all settings names and descriptions, the Advanced/Pi CLI/Skills/Context groups, buttons and tooltips, dropdown and thinking-level options, placeholders, the write-tools confirmation, and the desktop-notification notice. The model and thinking pickers and the tool mode labels shown in the composer and message metadata were translated for consistency.

## 0.0.20

- Doubled the chat composer input height: the textarea now rests at a taller two-line height and can grow up to 320px as you type.

## 0.0.19

- Stopped the composer **Model** control from truncating long model names: the model label can now expand (up to 240px) and shrinks with an ellipsis only when space is tight, while **Think** and **Mode** keep their compact labels.

## 0.0.18

- Widened the composer control spacing further: run settings (**Model**, **Think**, **Mode**) now use a 16px gap, the composer bar uses 14px, and the compact layout uses 8px.

## 0.0.17

- Increased the spacing between the composer run settings controls (**Model**, **Think**, **Mode**) and the composer bar buttons so they no longer sit too close together.

## 0.0.16

- Moved the composer **Mode** control to the end of the run settings row, after **Model** and **Think**.

## 0.0.15

- Added a **Mode** control to the chat composer, next to **Model** and **Think**, so the Pi tool mode (Chat, Review, Edit, Full agent) can be switched without opening plugin settings. The picker shows the same options and the same one-time write-tools confirmation as the settings tab, and the change applies to subsequent runs.

## 0.0.14

- Smoothed long agent responses by throttling live streaming updates and rendering streaming text as plain text instead of re-parsing the entire answer through Obsidian's Markdown renderer on every token, which was stalling the main thread and freezing the UI during long runs. Completed responses are still rendered as full Markdown.
- Removed the remaining synchronous CLI calls from the Obsidian renderer: Pi installation checks now run asynchronously instead of blocking for up to 5 seconds, and Windows process termination (taskkill) no longer blocks the UI for up to 2 seconds.

## 0.0.13

- Fixed model switching and Pi-default startup failures by resolving one concrete startup model, passing it to Pi exactly once, and removing the redundant RPC model change and unreliable authentication preflight.
- Prevented intermittent OAuth and model-availability races by removing background Pi catalog processes from chat startup and settings saves; model discovery now runs from the picker, while Pi command discovery is lazy for slash commands.
- Kept Pi runtime state as display metadata only, restarted chat runners after settings changes, and preserved the effective Pi model as the single non-duplicated default entry in the model picker.

## 0.0.12

- Updated the transitive lint-tooling dependency set to clear the remaining npm security advisory; the release candidate now reports zero known vulnerabilities.
- Replaced the broken archive-all action with guarded bulk chat deletion, including **delete all** and **delete all except favorites** choices, active-run protection, exact deletion counts, one atomic history update, and default preservation of local Pi sessions. (#79)
- Fixed intermittent `No API key found for the selected model` failures by waiting for Pi model/auth discovery before each run, pinning the resolved effective model onto every chat RPC process, and discarding startup processes whose initial model configuration fails.
- Fixed internal vault links in agent results with a captured delegated navigation fallback, made links visibly interactive, and rendered live **RESPONDING** output through the same Obsidian Markdown path as completed responses and live thinking. The thinking/response separator and spacing now appear as soon as response text starts, avoiding a late layout shift when the run finishes.
- Added a dedicated live **SKILL · name** activity state for explicit `/skill:name` commands and on-demand `SKILL.md` reads, instead of presenting skill loading as generic reading or thinking.
- Hardened local JSON chat persistence in the plugin directory: removed the silent 40-chat retention cap, kept complete chat and thinking history in `data.json`, added checksummed current/previous recovery backups with atomic replacement, and added automatic verified import and cleanup for vault chat files created by development builds. Pi runtime JSONL sessions remain separate. (#78)
- Tightened the native thinking disclosure introduced in 0.0.11 with a clearer answer separator, label-aligned thinking content, and reduced Markdown section spacing while preserving expandable Markdown rendering. (#77)

## 0.0.11

- Cleared all Obsidian plugin scanner findings by replacing ambiguous expression chains, adopting popout-safe window/document/timer access, using the configured vault settings directory, adding Obsidian 1.13 searchable settings definitions with a 1.12-compatible renderer, and declaring CodeMirror as build-time-only dependencies while keeping its runtime modules externalized.
- Moved live **THINKING**, **EDITING**, **READING**, and other run activity out of the Agent heading and into the response disclosure; thinking now renders as Markdown, shares the response bubble background, and uses a separator before the answer.
- Added deduplicated native desktop completion notifications for settled runs while Obsidian is unfocused. Notification clicks focus Obsidian and reopen the originating chat without disabling Pi extensions; unsupported or denied notification environments fail gracefully. (#57)
- Fixed open Markdown notes not refreshing after Pi edits by carrying tool arguments from Pi's start event into completion handling, then reloading every open split while preserving scroll position.
- Made the current Markdown note mandatory prompt context while keeping attached files and annotations removable, and clarified that every annotation's Request field drives the targeted change or focused answer.
- Added the Pi Agent banner and logo source assets and displayed the banner at the top of the GitHub README.

## 0.0.10

- Fixed the two error-level Obsidian Community scanner findings by removing a `this` alias from the vault attachment picker and using Obsidian's `setCssProps` helper for dynamic composer height updates.
- Added the official Obsidian ESLint rules as a release gate so future error-level scanner findings fail CI before publication.
- Restricted release versions to the numbers-and-dots format required by Obsidian Community Plugins.

## 0.0.9

- Simplified the composer attachment action to an accessible paperclip-only button. Model and thinking controls now display their resolved runtime names without a `Default` prefix, and recognized model providers use distinct bundled brand icons or compact provider marks with a neutral fallback for custom providers.
- Updated the release toolchain lockfile to patched dependency versions; the release candidate reports zero known npm audit vulnerabilities.
- Made annotations one-shot prompt context: capture mode now remains active across additions until Escape, the annotation button, or prompt submission; submitted annotations are snapshotted for immediate, queued, and Steer delivery and then cleared. Markdown files changed during an agent run now refresh in every open Markdown view while preserving the existing scroll-restoration behavior. (#46)
- Added a transient annotation-processing transition: submitted attached ranges and blocks become gray masks with a left-to-right accent sweep until the target file changes or the owning run settles, with deterministic cleanup for rejection, failure, cancellation, queue retrieval/removal, and reduced motion. Processing masks preserve exact annotated character geometry across words and multi-paragraph rendered selections, suppress spellcheck underlines without changing layout, and reveal confidently resolved replacement ranges after atomic edits. Persisted and native selection marks are cleared before processing starts. A prominent sticky **Send to Pi** action supports annotation-only prompts, targeted-edit guidance avoids unnecessary whole-file writes, and paragraph/text annotations now share one subtle background-and-underline design without vertical bars. Dragged source or reading-mode selections suppress the element outline, open the annotation dialog on release, and discard the native selection after saving so it cannot visually override the shared annotation style. (#46)
- Fixed every Markdown editor failing to open with `Unrecognized extension value in extension set ([object Object]). This sometimes happens because multiple instances of @codemirror/state are loaded, breaking instanceof checks.` by externalizing the directly imported `@codemirror/state` and `@codemirror/view` packages. The annotation `ViewPlugin` now uses Obsidian's shared CodeMirror runtime instead of incompatible copies bundled into `main.js`. (#35)
- Added native file attachments with an **Attach files** paperclip and Obsidian vault/local pickers. PNG/JPEG/WebP remain Pi RPC images; bounded UTF-8 text/code/config files are delivered as explicitly delimited untrusted context, persist safely through normal/queued/Steer delivery, and reject unsupported binary formats. (#59)
- Defined the minimum and last-tested Pi versions, added actionable RPC capability fallback diagnostics and fake-RPC compatibility coverage, and added an opt-in offline smoke command plus a dedicated pre-release test-vault checklist. Manual validation remains pending. (#43)
- Added Markdown annotations for attaching change requests and questions to selections or source-backed blocks in editing and reading views, with resilient anchors, active-note prompt context, accessible controls, bounded local storage, and lifecycle-safe persistence. (#46)
- Replaced the model and thinking pickers with Obsidian-native suggestion modals, pinned the friendly resolved Pi default, and serialized stale runtime catalog/state refreshes so startup, save, restart, and transient Pi failures cannot expose an ambiguous default. (#42)
- Added an ordered, persistent local follow-up queue for active runs with one-shot steering, edit/retrieve/removal controls, separate Pi-native queue status, and safe delivery after settlement. Added PNG/JPEG/WebP picker, paste, and drop attachments with accessible previews, model capability validation, and Pi RPC image payloads. (#40)
- Delegated extension, prompt-template, and skill discovery/expansion to Pi RPC so Pi's resource precedence and project-trust decisions remain authoritative; Full agent keeps extension/custom tools, constrained modes keep explicit built-in allowlists, and extension UI requests now use Obsidian dialogs, notices, status, widgets, titles, and composer text. (#39)
- Removed duplicated local history and repeated durable instructions from each user prompt; stable instructions now load once when the Pi runtime starts. (#38)

- Made Pi RPC the source of truth for runtime models, effective defaults, complete model metadata, and supported thinking levels, including sparse maps and `max`; model and thinking overrides now use RPC commands. (#37)
- Replaced per-prompt JSON subprocesses with persistent, per-chat Pi RPC sessions, including strict JSONL framing, correlated commands, restart/error handling, RPC cancellation, and native compaction. (#36)
- Replaced manual JSONL session forking with Pi RPC cloning; added native session naming, stats, tree/entry access, HTML export, and explicit chat-only versus chat-and-local-session deletion. (#41)
- Improved chat UX with synchronized header/list favorites, guarded bulk chat archiving, integrated live and completed thinking disclosures, concise tool activity/errors, and distinct send, queue, cancel, and canceling controls. (#33)
- Followed up on chat polish with solid non-accent favorite stars, a directly visible Archive all action, and compact native live/completed thinking disclosures without the brain icon; live thinking and inline activity retain their reduced-motion-aware animated text sweep. (#33)

## 0.0.8

- Model list now automatically refreshes from the Pi CLI on every Obsidian startup (silent refresh, no notice). This fixes stale model dropdown after restart. (#31)
- Switched chat message rendering to use Obsidian's native `MarkdownRenderer`. Messages now support code blocks (with syntax highlighting), tables, headings, lists, blockquotes, bold/italic, and native `[[wikilink]]` / markdown links. Streaming responses keep the raw-text live typing effect for responsiveness. Improved CSS for rendered content (tables, code, blockquotes). (#27)

## 0.0.7

- Fixed Windows Pi CLI launch quoting when routing through `cmd.exe` on Node.js 24+ (outer quotes for `/s /c` parsing).
- Improved Windows process termination to reliably kill process trees using `taskkill /T /F` (fixes cancel and cleanup for cmd.exe-wrapped launches).
- Added best-effort Pi CLI warmup (`--version` spawn) on plugin load to reduce first-command cold-start latency on Windows (skipped in dry-run mode).

## 0.0.6

- Fixed Windows Pi CLI launches on Node.js 24+ by routing `pi`/`pi.cmd` through `cmd.exe` without Node's deprecated shell-args path. ([#17](https://github.com/ChristianLempa/obsidian-pi/issues/17))
- Updated CI and release workflows to Node.js 24-compatible GitHub Actions. ([#11](https://github.com/ChristianLempa/obsidian-pi/issues/11))
- Added vault prompt-template support for `.pi/prompts/*.md`, including slash-command discovery and Pi-style template arguments. ([#19](https://github.com/ChristianLempa/obsidian-pi/issues/19))
- Removed the built-in change diff/review feature and its related local snapshot tracking code. ([#13](https://github.com/ChristianLempa/obsidian-pi/issues/13))
- Fixed `context show` / `/context show` so it displays the current Obsidian context inspection without calling Pi. ([#12](https://github.com/ChristianLempa/obsidian-pi/issues/12))
- Added favorite stars for chat sessions with favorite prioritization in the thread list. ([#20](https://github.com/ChristianLempa/obsidian-pi/issues/20))
- Made Pi session references portable across synced vaults by storing local session filenames instead of machine-specific absolute paths. ([#18](https://github.com/ChristianLempa/obsidian-pi/issues/18))
- Fixed the context usage badge so Pi-returned token usage is shown even when the model context window is unknown. ([#12](https://github.com/ChristianLempa/obsidian-pi/issues/12))

## 0.0.5

- Added a Pi executable path setting so custom installs such as nix-darwin can point Obsidian directly at the Pi CLI. (#15, #16)

## 0.0.4

- Added support for finding Pi CLI installations that use the `pi-node` launcher on Ubuntu/Debian systems. Thanks @Hatekaharja! (#10)

## 0.0.3

- Simplified context settings by removing user-facing numeric context/change tracking limits and keeping ignored folders/directories as the visible context/file-access control. (#3)
- Changed pre-attached context to avoid automatic broad prompt searches; Pi now starts from current-note, link/backlink, and explicit attachment context while tool-enabled modes can explore further with Pi read/search/list tools. (#3)
- Documented the issue, branch, changelog, and manual release-prep process for future changes. (#3)
- Fixed CI format checks for optional local docs and agent guidance files. (#3)
- Improved Pi CLI dependency diagnostics for missing Pi installs, missing Node runtimes, and startup failures. (#6)
- Added safer Pi subprocess PATH handling for Obsidian GUI launches on macOS and common Node version managers. (#6)
- Updated Pi setup guidance to explain Node/PATH issues when the Pi CLI is installed but cannot run. (#6)
- Started smarter change tracking that snapshots Pi-touched files for Edit mode while keeping full snapshots as a Full agent fallback. (#4)

## 0.0.2

Automated review fixes for Obsidian Community Plugins:

- Added GitHub release notes generated from the current changelog entry.
- Added artifact attestations for supported release assets.
- Removed unsupported release zip uploads from the GitHub release workflow.
- Removed environment-variable reads from plugin source.
- Replaced the source entrypoint's `require()` import with an ES module export.
- Removed CSS `!important` declarations.

## 0.0.1

Initial Pi Agent release:

- Pi chat view inside Obsidian.
- Vault-aware context from current notes, links, backlinks, tags, search results, and selections.
- Skill folder settings and `/skill:name` autocomplete for Pi skills.
- Review mode for read/search-only workflows.
- Edit and Full agent modes for controlled vault/project changes through Pi.
- Chat history and Pi session persistence.
- Change summaries and diff review for edited files.
