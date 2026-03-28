import { ConversationManager } from './conversation-manager.js';
import { ReplyQueue } from './message-processor/reply-queue.js';
import { MessageCommandHandler } from './message-processor/command-handler.js';
import { CodexTaskRunner } from './message-processor/codex-task-runner.js';

function toPlannerItems(rows) {
  return rows
    .map((row) => {
      const text = `${row.message_text ?? ''}`.trim();

      if (!text) {
        return null;
      }

      return {
        role: row.direction === 'outbound' ? 'assistant' : 'user',
        content: [
          {
            type: row.direction === 'outbound' ? 'output_text' : 'input_text',
            text,
          },
        ],
      };
    })
    .filter(Boolean);
}

export class MessageProcessor {
  constructor({
    db,
    agent,
    executionPlanner,
    codexRunner,
    config,
    memorySummarizer = null,
    onAcknowledgementQueued = null,
    conversationManager = null,
  }) {
    this.db = db;
    this.agent = agent;
    this.executionPlanner = executionPlanner;
    this.config = config;
    this.memorySummarizer = memorySummarizer;
    this.onAcknowledgementQueued = onAcknowledgementQueued;
    this.conversationManager = conversationManager ?? new ConversationManager({ db });
    this.replyQueue = new ReplyQueue({ db });
    this.commandHandler = new MessageCommandHandler({
      db,
      replyQueue: this.replyQueue,
      conversationManager: this.conversationManager,
    });
    this.codexTaskRunner = new CodexTaskRunner({
      db,
      codexRunner,
      config,
    });
  }

  async processJob(job) {
    const message = this.db.getMessageById(job.message_id);

    if (!message) {
      throw new Error(`Message not found for job ${job.id}`);
    }

    const text = `${message.message_text ?? ''}`.trim();
    const lower = text.toLowerCase();
    const projectRoot = this.config.projectRoot ?? process.cwd();

    if (await this.commandHandler.tryHandle(message, lower)) {
      return;
    }

    const plannerSession = {
      getSnapshot: async () => {
        const state = this.conversationManager.getState(message.chat_id);
        return {
          summaryText: state.memorySummary,
          items: toPlannerItems(this.db.listConversation(message.chat_id, 8)),
        };
      },
    };

    const plan = this.executionPlanner
      ? await this.executionPlanner.plan({
          chatId: message.chat_id,
          messageText: text,
          workspaceRoot: this.config.workspaceRoot,
          projectRoot,
          session: plannerSession,
        })
      : {
          action: 'answer_directly',
          reason: 'Execution planner unavailable.',
          responseOutline: null,
          taskTitle: null,
          executionPlan: null,
          workingDirectory: projectRoot,
        };

    if (plan.action === 'run_codex') {
      await this.processCodexPlan({ job, message, text, plan, projectRoot });
    } else {
      await this.processDirectReply({ job, message, text, plan });
    }

    if (this.memorySummarizer) {
      await this.memorySummarizer.summarizeChat({
        chatId: message.chat_id,
        db: this.db,
        conversationManager: this.conversationManager,
      });
    }

    this.db.markMessageProcessed(message.id);
  }

  async processCodexPlan({ job, message, text, plan, projectRoot }) {
    const acknowledgement =
      typeof this.agent.composeAcknowledgement === 'function'
        ? await this.agent.composeAcknowledgement({
            chatId: message.chat_id,
            messageText: text,
            workspaceRoot: this.config.workspaceRoot,
          })
        : "Got it. I'll start that now.";

    this.replyQueue.queue({
      chatId: message.chat_id,
      replyToMessageId: message.telegram_message_id,
      text: acknowledgement,
    });

    if (this.onAcknowledgementQueued) {
      await this.onAcknowledgementQueued();
    }

    const codexExecution = this.codexTaskRunner.createPrompt({
      userText: text,
      plan: {
        ...plan,
        workingDirectory: plan.workingDirectory ?? projectRoot,
      },
    });

    const codexResult = await this.codexTaskRunner.execute({
      taskTitle: codexExecution.taskTitle,
      prompt: codexExecution.prompt,
      workingDirectory: codexExecution.workingDirectory,
      sourceJobId: job.id,
      sourceMessageId: message.id,
    });
    const userSummary =
      typeof this.agent.summarizeCodexResult === 'function'
        ? await this.agent.summarizeCodexResult({
            chatId: message.chat_id,
            workspaceRoot: this.config.workspaceRoot,
            userMessage: text,
            codexResult,
          })
        : null;

    this.replyQueue.queue({
      chatId: message.chat_id,
      replyToMessageId: message.telegram_message_id,
      text: this.codexTaskRunner.formatResultMessage({
        ...codexResult,
        user_summary: userSummary,
        }),
    });
  }

  async processDirectReply({ job, message, text, plan }) {
    const { session } = await this.conversationManager.getSession(message.chat_id);
    const replyText =
      typeof this.agent.answerDirectly === 'function'
        ? await this.agent.answerDirectly({
            chatId: message.chat_id,
            workspaceRoot: this.config.workspaceRoot,
            messageText: text,
            session,
            responseOutline: plan.responseOutline,
            planReason: plan.reason,
            conversationStateTool: async () => this.conversationManager.getState(message.chat_id),
            resetConversationTool: async ({ reason }) => {
              const { control } = await this.conversationManager.archiveAndReset(message.chat_id, {
                reason,
                preserveMemory: true,
              });

              return {
                ok: true,
                conversation_generation: control.conversationGeneration,
                active_conversation_id: control.activeConversationId,
                memory_preserved: true,
              };
            },
          })
        : ((await this.agent.handleMessage?.({
            chatId: message.chat_id,
            messageText: text,
            session,
            workspaceRoot: this.config.workspaceRoot,
            codexTool: async (params) =>
              this.codexTaskRunner.execute({
                ...params,
                sourceJobId: job.id,
                sourceMessageId: message.id,
              }),
            codexStatusTool: async () => this.codexTaskRunner.codexRunner.getStatus(),
            recentTasksTool: async () =>
              this.db.listRecentTasks(10).map((task) => ({
                id: task.id,
                title: task.title,
                status: task.status,
                result_summary: task.result_summary,
                created_at: task.created_at,
                completed_at: task.completed_at,
              })),
            queueSnapshotTool: async () => this.db.getQueueSnapshot(),
            conversationStateTool: async () => this.conversationManager.getState(message.chat_id),
            resetConversationTool: async ({ reason }) => {
              const { control } = await this.conversationManager.archiveAndReset(message.chat_id, {
                reason,
                preserveMemory: true,
              });

              return {
                ok: true,
                conversation_generation: control.conversationGeneration,
                active_conversation_id: control.activeConversationId,
                memory_preserved: true,
              };
            },
          }))?.text ?? 'No response text returned.');

    this.replyQueue.queue({
      chatId: message.chat_id,
      replyToMessageId: message.telegram_message_id,
      text: replyText,
    });
  }
}
