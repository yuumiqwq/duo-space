import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskScheduler, servesTaskSyncOrigin } from '../app/api/room/tasks/scheduler.ts';

test('only the instance serving the public origin can recover pending tasks', async () => {
  let calls = 0;
  const request = async (url, options) => {
    calls++; assert.equal(url.href, 'https://site.example/api/access/runtime');
    assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
    return Response.json({ instanceId: 'production' });
  };
  assert.equal(await servesTaskSyncOrigin('https://site.example', 'candidate', request), false);
  assert.equal(await servesTaskSyncOrigin('https://site.example', 'production', request), true);
  assert.equal(calls, 2);
  let writes = 0, errors = 0;
  const candidate = createTaskScheduler(async () => { writes++; }, async () => false);
  await candidate.tick(); assert.equal(writes, 0);
  const offline = createTaskScheduler(async () => { writes++; }, async () => { throw new Error('origin unavailable'); }, 15000, () => { errors++; });
  await offline.tick(); assert.equal(writes, 0); assert.equal(errors, 1);
});

test('background ticks continue without page requests and never overlap', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let writes = 0;
  const scheduler = createTaskScheduler(async () => { writes++; entered(); await gate; }, async () => true, 5);
  scheduler.start(); scheduler.start();
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await started;
    const a = scheduler.tick(), b = scheduler.tick(); assert.equal(a, b); assert.equal(writes, 1);
    release(); await a;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(writes > 1); scheduler.stop(); const stopped = writes;
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(writes, stopped);
  } finally { scheduler.stop(); clearTimeout(keepAlive); release(); }
});
