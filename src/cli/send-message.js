import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load-config.js';
import { AppDb } from '../db/app-db.js';
import { TelegramClient } from '../telegram/telegram-client.js';
import { splitTelegramText } from '../utils/text.js';

async function main() {
  const { values } = parseArgs({
    options: {
      'chat-id': { type: 'string' },
      text: { type: 'string' },
      flush: { type: 'boolean', default: false },
    },
  });

  const config = loadConfig({ requireAllowedChats: false });
  const chatId = values['chat-id'] ?? config.telegramAllowedChatIds[0];
  const text = values.text?.trim();

  if (!chatId) {
    throw new Error('Provide --chat-id or set TELEGRAM_ALLOWED_CHAT_IDS in .env');
  }

  if (!text) {
    throw new Error('Provide --text "your message"');
  }

  const db = new AppDb({ dbPath: config.dbPath });

  try {
    const queued = splitTelegramText(text).map((part) =>
      db.queueOutboundMessage({
        chatId,
        text: part,
      }),
    );

    console.log(`Queued ${queued.length} outbound message(s) for chat ${chatId}.`);

    if (values.flush) {
      const client = new TelegramClient({
        token: config.telegramBotToken,
        apiBaseUrl: config.telegramApiBaseUrl,
      });

      for (const row of queued) {
        const result = await client.sendMessage({
          chatId: row.chat_id,
          text: row.message_text,
        });

        db.markOutboundSent(row.id, result.message_id, result);
      }

      console.log('Flushed queued messages immediately.');
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
