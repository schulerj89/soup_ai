import test from 'node:test';
import assert from 'node:assert/strict';
import { AppDb } from '../src/db/app-db.js';

test('AppDb stores inbound messages, jobs, and outbound queue state', () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    const inbound = db.insertInboundMessage({
      updateId: 1,
      telegramMessageId: 55,
      chatId: '123',
      replyToMessageId: null,
      text: 'hello',
      status: 'received',
      raw: { update_id: 1 },
    });

    assert.ok(inbound);
    assert.equal(
      db.insertInboundMessage({
        updateId: 1,
        telegramMessageId: 55,
        chatId: '123',
        replyToMessageId: null,
        text: 'hello',
        status: 'received',
        raw: { update_id: 1 },
      }),
      null,
    );

    const job = db.queueJob({
      jobType: 'process_inbound_message',
      messageId: inbound.id,
      payload: { x: 1 },
    });

    assert.equal(db.listPendingJobs(10).length, 1);
    db.markJobRunning(job.id);
    db.markJobCompleted(job.id);

    const outbound = db.queueOutboundMessage({
      chatId: '123',
      text: 'reply',
    });

    assert.equal(db.listPendingOutbound(10).length, 1);
    db.markOutboundSent(outbound.id, 88, { ok: true });

    const snapshot = db.getQueueSnapshot();
    assert.equal(snapshot.pendingJobs, 0);
    assert.equal(snapshot.pendingOutbound, 0);
  } finally {
    db.close();
  }
});

test('AppDb keeps failed outbound messages queued for retry', () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    const outbound = db.queueOutboundMessage({
      chatId: '123',
      text: 'retry me',
    });

    db.markOutboundFailed(outbound.id, 'temporary telegram error');

    const pending = db.listPendingOutbound(10);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].last_error, 'temporary telegram error');
  } finally {
    db.close();
  }
});
