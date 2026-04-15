import { splitTelegramText, truncateText } from '../../utils/text.js';

const TASK_PREVIEW_TRUNCATE_LENGTH = 60;

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
    .map((task) => {
      const lines = [`#${task.id} ${task.status.toUpperCase()} [${`${task.tool_type ?? 'codex'}`.toUpperCase()}] ${task.title}`];

      if (task.last_progress_text) {
        lines.push(truncateText(task.last_progress_text, 240));
      }

      const checklist = Array.isArray(task.progress?.checklist) ? task.progress.checklist : [];
      if (checklist.length > 0) {
        const completed = checklist.filter((item) => item.status === 'completed').length;
        lines.push(`checklist: ${completed}/${checklist.length} complete`);
      }

      if (task.result_summary) {
        lines.push(truncateText(task.result_summary, 240));
      }

      return lines.join('\n');
    })
    .join('\n\n');
}

export function formatTaskPreview(tasks) {
  return tasks
    .map((task) => {
      const parts = [`#${task.id}`, truncateText(task.title || 'Untitled task', TASK_PREVIEW_TRUNCATE_LENGTH)];
      const progressText = `${task.last_progress_text ?? ''}`.trim();

      if (progressText) {
        parts.push(`— ${truncateText(progressText, TASK_PREVIEW_TRUNCATE_LENGTH)}`);
      }

      return parts.join(' ');
    })
    .join(' | ');
}

export function formatConversationArchiveList(archives) {
  if (archives.length === 0) {
    return 'No archived conversations yet.';
  }

  return archives
    .map((archive) => {
      const lines = [`generation ${archive.generation}: ${archive.reason ?? 'Archived conversation'}`];
      lines.push(`archivedAt: ${archive.archived_at ?? '(unknown)'}`);

      if (archive.conversation_id) {
        lines.push(`conversationId: ${archive.conversation_id}`);
      }

      if (archive.created_at) {
        lines.push(`createdAt: ${archive.created_at}`);
      }

      if (`${archive.memory_summary ?? ''}`.trim()) {
        lines.push(`summary: ${truncateText(archive.memory_summary, 240)}`);
      }

      return lines.join('\n');
    })
    .join('\n\n');
}

export function shouldUseTodoChecklist(executionPlan) {
  const steps = Array.isArray(executionPlan?.steps) ? executionPlan.steps.filter(Boolean) : [];
  const verification = Array.isArray(executionPlan?.verification)
    ? executionPlan.verification.filter(Boolean)
    : [];

  return steps.length >= 2 || verification.length >= 2;
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
  const useChecklist = shouldUseTodoChecklist(executionPlan);

  lines.push('You are operating as the owner\'s local computer assistant inside the approved working directory.');
  lines.push('Treat routine local file and config work as allowed, including careful edits to files like `.env` within that directory.');
  lines.push('Preserve unrelated existing values when editing config files, and do not expose secret values in the final response unless the user explicitly asked for them.');
  lines.push('');

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

  if (useChecklist) {
    lines.push('Execution checklist:');
    lines.push('Work through the checklist deliberately and make sure the final result covers each required step.');
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
  lines.push('- Set `status` to one of `completed`, `partial`, or `failed` so the outcome is explicit.');
  lines.push('- Use `completed` only when the requested work is actually finished.');
  lines.push('- Use `partial` when some work was done but follow-up is still required.');
  lines.push('- Use `failed` when the requested work was not completed.');
  lines.push('- Use `remaining_work` for unfinished required work, not optional suggestions.');
  lines.push('- Include `git` only if commit or push was attempted.');
  lines.push('- Put that JSON object after the exact marker `CODEX_RESULT_JSON:`.');
  lines.push('- Do not write any text after the JSON object.');
  lines.push('');
  lines.push('Required ending format:');
  lines.push('CODEX_RESULT_JSON:');
  lines.push('{"status":"completed","summary":"...","files_changed":[],"verification":[],"remaining_work":[],"user_message":"..."}');
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

  const structuredStatus = normalizeStructuredStatus(report);

  return (
    (structuredStatus.kind === 'valid' && structuredStatus.value === 'completed') ||
    (Array.isArray(report.files_changed) && report.files_changed.length > 0) ||
    (Array.isArray(report.verification) && report.verification.length > 0) ||
    (Array.isArray(report.git?.commit_hashes) && report.git.commit_hashes.length > 0)
  );
}

function reportHasFollowUp(report) {
  return Array.isArray(report?.remaining_work) && report.remaining_work.some((item) => `${item ?? ''}`.trim().length > 0);
}

function normalizeStructuredStatus(report) {
  const status = `${report?.status ?? ''}`.trim().toLowerCase();

  if (!status) {
    return { kind: 'missing', value: null };
  }

  if (['completed', 'partial', 'failed'].includes(status)) {
    return { kind: 'valid', value: status };
  }

  return { kind: 'invalid', value: status };
}

export function classifyCodexResult(result) {
  if (result.exitCode !== 0) {
    return 'failed';
  }

  const report = result?.structuredReport;

  if (report && typeof report === 'object') {
    const structuredStatus = normalizeStructuredStatus(report);

    if (structuredStatus.kind === 'valid') {
      return structuredStatus.value;
    }

    if (structuredStatus.kind === 'invalid') {
      return 'failed';
    }

    if (report.completed === true && !reportHasFollowUp(report) && result.acknowledgedOnly !== true) {
      return 'completed';
    }

    return hasRecordedWork(result) ? 'partial' : 'failed';
  }

  return result.acknowledgedOnly === true ? 'failed' : 'completed';
}
