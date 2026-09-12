import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { CollaborationStore, taskFields, remoteVersion } from '../app/api/room/tasks/store.ts';
import { attachmentMarkdown } from '../app/task-description-attachments.ts';

async function fixture() {
  await mkdir('codex-generated/test-data', { recursive: true });
  const dir = await mkdtemp(path.resolve('codex-generated/test-data/attachment-lifecycle-'));
  const output = path.join(dir, 'attachments.mjs');
  await build({ entryPoints: ['app/api/room/tasks/attachments/store.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output, logLevel: 'silent', define: { 'process.env.DATA_DIR': JSON.stringify(dir) } });
  const { TaskAttachmentStore } = await import(pathToFileURL(output).href);
  const attachments = new TaskAttachmentStore(dir), accounts = { alice: new Map(), bob: new Map() };
  const gateway = {
    taskAttachments: attachments,
    members: async () => ['alice', 'bob'].map(id => ({ id, name: id, connected: true })),
    inbox: async owner => ({ projectId: `inbox-${owner}`, tasks: [...accounts[owner].values()].map(task => structuredClone(task)) }),
    get: async (owner, id) => structuredClone(accounts[owner].get(id) || null),
    create: async (owner, id, fields) => accounts[owner].set(id, { ...fields, id, projectId: `inbox-${owner}` }),
    update: async (owner, id, fields) => Object.assign(accounts[owner].get(id), fields),
    complete: async (owner, id) => { accounts[owner].get(id).status = 2; },
    checkTransfer: async () => {},
  };
  const store = new CollaborationStore(dir, gateway);
  const stage = async (name = 'input.txt', contents = '附件正文') => {
    const item = await attachments.stage('alice', 'task', name, new Response(contents).body);
    return { ...item, content: attachmentMarkdown('https://study.11scat.xyz', item.name, item.path), location: path.join(dir, 'cloud-drive', item.path) };
  };
  const create = async content => { const result = await store.execute('alice', { id: randomUUID(), action: 'create', fields: { title: '测试任务', content } }); assert.equal(result.status, 'done'); return (await store.snapshot('alice')).buffer.find(task => task.id === result.id) || (await store.snapshot('alice')).buffer.at(-1); };
  const edit = async (task, content) => store.execute('alice', { id: randomUUID(), action: 'update', source: { ownerId: null, taskId: task.id, version: task.version }, fields: { content } });
  return { dir, attachments, accounts, gateway, store, stage, create, edit };
}

test('draft attachments are private and absent from the drive until save; saved removal deletes only its file', async () => {
  const f = await fixture(), a = await f.stage(), discarded = await f.stage('discarded.txt');
  await assert.rejects(stat(a.location), { code: 'ENOENT' });
  assert.equal(await readFile(await f.attachments.readable('alice', a.path), 'utf8'), '附件正文');
  await assert.rejects(f.attachments.readable('bob', a.path), { status: 404 });
  await assert.rejects(f.attachments.publish('bob', '', a.content), /暂存已失效/);
  let task = await f.create(a.content);
  assert.equal(await readFile(a.location, 'utf8'), '附件正文');
  assert.equal(await f.attachments.readable('bob', a.path), a.location);
  assert.ok((await readdir(path.join(f.dir, 'task-attachment-drafts'))).every(name => !name.startsWith(a.path.split('/')[2])));
  await assert.rejects(stat(discarded.location), { code: 'ENOENT' });
  const newFile = await f.stage('input.txt', '同名新文件');
  await assert.rejects(f.store.execute('alice', { id: randomUUID(), action: 'update', source: { ownerId: null, taskId: task.id, version: 'stale' }, fields: { content: newFile.content } }));
  await assert.rejects(stat(newFile.location), { code: 'ENOENT' });
  const update = await f.edit(task, newFile.content); assert.equal(update.status, 'done');
  assert.equal(await readFile(newFile.location, 'utf8'), '同名新文件');
  await assert.rejects(stat(a.location), { code: 'ENOENT' });
  await assert.rejects(f.attachments.readable('alice', a.path), { status: 404 });
  const originalDrafts = await readdir(path.join(f.dir, 'task-attachment-drafts'));
  assert.ok(originalDrafts.every(name => !name.startsWith(a.path.split('/')[2])));
});

test('workflow attachment deletion waits for linked saves and resumes cleanup after restart without losing submissions', async () => {
  const f = await fixture(), a = await f.stage();
  const task = await f.create(a.content);
  let w = await f.store.claim('bob', { id: randomUUID(), action: 'claim', source: { ownerId: null, taskId: task.id, version: task.version }, destination: 'bob' });
  const snapshot = await f.store.snapshot('bob', null);
  w = (await f.store.arrangeExecution('bob', { id: randomUUID(), action: 'arrange-execution', version: snapshot.executionVersion, workflowIds: [w.id] })).workflows.find(workflow => workflow.id === w.id);
  const act = (actor, action, extra = {}) => f.store.workflowCommand(actor, { id: randomUUID(), workflowId: w.id, version: w.version, action, ...extra });
  w = await act('bob', 'submit', { comment: '已提交材料' });
  const update = f.gateway.update;
  f.gateway.update = async () => { throw new Error('temporary save failure'); };
  w = await act('alice', 'update-workflow', { fields: { content: '' } });
  assert.ok(w.error); assert.equal(w.status, 'submitted'); assert.ok(await stat(a.location));
  f.gateway.update = update;
  const remove = f.attachments.remove.bind(f.attachments);
  f.attachments.remove = async () => { throw new Error('temporary cleanup failure'); };
  w = await act('bob', 'retry-workflow'); assert.ok(w.error); assert.ok(w.editPending);
  assert.equal(f.accounts.bob.get(w.targetId).content, ''); assert.ok(await stat(a.location));
  f.attachments.remove = remove;
  f.store = new CollaborationStore(f.dir, f.gateway);
  w = await act('bob', 'retry-workflow'); assert.equal(w.error, ''); assert.ok(!w.editPending);
  await assert.rejects(stat(a.location), { code: 'ENOENT' });
  assert.equal(w.events.find(event => event.type === 'submit').comment, '已提交材料');
  w = await act('alice', 'approve'); assert.equal(w.status, 'done');
});

test('shared attachment survives until its last current task removes the link, including legacy files', async () => {
  const f = await fixture(), a = await f.stage();
  const task = await f.create(a.content);
  f.accounts.alice.set('shared', { id: 'shared', projectId: 'inbox-alice', ...taskFields({ title: '另一个引用', content: a.content }) });
  assert.equal((await f.edit(task, '')).status, 'done'); assert.ok(await stat(a.location));
  const remote = f.accounts.alice.get('shared');
  const op = await f.store.execute('alice', { id: randomUUID(), action: 'update', source: { ownerId: 'alice', taskId: remote.id, version: remoteVersion(remote) }, fields: { content: '' } });
  assert.equal(op.status, 'done'); await assert.rejects(stat(a.location), { code: 'ENOENT' });
  const legacy = 'tasks/old-task/old-file/legacy.txt', location = path.join(f.dir, 'cloud-drive', legacy);
  await mkdir(path.dirname(location), { recursive: true }); await writeFile(location, '旧附件');
  const oldTask = await f.create(attachmentMarkdown('https://study.11scat.xyz', 'legacy.txt', legacy));
  assert.equal((await f.edit(oldTask, '')).status, 'done'); await assert.rejects(stat(location), { code: 'ENOENT' });
  await assert.rejects(f.attachments.remove(['tasks/../identities.json']), /路径无效/);
  await assert.rejects(f.attachments.stage('alice', '..', 'a.txt', new Response('x').body), /任务编号无效/);
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20 * 1024 * 1024 + 1)); controller.close(); } });
  await assert.rejects(f.attachments.stage('alice', 'task', 'large.txt', oversized), { status: 413 });
});

test('replacing a failed save still publishes its retained staged attachment', async () => {
  const f = await fixture(), task = await f.create('');
  let w = await f.store.claim('bob', { id: randomUUID(), action: 'claim', source: { ownerId: null, taskId: task.id, version: task.version }, destination: 'bob' });
  const a = await f.stage(), publish = f.attachments.publish.bind(f.attachments);
  f.attachments.publish = async () => { throw new Error('capacity temporarily unavailable'); };
  w = await f.store.workflowCommand('alice', { id: randomUUID(), workflowId: w.id, version: w.version, action: 'update-workflow', fields: { content: a.content } });
  assert.ok(w.error); await assert.rejects(stat(a.location), { code: 'ENOENT' });
  f.attachments.publish = publish;
  w = await f.store.workflowCommand('alice', { id: randomUUID(), workflowId: w.id, version: w.version, action: 'update-workflow', fields: { title: '保留附件再次保存' } });
  assert.equal(w.error, ''); assert.ok(!w.editPending); assert.ok(await stat(a.location));
  assert.equal(f.accounts.bob.get(w.targetId).content, a.content);
});
