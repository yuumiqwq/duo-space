import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { attachmentMarkdown } from '../app/task-description-attachments.ts';

async function fixture(t, limit = 100) {
  const parent = path.resolve('codex-generated/review-fixes-20261009/server/test-data');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'cloud-'));
  process.env.DATA_DIR = directory;
  process.env.CLOUD_DRIVE_LIMIT_BYTES = String(limit);
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Bundle the full module graph so each fixture gets its own configuration,
  // including the path/capacity modules imported by the public store entry.
  const output = path.join(directory, 'cloud.mjs');
  await build({ entryPoints: ['app/api/cloud/store.ts'], bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: output, logLevel: 'silent' });
  return { directory, store: await import(pathToFileURL(output).href), moduleURL: pathToFileURL(output).href };
}
const stream = bytes => new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(bytes)); controller.close(); } });

test('concurrent same-name uploads retain every distinct body and existing files', async t => {
  const { store } = await fixture(t, 10000);
  await store.saveCloudUpload(stream('original'), '', 'same.txt');
  const bodies = Array.from({ length: 40 }, (_, i) => `body-${i}`);
  const items = await Promise.all(bodies.map(body => store.saveCloudUpload(stream(body), '', 'same.txt')));
  assert.equal(new Set(items.map(item => item.path)).size, bodies.length);
  assert.equal(await readFile(path.join(store.cloudRoot, 'same.txt'), 'utf8'), 'original');
  assert.deepEqual(await Promise.all(items.map(item => readFile(path.join(store.cloudRoot, item.path), 'utf8'))), bodies);
  assert.equal((await store.listCloudFolder('')).items.length, 41);
  assert.deepEqual(await readdir(store.cloudStagingRoot), []);
});

test('name publication also refuses replacement between independent processes', async t => {
  const { directory, store } = await fixture(t, 100000);
  const moduleURL = new URL('../app/api/cloud/store.ts', import.meta.url).href;
  const script = `
    const { saveCloudUpload } = await import(${JSON.stringify(moduleURL)});
    const label = process.argv[1];
    const files = await Promise.all(Array.from({ length: 16 }, (_, i) => {
      const body = new ReadableStream({ start(c) { c.enqueue(Buffer.from(label + '-' + i)); c.close(); } });
      return saveCloudUpload(body, '', 'same.txt');
    }));
    process.stdout.write(JSON.stringify(files));
  `;
  const run = label => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, label], {
      windowsHide: true, env: { ...process.env, DATA_DIR: directory, CLOUD_DRIVE_LIMIT_BYTES: '100000' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  const results = (await Promise.all([run('a'), run('b')])).flat();
  assert.equal(new Set(results.map(item => item.path)).size, 32);
  const actual = await Promise.all(results.map(item => readFile(path.join(store.cloudRoot, item.path), 'utf8')));
  const expected = ['a', 'b'].flatMap(label => Array.from({ length: 16 }, (_, i) => `${label}-${i}`));
  assert.deepEqual(actual.sort(), expected.sort());
});

test('upload reservations reject another upload or import and release after a failed stream', async t => {
  const { directory, store } = await fixture(t);
  const source = path.join(directory, 'source.bin');
  await writeFile(source, Buffer.alloc(60));
  let controller;
  const pendingBody = new ReadableStream({ start(value) { controller = value; } });
  const pending = store.saveCloudUpload(pendingBody, '', 'first.bin', 60);
  // Poll a public operation until the first request has reserved its declared body.
  for (let i = 0; i < 50; i++) {
    try { await store.assertCloudCapacity(60); }
    catch (error) { assert.ok(error instanceof store.CloudCapacityError); break; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await assert.rejects(store.saveCloudUpload(stream(Buffer.alloc(60)), '', 'second.bin', 60), store.CloudCapacityError);
  await assert.rejects(store.importChatAttachment(randomUUID(), source, 'source.bin', 60, 'chat'), store.CloudCapacityError);
  controller.error(new Error('connection aborted'));
  await assert.rejects(pending, /connection aborted/);
  const saved = await store.importChatAttachment(randomUUID(), source, 'source.bin', 60, 'chat');
  assert.equal((await readFile(path.join(store.cloudRoot, saved))).length, 60);
  assert.equal((await store.cloudStatus()).usedBytes, 60);
  assert.deepEqual(await readdir(store.cloudStagingRoot), []);
});

test('unknown-length concurrent uploads and imports share the ninety-percent ceiling', async t => {
  const { directory, store } = await fixture(t);
  const source = path.join(directory, 'source.bin');
  await writeFile(source, Buffer.alloc(60));
  const results = await Promise.allSettled([
    store.saveCloudUpload(stream(Buffer.alloc(60)), '', 'first.bin'),
    store.saveCloudUpload(stream(Buffer.alloc(60)), '', 'second.bin'),
    store.importChatAttachment(randomUUID(), source, 'source.bin', 1, 'chat'),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason instanceof store.CloudCapacityError));
  assert.equal((await store.cloudStatus()).usedBytes, 60);
});

test('duplicate imports are idempotent at the ceiling and independent module copies coordinate', async t => {
  const { directory, store, moduleURL } = await fixture(t);
  const other = await import(`${moduleURL}?second=${randomUUID()}`);
  const source = path.join(directory, 'source.bin'), id = randomUUID();
  await writeFile(source, Buffer.alloc(90, 7));
  const items = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? store : other).importChatAttachment(id, source, 'same.bin', 90, 'chat')));
  assert.equal(new Set(items).size, 1);
  assert.equal((await store.cloudStatus()).usedBytes, 90);
  assert.deepEqual(await readFile(path.join(store.cloudRoot, items[0])), Buffer.alloc(90, 7));
});

test('dot-prefixed user folders and files remain visible, counted, readable and deletable', async t => {
  const { store } = await fixture(t);
  const folder = await store.createCloudFolder('', '.notes');
  const item = await store.saveCloudUpload(stream('secret'), folder, '.secret.txt');
  assert.equal((await store.listCloudFolder('')).items[0].name, '.notes');
  assert.equal((await store.listCloudFolder(folder)).items[0].name, '.secret.txt');
  assert.equal((await store.cloudStatus()).usedBytes, 6);
  assert.equal(await readFile(path.join(store.cloudRoot, item.path), 'utf8'), 'secret');
  await store.deleteCloudItem(item.path);
  await store.deleteCloudItem(folder);
  assert.deepEqual((await store.listCloudFolder('')).items, []);
});

test('capacity is checked again at publication and an understated body is rejected without leftovers', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.saveCloudUpload(stream(Buffer.alloc(91)), '', 'too-large.bin', 1), store.CloudCapacityError);
  assert.equal((await store.cloudStatus()).usedBytes, 0);
  const reservation = await store.reserveCloudCapacity(60);
  await writeFile(path.join(store.cloudRoot, 'external.bin'), Buffer.alloc(40));
  let published = false;
  await assert.rejects(reservation.commit(60, async () => { published = true; }), store.CloudCapacityError);
  assert.equal(published, false);
  await reservation.release();
  await store.saveCloudUpload(stream(Buffer.alloc(50)), '', 'allowed.bin', 50);
  assert.equal((await store.cloudStatus()).usedBytes, 90);
  assert.deepEqual(await readdir(store.cloudStagingRoot), []);
});

test('complete-file writers can join capacity coordination without retaining failed reservations', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.withCloudCapacity(80, async () => { throw new Error('publication failed'); }), /publication failed/);
  const results = await Promise.allSettled(['a', 'b'].map(name => store.withCloudCapacity(60, () => writeFile(path.join(store.cloudRoot, name), Buffer.alloc(60)))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await store.cloudStatus()).usedBytes, 60);
});

test('task attachment publication shares capacity with cloud uploads across route bundles', async t => {
  const { directory, store } = await fixture(t);
  const output = path.join(directory, 'attachments.mjs');
  await build({ entryPoints: ['app/api/room/tasks/attachments/store.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output, logLevel: 'silent', define: { 'process.env.DATA_DIR': JSON.stringify(directory), 'process.env.CLOUD_DRIVE_LIMIT_BYTES': '"100"' } });
  const { TaskAttachmentStore } = await import(pathToFileURL(output).href);
  const attachments = new TaskAttachmentStore(directory);
  const draft = await attachments.stage('alice', 'task', 'draft.txt', stream(Buffer.alloc(60)));
  const content = attachmentMarkdown('https://study.example', draft.name, draft.path);
  const upload = await store.reserveCloudCapacity(60);
  await assert.rejects(attachments.publish('alice', '', content), error => error.status === 507);
  assert.equal((await store.cloudStatus()).usedBytes, 0);
  await upload.release();
  await attachments.publish('alice', '', content);
  assert.equal((await store.cloudStatus()).usedBytes, 60);
  await assert.rejects(store.saveCloudUpload(stream(Buffer.alloc(60)), '', 'another.bin'), store.CloudCapacityError);
});
