import fs from 'node:fs';
import dotenv from 'dotenv';
import { loadConfig } from '../config/load-config.js';
import { AppDb } from '../db/app-db.js';
import { TelegramClient } from '../telegram/telegram-client.js';

export function normalizePathForEnv(value) {
  return value.replaceAll('\\', '/');
}

export function readExistingEnv(envPath) {
  return fs.existsSync(envPath)
    ? dotenv.parse(fs.readFileSync(envPath, 'utf8'))
    : {};
}

export async function discoverTelegramChatIds(
  token,
  { telegramClientFactory = (options) => new TelegramClient(options) } = {},
) {
  if (!token) {
    return [];
  }

  try {
    const client = telegramClientFactory({ token });
    const updates = await client.getUpdates({
      offset: 0,
      limit: 25,
      timeoutSeconds: 0,
    });
    const ids = [...new Set(updates.map((update) => update.message?.chat?.id).filter(Boolean))];
    return ids.map((value) => `${value}`);
  } catch {
    return [];
  }
}

export function buildSetupDefaults(existingEnv, discoveredChatIds = []) {
  return {
    openAiApiKey: existingEnv.OPENAI_API_KEY ?? '',
    telegramBotToken: existingEnv.TELEGRAM_BOT_TOKEN ?? '',
    allowedChatIds:
      existingEnv.TELEGRAM_ALLOWED_CHAT_IDS ?? discoveredChatIds.join(','),
    workspaceRoot:
      existingEnv.SUPERVISOR_WORKSPACE_ROOT ?? 'C:/Users/joshs/Projects',
    openAiModel: existingEnv.OPENAI_MODEL ?? 'gpt-4.1-mini',
    openAiMemoryModel:
      existingEnv.OPENAI_MEMORY_MODEL ??
      existingEnv.OPENAI_MODEL ??
      'gpt-4.1-mini',
    openAiTranscriptionModel:
      existingEnv.OPENAI_TRANSCRIPTION_MODEL ?? 'gpt-4o-mini-transcribe',
    dbPath: existingEnv.SUPERVISOR_DB_PATH ?? './data/soup-ai.sqlite',
    codexBin: existingEnv.CODEX_BIN ?? 'codex',
    codexSearch: existingEnv.CODEX_ENABLE_SEARCH ?? 'false',
  };
}

export function buildEnvFileContents({ existingEnv, values }) {
  return [
    `OPENAI_API_KEY=${values.openAiApiKey}`,
    `OPENAI_MODEL=${values.openAiModel}`,
    `OPENAI_MEMORY_MODEL=${values.openAiMemoryModel}`,
    `OPENAI_TRANSCRIPTION_MODEL=${values.openAiTranscriptionModel}`,
    `TELEGRAM_BOT_TOKEN=${values.telegramBotToken}`,
    `TELEGRAM_ALLOWED_CHAT_IDS=${values.allowedChatIds}`,
    `TELEGRAM_API_BASE_URL=${existingEnv.TELEGRAM_API_BASE_URL ?? 'https://api.telegram.org'}`,
    `TELEGRAM_POLL_LIMIT=${existingEnv.TELEGRAM_POLL_LIMIT ?? '25'}`,
    `TELEGRAM_POLL_TIMEOUT_SECONDS=${existingEnv.TELEGRAM_POLL_TIMEOUT_SECONDS ?? '0'}`,
    `TELEGRAM_AUDIO_MAX_FILE_BYTES=${existingEnv.TELEGRAM_AUDIO_MAX_FILE_BYTES ?? '25165824'}`,
    `SUPERVISOR_DB_PATH=${normalizePathForEnv(values.dbPath)}`,
    `SUPERVISOR_WORKSPACE_ROOT=${normalizePathForEnv(values.workspaceRoot)}`,
    `SUPERVISOR_MAX_JOBS_PER_RUN=${existingEnv.SUPERVISOR_MAX_JOBS_PER_RUN ?? '5'}`,
    `CODEX_BIN=${values.codexBin}`,
    `CODEX_MODEL=${existingEnv.CODEX_MODEL ?? ''}`,
    `CODEX_ENABLE_SEARCH=${values.codexSearch}`,
    `CODEX_TIMEOUT_MS=${existingEnv.CODEX_TIMEOUT_MS ?? '900000'}`,
    `CODEX_MAX_OUTPUT_CHARS=${existingEnv.CODEX_MAX_OUTPUT_CHARS ?? '16000'}`,
    '',
  ].join('\n');
}

export function writeEnvAndInitializeDb({
  envPath,
  contents,
  loadConfigImpl = loadConfig,
  AppDbClass = AppDb,
}) {
  fs.writeFileSync(envPath, contents, 'utf8');

  const config = loadConfigImpl();
  const db = new AppDbClass({ dbPath: config.dbPath });
  db.close();
}
