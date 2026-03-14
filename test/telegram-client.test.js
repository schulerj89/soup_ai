import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramClient } from '../src/telegram/telegram-client.js';

test('TelegramClient sendMessage posts reply parameters only when needed', async () => {
  const requests = [];
  const client = new TelegramClient({
    token: 'test-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        async json() {
          return { ok: true, result: { message_id: 909 } };
        },
      };
    },
  });

  const result = await client.sendMessage({
    chatId: 'chat-1',
    text: 'Hello',
    replyToMessageId: 88,
  });

  assert.equal(result.message_id, 909);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.telegram.org/bottest-token/sendMessage');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    chat_id: 'chat-1',
    text: 'Hello',
    reply_parameters: { message_id: 88 },
  });
});

test('TelegramClient surfaces Telegram API errors from JSON responses', async () => {
  const client = new TelegramClient({
    token: 'test-token',
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { ok: false, description: 'bot was blocked by the user' };
      },
    }),
  });

  await assert.rejects(
    client.getUpdates({ offset: 10, limit: 5, timeoutSeconds: 2 }),
    /Telegram API error: bot was blocked by the user/,
  );
});

test('TelegramClient downloads file bytes and rejects HTTP failures', async () => {
  const client = new TelegramClient({
    token: 'test-token',
    fetchImpl: async (url) => {
      if (url.includes('/file/')) {
        return {
          ok: true,
          async arrayBuffer() {
            return Uint8Array.from([65, 66, 67]).buffer;
          },
        };
      }

      return {
        ok: false,
        status: 503,
      };
    },
  });

  const bytes = await client.downloadFile('audio/file-1.ogg');

  assert.equal(bytes.toString('utf8'), 'ABC');
  await assert.rejects(client.call('getMe'), /Telegram API HTTP 503/);
});
