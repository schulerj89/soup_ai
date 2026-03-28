import { toJson } from '../../utils/json.js';

export const messageStoreMethods = {
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
  },

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
  },

  listPendingOutbound(limit = 10) {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE direction = 'outbound' AND status = 'pending_send'
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit);
  },

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
  },

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
  },

  getMessageById(id) {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  },

  markMessageProcessed(id) {
    this.db
      .prepare(
        `UPDATE messages
         SET status = 'processed',
             processed_at = ?
         WHERE id = ?`,
      )
      .run(this.now(), id);
  },

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
  },
};
