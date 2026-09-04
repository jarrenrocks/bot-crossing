# Codex CLI adapter investigation

This document records the evidence used for the Codex CLI harness adapter. No private transcript content, credentials, or personal conversation data is included.

## Repository architecture

- `server/harnesses/index.mjs` is the registry. A registered adapter supplies `id`, `name`, `detect`, `scanThreads`, `openThread`, `newSession`, and `setArchived`; `appStartedAt` is optional.
- `server/scan.mjs` asks each detected harness for normalized threads, isolates adapter failures, adds harness identity, and sorts the merged result. The browser requests `/api/threads` at boot, every 15 seconds, on window focus, and when a hidden tab becomes visible.
- `server/api.mjs` exposes the merged data and delegates open/archive requests to the originating adapter. The existing opener uses macOS `open(1)` with a URL returned by an adapter.
- The browser consumes the normalized shape rather than harness-specific records. Colony layout/archive state is separate from a harness's own archive state.
- `server/lib/fsutil.mjs` provides bounded head reads, tolerant JSONL parsing, directory listing, and existence checks.

The normalized fields are documented in `server/harnesses/README.md`. Important behavioral fields include globally unique `id`, timestamps in epoch milliseconds, exact `sizeBytes`, capability flags, and an opaque `ref` returned to the adapter.

## Codex storage findings

Read-only inspection of an installed Codex extension found:

- Sessions under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
- An optional `~/.codex/session_index.jsonl`, with records containing `id`, `thread_name`, and `updated_at`.
- Transcript envelopes shaped as `{ timestamp, type, payload }`.
- `session_meta` provides a session identifier, creation timestamp, working directory, and sometimes Git metadata.
- `turn_context` provides current working directory, model, and effort.
- User messages are `response_item` records whose payload is a `message` with role `user`.
- Lifecycle records are `event_msg` payloads including `task_started`, `task_complete`, and `turn_aborted`.
- Installed CLI help verifies `codex resume [SESSION_ID]`. Inspection of the installed OpenAI VS Code extension also verifies its registered URI handler and `/local/:conversationId` route.

## Implemented mapping

`server/harnesses/codex-cli.mjs` discovers every dated rollout file and returns one thread per valid session:

- Title prefers the session index, then the first user message, then `Untitled thread`.
- Preview is a whitespace-normalized, length-limited first user message.
- Project path is the nearest ancestor containing `.git`, falling back to the recorded working directory.
- Model, effort, branch, and creation time come from transcript metadata when present.
- Transcript size is the file's exact stat size. Activity is the newer of transcript mtime and index update time.
- A thread is running only when the latest lifecycle record is `task_started` and activity is less than five minutes old. This is deliberately an inference: Codex exposes no verified process-to-session mapping.
- A latest `turn_aborted` marks `hasError`; unread is always false because Codex focus/read state is unavailable.
- Parsing reads bounded head and tail chunks, caches unchanged files, skips malformed records, and never writes Codex data.

## Known limitations

- Sessions with UUID thread IDs can open in the installed OpenAI VS Code extension through its verified `vscode://openai.chatgpt/local/<thread-id>` route. The server hands this route to Windows through PowerShell when running under WSL, to `open(1)` on macOS, or to `xdg-open` on native Linux.
- Creating sessions is disabled for the same reason.
- Native archiving is disabled (`canArchive: false`) because no Codex archive field or supported mutation was found. Bot Crossing's own colony archive state remains separate.
- Running and error states are conservative transcript-based inferences, not direct process state.
- Worktree identity and focus/unread state are unavailable from the verified records.
- Session scanning works with the verified Linux/WSL storage path. Codex thread opening is supported in Windows VS Code from WSL; other cross-platform harness handoffs remain dependent on their registered URI handlers.

The selected-thread card displays the adapter's generic `harnessName`, so Codex and Claude sessions are distinguishable without adding harness-specific frontend branches.

## Validation

The adapter has fixture-based tests for normalized metadata, project-root discovery, exact sizing, recent/old lifecycle state, aborted state, malformed JSONL, missing storage, and unsupported actions. Run them with `npm test` or directly with `node --test server/harnesses/codex-cli.test.mjs`.
