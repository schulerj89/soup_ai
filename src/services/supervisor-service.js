import crypto from 'node:crypto';
import { MessageProcessor } from './message-processor.js';

function extractText(message) {
  return message?.text ?? message?.caption ?? null;
}

function selectAudioAttachment(message) {
  if (message?.voice?.file_id) {
    return {
      kind: 'voice',
      fileId: message.voice.file_id,
      fileSize: message.voice.file_size ?? null,
      mimeType: message.voice.mime_type ?? 'audio/ogg',
      fileName: `voice-${message.message_id ?? 'message'}.ogg`,
    };
  }

  if (message?.audio?.file_id) {
    return {
      kind: 'audio',
      fileId: message.audio.file_id,
      fileSize: message.audio.file_size ?? null,
      mimeType: message.audio.mime_type ?? 'audio/mpeg',
      fileName: message.audio.file_name ?? `audio-${message.message_id ?? 'message'}.mp3`,
    };
  }

  if (message?.document?.file_id && `${message.document.mime_type ?? ''}`.startsWith('audio/')) {
    return {
      kind: 'document',
      fileId: message.document.file_id,
      fileSize: message.document.file_size ?? null,
      mimeType: message.document.mime_type,
      fileName: message.document.file_name ?? `audio-${message.message_id ?? 'message'}`,
    };
  }

  return null;
}

function combineTextAndTranscript(text, transcript) {
  const normalizedText = `${text ?? ''}`.trim();
  const normalizedTranscript = `${transcript ?? ''}`.trim();

  if (!normalizedTranscript) {
    return normalizedText || null;
  }

  if (!normalizedText) {
    return normalizedTranscript;
  }

  return `${normalizedText}\n\nAudio transcript:\n${normalizedTranscript}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SupervisorService {
  constructor({
    db,
    telegramClient,
    agent,
    executionPlanner,
    codexRunner,
    config,
    memorySummarizer = null,
    audioTranscriber = null,
    logger = console,
    timers = { setInterval, clearInterval, sleep },
  }) {
    this.db = db;
    this.telegramClient = telegramClient;
    this.config = config;
    this.audioTranscriber = audioTranscriber;
    this.logger = logger;
    this.timers = timers;
    this.immediateSentMessages = 0;
    this.messageProcessor = new MessageProcessor({
      db,
      agent,
      executionPlanner,
      codexRunner,
      config,
      memorySummarizer,
      onAcknowledgementQueued: async () => {
        this.immediateSentMessages += await this.flushOutbound(1);
      },
    });
  }

  isAllowedChat(chatId) {
    return this.config.telegramAllowedChatIds.includes(`${chatId}`);
  }

  async transcribeAudioMessage(message, attachment) {
    if (!this.audioTranscriber) {
      throw new Error('Audio transcription is not configured.');
    }

    if (
      attachment.fileSize != null &&
      attachment.fileSize > this.config.telegramAudioMaxFileBytes
    ) {
      throw new Error(
        `Audio file is too large to transcribe (${attachment.fileSize} bytes > ${this.config.telegramAudioMaxFileBytes} bytes).`,
      );
    }

    const file = await this.telegramClient.getFile(attachment.fileId);

    if (!file?.file_path) {
      throw new Error('Telegram did not return a file path for the audio attachment.');
    }

    const audioBuffer = await this.telegramClient.downloadFile(file.file_path);
    const transcription = await this.audioTranscriber.transcribe({
      audioBuffer,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
    });

    return {
      text: transcription.text,
      model: transcription.model,
      telegramFilePath: file.file_path,
    };
  }

  async ingestUpdates(updates) {
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
      const attachment = selectAudioAttachment(message);
      const allowed = this.isAllowedChat(chatId);
      let resolvedText = text;
      let metadata = {};
      let status = !allowed ? 'ignored_unauthorized' : text ? 'received' : 'ignored_unsupported';

      if (allowed && attachment) {
        try {
          const transcription = await this.transcribeAudioMessage(message, attachment);
          resolvedText = combineTextAndTranscript(text, transcription.text);
          metadata = {
            audio: {
              kind: attachment.kind,
              mime_type: attachment.mimeType,
              file_name: attachment.fileName,
              file_size: attachment.fileSize,
              telegram_file_path: transcription.telegramFilePath,
              transcription_model: transcription.model,
            },
          };
          status = resolvedText ? 'received' : 'ignored_unsupported';
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : `${error}`;
          metadata = {
            audio: {
              kind: attachment.kind,
              mime_type: attachment.mimeType,
              file_name: attachment.fileName,
              file_size: attachment.fileSize,
              transcription_error: errorMessage,
            },
          };
          status = text ? 'received' : 'ignored_unsupported';
          this.logger.error(`Failed to transcribe Telegram audio message ${message.message_id ?? updateId}: ${errorMessage}`);
        }
      }

      const row = this.db.insertInboundMessage({
        updateId,
        telegramMessageId: message.message_id,
        chatId,
        replyToMessageId: message.reply_to_message?.message_id ?? null,
        text: resolvedText,
        status,
        metadata,
        raw: update,
      });

      if (!row) {
        continue;
      }

      inserted += 1;

      if (allowed && resolvedText) {
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

  computeLeaseTtlMs() {
    return this.config.supervisorLeaseTtlMs ?? this.config.codexTimeoutMs + 60000;
  }

  computeLeaseHeartbeatMs(leaseTtlMs) {
    if (this.config.supervisorLeaseHeartbeatMs) {
      return this.config.supervisorLeaseHeartbeatMs;
    }

    return Math.max(1000, Math.floor(leaseTtlMs / 3));
  }

  async runOnce() {
    const owner = crypto.randomUUID();
    const leaseTtlMs = this.computeLeaseTtlMs();
    const leaseHeartbeatMs = this.computeLeaseHeartbeatMs(leaseTtlMs);
    const acquired = this.db.acquireLease('supervisor_once', owner, leaseTtlMs);

    if (!acquired) {
      this.logger.log('Another Soup AI run is still active. Skipping this tick.');
      return { skipped: true };
    }

    const heartbeat = this.timers.setInterval(() => {
      const renewed = this.db.renewLease('supervisor_once', owner, leaseTtlMs);

      if (!renewed) {
        this.logger.error('Failed to renew supervisor lease; another run may take over after expiry.');
      }
    }, leaseHeartbeatMs);

    try {
      this.immediateSentMessages = 0;
      const offset = this.db.getCursor('telegram_updates_offset', 0);
      const updates = await this.telegramClient.getUpdates({
        offset,
        limit: this.config.telegramPollLimit,
        timeoutSeconds: this.config.telegramPollTimeoutSeconds,
      });

      const ingested = await this.ingestUpdates(updates);
      const processedJobs = await this.processPendingJobs(this.config.maxJobsPerRun);
      const sentMessages = this.immediateSentMessages + (await this.flushOutbound(20));

      return {
        skipped: false,
        updatesReceived: updates.length,
        insertedMessages: ingested.inserted,
        processedJobs,
        sentMessages,
      };
    } finally {
      this.immediateSentMessages = 0;
      this.timers.clearInterval(heartbeat);
      this.db.releaseLease('supervisor_once', owner);
    }
  }
}
