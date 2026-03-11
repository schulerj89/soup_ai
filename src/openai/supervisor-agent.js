import fs from 'node:fs';
import path from 'node:path';
import { Agent, run, tool, webSearchTool } from '@openai/agents';
import { z } from 'zod';
import { projectRoot } from '../utils/paths.js';

function loadSystemPrompt() {
  const promptPath = path.join(projectRoot, 'docs', 'system-prompt.md');
  return fs.readFileSync(promptPath, 'utf8');
}

export class SupervisorAgent {
  constructor({
    model,
    runImpl = run,
    agentFactory = (options) => new Agent(options),
    toolFactory = tool,
    webSearchToolFactory = webSearchTool,
  }) {
    this.model = model;
    this.runImpl = runImpl;
    this.agentFactory = agentFactory;
    this.toolFactory = toolFactory;
    this.webSearchToolFactory = webSearchToolFactory;
    this.systemPrompt = loadSystemPrompt();
  }

  buildAgent({ codexTool, codexStatusTool, recentTasksTool, queueSnapshotTool }) {
    const tools = [
      this.webSearchToolFactory({
        searchContextSize: 'medium',
      }),
    ];

    tools.push(
      this.toolFactory({
        name: 'run_codex_exec',
        description:
          'Run local work through Codex inside the approved workspace root. Use only when local machine work is required.',
        parameters: z.object({
          task_title: z.string().min(1),
          prompt: z.string().min(1),
          working_directory: z.string().min(1),
        }),
        execute: async (input) =>
          codexTool({
            taskTitle: input.task_title,
            prompt: input.prompt,
            workingDirectory: input.working_directory,
          }),
      }),
      this.toolFactory({
        name: 'get_codex_status',
        description:
          'Read local Codex configuration and recent Codex limits or usage telemetry for the current machine.',
        parameters: z.object({}),
        execute: async () => codexStatusTool(),
      }),
      this.toolFactory({
        name: 'list_recent_tasks',
        description: 'List the most recent local tasks tracked by Soup AI.',
        parameters: z.object({}),
        execute: async () => recentTasksTool(),
      }),
      this.toolFactory({
        name: 'get_supervisor_snapshot',
        description: 'Get the current local queue and task snapshot for the supervisor.',
        parameters: z.object({}),
        execute: async () => queueSnapshotTool(),
      }),
    );

    return this.agentFactory({
      name: 'Tosh the AI Bot',
      model: this.model,
      instructions: (runContext) =>
        [
          this.systemPrompt,
          '',
          `Current workspace root: ${runContext.context.workspaceRoot}`,
          `Telegram chat ID: ${runContext.context.chatId}`,
        ].join('\n'),
      tools,
    });
  }

  async composeAcknowledgement({ chatId, messageText, workspaceRoot }) {
    void chatId;
    void messageText;
    void workspaceRoot;
    return "Got it. I'll start that now.";
  }

  async answerDirectly({ chatId, workspaceRoot, messageText, session = null, responseOutline = null, planReason = null }) {
    const result = await this.runImpl(
      this.agentFactory({
        name: 'Tosh the AI Bot',
        model: this.model,
        instructions: [
          this.systemPrompt,
          '',
          'Answer the user directly without calling local execution tools.',
          'Use web search when the answer depends on current or recent external information.',
          'Keep the reply concise and factual.',
          'If a plan outline is provided, follow it unless the user message clearly requires a correction.',
          'Do not claim local work was performed.',
        ].join('\n'),
        tools: [
          this.webSearchToolFactory({
            searchContextSize: 'medium',
          }),
        ],
      }),
      [
        `User message:\n${messageText}`,
        responseOutline ? `Planned response outline:\n${responseOutline}` : null,
        planReason ? `Planner reason:\n${planReason}` : null,
      ]
        .filter(Boolean)
        .join('\n\n'),
      {
        context: {
          chatId,
          workspaceRoot,
        },
        session,
        maxTurns: 3,
      },
    );

    return `${result.finalOutput ?? ''}`.trim() || 'No response text returned.';
  }

  async summarizeCodexResult({ chatId, workspaceRoot, userMessage, codexResult }) {
    const result = await this.runImpl(
      this.agentFactory({
        name: 'Tosh the AI Bot',
        model: this.model,
        instructions: [
          this.systemPrompt,
          '',
          'Summarize a Codex run for Telegram.',
          'Keep it concise and factual.',
          'If the run is incomplete or blocked, say that clearly first.',
          'If work completed, mention the key changes, verification, and any commit or push status if present.',
          'Do not include raw CLI session boilerplate.',
        ].join('\n'),
      }),
      [
        `User request:\n${userMessage}`,
        `Structured Codex result:\n${JSON.stringify(codexResult, null, 2)}`,
      ].join('\n\n'),
      {
        context: {
          chatId,
          workspaceRoot,
        },
        maxTurns: 1,
      },
    );

    return `${result.finalOutput ?? ''}`.trim() || `${codexResult.summary ?? 'Codex run finished.'}`;
  }

  async handleMessage({
    chatId,
    messageText,
    session,
    workspaceRoot,
    codexTool,
    codexStatusTool,
    recentTasksTool,
    queueSnapshotTool,
  }) {
    if (
      typeof codexTool !== 'function' ||
      typeof codexStatusTool !== 'function' ||
      typeof recentTasksTool !== 'function' ||
      typeof queueSnapshotTool !== 'function'
    ) {
      throw new Error('SupervisorAgent requires tool callbacks for each handled message.');
    }

    const agent = this.buildAgent({
      codexTool,
      codexStatusTool,
      recentTasksTool,
      queueSnapshotTool,
    });

    const result = await this.runImpl(agent, messageText, {
      context: {
        chatId,
        workspaceRoot,
      },
      session,
      maxTurns: 8,
    });

    return {
      responseId: null,
      text: `${result.finalOutput ?? ''}`.trim() || 'No response text returned.',
    };
  }
}
