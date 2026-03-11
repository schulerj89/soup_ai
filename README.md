# Soup AI

`Soup AI` is a local-only Telegram supervisor for Windows. It polls a private Telegram bot on a schedule, stores inbound and outbound messages in SQLite, routes work through the OpenAI Agents SDK, and can hand off local tasks to `codex exec --dangerously-bypass-approvals-and-sandbox`.

## What it does

- Polls Telegram updates with a scheduled Windows task.
- Persists messages, queue state, leases, and tracked tasks in SQLite.
- Uses the OpenAI Agents SDK as the supervisor brain.
- Lets the model invoke a guarded local Codex tool inside one allowed workspace root.
- Exposes Codex status and recent limits telemetry from the local Codex install.
- Queues outbound Telegram replies so sends can be retried on the next scheduled run.

## Architecture

- `src/cli/setup.js`: interactive bootstrap for `.env` and DB creation.
- `src/cli/supervisor-once.js`: one scheduler tick.
- `src/services/supervisor-service.js`: poll, ingest, process queue, flush outbound messages.
- `src/openai/supervisor-agent.js`: Tosh the AI Bot, implemented with the OpenAI Agents SDK.
- `src/tools/codex-runner.js`: executes Codex with the required dangerous bypass flag and reads local Codex status data.
- `src/db/app-db.js`: SQLite schema and repository methods.
- `scripts/run-supervisor.cmd`: Windows scheduler entrypoint.
- `scripts/register-task.ps1`: registers a Task Scheduler job that runs every minute.

## Requirements

- Windows with Task Scheduler
- Node.js `25+`
- `codex` CLI available on `PATH`
- A Telegram bot token
- An OpenAI API key

## Setup

1. Install dependencies:

```powershell
npm install
```

2. Run the interactive setup:

```powershell
npm run setup
```

3. Read the operator checklist in [docs/telegram.md](./docs/telegram.md) and supply the required values.

4. Run one manual cycle:

```powershell
npm run supervisor:once
```

5. Register the Windows scheduled task:

```powershell
npm run task:register
```

## Useful commands

```powershell
npm run discover:telegram
npm run send:message -- --text "Manual outbound test"
npm run supervisor:once
npm test
```

## Telegram commands

- `/help`: show supported commands
- `/health`: show queue and task counts
- `/tasks`: show recent Codex-tracked tasks

Any other text is treated as a supervisor request. The model may answer directly or invoke Codex for local work.

The agent also has internal tools for:

- recent task history
- supervisor queue snapshot
- Codex status and recent rate-limit telemetry

## Security notes

- Codex runs with `--dangerously-bypass-approvals-and-sandbox` because that was an explicit requirement. Treat this bot as equivalent to giving Telegram-triggered shell authority to your local account.
- `SUPERVISOR_WORKSPACE_ROOT` is enforced. Codex requests outside that root are rejected.
- Set `TELEGRAM_ALLOWED_CHAT_IDS` to your private chat IDs only.
- `.env` is gitignored. Keep it local.

## SQLite choice

This project uses Node's built-in `node:sqlite` because the current machine is on Node `25.3.0`, and common native SQLite packages are not yet a reliable fit there. On Node 25 the module still emits an experimental warning, so the scheduler wrapper suppresses warnings for cleaner scheduled runs.

For Codex limits/status, the CLI's `/status` command is interactive-only. This project derives a scriptable equivalent from `~/.codex/config.toml` plus the latest local Codex session telemetry when available.

## Testing

Run:

```powershell
npm test
```

The tests cover the DB queue logic, the Tosh agent wiring, the Codex status parser, and a scheduler tick with mocked Telegram/Codex behavior.
