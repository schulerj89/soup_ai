import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorJobRunner } from '../src/services/supervisor-service/job-runner.js';
import { createTestDb, queueInboundJob } from '../support/unit-helpers.js';

test('SupervisorJobRunner completes successful jobs and increments attempts', async () => {
  const db = createTestDb();
  const processed = [];

  try {
    const { job } = queueInboundJob(db, {
      updateId: 41,
      telegramMessageId: 51,
      chatId: 'chat-1',
      text: 'Process me',
    });

    const runner = new SupervisorJobRunner({
      db,
      messageProcessor: {
        processJob: async (queuedJob) => {
          processed.push(queuedJob.id);
        },
      },
      logger: console,
    });

    const count = await runner.processPending(10);
    const stored = db.db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);

    assert.equal(count, 1);
    assert.deepEqual(processed, [job.id]);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.attempts, 1);
  } finally {
    db.close();
  }
});

test('SupervisorJobRunner marks failed jobs and logs the error', async () => {
  const db = createTestDb();
  const errors = [];

  try {
    const { job } = queueInboundJob(db, {
      updateId: 42,
      telegramMessageId: 52,
      chatId: 'chat-2',
      text: 'Fail me',
    });

    const runner = new SupervisorJobRunner({
      db,
      messageProcessor: {
        processJob: async () => {
          throw new Error('processor exploded');
        },
      },
      logger: {
        log() {},
        error(message) {
          errors.push(message);
        },
      },
    });

    const count = await runner.processPending(10);
    const stored = db.db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);

    assert.equal(count, 0);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.last_error, 'processor exploded');
    assert.equal(stored.attempts, 1);
    assert.match(errors[0], /Job .* processor exploded/);
  } finally {
    db.close();
  }
});
