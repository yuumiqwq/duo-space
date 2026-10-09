import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { loadRoute } from './helpers/load-route.mjs';

const { NextRequest } = createRequire(import.meta.url)('next/server');

test('cloud routes return distinct upload paths, keep dot names manageable, and share import quota', async t => {
  const parent = path.resolve('codex-generated/review-fixes-20261009/server/test-data');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'cloud-routes-'));
  process.env.DATA_DIR = directory;
  process.env.CLOUD_DRIVE_LIMIT_BYTES = '100';
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await import(`../app/api/cloud/store.ts?routes=${randomUUID()}`);
  const replacement = { '../../identity/session': { currentIdentityId: async () => 'alice' }, '../store': store };
  const files = await loadRoute(new URL('../app/api/cloud/files/route.ts', import.meta.url), replacement);
  const importer = await loadRoute(new URL('../app/api/cloud/import-chat/route.ts', import.meta.url), replacement);
  const request = (pathname, body, headers = {}, method = 'POST') => new NextRequest(`http://fixture.test${pathname}`, {
    method, body, headers: { host: 'fixture.test', origin: 'http://fixture.test', ...headers },
  });
  const uploads = await Promise.all(['first', 'second'].map(body => files.POST(request('/api/cloud/files', body, { 'x-file-name': '.notes.txt' }))));
  assert.deepEqual(uploads.map(response => response.status), [201, 201]);
  const items = await Promise.all(uploads.map(async response => (await response.json()).item));
  assert.equal(new Set(items.map(item => item.path)).size, 2);
  assert.deepEqual(await Promise.all(items.map(item => readFile(path.join(store.cloudRoot, item.path), 'utf8'))), ['first', 'second']);
  assert.equal((await store.listCloudFolder('')).items.length, 2);
  const id = randomUUID();
  await mkdir(path.join(directory, 'chat-files'));
  await writeFile(path.join(directory, 'chat-files', `${id}.bin`), Buffer.alloc(80));
  await writeFile(path.join(directory, 'chat-files', `${id}.json`), JSON.stringify({ name: 'voice.wav', size: 80, kind: 'audio' }));
  assert.equal((await importer.POST(request('/api/cloud/import-chat', JSON.stringify({ attachmentId: id }), { 'content-type': 'application/json' }))).status, 507);
  for (const item of items) {
    assert.equal((await files.DELETE(request('/api/cloud/files', JSON.stringify({ path: item.path, confirmed: true }), { 'content-type': 'application/json' }, 'DELETE'))).status, 200);
  }
  assert.equal((await importer.POST(request('/api/cloud/import-chat', JSON.stringify({ attachmentId: id }), { 'content-type': 'application/json' }))).status, 201);
  assert.equal((await store.cloudStatus()).usedBytes, 80);
  assert.equal((await files.POST(request('/api/cloud/files', 'denied', { origin: 'http://outside.test' }))).status, 403);
  assert.equal((await files.POST(request('/api/cloud/files?path=tasks/example', 'small', { 'content-length': String(20 * 1024 * 1024 + 1) }))).status, 413);
});
