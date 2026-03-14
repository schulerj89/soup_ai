import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramUpdateIngester } from '../src/services/supervisor-service/telegram-update-ingester.js';
import { createSilentLogger, createTestConfig, createTestDb } from '../support/unit-helpers.js';

test('TelegramUpdateIngester stores authorized text updates and queues jobs', async () => {
  const db = createTestDb();

  try {
    const ingester = new TelegramUpdateIngester({
      db,
      telegramClient: {},
      audioTranscriber: null,
      config: createTestConfig(),
      logger: createSilentLogger(),
    });

    const summary = await ingester.ingest([
      {
        update_id: 21,
        message: {
          message_id: 31,
          chat: { id: 999111, type: 'private' },
          text: 'Summarize the repo',
        },
      },
    ]);

    const inbound = db.getMessageById(1);
    const jobs = db.listPendingJobs(10);

    assert.deepEqual(summary, { inserted: 1, nextOffset: 22 });
    assert.equal(inbound.status, 'received');
    assert.equal(inbound.message_text, 'Summarize the repo');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].message_id, inbound.id);
    assert.equal(db.getCursor('telegram_updates_offset', 0), 22);
  } finally {
    db.close();
  }
});

test('TelegramUpdateIngester combines caption text with a transcribed audio attachment', async () => {
  const db = createTestDb();

  try {
    const ingester = new TelegramUpdateIngester({
      db,
      telegramClient: {
        getFile: async (fileId) => {
          assert.equal(fileId, 'audio-1');
          return { file_path: 'audio/file-1.mp3' };
        },
        downloadFile: async (filePath) => {
          assert.equal(filePath, 'audio/file-1.mp3');
          return Buffer.from('audio-bytes');
        },
      },
      audioTranscriber: {
        transcribe: async ({ audioBuffer, fileName, mimeType }) => {
          assert.equal(audioBuffer.toString(), 'audio-bytes');
          assert.equal(fileName, 'note.mp3');
          assert.equal(mimeType, 'audio/mpeg');
          return {
            text: 'Transcribed action items',
            model: 'gpt-4o-mini-transcribe',
          };
        },
      },
      config: createTestConfig(),
      logger: createSilentLogger(),
    });

    await ingester.ingest([
      {
        update_id: 22,
        message: {
          message_id: 32,
          chat: { id: 999111, type: 'private' },
          caption: 'Please capture this note',
          audio: {
            file_id: 'audio-1',
            file_name: 'note.mp3',
            file_size: 1024,
            mime_type: 'audio/mpeg',
          },
        },
      },
    ]);

    const inbound = db.getMessageById(1);
    const metadata = JSON.parse(inbound.metadata_json);

    assert.equal(
      inbound.message_text,
      'Please capture this note\n\nAudio transcript:\nTranscribed action items',
    );
    assert.equal(inbound.status, 'received');
    assert.deepEqual(metadata.audio, {
      kind: 'audio',
      mime_type: 'audio/mpeg',
      file_name: 'note.mp3',
      file_size: 1024,
      telegram_file_path: 'audio/file-1.mp3',
      transcription_model: 'gpt-4o-mini-transcribe',
    });
    assert.equal(db.listPendingJobs(10).length, 1);
  } finally {
    db.close();
  }
});

test('TelegramUpdateIngester records unauthorized chats without queuing work', async () => {
  const db = createTestDb();

  try {
    const ingester = new TelegramUpdateIngester({
      db,
      telegramClient: {},
      audioTranscriber: null,
      config: createTestConfig(),
      logger: createSilentLogger(),
    });

    await ingester.ingest([
      {
        update_id: 23,
        message: {
          message_id: 33,
          chat: { id: 555000, type: 'private' },
          text: 'Ignored request',
        },
      },
    ]);

    const inbound = db.getMessageById(1);

    assert.equal(inbound.status, 'ignored_unauthorized');
    assert.equal(db.listPendingJobs(10).length, 0);
  } finally {
    db.close();
  }
});

test('TelegramUpdateIngester preserves text when audio transcription fails', async () => {
  const db = createTestDb();
  const errors = [];

  try {
    const ingester = new TelegramUpdateIngester({
      db,
      telegramClient: {
        getFile: async () => {
          throw new Error('network unavailable');
        },
      },
      audioTranscriber: {
        transcribe: async () => {
          throw new Error('should not reach transcriber');
        },
      },
      config: createTestConfig(),
      logger: {
        log() {},
        error(message) {
          errors.push(message);
        },
      },
    });

    await ingester.ingest([
      {
        update_id: 24,
        message: {
          message_id: 34,
          chat: { id: 999111, type: 'private' },
          caption: 'Fallback to caption',
          audio: {
            file_id: 'audio-2',
            file_name: 'note.mp3',
            file_size: 1024,
            mime_type: 'audio/mpeg',
          },
        },
      },
    ]);

    const inbound = db.getMessageById(1);
    const metadata = JSON.parse(inbound.metadata_json);

    assert.equal(inbound.status, 'received');
    assert.equal(inbound.message_text, 'Fallback to caption');
    assert.equal(metadata.audio.transcription_error, 'network unavailable');
    assert.match(errors[0], /Failed to transcribe Telegram audio message 34/);
    assert.equal(db.listPendingJobs(10).length, 1);
  } finally {
    db.close();
  }
});
