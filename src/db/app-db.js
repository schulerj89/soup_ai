import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { safeJsonParse, toJson } from '../utils/json.js';

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_update_id INTEGER UNIQUE,
  telegram_message_id INTEGER,
  reply_to_message_id INTEGER,
  chat_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  message_text TEXT,
  status TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  raw_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_created
  ON messages(chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_direction_status
  ON messages(direction, status, created_at ASC);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL,
  message_id INTEGER,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(message_id) REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created
  ON jobs(status, created_at ASC);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_job_id INTEGER,
  source_message_id INTEGER,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  details TEXT,
  result_summary TEXT,
  codex_command TEXT,
  codex_exit_code INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(source_job_id) REFERENCES jobs(id),
  FOREIGN KEY(source_message_id) REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_created
  ON tasks(created_at DESC);

CREATE TABLE IF NOT EXISTS tool_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT NOT NULL,
  exit_code INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);
`;

export class AppDb {
  constructor({ dbPath }) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA_SQL);
  }

  close() {
    this.db.close();
  }

  now() {
    return new Date().toISOString();
  }

  getState(key, fallback = null) {
    const row = this.db.prepare('SELECT value_json FROM app_state WHERE key = ?').get(key);
    return row ? safeJsonParse(row.value_json, fallback) : fallback;
  }

  setState(key, value) {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO app_state (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(key, toJson(value), now);
  }

  getAgentSessionState(chatId) {
    return this.getState(`agent_session:${chatId}`, null);
  }

  setAgentSessionState(chatId, value) {
    this.setState(`agent_session:${chatId}`, value);
  }

  clearAgentSessionState(chatId) {
    this.db.prepare('DELETE FROM app_state WHERE key = ?').run(`agent_session:${chatId}`);
  }

  getCursor(key, fallback = 0) {
    const value = this.getState(key, fallback);
    return Number.isFinite(value) ? value : fallback;
  }

  setCursor(key, value) {
    this.setState(key, value);
  }

  acquireLease(key, owner, ttlMs) {
    const now = this.now();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    const insert = this.db
      .prepare(
        `INSERT OR IGNORE INTO leases (key, owner, expires_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(key, owner, expiresAt, now);

    if (insert.changes > 0) {
      return true;
    }

    const row = this.db.prepare('SELECT owner, expires_at FROM leases WHERE key = ?').get(key);

    if (row && row.expires_at <= now) {
      const update = this.db
        .prepare(
          `UPDATE leases
           SET owner = ?, expires_at = ?, updated_at = ?
           WHERE key = ? AND expires_at <= ?`,
        )
        .run(owner, expiresAt, now, key, now);

      return update.changes > 0;
    }

    return false;
  }

  renewLease(key, owner, ttlMs) {
    const now = this.now();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE leases
         SET expires_at = ?,
             updated_at = ?
         WHERE key = ? AND owner = ?`,
      )
      .run(expiresAt, now, key, owner);

    return result.changes > 0;
  }

  getLease(key) {
    return this.db.prepare('SELECT * FROM leases WHERE key = ?').get(key) ?? null;
  }

  releaseLease(key, owner) {
    this.db.prepare('DELETE FROM leases WHERE key = ? AND owner = ?').run(key, owner);
  }

  insertInboundMessage({
    updateId,
    telegramMessageId,
    chatId,
    replyToMessageId,
    text,
    status,
    metadata = {},
    raw,
  }) {
    const now = this.now();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (
           telegram_update_id,
           telegram_message_id,
           reply_to_message_id,
           chat_id,
           direction,
           message_text,
           status,
           metadata_json,
           raw_json,
           created_at
         ) VALUES (?, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?)`,
      )
      .run(
        updateId,
        telegramMessageId ?? null,
        replyToMessageId ?? null,
        `${chatId}`,
        text ?? null,
        status,
        toJson(metadata),
        toJson(raw),
        now,
      );

    if (result.changes === 0) {
      return null;
    }

    return this.db.prepare('SELECT * FROM messages WHERE telegram_update_id = ?').get(updateId);
  }

  queueOutboundMessage({ chatId, text, replyToMessageId = null, metadata = {} }) {
    const now = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO messages (
           chat_id,
           direction,
           message_text,
           reply_to_message_id,
           status,
           metadata_json,
           raw_json,
           created_at
         ) VALUES (?, 'outbound', ?, ?, 'pending_send', ?, '{}', ?)`,
      )
      .run(`${chatId}`, text, replyToMessageId, toJson(metadata), now);

    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid);
  }

  listPendingOutbound(limit = 10) {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE direction = 'outbound' AND status = 'pending_send'
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit);
  }

  markOutboundSent(id, telegramMessageId, raw) {
    this.db
      .prepare(
        `UPDATE messages
         SET status = 'sent',
             telegram_message_id = ?,
             raw_json = ?,
             processed_at = ?
         WHERE id = ?`,
      )
      .run(telegramMessageId ?? null, toJson(raw), this.now(), id);
  }

  markOutboundFailed(id, errorMessage) {
    this.db
      .prepare(
        `UPDATE messages
         SET status = 'pending_send',
             last_error = ?,
             processed_at = NULL
         WHERE id = ?`,
      )
      .run(errorMessage, id);
  }

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
  }

  listPendingJobs(limit = 10) {
    return this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit);
  }

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
  }

  markJobCompleted(id) {
    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'completed',
             updated_at = ?
         WHERE id = ?`,
      )
      .run(this.now(), id);
  }

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
  }

  getMessageById(id) {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  }

  markMessageProcessed(id) {
    this.db
      .prepare(
        `UPDATE messages
         SET status = 'processed',
             processed_at = ?
         WHERE id = ?`,
      )
      .run(this.now(), id);
  }

  listConversation(chatId, limit = 8) {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE chat_id = ? AND message_text IS NOT NULL
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(`${chatId}`, limit)
      .reverse();
  }

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
  }

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
  }

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
  }

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
  }

  listRecentTasks(limit = 5) {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(limit);
  }

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
  }
}
