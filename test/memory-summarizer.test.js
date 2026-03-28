import test from 'node:test';
import assert from 'node:assert/strict';
import { AppDb } from '../src/db/app-db.js';
import { ConversationManager } from '../src/services/conversation-manager.js';
import { MemorySummarizer } from '../src/openai/memory-summarizer.js';

test('MemorySummarizer writes curated memory back through the conversation manager', async () => {
  const db = new AppDb({ dbPath: ':memory:' });
  const conversationManager = new ConversationManager({
    db,
    sessionFactory: () => ({
      async getSessionId() {
        return 'conv_test';
      },
      async addItems() {},
    }),
  });

  try {
    db.insertInboundMessage({
      updateId: 1,
      telegramMessageId: 10,
      chatId: 'chat-1',
      replyToMessageId: null,
      text: 'A',
      status: 'received',
      raw: {},
    });
    db.queueOutboundMessage({
      chatId: 'chat-1',
      text: 'B',
    });
    db.insertInboundMessage({
      updateId: 2,
      telegramMessageId: 11,
      chatId: 'chat-1',
      replyToMessageId: null,
      text: 'C',
      status: 'received',
      raw: {},
    });
    db.queueOutboundMessage({
      chatId: 'chat-1',
      text: 'D',
    });

    const summarizer = new MemorySummarizer({
      model: 'gpt-test',
      threshold: 2,
      keepRecentItems: 2,
      runImpl: async () => ({ finalOutput: 'Summary text' }),
    });

    const result = await summarizer.summarizeChat({
      chatId: 'chat-1',
      db,
      conversationManager,
    });
    const state = conversationManager.getState('chat-1');

    assert.equal(result.summarized, true);
    assert.equal(state.memorySummary, 'Summary text');
    assert.deepEqual(state.durableFacts.recent_open_tasks, []);
  } finally {
    db.close();
  }
});

test('MemorySummarizer only summarizes messages from the active conversation generation', async () => {
  const db = new AppDb({ dbPath: ':memory:' });
  const conversationManager = new ConversationManager({
    db,
    sessionFactory: () => ({
      async getSessionId() {
        return 'conv_test';
      },
      async addItems() {},
    }),
  });

  try {
    db.insertInboundMessage({
      updateId: 1,
      telegramMessageId: 10,
      chatId: 'chat-2',
      replyToMessageId: null,
      text: 'old topic',
      status: 'received',
      raw: {},
    });
    db.queueOutboundMessage({
      chatId: 'chat-2',
      text: 'old reply',
    });

    const resetControl = conversationManager.writeControl('chat-2', {
      ...conversationManager.getState('chat-2'),
      currentStartedAt: '9999-01-01T00:00:00.000Z',
      durableFacts: { user_preferences: ['concise'] },
    });

    void resetControl;

    db.insertInboundMessage({
      updateId: 2,
      telegramMessageId: 11,
      chatId: 'chat-2',
      replyToMessageId: null,
      text: 'new topic',
      status: 'received',
      raw: {},
    });
    db.queueOutboundMessage({
      chatId: 'chat-2',
      text: 'new reply',
    });

    const summarizer = new MemorySummarizer({
      model: 'gpt-test',
      threshold: 1,
      keepRecentItems: 1,
      runImpl: async (_agent, input) => ({ finalOutput: input.includes('old topic') ? 'bad' : 'fresh summary' }),
    });

    const result = await summarizer.summarizeChat({
      chatId: 'chat-2',
      db,
      conversationManager,
    });

    assert.equal(result.summarized, false);
    assert.equal(conversationManager.getState('chat-2').memorySummary, null);
  } finally {
    db.close();
  }
});
