import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionPlanner } from '../src/openai/execution-planner.js';

test('ExecutionPlanner normalizes a run_codex plan', async () => {
  const planner = new ExecutionPlanner({
    model: 'gpt-4.1-mini',
    runImpl: async () => ({
      finalOutput: JSON.stringify({
        action: 'run_codex',
        reason: 'The user explicitly asked for repo work.',
        response_outline: null,
        task_title: 'Create repo file',
        working_directory: 'C:/Users/joshs/Projects/soup_ai',
        codex_prompt: 'Create the requested file.',
        expected_verification: ['Read the file back.'],
      }),
    }),
  });

  const plan = await planner.plan({
    chatId: '123',
    messageText: 'Create a file in the repo.',
    workspaceRoot: 'C:/Users/joshs/Projects',
    projectRoot: 'C:/Users/joshs/Projects/soup_ai',
    session: {
      getSnapshot: async () => ({ summaryText: null, items: [] }),
    },
  });

  assert.deepEqual(plan, {
    action: 'run_codex',
    reason: 'The user explicitly asked for repo work.',
    responseOutline: null,
    taskTitle: 'Create repo file',
    codexPrompt: 'Create the requested file.',
    workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
    expectedVerification: ['Read the file back.'],
  });
});

test('ExecutionPlanner falls back to answer_directly for invalid Codex plans', async () => {
  const planner = new ExecutionPlanner({
    model: 'gpt-4.1-mini',
    runImpl: async () => ({
      finalOutput: JSON.stringify({
        action: 'run_codex',
        reason: 'Needs repo work.',
        task_title: '',
        codex_prompt: '',
      }),
    }),
  });

  const plan = await planner.plan({
    chatId: '123',
    messageText: 'Do repo work.',
    workspaceRoot: 'C:/Users/joshs/Projects',
    projectRoot: 'C:/Users/joshs/Projects/soup_ai',
    session: {
      getSnapshot: async () => ({ summaryText: null, items: [] }),
    },
  });

  assert.equal(plan.action, 'answer_directly');
  assert.match(plan.reason, /incomplete Codex execution plan/i);
  assert.equal(plan.codexPrompt, null);
});
