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

test('MessageProcessor lets the supervisor agent choose Codex tool usage', async () => {
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

    let codexInput = null;
    let agentCalls = 0;

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
              completed: true,
              summary: 'Changed files and ran tests.',
              files_changed: ['src/example.js'],
              verification: ['npm test'],
              commit_hash: null,
              push_succeeded: null,
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
    });

    await processor.processJob(job);

    const outbound = db
      .db.prepare("SELECT message_text FROM messages WHERE direction = 'outbound' ORDER BY id ASC")
      .all()
      .map((row) => row.message_text);

    assert.equal(codexInput.workingDirectory, 'C:/Users/joshs/Projects/soup_ai');
    assert.match(codexInput.prompt, /Task: Apply repo update/);
    assert.match(codexInput.prompt, /Goal:\nUpdate the repo, run tests, commit, and push the changes\./);
    assert.match(codexInput.prompt, /Target paths:\n- src\/example\.js/);
    assert.match(codexInput.prompt, /Verification:\n- npm test/);
    assert.deepEqual(outbound, ["Got it. I'll start that now.", 'Changed files and ran tests.']);

    const sessionState = db.getAgentSessionState('chat-1');
    assert.equal(sessionState.items.length, 2);
    assert.equal(sessionState.items[0].role, 'user');
    assert.equal(
      sessionState.items[0].content[0].text,
      'Please update the repo, run tests, commit, and push the changes.',
    );
    assert.equal(sessionState.items[1].role, 'assistant');
    assert.equal(sessionState.items[1].content[0].text, 'Changed files and ran tests.');
  } finally {
    db.close();
  }
});

test('MessageProcessor still uses the supervisor agent for informational requests', async () => {
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

test('MessageProcessor reports acknowledgement-only Codex runs as incomplete when chosen by the agent', async () => {
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
            completed: false,
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

test('MessageProcessor reports partial Codex runs when changes were made but the task was not completed', async () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    const inbound = db.insertInboundMessage({
      updateId: 5,
      telegramMessageId: 15,
      chatId: 'chat-5',
      replyToMessageId: null,
      text: 'Create the exact README file.',
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
            completed: true,
            summary: 'Created a placeholder README.',
            files_changed: ['telegram_codex_e2e/README.md'],
            verification: ['Read back the placeholder README.'],
            commit_hash: null,
            push_succeeded: null,
            follow_up: 'Can refine the README further if needed.',
            raw_user_visible_output: 'Created the README placeholder.',
          },
          acknowledgedOnly: true,
          stdout: '',
          stderr: '',
        }),
      },
      config: buildConfig(),
    });

    await processor.processJob(job);

    const latestTask = db.listRecentTasks(1)[0];
    const toolRun = JSON.parse(db.db.prepare('SELECT output_json FROM tool_runs ORDER BY id DESC LIMIT 1').get().output_json);
    const outbound = db
      .db.prepare("SELECT message_text FROM messages WHERE direction = 'outbound' ORDER BY id ASC")
      .all()
      .map((row) => row.message_text);

    assert.equal(latestTask.status, 'failed');
    assert.equal(latestTask.result_summary, 'Codex changed the repo but did not complete the requested work.');
    assert.equal(toolRun.result_status, 'partial');
    assert.equal(outbound[0], "Got it. I'll start that now.");
    assert.equal(outbound[1], 'Codex changed the repo but did not complete the requested work.');
  } finally {
    db.close();
  }
});

test('MessageProcessor renders exact file contents explicitly for Codex', async () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    const inbound = db.insertInboundMessage({
      updateId: 4,
      telegramMessageId: 14,
      chatId: 'chat-4',
      replyToMessageId: null,
      text: 'Create a README with exact content.',
      status: 'received',
      raw: {},
    });
    const job = db.queueJob({
      jobType: 'process_inbound_message',
      messageId: inbound.id,
      payload: {},
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
              completed: true,
              summary: 'Created the README.',
              files_changed: ['telegram_codex_e2e/readme.md'],
              verification: ['Read the file and confirm it matches exactly.'],
              commit_hash: null,
              push_succeeded: null,
              follow_up: null,
              raw_user_visible_output: 'Created the README.',
            },
            acknowledgedOnly: false,
            stdout: '',
            stderr: '',
          };
        },
      },
      config: buildConfig(),
    });

    await processor.processJob(job);

    assert.equal(renderedPrompt.workingDirectory, 'C:/Users/joshs/Projects/soup_ai');
    assert.match(renderedPrompt.prompt, /Path: telegram_codex_e2e\/readme\.md/);
    assert.match(renderedPrompt.prompt, /Content:\ntelegram smoke test/);
    assert.match(renderedPrompt.prompt, /Constraints:\n- Do not add any extra text\./);
  } finally {
    db.close();
  }
});
