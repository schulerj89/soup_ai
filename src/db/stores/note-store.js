import { safeJsonParse, toJson } from '../../utils/json.js';

function normalizeTags(tags) {
  return Array.isArray(tags)
    ? [...new Set(tags.map((tag) => `${tag}`.trim().toLowerCase()).filter(Boolean))]
    : [];
}

function mapNoteRow(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    tags: normalizeTags(safeJsonParse(row.tags_json, [])),
  };
}

export const noteStoreMethods = {
  createNote({ chatId, title, body, tags = [], sourceMessageId = null }) {
    const now = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO notes (
           chat_id,
           title,
           body,
           tags_json,
           source_message_id,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${chatId}`,
        `${title}`.trim(),
        `${body}`.trim(),
        toJson(normalizeTags(tags)),
        sourceMessageId,
        now,
        now,
      );

    return mapNoteRow(this.db.prepare('SELECT * FROM notes WHERE id = ?').get(result.lastInsertRowid));
  },

  listRecentNotes(chatId, limit = 10) {
    return this.db
      .prepare(
        `SELECT * FROM notes
         WHERE chat_id = ?
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
      )
      .all(`${chatId}`, limit)
      .map(mapNoteRow);
  },

  searchNotes(chatId, query, limit = 10) {
    const normalizedQuery = `${query ?? ''}`.trim();

    if (!normalizedQuery) {
      return [];
    }

    const like = `%${normalizedQuery}%`;

    return this.db
      .prepare(
        `SELECT * FROM notes
         WHERE chat_id = ?
           AND (
             title LIKE ? COLLATE NOCASE OR
             body LIKE ? COLLATE NOCASE OR
             tags_json LIKE ? COLLATE NOCASE
           )
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
      )
      .all(`${chatId}`, like, like, like, limit)
      .map(mapNoteRow);
  },

  findNoteByExactContent(chatId, title, body) {
    return mapNoteRow(
      this.db
        .prepare(
          `SELECT * FROM notes
           WHERE chat_id = ?
             AND title = ?
             AND body = ?
           ORDER BY id DESC
           LIMIT 1`,
        )
        .get(`${chatId}`, `${title}`.trim(), `${body}`.trim()),
    );
  },

  createNoteIfMissing({ chatId, title, body, tags = [], sourceMessageId = null }) {
    const existing = this.findNoteByExactContent(chatId, title, body);
    return existing ?? this.createNote({ chatId, title, body, tags, sourceMessageId });
  },

  getDurableProfile(chatId) {
    return this.getState(`durable_profile:${chatId}`, {
      preferences: {},
      routines: [],
      projects: [],
      people: {},
      personal_details: {},
      important_dates: [],
      saved_patterns: [],
    });
  },

  mergeDurableProfile(chatId, patch = {}, { source = 'system' } = {}) {
    const current = this.getDurableProfile(chatId);
    const next = mergeProfile(current, patch, source, this.now());
    this.setState(`durable_profile:${chatId}`, next);
    return next;
  },
};

function mergeNamedMap(current, patch, source, updatedAt) {
  const base = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
  const incoming = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};

  for (const [key, value] of Object.entries(incoming)) {
    const normalizedKey = `${key}`.trim();

    if (!normalizedKey || value == null || value === '') {
      continue;
    }

    base[normalizedKey] = {
      value,
      source,
      updated_at: updatedAt,
    };
  }

  return base;
}

function mergeList(current, patch, source, updatedAt) {
  const output = Array.isArray(current) ? [...current] : [];
  const items = Array.isArray(patch) ? patch : [];

  for (const item of items) {
    const value =
      item && typeof item === 'object' && !Array.isArray(item) ? `${item.value ?? ''}`.trim() : `${item ?? ''}`.trim();

    if (!value) {
      continue;
    }

    if (
      output.some(
        (existing) =>
          `${existing?.value ?? ''}`.trim().toLowerCase() === value.toLowerCase(),
      )
    ) {
      continue;
    }

    output.push({
      value,
      source,
      updated_at: updatedAt,
    });
  }

  return output;
}

function mergeProfile(current, patch, source, updatedAt) {
  const next = {
    preferences: mergeNamedMap(current?.preferences, patch?.preferences, source, updatedAt),
    routines: mergeList(current?.routines, patch?.routines, source, updatedAt),
    projects: mergeList(current?.projects, patch?.projects, source, updatedAt),
    people: mergeNamedMap(current?.people, patch?.people, source, updatedAt),
    personal_details: mergeNamedMap(current?.personal_details, patch?.personal_details, source, updatedAt),
    important_dates: mergeList(current?.important_dates, patch?.important_dates, source, updatedAt),
    saved_patterns: mergeList(current?.saved_patterns, patch?.saved_patterns, source, updatedAt),
  };

  return {
    ...next,
    updated_at: updatedAt,
  };
}
