import test from 'node:test';
import assert from 'node:assert/strict';
import { AppDb } from '../src/db/app-db.js';
import { SqliteSession } from '../src/openai/sqlite-session.js';
import { MemorySummarizer } from '../src/openai/memory-summarizer.js';

test('MemorySummarizer compacts old session items into a summary', async () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    const session = new SqliteSession({ db, chatId: 'chat-1', maxItems: 50 });
    await session.addItems([
      { role: 'user', content: [{ type: 'input_text', text: 'A' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'B' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'C' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'D' }] },
    ]);

    const summarizer = new MemorySummarizer({
      model: 'gpt-test',
      threshold: 2,
      keepRecentItems: 2,
      runImpl: async () => ({ finalOutput: 'Summary text' }),
    });

    const result = await summarizer.summarizeSession(session);
    const snapshot = await session.getSnapshot();

    assert.equal(result.summarized, true);
    assert.equal(snapshot.summaryText, 'Summary text');
    assert.equal(snapshot.items.length, 2);
    assert.equal(snapshot.items[0].content[0].text, 'C');
  } finally {
    db.close();
  }
});
