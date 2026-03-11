import { randomUUID } from 'node:crypto';
import { system } from '@openai/agents';

const SUMMARY_PREFIX = 'Conversation memory summary:\n';

export class SqliteSession {
  constructor({ db, chatId, maxItems = 200 }) {
    this.db = db;
    this.chatId = `${chatId}`;
    this.maxItems = maxItems;
  }

  readState() {
    const stored = this.db.getAgentSessionState(this.chatId);

    return {
      sessionId: stored?.sessionId ?? randomUUID(),
      summaryText: typeof stored?.summaryText === 'string' ? stored.summaryText : null,
      items: Array.isArray(stored?.items) ? stored.items : [],
    };
  }

  writeState(state) {
    const items = Array.isArray(state.items) ? state.items : [];
    const trimmedItems = items.length > this.maxItems ? items.slice(items.length - this.maxItems) : items;

    this.db.setAgentSessionState(this.chatId, {
      sessionId: state.sessionId,
      summaryText: typeof state.summaryText === 'string' ? state.summaryText : null,
      items: trimmedItems,
    });
  }

  buildSessionItems(state) {
    const items = state.items.map((item) => structuredClone(item));

    if (!state.summaryText) {
      return items;
    }

    return [system(`${SUMMARY_PREFIX}${state.summaryText}`), ...items];
  }

  async getSessionId() {
    const state = this.readState();
    this.writeState(state);
    return state.sessionId;
  }

  async getItems(limit) {
    const items = this.buildSessionItems(this.readState());

    if (limit == null) {
      return items;
    }

    if (limit <= 0) {
      return [];
    }

    return items.slice(Math.max(items.length - limit, 0));
  }

  async addItems(items) {
    if (!items.length) {
      return;
    }

    const state = this.readState();
    this.writeState({
      sessionId: state.sessionId,
      summaryText: state.summaryText,
      items: [...state.items, ...structuredClone(items)],
    });
  }

  async popItem() {
    const state = this.readState();

    if (!state.items.length) {
      return undefined;
    }

    const item = state.items[state.items.length - 1];
    this.writeState({
      sessionId: state.sessionId,
      summaryText: state.summaryText,
      items: state.items.slice(0, -1),
    });
    return structuredClone(item);
  }

  async getSnapshot() {
    return structuredClone(this.readState());
  }

  async compact({ summaryText, items }) {
    const state = this.readState();
    this.writeState({
      sessionId: state.sessionId,
      summaryText: summaryText?.trim() || null,
      items: structuredClone(items ?? []),
    });
  }

  async clearSession() {
    this.db.clearAgentSessionState(this.chatId);
  }
}
