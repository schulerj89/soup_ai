import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectProviderRequirements,
  getProvider,
  getProviderRequirements,
  hasProvider,
  listProviders,
} from '../src/integrations/index.js';

test('listProviders returns the supported provider catalog', () => {
  const providers = listProviders();

  assert.deepEqual(
    providers.map((provider) => provider.id),
    ['openai', 'github', 'vercel', 'telegram'],
  );
});

test('getProvider resolves aliases and exposes provider metadata', () => {
  const provider = getProvider(' Open-AI ');

  assert.equal(provider.id, 'openai');
  assert.equal(provider.displayName, 'OpenAI');
  assert.deepEqual(provider.capabilities, [
    'chat-completions',
    'responses',
    'audio-transcription',
  ]);
});

test('getProviderRequirements returns required env vars without secret lookup logic', () => {
  assert.deepEqual(getProviderRequirements('telegram'), [
    {
      name: 'TELEGRAM_BOT_TOKEN',
      required: true,
      secret: true,
      description: 'Bot token used to fetch updates and send messages.',
    },
    {
      name: 'TELEGRAM_ALLOWED_CHAT_IDS',
      required: true,
      secret: false,
      description: 'Comma-separated chat allowlist for the supervisor bot.',
    },
  ]);
});

test('hasProvider and getProvider reject unknown providers cleanly', () => {
  assert.equal(hasProvider('slack'), false);
  assert.throws(() => getProvider('slack'), /Unknown provider: slack/);
});

test('collectProviderRequirements merges env vars and capabilities across providers', () => {
  const requirements = collectProviderRequirements(['openai', 'telegram', 'OpenAI']);

  assert.deepEqual(
    requirements.providers.map((provider) => provider.id),
    ['openai', 'telegram', 'openai'],
  );
  assert.deepEqual(
    requirements.envVars.map((envVar) => envVar.name),
    ['OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHAT_IDS'],
  );
  assert.deepEqual(requirements.capabilities, [
    'chat-completions',
    'responses',
    'audio-transcription',
    'bot-updates',
    'bot-messaging',
  ]);
});
