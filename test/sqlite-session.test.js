import test from 'node:test';
import assert from 'node:assert/strict';
import { AppDb } from '../src/db/app-db.js';
import { SqliteSession } from '../src/openai/sqlite-session.js';

test('SqliteSession persists items across instances for the same chat', async () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    const first = new SqliteSession({ db, chatId: 'chat-1', maxItems: 10 });
    const sessionId = await first.getSessionId();

    await first.addItems([
      { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    ]);

    const second = new SqliteSession({ db, chatId: 'chat-1', maxItems: 10 });
    assert.equal(await second.getSessionId(), sessionId);
    const snapshot = await second.getSnapshot();
    assert.equal(snapshot.summaryText, null);
    assert.equal((await second.getItems()).length, 2);
  } finally {
    db.close();
  }
});

test('SqliteSession trims old items when maxItems is exceeded', async () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    const session = new SqliteSession({ db, chatId: 'chat-2', maxItems: 2 });

    await session.addItems([
      { role: 'user', content: [{ type: 'input_text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'two' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'three' }] },
    ]);

    const items = await session.getItems();
    assert.equal(items.length, 2);
    assert.equal(items[0].content[0].text, 'two');
    assert.equal(items[1].content[0].text, 'three');
  } finally {
    db.close();
  }
});

test('SqliteSession includes a summary item ahead of recent items', async () => {
  const db = new AppDb({ dbPath: ':memory:' });

  try {
    const session = new SqliteSession({ db, chatId: 'chat-3', maxItems: 10 });
    await session.compact({
      summaryText: 'User prefers concise replies.',
      items: [{ role: 'user', content: [{ type: 'input_text', text: 'latest turn' }] }],
    });

    const items = await session.getItems();
    assert.equal(items.length, 2);
    assert.equal(items[0].role, 'system');
    assert.match(items[0].content, /concise replies/);
    assert.equal(items[1].content[0].text, 'latest turn');
  } finally {
    db.close();
  }
});
