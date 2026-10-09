import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

test('concurrent writes, retries, paging and recalls preserve every message', async () => {
  const root = path.resolve('codex-generated/test-data');
  await mkdir(root, { recursive: true });
  process.env.DATA_DIR = await mkdtemp(path.join(root, 'chat-'));
  const store = await import('../app/api/chat/store.ts');
  const otherRouteBundle = await import('../app/api/chat/store.ts?second-bundle');
  const fixture = (id) => ({ id, body: id, identityId: 'alice', sender: 'Alice', time: '12:00', createdAt: 100 });
  // A legacy file may contain many identical timestamps from the old writer.
  await writeFile(path.join(process.env.DATA_DIR, 'chat-messages.json'), JSON.stringify({ version: 1, messages: Array.from({ length: 250 }, (_, i) => fixture('old-' + i)) }));
  const legacy = await store.listMessageChanges(0, 200);
  assert.equal(legacy.messages.length, 250);
  const history = await store.listMessages(null, 30);
  assert.equal(history.messages.length, 250);
  const written = await Promise.all(Array.from({ length: 240 }, (_, i) => (i % 2 ? otherRouteBundle : store).saveMessage(fixture('new-' + i))));
  assert.equal(new Set(written.map((m) => m.createdAt)).size, 240);
  const retry = await store.saveMessage(fixture('new-1'));
  assert.deepEqual(retry, written[1]);
  assert.deepEqual(await store.findMessage('new-1', 'alice'), written[1]);
  assert.equal(await store.findMessage('new-1', 'bob'), null);
  await assert.rejects(store.saveMessage({ ...fixture('new-1'), identityId: 'bob' }));
  const seen = new Set();
  let cursor = legacy.cursor;
  for (;;) {
    const page = await store.listMessageChanges(cursor, 31);
    page.messages.forEach((m) => { assert.ok(!seen.has(m.id)); seen.add(m.id); });
    cursor = page.cursor;
    if (!page.hasMore) break;
  }
  assert.equal(seen.size, 240);
  await store.recallMessage('new-1', 'alice');
  const recalled = await store.listMessageChanges(cursor, 31);
  assert.deepEqual(recalled.recalledIds, ['new-1']);
  assert.ok(recalled.cursor > cursor);
  assert.equal((await store.findMessage('new-1', 'alice')).recalled, true);
  assert.equal((await store.listMessages(null, 30)).cursor, recalled.cursor);
});
