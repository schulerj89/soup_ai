import { AppDb } from '../src/db/app-db.js';

const TEST_CONFIG = {
  workspaceRoot: 'C:/Users/joshs/Projects',
  projectRoot: 'C:/Users/joshs/Projects/soup_ai',
  codexBin: 'codex',
  codexMaxOutputChars: 2000,
  codexTimeoutMs: 5000,
  telegramAllowedChatIds: ['999111'],
  telegramPollLimit: 25,
  telegramPollTimeoutSeconds: 0,
  telegramAudioMaxFileBytes: 24 * 1024 * 1024,
  maxJobsPerRun: 5,
};

export function createTestDb() {
  return new AppDb({ dbPath: ':memory:' });
}

export function createTestConfig(overrides = {}) {
  return {
    ...TEST_CONFIG,
    ...overrides,
  };
}

export function queueInboundJob(
  db,
  { updateId, telegramMessageId, chatId, text, replyToMessageId = null, raw = {}, payload = {} },
) {
  const inbound = db.insertInboundMessage({
    updateId,
    telegramMessageId,
    chatId,
    replyToMessageId,
    text,
    status: 'received',
    raw,
  });
  const job = db.queueJob({
    jobType: 'process_inbound_message',
    messageId: inbound.id,
    payload,
  });

  return { inbound, job };
}

export function listOutboundMessages(db) {
  return db
    .db.prepare("SELECT message_text FROM messages WHERE direction = 'outbound' ORDER BY id ASC")
    .all()
    .map((row) => row.message_text);
}

export function createSilentLogger() {
  return { log() {}, error() {} };
}
