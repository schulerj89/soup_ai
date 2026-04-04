import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.js';
import { conversationStoreMethods } from './stores/conversation-store.js';
import { jobStoreMethods } from './stores/job-store.js';
import { leaseStoreMethods } from './stores/lease-store.js';
import { messageStoreMethods } from './stores/message-store.js';
import { noteStoreMethods } from './stores/note-store.js';
import { stateStoreMethods } from './stores/state-store.js';
import { taskStoreMethods } from './stores/task-store.js';

export class AppDb {
  constructor({ dbPath }) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA_SQL);
    this.ensureSchemaColumns();
  }

  close() {
    this.db.close();
  }

  now() {
    return new Date().toISOString();
  }

  ensureSchemaColumns() {
    const taskColumns = new Set(
      this.db
        .prepare('PRAGMA table_info(tasks)')
        .all()
        .map((column) => column.name),
    );

    const taskAlterStatements = [
      ["tool_type", "ALTER TABLE tasks ADD COLUMN tool_type TEXT NOT NULL DEFAULT 'codex'"],
      ["execution_input_json", "ALTER TABLE tasks ADD COLUMN execution_input_json TEXT NOT NULL DEFAULT '{}'"],
      ["progress_json", "ALTER TABLE tasks ADD COLUMN progress_json TEXT NOT NULL DEFAULT '{}'"],
      ["last_progress_text", 'ALTER TABLE tasks ADD COLUMN last_progress_text TEXT'],
      ["notify_chat_id", 'ALTER TABLE tasks ADD COLUMN notify_chat_id TEXT'],
      ["notify_reply_to_message_id", 'ALTER TABLE tasks ADD COLUMN notify_reply_to_message_id INTEGER'],
      ["started_at", 'ALTER TABLE tasks ADD COLUMN started_at TEXT'],
      ["updated_at", 'ALTER TABLE tasks ADD COLUMN updated_at TEXT'],
    ];

    for (const [column, statement] of taskAlterStatements) {
      if (!taskColumns.has(column)) {
        this.db.exec(statement);
      }
    }

    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_tasks_status_tool_created ON tasks(status, tool_type, created_at ASC)',
    );
  }
}

Object.assign(
  AppDb.prototype,
  stateStoreMethods,
  noteStoreMethods,
  conversationStoreMethods,
  leaseStoreMethods,
  messageStoreMethods,
  jobStoreMethods,
  taskStoreMethods,
);
