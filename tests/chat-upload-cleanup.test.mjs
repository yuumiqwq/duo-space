import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { loadRoute } from './helpers/load-route.mjs';

async function fixture(t, patch = {}) {
  const parent = path.resolve('codex-generated/review-fixes-20261009/server/test-data');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'chat-'));
  process.env.DATA_DIR = directory;
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let imports = 0;
  const route = await loadRoute(new URL('../app/api/chat/files/route.ts', import.meta.url), {
    'node:fs/promises': { ...fs, ...patch },
    '../../identity/session': { currentIdentityId: async () => 'alice' },
    '../../cloud/store': { autoImportChatFile: async () => { imports++; return { warning: '' }; } },
  });
  return { route, directory: path.join(directory, 'chat-files'), imports: () => imports };
}
const request = body => new Request('http://fixture.test/api/chat/files', {
  method: 'POST', body, duplex: 'half', headers: { 'X-File-Name': 'notes.txt', 'Content-Type': 'application/octet-stream' },
});

test('aborted chat request removes partial data and leaves no metadata or cloud import', async t => {
  const fixtureData = await fixture(t);
  let chunks = 0;
  const body = new ReadableStream({ pull(controller) {
    if (chunks++ === 0) controller.enqueue(Buffer.alloc(65536));
    else controller.error(new Error('request aborted'));
  } });
  const response = await fixtureData.route.POST(request(body));
  assert.equal(response.status, 400);
  assert.deepEqual(await fs.readdir(fixtureData.directory), []);
  assert.equal(fixtureData.imports(), 0);
});

for (const failure of ['write', 'close', 'data-rename', 'metadata-write', 'metadata-rename']) {
  test(`chat upload cleans both data and metadata after ${failure} fails`, async t => {
    let failed = false;
    const inject = () => { failed = true; throw new Error('injected I/O failure'); };
    const fixtureData = await fixture(t, {
      async open(...args) {
        const handle = await fs.open(...args);
        return {
          async writeFile(...values) { if (failure === 'write') inject(); return handle.writeFile(...values); },
          async close() { await handle.close(); if (failure === 'close' && !failed) inject(); },
        };
      },
      async rename(source, destination) {
        if ((failure === 'data-rename' && destination.endsWith('.bin')) || (failure === 'metadata-rename' && destination.endsWith('.json'))) inject();
        return fs.rename(source, destination);
      },
      async writeFile(filename, data, options) {
        if (failure === 'metadata-write') { await fs.writeFile(filename, '{', options); inject(); }
        return fs.writeFile(filename, data, options);
      },
    });
    assert.equal((await fixtureData.route.POST(request('contents'))).status, 400);
    assert.ok(failed);
    assert.deepEqual(await fs.readdir(fixtureData.directory), []);
    assert.equal(fixtureData.imports(), 0);
  });
}

test('completed chat upload keeps exact data and metadata and still imports ordinary files', async t => {
  const fixtureData = await fixture(t);
  const response = await fixtureData.route.POST(request('contents'));
  assert.equal(response.status, 201);
  const { attachment } = await response.json();
  assert.equal(await fs.readFile(path.join(fixtureData.directory, `${attachment.id}.bin`), 'utf8'), 'contents');
  assert.equal(JSON.parse(await fs.readFile(path.join(fixtureData.directory, `${attachment.id}.json`), 'utf8')).size, 8);
  assert.equal((await fs.readdir(fixtureData.directory)).length, 2);
  assert.equal(fixtureData.imports(), 1);
});
