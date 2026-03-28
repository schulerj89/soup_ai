import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectReplyHandler } from '../src/services/message-processor/direct-reply-handler.js';
import { createTestConfig, createTestDb, queueInboundJob } from '../support/unit-helpers.js';

function createConversationManagerStub() {
  let sequence = 1;
  const state = {
    activeConversationId: null,
    conversationGeneration: 0,
    memorySummary: 'Remember the preferred repo structure.',
    durableFacts: { repo: 'soup_ai' },
    seedText: 'Conversation summary:\nRemember the preferred repo structure.',
    lastResetAt: null,
    lastResetReason: null,
  };

  return {
    getState() {
      return { ...state };
    },
    async getSession() {
      if (!state.activeConversationId) {
        state.activeConversationId = `conv_${sequence++}`;
      }

      return {
        control: { ...state },
        session: {
          async getSessionId() {
            return state.activeConversationId;
          },
        },
      };
    },
    async archiveAndReset(_chatId, { reason }) {
      state.conversationGeneration += 1;
      state.activeConversationId = `conv_${sequence++}`;
      state.lastResetAt = '2026-03-28T00:00:00.000Z';
      state.lastResetReason = reason;

      return {
        control: { ...state },
        session: {
          async getSessionId() {
            return state.activeConversationId;
          },
        },
      };
    },
  };
}

test('DirectReplyHandler passes direct-answer conversation context through a dedicated collaborator', async () => {
  const db = createTestDb();
  const conversationManager = createConversationManagerStub();
  let capturedArgs = null;

  try {
    const handler = new DirectReplyHandler({
      db,
      agent: {
        answerDirectly: async (args) => {
          capturedArgs = args;
          const resetResult = await args.resetConversationTool({ reason: 'Need a clean slate.' });
          return `reset:${resetResult.conversation_generation}`;
        },
      },
      config: createTestConfig(),
      conversationManager,
      codexTaskRunner: {
        codexRunner: { getStatus: async () => ({ ok: true }) },
        execute: async () => {
          throw new Error('execute should not run for direct answers');
        },
      },
    });

    const reply = await handler.reply({
      job: { id: 10 },
      message: { id: 20, chat_id: 'chat-1', telegram_message_id: 30 },
      text: 'Reset and summarize the conversation.',
      plan: {
        reason: 'Informational request.',
        responseOutline: 'Use the available reset tool if needed.',
      },
    });

    assert.equal(reply, 'reset:1');
    assert.equal(capturedArgs.chatId, 'chat-1');
    assert.equal(capturedArgs.messageText, 'Reset and summarize the conversation.');
    assert.equal(
      capturedArgs.conversationMemory,
      'Conversation summary:\nRemember the preferred repo structure.',
    );
    assert.equal(conversationManager.getState('chat-1').conversationGeneration, 1);
    assert.equal(conversationManager.getState('chat-1').lastResetReason, 'Need a clean slate.');
  } finally {
    db.close();
  }
});

test('DirectReplyHandler encapsulates tool wiring for handleMessage fallback', async () => {
  const db = createTestDb();
  const conversationManager = createConversationManagerStub();
  const codexCalls = [];

  try {
    const { job: existingJob, inbound } = queueInboundJob(db, {
      updateId: 99,
      telegramMessageId: 199,
      chatId: 'chat-2',
      text: 'Track an existing task.',
    });

    db.createTask({
      sourceJobId: existingJob.id,
      sourceMessageId: inbound.id,
      title: 'Existing task',
      details: 'Task details',
      codexCommand: 'codex exec',
    });

    const handler = new DirectReplyHandler({
      db,
      agent: {
        handleMessage: async (args) => {
          const codexResult = await args.codexTool({
            taskTitle: 'Refactor component',
            prompt: 'Apply the refactor.',
            workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
          });
          const recentTasks = await args.recentTasksTool();
          const queueSnapshot = await args.queueSnapshotTool();

          assert.equal(codexResult.task_id, 77);
          assert.equal(codexCalls[0].sourceJobId, 11);
          assert.equal(codexCalls[0].sourceMessageId, 22);
          assert.equal(recentTasks[0].title, 'Existing task');
          assert.equal(queueSnapshot.pendingJobs, 1);

          return { text: 'fallback reply' };
        },
      },
      config: createTestConfig(),
      conversationManager,
      codexTaskRunner: {
        codexRunner: { getStatus: async () => ({ ok: true }) },
        execute: async (params) => {
          codexCalls.push(params);
          return { task_id: 77 };
        },
      },
    });

    const reply = await handler.reply({
      job: { id: 11 },
      message: { id: 22, chat_id: 'chat-2', telegram_message_id: 33 },
      text: 'Do the local repo work.',
      plan: {
        reason: 'Local work required.',
        responseOutline: null,
      },
    });

    assert.equal(reply, 'fallback reply');
  } finally {
    db.close();
  }
});
