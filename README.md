# Pi Agent

Chat with [Pi](https://pi.dev) inside Obsidian, using your notes as context. The
plugin talks to the Pi CLI over its RPC protocol, so the agent can read the
current note, links, backlinks, tags, search results, and explicit `@note`,
`#tag`, `/command`, skill, and file attachments.

Desktop only (`Platform.isDesktopApp`). Requires a working `pi` executable.

## Install

1. Copy this folder into `<vault>/.obsidian/plugins/pi-agent/`.
2. Enable **Pi Agent** under Settings → Community plugins.
3. Open the plugin settings and press **Check Pi installation** if the chat view
   reports that Pi was not found.

The plugin ships as two files, `main.js` and `manifest.json`, plus `styles.css`.

## Development

```bash
npm ci
npm run build        # bundles src/main.js -> main.js (committed)
npm run dev:install  # copies the built plugin into a vault for manual testing
npm test             # vitest, 60 files
npm run ci           # the full quality gate, see below
```

`npm run ci` is the single gate used by CI and should pass before every commit.
It runs, in order:

| Step          | Command                        | What it protects                                         |
| ------------- | ------------------------------ | -------------------------------------------------------- |
| Build         | `npm run build`                | `main.js` is generated from `src/`, never edited by hand |
| Freshness     | `npm run build:check`          | A stale committed bundle fails the build                 |
| Format        | `npm run format:check`         | Prettier, including the generated bundle                 |
| Lint          | `npm run lint`                 | ESLint over `src`, `scripts`, `tests`                    |
| Obsidian lint | `npm run lint:obsidian:errors` | Platform rules (timers, popout windows, UI text)         |
| Types         | `npm run typecheck`            | `tsc --noEmit`                                           |
| Tests         | `npm test`                     | Vitest unit and synthetic performance tests              |
| Version       | `npm run version:check`        | `package.json`, `manifest.json`, `versions.json` agree   |

### Architecture

| Area        | Modules                                       | Responsibility                                                                                                                                                                                                                                                                                                          |
| ----------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry       | `src/main.js`, `src/plugin/PiAgentPlugin.mjs` | Plugin lifecycle, commands, settings, thread and annotation wiring                                                                                                                                                                                                                                                      |
| Pi runtime  | `src/pi/`                                     | `rpc-client.mjs` owns one Pi process and the LF-delimited RPC protocol; `runner.mjs` turns a prompt into a run; `events.mjs` + `run-state.mjs` normalize the event stream; `environment.mjs`, `health.mjs`, `diagnostics.mjs` handle discovery and failure reporting; `yield-scheduler.mjs` keeps the drain cooperative |
| Chat UI     | `src/ui/`                                     | `PiAgentView.mjs` hosts the view; `message-renderer.mjs`, `run-activity-state.mjs`, `prompt-queue.mjs`, `thread-list-view.mjs` and friends are mixed into the view prototype; `modals/` holds dialogs                                                                                                                   |
| Context     | `src/context/`                                | `context-builder.mjs` assembles the prompt packet; `vault-graph.mjs` walks links and tags; `skills.mjs`, `slash-commands.mjs`, `prompt-references.mjs` resolve explicit references                                                                                                                                      |
| Threads     | `src/threads/`                                | `thread-store.mjs` (in-memory model), `chat-history-backup.mjs` and `chat-history-import.mjs` (storage and migration)                                                                                                                                                                                                   |
| Annotations | `src/annotations/`                            | Anchoring a selection to note text, storing it, and rendering decoration in both editing and reading mode                                                                                                                                                                                                               |
| Shared      | `src/shared/`                                 | `runtime.mjs` (window, timers, IDs), `process-tree.mjs` (subprocess teardown), `i18n/`, `frontmatter.mjs`, `paths.mjs`, `text.mjs`, `performance-profiler.mjs`                                                                                                                                                          |

Data flow for one run: the view builds a prompt and context →
`PiAgentPlugin.runPiPrompt` → `PiRunner.run` → `PiRpcClient.request("prompt")` →
Pi streams JSONL events → `handlePiEvent` normalizes them into `RunState` and
callbacks → the view coalesces them into DOM updates.

### Data and permissions

- Plugin data (`data.json`) holds settings, thread history, and annotations.
- Pi sessions live in `pi-sessions/` inside the plugin folder.
- The plugin spawns the Pi CLI and passes tool modes through to it. **Tool modes
  are not an OS sandbox**: Edit and Full agent can modify vault files, and Full
  agent can run shell commands.

## Known limitations

- The test suite cannot run where forked workers are unable to open IPC pipes
  (some sandboxed or containerized shells). Vitest then reports every file as
  "child process was torn down or never initialized" before any assertion runs.
  Run `npm test` on a normal machine or CI runner for the real result.
- `/context` reports the run's model, reasoning, and tool mode. It
  intentionally no longer includes a dry-run field, since the dry-run mode was
  removed.
- `data.json` may still contain retired settings (`dryRun`, `maxSearchResults`,
  `maxSearchFiles`, `maxFileChars`, `maxChangeSnapshotFiles`). They are ignored
  on load and kept only so old files keep opening.
- The test suite is the only automated check of UI behavior: there is no
  Obsidian-level integration test, so changes to layout or platform APIs need a
  manual pass in a real vault.
