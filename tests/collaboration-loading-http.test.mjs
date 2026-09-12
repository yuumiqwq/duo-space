import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { encryptToken } from '../app/api/ticktick/crypto.ts';
import { taskFields } from '../app/api/room/tasks/store.ts';

test('HTTP website records and the fast member remain readable during a slow peer inbox request', { timeout: 20000 }, async () => {
  await mkdir('codex-generated/test-data', { recursive: true });
  const dir = await mkdtemp(path.resolve('codex-generated/test-data/loading-http-'));
  const secret = randomUUID(), previous = process.env.TICKTICK_STORAGE_SECRET;
  process.env.TICKTICK_STORAGE_SECRET = secret;
  const users = Object.fromEntries(['alice', 'bob'].map(id => [id, { nickname: id, ticktickToken: encryptToken('fixture-' + id) }]));
  if (previous === undefined) delete process.env.TICKTICK_STORAGE_SECRET; else process.env.TICKTICK_STORAGE_SECRET = previous;
  await writeFile(path.join(dir, 'identities.json'), JSON.stringify({ version: 1, users }));
  const tasks = Object.fromEntries(['alice', 'bob'].map(id => [id, { [id + '-task']: { ...taskFields({ title: id + '的任务' }), id: id + '-task', projectId: 'inbox-' + id } }]));
  await writeFile(path.join(dir, 'fake-dida.json'), JSON.stringify(tasks));
  await writeFile(path.join(dir, 'room-collaboration.json'), JSON.stringify({ version: 1, revision: 1, buffer: { public: { fields: taskFields({ title: '无需滴答即可阅读' }), version: 1, publisherId: 'alice' } }, operations: {}, workflows: {} }));
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['--import', './tests/helpers/dida-fixture.mjs', 'node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { env: { ...process.env, DATA_DIR: dir, AUTH_SESSION_SECRET: secret, TICKTICK_STORAGE_SECRET: secret, SITE_PASSWORD: 'fixture', DIDA_FIXTURE_INBOX_DELAY_MS: '2500', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' }, stdio: 'ignore', windowsHide: true });
  const origin = `http://127.0.0.1:${port}`;
  const payload = `alice.${Math.floor(Date.now() / 1000) + 600}`;
  const cookie = `ss_access=${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
  const call = query => fetch(origin + '/api/room/tasks?' + query, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(8000) });
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) { try { if ((await fetch(origin + '/access')).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.ok(ready);
    let started = performance.now();
    const local = await (await call('local=1')).json(), localMs = performance.now() - started;
    assert.equal(local.buffer[0].title, '无需滴答即可阅读'); assert.ok(local.members.every(member => member.loading));
    assert.ok(localMs < 1000, `local records took ${localMs}ms`);
    let slowDone = false;
    const slow = call('member=bob').then(response => response.json()).then(data => { slowDone = true; return data; });
    started = performance.now();
    const [aliceResponse, latestResponse] = await Promise.all([call('member=alice'), call('local=1')]);
    const alice = await aliceResponse.json(), latest = await latestResponse.json(), independentMs = performance.now() - started;
    assert.equal(alice.members.length, 1); assert.equal(alice.members[0].tasks[0].id, 'alice-task');
    assert.equal(latest.buffer.length, 1); assert.equal(slowDone, false);
    assert.ok(independentMs < 1000, `independent responses took ${independentMs}ms`);
    const bob = await slow; assert.equal(bob.members[0].tasks[0].id, 'bob-task');
    assert.equal((await call('member=unknown')).status, 404);
    const loggedOut = await fetch(origin + '/api/room/tasks?local=1', { redirect: 'manual' });
    assert.ok([401, 307].includes(loggedOut.status));
    console.log(`Website records: ${Math.round(localMs)}ms; fast member and next website read: ${Math.round(independentMs)}ms; peer delay: 2500ms`);
  } finally { child.kill(); await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); }); }
});
