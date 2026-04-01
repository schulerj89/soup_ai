import test from 'node:test';
import assert from 'node:assert/strict';
import { AppDb } from '../src/db/app-db.js';
import { ConversationManager } from '../src/services/conversation-manager.js';
import { DURABLE_PROFILE_PROMPT, MEMORY_SUMMARY_PROMPT, MemorySummarizer } from '../src/openai/memory-summarizer.js';

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
      runImpl: async (agent) =>
        agent.instructions === MEMORY_SUMMARY_PROMPT
          ? { finalOutput: 'Summary text' }
          : { finalOutput: '{"profile_patch":{},"notes":[]}' },
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
      runImpl: async (agent, input) =>
        agent.instructions === MEMORY_SUMMARY_PROMPT
          ? { finalOutput: input.includes('old topic') ? 'bad' : 'fresh summary' }
          : { finalOutput: '{"profile_patch":{},"notes":[]}' },
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

test('MemorySummarizer extracts durable profile signals and notes', async () => {
  const db = new AppDb({ dbPath: ':memory:' });
  const conversationManager = new ConversationManager({
    db,
    sessionFactory: () => ({
      async getSessionId() {
        return 'conv_profile';
      },
      async addItems() {},
    }),
  });

  try {
    db.insertInboundMessage({
      updateId: 1,
      telegramMessageId: 10,
      chatId: 'chat-profile',
      replyToMessageId: null,
      text: 'Please remember that I prefer concise answers.',
      status: 'received',
      raw: {},
    });
    db.queueOutboundMessage({
      chatId: 'chat-profile',
      text: 'Saved.',
    });
    db.insertInboundMessage({
      updateId: 2,
      telegramMessageId: 11,
      chatId: 'chat-profile',
      replyToMessageId: null,
      text: 'Remember this note: monitor arm uses a 6mm hex key.',
      status: 'received',
      raw: {},
    });
    db.queueOutboundMessage({
      chatId: 'chat-profile',
      text: 'Noted.',
    });

    const summarizer = new MemorySummarizer({
      model: 'gpt-test',
      threshold: 2,
      keepRecentItems: 1,
      runImpl: async (agent) => {
        if (agent.instructions === MEMORY_SUMMARY_PROMPT) {
          return { finalOutput: 'User prefers concise answers.' };
        }

        if (agent.instructions === DURABLE_PROFILE_PROMPT) {
          return {
            finalOutput: JSON.stringify({
              profile_patch: {
                preferences: { reply_style: 'concise' },
                saved_patterns: ['Explicitly asks the assistant to remember implementation details.'],
              },
              notes: [
                {
                  title: 'Monitor arm tool',
                  body: 'Monitor arm uses a 6mm hex key.',
                  tags: ['hardware', 'setup'],
                },
              ],
            }),
          };
        }

        throw new Error('Unexpected agent instructions');
      },
    });

    const result = await summarizer.summarizeChat({
      chatId: 'chat-profile',
      db,
      conversationManager,
    });

    const profile = db.getDurableProfile('chat-profile');
    const notes = db.listRecentNotes('chat-profile', 5);

    assert.equal(result.profileUpdated, true);
    assert.equal(result.notesCreated, 1);
    assert.equal(profile.preferences.reply_style.value, 'concise');
    assert.equal(notes[0].title, 'Monitor arm tool');
    assert.match(notes[0].body, /6mm hex key/);
  } finally {
    db.close();
  }
});
