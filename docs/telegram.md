# Telegram Operator Checklist

You asked for the supervisor to stay local-only and private. These are the inputs still needed from you when you run setup.

## Required

- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_CHAT_IDS`

## How to get them

### `TELEGRAM_BOT_TOKEN`

1. In Telegram, talk to `@BotFather`.
2. Create a bot with `/newbot`.
3. Copy the token into setup or `.env`.

### `TELEGRAM_ALLOWED_CHAT_IDS`

Use one of these:

1. Send a message to your bot, then run:

```powershell
npm run discover:telegram
```

2. Or inspect the latest update manually:

`https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`

The `message.chat.id` value is the chat ID to allow. Multiple IDs can be comma-separated.

### `OPENAI_API_KEY`

Create it in the OpenAI dashboard and store it only in `.env`.

## Recommended values

- `SUPERVISOR_WORKSPACE_ROOT=C:/Users/joshs/Projects`
- `OPENAI_MODEL=gpt-4.1-mini`
- `TELEGRAM_POLL_TIMEOUT_SECONDS=0`

## Windows scheduler

After setup and one manual test run:

```powershell
npm run task:register
```

That creates a Task Scheduler job named `SoupAiSupervisor` which runs once per minute.
