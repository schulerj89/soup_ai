import { splitTelegramText, truncateText } from '../../utils/text.js';

export function createSessionTextItem(role, text, partType) {
  const normalizedText = `${text ?? ''}`.trim();

  if (!normalizedText) {
    return null;
  }

  return {
    role,
    content: [{ type: partType, text: normalizedText }],
  };
}

export function buildSessionItems({ userMessage, assistantReply }) {
  return [
    createSessionTextItem('user', userMessage, 'input_text'),
    createSessionTextItem('assistant', assistantReply, 'output_text'),
  ].filter(Boolean);
}

export function queueReplyParts(db, { chatId, text, replyToMessageId }) {
  const parts = splitTelegramText(text);

  for (let index = 0; index < parts.length; index += 1) {
    db.queueOutboundMessage({
      chatId,
      text: parts[index],
      replyToMessageId: index === 0 ? replyToMessageId : null,
    });
  }
}

export function formatTaskList(tasks) {
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

export function inferTaskTitle(text) {
  const normalized = `${text ?? ''}`.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return 'Run local Codex task';
  }

  return truncateText(normalized, 90);
}

export function buildCodexExecutionPrompt({ taskTitle, executionPlan }) {
  const lines = [];

  if (taskTitle) {
    lines.push(`Task: ${taskTitle}`);
    lines.push('');
  }

  if (executionPlan?.goal) {
    lines.push('Goal:');
    lines.push(executionPlan.goal);
    lines.push('');
  }

  if (executionPlan?.targetPaths?.length) {
    lines.push('Target paths:');
    for (const targetPath of executionPlan.targetPaths) {
      lines.push(`- ${targetPath}`);
    }
    lines.push('');
  }

  if (executionPlan?.steps?.length) {
    lines.push('Required changes:');
    for (const step of executionPlan.steps) {
      lines.push(`- ${step}`);
    }
    lines.push('');
  }

  if (executionPlan?.exactFileContents?.length) {
    lines.push('Exact file contents:');
    lines.push('Write each file exactly as shown.');

    for (const file of executionPlan.exactFileContents) {
      lines.push('');
      lines.push(`Path: ${file.path}`);
      lines.push('Content:');
      lines.push(file.content);
    }

    lines.push('');
  }

  if (executionPlan?.constraints?.length) {
    lines.push('Constraints:');
    for (const constraint of executionPlan.constraints) {
      lines.push(`- ${constraint}`);
    }
    lines.push('');
  }

  if (executionPlan?.verification?.length) {
    lines.push('Verification:');
    for (const item of executionPlan.verification) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  lines.push('Final response requirements:');
  lines.push('- Do the requested work before producing the final response.');
  lines.push('- End the final response with a JSON object that matches the provided Codex output schema.');
  lines.push('- Put that JSON object after the exact marker `CODEX_RESULT_JSON:`.');
  lines.push('- Do not write any text after the JSON object.');
  lines.push('');
  lines.push('Required ending format:');
  lines.push('CODEX_RESULT_JSON:');
  lines.push('{"completed":true,"summary":"...","files_changed":[],"verification":[],"commit_hash":null,"push_succeeded":null,"follow_up":null,"raw_user_visible_output":"..."}');
  lines.push('');

  return lines.join('\n').trim();
}

export function formatCodexResultMessage(result) {
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

function hasRecordedWork(result) {
  const report = result?.structuredReport;

  if (!report || typeof report !== 'object') {
    return false;
  }

  return (
    report.completed === true ||
    (Array.isArray(report.files_changed) && report.files_changed.length > 0) ||
    (Array.isArray(report.verification) && report.verification.length > 0) ||
    Boolean(report.commit_hash)
  );
}

function reportHasFollowUp(report) {
  return `${report?.follow_up ?? ''}`.trim().length > 0;
}

export function classifyCodexResult(result) {
  if (result.exitCode !== 0) {
    return 'failed';
  }

  const report = result?.structuredReport;

  if (report && typeof report === 'object') {
    if (report.completed === true && !reportHasFollowUp(report) && result.acknowledgedOnly !== true) {
      return 'completed';
    }

    return hasRecordedWork(result) ? 'partial' : 'failed';
  }

  return result.acknowledgedOnly === true ? 'failed' : 'completed';
}
