import crypto from 'node:crypto';
import { MessageProcessor } from './message-processor.js';

function extractText(message) {
  return message?.text ?? message?.caption ?? null;
}

export class SupervisorService {
  constructor({ db, telegramClient, agent, codexRunner, config, memorySummarizer = null, logger = console }) {
    this.db = db;
    this.telegramClient = telegramClient;
    this.config = config;
    this.logger = logger;
    this.messageProcessor = new MessageProcessor({
      db,
      agent,
      codexRunner,
      config,
      memorySummarizer,
    });
  }

  isAllowedChat(chatId) {
    return this.config.telegramAllowedChatIds.includes(`${chatId}`);
  }

  ingestUpdates(updates) {
    let maxOffset = this.db.getCursor('telegram_updates_offset', 0);
    let inserted = 0;

    for (const update of updates) {
      const updateId = update.update_id;
      const message = update.message;

      if (typeof updateId === 'number') {
        maxOffset = Math.max(maxOffset, updateId + 1);
      }

      if (!message) {
        continue;
      }

      const chatId = `${message.chat?.id ?? ''}`;
      const text = extractText(message);
      const allowed = this.isAllowedChat(chatId);
      const status = !allowed ? 'ignored_unauthorized' : text ? 'received' : 'ignored_unsupported';

      const row = this.db.insertInboundMessage({
        updateId,
        telegramMessageId: message.message_id,
        chatId,
        replyToMessageId: message.reply_to_message?.message_id ?? null,
        text,
        status,
        raw: update,
      });

      if (!row) {
        continue;
      }

      inserted += 1;

      if (allowed && text) {
        this.db.queueJob({
          jobType: 'process_inbound_message',
          messageId: row.id,
          payload: { chatId, telegramMessageId: message.message_id },
        });
      }
    }

    this.db.setCursor('telegram_updates_offset', maxOffset);
    return { inserted, nextOffset: maxOffset };
  }

  async processPendingJobs(limit) {
    const jobs = this.db.listPendingJobs(limit);
    let processed = 0;

    for (const job of jobs) {
      this.db.markJobRunning(job.id);

      try {
        await this.messageProcessor.processJob(job);
        this.db.markJobCompleted(job.id);
        processed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : `${error}`;
        this.db.markJobFailed(job.id, message);
        this.logger.error(`Job ${job.id} failed: ${message}`);
      }
    }

    return processed;
  }

  async flushOutbound(limit = 10) {
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

  async runOnce() {
    const owner = crypto.randomUUID();
    const acquired = this.db.acquireLease('supervisor_once', owner, this.config.codexTimeoutMs + 60000);

    if (!acquired) {
      this.logger.log('Another Soup AI run is still active. Skipping this tick.');
      return { skipped: true };
    }

    try {
      const offset = this.db.getCursor('telegram_updates_offset', 0);
      const updates = await this.telegramClient.getUpdates({
        offset,
        limit: this.config.telegramPollLimit,
        timeoutSeconds: this.config.telegramPollTimeoutSeconds,
      });

      const ingested = this.ingestUpdates(updates);
      const processedJobs = await this.processPendingJobs(this.config.maxJobsPerRun);
      const sentMessages = await this.flushOutbound(20);

      return {
        skipped: false,
        updatesReceived: updates.length,
        insertedMessages: ingested.inserted,
        processedJobs,
        sentMessages,
      };
    } finally {
      this.db.releaseLease('supervisor_once', owner);
    }
  }
}
