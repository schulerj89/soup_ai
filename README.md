# Soup AI

`Soup AI` is a local-only Telegram supervisor for Windows. It polls a private Telegram bot, stores state in SQLite, uses OpenAI to decide whether to answer directly or run local work, and hands repo or machine tasks to `codex exec` inside one approved workspace root.

## What it does

- Polls Telegram updates on each run and inserts inbound messages into SQLite
- Accepts plain text, voice notes, and audio attachments
- Transcribes audio locally through the OpenAI transcription API before processing
- Uses an execution planner to choose `answer_directly` or `run_codex`
- Answers direct questions through the OpenAI Agents SDK, with hosted web search available for current topics
- Runs local work through `codex exec` and stores task records plus tool-run details
- Summarizes older chat context into compact session memory
- Retries outbound Telegram delivery on later runs if sending fails
- Uses a lease so overlapping scheduler runs do not process the queue at the same time
- Recovers abandoned running jobs/tasks if a prior run died mid-execution

## Requirements

- Windows with Task Scheduler
- Node.js `25+`
- `codex` on `PATH`
- Telegram bot token
- OpenAI API key

## Setup

```powershell
npm install
npm run setup
```

`npm run setup` opens an interactive terminal setup wizard, writes `.env`, and initializes the SQLite DB. In non-interactive environments it falls back to the prompt-based setup flow. The setup process collects:

![Soup AI setup wizard](./docs/soup_ai_setup.png)

- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_CHAT_IDS`
- `SUPERVISOR_WORKSPACE_ROOT`
- `OPENAI_MODEL`
- `OPENAI_MEMORY_MODEL`
- `OPENAI_TRANSCRIPTION_MODEL`
- `SUPERVISOR_DB_PATH`
- `CODEX_BIN`
- `CODEX_ENABLE_SEARCH`

See [docs/telegram.md](./docs/telegram.md) for the bot token and chat ID workflow.

After setup, send your bot a Telegram message or voice note from an allowed chat so Soup AI has something to ingest and process.

```powershell
npm run supervisor:once
```

That single run polls Telegram, downloads and transcribes supported voice/audio messages, processes text requests, and sends queued replies.

For normal use on Windows, run the persistent background mode instead:

```powershell
npm run supervisor:serve
```

That keeps a local process alive, long-polls Telegram, and reacts to new messages with much lower latency than a once-per-minute scheduler tick.

If that works, register the scheduled task:

```powershell
npm run task:register
```

The registration script now creates explicit Task Scheduler settings instead of relying on `schtasks` defaults:

- allows runs on battery power
- sets a working directory for the task action
- starts at logon and stays running in the background
- prefers background `S4U` logon under your current user account
- falls back to a basic `schtasks` registration with a warning if Windows blocks the richer task profile

## Useful commands

```powershell
npm run discover:telegram
npm run inspect:codex
npm run send:message -- --text "Manual outbound test"
npm run supervisor:once
npm run supervisor:serve
npm run task:register
npm run task:stop
npm run task:unregister
npm test
```

## Telegram commands

- `/help` replies with the built-in command list.
- `/health` is an alias for `/status`.
- `/status` replies with the current supervisor snapshot:
  - pending and running job counts
  - pending outbound message count
  - running task count
  - active Codex telemetry when a local run is in progress, including task ID, PID, title, start/timeout times, stdout/stderr byte counts, last output time, and the last output file path
  - current conversation state for that chat, including generation, active conversation ID, and the last reset timestamp and reason
- `/tasks` shows the five most recent tracked tasks with status and result summary.
- `/memory` shows the current conversation memory summary, durable facts, durable profile, and recent notes for the chat.
- `/reset` archives the current conversation, starts a fresh one, and preserves curated memory for reseeding.

Anything else is treated as a supervisor request. Soup AI either replies directly or starts a Codex task and posts a follow-up summary when it finishes.

Example status reply:

```text
Soup AI health
pendingJobs: 0
runningJobs: 0
pendingOutbound: 0
runningTasks: 1
activeCodexTaskId: 77
activeCodexPid: 4321
activeCodexTitle: Inspect repo state
activeCodexStartedAt: 2026-04-02T22:42:13.746Z
activeCodexTimeoutAt: 2026-04-02T22:57:13.746Z
conversationGeneration: 0
activeConversationId: conv_1
lastResetAt: (never)
lastResetReason: (none)
```

## Configuration

- `.env.example` shows the supported environment variables
- `SUPERVISOR_WORKSPACE_ROOT` is the hard boundary for local Codex work
- `SUPERVISOR_DB_PATH` defaults to `./data/soup-ai.sqlite`
- `OPENAI_MODEL` is used for planning, direct replies, and Codex result summaries
- `OPENAI_MEMORY_MODEL` is used by the session summarizer and falls back to `OPENAI_MODEL`
- `OPENAI_TRANSCRIPTION_MODEL` is used for Telegram audio transcription
- `CODEX_MODEL` is optional; if Codex rejects it, the runner retries without an explicit model
- `CODEX_ENABLE_SEARCH=true` enables Codex web search during local runs
- `CODEX_TIMEOUT_MS` defaults to `900000`
- `CODEX_MAX_OUTPUT_CHARS` caps the result text stored back into task summaries
- `TELEGRAM_ALLOWED_CHAT_IDS` should contain only private chat IDs you trust
- `.env` is local and gitignored

## Security

Codex runs with `--dangerously-bypass-approvals-and-sandbox`. In practice, this bot can execute local work as your user account inside the configured workspace root. Treat the Telegram bot as privileged local access.
