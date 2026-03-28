import { OpenAIConversationsSession } from '@openai/agents';

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeControlState(chatId, stored = null) {
  const state = stored && typeof stored === 'object' ? stored : {};
  const now = new Date().toISOString();

  return {
    chatId: `${chatId}`,
    activeConversationId: typeof state.activeConversationId === 'string' ? state.activeConversationId : null,
    conversationGeneration: Number.isInteger(state.conversationGeneration) ? state.conversationGeneration : 0,
    memorySummary: typeof state.memorySummary === 'string' ? state.memorySummary : null,
    durableFacts: normalizeObject(state.durableFacts),
    currentStartedAt: typeof state.currentStartedAt === 'string' ? state.currentStartedAt : now,
    lastUsedAt: typeof state.lastUsedAt === 'string' ? state.lastUsedAt : null,
    lastResetAt: typeof state.lastResetAt === 'string' ? state.lastResetAt : null,
    lastResetReason: typeof state.lastResetReason === 'string' ? state.lastResetReason : null,
  };
}

function formatDurableFacts(durableFacts) {
  const facts = Object.entries(normalizeObject(durableFacts)).filter(([, value]) => {
    if (Array.isArray(value)) {
      return value.length > 0;
    }

    if (value && typeof value === 'object') {
      return Object.keys(value).length > 0;
    }

    return `${value ?? ''}`.trim().length > 0;
  });

  if (facts.length === 0) {
    return null;
  }

  return facts
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return `${key}: ${value.join(', ')}`;
      }

      if (value && typeof value === 'object') {
        return `${key}: ${JSON.stringify(value)}`;
      }

      return `${key}: ${value}`;
    })
    .join('\n');
}

function buildSeedText({ memorySummary, durableFacts }) {
  const sections = [];

  if (`${memorySummary ?? ''}`.trim()) {
    sections.push(`Conversation summary:\n${memorySummary.trim()}`);
  }

  const durableFactsText = formatDurableFacts(durableFacts);

  if (durableFactsText) {
    sections.push(`Durable facts:\n${durableFactsText}`);
  }

  if (sections.length === 0) {
    return null;
  }

  return sections.join('\n\n');
}

export class ConversationManager {
  constructor({
    db,
    sessionFactory = (options) => new OpenAIConversationsSession(options),
  }) {
    this.db = db;
    this.sessionFactory = sessionFactory;
  }

  readControl(chatId) {
    return normalizeControlState(chatId, this.db.getConversationControlState(chatId));
  }

  writeControl(chatId, nextState) {
    const normalized = normalizeControlState(chatId, nextState);
    this.db.setConversationControlState(chatId, normalized);
    return normalized;
  }

  touch(chatId) {
    const control = this.readControl(chatId);
    control.lastUsedAt = new Date().toISOString();
    return this.writeControl(chatId, control);
  }

  async createConversation(chatId, control = this.readControl(chatId)) {
    const session = this.sessionFactory({});
    const conversationId = await session.getSessionId();
    const nextControl = {
      ...control,
      activeConversationId: conversationId,
      currentStartedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };

    return {
      session,
      control: this.writeControl(chatId, nextControl),
    };
  }

  async getSession(chatId) {
    const control = this.readControl(chatId);

    if (!control.activeConversationId) {
      return this.createConversation(chatId, control);
    }

    const session = this.sessionFactory({
      conversationId: control.activeConversationId,
    });

    return {
      session,
      control: this.touch(chatId),
    };
  }

  async archiveAndReset(chatId, { reason = 'Manual reset requested.', preserveMemory = true } = {}) {
    const control = this.readControl(chatId);

    this.db.archiveConversation({
      chatId,
      conversationId: control.activeConversationId,
      generation: control.conversationGeneration,
      reason,
      memorySummary: control.memorySummary,
      durableFacts: control.durableFacts,
      createdAt: control.currentStartedAt,
    });

    const nextControl = {
      ...control,
      activeConversationId: null,
      conversationGeneration: control.conversationGeneration + 1,
      currentStartedAt: new Date().toISOString(),
      lastUsedAt: null,
      lastResetAt: new Date().toISOString(),
      lastResetReason: reason,
      memorySummary: null,
      durableFacts: preserveMemory ? control.durableFacts : {},
    };

    return this.createConversation(chatId, nextControl);
  }

  updateMemory(chatId, { memorySummary = undefined, durableFacts = undefined } = {}) {
    const control = this.readControl(chatId);

    if (memorySummary !== undefined) {
      control.memorySummary = `${memorySummary ?? ''}`.trim() || null;
    }

    if (durableFacts !== undefined) {
      control.durableFacts = normalizeObject(durableFacts);
    }

    return this.writeControl(chatId, control);
  }

  getState(chatId) {
    const control = this.readControl(chatId);
    return {
      ...control,
      archives: this.db.listConversationArchives(chatId, 5),
      seedText: buildSeedText(control),
    };
  }
}
