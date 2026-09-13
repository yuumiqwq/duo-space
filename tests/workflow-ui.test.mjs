import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { taskFields } from '../app/api/room/tasks/store.ts';

test('workflow detail offers settings to every member and direct completion only to original owner', async () => {
  await mkdir('codex-generated/test-data', { recursive: true });
  const dir = await mkdtemp(path.resolve('codex-generated/test-data/workflow-ui-')), output = path.join(dir, 'component.mjs');
  await build({ entryPoints: ['app/ClaimWorkflows.tsx'], bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', outfile: output, logLevel: 'silent' });
  const { ClaimWorkflows, WorkflowList } = await import(pathToFileURL(output).href);
  const workflow = { id: 'workflow', title: '测试', reviewerId: 'alice', claimantId: 'bob', fields: taskFields({ title: '测试' }), status: 'working', executing: true, events: [] };
  const render = (identityId, status = 'working', editPending = false, error = '') => renderToStaticMarkup(createElement(ClaimWorkflows, { initialId: workflow.id, busy: false, error, onClose() {}, onEdit() {}, perform() {}, snapshot: { identityId, members: ['alice', 'bob', 'charlie'].map(id => ({ id, name: id })), workflows: [{ ...workflow, status, editPending }] } }));
  for (const member of ['alice', 'bob', 'charlie']) for (const status of ['creating', 'working', 'submitted', 'rejected', 'approving', 'done', 'deleted']) {
    const html = render(member, status); assert.match(html, /<form[^>]+aria-label="详细设置"/); assert.ok(!html.includes(">详细设置</button>"));
    assert.equal(html.includes('直接完成'), member === 'alice' && !['done','deleted'].includes(status));
    const settings = html.match(/<form[^>]+aria-label="详细设置"[\s\S]*?<\/form>/)[0];
    assert.equal(settings.includes('aria-label="删除任务"'), member !== 'charlie' && status !== 'deleted');
    if(status==='deleted') assert.match(settings, /disabled/);
  }
  assert.ok(render('bob').includes('提交完成')); assert.ok(!render('bob', 'working', true).includes('提交完成'));
  assert.ok(!render('charlie', 'working', true).includes('核对并继续')); assert.ok(render('charlie', 'working', true).includes('正在同步任务'));
  const workflows = [{ ...workflow, id: 'mine', title: '我认领的事项' }, { ...workflow, id: 'theirs', title: '他人认领的事项', claimantId: 'alice', reviewerId: 'bob' }, { ...workflow, id: 'done', title: '归档事项示例', status: 'done' }, { ...workflow, id:'deleted',title:'已删除归档示例',status:'deleted' }];
  const overview = archived => renderToStaticMarkup(createElement(WorkflowList, { workflows, archived, setArchived() {}, select() {}, name: id => id }));
  const active = overview(false); assert.ok(active.includes('我认领的事项')); assert.ok(active.includes('他人认领的事项')); assert.ok(!active.includes('归档事项示例')); assert.ok(active.includes('已归档'));
  assert.ok(!active.includes('已删除归档示例')); const archive = overview(true); assert.ok(archive.includes('已删除归档示例')); assert.ok(archive.includes('归档事项示例')); assert.ok(!archive.includes('我认领的事项')); assert.ok(!archive.includes('他人认领的事项')); assert.ok(archive.includes('未完成流程'));
  const notices = [{ id: 'nudge-notice', workflowId: 'theirs', eventType: 'nudge' }, { id: 'done-notice', workflowId: 'done', eventType: 'completed' }];
  const withNotices = renderToStaticMarkup(createElement(WorkflowList, { workflows, notices, archived: false, setArchived() {}, select() {}, name: id => id }));
  assert.ok(withNotices.indexOf('我认领的事项') < withNotices.indexOf('他人认领的事项'), 'unread badges do not reorder equal-priority execution tasks');
  assert.match(withNotices, /1 条归档新记录/); assert.match(withNotices, /task-notice-dot/);
  assert.match(withNotices, /coop-workflow-status has-update">有更新/);
  assert.ok(!overview(false).includes('有更新'), 'read workflow returns to its actual status');
  assert.ok(!overview(false).includes('task-notice-dot'), 'read acknowledgements remove dots and unread sorting');
  for (const status of ['creating', 'working', 'submitted', 'rejected', 'approving']) {
    for (const flags of [{}, { taskAnomaly: true }, { reopenPending: true }, { needsSubmission: true }]) {
      for (const updated of [false, true]) {
        const html = renderToStaticMarkup(createElement(WorkflowList, { workflows: [{ ...workflow, ...flags, status }], notices: updated ? [{ id: 'update', workflowId: workflow.id }] : [], archived: false, setArchived() {}, select() {}, name: id => id }));
        const label = html.match(/coop-workflow-status [^"]+">([^<]+)<\/span>/)?.[1];
        assert.equal(label, updated ? '有更新' : undefined, 'active stages are shown by group titles rather than trailing status badges');
      }
    }
  }
  const ordered = renderToStaticMarkup(createElement(WorkflowList, { workflows: [...workflows, { ...workflow, id: 'review', title: '优先审批事项', status: 'submitted', createdAt: 1 }], notices, archived: false, setArchived() {}, select() {}, name: id => id }));
  assert.ok(ordered.indexOf('他人认领的事项') < ordered.indexOf('优先审批事项'), 'execution is the first group');
  workflow.executing = false;
  assert.ok(!render('bob').includes('提交完成')); assert.ok(render('bob').includes('已认领'));
  workflow.executing = true;
  const choosing = renderToStaticMarkup(createElement(WorkflowList, { workflows: [...workflows, { ...workflow, id: 'reserved', status: 'submitted' }], notices, archived: false, setArchived() {}, select() {}, name: id => id, identityId: 'bob', executionDraft: ['mine', 'reserved'], toggleExecution() {} }));
  assert.ok(!choosing.includes('>有更新<')); assert.match(choosing, /role="checkbox" aria-checked="true"/);
  assert.match(choosing, /coop-complete coop-execution-checkbox/); assert.match(choosing, /role="checkbox" aria-checked="true" disabled/);
  workflow.events = ['claimed', 'submit', 'approve', 'completed'].map((type, index) => ({ id: String(index), actorId: 'bob', type, at: 1700000000000, comment: type === 'completed' ? '不可显示的后台完成说明' : '', files: [] }));
  const history = render('alice', 'done');
  assert.ok(!history.includes('安排认领')); assert.ok(!history.includes('完成同步')); assert.ok(!history.includes('不可显示的后台完成说明'));
  assert.ok(history.includes('bob · 认领')); assert.ok(history.includes('提交完成')); assert.ok(history.includes('审批通过'));
  assert.ok(render('bob').includes('aria-label="删除任务"')); assert.ok(render('alice').includes('aria-label="删除任务"'));
  assert.ok(render('alice').includes('>催办</button>')); assert.ok(!render('bob').includes('>催办</button>'));
  workflow.fields.content = '前文 [附件：报告.pdf](https://study.11scat.xyz/task-attachment?path=tasks%2Fa%2Fb.pdf) 后文';
  const attachmentHtml = render('alice');
  assert.match(attachmentHtml, /前文 <a[^>]+>\[报告.pdf\]<\/a> 后文/);
  assert.match(attachmentHtml, /aria-label="任务附件"/);
  assert.ok(!attachmentHtml.includes('[附件：报告.pdf]'), 'raw Markdown is not shown in the description');
  assert.ok(!attachmentHtml.includes('target="_blank"'), 'task attachment clicks stay in the current page');
  workflow.events.push({ id: 'old-attachment-change', actorId: 'alice', type: 'updated', at: 1700000000000, comment: `说明：无 → ${workflow.fields.content}`, files: [] });
  assert.ok(render('alice').includes('说明：无 → 前文 [报告.pdf] 后文'));
  workflow.fields.content = '[附件：hash.png](https://study.11scat.xyz/task-attachment?path=tasks%2Fa%2Fphoto.png)';
  workflow.events.push({ id: 'image-review', type: 'approve', actorId: 'alice', at: 1700000000000, comment: '[图1.png] [证明.pdf]', files: [{ id: 'image', name: 'hash.png', url: '/api/room/tasks/files/image' }, { id: 'document', name: '证明.pdf', url: '/api/room/tasks/files/document' }] });
  const images = render('alice', 'submitted', false, 'Unexpected end of JSON input');
  assert.ok(images.includes('src="/api/room/tasks/files/image?preview=1"'));
  assert.ok(images.includes('alt="图1.png"'));
  assert.ok(images.includes('download="证明.pdf"'));
  assert.ok(!images.includes('Unexpected end of JSON input'));
  assert.ok(!images.includes('每个 20 MB'));
  const description = images.match(/<div class="task-description">[\s\S]*?<\/div>/)[0];
  assert.ok(description.includes('[图1.png]')); assert.ok(!description.includes('<img'));
  for (const claimantId of ['alice', 'bob']) for (const actorId of ['alice', 'bob']) {
    workflow.claimantId = claimantId;
    workflow.events = [{ id: 'existing-claim', actorId, type: 'claimed', at: 1700000000000, comment: '', files: [] }];
    for (const viewer of ['alice', 'bob']) {
      const expected = actorId === claimantId ? `${claimantId} · 认领` : `${actorId} · 安排 ${claimantId} 认领`;
      const html = render(viewer);
      assert.ok(html.includes(expected), 'historical claim events distinguish assignment from self-claim for both viewers');
      if (actorId !== claimantId) assert.ok(!html.includes(`${actorId} · 认领`), 'the arranger is never presented as the claimant');
    }
  }
  workflow.claimantId = 'bob';
  workflow.fields.content = '';
  workflow.reopenPending = true; workflow.needsSubmission = true;
  workflow.events.push({ id: 'old-auto', type: 'external-task-reopened', actorId: '', at: 1700000000000, comment: '历史自动恢复提示', files: [] });
  const silentRepair = render('bob', 'submitted');
  assert.ok(!silentRepair.includes('历史自动恢复提示'));
  assert.ok(!silentRepair.includes('正在恢复未完成')); assert.ok(!silentRepair.includes('待补充提交'));
  assert.ok(!silentRepair.includes('workflow-sync-spinner'));
  delete workflow.reopenPending; delete workflow.needsSubmission;
  workflow.ownerDeletePending = true; workflow.error = '滴答授权不足或已失效，请该成员重新连接';
  const pendingDeletion = render('alice');
  assert.match(pendingDeletion, /role="alert">滴答授权不足或已失效，请该成员重新连接/);
  assert.ok(pendingDeletion.includes('workflow-sync-spinner'));
  delete workflow.ownerDeletePending; delete workflow.error;
  workflow.error = '滴答清单中删除失败';
  const archivedDeletion = render('alice', 'deleted');
  assert.match(archivedDeletion, /role="alert">滴答清单中删除失败/);
  assert.match(archivedDeletion, />已删除<\/span>/);
  assert.ok(!archivedDeletion.includes('workflow-sync-spinner'));
  assert.ok(!archivedDeletion.includes('aria-label="删除任务"'));
  delete workflow.error;
  workflow.taskAnomaly = true;
  for (const member of ['alice', 'bob', 'charlie']) {
    const html = render(member, 'submitted');
    assert.ok(!html.includes('恢复任务</button>'));
    assert.ok(html.includes('>待审批</span>'));
    assert.match(html, /<\/ol><p class="coop-feedback error" role="alert"><small>该任务已被删除<\/small><\/p>/);
    assert.equal(html.match(/该任务已被删除/g).length, 1);
    assert.ok(!html.match(/<ol[\s\S]*该任务已被删除[\s\S]*<\/ol>/));
    assert.ok(!html.includes('>通过</button>')); assert.ok(!html.includes('>提交完成</button>'));
  }
});
