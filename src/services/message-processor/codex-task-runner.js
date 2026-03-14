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

  formatResultMessage(result) {
    return formatCodexResultMessage(result);
  }

  async execute({ taskTitle, prompt, workingDirectory, sourceJobId, sourceMessageId }) {
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
      const resultStatus = classifyCodexResult(result);
      const summary = this.summarizeResult(result, resultStatus, structuredReport);

      this.persistTaskResult(task.id, resultStatus, summary, result.exitCode);

      const output = {
        ok: resultStatus === 'completed',
        task_id: task.id,
        task_title: taskTitle,
        summary,
        working_directory: result.workingDirectory,
        command: result.command,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        result_status: resultStatus,
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
