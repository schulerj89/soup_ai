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

test('AppDb can persist partial task outcomes separately from failed tasks', () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    const task = db.createTask({
      sourceJobId: null,
      sourceMessageId: null,
      title: 'Update README',
      details: 'Make a partial repo change',
      codexCommand: 'codex exec ...',
    });

    db.markTaskPartial(task.id, {
      resultSummary: 'Changed files but left follow-up work.',
      exitCode: 0,
    });

    const stored = db.listRecentTasks(1)[0];
    assert.equal(stored.status, 'partial');
    assert.equal(stored.result_summary, 'Changed files but left follow-up work.');
    assert.equal(stored.codex_exit_code, 0);
    assert.ok(stored.completed_at);
  } finally {
    db.close();
  }
});

test('AppDb stores conversation control state and archives resets', () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    db.setConversationControlState('chat-1', {
      activeConversationId: 'conv_123',
      conversationGeneration: 2,
      memorySummary: 'Keep answers concise.',
      durableFacts: { preferences: ['concise replies'] },
    });

    const state = db.getConversationControlState('chat-1');
    assert.equal(state.activeConversationId, 'conv_123');
    assert.equal(state.conversationGeneration, 2);
    assert.deepEqual(state.durableFacts, { preferences: ['concise replies'] });

    db.archiveConversation({
      chatId: 'chat-1',
      conversationId: 'conv_123',
      generation: 2,
      reason: 'Manual reset',
      memorySummary: 'Keep answers concise.',
      durableFacts: { preferences: ['concise replies'] },
      createdAt: '2026-03-01T00:00:00.000Z',
    });

    const archives = db.listConversationArchives('chat-1', 5);
    assert.equal(archives.length, 1);
    assert.equal(archives[0].conversation_id, 'conv_123');
    assert.equal(archives[0].generation, 2);
    assert.equal(archives[0].reason, 'Manual reset');
  } finally {
    db.close();
  }
});
