import test from 'node:test';
import assert from 'node:assert/strict';
import { AppDb } from '../src/db/app-db.js';
import { ConversationManager } from '../src/services/conversation-manager.js';

function createFakeSessionFactory() {
  const sessions = [];
  let sequence = 1;

  return {
    sessions,
    factory: ({ conversationId } = {}) => {
      const session = {
        conversationId: conversationId ?? `conv_${sequence++}`,
        addedItems: [],
        async getSessionId() {
          return this.conversationId;
        },
        async addItems(items) {
          this.addedItems.push(...items);
        },
      };
      sessions.push(session);
      return session;
    },
  };
}

test('ConversationManager creates and tracks a seeded active conversation', async () => {
  const db = new AppDb({ dbPath: ':memory:' });
  const fake = createFakeSessionFactory();

  try {
    const manager = new ConversationManager({
      db,
      sessionFactory: fake.factory,
    });

    manager.updateMemory('chat-1', {
      memorySummary: 'User prefers concise replies.',
      durableFacts: { open_tasks: ['Review repo state'] },
    });

    const { session, control } = await manager.getSession('chat-1');

    assert.equal(await session.getSessionId(), 'conv_1');
    assert.equal(control.activeConversationId, 'conv_1');
    assert.equal(control.conversationGeneration, 0);
    assert.equal(fake.sessions[0].addedItems.length, 0);
  } finally {
    db.close();
  }
});

test('ConversationManager archives the current conversation and creates a new one on reset', async () => {
  const db = new AppDb({ dbPath: ':memory:' });
  const fake = createFakeSessionFactory();

  try {
    const manager = new ConversationManager({
      db,
      sessionFactory: fake.factory,
    });

    await manager.getSession('chat-1');
    manager.updateMemory('chat-1', {
      memorySummary: 'Keep track of open migration work.',
      durableFacts: { open_tasks: ['Implement /reset'] },
    });

    const { control } = await manager.archiveAndReset('chat-1', {
      reason: 'User requested reset',
      preserveMemory: true,
    });

    assert.equal(control.activeConversationId, 'conv_2');
    assert.equal(control.conversationGeneration, 1);
    assert.equal(control.memorySummary, null);
    assert.deepEqual(control.durableFacts, { open_tasks: ['Implement /reset'] });
    assert.equal(db.listConversationArchives('chat-1', 5).length, 1);
    assert.equal(db.listConversationArchives('chat-1', 5)[0].conversation_id, 'conv_1');
    assert.equal(fake.sessions[1].addedItems.length, 0);
  } finally {
    db.close();
  }
});

test('ConversationManager seed text includes durable profile and recent notes', async () => {
  const db = new AppDb({ dbPath: ':memory:' });
  const fake = createFakeSessionFactory();

  try {
    const manager = new ConversationManager({
      db,
      sessionFactory: fake.factory,
    });

    db.mergeDurableProfile(
      'chat-3',
      {
        preferences: { reply_style: 'concise' },
        projects: ['soup_ai'],
      },
      { source: 'test' },
    );
    db.createNote({
      chatId: 'chat-3',
      title: 'Desk setup',
      body: 'Secondary monitor uses HDMI 2.',
      tags: ['hardware'],
    });

    manager.updateMemory('chat-3', {
      memorySummary: 'User is iterating on assistant features.',
      durableFacts: { open_tasks: ['Add profile storage'] },
    });

    const state = manager.getState('chat-3');

    assert.match(state.seedText, /Conversation summary:\nUser is iterating on assistant features\./);
    assert.match(state.seedText, /Durable profile:/);
    assert.match(state.seedText, /reply_style: concise/);
    assert.match(state.seedText, /Recent notes:\n- Desk setup \[tags: hardware\]: Secondary monitor uses HDMI 2\./);
  } finally {
    db.close();
  }
});
