import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import webPush from 'web-push';

test('task push reuses subscription devices, excludes unrelated recipients and cleans expired endpoints', async () => {
  await mkdir('codex-generated/test-data', { recursive: true });
  const dir = await mkdtemp(path.resolve('codex-generated/test-data/task-push-'));
  const env = Object.fromEntries(['DATA_DIR', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'].map(key => [key, process.env[key]]));
  process.env.DATA_DIR = dir; const keys = webPush.generateVAPIDKeys(); process.env.VAPID_PUBLIC_KEY = keys.publicKey; process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  const send = webPush.sendNotification, deliveries = [];
  try {
    await writeFile(path.join(dir, 'identities.json'), JSON.stringify({ version: 1, users: { alice: { nickname: 'Alice' }, bob: { nickname: 'Bob' }, charlie: { nickname: 'Charlie' } } }));
    const subscriptions = ['alice', 'bob', 'charlie', 'removed'].map(identityId => ({ identityId, deviceId: `${identityId}-device`, endpoint: `https://push.example/${identityId}`, keys: {}, updatedAt: Date.now() }));
    subscriptions.push({ identityId: 'bob', endpoint: 'https://push.example/expired', keys: {}, updatedAt: Date.now() });
    await writeFile(path.join(dir, 'push-subscriptions.json'), JSON.stringify({ version: 1, subscriptions }));
    webPush.sendNotification = async (subscription, payload, options) => { deliveries.push({ endpoint: subscription.endpoint, data: JSON.parse(payload), options }); if (subscription.endpoint.endsWith('/expired')) throw { statusCode: 410 }; return { statusCode: 201 }; };
    const output = path.join(dir, 'push.mjs'); await build({ entryPoints: ['app/api/push/store.ts'], bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: output, logLevel: 'silent' });
    const { sendTaskPush, sendDeviceTestPush, sendChatPush } = await import(pathToFileURL(output).href);
    assert.equal((await sendDeviceTestPush('alice', 'https://push.example/bob')).status, 404);
    assert.equal(deliveries.length, 0, 'a user cannot test another identity endpoint');
    assert.equal((await sendDeviceTestPush('bob', 'https://push.example/bob')).status, 200);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].endpoint, 'https://push.example/bob');
    assert.equal(deliveries[0].options.TTL, 60);
    deliveries.length = 0;
    await sendTaskPush({ id: 'event-1', kind: 'workflow', workflowId: 'workflow-1', title: '作业', body: '催办', actorId: 'alice', recipients: ['alice', 'bob'] });
    assert.deepEqual(deliveries.map(item => item.endpoint), ['https://push.example/bob', 'https://push.example/expired']);
    assert.equal(deliveries[0].data.kind, 'task'); assert.match(deliveries[0].data.url, /workflow=workflow-1/); assert.equal(deliveries[0].options.urgency, 'high');
    assert.ok(!JSON.parse(await readFile(path.join(dir, 'push-subscriptions.json'), 'utf8')).subscriptions.some(item => item.endpoint.endsWith('/expired')));
    deliveries.length = 0;
    await sendTaskPush({ id: 'public-1', kind: 'public', title: '公共任务', body: '新任务', actorId: 'alice' });
    assert.deepEqual(deliveries.map(item => item.endpoint), ['https://push.example/bob', 'https://push.example/charlie']);
    deliveries.length = 0;
    await sendChatPush({ id: 'chat-test', sender: 'Alice', body: '中'.repeat(8000) }, 'alice-device');
    assert.deepEqual(deliveries.map(item => item.endpoint), ['https://push.example/bob', 'https://push.example/charlie']);
    assert.equal(deliveries[0].data.kind, 'chat');
    assert.ok(Buffer.byteLength(JSON.stringify(deliveries[0].data)) < 3993);
  } finally {
    webPush.sendNotification = send;
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('service worker uses task event tags, vibration and duplicate suppression', async () => {
  const handlers = {}, shown = [];
  const self = { addEventListener: (name, callback) => { handlers[name] = callback; }, registration: { getNotifications: async ({ tag }) => shown.filter(item => item.options.tag === tag), showNotification: async (title, options) => shown.push({ title, options }) } };
  runInNewContext(await readFile('public/sw.js', 'utf8'), { self });
  const push = async data => { let done; handlers.push({ data: { json: () => data }, waitUntil: promise => { done = promise; } }); await done; };
  const notice = { kind: 'task', noticeId: 'event-1', title: '同桌催办', body: '请回复', url: '/?taskboard=1' };
  await push(notice); await push(notice); await push({ ...notice, noticeId: 'event-2' });
  assert.equal(shown.length, 2); assert.equal(shown[0].options.tag, '11scat-task-event-1');
  assert.deepEqual(Array.from(shown[0].options.vibrate), [200, 100, 200]); assert.equal(shown[0].options.data.url, '/?taskboard=1');
});
