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

function seemsLikeLocalWorkRequest(text) {
  const normalized = `${text ?? ''}`.toLowerCase();
  const strongPatterns = [
    /\bfix\b/,
    /\bupdate\b/,
    /\bchange\b/,
    /\bmodify\b/,
    /\bedit\b/,
    /\brefactor\b/,
    /\bimplement\b/,
    /\badd\b/,
    /\bcreate\b/,
    /\bwrite code\b/,
    /\bcode change\b/,
    /\bcommit\b/,
    /\bpush\b/,
    /\btest\b/,
    /\bcodex\b/,
    /\brepo\b/,
    /\bproject\b/,
    /\bfile\b/,
    /\bsrc\b/,
  ];

  if (strongPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const inspectionPattern =
    /\b(review|inspect|check|look at|look through|analyze|analyse|summarize|explain|walk through|read)\b/;
  const localReferencePattern =
    /\b(repo|repository|project|codebase|workspace|folder|directory|readme|docs|package\.json|src|test)\b/;
  const filePathPattern =
    /(^|[\s(])([a-z]:)?[./\\]?[\w-]+([/\\][\w.-]+)+(\.[a-z0-9]+)?(?=$|[\s),.:;!?])/i;
  const fileNamePattern = /\b[\w.-]+\.(js|mjs|cjs|ts|tsx|json|md|ps1|cmd|yml|yaml|toml)\b/;

  return (
    (inspectionPattern.test(normalized) && localReferencePattern.test(normalized)) ||
    filePathPattern.test(normalized) ||
    fileNamePattern.test(normalized)
  );
}

function extractTextParts(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (part?.type === 'input_text' || part?.type === 'output_text') {
        return part.text ?? '';
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function formatRecentSessionItems(items) {
  return items
    .map((item) => {
      const role = item?.role ?? 'unknown';
      const text = extractTextParts(item?.content).trim();
      return text ? `${role}: ${text}` : null;
    })
    .filter(Boolean)
    .join('\n');
}

function buildDirectCodexPrompt({ workspaceRoot, repoRoot, userMessage, sessionSummary, recentSessionItems }) {
  return [
    'Handle the owner request directly in the target repo.',
    'If the request is actionable, inspect the relevant files and proceed without a setup acknowledgement.',
    'Ask a clarifying question only when a real blocker makes the task unsafe or impossible to complete.',
    '',
    'Owner request:',
    userMessage,
    '',
    `Target repo: ${repoRoot}.`,
    `Workspace root: ${workspaceRoot}.`,
    sessionSummary ? `Conversation summary:\n${sessionSummary}` : 'Conversation summary:\n(none)',
    recentSessionItems ? `Recent turns:\n${recentSessionItems}` : 'Recent turns:\n(none)',
    '',
    'Interpret the owner request reasonably and perform the work directly in the target repo.',
    'If the request is read-only, inspect the relevant files and answer from actual file contents.',
    'If the request requires changes, inspect first, then implement, then verify.',
    '',
    'Required steps:',
    '1. Inspect the relevant files immediately.',
    '2. Execute the requested work immediately after inspection.',
    '3. Run relevant tests or verification commands when applicable.',
    '4. If the owner asked for git actions, commit and push only if those steps succeed.',
    '5. Return the final result in the required structured format.',
    '',
    'Constraints:',
    `- Stay inside ${repoRoot}.`,
    '- Do not claim tests, commit, or push unless command output confirms them.',
    '- Only use follow_up when the request is genuinely blocked and impossible to complete safely.',
    '- If you can answer from repository inspection, do that instead of asking for more direction.',
    '- Keep the final report factual and concise.',
  ].join('\n');
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
  constructor({ db, agent, codexRunner, config, memorySummarizer = null, onAcknowledgementQueued = null }) {
    this.db = db;
    this.agent = agent;
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

  async handleDirectCodexRequest({ job, message, text, session }) {
    const repoRoot = this.config.projectRoot ?? process.cwd();
    const snapshot = session ? await session.getSnapshot() : { summaryText: null, items: [] };
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

    const result = await this.runCodexTool({
      taskTitle: inferTaskTitle(text),
      prompt: buildDirectCodexPrompt({
        workspaceRoot: this.config.workspaceRoot,
        repoRoot,
        userMessage: text,
        sessionSummary: snapshot.summaryText,
        recentSessionItems: formatRecentSessionItems(snapshot.items.slice(-6)),
      }),
      workingDirectory: repoRoot,
      sourceJobId: job.id,
      sourceMessageId: message.id,
    });
    const userSummary =
      typeof this.agent.summarizeCodexResult === 'function'
        ? await this.agent.summarizeCodexResult({
            chatId: message.chat_id,
            workspaceRoot: this.config.workspaceRoot,
            userMessage: text,
            codexResult: result,
          })
        : null;

    this.queueReply({
      chatId: message.chat_id,
      replyToMessageId: message.telegram_message_id,
      text: formatCodexResultMessage({
        ...result,
        user_summary: userSummary,
      }),
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

    if (seemsLikeLocalWorkRequest(text)) {
      await this.handleDirectCodexRequest({ job, message, text, session });
      this.db.markMessageProcessed(message.id);
      return;
    }
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
