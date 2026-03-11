import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { projectRoot, resolveProjectPath } from '../utils/paths.js';

const RawEnvSchema = z.object({
  OPENAI_API_KEY: z.string().trim().optional(),
  OPENAI_MODEL: z.string().trim().default('gpt-4.1-mini'),
  OPENAI_MEMORY_MODEL: z.string().trim().optional(),
  TELEGRAM_BOT_TOKEN: z.string().trim().optional(),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().trim().optional(),
  TELEGRAM_API_BASE_URL: z.string().trim().default('https://api.telegram.org'),
  TELEGRAM_POLL_LIMIT: z.coerce.number().int().min(1).max(100).default(25),
  TELEGRAM_POLL_TIMEOUT_SECONDS: z.coerce.number().int().min(0).max(50).default(0),
  SUPERVISOR_DB_PATH: z.string().trim().default('./data/soup-ai.sqlite'),
  SUPERVISOR_WORKSPACE_ROOT: z.string().trim().default('C:/Users/joshs/Projects'),
  SUPERVISOR_MAX_JOBS_PER_RUN: z.coerce.number().int().min(1).max(100).default(5),
  CODEX_BIN: z.string().trim().default('codex'),
  CODEX_MODEL: z.string().trim().optional(),
  CODEX_ENABLE_SEARCH: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60 * 60 * 1000).default(900000),
  CODEX_MAX_OUTPUT_CHARS: z.coerce.number().int().min(1000).max(50000).default(16000),
});

let envLoaded = false;

export function loadDotEnv() {
  if (envLoaded) {
    return;
  }

  const envPath = path.join(projectRoot, '.env');

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }

  envLoaded = true;
}

function requireValue(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

export function loadConfig(options = {}) {
  const {
    requireOpenAI = true,
    requireTelegram = true,
    requireAllowedChats = true,
  } = options;

  loadDotEnv();

  const raw = RawEnvSchema.parse(process.env);

  if (requireOpenAI) {
    requireValue('OPENAI_API_KEY', raw.OPENAI_API_KEY);
  }

  if (requireTelegram) {
    requireValue('TELEGRAM_BOT_TOKEN', raw.TELEGRAM_BOT_TOKEN);
  }

  const allowedChatIds = `${raw.TELEGRAM_ALLOWED_CHAT_IDS ?? ''}`
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (requireAllowedChats && allowedChatIds.length === 0) {
    throw new Error('Missing required environment variable: TELEGRAM_ALLOWED_CHAT_IDS');
  }

  return {
    openAiApiKey: raw.OPENAI_API_KEY,
    openAiModel: raw.OPENAI_MODEL,
    openAiMemoryModel: raw.OPENAI_MEMORY_MODEL ?? raw.OPENAI_MODEL,
    telegramBotToken: raw.TELEGRAM_BOT_TOKEN,
    telegramAllowedChatIds: allowedChatIds,
    telegramApiBaseUrl: raw.TELEGRAM_API_BASE_URL.replace(/\/$/, ''),
    telegramPollLimit: raw.TELEGRAM_POLL_LIMIT,
    telegramPollTimeoutSeconds: raw.TELEGRAM_POLL_TIMEOUT_SECONDS,
    dbPath: raw.SUPERVISOR_DB_PATH === ':memory:' ? ':memory:' : resolveProjectPath(raw.SUPERVISOR_DB_PATH),
    workspaceRoot: path.resolve(raw.SUPERVISOR_WORKSPACE_ROOT),
    maxJobsPerRun: raw.SUPERVISOR_MAX_JOBS_PER_RUN,
    codexBin: raw.CODEX_BIN,
    codexModel: raw.CODEX_MODEL,
    codexEnableSearch: raw.CODEX_ENABLE_SEARCH,
    codexTimeoutMs: raw.CODEX_TIMEOUT_MS,
    codexMaxOutputChars: raw.CODEX_MAX_OUTPUT_CHARS,
    envPath: path.join(projectRoot, '.env'),
  };
}
