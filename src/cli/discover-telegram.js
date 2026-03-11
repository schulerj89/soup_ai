import { loadConfig } from '../config/load-config.js';
import { TelegramClient } from '../telegram/telegram-client.js';

function formatChat(chat) {
  const pieces = [`chat_id=${chat.id}`];

  if (chat.username) {
    pieces.push(`username=@${chat.username}`);
  }

  if (chat.first_name || chat.last_name) {
    pieces.push(`name=${[chat.first_name, chat.last_name].filter(Boolean).join(' ')}`);
  }

  return pieces.join(' ');
}

async function main() {
  const config = loadConfig({
    requireOpenAI: false,
    requireTelegram: true,
    requireAllowedChats: false,
  });

  const client = new TelegramClient({
    token: config.telegramBotToken,
    apiBaseUrl: config.telegramApiBaseUrl,
  });

  const updates = await client.getUpdates({
    offset: 0,
    limit: config.telegramPollLimit,
    timeoutSeconds: 0,
  });

  const chats = new Map();

  for (const update of updates) {
    const chat = update.message?.chat;

    if (chat?.id != null) {
      chats.set(`${chat.id}`, chat);
    }
  }

  if (chats.size === 0) {
    console.log('No chats discovered yet. Send your bot a message, then rerun this command.');
    return;
  }

  console.log('Discovered Telegram chats:');

  for (const chat of chats.values()) {
    console.log(`- ${formatChat(chat)}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
