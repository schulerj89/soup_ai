import { formatTaskList } from './helpers.js';

export class MessageCommandHandler {
  constructor({ db, replyQueue }) {
    this.db = db;
    this.replyQueue = replyQueue;
  }

  async tryHandle(message, commandText) {
    switch (commandText) {
      case '/help':
        this.replyQueue.queue({
          chatId: message.chat_id,
          replyToMessageId: message.telegram_message_id,
          text: ['Commands:', '/help', '/health', '/tasks', '', 'Any other message is handled by the AI supervisor.'].join('\n'),
        });
        this.db.markMessageProcessed(message.id);
        return true;
      case '/health':
      case '/status': {
        const snapshot = this.db.getQueueSnapshot();
        this.replyQueue.queue({
          chatId: message.chat_id,
          replyToMessageId: message.telegram_message_id,
          text: [
            'Soup AI health',
            `pendingJobs: ${snapshot.pendingJobs}`,
            `runningJobs: ${snapshot.runningJobs}`,
            `pendingOutbound: ${snapshot.pendingOutbound}`,
            `runningTasks: ${snapshot.runningTasks}`,
          ].join('\n'),
        });
        this.db.markMessageProcessed(message.id);
        return true;
      }
      case '/tasks': {
        const tasks = this.db.listRecentTasks(5);
        this.replyQueue.queue({
          chatId: message.chat_id,
          replyToMessageId: message.telegram_message_id,
          text: formatTaskList(tasks),
        });
        this.db.markMessageProcessed(message.id);
        return true;
      }
      default:
        return false;
    }
  }
}
