import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorAgent } from '../src/openai/supervisor-agent.js';

test('SupervisorAgent builds a Tosh agent and returns final output text', async () => {
  const toolDefinitions = [];
  let agentConfig = null;
  const agent = new SupervisorAgent({
    model: 'gpt-4.1-mini',
    agentFactory: (options) => {
      agentConfig = options;
      return { options };
    },
    toolFactory: (options) => {
      toolDefinitions.push(options);
      return options;
    },
    runImpl: async () => ({
      finalOutput: 'Finished the task.',
    }),
  });

  const result = await agent.handleMessage({
    chatId: '123',
    messageText: 'run it',
    session: { getSessionId: async () => 'session-123' },
    workspaceRoot: 'C:/Users/joshs/Projects',
    codexTool: async () => ({ ok: true }),
    codexStatusTool: async () => ({ ok: true }),
    recentTasksTool: async () => [],
    queueSnapshotTool: async () => ({ pendingJobs: 0 }),
  });

  assert.equal(result.text, 'Finished the task.');
  assert.equal(agentConfig.name, 'Tosh the AI Bot');
  assert.deepEqual(
    toolDefinitions.map((entry) => entry.name),
    ['run_codex_exec', 'get_codex_status', 'list_recent_tasks', 'get_supervisor_snapshot'],
  );
});
