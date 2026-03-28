export const SCHEMA_SQL = `
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

CREATE TABLE IF NOT EXISTS conversation_archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  conversation_id TEXT,
  generation INTEGER NOT NULL,
  reason TEXT,
  memory_summary TEXT,
  durable_facts_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  archived_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_archives_chat_archived
  ON conversation_archives(chat_id, archived_at DESC);
`;
