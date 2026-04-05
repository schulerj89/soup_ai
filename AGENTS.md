# AGENTS.md

## Purpose

Soup AI is a local-only Telegram supervisor for Windows. It polls a private Telegram bot, stores operational state in SQLite, uses OpenAI models for planning, direct replies, memory summarization, and audio transcription, and uses `codex exec` to perform local repo or workspace work inside one approved workspace root.

The repo is designed around a single-owner, private automation model:

- Telegram is the user interface.
- SQLite is the source of truth for messages, jobs, tasks, leases, and conversation state.
- `supervisor:serve` is the long-running production loop.
- Codex work is backgrounded and single-flight by default in the persistent supervisor.

## Environment And Runtime Assumptions

- Platform: Windows-first.
- Node.js: `25+`.
- Module system: ESM (`"type": "module"`).
- Database: built-in `node:sqlite` via `DatabaseSync`.
- Secrets and local settings live in `.env` and must never be committed.
- The configured workspace boundary is `SUPERVISOR_WORKSPACE_ROOT`.

When making changes, preserve the local-only and workspace-bounded behavior unless the user explicitly requests a broader scope.

## Key Entry Points

- `README.md`: product overview, setup, commands, and operator expectations.
- `src/cli/setup.js`: interactive setup flow.
- `src/cli/supervisor-once.js`: one-shot processing loop.
- `src/cli/supervisor-serve.js`: persistent supervisor loop with retries and keep-awake handling.
- `src/services/supervisor-service.js`: orchestration for ingestion, jobs, outbound delivery, queue startup, lease handling, and abandoned-work recovery.
- `src/services/message-processor.js`: routing boundary for slash commands, direct replies, and Codex execution.
- `src/tools/`: Codex process execution, command building, result parsing, and status tracking.
- `src/openai/`: planning, direct supervisor behavior, summarization, transcription, and session helpers.
- `src/db/`: schema and store methods.
- `src/telegram/telegram-client.js`: Telegram API access.
- `test/`: node:test coverage for service behavior and regression protection.

## Architecture Notes

### Supervisor Lifecycle

`supervisor:serve` constructs the DB, Telegram client, OpenAI-backed helpers, and Codex runner, then repeatedly calls `SupervisorService.runOnce()`. That loop is the main production path and should stay robust under retries, crashes, and restarts.

### Message Flow

The normal path is:

1. Telegram updates are ingested into SQLite.
2. Jobs are queued from inbound messages.
3. `MessageProcessor` decides whether to handle a slash command, answer directly, or queue/run Codex work.
4. Replies are sent through the outbound queue.

Preserve that separation. Avoid coupling Telegram transport, planning, and Codex execution more tightly than they already are.

### Background Codex Execution

This repo treats Codex execution as tracked task work, not just raw shell output. Important invariants:

- In `supervisor:serve`, background Codex tasks are enabled automatically.
- Codex concurrency is intentionally limited to one at a time.
- Task state and active Codex telemetry are persisted in SQLite.
- Crashed or abandoned runs are recovered on the next service cycle.

Changes in this area need tests because regressions are easy to miss and can corrupt operational state.

### Database Compatibility

`AppDb` runs the base schema and then performs additive column backfills in `ensureSchemaColumns()`. Prefer additive, backward-compatible schema evolution. Do not assume a clean database or require destructive resets for normal upgrades.

## What Kinds Of Changes To Look For

An agent maintaining this repo should bias toward these classes of improvements:

- Reliability fixes in lease handling, crash recovery, retries, task state transitions, and outbound delivery.
- Routing fixes where direct replies vs. Codex execution are chosen incorrectly.
- Prompting and planning improvements that make Codex tasks more explicit, bounded, and verifiable.
- SQLite persistence fixes, especially anything affecting messages, jobs, tasks, notes, or conversation state.
- Telegram ingestion fixes, including command parsing, chat allowlisting, media handling, and transcription.
- Operator UX improvements in `/status`, `/tasks`, `/memory`, `/reset`, setup, and diagnostics.
- Safer config handling in `.env`, setup scripts, and scheduler scripts.
- Test coverage for bugs before or alongside code changes.

## What To Preserve

- Keep replies concise and operational.
- Keep local machine work inside the configured workspace root.
- Keep `.env` edits careful and non-destructive.
- Keep background Codex execution observable through tasks and active-run telemetry.
- Keep Windows scheduler support functional.
- Keep the repo Windows-oriented unless the user explicitly asks for cross-platform support.

## Change Strategy

Start by identifying which layer the requested behavior belongs to:

- CLI/setup issue: `src/cli/`
- Runtime orchestration issue: `src/services/supervisor-service.js`
- Planning/routing issue: `src/services/message-processor.js` or `src/openai/`
- Codex execution issue: `src/tools/`
- Persistence issue: `src/db/`
- Telegram transport or ingestion issue: `src/telegram/` or `src/services/supervisor-service/`

Prefer small, bounded changes that preserve existing behavior everywhere else. If a bug touches task state, background execution, or DB persistence, inspect related tests first because those areas have strong behavioral expectations.

## Testing Expectations

Before finishing a change:

- Run targeted tests for the affected files when possible, for example `node --test test/message-processor.test.js`.
- Run `npm test` for changes that affect shared flows, DB behavior, task execution, or orchestration.
- Run `npm run lint` for code changes.

If you cannot run verification, say so clearly.

When adding or fixing behavior, prefer updating or adding tests under `test/` to lock the behavior down. The repo already has good coverage for:

- `MessageProcessor`
- `SupervisorService`
- Codex runner and process behavior
- SQLite session and DB behavior
- Telegram ingestion and client behavior

## Editing Conventions

- Follow existing ESM style and current formatting patterns.
- Stay consistent with the repo's direct, minimal naming style.
- Avoid introducing new framework dependencies unless they are clearly justified.
- Keep comments sparse and useful.
- Do not commit secrets, generated SQLite files, or local environment state.

## Git Workflow

Do not work directly on `main` for fixes or features unless the user explicitly asks for that. Use a short-lived branch.

Recommended branch names:

- Bug fix: `fix/<short-topic>`
- Feature: `feature/<short-topic>`
- Refactor: `refactor/<short-topic>`
- Docs-only: `docs/<short-topic>`

Recommended workflow:

1. Check the current state with `git status --short --branch`.
2. Update local `main` first if the task requires it and it is safe to do so.
3. Create a branch from `main`, for example `git switch -c fix/telegram-status-format`.
4. Make focused changes for one concern.
5. Run relevant verification before committing.
6. Commit with a concise message that states the behavior change.

Useful commit styles:

- `fix: recover abandoned codex tasks on startup`
- `feat: add status details for active codex output`
- `refactor: simplify supervisor lease renewal flow`
- `docs: clarify telegram setup steps`

If the user asks for commit and push:

1. Verify the working tree with `git status --short`.
2. Commit only the intended files.
3. Push the branch with upstream, for example `git push -u origin fix/telegram-status-format`.
4. Do not merge to `main` unless the user explicitly asks.

## Git Safety Rules

- Never discard unrelated user changes.
- Never use destructive git commands like `git reset --hard` unless explicitly requested.
- Prefer non-interactive commands.
- If the worktree is dirty, isolate your changes and leave unrelated edits alone.
- If you find unexpected changes in files you need to edit, read them carefully and adapt instead of reverting them.

## Operational Risks To Watch

Be careful in these areas because small mistakes can have broad effects:

- lease acquisition and renewal
- task state transitions
- active Codex run tracking
- SQLite schema changes
- `.env` setup and parsing
- Telegram allowlist enforcement
- output truncation and task result summaries
- recovery of abandoned jobs and Codex processes

## Default Definition Of Done

A maintenance task is usually done when:

- the requested behavior is implemented or the bug is fixed,
- existing invariants are preserved,
- relevant tests pass or the verification gap is explicitly reported,
- the change is scoped to a focused branch,
- and the final summary explains what changed, what was verified, and any remaining risk.
