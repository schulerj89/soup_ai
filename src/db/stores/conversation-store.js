import { toJson } from '../../utils/json.js';

export const conversationStoreMethods = {
  archiveConversation({
    chatId,
    conversationId = null,
    generation = 0,
    reason = null,
    memorySummary = null,
    durableFacts = {},
    createdAt = null,
  }) {
    const archivedAt = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO conversation_archives (
           chat_id,
           conversation_id,
           generation,
           reason,
           memory_summary,
           durable_facts_json,
           created_at,
           archived_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${chatId}`,
        conversationId,
        generation,
        reason,
        memorySummary,
        toJson(durableFacts ?? {}),
        createdAt ?? archivedAt,
        archivedAt,
      );

    return this.db.prepare('SELECT * FROM conversation_archives WHERE id = ?').get(result.lastInsertRowid);
  },

  listConversationArchives(chatId, limit = 10) {
    return this.db
      .prepare(
        `SELECT * FROM conversation_archives
         WHERE chat_id = ?
         ORDER BY archived_at DESC
         LIMIT ?`,
      )
      .all(`${chatId}`, limit);
  },
};
