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

export class MessageProcessor {
  constructor({ db, agent, codexRunner, config, memorySummarizer = null }) {
    this.db = db;
    this.agent = agent;
    this.codexRunner = codexRunner;
    this.config = config;
    this.memorySummarizer = memorySummarizer;
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

  async runCodexTool({ taskTitle, prompt, workingDirectory, sourceJobId, sourceMessageId }) {
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
      const summary =
        result.exitCode === 0
          ? 'Codex completed successfully.'
          : `Codex failed with exit code ${result.exitCode}.`;

      if (result.exitCode === 0) {
        this.db.completeTask(task.id, { resultSummary: summary, exitCode: result.exitCode });
      } else {
        this.db.failTask(task.id, { resultSummary: summary, exitCode: result.exitCode });
      }

      const output = {
        ok: result.exitCode === 0,
        task_id: task.id,
        task_title: taskTitle,
        summary,
        working_directory: result.workingDirectory,
        command: result.command,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
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

    const session = new SqliteSession({
      db: this.db,
      chatId: message.chat_id,
    });
    const result = await this.agent.handleMessage({
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
    });

    this.queueReply({
      chatId: message.chat_id,
      replyToMessageId: message.telegram_message_id,
      text: result.text,
    });

    if (this.memorySummarizer) {
      await this.memorySummarizer.summarizeSession(session);
    }

    this.db.markMessageProcessed(message.id);
  }
}
