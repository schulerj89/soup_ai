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
        execution: {
          goal: 'Create the requested file.',
          steps: ['Add the requested file to the repo.'],
          target_paths: ['notes/todo.txt'],
          exact_file_contents: [{ path: 'notes/todo.txt', content: 'hello' }],
          constraints: ['Do not modify unrelated files.'],
          verification: ['Read the file back.'],
        },
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
    executionPlan: {
      goal: 'Create the requested file.',
      steps: ['Add the requested file to the repo.'],
      targetPaths: ['notes/todo.txt'],
      exactFileContents: [{ path: 'notes/todo.txt', content: 'hello' }],
      constraints: ['Do not modify unrelated files.'],
      verification: ['Read the file back.'],
    },
    workingDirectory: 'C:/Users/joshs/Projects/soup_ai',
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
        execution: {
          goal: '',
        },
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
  assert.equal(plan.executionPlan, null);
});

test('ExecutionPlanner defaults run_codex working directory to workspace root', async () => {
  const planner = new ExecutionPlanner({
    model: 'gpt-4.1-mini',
    runImpl: async () => ({
      finalOutput: JSON.stringify({
        action: 'run_codex',
        reason: 'The user asked for local machine work under the broader workspace.',
        response_outline: null,
        task_title: 'Create folder in Projects',
        execution: {
          goal: 'Create a new folder under Projects.',
          steps: ['Create the requested folder.'],
          target_paths: ['C:/Users/joshs/Projects/example-folder'],
          exact_file_contents: [],
          constraints: [],
          verification: ['Confirm the folder exists.'],
        },
      }),
    }),
  });

  const plan = await planner.plan({
    chatId: '123',
    messageText: 'Create a folder in my Projects directory.',
    workspaceRoot: 'C:/Users/joshs/Projects',
    projectRoot: 'C:/Users/joshs/Projects/soup_ai',
    session: {
      getSnapshot: async () => ({ summaryText: null, items: [] }),
    },
  });

  assert.equal(plan.action, 'run_codex');
  assert.equal(plan.workingDirectory, 'C:/Users/joshs/Projects');
});
