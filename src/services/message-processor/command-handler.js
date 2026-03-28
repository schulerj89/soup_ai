import { formatTaskList } from './helpers.js';

export class MessageCommandHandler {
  constructor({ db, replyQueue, conversationManager = null }) {
    this.db = db;
    this.replyQueue = replyQueue;
    this.conversationManager = conversationManager;
  }

  async tryHandle(message, commandText) {
    switch (commandText) {
      case '/help':
        this.replyQueue.queue({
          chatId: message.chat_id,
          replyToMessageId: message.telegram_message_id,
          text: [
            'Commands:',
            '/help',
            '/health',
            '/status',
            '/tasks',
            '/memory',
            '/reset',
            '',
            'Any other message is handled by the AI supervisor.',
          ].join('\n'),
        });
        this.db.markMessageProcessed(message.id);
        return true;
      case '/health':
      case '/status': {
        const snapshot = this.db.getQueueSnapshot();
        const conversationState = this.conversationManager?.getState(message.chat_id) ?? null;
        const statusLines = [
          'Soup AI health',
          `pendingJobs: ${snapshot.pendingJobs}`,
          `runningJobs: ${snapshot.runningJobs}`,
          `pendingOutbound: ${snapshot.pendingOutbound}`,
          `runningTasks: ${snapshot.runningTasks}`,
        ];

        if (conversationState) {
          statusLines.push(`conversationGeneration: ${conversationState.conversationGeneration}`);
          statusLines.push(`activeConversationId: ${conversationState.activeConversationId ?? '(none)'}`);
          statusLines.push(`lastResetAt: ${conversationState.lastResetAt ?? '(never)'}`);
          statusLines.push(`lastResetReason: ${conversationState.lastResetReason ?? '(none)'}`);
        }

        this.replyQueue.queue({
          chatId: message.chat_id,
          replyToMessageId: message.telegram_message_id,
          text: statusLines.join('\n'),
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
      case '/memory': {
        const conversationState = this.conversationManager?.getState(message.chat_id);
        const summary = `${conversationState?.memorySummary ?? ''}`.trim();
        const durableFacts = conversationState?.durableFacts ?? {};
        const durableFactsText =
          Object.keys(durableFacts).length > 0 ? JSON.stringify(durableFacts, null, 2) : '(none)';

        this.replyQueue.queue({
          chatId: message.chat_id,
          replyToMessageId: message.telegram_message_id,
          text: [
            'Conversation memory',
            `summary: ${summary || '(none)'}`,
            'durableFacts:',
            durableFactsText,
          ].join('\n'),
        });
        this.db.markMessageProcessed(message.id);
        return true;
      }
      case '/reset': {
        if (!this.conversationManager) {
          return false;
        }

        const { control } = await this.conversationManager.archiveAndReset(message.chat_id, {
          reason: 'User requested a fresh conversation via /reset.',
          preserveMemory: true,
        });

        this.replyQueue.queue({
          chatId: message.chat_id,
          replyToMessageId: message.telegram_message_id,
          text: [
            'Started a fresh AI conversation.',
            `conversationGeneration: ${control.conversationGeneration}`,
            `activeConversationId: ${control.activeConversationId}`,
            'Curated memory was preserved for reseeding.',
          ].join('\n'),
        });
        this.db.markMessageProcessed(message.id);
        return true;
      }
      default:
        return false;
    }
  }
}
