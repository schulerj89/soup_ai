import test from 'node:test';
import assert from 'node:assert/strict';
import { AppDb } from '../src/db/app-db.js';
import { MessageProcessor } from '../src/services/message-processor.js';

function buildConfig() {
  return {
    workspaceRoot: 'C:/Users/joshs/Projects',
    projectRoot: 'C:/Users/joshs/Projects/soup_ai',
    codexBin: 'codex',
    codexMaxOutputChars: 4000,
  };
}

test('MessageProcessor routes obvious code-change requests directly to Codex and acknowledges first', async () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    const inbound = db.insertInboundMessage({
      updateId: 1,
      telegramMessageId: 11,
      chatId: 'chat-1',
      replyToMessageId: null,
      text: 'Please update the repo, run tests, commit, and push the changes.',
      status: 'received',
      raw: {},
    });
    const job = db.queueJob({
      jobType: 'process_inbound_message',
      messageId: inbound.id,
      payload: {},
    });

    let agentCalls = 0;
    let codexPrompt = null;
    let acknowledgementFlushes = 0;

    const processor = new MessageProcessor({
      db,
      agent: {
        composeAcknowledgement: async () => 'Got it. I’ll start that now.',
        handleMessage: async () => {
          agentCalls += 1;
          return { text: 'unused' };
        },
      },
      codexRunner: {
        run: async ({ prompt, workingDirectory }) => {
          codexPrompt = { prompt, workingDirectory };
          return {
            workingDirectory,
            command: 'codex exec ...',
            exitCode: 0,
            timedOut: false,
            stdout: 'changed files',
            stderr: '',
          };
        },
        getStatus: async () => ({ ok: true }),
      },
      config: buildConfig(),
      onAcknowledgementQueued: async () => {
        acknowledgementFlushes += 1;
      },
    });

    await processor.processJob(job);

    const outbound = db
      .db.prepare("SELECT message_text FROM messages WHERE direction = 'outbound' ORDER BY id ASC")
      .all()
      .map((row) => row.message_text);

    assert.equal(agentCalls, 0);
    assert.equal(acknowledgementFlushes, 1);
    assert.equal(outbound.length, 2);
    assert.equal(outbound[0], 'Got it. I’ll start that now.');
    assert.match(outbound[1], /Codex completed successfully\./);
    assert.match(codexPrompt.prompt, /Do not stop to ask for clarification/);
    assert.equal(codexPrompt.workingDirectory, 'C:/Users/joshs/Projects/soup_ai');
  } finally {
    db.close();
  }
});

test('MessageProcessor still uses the supervisor agent for non-local informational requests', async () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    const inbound = db.insertInboundMessage({
      updateId: 2,
      telegramMessageId: 12,
      chatId: 'chat-2',
      replyToMessageId: null,
      text: 'What can GitHub CLI show me about contributions?',
      status: 'received',
      raw: {},
    });
    const job = db.queueJob({
      jobType: 'process_inbound_message',
      messageId: inbound.id,
      payload: {},
    });

    let agentCalls = 0;
    let codexCalls = 0;

    const processor = new MessageProcessor({
      db,
      agent: {
        composeAcknowledgement: async () => 'unused',
        handleMessage: async () => {
          agentCalls += 1;
          return { text: 'Informational answer' };
        },
      },
      codexRunner: {
        run: async () => {
          codexCalls += 1;
          return {
            workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
            command: 'codex exec ...',
            exitCode: 0,
            timedOut: false,
            stdout: '',
            stderr: '',
          };
        },
        getStatus: async () => ({ ok: true }),
      },
      config: buildConfig(),
    });

    await processor.processJob(job);

    const outbound = db
      .db.prepare("SELECT message_text FROM messages WHERE direction = 'outbound' ORDER BY id ASC")
      .all()
      .map((row) => row.message_text);

    assert.equal(agentCalls, 1);
    assert.equal(codexCalls, 0);
    assert.deepEqual(outbound, ['Informational answer']);
  } finally {
    db.close();
  }
});
