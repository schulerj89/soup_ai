import { toJson } from '../../utils/json.js';

export const taskStoreMethods = {
  failRunningWork(reason) {
    const now = this.now();
    const taskResult = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'failed',
             result_summary = ?,
             codex_exit_code = COALESCE(codex_exit_code, -1),
             completed_at = ?
         WHERE status = 'running'`,
      )
      .run(reason, now);
    const jobResult = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'failed',
             last_error = ?,
             updated_at = ?
         WHERE status = 'running'`,
      )
      .run(reason, now);

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
           details,
           codex_command,
           created_at
         ) VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(sourceJobId ?? null, sourceMessageId ?? null, title, details ?? null, codexCommand ?? null, now);

    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
  },

  completeTask(id, { resultSummary, exitCode }) {
    this.db
      .prepare(
        `UPDATE tasks
         SET status = 'completed',
             result_summary = ?,
             codex_exit_code = ?,
             completed_at = ?
         WHERE id = ?`,
      )
      .run(resultSummary ?? null, exitCode ?? null, this.now(), id);
  },

  markTaskPartial(id, { resultSummary, exitCode }) {
    this.db
      .prepare(
        `UPDATE tasks
         SET status = 'partial',
             result_summary = ?,
             codex_exit_code = ?,
             completed_at = ?
         WHERE id = ?`,
      )
      .run(resultSummary ?? null, exitCode ?? null, this.now(), id);
  },

  failTask(id, { resultSummary, exitCode }) {
    this.db
      .prepare(
        `UPDATE tasks
         SET status = 'failed',
             result_summary = ?,
             codex_exit_code = ?,
             completed_at = ?
         WHERE id = ?`,
      )
      .run(resultSummary ?? null, exitCode ?? null, this.now(), id);
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
      .all(limit);
  },

  getQueueSnapshot() {
    const pendingJobs = this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'pending'").get()
      .count;
    const runningJobs = this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'running'").get()
      .count;
    const pendingOutbound = this.db
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE direction = 'outbound' AND status = 'pending_send'")
      .get().count;
    const runningTasks = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'running'").get()
      .count;

    return { pendingJobs, runningJobs, pendingOutbound, runningTasks };
  },
};
