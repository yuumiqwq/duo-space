import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { CollaborationStore, taskFields } from '../app/api/room/tasks/store.ts';

async function harness(snapshot, perform) {
  const parent = path.resolve('codex-generated/review-fixes-20261009/tasks/test-data');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'planner-conflict-')), output = path.join(directory, 'component.mjs');
  const key = `plannerHooks_${randomUUID()}`;
  await build({ entryPoints: ['app/ExecutionPlanner.tsx'], bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', outfile: output, logLevel: 'silent', plugins: [{ name: 'controlled-hooks', setup(plugin) {
    plugin.onResolve({ filter: /^react$/ }, () => ({ path: key, namespace: 'hooks' }));
    plugin.onLoad({ filter: /.*/, namespace: 'hooks' }, () => ({ contents: `const hooks = globalThis[${JSON.stringify(key)}]; export const useState = (...args) => hooks.useState(...args); export const useRef = (...args) => hooks.useRef(...args); export const useEffect = (...args) => hooks.useEffect(...args);`, loader: 'js' }));
  } }] });
  const cells = []; let cursor = 0, lastRequest;
  globalThis[key] = {
    useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial; return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return cells[index] ||= { current: initial }; },
    useEffect() { cursor++; },
  };
  const { ExecutionPlanner } = await import(pathToFileURL(output).href);
  const h = { directory, snapshot, closed: 0, attempts: [], render() { cursor = 0; return ExecutionPlanner({ snapshot: h.snapshot, notices: [], name: id => id, busy: false, uncertain: false, error: '', onClose() { h.closed++; }, perform(command) { h.attempts.push(command); lastRequest = perform(command, h); return lastRequest; } }); },
    async save(tree) { button(tree, '保存').props.onClick(); await lastRequest; await Promise.resolve(); },
    dispose() { delete globalThis[key]; },
  };
  return h;
}
function buttons(node, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (Array.isArray(node)) { node.forEach(child => buttons(child, result)); return result; }
  if (node.type === 'button') result.push(node);
  buttons(node.props?.children, result);
  return result;
}
const button = (tree, label) => buttons(tree).find(node => node.props.children === label);
const checkbox = (tree, id) => buttons(tree).find(node => node.props.role === 'checkbox' && node.key === id);
const workflow = (title, executing = false) => ({ id: randomUUID(), title, source: { ownerId: 'alice', taskId: title, version: '1' }, claimantId: 'bob', reviewerId: 'alice', targetId: title + '-target', fields: taskFields({ title }), status: 'working', version: 1, executing, createdAt: 1, updatedAt: 1, events: [], error: '', signature: 'fixture', targetCreation: { state: 'received' } });

test('the mounted planner recovers a real version conflict only after explicitly loading the latest arrangement', async () => {
  const a = workflow('A', true), b = workflow('B'), c = workflow('C');
  let store;
  const results = [];
  const h = await harness({ identityId: 'bob', workflows: [a, b, c], executionVersion: 4 }, async (command, current) => {
    try { await store.arrangeExecution('bob', command); results.push('saved'); return true; }
    catch (error) { assert.match(error.message, /执行安排已更新/); results.push('conflict'); current.snapshot = await store.snapshot('bob', null); return false; }
  });
  try {
    await writeFile(path.join(h.directory, 'room-collaboration.json'), JSON.stringify({ version: 1, revision: 1, buffer: {}, operations: {}, workflows: Object.fromEntries([a, b, c].map(item => [item.id, item])), executionPlans: { bob: { version: 4, receipts: [] } } }));
    store = new CollaborationStore(h.directory, { members: async () => ['alice', 'bob'].map(id => ({ id, name: id, connected: true })) });
    let tree = h.render(); checkbox(tree, b.id).props.onClick(); tree = h.render();
    await store.arrangeExecution('bob', { id: randomUUID(), action: 'arrange-execution', version: 4, workflowIds: [a.id, c.id] });
    await h.save(tree); assert.deepEqual(results, ['conflict']); assert.equal(h.closed, 0);
    tree = h.render();
    assert.ok(button(tree, '保存').props.disabled);
    assert.ok(checkbox(tree, b.id).props['aria-checked'], 'the failed local draft is kept until the user explicitly refreshes it');
    assert.ok(!checkbox(tree, c.id).props['aria-checked']);
    await h.save(tree); assert.equal(h.attempts.length, 1, 'a stale draft is never silently rebased and sent');
    button(tree, '重新安排').props.onClick(); tree = h.render();
    assert.ok(checkbox(tree, c.id).props['aria-checked']); assert.ok(!checkbox(tree, b.id).props['aria-checked']);
    checkbox(tree, b.id).props.onClick(); tree = h.render();
    await h.save(tree);
    assert.deepEqual(results, ['conflict', 'saved']); assert.deepEqual(h.attempts.map(item => item.version), [4, 5]);
    assert.deepEqual(new Set(h.attempts[1].workflowIds), new Set([a.id, b.id, c.id]));
    assert.equal(h.closed, 1);
  } finally { h.dispose(); }
});

test('refreshing an arrangement drops completed/deleted selections and locks current pending-review slots', async () => {
  const a = workflow('Completed', true), b = workflow('Deleted', true), c = workflow('Reserved', true), d = workflow('New');
  const h = await harness({ identityId: 'bob', workflows: [a, b, c, d], executionVersion: 1 }, async () => true);
  try {
    h.render();
    h.snapshot = { ...h.snapshot, executionVersion: 2, workflows: [{ ...a, status: 'done', executing: false }, { ...b, status: 'deleted', executing: false }, { ...c, status: 'submitted' }, d] };
    let tree = h.render(); button(tree, '重新安排').props.onClick(); tree = h.render();
    assert.equal(checkbox(tree, a.id), undefined); assert.equal(checkbox(tree, b.id), undefined);
    assert.ok(checkbox(tree, c.id).props.disabled); assert.ok(checkbox(tree, c.id).props['aria-checked']);
    checkbox(tree, c.id).props.onClick(); checkbox(tree, d.id).props.onClick(); tree = h.render();
    await h.save(tree);
    assert.deepEqual(h.attempts[0].workflowIds, [c.id, d.id]); assert.equal(h.attempts[0].version, 2);
  } finally { h.dispose(); }
});

test('a newly reserved slot can refresh even before the arrangement version advances', async () => {
  const a = workflow('Completing', true), b = workflow('Available');
  const h = await harness({ identityId: 'bob', workflows: [a, b], executionVersion: 1 }, async () => true);
  try {
    let tree = h.render(); checkbox(tree, a.id).props.onClick(); tree = h.render();
    assert.ok(!checkbox(tree, a.id).props['aria-checked']);
    h.snapshot = { ...h.snapshot, workflows: [{ ...a, status: 'approving' }, b] };
    tree = h.render();
    assert.ok(button(tree, '保存').props.disabled);
    button(tree, '重新安排').props.onClick(); tree = h.render();
    assert.ok(checkbox(tree, a.id).props['aria-checked']); assert.ok(checkbox(tree, a.id).props.disabled);
    await h.save(tree); assert.deepEqual(h.attempts[0].workflowIds, [a.id]);
  } finally { h.dispose(); }
});
