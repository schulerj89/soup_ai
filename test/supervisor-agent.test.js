import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorAgent } from '../src/openai/supervisor-agent.js';

test('SupervisorAgent executes function calls and returns final output text', async () => {
  const calls = [];
  const fakeClient = {
    responses: {
      create: async (payload) => {
        calls.push(payload);

        if (calls.length === 1) {
          return {
            id: 'resp_1',
            output: [
              {
                type: 'function_call',
                call_id: 'call_1',
                name: 'run_codex_exec',
                arguments: JSON.stringify({
                  task_title: 'Test task',
                  prompt: 'Do the thing',
                  working_directory: 'C:/Users/joshs/Projects',
                }),
              },
            ],
            output_text: '',
          };
        }

        return {
          id: 'resp_2',
          output: [],
          output_text: 'Finished the task.',
        };
      },
    },
  };

  const toolInvocations = [];
  const agent = new SupervisorAgent({
    apiKey: 'test',
    model: 'gpt-4.1-mini',
    client: fakeClient,
  });

  const result = await agent.handleMessage({
    chatId: '123',
    messageText: 'run it',
    conversationHistory: [],
    workspaceRoot: 'C:/Users/joshs/Projects',
    codexTool: async (input) => {
      toolInvocations.push(input);
      return { ok: true, summary: 'done' };
    },
  });

  assert.equal(result.text, 'Finished the task.');
  assert.equal(toolInvocations.length, 1);
  assert.equal(toolInvocations[0].taskTitle, 'Test task');
});
