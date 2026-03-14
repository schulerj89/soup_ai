import { SqliteSession } from '../openai/sqlite-session.js';
import { buildSessionItems } from './message-processor/helpers.js';
import { ReplyQueue } from './message-processor/reply-queue.js';
import { MessageCommandHandler } from './message-processor/command-handler.js';
import { CodexTaskRunner } from './message-processor/codex-task-runner.js';

export class MessageProcessor {
  constructor({
    db,
    agent,
    executionPlanner,
    codexRunner,
    config,
    memorySummarizer = null,
    onAcknowledgementQueued = null,
  }) {
    this.db = db;
    this.agent = agent;
    this.executionPlanner = executionPlanner;
    this.config = config;
    this.memorySummarizer = memorySummarizer;
    this.onAcknowledgementQueued = onAcknowledgementQueued;
    this.replyQueue = new ReplyQueue({ db });
    this.commandHandler = new MessageCommandHandler({
      db,
      replyQueue: this.replyQueue,
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
    const session = new SqliteSession({
      db: this.db,
      chatId: message.chat_id,
    });
    const projectRoot = this.config.projectRoot ?? process.cwd();

    if (await this.commandHandler.tryHandle(message, lower)) {
      return;
    }

    const plan = this.executionPlanner
      ? await this.executionPlanner.plan({
          chatId: message.chat_id,
          messageText: text,
          workspaceRoot: this.config.workspaceRoot,
          projectRoot,
          session,
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
      await this.processCodexPlan({ job, message, text, session, plan, projectRoot });
    } else {
      await this.processDirectReply({ job, message, text, session, plan });
    }

    if (this.memorySummarizer) {
      await this.memorySummarizer.summarizeSession(session);
    }

    this.db.markMessageProcessed(message.id);
  }

  async processCodexPlan({ job, message, text, session, plan, projectRoot }) {
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

    await session.addItems(
      buildSessionItems({
        userMessage: text,
        assistantReply: userSummary || codexResult.summary,
      }),
    );
  }

  async processDirectReply({ job, message, text, session, plan }) {
    const replyText =
      typeof this.agent.answerDirectly === 'function'
        ? await this.agent.answerDirectly({
            chatId: message.chat_id,
            workspaceRoot: this.config.workspaceRoot,
            messageText: text,
            session,
            responseOutline: plan.responseOutline,
            planReason: plan.reason,
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
          }))?.text ?? 'No response text returned.');

    this.replyQueue.queue({
      chatId: message.chat_id,
      replyToMessageId: message.telegram_message_id,
      text: replyText,
    });

    await session.addItems(
      buildSessionItems({
        userMessage: text,
        assistantReply: replyText,
      }),
    );
  }
}
