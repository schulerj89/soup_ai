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
    projectRoot: 'C:/Users/joshs/Projects/soup_ai',
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
    composeAcknowledgement: async () => "I'll take care of that now.",
    summarizeCodexResult: async ({ codexResult }) => codexResult.summary,
    answerDirectly: async ({ messageText }) => `Supervisor reply: ${messageText}`,
  };

  const executionPlanner = {
    plan: async ({ messageText }) => ({
      action: 'answer_directly',
      reason: 'No repo execution needed for this test fixture.',
      responseOutline: `Reply directly to: ${messageText}`,
      taskTitle: null,
      codexPrompt: null,
      workingDirectory: null,
      expectedVerification: [],
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
      executionPlanner,
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
    assert.equal(sent[0].text, 'Supervisor reply: Create a repo summary');
  } finally {
    db.close();
  }
});

test('SupervisorService skips when another active lease is present', async () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    db.acquireLease('supervisor_once', 'other-owner', 60_000);

    const service = new SupervisorService({
      db,
      telegramClient: {
        getUpdates: async () => {
          throw new Error('should not fetch updates while skipped');
        },
      },
      agent: {
        answerDirectly: async () => 'unused',
      },
      executionPlanner: {
        plan: async () => ({
          action: 'answer_directly',
          reason: 'Skipped test route.',
          responseOutline: 'unused',
          taskTitle: null,
          codexPrompt: null,
          workingDirectory: null,
          expectedVerification: [],
        }),
      },
      codexRunner: {
        run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      },
      config: {
        telegramAllowedChatIds: ['999111'],
        telegramPollLimit: 25,
        telegramPollTimeoutSeconds: 0,
        maxJobsPerRun: 5,
        codexTimeoutMs: 5000,
        workspaceRoot: 'C:/Users/joshs/Projects',
        codexBin: 'codex',
        codexMaxOutputChars: 2000,
      },
      logger: { log() {}, error() {} },
    });

    const summary = await service.runOnce();
    assert.equal(summary.skipped, true);
  } finally {
    db.close();
  }
});

test('SupervisorService heartbeat renews the lease during long work', async () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    const config = {
      telegramAllowedChatIds: ['999111'],
      telegramPollLimit: 25,
      telegramPollTimeoutSeconds: 0,
      maxJobsPerRun: 5,
      codexTimeoutMs: 5000,
      supervisorLeaseTtlMs: 80,
      supervisorLeaseHeartbeatMs: 20,
      workspaceRoot: 'C:/Users/joshs/Projects',
      codexBin: 'codex',
      codexMaxOutputChars: 2000,
    };

    const service = new SupervisorService({
      db,
      telegramClient: {
        getUpdates: async () => {
          await new Promise((resolve) => setTimeout(resolve, 120));
          return [];
        },
        sendMessage: async () => ({ message_id: 1 }),
      },
      agent: {
        answerDirectly: async () => 'unused',
      },
      executionPlanner: {
        plan: async () => ({
          action: 'answer_directly',
          reason: 'Heartbeat test route.',
          responseOutline: 'unused',
          taskTitle: null,
          codexPrompt: null,
          workingDirectory: null,
          expectedVerification: [],
        }),
      },
      codexRunner: {
        run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      },
      config,
      logger: { log() {}, error() {} },
    });

    const before = Date.now();
    await service.runOnce();
    const elapsed = Date.now() - before;

    assert.ok(elapsed >= 100);
    assert.equal(db.getLease('supervisor_once'), null);
  } finally {
    db.close();
  }
});

test('AppDb renewLease extends lease expiration for the current owner', async () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    assert.equal(db.acquireLease('lease-key', 'owner-a', 20), true);
    const first = db.getLease('lease-key');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(db.renewLease('lease-key', 'owner-a', 200), true);
    const second = db.getLease('lease-key');

    assert.equal(second.owner, 'owner-a');
    assert.ok(second.expires_at > first.expires_at);
  } finally {
    db.close();
  }
});
