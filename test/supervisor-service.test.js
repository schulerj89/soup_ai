import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AppDb } from '../src/db/app-db.js';
import { SupervisorService } from '../src/services/supervisor-service.js';

const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'sample-telegram-updates.json');
const updates = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

test('SupervisorService ingests updates, processes jobs, and flushes outbound replies', async () => {
  const db = new AppDb({ dbPath: ':memory:' });
  const sent = [];

  const config = {
    telegramAllowedChatIds: ['999111'],
    telegramPollLimit: 25,
    telegramPollTimeoutSeconds: 0,
    maxJobsPerRun: 5,
    codexTimeoutMs: 5000,
    workspaceRoot: 'C:/Users/joshs/Projects',
    codexBin: 'codex',
    codexMaxOutputChars: 2000,
  };

  const telegramClient = {
    getUpdates: async () => updates,
    sendMessage: async ({ chatId, text }) => {
      sent.push({ chatId, text });
      return { message_id: 404, text };
    },
  };

  const agent = {
    handleMessage: async ({ messageText }) => ({
      text: `Supervisor reply: ${messageText}`,
      toolResults: [],
    }),
  };

  const memorySummarizer = {
    summarizeSession: async () => ({ summarized: false }),
  };

  const codexRunner = {
    run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
  };

  const service = new SupervisorService({
    db,
    telegramClient,
    agent,
    codexRunner,
    config,
    memorySummarizer,
    logger: { log() {}, error() {} },
  });

  try {
    const summary = await service.runOnce();

    assert.equal(summary.skipped, false);
    assert.equal(summary.updatesReceived, 1);
    assert.equal(summary.processedJobs, 1);
    assert.equal(summary.sentMessages, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Supervisor reply/);
  } finally {
    db.close();
  }
});
