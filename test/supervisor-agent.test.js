import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorAgent } from '../src/openai/supervisor-agent.js';

test('SupervisorAgent builds a Tosh agent and returns final output text', async () => {
  const toolDefinitions = [];
  const hostedToolDefinitions = [];
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
    webSearchToolFactory: (options) => {
      hostedToolDefinitions.push(options);
      return { type: 'hosted_tool', name: 'web_search', options };
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
  assert.equal(agentConfig.tools[0].name, 'web_search');
  assert.deepEqual(hostedToolDefinitions, [{ searchContextSize: 'medium' }]);
});

test('SupervisorAgent can compose a short acknowledgement', async () => {
  const agent = new SupervisorAgent({
    model: 'gpt-4.1-mini',
  });

  const result = await agent.composeAcknowledgement({
    chatId: '123',
    messageText: 'Please update the repo.',
    workspaceRoot: 'C:/Users/joshs/Projects',
  });

  assert.equal(result, "Got it. I'll start that now.");
});

test('SupervisorAgent answerDirectly includes hosted web search for current questions', async () => {
  const agentConfigs = [];
  const hostedToolDefinitions = [];
  let runOptions = null;
  const agent = new SupervisorAgent({
    model: 'gpt-4.1-mini',
    agentFactory: (options) => {
      agentConfigs.push(options);
      return { options };
    },
    webSearchToolFactory: (options) => {
      hostedToolDefinitions.push(options);
      return { type: 'hosted_tool', name: 'web_search', options };
    },
    runImpl: async (_agent, _input, options) => {
      runOptions = options;
      return {
        finalOutput: 'Current answer.',
      };
    },
  });

  const result = await agent.answerDirectly({
    chatId: '123',
    workspaceRoot: 'C:/Users/joshs/Projects',
    messageText: 'What happened today?',
  });

  assert.equal(result, 'Current answer.');
  assert.equal(agentConfigs[0].tools[0].name, 'web_search');
  assert.deepEqual(hostedToolDefinitions, [{ searchContextSize: 'medium' }]);
  assert.equal(runOptions.maxTurns, 3);
});
