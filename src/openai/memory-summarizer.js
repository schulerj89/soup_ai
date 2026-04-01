import { Agent, run } from '@openai/agents';
import { safeJsonParse } from '../utils/json.js';

function extractTextParts(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }

      if (part.type === 'input_text' || part.type === 'output_text') {
        return part.text ?? '';
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function renderItems(items) {
  return items
    .map((item) => {
      const role = item?.role ?? item?.type ?? 'unknown';
      const text = extractTextParts(item?.content).trim();
      return text ? `${role}: ${text}` : `${role}: [non-text item omitted]`;
    })
    .join('\n');
}

function normalizeStringList(value) {
  return Array.isArray(value) ? value.map((item) => `${item ?? ''}`.trim()).filter(Boolean) : [];
}

function normalizeStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => [key.trim(), `${entry ?? ''}`.trim()])
      .filter(([key, entry]) => key && entry),
  );
}

function normalizeCandidateNotes(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((note) => {
      if (!note || typeof note !== 'object') {
        return null;
      }

      const title = `${note.title ?? ''}`.trim();
      const body = `${note.body ?? ''}`.trim();
      const tags = normalizeStringList(note.tags).slice(0, 8);

      if (!title || !body) {
        return null;
      }

      return { title, body, tags };
    })
    .filter(Boolean);
}

function normalizeExtraction(value) {
  const parsed = value && typeof value === 'object' ? value : {};
  const profilePatch = parsed.profile_patch && typeof parsed.profile_patch === 'object' ? parsed.profile_patch : {};

  return {
    profilePatch: {
      preferences: normalizeStringMap(profilePatch.preferences),
      routines: normalizeStringList(profilePatch.routines),
      projects: normalizeStringList(profilePatch.projects),
      people: normalizeStringMap(profilePatch.people),
      personal_details: normalizeStringMap(profilePatch.personal_details),
      important_dates: normalizeStringList(profilePatch.important_dates),
      saved_patterns: normalizeStringList(profilePatch.saved_patterns),
    },
    notes: normalizeCandidateNotes(parsed.notes),
  };
}

export const MEMORY_SUMMARY_PROMPT = [
  'Summarize older chat context for future assistant turns.',
  'Preserve durable facts, user preferences, open tasks, constraints, decisions, and important tool outcomes.',
  'Be concise and factual. Use short plain text, not markdown headings.',
  'Do not invent facts. Do not include chit-chat unless it affects future work.',
].join('\n');

export const DURABLE_PROFILE_PROMPT = [
  'Extract durable user memory from the conversation.',
  'Return JSON only.',
  'Capture only stable or repeat-worthy information with clear evidence.',
  'Good examples: communication preferences, routines, recurring patterns, active long-term projects, important people, personal details that help future assistance, important dates, and reusable habits.',
  'Do not capture one-off transient requests, low-confidence guesses, or sensitive details unless the user stated them plainly and they are clearly useful for future assistance.',
  'Create note candidates only when the user explicitly asked to remember/save something or when the information is clearly worth long-term lookup later.',
  'Prefer profile_patch for stable patterns and preferences.',
  'Schema:',
  '{',
  '  "profile_patch": {',
  '    "preferences": {"key": "value"},',
  '    "routines": ["..."],',
  '    "projects": ["..."],',
  '    "people": {"name": "why this person matters"},',
  '    "personal_details": {"key": "value"},',
  '    "important_dates": ["..."],',
  '    "saved_patterns": ["..."]',
  '  },',
  '  "notes": [{"title": string, "body": string, "tags": string[]}]',
  '}',
].join('\n');

export class MemorySummarizer {
  constructor({
    model,
    threshold = 24,
    keepRecentItems = 12,
    runImpl = run,
    agentFactory = (options) => new Agent(options),
  }) {
    this.model = model;
    this.threshold = threshold;
    this.keepRecentItems = keepRecentItems;
    this.runImpl = runImpl;
    this.agentFactory = agentFactory;
  }

  shouldSummarize(snapshot) {
    return snapshot.items.length > this.threshold;
  }

  async summarizeChat({ chatId, db, conversationManager }) {
    const state = conversationManager.getState(chatId);
    const rows = db
      .listConversation(chatId, 200)
      .filter((row) => !state.currentStartedAt || row.created_at >= state.currentStartedAt)
      .slice(-(this.threshold + this.keepRecentItems + 8));
    const items = rows
      .map((row) => {
        const text = `${row.message_text ?? ''}`.trim();

        if (!text) {
          return null;
        }

        return {
          role: row.direction === 'outbound' ? 'assistant' : 'user',
          content: [
            {
              type: row.direction === 'outbound' ? 'output_text' : 'input_text',
              text,
            },
          ],
        };
      })
      .filter(Boolean);
    const snapshot = {
      summaryText: state.memorySummary,
      items,
    };

    if (!this.shouldSummarize(snapshot)) {
      return { summarized: false };
    }

    const splitIndex = Math.max(snapshot.items.length - this.keepRecentItems, 1);
    const olderItems = snapshot.items.slice(0, splitIndex);
    const recentItems = snapshot.items.slice(splitIndex);

    const summarizer = this.agentFactory({
      name: 'Soup Memory Summarizer',
      model: this.model,
      instructions: MEMORY_SUMMARY_PROMPT,
    });

    const extractor = this.agentFactory({
      name: 'Soup Durable Profile Extractor',
      model: this.model,
      instructions: DURABLE_PROFILE_PROMPT,
    });

    const summaryInput = [
      snapshot.summaryText ? `Existing summary:\n${snapshot.summaryText}` : 'Existing summary:\n(none)',
      'Older conversation items to compress:',
      renderItems(olderItems),
    ].join('\n\n');

    const summaryResult = await this.runImpl(summarizer, summaryInput, {
      maxTurns: 1,
    });

    const summaryText = `${summaryResult.finalOutput ?? ''}`.trim();
    const profileState = db.getDurableProfile(chatId);
    const extractionInput = [
      `Existing durable profile:\n${JSON.stringify(profileState, null, 2)}`,
      `Existing recent notes:\n${JSON.stringify(db.listRecentNotes(chatId, 10), null, 2)}`,
      'Conversation items to inspect:',
      renderItems(olderItems),
    ].join('\n\n');
    const extractionResult = await this.runImpl(extractor, extractionInput, {
      maxTurns: 1,
    });
    const extraction = normalizeExtraction(
      safeJsonParse(`${extractionResult.finalOutput ?? ''}`.trim(), {}),
    );

    const durableFacts = {
      ...state.durableFacts,
      recent_open_tasks:
        db
          .listRecentTasks(20)
          .filter((task) => (!state.currentStartedAt || task.created_at >= state.currentStartedAt))
          .filter((task) => task.status === 'running' || task.status === 'partial')
          .map((task) => `#${task.id} ${task.status} ${task.title}`)
          .slice(0, 5),
    };

    if (summaryText) {
      conversationManager.updateMemory(chatId, {
        memorySummary: summaryText,
        durableFacts,
      });
    } else {
      conversationManager.updateMemory(chatId, {
        durableFacts,
      });
    }

    const profileUpdated = Object.values(extraction.profilePatch).some((value) =>
      Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0,
    );

    if (profileUpdated) {
      db.mergeDurableProfile(chatId, extraction.profilePatch, {
        source: 'memory_summarizer',
      });
    }

    let notesCreated = 0;

    for (const note of extraction.notes) {
      const existing = db.findNoteByExactContent(chatId, note.title, note.body);

      if (existing) {
        continue;
      }

      db.createNote({
        chatId,
        title: note.title,
        body: note.body,
        tags: note.tags,
      });
      notesCreated += 1;
    }

    if (!summaryText && !profileUpdated && notesCreated === 0) {
      return { summarized: false };
    }

    return {
      summarized: Boolean(summaryText) || profileUpdated || notesCreated > 0,
      summaryText: summaryText || null,
      keptItems: recentItems.length,
      profileUpdated,
      notesCreated,
    };
  }
}
