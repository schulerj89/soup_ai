export class OutboundMessageDispatcher {
  constructor({ db, telegramClient, logger }) {
    this.db = db;
    this.telegramClient = telegramClient;
    this.logger = logger;
  }

  async flush(limit = 10) {
    const outboundMessages = this.db.listPendingOutbound(limit);
    let sent = 0;

    for (const row of outboundMessages) {
      try {
        const result = await this.telegramClient.sendMessage({
          chatId: row.chat_id,
          text: row.message_text,
          replyToMessageId: row.reply_to_message_id,
        });

        this.db.markOutboundSent(row.id, result.message_id, result);
        sent += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : `${error}`;
        this.db.markOutboundFailed(row.id, message);
        this.logger.error(`Outbound message ${row.id} failed: ${message}`);
      }
    }

    return sent;
  }
}
