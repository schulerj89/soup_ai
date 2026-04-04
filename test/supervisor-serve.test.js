import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { runSupervisorServe } from '../src/cli/supervisor-serve.js';

function createConfig() {
  return {
    dbPath: ':memory:',
    telegramBotToken: 'token',
    telegramApiBaseUrl: 'https://api.telegram.org',
    codexBin: 'codex',
    workspaceRoot: 'C:/Users/joshs/Projects',
    codexModel: 'gpt-5',
    codexEnableSearch: false,
    codexTimeoutMs: 1000,
    openAiModel: 'gpt-5',
    openAiMemoryModel: 'gpt-5-mini',
    openAiApiKey: 'test-key',
    openAiTranscriptionModel: 'gpt-4o-mini-transcribe',
    telegramPollTimeoutSeconds: 0,
  };
}

test('runSupervisorServe clears Windows keep-awake state during signal-driven shutdown', async () => {
  const logs = [];
  const errors = [];
  const events = new EventEmitter();
  let dbClosed = 0;
  let keepAwakeReleased = 0;
  let runCount = 0;

  class FakeDb {
    constructor(options) {
      assert.equal(options.dbPath, ':memory:');
    }

    close() {
      dbClosed += 1;
    }
  }

  class FakeService {
    async runOnce() {
      runCount += 1;
      events.emit('SIGTERM');
      return { skipped: false };
    }
  }

  await runSupervisorServe({
    loadConfigFn: createConfig,
    AppDbClass: FakeDb,
    TelegramClientClass: class {},
    CodexRunnerClass: class {},
    SupervisorAgentClass: class {},
    ExecutionPlannerClass: class {},
    MemorySummarizerClass: class {},
    AudioTranscriberClass: class {},
    SupervisorServiceClass: FakeService,
    createKeepAwake: async () => ({
      enabled: true,
      release() {
        keepAwakeReleased += 1;
      },
    }),
    processObject: {
      on(signal, handler) {
        events.on(signal, handler);
      },
      removeListener(signal, handler) {
        events.removeListener(signal, handler);
      },
    },
    consoleObject: {
      log(message) {
        logs.push(message);
      },
      error(message) {
        errors.push(message);
      },
    },
    sleepFn: async () => {
      throw new Error('sleep should not be reached');
    },
  });

  assert.equal(runCount, 1);
  assert.equal(keepAwakeReleased, 1);
  assert.equal(dbClosed, 1);
  assert.equal(events.listenerCount('SIGINT'), 0);
  assert.equal(events.listenerCount('SIGTERM'), 0);
  assert.deepEqual(errors, []);
  assert.ok(logs.includes('[Soup AI] Windows sleep prevention enabled for supervisor:serve.'));
  assert.ok(logs.includes('[Soup AI] Received SIGTERM; shutting down after the current cycle.'));
});
