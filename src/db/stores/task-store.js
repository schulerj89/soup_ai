import { safeJsonParse, toJson } from '../../utils/json.js';

function normalizeChecklist(checklist = []) {
  return Array.isArray(checklist)
    ? checklist
        .map((item, index) => {
          if (typeof item === 'string') {
            const title = item.trim();
            return title ? { id: index + 1, title, status: 'pending' } : null;
          }

          if (!item || typeof item !== 'object') {
            return null;
          }

          const title = `${item.title ?? ''}`.trim();
          if (!title) {
            return null;
          }

          return {
            id: Number.isInteger(item.id) ? item.id : index + 1,
            title,
            status: `${item.status ?? 'pending'}`.trim() || 'pending',
          };
        })
        .filter(Boolean)
    : [];
}

function parseTaskRow(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    execution_input: safeJsonParse(row.execution_input_json, {}),
    progress: safeJsonParse(row.progress_json, {}),
  };
}

function buildTaskStatusFilter(statuses) {
  const values = Array.isArray(statuses) ? statuses.filter(Boolean) : [];

  if (values.length === 0) {
    return { clause: '', params: [] };
  }

  return {
    clause: `WHERE status IN (${values.map(() => '?').join(', ')})`,
    params: values,
  };
}

export const taskStoreMethods = {
  failRunningWork(reason, { excludeTaskIds = [], excludeJobIds = [] } = {}) {
    const now = this.now();
    const taskWhere = ["status = 'running'"];

    if (excludeTaskIds.length > 0) {
      taskWhere.push(`id NOT IN (${excludeTaskIds.map(() => '?').join(', ')})`);
    }

    const taskResult = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'failed',
             result_summary = ?,
             last_progress_text = COALESCE(last_progress_text, ?),
             codex_exit_code = COALESCE(codex_exit_code, -1),
             completed_at = ?,
             updated_at = ?
         WHERE ${taskWhere.join(' AND ')}`,
      )
      .run(reason, reason, now, now, ...excludeTaskIds);

    const jobWhere = ["status = 'running'"];

    if (excludeJobIds.length > 0) {
      jobWhere.push(`id NOT IN (${excludeJobIds.map(() => '?').join(', ')})`);
    }

    const jobResult = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'failed',
             last_error = ?,
             updated_at = ?
         WHERE ${jobWhere.join(' AND ')}`,
      )
      .run(reason, now, ...excludeJobIds);

    return {
      failedTasks: taskResult.changes,
      failedJobs: jobResult.changes,
    };
  },

  createTask({ sourceJobId, sourceMessageId, title, details, codexCommand }) {
    const now = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO tasks (
           source_job_id,
           source_message_id,
           title,
           status,
           tool_type,
           details,
           execution_input_json,
           progress_json,
           last_progress_text,
           codex_command,
           created_at,
           started_at,
           updated_at
         ) VALUES (?, ?, ?, 'running', 'codex', ?, '{}', '{}', NULL, ?, ?, ?, ?)`,
      )
      .run(sourceJobId ?? null, sourceMessageId ?? null, title, details ?? null, codexCommand ?? null, now, now, now);

    return parseTaskRow(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid));
  },

  queueTask({
    sourceJobId,
    sourceMessageId,
    title,
    toolType = 'codex',
    details = null,
    executionInput = {},
    notifyChatId = null,
    notifyReplyToMessageId = null,
    checklist = [],
  }) {
    const now = this.now();
    const normalizedChecklist = normalizeChecklist(checklist);
    const progress = {
      phase: 'queued',
      checklist: normalizedChecklist,
    };
    const lastProgressText = normalizedChecklist.length > 0 ? 'Queued with checklist.' : 'Queued.';
    const result = this.db
      .prepare(
        `INSERT INTO tasks (
           source_job_id,
           source_message_id,
           title,
           status,
           tool_type,
           details,
           execution_input_json,
           progress_json,
           last_progress_text,
           notify_chat_id,
           notify_reply_to_message_id,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourceJobId ?? null,
        sourceMessageId ?? null,
        title,
        toolType,
        details ?? null,
        toJson(executionInput),
        toJson(progress),
        lastProgressText,
        notifyChatId ?? null,
        notifyReplyToMessageId ?? null,
        now,
        now,
      );

    return parseTaskRow(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid));
  },

  getTaskById(id) {
    return parseTaskRow(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  },

  listTasksByStatus(statuses, limit = 10) {
    const filter = buildTaskStatusFilter(statuses);
    return this.db
      .prepare(
        `SELECT * FROM tasks
         ${filter.clause}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...filter.params, limit)
      .map(parseTaskRow);
  },

  listQueuedTasks(limit = 10) {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit)
      .map(parseTaskRow);
  },

  listRunningTasks(limit = 10) {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'running'
         ORDER BY started_at ASC, created_at ASC
         LIMIT ?`,
      )
      .all(limit)
      .map(parseTaskRow);
  },

  claimTask(id, { startedAt = this.now(), lastProgressText = 'Started running.' } = {}) {
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'running',
             started_at = COALESCE(started_at, ?),
             updated_at = ?,
             last_progress_text = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(startedAt, startedAt, lastProgressText, id);

    return result.changes > 0 ? this.getTaskById(id) : null;
  },

  updateTaskProgress(id, { phase = null, lastProgressText = null, checklist = undefined } = {}) {
    const current = this.getTaskById(id);

    if (!current) {
      return null;
    }

    const progress = {
      ...(current.progress ?? {}),
      ...(phase ? { phase } : {}),
    };

    if (checklist !== undefined) {
      progress.checklist = normalizeChecklist(checklist);
    }

    const now = this.now();
    this.db
      .prepare(
        `UPDATE tasks
         SET progress_json = ?,
             last_progress_text = COALESCE(?, last_progress_text),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(toJson(progress), lastProgressText, now, id);

    return this.getTaskById(id);
  },

  completeTask(id, { resultSummary, exitCode }) {
    const current = this.getTaskById(id);
    const progress = {
      ...(current?.progress ?? {}),
      phase: 'completed',
      checklist: normalizeChecklist(current?.progress?.checklist ?? []).map((item) => ({ ...item, status: 'completed' })),
    };
    const now = this.now();
    this.db
      .prepare(
        `UPDATE tasks
         SET status = 'completed',
             progress_json = ?,
             result_summary = ?,
             last_progress_text = ?,
             codex_exit_code = ?,
             completed_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(toJson(progress), resultSummary ?? null, resultSummary ?? 'Completed.', exitCode ?? null, now, now, id);
  },

  markTaskPartial(id, { resultSummary, exitCode }) {
    const current = this.getTaskById(id);
    const progress = {
      ...(current?.progress ?? {}),
      phase: 'partial',
    };
    const now = this.now();
    this.db
      .prepare(
        `UPDATE tasks
         SET status = 'partial',
             progress_json = ?,
             result_summary = ?,
             last_progress_text = ?,
             codex_exit_code = ?,
             completed_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        toJson(progress),
        resultSummary ?? null,
        resultSummary ?? 'Partially completed.',
        exitCode ?? null,
        now,
        now,
        id,
      );
  },

  failTask(id, { resultSummary, exitCode }) {
    const current = this.getTaskById(id);
    const progress = {
      ...(current?.progress ?? {}),
      phase: 'failed',
    };
    const now = this.now();
    this.db
      .prepare(
        `UPDATE tasks
         SET status = 'failed',
             progress_json = ?,
             result_summary = ?,
             last_progress_text = ?,
             codex_exit_code = ?,
             completed_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(toJson(progress), resultSummary ?? null, resultSummary ?? 'Failed.', exitCode ?? null, now, now, id);
  },

  recordToolRun({ taskId, toolName, input, output, exitCode }) {
    this.db
      .prepare(
        `INSERT INTO tool_runs (
           task_id,
           tool_name,
           input_json,
           output_json,
           exit_code,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(taskId ?? null, toolName, toJson(input), toJson(output), exitCode ?? null, this.now());
  },

  listRecentTasks(limit = 5) {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(limit)
      .map(parseTaskRow);
  },

  getQueueSnapshot() {
    const pendingJobs = this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'pending'").get()
      .count;
    const runningJobs = this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'running'").get()
      .count;
    const pendingOutbound = this.db
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE direction = 'outbound' AND status = 'pending_send'")
      .get().count;
    const queuedTasks = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'queued'").get().count;
    const runningTasks = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'running'").get()
      .count;

    return { pendingJobs, runningJobs, pendingOutbound, queuedTasks, runningTasks };
  },
};
