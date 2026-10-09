import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CollaborationStore } from '../app/api/room/tasks/store.ts';
import { cleanupDraftFiles, metadata, uploadFile, WORKFLOW_DRAFT_TTL_MS } from '../app/api/room/tasks/files/storage.ts';

async function fixture() {
  const parent = path.resolve('codex-generated/review-fixes-20261009/tasks/test-data');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'workflow-drafts-'));
  const accounts = { alice: new Map(), bob: new Map() };
  const gateway = {
    members: async () => ['alice', 'bob'].map(id => ({ id, name: id, connected: true })),
    inbox: async owner => ({ projectId: `inbox-${owner}`, tasks: [...accounts[owner].values()].map(task => structuredClone(task)) }),
    get: async (owner, id) => structuredClone(accounts[owner].get(id) || null),
    create: async (owner, id, fields) => { accounts[owner].set(id, { ...fields, id, projectId: `inbox-${owner}`, status: 0 }); return structuredClone(accounts[owner].get(id)); },
    update: async (owner, id, fields) => Object.assign(accounts[owner].get(id), fields),
    complete: async (owner, id) => { accounts[owner].get(id).status = 2; },
    remove: async (owner, id) => { accounts[owner].delete(id); },
    cleanupWorkflowFiles: () => cleanupDraftFiles(directory),
  };
  const store = new CollaborationStore(directory, gateway);
  await store.execute('alice', { id: randomUUID(), action: 'create', fields: { title: 'Draft lifecycle' } });
  const task = (await store.snapshot('alice', null)).buffer[0];
  let workflow = await store.claim('bob', { id: randomUUID(), action: 'claim', source: { ownerId: null, taskId: task.id, version: task.version }, destination: 'bob' });
  workflow = (await store.arrangeExecution('bob', { id: randomUUID(), action: 'arrange-execution', version: 0, workflowIds: [workflow.id] })).workflows[0];
  const upload = (actor = 'bob', body = 'draft') => uploadFile(directory, new Request('http://localhost/upload', { method: 'POST', body }), workflow.id, actor, 'result.txt', () => store.attachmentAccess(actor, workflow.id, true));
  const command = async (actor, action, attachments = []) => {
    workflow = await store.workflowCommand(actor, { id: randomUUID(), workflowId: workflow.id, version: workflow.version, action, attachments });
    return workflow;
  };
  const age = async (file, createdAt = Date.now() - WORKFLOW_DRAFT_TTL_MS - 1000, extra = {}) => {
    const location = path.join(directory, 'workflow-files', `${file.id}.json`);
    await writeFile(location, JSON.stringify({ ...await metadata(directory, file.id), createdAt, ...extra }));
  };
  const exists = file => stat(path.join(directory, 'workflow-files', file.id));
  return { directory, store, gateway, upload, command, age, exists, workflow: () => workflow };
}

test('only unreferenced workflow drafts strictly beyond the explicit expiry are removed', async () => {
  const f = await fixture(), expired = await f.upload(), boundary = await f.upload(), recent = await f.upload();
  const now = Date.now();
  await f.age(expired, now - WORKFLOW_DRAFT_TTL_MS - 1);
  await f.age(boundary, now - WORKFLOW_DRAFT_TTL_MS);
  await f.age(recent, now);
  assert.deepEqual(await cleanupDraftFiles(f.directory, now), [expired.id]);
  await assert.rejects(f.exists(expired), { code: 'ENOENT' });
  await assert.rejects(metadata(f.directory, expired.id), { status: 404 });
  assert.ok(await f.exists(boundary)); assert.ok(await f.exists(recent));
  const invalid = await f.upload(); await f.age(invalid, null);
  assert.ok(!(await cleanupDraftFiles(f.directory, now)).includes(invalid.id), 'unknown timestamps do not authorize deletion');
});

test('quota calculation reclaims abandoned expired drafts and preserves submitted review history after restart', async () => {
  const f = await fixture(), abandoned = await f.upload();
  // Represent historical quota usage without allocating 100 MiB in a test.
  await f.age(abandoned, Date.now() - WORKFLOW_DRAFT_TTL_MS - 1000, { size: 100 * 1024 * 1024 });
  const submitted = await f.upload();
  await assert.rejects(f.exists(abandoned), { code: 'ENOENT' });
  await f.command('bob', 'submit', [submitted.id]);
  await f.age(submitted);
  const review = await f.upload('alice');
  await f.command('alice', 'reject', [review.id]);
  await f.age(review);
  await f.command('bob', 'submit');
  await f.command('alice', 'approve');
  assert.equal(f.workflow().status, 'done');
  const restarted = new CollaborationStore(f.directory, f.gateway);
  await restarted.maintainWorkflows();
  assert.deepEqual(await cleanupDraftFiles(f.directory), []);
  assert.ok(await f.exists(submitted)); assert.ok(await f.exists(review));
  const workflow = (await restarted.snapshot('alice', null)).workflows[0];
  assert.ok(workflow.events.some(event => event.files.some(file => file.id === submitted.id)));
  assert.ok(workflow.events.some(event => event.files.some(file => file.id === review.id)));
});

test('an expired draft removed after metadata validation cannot become a durable submission', { timeout: 5000 }, async () => {
  const f = await fixture(), file = await f.upload();
  await f.age(file);
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const save = f.store.saveWorkflow.bind(f.store);
  f.store.saveWorkflow = async (state, workflow) => {
    if (workflow.events.some(event => event.type === 'submit')) { entered(); await gate; }
    return save(state, workflow);
  };
  const submitting = f.command('bob', 'submit', [file.id]);
  // Install the rejection handler before releasing the deliberately paused save.
  const rejected = assert.rejects(submitting, { status: 400 });
  await reached;
  try { assert.deepEqual(await cleanupDraftFiles(f.directory), [file.id]); }
  finally { release(); }
  await rejected;
  const stored = JSON.parse(await readFile(path.join(f.directory, 'room-collaboration.json'), 'utf8'));
  assert.ok(!stored.workflows[f.workflow().id].events.some(event => event.type === 'submit'));
  assert.equal(stored.workflows[f.workflow().id].status, 'working');
});

test('a durable approval attachment survives superseding deletion even without an approval event', async () => {
  const f = await fixture();
  await f.command('bob', 'submit');
  const file = await f.upload('alice');
  const get = f.gateway.get;
  f.gateway.get = async () => { throw new Error('provider unavailable'); };
  await f.command('alice', 'approve', [file.id]);
  assert.ok(f.workflow().error);
  await f.age(file);
  assert.deepEqual(await cleanupDraftFiles(f.directory), []);
  f.gateway.get = get;
  await f.command('alice', 'delete-owner-task');
  assert.equal(f.workflow().status, 'deleted');
  assert.ok(!f.workflow().events.some(event => event.type === 'approve'));
  assert.equal((await metadata(f.directory, file.id)).retained, true);
  assert.deepEqual(await cleanupDraftFiles(f.directory), []);
  assert.ok(await f.exists(file));
});

test('normal maintenance reclaims drafts without waiting for another upload', async () => {
  const f = await fixture(), file = await f.upload();
  await f.age(file);
  await f.store.maintainWorkflows(true);
  await assert.rejects(f.exists(file), { code: 'ENOENT' });
});
