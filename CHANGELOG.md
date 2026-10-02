# Changelog

## Unreleased

## 0.0.26 - 2026-10-02

- Fixed six more defects the same audit found: one data-loss path in the annotation store, one in the release tooling, and four things a user could see go wrong - Escape cancelling an answer, a rebuilt view freezing a stream, a background run erasing the visible one, and a blank chat header. Each entry below explains its own defect.
- Stopped Escape from cancelling a running answer. While a completion popup was open in the composer - type `/`, `@` or `#` while Pi is answering - the popup's own Escape handler closed it and let the key bubble, and the document-level listener then read it as "cancel the run" and stopped an answer the user was reading. The composer now asks the popup first through `ComposerSuggestions.isPopupOpen()`, so the first Escape closes the popup and the next one cancels.
- Stopped rebuilding the chat view from freezing the answer that is streaming into it. `lifecycle.dispose()` released the pending animation frame and timers but left their handles on the view state, and every scheduler treats a set handle as "one is already pending" - so after returning from the thread list the streaming text stopped updating until the run ended. The three transient schedulers are now released together with the lifecycle they belonged to.
- Stopped a background thread's run from erasing what you are reading. `settleRunSuccess()` and `settleRunCleanup()` cleared the shared streaming, activity and tool state unconditionally, so a second thread's run finishing wiped the visible thread's stream and its next delta rendered only what arrived afterwards. Both now clear that surface only for the thread they belong to, which also let a real inconsistency be fixed: the cleanup path cleared the buffers but not the streaming elements.
- Started painting the chat header instead of leaving it blank. The header, badge, queue and composer repaints were called from inside the DOM builders, but every one of them guards on its own element (`if (!this.threadTitleEl) return;`) and the builders run before `Object.assign` attaches their results, so the first paint painted nothing and a rebuild painted into the previous round's detached elements: an empty title, a favorite button with no label, hidden context badges, and a restored paused queue whose Resume and Discard buttons never appeared. `renderChatView()` now runs them once, after every element is attached. Same-root fix for the extension widgets and the composer's own height measurement and `is-compact`/`is-narrow` classes.
- Made the annotation store refuse writes it cannot keep. `replacePath()` - the path a queued prompt's annotations are restored through - had no `paths` check, so a restore could write a 501st path that the next load dropped together with the record just restored, and no `perPath` check, so a restore past 100 records was silently truncated. It now rejects both the way `create()` already did, and the write-side byte budget leaves the one byte free that the incremental loader charges, which used to make a store at exactly the limit reload one record shorter.
- Fixed the release-notes extractor truncating a published release body. `extract-release-notes.mjs` stopped the version section at the next `^## ` line without tracking code fences, so a release note quoting a `## ` heading inside a fence produced a truncated body and still exited 0. It now tracks fences, and `tests/release-notes-extraction.test.mjs` covers a backtick fence, a tilde fence and the two failure cases.
- Made `install-dev.mjs` refuse a directory that holds another plugin. It overwrites `main.js`, `manifest.json` and `styles.css` in whatever directory it is pointed at, and pointed at another plugin's folder it replaced that plugin's files with this one, without a backup or a warning. It now checks the target's `manifest.json` id first and refuses anything that is not `pi-agent`, including an unreadable manifest.
- Fixed the annotation picker in a popout window. `closestLineElement()` tested `target instanceof Element`, which is false for an element from the popout's realm, so the hover highlight and the empty-selection block pick did nothing there. It now narrows by the `closest` method the call site uses, as the code did before `3ba2191`.

## 0.0.25 - 2026-10-02

- Fixed the wording of the startup report for annotations whose note is no longer in the vault: the 0.0.24 message read "1 annotation on 1 note no longer in the vault are still stored", with a plural verb and an ambiguous subject. It now reads "1 annotation is still stored for 1 note no longer in the vault. Move those notes back to their original paths to use them again.", with the verb and the subject agreeing for one record or many. This was found by driving the deployed 0.0.24 build in a live vault through the Obsidian CLI: a partial rename retained one record on a path without a note, `orphanedAnnotationPaths()` reported that path, and the rendered Notice showed the broken sentence. `tests/annotation-rename-notice.test.mjs` now pins the singular and plural wording separately.

## 0.0.24 - 2026-10-02

- Stopped renamed notes from stranding their annotations. `AnnotationStore.renamePath()` was all-or-nothing: it moved a note's records only when the whole set fit the destination, which `create()` cannot reach because the destination is already capped at `ANNOTATION_LIMITS.perPath`, an id repeats, or the serialized byte budget would be exceeded. A rename to an occupied path therefore left every record on a path with no note: invisible to every flow that reads annotations by path, and still counted against the totals the store enforces, with a Notice as the only trace and no lifecycle step that could ever reclaim them - the probe test `tests/annotation-rename-stranded-records.test.mjs` pinned exactly that, down to the persisted `data.json` and the capacity the records kept consuming. `renamePath()` now appends whatever fits after the destination's own records, which are never dropped or reordered, and returns what actually happened (`status`, `ok`, `moved`, `droppedDuplicates`, `retained`, `reason`) instead of a boolean, so a caller can report the difference instead of guessing. What does not fit stays exactly as it was, which makes the retention recoverable: a later rename of the same path moves the records the destination now has room for. A record whose id the destination already holds is the same annotation arriving twice and is the only thing dropped, counted as `droppedDuplicates`; the storage budget is now searched for the largest prefix a move can persist rather than refusing the whole move, and when not even the destination's own records fit it, the store leaves both paths untouched and reports `storage` instead of throwing.
- Told the user what a rename actually did, and surfaced the records a note no longer owns. The vault `rename` handler is now `handleVaultRename()`: a non-markdown file and a note without annotations report nothing, a complete move is silent, duplicate drops say the destination already carried them, and a refused or partial move names the retained count and the destination note's own ceiling as the cause, one line shorter in the common all-retained case because the counts already carry it. New `AnnotationStore.orphanedAnnotationPaths()` names the paths whose records no longer have a note, and the plugin reports that count once per load, without deleting anything: a missing note can be a rename, or a vault that is still indexing, and moving the note back to its path brings the records straight back. The store-level probe test was rewritten as an 11-case regression test covering the baseline, the partial move, the full destination, duplicates, persistence through `data.json`, the capacity the retained records keep using, the reclaim path, and the orphan report, and `tests/annotation-rename-notice.test.mjs` drives the plugin's rename handler and startup report through the real plugin prototype and the real store.
- Fixed a run being served by a session it did not ask for. A run's session is fixed when its Pi process is launched (`buildPiArgs()` passes `--session <path>`), but `getOrCreateRpcClient()` recorded that binding with `this.rpcSession ??=`, so from the second call on a different reference was discarded and the bound session returned instead: `runPiRpc()` reported it back as the run's `sessionId`, the plugin persisted it as `thread.piSessionId`, and the requested session was never opened. `runPiRpc()` now releases a client bound to a different session before asking for one, comparing references through `resolveSessionPath()` rather than `resolveOrCreateSession()` - the latter mints a session file for an absent reference and would report it as a different session. The same mismatch was fixed on the `/compact` path, which went straight to `getOrCreateRpcClient(sessionId)` and performed session B's compact in session A's process, reporting A back as the run's `sessionId`. Session lookups that address another session by parameter (`cloneSession()`, `setSessionName()`, `exportSession()`, ...) keep reusing the client the thread already owns.
- Fixed a timed-out prompt's abandoned Pi task polluting the next run. A timed-out `prompt` request is only a local give-up: the client never asks Pi to stop, so the task keeps running, and its late `agent_settled` arrived on the client that the next run on the same thread had subscribed to, which then returned the abandoned task's answer while its own task was still running. The local timeout is tagged (`PI_RPC_TIMEOUT` / `isPiRpcTimeoutError`) and, for that failure only, `PiRunner.runPiRpc()` gives up its client before rethrowing, so the next run reopens the same thread session from disk; cancel and dead-process failures keep their existing behaviour and their reusable client.
- Fixed the real-child-process tests so they pass on Windows and Linux alike.
- Added a test for a chat renderer's thinking behaviour, and stopped another from pinning that renderer's source formatting.

## 0.0.23 - 2026-10-02

- Stopped a running chat from losing Pi's last events when a replacement process started during an exit. The RPC client kept its stdout parser and cooperative drain in one set of client-level fields - `stdoutBuffer`, `decoder`, `stdoutEnded`, `drainPending`, and `drainPromise` - and `start()` reset all of them for every new child, so a Pi process that still had complete buffered lines lost them the moment a request spawned a replacement while that process was closing: the trailing `agent_message` events were dropped before any listener saw them, the old drain stopped on a generation check instead of draining its own buffer, and `rpc_exit` still looked like an ordinary process exit. Each child now owns a `PiRpcStreamState` (generation, buffer, decoder, stdoutEnded, drainPending, drainPromise): `start()` builds the new child's state without touching the state of the child it replaces, the stdout data and end handlers close over their own state, a drain finishes its own buffer no matter which child is current, `whenDrainIdle()` waits on the drain it was handed, and the close handler reports the exit only after its own child has drained, so a replaced child's trailing events arrive in order before its `rpc_exit` instead of disappearing. A late stdout `end` from a replaced child can no longer mark the replacement child's stream as ended, and request ownership still follows the child generation, so an exit fails only the requests that the exiting child owned.

## 0.0.22

- Stopped a failed Pi RPC write from crashing instead of failing one request. A rename, abort, or notification that races a Pi process which exits right after the client starts writes to a closed pipe, and Node reports that single EPIPE twice: to the write callback, which rejected exactly the request that lost the race, and as an `error` event on `child.stdin`, which had no listener and was therefore rethrown as an uncaught exception in the host process. `PiRpcClient.start()` now owns that event and records the reason on `stdinError` (cleared whenever a replacement child starts), so the request fails, the child's close handler still reports `Pi RPC process stopped`, and nothing escapes into Obsidian or the test runner. This was the unhandled `write EPIPE` raised by `tests/thread-rename-runner-lifecycle.test.mjs`, and it is now pinned by `tests/rpc-client-stdin-error.test.mjs`, which drives the request, `notify()`, and restart paths against a real failing `Writable` so the callback and the event arrive through Node's own machinery.
- Fixed the formatting that failed `format:check` in every CI and release run since `cc87f8e`: `tests/plugin-unload-lifecycle.test.mjs` and `tests/rpc-client-restart-race.test.mjs` were committed unformatted and are now reflowed to the repository's 100-column style.
- Kept chat history recoverable when the stored plugin data or a backup snapshot is damaged. A JSON parse failure in `data.json` is now treated as damaged data (one warning, default settings) instead of rejecting `loadSettings()` and ending `onload()` before the valid local backup could be read, while a missing file, a permission failure, or any other I/O error still propagates because continuing with defaults would hide a vault the plugin cannot read. A temporary snapshot is now named with a random UUID: `tmp-<pid>-<Date.now()>` let writers in the same millisecond share one path, and a 4-writer probe reproduced 113 collisions and 17 rounds that published a truncated mixture with no previous generation to fall back on.
- Made chat imports and cleanup report what actually happened: `pi_sessions/index.json` is read directly instead of being pre-checked with `access()`, so an unreadable index becomes a warning that keeps the chats already read instead of looking like an all clear, the legacy `migration-backup-v0.json` probe reports only `ENOENT` as absent, and a failed temporary-file cleanup can no longer turn a successful save into a failure or replace the error that made a write fail.
- Fixed Pi runs being reported as ordinary failures while the plugin unloads. `onunload()` cancelled the service runner while chat runs execute on per-thread runners that were then disposed mid-flight, which surfaced as `Agent run failed: Pi RPC client disposed.` plus an error notice; unload now aborts every runner that is actually executing before it releases anything, and disposal is terminal, so a disposed runner reports `Pi run canceled.`, settles a run waiting for a final event, and refuses to spawn Pi again. The chat view also releases its `document` keydown handler and its workspace `file-open` and `active-leaf-change` references when the view closes, so a closed view no longer leaves handlers registered alongside the next one's.
- Released the service runner that a rebuild replaces. `rebuildServices()` overwrote `this.pi` without disposing the runner it replaced, and because the service runner is deliberately not tracked in `threadRunners`, every settings save, pending rebuild, or service restore could leave another Pi process running with nothing left to stop it.
- Stopped idle Pi processes leaking from thread lifecycle paths. Archived and deleted threads release their runner through one rule that leaves a running runner alone (archiving a running thread is refused, bulk archive reports the skipped ids, and clearing archived threads deletes only threads with no run in flight), forking a running thread is refused in the plugin as well as in the UI, and Session Info, export, session tree, session entries, rename, and fork borrow an ephemeral runner released in a `finally` instead of registering a cached one, which had left one idle Pi process per inspected, renamed, or forked thread.
- Took the thread list's Pi session counting off the render path: `renderThreadList()` read and parsed every referenced session synchronously inside the row loop, blocking Obsidian for about 352 ms on a 100 MB session and about 3.0 s for a 20-thread list. Counts now come from a path-keyed cache validated against file size and mtime and are filled afterwards by a streaming, deduplicated scan capped at two concurrent reads, which renders a 20-thread list with 10 large sessions in 0.5 ms and holds the longest event-loop slice during a 256 MB scan to about 18 ms, with row repaints guarded by a render generation.
- Fixed an RPC restart race and the unhandled rejection around it: pending requests are now owned by the child generation that created them and an exit event fails only that generation, so a close or error callback arriving after a replacement child started cannot reject requests the replacement already owns, and the run completion promise claims its rejection as soon as it exists because an `rpc_exit` arriving while the prompt request was still pending made Node report an unhandled rejection even though the run settled correctly.
- Brought `PiAgentView` back under `checkJs` by describing its runtime mixin composition as a type cast instead of a file-wide `@ts-nocheck`. The class could not see any of the 60 members its seven mixins add at runtime, which was 105 type errors, and no member may be declared in the class body because a field declaration creates a real instance property and shadows the mixin method with `undefined`, the live `this.clearCoalescedActivity is not a function` crash; the emitted bundle is otherwise byte-identical.
- Added regression coverage for restoring a queued prompt into the view's documented state object, so a drift back to the old `this.promptQueue`, `this.running`, `this.composerImages`, and `this.composerAttachments` instance fields fails a test instead of shipping silently. The cases drive the real `retrieveQueuedPrompt`, `removeQueuedPrompt`, `renderPromptQueue`, and `submitInput`, and one static guard rejects stale `this.<field>` access anywhere else in the file.
- First published release since 0.0.20. The 0.0.21 cycle was tagged, but its release run stopped at that formatting gate, so GitHub never received a 0.0.21 release; 0.0.22 ships those changes for the first time, together with the two fixes above.

## 0.0.20

- Fixed Pi failing to start on Windows with `Cannot find module '...\pi-launcher.js'` when no Pi executable path was configured: the launcher is now resolved to an absolute `pi.cmd` path through `PATH` (plus the pi.dev installer and npm global locations) before it is handed to `cmd.exe`, so Pi's own `node "%~dp0pi-launcher.js"` wrapper no longer resolves its script against the plugin's working directory.

## 0.0.19

- Split the chat view into focused modules. `PiAgentView` was a single class of 1,269 lines whose DOM building, prompt stages, run teardown, and attachment handling all had to be read together to change any one of them. It is now 549 lines that orchestrate six modules, with no element creation left in it, all five plan targets met, and no behaviour change.
- Moved the chat view's transient state onto one documented object, so a field has one definition and one type instead of being spread across the instance next to the methods that use it.
- Gave the chat view one lifecycle for its timers, animation frames, and cleanups, so a rebuilt view can no longer leave an old timer to fire against the new DOM.
- Removed the class fields that were shadowing the view's mixin methods with `undefined`, which had crashed the view with `this.clearCoalescedActivity is not a function`.
- Enabled `checkJs` for `src/`, so a misspelled field or a wrong argument is a build failure instead of a runtime surprise inside a stream callback.
- Removed the retired dry-run mode, including its always-false settings branch and the unreachable non-RPC run path it kept alive. The `/context` diagnostic output no longer reports `run.dryRun`.
- Consolidated process termination into one shared helper, so a cancelled run always tears down the Pi process tree the same way.
- Routed timers, animation frames, and performance timing through the active window, so a chat view in a popout window measures and schedules correctly.
- Made reasoning labels come from the translation dictionaries only; the English fallback labels no longer live in a second hard-coded map.
- Made the Obsidian stress test's cancel check cancel a run that is genuinely mid-stream. It required 1,500 ms of live run time, which a local model never reaches, so the check failed on every release; it now asserts the property it is named for and passes reliably, which is what brings the end-to-end suite to 20/20.
- Extended the translation key test to fail on unused keys and mismatched placeholders, not just missing keys. The suite grew from 363 to 373 cases.
- Removed repository documentation files (README, PRIVACY, TESTING, RELEASE, AGENTS).

## 0.0.18

- Localized the settings tab and the dialogs it opens (model picker, thinking picker, write-tool confirmation, and Pi setup) so they follow Obsidian's app language, including Simplified Chinese.
- Localized the chat header and composer controls, the tool mode picker, the thread list, and the single and bulk chat deletion dialogs; new chats now take their default title from the active language.

## 0.0.17

- Kept Obsidian responsive during long agent runs: RPC output now drains cooperatively in bounded batches instead of blocking the main thread for seconds during full-vault scans.
- Reworked streaming rendering to plain text with per-frame coalescing, so live answers no longer re-render Markdown for every delta; the final answer is rendered once in Markdown when the run ends.
- Coalesced tool activity updates and added run/thread generation guards so fast tool progress cannot update a stale chat or run.
- Fixed opening the Pi view in a vault without a configured model, which failed with `e.startsWith is not a function`; the model control now shows a neutral AI mark.
- Fixed Windows tool modes and custom instructions: multi-line system prompts are passed to Pi through a file, so `cmd.exe` no longer truncates them and drops `--tools`, `--skills`, and related arguments. Review mode is now truly read-only.
- Added performance instrumentation (queue depth/bytes, streaming/activity/Markdown counters, heap samples), synthetic regression tests for the drain and streaming pipelines, and a 10,000-note benchmark.

## 0.0.16

- Doubled the composer input height and made the current-note context chip removable; the note is re-attached after opening another note or switching chats.
- Added a tool mode picker (Chat / Review / Edit / Full agent) to the composer bar with distinct per-mode icons and the same write-risk confirmation as the settings tab.
- Show the full model name in composer pickers instead of a fixed-width ellipsis, and keep descenders (g/y/p) fully visible in control labels.
- Removed the color and font-weight accents from the Edit and Full agent tool mode labels.
- Normalized the repository to LF line endings and fixed Windows-only quality gate failures so `npm run ci` passes on both Windows and Linux.

## 0.0.15

- Replaced broad annotation `:has()` selectors and avoidable `!important` overrides with native sibling selectors and narrowly scoped specificity, preserving keyboard focus, selected intent, and processing-mask behavior. (#85)

## 0.0.14

- Discover Pi extensions, prompt templates, skills, and their commands when the plugin starts, while keeping slash suggestions responsive and preventing stale discovery from reopening or replacing the active picker. (#80)
- Kept the current model and thinking labels visible in compact composers, with wrapping and ellipsis for narrow sidebars. (#82)
- Sanitized Pi extension status, widget, and title text; kept extension status in one bounded row with independently truncated, accessible per-extension entries; and added a persisted **Show extension status** toggle that applies without restarting RPC. (#83)

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
