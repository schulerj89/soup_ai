import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('AppDb can queue tasks with execution input and checklist progress', () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    const task = db.queueTask({
      sourceJobId: null,
      sourceMessageId: null,
      title: 'Inspect repo',
      toolType: 'codex',
      details: 'Inspect the repo and summarize it.',
      executionInput: {
        taskTitle: 'Inspect repo',
        prompt: 'Inspect the repo',
        workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
      },
      notifyChatId: 'chat-1',
      notifyReplyToMessageId: 44,
      checklist: ['Inspect files', 'Summarize findings'],
    });

    assert.equal(task.status, 'queued');
    assert.equal(task.tool_type, 'codex');
    assert.equal(task.notify_chat_id, 'chat-1');
    assert.equal(task.execution_input.workingDirectory, 'C:/Users/joshs/Projects/soup_ai');
    assert.equal(task.progress.phase, 'queued');
    assert.equal(task.progress.checklist.length, 2);
    assert.equal(db.getQueueSnapshot().queuedTasks, 1);
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

test('AppDb stores notes and merges durable profile state', () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    const note = db.createNote({
      chatId: 'chat-7',
      title: 'Grocery list',
      body: 'tomatoes, basil, pasta',
      tags: ['Errands', 'Food'],
    });

    assert.equal(note.title, 'Grocery list');
    assert.deepEqual(note.tags, ['errands', 'food']);
    assert.equal(db.searchNotes('chat-7', 'basil', 5).length, 1);
    assert.equal(
      db.createNoteIfMissing({
        chatId: 'chat-7',
        title: 'Grocery list',
        body: 'tomatoes, basil, pasta',
        tags: ['food'],
      }).id,
      note.id,
    );

    const profile = db.mergeDurableProfile(
      'chat-7',
      {
        preferences: { reply_style: 'concise' },
        projects: ['soup_ai'],
        saved_patterns: ['Usually asks for implementation before planning.'],
      },
      { source: 'test' },
    );

    assert.equal(profile.preferences.reply_style.value, 'concise');
    assert.equal(profile.preferences.reply_style.source, 'test');
    assert.equal(profile.projects[0].value, 'soup_ai');
    assert.equal(db.getDurableProfile('chat-7').saved_patterns[0].value, 'Usually asks for implementation before planning.');
  } finally {
    db.close();
  }
});

test('AppDb acquires a lease, rejects an active competing owner, and releases for the current owner', () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    assert.equal(db.acquireLease('lease-key', 'owner-a', 1_000), true);
    assert.equal(db.acquireLease('lease-key', 'owner-b', 1_000), false);

    const held = db.getLease('lease-key');
    assert.equal(held.owner, 'owner-a');

    assert.equal(db.releaseLease('lease-key', 'owner-b'), false);
    assert.equal(db.getLease('lease-key').owner, 'owner-a');
    assert.equal(db.releaseLease('lease-key', 'owner-a'), true);
    assert.equal(db.getLease('lease-key'), null);
    assert.equal(db.releaseLease('lease-key', 'owner-a'), false);
  } finally {
    db.close();
  }
});

test('AppDb reacquires an expired lease for a new owner and updates stored state', async () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    assert.equal(db.acquireLease('lease-key', 'owner-a', 20), true);
    const first = db.getLease('lease-key');

    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(db.acquireLease('lease-key', 'owner-b', 200), true);
    const second = db.getLease('lease-key');

    assert.equal(second.owner, 'owner-b');
    assert.ok(second.updated_at >= first.updated_at);
    assert.ok(second.expires_at > first.expires_at);
  } finally {
    db.close();
  }
});

test('AppDb persists lease state across database instances', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soup-ai-lease-'));
  const dbPath = path.join(tempRoot, 'app.sqlite');
  const first = new AppDb({ dbPath });

  try {
    assert.equal(first.acquireLease('lease-key', 'owner-a', 1_000), true);
  } finally {
    first.close();
  }

  const second = new AppDb({ dbPath });

  try {
    const stored = second.getLease('lease-key');
    assert.equal(stored.owner, 'owner-a');
    assert.equal(second.releaseLease('lease-key', 'owner-a'), true);
    assert.equal(second.getLease('lease-key'), null);
  } finally {
    second.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
