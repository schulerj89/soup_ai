import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { projectRoot } from '../utils/paths.js';

const TOOL_DEFINITION = {
  type: 'function',
  name: 'run_codex_exec',
  description:
    'Run local work through Codex inside the approved workspace root. Use only when local machine work is required.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      task_title: {
        type: 'string',
        description: 'Short title for the task record.',
      },
      prompt: {
        type: 'string',
        description: 'Complete prompt to send to codex exec.',
      },
      working_directory: {
        type: 'string',
        description: 'Absolute path inside the allowed workspace root.',
      },
    },
    required: ['task_title', 'prompt', 'working_directory'],
  },
};

function loadSystemPrompt() {
  const promptPath = path.join(projectRoot, 'docs', 'system-prompt.md');
  return fs.readFileSync(promptPath, 'utf8');
}

function formatConversationHistory(history) {
  if (!history.length) {
    return 'No prior conversation history is stored yet.';
  }

  return history
    .map((item) => `${item.direction === 'inbound' ? 'user' : 'assistant'}: ${item.message_text}`)
    .join('\n');
}

export class SupervisorAgent {
  constructor({ apiKey, model, client = null }) {
    this.client = client ?? new OpenAI({ apiKey });
    this.model = model;
    this.systemPrompt = loadSystemPrompt();
  }

  async handleMessage({ chatId, messageText, conversationHistory, workspaceRoot, codexTool }) {
    if (typeof codexTool !== 'function') {
      throw new Error('SupervisorAgent requires a codexTool callback for each handled message.');
    }

    const userMessage = [
      `Workspace root: ${workspaceRoot}`,
      `Telegram chat ID: ${chatId}`,
      'Recent conversation history:',
      formatConversationHistory(conversationHistory),
      'Latest user message:',
      messageText,
    ].join('\n\n');

    let response = await this.client.responses.create({
      model: this.model,
      instructions: this.systemPrompt,
      tools: [TOOL_DEFINITION],
      input: userMessage,
    });

    const toolResults = [];

    for (let iteration = 0; iteration < 3; iteration += 1) {
      const toolCalls = (response.output ?? []).filter((item) => item.type === 'function_call');

      if (toolCalls.length === 0) {
        break;
      }

      const outputs = [];

      for (const toolCall of toolCalls) {
        const args = JSON.parse(toolCall.arguments);
        const result = await codexTool({
          taskTitle: args.task_title,
          prompt: args.prompt,
          workingDirectory: args.working_directory,
        });

        toolResults.push(result);
        outputs.push({
          type: 'function_call_output',
          call_id: toolCall.call_id,
          output: JSON.stringify(result),
        });
      }

      response = await this.client.responses.create({
        model: this.model,
        instructions: this.systemPrompt,
        previous_response_id: response.id,
        tools: [TOOL_DEFINITION],
        input: outputs,
      });
    }

    return {
      responseId: response.id,
      text: response.output_text?.trim() || 'No response text returned.',
      toolResults,
    };
  }
}
