import { splitTelegramText, truncateText } from '../utils/text.js';
import { SqliteSession } from '../openai/sqlite-session.js';

function formatTaskList(tasks) {
  if (tasks.length === 0) {
    return 'No tracked tasks yet.';
  }

  return tasks
    .map(
      (task) =>
        `#${task.id} ${task.status.toUpperCase()} ${task.title}${
          task.result_summary ? `\n${truncateText(task.result_summary, 240)}` : ''
        }`,
    )
    .join('\n\n');
}

function inferTaskTitle(text) {
  const normalized = `${text ?? ''}`.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return 'Run local Codex task';
  }

  return truncateText(normalized, 90);
}

function formatCodexResultMessage(result) {
  if (result.user_summary) {
    return result.user_summary;
  }

  const lines = [result.summary];

  if (result.task_id) {
    lines.push(`task_id: ${result.task_id}`);
  }

  if (result.exit_code != null) {
    lines.push(`exit_code: ${result.exit_code}`);
  }

  if (result.timed_out) {
    lines.push('timed_out: true');
  }

  if (result.stdout) {
    lines.push('');
    lines.push('stdout:');
    lines.push(truncateText(result.stdout, 1200));
  }

  if (result.stderr) {
    lines.push('');
    lines.push('stderr:');
    lines.push(truncateText(result.stderr, 1200));
  }

  return lines.join('\n');
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
  }) {
    this.db = db;
    this.agent = agent;
    this.executionPlanner = executionPlanner;
    this.codexRunner = codexRunner;
    this.config = config;
    this.memorySummarizer = memorySummarizer;
    this.onAcknowledgementQueued = onAcknowledgementQueued;
  }

  queueReply({ chatId, text, replyToMessageId }) {
    const parts = splitTelegramText(text);

    for (let index = 0; index < parts.length; index += 1) {
      this.db.queueOutboundMessage({
        chatId,
        text: parts[index],
        replyToMessageId: index === 0 ? replyToMessageId : null,
      });
    }
  }

  async runCodexTool({
    taskTitle,
    prompt,
    workingDirectory,
    sourceJobId,
    sourceMessageId,
  }) {
    const previewCommand = [
      this.config.codexBin,
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      workingDirectory,
      '<prompt>',
    ].join(' ');

    const task = this.db.createTask({
      sourceJobId,
      sourceMessageId,
      title: taskTitle,
      details: prompt,
      codexCommand: previewCommand,
    });

    try {
      const result = await this.codexRunner.run({ prompt, workingDirectory });

      const structuredReport = result.structuredReport ?? null;
      const completed = result.exitCode === 0 && result.acknowledgedOnly !== true;
      const summary =
        result.exitCode !== 0
          ? `Codex failed with exit code ${result.exitCode}.`
          : result.acknowledgedOnly
            ? 'Codex did not complete the requested work.'
            : structuredReport?.summary?.trim() || 'Codex completed successfully.';

      if (completed) {
        this.db.completeTask(task.id, { resultSummary: summary, exitCode: result.exitCode });
      } else {
        this.db.failTask(task.id, { resultSummary: summary, exitCode: result.exitCode });
      }

      const output = {
        ok: completed,
        task_id: task.id,
        task_title: taskTitle,
        summary,
        working_directory: result.workingDirectory,
        command: result.command,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        acknowledged_only: result.acknowledgedOnly ?? false,
        structured_report: structuredReport,
        stdout: truncateText(result.stdout, this.config.codexMaxOutputChars),
        stderr: truncateText(result.stderr, this.config.codexMaxOutputChars),
      };

      this.db.recordToolRun({
        taskId: task.id,
        toolName: 'run_codex_exec',
        input: { taskTitle, prompt, workingDirectory },
        output,
        exitCode: result.exitCode,
      });

      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`;

      this.db.failTask(task.id, { resultSummary: message, exitCode: -1 });
      this.db.recordToolRun({
        taskId: task.id,
        toolName: 'run_codex_exec',
        input: { taskTitle, prompt, workingDirectory },
        output: { ok: false, error: message },
        exitCode: -1,
      });

      return {
        ok: false,
        task_id: task.id,
        task_title: taskTitle,
        summary: message,
        working_directory: workingDirectory,
        command: previewCommand,
        exit_code: -1,
        timed_out: false,
        stdout: '',
        stderr: message,
      };
    }
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

    if (lower === '/help') {
      this.queueReply({
        chatId: message.chat_id,
        replyToMessageId: message.telegram_message_id,
        text: [
          'Commands:',
          '/help',
          '/health',
          '/tasks',
          '',
          'Any other message is handled by the AI supervisor.',
        ].join('\n'),
      });
      this.db.markMessageProcessed(message.id);
      return;
    }

    if (lower === '/health' || lower === '/status') {
      const snapshot = this.db.getQueueSnapshot();
      this.queueReply({
        chatId: message.chat_id,
        replyToMessageId: message.telegram_message_id,
        text: [
          'Tosh the AI Bot health',
          `pendingJobs: ${snapshot.pendingJobs}`,
          `runningJobs: ${snapshot.runningJobs}`,
          `pendingOutbound: ${snapshot.pendingOutbound}`,
          `runningTasks: ${snapshot.runningTasks}`,
        ].join('\n'),
      });
      this.db.markMessageProcessed(message.id);
      return;
    }

    if (lower === '/tasks') {
      const tasks = this.db.listRecentTasks(5);
      this.queueReply({
        chatId: message.chat_id,
        replyToMessageId: message.telegram_message_id,
        text: formatTaskList(tasks),
      });
      this.db.markMessageProcessed(message.id);
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
          codexPrompt: null,
          workingDirectory: projectRoot,
          expectedVerification: [],
        };

    if (plan.action === 'run_codex') {
      const acknowledgement =
        typeof this.agent.composeAcknowledgement === 'function'
          ? await this.agent.composeAcknowledgement({
              chatId: message.chat_id,
              messageText: text,
              workspaceRoot: this.config.workspaceRoot,
            })
          : "Got it. I'll start that now.";

      this.queueReply({
        chatId: message.chat_id,
        replyToMessageId: message.telegram_message_id,
        text: acknowledgement,
      });

      if (this.onAcknowledgementQueued) {
        await this.onAcknowledgementQueued();
      }

      const codexResult = await this.runCodexTool({
        taskTitle: plan.taskTitle ?? inferTaskTitle(text),
        prompt: plan.codexPrompt,
        workingDirectory: plan.workingDirectory ?? projectRoot,
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

      this.queueReply({
        chatId: message.chat_id,
        replyToMessageId: message.telegram_message_id,
        text: formatCodexResultMessage({
          ...codexResult,
          user_summary: userSummary,
        }),
      });
    } else {
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
                this.runCodexTool({
                  ...params,
                  sourceJobId: job.id,
                  sourceMessageId: message.id,
                }),
              codexStatusTool: async () => this.codexRunner.getStatus(),
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

      this.queueReply({
        chatId: message.chat_id,
        replyToMessageId: message.telegram_message_id,
        text: replyText,
      });
    }

    if (this.memorySummarizer) {
      await this.memorySummarizer.summarizeSession(session);
    }

    this.db.markMessageProcessed(message.id);
  }
}
