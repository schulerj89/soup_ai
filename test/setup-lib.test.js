import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnvFileContents,
  buildSetupDefaults,
  discoverTelegramChatIds,
  normalizePathForEnv,
} from '../src/cli/setup-lib.js';

test('normalizePathForEnv converts Windows separators to forward slashes', () => {
  assert.equal(
    normalizePathForEnv('C:\\Users\\joshs\\Projects\\soup_ai'),
    'C:/Users/joshs/Projects/soup_ai',
  );
});

test('buildSetupDefaults prefers existing env values and falls back to defaults', () => {
  const defaults = buildSetupDefaults(
    {
      OPENAI_MODEL: 'gpt-5-mini',
      TELEGRAM_BOT_TOKEN: 'bot-token',
    },
    ['111', '222'],
  );

  assert.equal(defaults.openAiApiKey, '');
  assert.equal(defaults.telegramBotToken, 'bot-token');
  assert.equal(defaults.allowedChatIds, '111,222');
  assert.equal(defaults.openAiModel, 'gpt-5-mini');
  assert.equal(defaults.openAiMemoryModel, 'gpt-5-mini');
  assert.equal(defaults.workspaceRoot, 'C:/Users/joshs/Projects');
  assert.equal(defaults.codexSearch, 'false');
});

test('buildEnvFileContents preserves existing advanced settings and normalizes paths', () => {
  const contents = buildEnvFileContents({
    existingEnv: {
      TELEGRAM_API_BASE_URL: 'https://example.invalid',
      TELEGRAM_POLL_LIMIT: '50',
      CODEX_MODEL: 'gpt-5-codex',
      CODEX_TIMEOUT_MS: '120000',
    },
    values: {
      openAiApiKey: 'openai-key',
      openAiModel: 'gpt-4.1-mini',
      openAiMemoryModel: 'gpt-4.1-mini',
      openAiTranscriptionModel: 'gpt-4o-mini-transcribe',
      telegramBotToken: 'telegram-token',
      allowedChatIds: '123,456',
      dbPath: '.\\data\\soup-ai.sqlite',
      workspaceRoot: 'C:\\Users\\joshs\\Projects',
      codexBin: 'codex',
      codexSearch: 'true',
    },
  });

  assert.match(contents, /OPENAI_API_KEY=openai-key/);
  assert.match(contents, /TELEGRAM_ALLOWED_CHAT_IDS=123,456/);
  assert.match(contents, /SUPERVISOR_DB_PATH=.\/data\/soup-ai.sqlite/);
  assert.match(contents, /SUPERVISOR_WORKSPACE_ROOT=C:\/Users\/joshs\/Projects/);
  assert.match(contents, /TELEGRAM_API_BASE_URL=https:\/\/example.invalid/);
  assert.match(contents, /CODEX_MODEL=gpt-5-codex/);
  assert.match(contents, /CODEX_TIMEOUT_MS=120000/);
});

test('discoverTelegramChatIds deduplicates and stringifies discovered chats', async () => {
  const ids = await discoverTelegramChatIds('token', {
    telegramClientFactory: () => ({
      getUpdates: async () => [
        { message: { chat: { id: 123 } } },
        { message: { chat: { id: 123 } } },
        { message: { chat: { id: 456 } } },
      ],
    }),
  });

  assert.deepEqual(ids, ['123', '456']);
});

test('discoverTelegramChatIds returns an empty list on client failure', async () => {
  const ids = await discoverTelegramChatIds('token', {
    telegramClientFactory: () => ({
      getUpdates: async () => {
        throw new Error('network failure');
      },
    }),
  });

  assert.deepEqual(ids, []);
});
