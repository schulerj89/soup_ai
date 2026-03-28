import { toJson } from '../../utils/json.js';

export const jobStoreMethods = {
  queueJob({ jobType, messageId, payload }) {
    const now = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO jobs (
           job_type,
           message_id,
           payload_json,
           status,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, 'pending', ?, ?)`,
      )
      .run(jobType, messageId ?? null, toJson(payload), now, now);

    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);
  },

  listPendingJobs(limit = 10) {
    return this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit);
  },

  markJobRunning(id) {
    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'running',
             attempts = attempts + 1,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(this.now(), id);
  },

  markJobCompleted(id) {
    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'completed',
             updated_at = ?
         WHERE id = ?`,
      )
      .run(this.now(), id);
  },

  markJobFailed(id, errorMessage) {
    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'failed',
             last_error = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(errorMessage, this.now(), id);
  },
};
