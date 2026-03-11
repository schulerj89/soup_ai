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
        composeAcknowledgement: async () => "Got it. I'll start that now.",
        summarizeCodexResult: async ({ codexResult }) => codexResult.summary,
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
            structuredReport: {
              completed: true,
              summary: 'Changed files and ran tests.',
              files_changed: ['src/example.js'],
              verification: ['npm test'],
              commit_hash: 'abc1234',
              push_succeeded: true,
              follow_up: null,
              raw_user_visible_output: 'Applied the requested changes.',
            },
            acknowledgedOnly: false,
            stdout: '',
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
    assert.equal(outbound[0], "Got it. I'll start that now.");
    assert.equal(outbound[1], 'Changed files and ran tests.');
    assert.match(codexPrompt.prompt, /Conversation summary:/);
    assert.match(codexPrompt.prompt, /Ask a clarifying question only when a real blocker/);
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
        summarizeCodexResult: async () => 'unused',
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

test('MessageProcessor marks acknowledgement-only Codex runs as incomplete', async () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    const inbound = db.insertInboundMessage({
      updateId: 3,
      telegramMessageId: 13,
      chatId: 'chat-3',
      replyToMessageId: null,
      text: 'Please update the repo.',
      status: 'received',
      raw: {},
    });
    const job = db.queueJob({
      jobType: 'process_inbound_message',
      messageId: inbound.id,
      payload: {},
    });

    const processor = new MessageProcessor({
      db,
      agent: {
        composeAcknowledgement: async () => "Got it. I'll start that now.",
        summarizeCodexResult: async ({ codexResult }) => codexResult.summary,
        handleMessage: async () => ({ text: 'unused' }),
      },
      codexRunner: {
        run: async () => ({
          workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
          command: 'codex exec ...',
          exitCode: 0,
          timedOut: false,
          structuredReport: {
            completed: true,
            summary: 'Noted the request.',
            files_changed: [],
            verification: [],
            commit_hash: null,
            push_succeeded: null,
            follow_up: 'Need more details.',
            raw_user_visible_output: 'Noted. I will treat the repo as soup_ai.',
          },
          acknowledgedOnly: true,
          stdout: 'Noted.',
          stderr: '',
        }),
        getStatus: async () => ({ ok: true }),
      },
      config: buildConfig(),
    });

    await processor.processJob(job);

    const latestTask = db.listRecentTasks(1)[0];
    const outbound = db
      .db.prepare("SELECT message_text FROM messages WHERE direction = 'outbound' ORDER BY id ASC")
      .all()
      .map((row) => row.message_text);

    assert.equal(latestTask.status, 'failed');
    assert.equal(outbound[1], 'Codex did not complete the requested work.');
  } finally {
    db.close();
  }
});
