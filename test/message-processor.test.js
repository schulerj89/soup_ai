import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageProcessor } from '../src/services/message-processor.js';
import { createTestConfig, createTestDb, listOutboundMessages, queueInboundJob } from '../support/unit-helpers.js';

const config = createTestConfig({ codexMaxOutputChars: 4000 });

function createConversationManagerStub() {
  let sequence = 1;
  const state = {
    activeConversationId: null,
    conversationGeneration: 0,
    memorySummary: null,
    durableFacts: {},
    lastResetAt: null,
    lastResetReason: null,
  };

  return {
    getState() {
      return { ...state };
    },
    updateMemory(_chatId, { memorySummary = undefined, durableFacts = undefined } = {}) {
      if (memorySummary !== undefined) {
        state.memorySummary = memorySummary;
      }

      if (durableFacts !== undefined) {
        state.durableFacts = durableFacts;
      }

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
          async addItems() {},
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
          async addItems() {},
        },
      };
    },
  };
}

test('MessageProcessor lets the supervisor agent choose Codex tool usage', async () => {
  const db = createTestDb();

  try {
    const { job } = queueInboundJob(db, {
      updateId: 1,
      telegramMessageId: 11,
      chatId: 'chat-1',
      text: 'Please update the repo, run tests, commit, and push the changes.',
    });

    let codexInput = null;

    const processor = new MessageProcessor({
      db,
      agent: {
        composeAcknowledgement: async () => "Got it. I'll start that now.",
        summarizeCodexResult: async ({ codexResult }) => codexResult.summary,
        answerDirectly: async () => {
          throw new Error('answerDirectly should not run for a run_codex plan');
        },
      },
      executionPlanner: {
        plan: async () => ({
          action: 'run_codex',
          reason: 'User explicitly requested repo work.',
          responseOutline: null,
          taskTitle: 'Apply repo update',
          executionPlan: {
            goal: 'Update the repo, run tests, commit, and push the changes.',
            steps: ['Make the requested repo changes.', 'Run the relevant tests.', 'Commit and push the result.'],
            targetPaths: ['src/example.js'],
            exactFileContents: [],
            constraints: ['Do not ask for a setup acknowledgement.'],
            verification: ['npm test'],
          },
          workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
        }),
      },
      codexRunner: {
        run: async ({ prompt, workingDirectory }) => {
          codexInput = { prompt, workingDirectory };
          return {
            workingDirectory,
            command: 'codex exec ...',
            exitCode: 0,
            timedOut: false,
            structuredReport: {
              status: 'completed',
              summary: 'Changed files and ran tests.',
              files_changed: ['src/example.js'],
              verification: ['npm test'],
              remaining_work: [],
              user_message: 'Applied the requested changes.',
            },
            acknowledgedOnly: false,
            stdout: '',
            stderr: '',
          };
        },
        getStatus: async () => ({ ok: true }),
      },
      config,
      conversationManager: createConversationManagerStub(),
    });

    await processor.processJob(job);

    const outbound = listOutboundMessages(db);

    assert.equal(codexInput.workingDirectory, 'C:/Users/joshs/Projects/soup_ai');
    assert.match(
      codexInput.prompt,
      /Treat routine local file and config work as allowed, including careful edits to files like `\.env` within that directory\./,
    );
    assert.match(codexInput.prompt, /Task: Apply repo update/);
    assert.match(codexInput.prompt, /Goal:\nUpdate the repo, run tests, commit, and push the changes\./);
    assert.match(codexInput.prompt, /Target paths:\n- src\/example\.js/);
    assert.match(codexInput.prompt, /Verification:\n- npm test/);
    assert.deepEqual(outbound, ["Got it. I'll start that now.", 'Changed files and ran tests.']);

  } finally {
    db.close();
  }
});

test('MessageProcessor avoids storing raw stdout and stderr for successful structured Codex runs', async () => {
  const db = createTestDb();

  try {
    const { job } = queueInboundJob(db, {
      updateId: 41,
      telegramMessageId: 141,
      chatId: 'chat-trim-success',
      text: 'Please update the repo and summarize the result.',
    });

    const processor = new MessageProcessor({
      db,
      agent: {
        composeAcknowledgement: async () => "Got it. I'll start that now.",
        summarizeCodexResult: async ({ codexResult }) => codexResult.summary,
      },
      executionPlanner: {
        plan: async () => ({
          action: 'run_codex',
          reason: 'User requested repo work.',
          responseOutline: null,
          taskTitle: 'Trim success output',
          executionPlan: {
            goal: 'Update the repo and summarize the result.',
            steps: ['Update the repo.', 'Summarize the result.'],
            targetPaths: ['src'],
            exactFileContents: [],
            constraints: [],
            verification: ['npm test'],
          },
          workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
        }),
      },
      codexRunner: {
        run: async () => ({
          workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
          command: 'codex exec ...',
          exitCode: 0,
          timedOut: false,
          stdout: 'verbose stdout that should not be persisted',
          stderr: 'verbose stderr that should not be persisted',
          stdoutBytes: 40000,
          stderrBytes: 1200,
          stdoutTruncated: true,
          stderrTruncated: true,
          structuredReport: {
            status: 'completed',
            summary: 'Completed successfully.',
            files_changed: ['src/example.js'],
            verification: ['npm test'],
            remaining_work: [],
            user_message: 'Completed successfully.',
          },
          acknowledgedOnly: false,
        }),
      },
      config,
      conversationManager: createConversationManagerStub(),
    });

    await processor.processJob(job);

    const toolRun = JSON.parse(db.db.prepare('SELECT output_json FROM tool_runs ORDER BY id DESC LIMIT 1').get().output_json);
    assert.equal(toolRun.stdout, undefined);
    assert.equal(toolRun.stderr, undefined);
    assert.equal(toolRun.stdout_bytes, 40000);
    assert.equal(toolRun.stderr_bytes, 1200);
    assert.equal(toolRun.stdout_truncated, true);
    assert.equal(toolRun.stderr_truncated, true);
  } finally {
    db.close();
  }
});

test('MessageProcessor can queue Codex work for background execution', async () => {
  const db = createTestDb();

  try {
    const { job } = queueInboundJob(db, {
      updateId: 101,
      telegramMessageId: 111,
      chatId: 'chat-bg',
      text: 'Please inspect the repo, run tests, and summarize the result.',
    });

    const processor = new MessageProcessor({
      db,
      agent: {
        composeAcknowledgement: async () => "Got it. I'll start that now.",
      },
      executionPlanner: {
        plan: async () => ({
          action: 'run_codex',
          reason: 'User requested repo work.',
          responseOutline: null,
          taskTitle: 'Inspect repo',
          executionPlan: {
            goal: 'Inspect the repo, run tests, and summarize the result.',
            steps: ['Inspect the repo.', 'Run tests.', 'Summarize the result.'],
            targetPaths: ['src'],
            exactFileContents: [],
            constraints: [],
            verification: ['npm test'],
          },
          workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
        }),
      },
      codexRunner: {
        run: async () => {
          throw new Error('background queueing should not execute Codex inline');
        },
        getStatus: async () => ({ ok: true }),
      },
      config: createTestConfig({ allowBackgroundCodexTasks: true }),
      conversationManager: createConversationManagerStub(),
    });

    await processor.processJob(job);

    const tasks = db.listRecentTasks(1);
    const outbound = listOutboundMessages(db);

    assert.equal(tasks[0].status, 'queued');
    assert.equal(tasks[0].tool_type, 'codex');
    assert.equal(tasks[0].progress.checklist.length, 3);
    assert.deepEqual(outbound, [
      "Got it. I'll start that now.",
      `Queued task #${tasks[0].id} with checklist. I'll send the result when it finishes.`,
    ]);
  } finally {
    db.close();
  }
});

test('MessageProcessor handles built-in slash commands without invoking planning', async () => {
  const db = createTestDb();

  try {
    const { job, inbound } = queueInboundJob(db, {
      updateId: 7,
      telegramMessageId: 17,
      chatId: 'chat-commands',
      text: '/help',
    });

    let plannerCalls = 0;

    const processor = new MessageProcessor({
      db,
      agent: {},
      executionPlanner: {
        plan: async () => {
          plannerCalls += 1;
          return {
            action: 'answer_directly',
            reason: 'unused',
            responseOutline: null,
            taskTitle: null,
            executionPlan: null,
            workingDirectory: null,
          };
        },
      },
      codexRunner: {
        run: async () => {
          throw new Error('codex should not run for slash commands');
        },
        getStatus: async () => ({ ok: true }),
      },
      config,
      conversationManager: createConversationManagerStub(),
    });

    await processor.processJob(job);

    const outbound = listOutboundMessages(db);
    const processed = db.getMessageById(inbound.id);

    assert.equal(plannerCalls, 0);
    assert.deepEqual(
      outbound,
      [[
        'Commands:',
        '/help',
        '/health',
        '/status',
        '/tasks',
        '/memory',
        '/archives',
        '/reset',
        '',
        'Any other message is handled by the AI supervisor.',
      ].join('\n')],
    );
    assert.equal(processed.status, 'processed');
  } finally {
    db.close();
  }
});

test('MessageProcessor /status includes active Codex telemetry when present', async () => {
  const db = createTestDb();

  try {
    db.setActiveCodexRun({
      pid: 4321,
      taskId: 77,
      taskTitle: 'Inspect repo state',
      startedAt: '2026-04-02T22:42:13.746Z',
      timeoutAt: '2026-04-02T22:57:13.746Z',
      stdoutBytes: 128,
      stderrBytes: 32,
      lastOutputAt: '2026-04-02T22:44:00.000Z',
      outputLastMessagePath: 'C:\\temp\\codex-output.json',
    });

    const { job } = queueInboundJob(db, {
      updateId: 70,
      telegramMessageId: 170,
      chatId: 'chat-status',
      text: '/status',
    });

    const processor = new MessageProcessor({
      db,
      agent: {},
      executionPlanner: null,
      codexRunner: {
        run: async () => {
          throw new Error('codex should not run for /status');
        },
        getStatus: async () => ({ ok: true }),
      },
      config,
      conversationManager: createConversationManagerStub(),
    });

    await processor.processJob(job);

    const outbound = listOutboundMessages(db);
    assert.match(outbound[0], /activeCodexTaskId: 77/);
    assert.match(outbound[0], /activeCodexPid: 4321/);
    assert.match(outbound[0], /activeCodexTitle: Inspect repo state/);
    assert.match(outbound[0], /activeCodexTimeoutAt: 2026-04-02T22:57:13\.746Z/);
    assert.match(outbound[0], /activeCodexStdoutBytes: 128/);
    assert.match(outbound[0], /activeCodexStderrBytes: 32/);
    assert.match(outbound[0], /activeCodexLastOutputAt: 2026-04-02T22:44:00\.000Z/);
    assert.match(outbound[0], /activeCodexOutputFile: C:\\temp\\codex-output\.json/);
  } finally {
    db.close();
  }
});

test('MessageProcessor handles Telegram-style bot command suffixes for /status', async () => {
  const db = createTestDb();

  try {
    const { job } = queueInboundJob(db, {
      updateId: 71,
      telegramMessageId: 171,
      chatId: 'chat-status-suffix',
      text: '/status@soup_ai_bot',
    });

    const processor = new MessageProcessor({
      db,
      agent: {},
      executionPlanner: null,
      codexRunner: {
        run: async () => {
          throw new Error('codex should not run for /status');
        },
        getStatus: async () => ({ ok: true }),
      },
      config,
      conversationManager: createConversationManagerStub(),
    });

    await processor.processJob(job);

    const outbound = listOutboundMessages(db);
    assert.match(outbound[0], /Soup AI health/);
  } finally {
    db.close();
  }
});

test('MessageProcessor handles /status with trailing text', async () => {
  const db = createTestDb();

  try {
    const { job } = queueInboundJob(db, {
      updateId: 72,
      telegramMessageId: 172,
      chatId: 'chat-status-trailing',
      text: '/status please',
    });

    const processor = new MessageProcessor({
      db,
      agent: {},
      executionPlanner: null,
      codexRunner: {
        run: async () => {
          throw new Error('codex should not run for /status');
        },
        getStatus: async () => ({ ok: true }),
      },
      config,
      conversationManager: createConversationManagerStub(),
    });

    await processor.processJob(job);

    const outbound = listOutboundMessages(db);
    assert.match(outbound[0], /Soup AI health/);
  } finally {
    db.close();
  }
});

test('MessageProcessor /status previews queued tasks when work is waiting', async () => {
  const db = createTestDb();

  try {
    db.queueTask({
      title: 'Inspect the repo status and summarize next steps for the operator dashboard',
      checklist: ['Inspect the repo', 'Summarize next steps'],
    });
    db.queueTask({
      title: 'Review recent conversation archives',
    });

    const { job } = queueInboundJob(db, {
      updateId: 73,
      telegramMessageId: 173,
      chatId: 'chat-status-queued',
      text: '/status',
    });

    const processor = new MessageProcessor({
      db,
      agent: {},
      executionPlanner: null,
      codexRunner: {
        run: async () => {
          throw new Error('codex should not run for /status');
        },
        getStatus: async () => ({ ok: true }),
      },
      config,
      conversationManager: createConversationManagerStub(),
    });

    await processor.processJob(job);

    const outbound = listOutboundMessages(db);
    assert.match(outbound[0], /queuedTasks: 2/);
    assert.match(outbound[0], /queuedTaskPreview: #1 /);
    assert.match(outbound[0], /Inspect the repo status and summarize next steps/);
    assert.match(outbound[0], /\.\.\.\[truncated\] — Queued with checklist\./);
    assert.match(outbound[0], /#2 Review recent conversation archives — Queued\./);
  } finally {
    db.close();
  }
});

test('MessageProcessor /archives reports when no archived conversations exist', async () => {
  const db = createTestDb();

  try {
    const { job } = queueInboundJob(db, {
      updateId: 73,
      telegramMessageId: 173,
      chatId: 'chat-archives-empty',
      text: '/archives',
    });

    const processor = new MessageProcessor({
      db,
      agent: {},
      executionPlanner: null,
      codexRunner: {
        run: async () => {
          throw new Error('codex should not run for /archives');
        },
      },
      config,
      conversationManager: createConversationManagerStub(),
    });

    await processor.processJob(job);

    const outbound = listOutboundMessages(db);
    assert.equal(outbound[0], 'No archived conversations yet.');
  } finally {
    db.close();
  }
});

test('MessageProcessor /archives lists recent archived conversations for the chat', async () => {
  const db = createTestDb();

  try {
    db.archiveConversation({
      chatId: 'chat-archives',
      conversationId: 'conv_1',
      generation: 0,
      reason: 'User requested a fresh conversation via /reset.',
      memorySummary: 'Discussed the repo status and next maintenance step.',
      createdAt: '2026-04-08T10:00:00.000Z',
    });

    const { job } = queueInboundJob(db, {
      updateId: 74,
      telegramMessageId: 174,
      chatId: 'chat-archives',
      text: '/archives',
    });

    const processor = new MessageProcessor({
      db,
      agent: {},
      executionPlanner: null,
      codexRunner: {
        run: async () => {
          throw new Error('codex should not run for /archives');
        },
      },
      config,
      conversationManager: createConversationManagerStub(),
    });

    await processor.processJob(job);

    const outbound = listOutboundMessages(db);
    assert.match(outbound[0], /generation 0: User requested a fresh conversation via \/reset\./);
    assert.match(outbound[0], /conversationId: conv_1/);
    assert.match(outbound[0], /createdAt: 2026-04-08T10:00:00\.000Z/);
    assert.match(outbound[0], /summary: Discussed the repo status and next maintenance step\./);
  } finally {
    db.close();
  }
});

test('MessageProcessor still uses the supervisor agent for informational requests', async () => {
  const db = createTestDb();

  try {
    const { job } = queueInboundJob(db, {
      updateId: 2,
      telegramMessageId: 12,
      chatId: 'chat-2',
      text: 'What can GitHub CLI show me about contributions?',
    });

    let agentCalls = 0;
    let codexCalls = 0;
    const conversationManager = createConversationManagerStub();

    const processor = new MessageProcessor({
      db,
      agent: {
        answerDirectly: async () => {
          agentCalls += 1;
          return 'Informational answer';
        },
      },
      executionPlanner: {
        plan: async () => ({
          action: 'answer_directly',
          reason: 'This is an informational question.',
          responseOutline: 'Answer the question directly without using Codex.',
          taskTitle: null,
          executionPlan: null,
          workingDirectory: null,
        }),
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
      config,
      conversationManager,
    });

    await processor.processJob(job);

    const outbound = listOutboundMessages(db);

    assert.equal(agentCalls, 1);
    assert.equal(codexCalls, 0);
    assert.deepEqual(outbound, ['Informational answer']);

    assert.equal(conversationManager.getState('chat-2').activeConversationId, 'conv_1');
  } finally {
    db.close();
  }
});

test('MessageProcessor overrides answer_directly when the user explicitly asks to have Codex inspect the repo', async () => {
  const db = createTestDb();

  try {
    const { job } = queueInboundJob(db, {
      updateId: 200,
      telegramMessageId: 220,
      chatId: 'chat-explicit-codex',
      text: 'Could you have codex look into soup_ai summarize how it stores memory?',
    });

    let codexInput = null;

    const processor = new MessageProcessor({
      db,
      agent: {
        composeAcknowledgement: async () => "Got it. I'll start that now.",
        summarizeCodexResult: async ({ codexResult }) => codexResult.summary,
        answerDirectly: async () => {
          throw new Error('answerDirectly should not run for an explicit Codex request');
        },
      },
      executionPlanner: {
        plan: async () => ({
          action: 'answer_directly',
          reason: 'This is analysis work.',
          responseOutline: 'Answer with a high-level summary.',
          taskTitle: null,
          executionPlan: null,
          workingDirectory: null,
        }),
      },
      codexRunner: {
        run: async ({ prompt, workingDirectory }) => {
          codexInput = { prompt, workingDirectory };
          return {
            workingDirectory,
            command: 'codex exec ...',
            exitCode: 0,
            timedOut: false,
            structuredReport: {
              status: 'completed',
              summary: 'Inspected the repo memory storage.',
              files_changed: [],
              verification: ['Reviewed the relevant files.'],
              remaining_work: [],
              user_message: 'Inspected the repo memory storage.',
            },
            acknowledgedOnly: false,
            stdout: '',
            stderr: '',
          };
        },
        getStatus: async () => ({ ok: true }),
      },
      config,
      conversationManager: createConversationManagerStub(),
    });

    await processor.processJob(job);

    const outbound = listOutboundMessages(db);

    assert.equal(codexInput.workingDirectory, 'C:/Users/joshs/Projects/soup_ai');
    assert.match(codexInput.prompt, /Goal:\nCould you have codex look into soup_ai summarize how it stores memory\?/);
    assert.deepEqual(outbound, ["Got it. I'll start that now.", 'Inspected the repo memory storage.']);
  } finally {
    db.close();
  }
});

test('MessageProcessor reports acknowledgement-only Codex runs as incomplete when chosen by the agent', async () => {
  const db = createTestDb();

  try {
    const { job } = queueInboundJob(db, {
      updateId: 3,
      telegramMessageId: 13,
      chatId: 'chat-3',
      text: 'Please update the repo.',
    });

    const processor = new MessageProcessor({
      db,
      agent: {
        composeAcknowledgement: async () => "Got it. I'll start that now.",
        summarizeCodexResult: async ({ codexResult }) => codexResult.summary,
        answerDirectly: async () => {
          throw new Error('answerDirectly should not run for a run_codex plan');
        },
      },
      executionPlanner: {
        plan: async () => ({
          action: 'run_codex',
          reason: 'User asked for repo work.',
          responseOutline: null,
          taskTitle: 'Update repo',
          executionPlan: {
            goal: 'Please update the repo.',
            steps: ['Update the repo as requested.'],
            targetPaths: [],
            exactFileContents: [],
            constraints: [],
            verification: [],
          },
          workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
        }),
      },
      codexRunner: {
        run: async () => ({
          workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
          command: 'codex exec ...',
          exitCode: 0,
          timedOut: false,
          structuredReport: {
            status: 'failed',
            summary: 'Noted the request.',
            files_changed: [],
            verification: [],
            remaining_work: ['Need more details.'],
            user_message: 'Noted. I will treat the repo as soup_ai.',
          },
          acknowledgedOnly: true,
          stdout: 'Noted.',
          stderr: '',
        }),
        getStatus: async () => ({ ok: true }),
      },
      config,
      conversationManager: createConversationManagerStub(),
    });

    await processor.processJob(job);

    const latestTask = db.listRecentTasks(1)[0];
    const outbound = listOutboundMessages(db);

    assert.equal(latestTask.status, 'failed');
    assert.equal(outbound[1], 'Codex did not complete the requested work.');
  } finally {
    db.close();
  }
});

test('MessageProcessor keeps trimmed stderr for failed Codex runs', async () => {
  const db = createTestDb();

  try {
    const { job } = queueInboundJob(db, {
      updateId: 32,
      telegramMessageId: 132,
      chatId: 'chat-trim-failure',
      text: 'Please update the repo.',
    });

    const processor = new MessageProcessor({
      db,
      agent: {
        composeAcknowledgement: async () => "Got it. I'll start that now.",
        summarizeCodexResult: async ({ codexResult }) => codexResult.summary,
      },
      executionPlanner: {
        plan: async () => ({
          action: 'run_codex',
          reason: 'User asked for repo work.',
          responseOutline: null,
          taskTitle: 'Failure output',
          executionPlan: {
            goal: 'Please update the repo.',
            steps: ['Update the repo as requested.'],
            targetPaths: [],
            exactFileContents: [],
            constraints: [],
            verification: [],
          },
          workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
        }),
      },
      codexRunner: {
        run: async () => ({
          workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
          command: 'codex exec ...',
          exitCode: 1,
          timedOut: false,
          stdout: 'failed stdout',
          stderr: 'failed stderr',
          stdoutBytes: 13,
          stderrBytes: 13,
          structuredReport: null,
          acknowledgedOnly: false,
        }),
      },
      config,
      conversationManager: createConversationManagerStub(),
    });

    await processor.processJob(job);

    const toolRun = JSON.parse(db.db.prepare('SELECT output_json FROM tool_runs ORDER BY id DESC LIMIT 1').get().output_json);
    assert.equal(toolRun.stdout, 'failed stdout');
    assert.equal(toolRun.stderr, 'failed stderr');
    assert.equal(toolRun.result_status, 'failed');
  } finally {
    db.close();
  }
});

test('MessageProcessor fails closed when Codex returns an invalid explicit status', async () => {
  const db = createTestDb();

  try {
    const { job } = queueInboundJob(db, {
      updateId: 31,
      telegramMessageId: 131,
      chatId: 'chat-invalid-status',
      text: 'Please update the repo.',
    });

    const processor = new MessageProcessor({
      db,
      agent: {
        composeAcknowledgement: async () => "Got it. I'll start that now.",
        summarizeCodexResult: async ({ codexResult }) => codexResult.summary,
      },
      executionPlanner: {
        plan: async () => ({
          action: 'run_codex',
          reason: 'User asked for repo work.',
          responseOutline: null,
          taskTitle: 'Update repo',
          executionPlan: {
            goal: 'Please update the repo.',
            steps: ['Update the repo as requested.'],
            targetPaths: [],
            exactFileContents: [],
            constraints: [],
            verification: [],
          },
          workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
        }),
      },
      codexRunner: {
        run: async () => ({
          workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
          command: 'codex exec ...',
          exitCode: 0,
          timedOut: false,
          structuredReport: {
            status: 'done',
            summary: 'Applied the requested changes.',
            files_changed: ['src/example.js'],
            verification: ['npm test'],
            remaining_work: [],
            user_message: 'Applied the requested changes.',
          },
          acknowledgedOnly: false,
          stdout: '',
          stderr: '',
        }),
      },
      config,
      conversationManager: createConversationManagerStub(),
    });

    await processor.processJob(job);

    const latestTask = db.listRecentTasks(1)[0];
    const toolRun = JSON.parse(db.db.prepare('SELECT output_json FROM tool_runs ORDER BY id DESC LIMIT 1').get().output_json);
    const outbound = listOutboundMessages(db);

    assert.equal(latestTask.status, 'failed');
    assert.equal(toolRun.result_status, 'failed');
    assert.equal(outbound[1], 'Codex did not complete the requested work.');
  } finally {
    db.close();
  }
});

test('MessageProcessor reports partial Codex runs when changes were made but the task was not completed', async () => {
  const db = createTestDb();

  try {
    const { job } = queueInboundJob(db, {
      updateId: 5,
      telegramMessageId: 15,
      chatId: 'chat-5',
      text: 'Create the exact README file.',
    });

    const processor = new MessageProcessor({
      db,
      agent: {
        summarizeCodexResult: async ({ codexResult }) => codexResult.summary,
      },
      executionPlanner: {
        plan: async () => ({
          action: 'run_codex',
          reason: 'User asked for local repo work.',
          responseOutline: null,
          taskTitle: 'Create exact README',
          executionPlan: {
            goal: 'Create the exact requested README file.',
            steps: ['Write the requested file.'],
            targetPaths: ['telegram_codex_e2e/readme.md'],
            exactFileContents: [{ path: 'telegram_codex_e2e/readme.md', content: 'telegram smoke test' }],
            constraints: ['Do not substitute another filename or placeholder content.'],
            verification: ['Read the file back.'],
          },
          workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
        }),
      },
      codexRunner: {
        run: async () => ({
          workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
          command: 'codex exec ...',
          exitCode: 0,
          timedOut: false,
          structuredReport: {
            status: 'partial',
            summary: 'Created a placeholder README.',
            files_changed: ['telegram_codex_e2e/README.md'],
            verification: ['Read back the placeholder README.'],
            remaining_work: ['Can refine the README further if needed.'],
            user_message: 'Created the README placeholder.',
          },
          acknowledgedOnly: true,
          stdout: '',
          stderr: '',
        }),
      },
      config,
      conversationManager: createConversationManagerStub(),
    });

    await processor.processJob(job);

    const latestTask = db.listRecentTasks(1)[0];
    const toolRun = JSON.parse(db.db.prepare('SELECT output_json FROM tool_runs ORDER BY id DESC LIMIT 1').get().output_json);
    const outbound = listOutboundMessages(db);

    assert.equal(latestTask.status, 'partial');
    assert.equal(latestTask.result_summary, 'Codex changed the repo but did not complete the requested work.');
    assert.equal(toolRun.result_status, 'partial');
    assert.equal(outbound[0], "Got it. I'll start that now.");
    assert.equal(outbound[1], 'Codex changed the repo but did not complete the requested work.');
  } finally {
    db.close();
  }
});

test('MessageProcessor keeps follow-up-required Codex runs out of completed state', async () => {
  const db = createTestDb();

  try {
    const { job } = queueInboundJob(db, {
      updateId: 6,
      telegramMessageId: 16,
      chatId: 'chat-6',
      text: 'Finish the migration.',
    });

    const processor = new MessageProcessor({
      db,
      agent: {
        composeAcknowledgement: async () => "Got it. I'll start that now.",
        summarizeCodexResult: async ({ codexResult }) => codexResult.summary,
      },
      executionPlanner: {
        plan: async () => ({
          action: 'run_codex',
          reason: 'User requested local repo work.',
          responseOutline: null,
          taskTitle: 'Finish migration',
          executionPlan: {
            goal: 'Finish the migration.',
            steps: ['Apply the remaining migration work.'],
            targetPaths: ['src/migrate.js'],
            exactFileContents: [],
            constraints: [],
            verification: ['npm test'],
          },
          workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
        }),
      },
      codexRunner: {
        run: async () => ({
          workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
          command: 'codex exec ...',
          exitCode: 0,
          timedOut: false,
          structuredReport: {
            status: 'partial',
            summary: 'Applied part of the migration.',
            files_changed: ['src/migrate.js'],
            verification: ['npm test'],
            remaining_work: ['Need to update the rollback script.'],
            user_message: 'Applied part of the migration.',
          },
          acknowledgedOnly: false,
          stdout: '',
          stderr: '',
        }),
      },
      config,
      conversationManager: createConversationManagerStub(),
    });

    await processor.processJob(job);

    const latestTask = db.listRecentTasks(1)[0];
    const toolRun = JSON.parse(db.db.prepare('SELECT output_json FROM tool_runs ORDER BY id DESC LIMIT 1').get().output_json);

    assert.equal(latestTask.status, 'partial');
    assert.equal(latestTask.result_summary, 'Codex changed the repo but did not complete the requested work.');
    assert.equal(toolRun.result_status, 'partial');
  } finally {
    db.close();
  }
});

test('MessageProcessor renders exact file contents explicitly for Codex', async () => {
  const db = createTestDb();

  try {
    const { job } = queueInboundJob(db, {
      updateId: 4,
      telegramMessageId: 14,
      chatId: 'chat-4',
      text: 'Create a README with exact content.',
    });

    let renderedPrompt = null;

    const processor = new MessageProcessor({
      db,
      agent: {
        composeAcknowledgement: async () => "Got it. I'll start that now.",
        summarizeCodexResult: async ({ codexResult }) => codexResult.summary,
      },
      executionPlanner: {
        plan: async () => ({
          action: 'run_codex',
          reason: 'User requested local file creation.',
          responseOutline: null,
          taskTitle: 'Create README',
          executionPlan: {
            goal: 'Create the requested README file.',
            steps: ['Create the folder if needed.', 'Write the README file.'],
            targetPaths: ['telegram_codex_e2e/readme.md'],
            exactFileContents: [{ path: 'telegram_codex_e2e/readme.md', content: 'telegram smoke test' }],
            constraints: ['Do not add any extra text.'],
            verification: ['Read the file and confirm it matches exactly.'],
          },
          workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
        }),
      },
      codexRunner: {
        run: async ({ prompt, workingDirectory }) => {
          renderedPrompt = { prompt, workingDirectory };
          return {
            workingDirectory,
            command: 'codex exec ...',
            exitCode: 0,
            timedOut: false,
            structuredReport: {
              status: 'completed',
              summary: 'Created the README.',
              files_changed: ['telegram_codex_e2e/readme.md'],
              verification: ['Read the file and confirm it matches exactly.'],
              remaining_work: [],
              user_message: 'Created the README.',
            },
            acknowledgedOnly: false,
            stdout: '',
            stderr: '',
          };
        },
      },
      config,
      conversationManager: createConversationManagerStub(),
    });

    await processor.processJob(job);

    assert.equal(renderedPrompt.workingDirectory, 'C:/Users/joshs/Projects/soup_ai');
    assert.match(
      renderedPrompt.prompt,
      /Preserve unrelated existing values when editing config files, and do not expose secret values in the final response unless the user explicitly asked for them\./,
    );
    assert.match(renderedPrompt.prompt, /Path: telegram_codex_e2e\/readme\.md/);
    assert.match(renderedPrompt.prompt, /Content:\ntelegram smoke test/);
    assert.match(renderedPrompt.prompt, /Constraints:\n- Do not add any extra text\./);
    assert.match(renderedPrompt.prompt, /Execution checklist:/);
    assert.match(renderedPrompt.prompt, /Final response requirements:/);
    assert.match(renderedPrompt.prompt, /CODEX_RESULT_JSON:/);
  } finally {
    db.close();
  }
});

test('MessageProcessor handles /reset through the conversation manager', async () => {
  const db = createTestDb();
  const conversationManager = createConversationManagerStub();

  try {
    const { job } = queueInboundJob(db, {
      updateId: 8,
      telegramMessageId: 18,
      chatId: 'chat-reset',
      text: '/reset',
    });

    const processor = new MessageProcessor({
      db,
      agent: {},
      executionPlanner: null,
      codexRunner: {
        run: async () => {
          throw new Error('codex should not run for /reset');
        },
      },
      config,
      conversationManager,
    });

    await processor.processJob(job);

    const outbound = listOutboundMessages(db);
    assert.match(outbound[0], /Started a fresh AI conversation\./);
    assert.match(outbound[0], /conversationGeneration: 1/);
    assert.equal(conversationManager.getState('chat-reset').conversationGeneration, 1);
  } finally {
    db.close();
  }
});
