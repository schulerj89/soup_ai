# Soup AI

`Soup AI` is a local-only Telegram supervisor for Windows. It polls a private Telegram bot, stores state in SQLite, answers simple requests through the OpenAI Agents SDK, and hands repo or machine work to `codex exec` inside one allowed workspace root.

## Current behavior

- Runs as a scheduled local worker, typically once per minute through Windows Task Scheduler
- Accepts Telegram text, voice notes, and audio attachments
- Transcribes audio with OpenAI before processing
- Stores messages, jobs, outbound replies, leases, tasks, and chat memory in SQLite
- Uses an execution planner to either answer directly or run Codex locally
- Keeps direct replies concise and can use OpenAI web search for current questions
- Summarizes long chat history into compact session memory
- Queues outbound Telegram messages for retry on the next run

## Main pieces

- `src/cli/setup.js`: interactive `.env` setup and DB initialization
- `src/cli/supervisor-once.js`: one supervisor tick
- `src/services/supervisor-service.js`: ingest, process, and flush loop
- `src/openai/execution-planner.js`: decides direct reply vs. Codex execution
- `src/openai/supervisor-agent.js`: direct answers, Codex acknowledgements, and result summaries
- `src/tools/codex-runner.js`: guarded `codex exec` wrapper plus local Codex status inspection
- `src/db/app-db.js`: SQLite schema and persistence

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
npm run supervisor:once
npm run task:register
```

`npm run setup` writes `.env`, initializes the SQLite DB, and prompts for the workspace root, Telegram allowlist, and model settings. See [docs/telegram.md](./docs/telegram.md) if you still need the bot token or chat ID workflow.

## Useful commands

```powershell
npm run discover:telegram
npm run inspect:codex
npm run send:message -- --text "Manual outbound test"
npm run supervisor:once
npm run task:register
npm run task:unregister
npm test
```

## Telegram commands

- `/help`
- `/health`
- `/status`
- `/tasks`

Anything else is treated as a supervisor request. Soup AI either replies directly or starts a Codex task and posts a follow-up summary when it finishes.

## Configuration notes

- `SUPERVISOR_WORKSPACE_ROOT` is the hard boundary for local Codex work
- `CODEX_ENABLE_SEARCH=true` enables Codex web search during local runs
- `TELEGRAM_ALLOWED_CHAT_IDS` should contain only private chat IDs you trust
- `.env` is local and gitignored

## Security

Codex runs with `--dangerously-bypass-approvals-and-sandbox`. In practice, this bot can execute local work as your user account inside the configured workspace root. Treat the Telegram bot as privileged local access.
