import { truncateText } from '../../utils/text.js';
import {
  buildCodexExecutionPrompt,
  classifyCodexResult,
  formatCodexResultMessage,
  inferTaskTitle,
} from './helpers.js';

export class CodexTaskRunner {
  constructor({ db, codexRunner, config }) {
    this.db = db;
    this.codexRunner = codexRunner;
    this.config = config;
  }

  createPrompt({ userText, plan }) {
    const taskTitle = plan.taskTitle ?? inferTaskTitle(userText);

    return {
      taskTitle,
      prompt: buildCodexExecutionPrompt({
        taskTitle,
        executionPlan: plan.executionPlan,
      }),
      workingDirectory: plan.workingDirectory,
    };
  }

  createExecutionInput({ taskTitle, prompt, workingDirectory, userText = null, checklist = [] }) {
    return {
      taskTitle,
      prompt,
      workingDirectory,
      userText,
      checklist,
    };
  }

  formatResultMessage(result) {
    return formatCodexResultMessage(result);
  }

  buildTrimmedOutput(result, resultStatus, structuredReport) {
    const output = {
      ok: resultStatus === 'completed',
      task_id: result.taskId,
      task_title: result.taskTitle,
      summary: result.summary,
      working_directory: result.workingDirectory,
      command: result.command,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      result_status: resultStatus,
      acknowledged_only: result.acknowledgedOnly ?? false,
      structured_report: structuredReport,
      stdout_bytes: result.stdoutBytes ?? Buffer.byteLength(`${result.stdout ?? ''}`, 'utf8'),
      stderr_bytes: result.stderrBytes ?? Buffer.byteLength(`${result.stderr ?? ''}`, 'utf8'),
      stdout_truncated: result.stdoutTruncated ?? false,
      stderr_truncated: result.stderrTruncated ?? false,
    };

    const includeStdout = resultStatus !== 'completed';
    const includeStderr = resultStatus !== 'completed';

    if (includeStdout && result.stdout) {
      output.stdout = truncateText(result.stdout, this.config.codexMaxOutputChars);
    }

    if (includeStderr && result.stderr) {
      output.stderr = truncateText(result.stderr, this.config.codexMaxOutputChars);
    }

    return output;
  }

  recordOutputProgress(fieldName, chunk, timestamp) {
    const activeRun = this.db.getActiveCodexRun();

    if (!activeRun) {
      return;
    }

    const previousBytes = Number.isFinite(activeRun[fieldName]) ? activeRun[fieldName] : 0;
    const lastOutputPreview = `${chunk}`.trim().slice(-200) || activeRun.lastOutputPreview || null;
    this.db.updateActiveCodexRun({
      [fieldName]: previousBytes + Buffer.byteLength(chunk, 'utf8'),
      lastOutputAt: timestamp,
      lastOutputPreview,
    });
  }

  buildPreviewCommand(workingDirectory) {
    return [
      this.config.codexBin,
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      workingDirectory,
      '<prompt>',
    ].join(' ');
  }

  queueExecution({
    taskTitle,
    prompt,
    workingDirectory,
    sourceJobId,
    sourceMessageId,
    notifyChatId,
    notifyReplyToMessageId,
    userText = null,
    checklist = [],
  }) {
    return this.db.queueTask({
      sourceJobId,
      sourceMessageId,
      title: taskTitle,
      toolType: 'codex',
      details: prompt,
      executionInput: this.createExecutionInput({
        taskTitle,
        prompt,
        workingDirectory,
        userText,
        checklist,
      }),
      notifyChatId,
      notifyReplyToMessageId,
      checklist,
    });
  }

  async execute({ taskTitle, prompt, workingDirectory, sourceJobId, sourceMessageId }) {
    const previewCommand = this.buildPreviewCommand(workingDirectory);

    const task = this.db.createTask({
      sourceJobId,
      sourceMessageId,
      title: taskTitle,
      details: prompt,
      codexCommand: previewCommand,
    });

    try {
      const result = await this.codexRunner.run({
        prompt,
        workingDirectory,
        onSpawn: ({ pid, startedAt, timeoutMs, outputSchemaPath, outputLastMessagePath }) => {
          this.db.setActiveCodexRun({
            pid,
            taskId: task.id,
            sourceJobId,
            sourceMessageId,
            taskTitle,
            workingDirectory,
            startedAt,
            timeoutMs,
            timeoutAt: new Date(Date.parse(startedAt) + timeoutMs).toISOString(),
            outputSchemaPath,
            outputLastMessagePath,
            stdoutBytes: 0,
            stderrBytes: 0,
            lastOutputAt: null,
            lastOutputPreview: null,
          });
        },
        onExit: () => {
          this.db.clearActiveCodexRun();
        },
        onStdout: ({ chunk, timestamp }) => {
          this.recordOutputProgress('stdoutBytes', chunk, timestamp);
        },
        onStderr: ({ chunk, timestamp }) => {
          this.recordOutputProgress('stderrBytes', chunk, timestamp);
        },
      });
      const structuredReport = result.structuredReport ?? null;
      const resultStatus = classifyCodexResult(result);
      const summary = this.summarizeResult(result, resultStatus, structuredReport);

      this.persistTaskResult(task.id, resultStatus, summary, result.exitCode);

      const output = this.buildTrimmedOutput(
        {
          ...result,
          taskId: task.id,
          taskTitle,
          summary,
        },
        resultStatus,
        structuredReport,
      );

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

  async executeQueuedTask(task) {
    const executionInput = task?.execution_input ?? {};
    const taskTitle = executionInput.taskTitle ?? task.title;
    const prompt = executionInput.prompt ?? task.details;
    const workingDirectory = executionInput.workingDirectory;
    const sourceJobId = task.source_job_id ?? null;
    const sourceMessageId = task.source_message_id ?? null;
    const previewCommand = this.buildPreviewCommand(workingDirectory);
    const claimed = this.db.claimTask(task.id, {
      lastProgressText: 'Starting Codex execution.',
    });

    if (!claimed) {
      return null;
    }

    try {
      const result = await this.codexRunner.run({
        prompt,
        workingDirectory,
        onSpawn: ({ pid, startedAt, timeoutMs, outputSchemaPath, outputLastMessagePath }) => {
          this.db.setActiveCodexRun({
            pid,
            taskId: task.id,
            sourceJobId,
            sourceMessageId,
            taskTitle,
            workingDirectory,
            startedAt,
            timeoutMs,
            timeoutAt: new Date(Date.parse(startedAt) + timeoutMs).toISOString(),
            outputSchemaPath,
            outputLastMessagePath,
            stdoutBytes: 0,
            stderrBytes: 0,
            lastOutputAt: null,
            lastOutputPreview: null,
          });
          this.db.updateTaskProgress(task.id, {
            phase: 'running',
            lastProgressText: `Running Codex in ${workingDirectory}.`,
          });
        },
        onExit: () => {
          this.db.clearActiveCodexRun();
        },
        onStdout: ({ chunk, timestamp }) => {
          this.recordOutputProgress('stdoutBytes', chunk, timestamp);
        },
        onStderr: ({ chunk, timestamp }) => {
          this.recordOutputProgress('stderrBytes', chunk, timestamp);
        },
      });
      const structuredReport = result.structuredReport ?? null;
      const resultStatus = classifyCodexResult(result);
      const summary = this.summarizeResult(result, resultStatus, structuredReport);

      this.persistTaskResult(task.id, resultStatus, summary, result.exitCode);

      const output = this.buildTrimmedOutput(
        {
          ...result,
          taskId: task.id,
          taskTitle,
          summary,
        },
        resultStatus,
        structuredReport,
      );

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

  summarizeResult(result, resultStatus, structuredReport) {
    if (resultStatus === 'failed') {
      return result.exitCode !== 0
        ? `Codex failed with exit code ${result.exitCode}.`
        : 'Codex did not complete the requested work.';
    }

    if (resultStatus === 'partial') {
      return 'Codex changed the repo but did not complete the requested work.';
    }

    return structuredReport?.summary?.trim() || 'Codex completed successfully.';
  }

  persistTaskResult(taskId, resultStatus, summary, exitCode) {
    if (resultStatus === 'completed') {
      this.db.completeTask(taskId, { resultSummary: summary, exitCode });
      return;
    }

    if (resultStatus === 'partial') {
      this.db.markTaskPartial(taskId, { resultSummary: summary, exitCode });
      return;
    }

    this.db.failTask(taskId, { resultSummary: summary, exitCode });
  }
}
