import { safeJsonParse, toJson } from '../../utils/json.js';

export const stateStoreMethods = {
  getState(key, fallback = null) {
    const row = this.db.prepare('SELECT value_json FROM app_state WHERE key = ?').get(key);
    return row ? safeJsonParse(row.value_json, fallback) : fallback;
  },

  setState(key, value) {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO app_state (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(key, toJson(value), now);
  },

  getAgentSessionState(chatId) {
    return this.getState(`agent_session:${chatId}`, null);
  },

  setAgentSessionState(chatId, value) {
    this.setState(`agent_session:${chatId}`, value);
  },

  clearAgentSessionState(chatId) {
    this.db.prepare('DELETE FROM app_state WHERE key = ?').run(`agent_session:${chatId}`);
  },

  getConversationControlState(chatId) {
    return this.getState(`conversation_control:${chatId}`, null);
  },

  setConversationControlState(chatId, value) {
    this.setState(`conversation_control:${chatId}`, value);
  },

  clearConversationControlState(chatId) {
    this.db.prepare('DELETE FROM app_state WHERE key = ?').run(`conversation_control:${chatId}`);
  },

  getCursor(key, fallback = 0) {
    const value = this.getState(key, fallback);
    return Number.isFinite(value) ? value : fallback;
  },

  setCursor(key, value) {
    this.setState(key, value);
  },

  getActiveCodexRun() {
    return this.getState('active_codex_run', null);
  },

  setActiveCodexRun(value) {
    this.setState('active_codex_run', value);
  },

  clearActiveCodexRun() {
    this.db.prepare('DELETE FROM app_state WHERE key = ?').run('active_codex_run');
  },
};
