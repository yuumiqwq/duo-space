import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { CollaborationRepository } from '../app/api/room/tasks/repository.ts';
import { CollaborationError, taskFields } from '../app/api/room/tasks/domain.ts';
import { CollaborationError as PublicCollaborationError } from '../app/api/room/tasks/store.ts';

async function fixture(t) {
  const parent = path.resolve('codex-generated/refactor-20261009/test-data');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'repository-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'room-collaboration.json'), repository: new CollaborationRepository(directory) };
}
const task = title => ({ fields: taskFields({ title }), version: 1 });

test('the public error identity and legacy v1 publication receipts remain compatible', async t => {
  assert.equal(CollaborationError, PublicCollaborationError);
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify({ version: 1, revision: 3, buffer: { first: task('Legacy task') }, operations: {
    publication: { action: 'create', actorId: 'alice', targetId: 'first', status: 'done', createdAt: 1000 },
    obsolete: { action: 'move', status: 'pending' },
  } }));
  const bytes = await readFile(f.file, 'utf8');
  const state = await f.repository.read();
  assert.equal(state.buffer.first.publisherId, 'alice');
  assert.equal(state.buffer.first.publishedAt, 1000);
  assert.deepEqual(state.workflows, {});
  assert.equal(state.operations.obsolete.action, 'move');
  assert.equal(await readFile(f.file, 'utf8'), bytes, 'read-time compatibility does not publish a migration by itself');
  state.buffer.second = task('New task'); state.revision++;
  await f.repository.write(state);
  const saved = JSON.parse(await readFile(f.file, 'utf8'));
  assert.equal(saved.version, 1); assert.equal(saved.revision, 4);
  assert.equal(saved.buffer.first.publisherId, 'alice');
  assert.equal(saved.buffer.second.fields.title, 'New task');
  assert.equal(saved.operations.obsolete.action, 'move');
});

test('independent repository bundles merge disjoint commits and reject stale writes to one task', async t => {
  const f = await fixture(t);
  const outputs = ['repository-a.mjs', 'repository-b.mjs'].map(name => path.join(f.directory, name));
  await Promise.all(outputs.map(outfile => build({ entryPoints: ['app/api/room/tasks/repository.ts'], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })));
  const repositories = await Promise.all(outputs.map(async outfile => new (await import(pathToFileURL(outfile).href)).CollaborationRepository(f.directory)));
  const [left, right] = await Promise.all(repositories.map(repository => repository.read()));
  left.buffer.left = task('Left'); left.revision++;
  right.buffer.right = task('Right'); right.revision++;
  await Promise.all(repositories.map((repository, index) => repository.write([left, right][index])));
  const merged = await f.repository.read();
  assert.deepEqual(Object.keys(merged.buffer).sort(), ['left', 'right']);
  assert.equal(merged.revision, 2);
  const stale = await Promise.all(repositories.map(repository => repository.read()));
  stale[0].buffer.left.fields.title = 'First edit'; stale[0].revision++;
  stale[1].buffer.left.fields.title = 'Competing edit'; stale[1].revision++;
  const outcomes = await Promise.allSettled(repositories.map((repository, index) => repository.write(stale[index])));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const failure = outcomes.find(result => result.status === 'rejected');
  assert.equal(failure.reason.status, 409);
  const final = await f.repository.read();
  assert.ok(['First edit', 'Competing edit'].includes(final.buffer.left.fields.title));
  assert.equal(final.buffer.right.fields.title, 'Right');
  assert.equal(final.revision, 3);
  assert.ok(!(await readdir(f.directory)).some(filename => filename.endsWith('.tmp')));
});

test('incompatible persisted state and untracked snapshots fail without replacing the saved file', async t => {
  const f = await fixture(t);
  const bytes = JSON.stringify({ version: 2, revision: 1, buffer: {}, operations: {} });
  await writeFile(f.file, bytes);
  await assert.rejects(f.repository.read(), /协作记录格式异常/);
  assert.equal(await readFile(f.file, 'utf8'), bytes);
  await assert.rejects(f.repository.write({ version: 1, revision: 1, buffer: {}, operations: {}, workflows: {} }), { status: 409 });
  assert.equal(await readFile(f.file, 'utf8'), bytes);
});
