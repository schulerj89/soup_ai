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

  getDefaultAcknowledgement() {
    return "Got it. I'll start that now.";
  }

  buildConversationTools({ conversationStateTool, resetConversationTool }) {
    const tools = [];

    if (typeof conversationStateTool === 'function') {
      tools.push(
        this.toolFactory({
          name: 'get_conversation_state',
          description: 'Read the current active conversation state, summary, and recent reset metadata.',
          parameters: z.object({}),
          execute: async () => conversationStateTool(),
        }),
      );
    }

    if (typeof resetConversationTool === 'function') {
      tools.push(
        this.toolFactory({
          name: 'archive_and_reset_conversation',
          description:
            'Archive the current active conversation and start a fresh one. Use when the user asks to reset or start fresh.',
          parameters: z.object({
            reason: z.string().min(1),
          }),
          execute: async (input) => resetConversationTool({ reason: input.reason }),
        }),
      );
    }

    return tools;
  }

  buildMemoryTools({
    createNoteTool,
    searchNotesTool,
    listRecentNotesTool,
    getDurableProfileTool,
    mergeDurableProfileTool,
  }) {
    const tools = [];

    if (typeof createNoteTool === 'function') {
      tools.push(
        this.toolFactory({
          name: 'create_note',
          description:
            'Save a user note for future retrieval. Use when the user asks to remember or save something explicitly, or when preserving a durable reference would clearly help later.',
          parameters: z.object({
            title: z.string().min(1),
            body: z.string().min(1),
            tags: z.array(z.string().min(1)).max(8).default([]),
          }),
          execute: async (input) => createNoteTool(input),
        }),
      );
    }

    if (typeof searchNotesTool === 'function') {
      tools.push(
        this.toolFactory({
          name: 'search_notes',
          description: 'Search saved notes by keywords and return the most relevant recent matches.',
          parameters: z.object({
            query: z.string().min(1),
            limit: z.number().int().min(1).max(10).default(5),
          }),
          execute: async (input) => searchNotesTool(input),
        }),
      );
    }

    if (typeof listRecentNotesTool === 'function') {
      tools.push(
        this.toolFactory({
          name: 'list_recent_notes',
          description: 'List the most recent saved notes.',
          parameters: z.object({
            limit: z.number().int().min(1).max(10).default(5),
          }),
          execute: async (input) => listRecentNotesTool(input),
        }),
      );
    }

    if (typeof getDurableProfileTool === 'function') {
      tools.push(
        this.toolFactory({
          name: 'get_durable_profile',
          description:
            'Read the stored durable user profile, including preferences, routines, projects, people, and other stable long-term context.',
          parameters: z.object({}),
          execute: async () => getDurableProfileTool(),
        }),
      );
    }

    if (typeof mergeDurableProfileTool === 'function') {
      tools.push(
        this.toolFactory({
          name: 'merge_durable_profile',
          description:
            'Merge stable user information into the durable profile. Use for clear preferences, routines, important people, projects, or personal details that should persist.',
          parameters: z.object({
            patch: z.object({
              preferences: z
                .array(
                  z.object({
                    key: z.string().min(1),
                    value: z.string().min(1),
                  }),
                )
                .default([]),
              routines: z.array(z.string()).default([]),
              projects: z.array(z.string()).default([]),
              people: z
                .array(
                  z.object({
                    key: z.string().min(1),
                    value: z.string().min(1),
                  }),
                )
                .default([]),
              personal_details: z
                .array(
                  z.object({
                    key: z.string().min(1),
                    value: z.string().min(1),
                  }),
                )
                .default([]),
              important_dates: z.array(z.string()).default([]),
              saved_patterns: z.array(z.string()).default([]),
            }),
            source: z.string().min(1).default('assistant_tool'),
          }),
          execute: async (input) =>
            mergeDurableProfileTool({
              patch: {
                preferences: Object.fromEntries(input.patch.preferences.map((entry) => [entry.key, entry.value])),
                routines: input.patch.routines,
                projects: input.patch.projects,
                people: Object.fromEntries(input.patch.people.map((entry) => [entry.key, entry.value])),
                personal_details: Object.fromEntries(
                  input.patch.personal_details.map((entry) => [entry.key, entry.value]),
                ),
                important_dates: input.patch.important_dates,
                saved_patterns: input.patch.saved_patterns,
              },
              source: input.source,
            }),
        }),
      );
    }

    return tools;
  }

  buildAgent({
    codexTool,
    codexStatusTool,
    recentTasksTool,
    queueSnapshotTool,
    conversationStateTool,
    resetConversationTool,
    createNoteTool,
    searchNotesTool,
    listRecentNotesTool,
    getDurableProfileTool,
    mergeDurableProfileTool,
  }) {
    const tools = [
      this.webSearchToolFactory({
        searchContextSize: 'medium',
      }),
      ...this.buildConversationTools({ conversationStateTool, resetConversationTool }),
      ...this.buildMemoryTools({
        createNoteTool,
        searchNotesTool,
        listRecentNotesTool,
        getDurableProfileTool,
        mergeDurableProfileTool,
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
      name: 'Soup AI',
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
    try {
      const result = await this.runImpl(
        this.agentFactory({
          name: 'Soup AI',
          model: this.model,
          instructions: [
            this.systemPrompt,
            '',
            'Write a short acknowledgement for a request that will be handled through local Codex execution.',
            'Keep it to one sentence.',
            'Do not claim the work is already done.',
            'Do not ask follow-up questions.',
            'Keep the reply concise and factual.',
          ].join('\n'),
        }),
        `User message:\n${messageText}`,
        {
          context: {
            chatId,
            workspaceRoot,
          },
          maxTurns: 1,
        },
      );

      return `${result.finalOutput ?? ''}`.trim() || this.getDefaultAcknowledgement();
    } catch {
      return this.getDefaultAcknowledgement();
    }
  }

  async answerDirectly({
    chatId,
    workspaceRoot,
    messageText,
    session = null,
    responseOutline = null,
    planReason = null,
    conversationMemory = null,
    conversationStateTool = null,
    resetConversationTool = null,
    createNoteTool = null,
    searchNotesTool = null,
    listRecentNotesTool = null,
    getDurableProfileTool = null,
    mergeDurableProfileTool = null,
  }) {
    const result = await this.runImpl(
      this.agentFactory({
        name: 'Soup AI',
        model: this.model,
        instructions: [
          this.systemPrompt,
          '',
          'Answer the user directly without calling local execution tools.',
          'Use web search when the answer depends on current or recent external information.',
          'Keep the reply concise and factual.',
          'If a plan outline is provided, follow it unless the user message clearly requires a correction.',
          'Do not claim local work was performed.',
          'If the user asks to reset, archive, or start fresh, use the conversation reset tool instead of pretending it happened.',
        ].join('\n'),
        tools: [
          this.webSearchToolFactory({
            searchContextSize: 'medium',
          }),
          ...this.buildConversationTools({ conversationStateTool, resetConversationTool }),
          ...this.buildMemoryTools({
            createNoteTool,
            searchNotesTool,
            listRecentNotesTool,
            getDurableProfileTool,
            mergeDurableProfileTool,
          }),
        ],
      }),
      [
        `User message:\n${messageText}`,
        conversationMemory ? `Curated conversation memory:\n${conversationMemory}` : null,
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
        name: 'Soup AI',
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
    conversationStateTool,
    resetConversationTool,
    createNoteTool,
    searchNotesTool,
    listRecentNotesTool,
    getDurableProfileTool,
    mergeDurableProfileTool,
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
      conversationStateTool,
      resetConversationTool,
      createNoteTool,
      searchNotesTool,
      listRecentNotesTool,
      getDurableProfileTool,
      mergeDurableProfileTool,
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
