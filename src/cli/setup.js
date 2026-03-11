import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import dotenv from 'dotenv';
import { loadConfig } from '../config/load-config.js';
import { AppDb } from '../db/app-db.js';
import { TelegramClient } from '../telegram/telegram-client.js';
import { projectRoot } from '../utils/paths.js';

function normalizePathForEnv(value) {
  return value.replaceAll('\\', '/');
}

async function discoverChats(token) {
  if (!token) {
    return [];
  }

  try {
    const client = new TelegramClient({ token });
    const updates = await client.getUpdates({ offset: 0, limit: 25, timeoutSeconds: 0 });
    const ids = [...new Set(updates.map((update) => update.message?.chat?.id).filter(Boolean))];
    return ids.map((value) => `${value}`);
  } catch {
    return [];
  }
}

async function promptValue(rl, label, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || defaultValue || '';
}

async function main() {
  const envPath = path.join(projectRoot, '.env');
  const existingEnv = fs.existsSync(envPath)
    ? dotenv.parse(fs.readFileSync(envPath, 'utf8'))
    : {};

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('Soup AI setup');
    console.log('');

    const openAiApiKey = await promptValue(rl, 'OpenAI API key', existingEnv.OPENAI_API_KEY ?? '');
    const telegramBotToken = await promptValue(
      rl,
      'Telegram bot token',
      existingEnv.TELEGRAM_BOT_TOKEN ?? '',
    );

    const discoveredChatIds = await discoverChats(telegramBotToken);
    const allowedChatIdsDefault =
      existingEnv.TELEGRAM_ALLOWED_CHAT_IDS ?? discoveredChatIds.join(',');

    if (discoveredChatIds.length > 0) {
      console.log(`Discovered chat IDs: ${discoveredChatIds.join(', ')}`);
    }

    const allowedChatIds = await promptValue(
      rl,
      'Allowed Telegram chat IDs (comma-separated)',
      allowedChatIdsDefault,
    );
    const workspaceRoot = await promptValue(
      rl,
      'Workspace root for Codex',
      existingEnv.SUPERVISOR_WORKSPACE_ROOT ?? 'C:/Users/joshs/Projects',
    );
    const openAiModel = await promptValue(
      rl,
      'OpenAI model',
      existingEnv.OPENAI_MODEL ?? 'gpt-4.1-mini',
    );
    const dbPath = await promptValue(
      rl,
      'SQLite DB path',
      existingEnv.SUPERVISOR_DB_PATH ?? './data/soup-ai.sqlite',
    );
    const codexBin = await promptValue(rl, 'Codex binary', existingEnv.CODEX_BIN ?? 'codex');
    const codexSearch = await promptValue(
      rl,
      'Enable Codex web search (true/false)',
      existingEnv.CODEX_ENABLE_SEARCH ?? 'false',
    );

    const contents = [
      `OPENAI_API_KEY=${openAiApiKey}`,
      `OPENAI_MODEL=${openAiModel}`,
      `TELEGRAM_BOT_TOKEN=${telegramBotToken}`,
      `TELEGRAM_ALLOWED_CHAT_IDS=${allowedChatIds}`,
      `TELEGRAM_API_BASE_URL=${existingEnv.TELEGRAM_API_BASE_URL ?? 'https://api.telegram.org'}`,
      `TELEGRAM_POLL_LIMIT=${existingEnv.TELEGRAM_POLL_LIMIT ?? '25'}`,
      `TELEGRAM_POLL_TIMEOUT_SECONDS=${existingEnv.TELEGRAM_POLL_TIMEOUT_SECONDS ?? '0'}`,
      `SUPERVISOR_DB_PATH=${normalizePathForEnv(dbPath)}`,
      `SUPERVISOR_WORKSPACE_ROOT=${normalizePathForEnv(workspaceRoot)}`,
      `SUPERVISOR_MAX_JOBS_PER_RUN=${existingEnv.SUPERVISOR_MAX_JOBS_PER_RUN ?? '5'}`,
      `CODEX_BIN=${codexBin}`,
      `CODEX_MODEL=${existingEnv.CODEX_MODEL ?? ''}`,
      `CODEX_ENABLE_SEARCH=${codexSearch}`,
      `CODEX_TIMEOUT_MS=${existingEnv.CODEX_TIMEOUT_MS ?? '900000'}`,
      `CODEX_MAX_OUTPUT_CHARS=${existingEnv.CODEX_MAX_OUTPUT_CHARS ?? '16000'}`,
      '',
    ].join('\n');

    fs.writeFileSync(envPath, contents, 'utf8');

    const config = loadConfig();
    const db = new AppDb({ dbPath: config.dbPath });
    db.close();

    console.log('');
    console.log(`Wrote ${path.relative(projectRoot, envPath)} and initialized the SQLite database.`);
    console.log('Next steps:');
    console.log('1. npm run supervisor:once');
    console.log('2. npm run task:register');
    console.log('3. Read docs/telegram.md if you still need bot/chat details');
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
