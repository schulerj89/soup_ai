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

export class TelegramUpdateIngester {
  constructor({ db, telegramClient, audioTranscriber, config, logger }) {
    this.db = db;
    this.telegramClient = telegramClient;
    this.audioTranscriber = audioTranscriber;
    this.config = config;
    this.logger = logger;
  }

  isAllowedChat(chatId) {
    return this.config.telegramAllowedChatIds.includes(`${chatId}`);
  }

  async ingest(updates) {
    let maxOffset = this.db.getCursor('telegram_updates_offset', 0);
    let inserted = 0;

    for (const update of updates) {
      const outcome = await this.ingestUpdate(update);
      maxOffset = Math.max(maxOffset, outcome.nextOffset);
      inserted += outcome.inserted;
    }

    this.db.setCursor('telegram_updates_offset', maxOffset);
    return { inserted, nextOffset: maxOffset };
  }

  async ingestUpdate(update) {
    const updateId = update.update_id;
    const nextOffset = typeof updateId === 'number' ? updateId + 1 : this.db.getCursor('telegram_updates_offset', 0);
    const message = update.message;

    if (!message) {
      return { inserted: 0, nextOffset };
    }

    const chatId = `${message.chat?.id ?? ''}`;
    const text = extractText(message);
    const attachment = selectAudioAttachment(message);
    const allowed = this.isAllowedChat(chatId);
    const payload = await this.resolveInboundPayload({
      allowed,
      message,
      updateId,
      text,
      attachment,
    });

    const row = this.db.insertInboundMessage({
      updateId,
      telegramMessageId: message.message_id,
      chatId,
      replyToMessageId: message.reply_to_message?.message_id ?? null,
      text: payload.text,
      status: payload.status,
      metadata: payload.metadata,
      raw: update,
    });

    if (!row) {
      return { inserted: 0, nextOffset };
    }

    if (allowed && payload.text) {
      this.db.queueJob({
        jobType: 'process_inbound_message',
        messageId: row.id,
        payload: { chatId, telegramMessageId: message.message_id },
      });
    }

    return { inserted: 1, nextOffset };
  }

  async resolveInboundPayload({ allowed, message, updateId, text, attachment }) {
    let resolvedText = text;
    let metadata = {};
    let status = !allowed ? 'ignored_unauthorized' : text ? 'received' : 'ignored_unsupported';

    if (allowed && attachment) {
      try {
        const transcription = await this.transcribeAudioMessage(attachment);
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

    return { text: resolvedText, metadata, status };
  }

  async transcribeAudioMessage(attachment) {
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
}
