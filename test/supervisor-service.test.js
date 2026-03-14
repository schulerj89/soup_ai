import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorService } from '../src/services/supervisor-service.js';
import { createSilentLogger, createTestConfig, createTestDb } from '../support/unit-helpers.js';

const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'sample-telegram-updates.json');
const updates = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

test('SupervisorService ingests updates, processes jobs, and flushes outbound replies', async () => {
  const db = createTestDb();
  const sent = [];

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
      executionPlan: null,
      workingDirectory: null,
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
    config: createTestConfig(),
    memorySummarizer,
    logger: createSilentLogger(),
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
  const db = createTestDb();

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
          executionPlan: null,
          workingDirectory: null,
        }),
      },
      codexRunner: {
        run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      },
      config: createTestConfig(),
      logger: createSilentLogger(),
    });

    const summary = await service.runOnce();
    assert.equal(summary.skipped, true);
  } finally {
    db.close();
  }
});

test('SupervisorService heartbeat renews the lease during long work', async () => {
  const db = createTestDb();

  try {
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
          executionPlan: null,
          workingDirectory: null,
        }),
      },
      codexRunner: {
        run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      },
      config: createTestConfig({
        supervisorLeaseTtlMs: 80,
        supervisorLeaseHeartbeatMs: 20,
      }),
      logger: createSilentLogger(),
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

test('SupervisorService transcribes Telegram voice messages before processing them', async () => {
  const db = createTestDb();
  const sent = [];
  const voiceUpdates = [
    {
      update_id: 202,
      message: {
        message_id: 88,
        chat: {
          id: 999111,
          type: 'private',
        },
        date: 1736200100,
        voice: {
          file_id: 'voice-file-1',
          file_size: 4096,
          mime_type: 'audio/ogg',
        },
      },
    },
  ];

  const service = new SupervisorService({
    db,
    telegramClient: {
      getUpdates: async () => voiceUpdates,
      getFile: async (fileId) => {
        assert.equal(fileId, 'voice-file-1');
        return { file_path: 'voice/file-1.ogg' };
      },
      downloadFile: async (filePath) => {
        assert.equal(filePath, 'voice/file-1.ogg');
        return Buffer.from('ogg-audio');
      },
      sendMessage: async ({ chatId, text }) => {
        sent.push({ chatId, text });
        return { message_id: 505, text };
      },
    },
    audioTranscriber: {
      transcribe: async ({ audioBuffer, fileName, mimeType }) => {
        assert.equal(audioBuffer.toString(), 'ogg-audio');
        assert.equal(fileName, 'voice-88.ogg');
        assert.equal(mimeType, 'audio/ogg');
        return {
          text: 'Create a repo summary from this voice note.',
          model: 'gpt-4o-mini-transcribe',
        };
      },
    },
    agent: {
      answerDirectly: async ({ messageText }) => `Supervisor reply: ${messageText}`,
    },
    executionPlanner: {
      plan: async ({ messageText }) => ({
        action: 'answer_directly',
        reason: 'Voice note was transcribed into text.',
        responseOutline: `Reply directly to: ${messageText}`,
        taskTitle: null,
        executionPlan: null,
        workingDirectory: null,
      }),
    },
    codexRunner: {
      run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    },
    config: createTestConfig(),
    logger: createSilentLogger(),
  });

  try {
    const summary = await service.runOnce();
    const inbound = db.db.prepare("SELECT * FROM messages WHERE direction = 'inbound' ORDER BY id DESC LIMIT 1").get();
    const metadata = JSON.parse(inbound.metadata_json);

    assert.equal(summary.skipped, false);
    assert.equal(summary.insertedMessages, 1);
    assert.equal(summary.processedJobs, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, 'Supervisor reply: Create a repo summary from this voice note.');
    assert.equal(inbound.message_text, 'Create a repo summary from this voice note.');
    assert.equal(metadata.audio.transcription_model, 'gpt-4o-mini-transcribe');
    assert.equal(metadata.audio.telegram_file_path, 'voice/file-1.ogg');
  } finally {
    db.close();
  }
});

test('AppDb renewLease extends lease expiration for the current owner', async () => {
  const db = createTestDb();

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
