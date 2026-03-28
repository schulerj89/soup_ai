import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.js';
import { conversationStoreMethods } from './stores/conversation-store.js';
import { jobStoreMethods } from './stores/job-store.js';
import { leaseStoreMethods } from './stores/lease-store.js';
import { messageStoreMethods } from './stores/message-store.js';
import { stateStoreMethods } from './stores/state-store.js';
import { taskStoreMethods } from './stores/task-store.js';

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
}

Object.assign(
  AppDb.prototype,
  stateStoreMethods,
  conversationStoreMethods,
  leaseStoreMethods,
  messageStoreMethods,
  jobStoreMethods,
  taskStoreMethods,
);
