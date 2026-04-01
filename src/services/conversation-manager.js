import { OpenAIConversationsSession } from '@openai/agents';

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeControlState(chatId, stored = null) {
  const state = stored && typeof stored === 'object' ? stored : {};

  return {
    chatId: `${chatId}`,
    activeConversationId: typeof state.activeConversationId === 'string' ? state.activeConversationId : null,
    conversationGeneration: Number.isInteger(state.conversationGeneration) ? state.conversationGeneration : 0,
    memorySummary: typeof state.memorySummary === 'string' ? state.memorySummary : null,
    durableFacts: normalizeObject(state.durableFacts),
    currentStartedAt: typeof state.currentStartedAt === 'string' ? state.currentStartedAt : null,
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

function renderProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    return null;
  }

  const sections = [];

  const renderMap = (label, value) => {
    const entries = Object.entries(value ?? {}).filter(([, entry]) => entry?.value != null && `${entry.value}`.trim());

    if (entries.length === 0) {
      return null;
    }

    return `${label}:\n${entries.map(([key, entry]) => `- ${key}: ${entry.value}`).join('\n')}`;
  };

  const renderList = (label, value) => {
    const entries = Array.isArray(value)
      ? value.map((entry) => `${entry?.value ?? ''}`.trim()).filter(Boolean)
      : [];

    if (entries.length === 0) {
      return null;
    }

    return `${label}:\n${entries.map((entry) => `- ${entry}`).join('\n')}`;
  };

  sections.push(renderMap('Preferences', profile.preferences));
  sections.push(renderList('Routines', profile.routines));
  sections.push(renderList('Projects', profile.projects));
  sections.push(renderMap('People', profile.people));
  sections.push(renderMap('Personal details', profile.personal_details));
  sections.push(renderList('Important dates', profile.important_dates));
  sections.push(renderList('Saved patterns', profile.saved_patterns));

  return sections.filter(Boolean).join('\n\n') || null;
}

function renderRecentNotes(notes) {
  if (!Array.isArray(notes) || notes.length === 0) {
    return null;
  }

  return notes
    .map((note) => {
      const tags = Array.isArray(note.tags) && note.tags.length > 0 ? ` [tags: ${note.tags.join(', ')}]` : '';
      return `- ${note.title}${tags}: ${note.body}`;
    })
    .join('\n');
}

function buildSeedText({ memorySummary, durableFacts, durableProfile, recentNotes }) {
  const sections = [];

  if (`${memorySummary ?? ''}`.trim()) {
    sections.push(`Conversation summary:\n${memorySummary.trim()}`);
  }

  const durableFactsText = formatDurableFacts(durableFacts);

  if (durableFactsText) {
    sections.push(`Durable facts:\n${durableFactsText}`);
  }

  const profileText = renderProfile(durableProfile);

  if (profileText) {
    sections.push(`Durable profile:\n${profileText}`);
  }

  const notesText = renderRecentNotes(recentNotes);

  if (notesText) {
    sections.push(`Recent notes:\n${notesText}`);
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
    const durableProfile = this.db.getDurableProfile(chatId);
    const recentNotes = this.db.listRecentNotes(chatId, 5);
    return {
      ...control,
      durableProfile,
      recentNotes,
      archives: this.db.listConversationArchives(chatId, 5),
      seedText: buildSeedText({
        ...control,
        durableProfile,
        recentNotes,
      }),
    };
  }
}
