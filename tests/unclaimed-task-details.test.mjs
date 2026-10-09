import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { taskFields } from '../app/api/room/tasks/store.ts';

test('unclaimed public and member titles use the same workflow dialog and settings without claimant history', async () => {
  await mkdir('codex-generated/test-data', { recursive: true });
  const dir = await mkdtemp(path.resolve('codex-generated/test-data/unclaimed-ui-'));
  const output = path.join(dir, 'component.mjs');
  await build({ entryPoints: ['app/ClaimWorkflows.tsx'], bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', outfile: output, logLevel: 'silent' });
  const { ClaimWorkflows } = await import(pathToFileURL(output).href);
  const members = ['alice','bob'].map(id => ({ id, name: id, tasks: [], connected: true }));
  for (const ownerId of [null, 'alice']) {
    const task = { ...taskFields({ title: '待认领任务', content: '任务说明' }), id: 'task', ownerId, publisherId: 'alice', version: '1' };
    const render = (identityId, workflows = []) => renderToStaticMarkup(createElement(ClaimWorkflows, { initialId: null, task, busy: false, error: '', perform() {}, onClose() {}, snapshot: { identityId, members, workflows } }));
    for (const viewer of ['alice', 'bob']) {
      const html = render(viewer);
      assert.match(html, /class="coop-workflows"/);
      assert.match(html, /class="coop-workflow-detail"/);
      assert.match(html, /class="coop-workflow-people">alice 审批/);
      assert.match(html, /<ol class="coop-workflow-events"><\/ol>/);
      assert.match(html, /<form[^>]+aria-label="详细设置"/);
      assert.ok(!html.includes(' 认领 · '));
      assert.ok(!html.includes('提交完成'));
      assert.equal(html.includes('直接完成'), viewer === 'alice');
      assert.ok(html.includes('aria-label="删除任务"'));
    }
    const workflow = { id: 'workflow', source: { ownerId, taskId: task.id }, claimantId: 'bob', reviewerId: 'alice', targetId: 'copy', title: task.title, fields: taskFields(task), status: 'working', version: 1, events: [{ id: 'claim', type: 'claimed', actorId: 'bob', at: 1, files: [] }] };
    const claimed = render('alice', [workflow]);
    assert.ok(claimed.includes('bob 认领 · alice 审批'));
    assert.ok(claimed.includes('bob · 认领'));
    assert.match(claimed, /<form[^>]+aria-label="详细设置"/);
  }
  const board = await readFile('app/RoomCollaboration.tsx', 'utf8');
  assert.ok(!board.includes('点击修改标题'));
  assert.ok(!board.includes('编辑协作任务'));
});

test('ordinary recurring or reopened tasks ignore archived details while explicit archive selection remains available', async () => {
  const parent = path.resolve('codex-generated/review-fixes-20261009/tasks/test-data');
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(parent, 'recurring-detail-')), output = path.join(dir, 'component.mjs');
  await build({ entryPoints: ['app/ClaimWorkflows.tsx'], bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', outfile: output, logLevel: 'silent' });
  const { ClaimWorkflows } = await import(pathToFileURL(output).href);
  for (const repeating of [false, true]) for (const status of ['done', 'deleted']) {
    const fields = taskFields({ title: 'Previous occurrence', ...(repeating ? { repeatFlag: 'RRULE:FREQ=DAILY', startDate: '2026-10-08T00:00:00+08:00', dueDate: '2026-10-08T00:00:00+08:00' } : {}) });
    const archive = { id: 'archive', source: { ownerId: 'alice', taskId: 'same-task' }, targetId: 'copy', claimantId: 'bob', reviewerId: 'alice', title: fields.title, fields, status, version: 1, events: [] };
    const task = { ...taskFields({ ...fields, title: 'Current occurrence', ...(repeating ? { startDate: '2026-10-09T00:00:00+08:00', dueDate: '2026-10-09T00:00:00+08:00' } : {}) }), id: 'same-task', ownerId: 'alice', version: 'new' };
    const snapshot = { identityId: 'alice', members: ['alice', 'bob'].map(id => ({ id, name: id, connected: true, tasks: [] })), workflows: [archive] };
    const render = (initialId, selectedTask = task, current = snapshot) => renderToStaticMarkup(createElement(ClaimWorkflows, { initialId, task: selectedTask, snapshot: current, busy: false, error: '', onClose() {}, perform() {} }));
    const ordinary = render(null);
    assert.ok(ordinary.includes('Current occurrence')); assert.ok(!ordinary.includes('Previous occurrence')); assert.ok(ordinary.includes('直接完成'));
    const explicit = render('archive');
    assert.ok(explicit.includes('Previous occurrence')); assert.ok(!explicit.includes('Current occurrence'));
    const active = { ...archive, id: 'active', status: 'working', fields: taskFields(task), title: 'New active workflow' };
    const linked = render(null, { ...task, workflowId: active.id }, { ...snapshot, workflows: [archive, active] });
    assert.ok(linked.includes('New active workflow')); assert.ok(!linked.includes('Previous occurrence'));
  }
});
