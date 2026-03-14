import test from 'node:test';
import assert from 'node:assert/strict';
import { OutboundMessageDispatcher } from '../src/services/supervisor-service/outbound-dispatcher.js';
import { createTestDb } from '../support/unit-helpers.js';

test('OutboundMessageDispatcher sends pending messages and stores Telegram metadata', async () => {
  const db = createTestDb();
  const sent = [];

  try {
    const outbound = db.queueOutboundMessage({
      chatId: 'chat-1',
      text: 'Reply text',
      replyToMessageId: 77,
    });

    const dispatcher = new OutboundMessageDispatcher({
      db,
      telegramClient: {
        sendMessage: async (payload) => {
          sent.push(payload);
          return { message_id: 701, ok: true };
        },
      },
      logger: console,
    });

    const flushed = await dispatcher.flush(10);
    const stored = db.getMessageById(outbound.id);

    assert.equal(flushed, 1);
    assert.deepEqual(sent, [
      {
        chatId: 'chat-1',
        text: 'Reply text',
        replyToMessageId: 77,
      },
    ]);
    assert.equal(stored.status, 'sent');
    assert.equal(stored.telegram_message_id, 701);
    assert.deepEqual(JSON.parse(stored.raw_json), { message_id: 701, ok: true });
  } finally {
    db.close();
  }
});

test('OutboundMessageDispatcher keeps failed sends queued for retry and records the error', async () => {
  const db = createTestDb();
  const errors = [];

  try {
    const outbound = db.queueOutboundMessage({
      chatId: 'chat-1',
      text: 'Retry me',
    });

    const dispatcher = new OutboundMessageDispatcher({
      db,
      telegramClient: {
        sendMessage: async () => {
          throw new Error('temporary telegram failure');
        },
      },
      logger: {
        log() {},
        error(message) {
          errors.push(message);
        },
      },
    });

    const flushed = await dispatcher.flush(10);
    const stored = db.getMessageById(outbound.id);

    assert.equal(flushed, 0);
    assert.equal(stored.status, 'pending_send');
    assert.equal(stored.last_error, 'temporary telegram failure');
    assert.match(errors[0], /Outbound message .* temporary telegram failure/);
  } finally {
    db.close();
  }
});
