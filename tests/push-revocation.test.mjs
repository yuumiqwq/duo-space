import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import webPush from 'web-push';

const hash = endpoint => createHash('sha256').update(endpoint).digest('hex');

test('permanent push rejection survives restart, prevents automatic registration and permits a replacement device subscription', async () => {
  await mkdir('codex-generated/test-data', { recursive: true });
  const directory = await mkdtemp(path.resolve('codex-generated/test-data/push-revocation-'));
  const environment = Object.fromEntries(['DATA_DIR', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'].map(key => [key, process.env[key]]));
  const originalSend = webPush.sendNotification;
  const endpoint = 'https://push.invalid/rejected-fixture';
  const other = { endpoint: 'https://push.invalid/other-fixture', expirationTime: null, keys: { p256dh: 'A'.repeat(87), auth: 'A'.repeat(22) }, identityId: 'alice', deviceId: 'alice-device', updatedAt: Date.now() };
  const subscription = { ...other, endpoint, identityId: 'bob', deviceId: 'bob-device' };
  const storeFile = path.join(directory, 'push-subscriptions.json');
  const saved = () => readFile(storeFile, 'utf8').then(JSON.parse);
  try {
    process.env.DATA_DIR = directory;
    const keys = webPush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    await writeFile(path.join(directory, 'identities.json'), JSON.stringify({ version: 1, users: { alice: { nickname: 'Alice' }, bob: { nickname: 'Bob' } } }));
    const output = path.join(directory, 'push.mjs');
    await build({ entryPoints: ['app/api/push/store.ts'], bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: output, logLevel: 'silent' });
    const store = await import(pathToFileURL(output).href);
    const senders = [
      [404, () => store.sendDeviceTestPush('bob', endpoint)],
      [410, () => store.sendChatPush({ id: 'fixture-chat', sender: 'Alice', body: 'fixture' }, 'alice-device')],
      [404, () => store.sendTaskPush({ id: 'fixture-task', kind: 'workflow', title: 'fixture', body: 'fixture', actorId: 'alice', recipients: ['bob'] })],
      [410, () => store.sendRingPush({ id: 'fixture-ring', recipientId: 'bob', senderName: 'Alice', expiresAt: Date.now() + 120000 })],
    ];
    for (const [index, [statusCode, send]] of senders.entries()) {
      // Exercise a legacy store without the optional rejection metadata.
      await writeFile(storeFile, JSON.stringify({ version: 1, subscriptions: [other, subscription] }));
      let providerCalls = 0;
      webPush.sendNotification = async item => {
        providerCalls++;
        assert.equal(item.endpoint, endpoint, 'only fixture recipients are selected');
        throw { statusCode };
      };
      await send();
      assert.equal(providerCalls, 1);
      const persisted = await saved();
      assert.deepEqual(persisted.subscriptions.map(item => item.endpoint), [other.endpoint]);
      assert.equal(persisted.rejectedEndpoints.length, 1);
      assert.equal(persisted.rejectedEndpoints[0].hash, hash(endpoint));
      assert.ok(!JSON.stringify(persisted.rejectedEndpoints).includes(endpoint));
      const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => store.savePushSubscription(subscription)));
      assert.ok(attempts.every(result => result.status === 'rejected' && result.reason.name === 'RejectedPushSubscriptionError'));
      await store.removePushSubscription(endpoint, 'bob');
      await assert.rejects(store.savePushSubscription(subscription), { name: 'RejectedPushSubscriptionError' });
      // A new module instance must still reject the old address after restart.
      const restarted = await import(pathToFileURL(output).href + `?restart=${index}`);
      await assert.rejects(restarted.savePushSubscription({ ...subscription, identityId: 'alice', deviceId: 'different-device' }), { name: 'RejectedPushSubscriptionError' });
      await restarted.savePushSubscription({ ...subscription, endpoint: 'https://push.invalid/replacement-fixture' });
      const repaired = await saved();
      assert.equal(repaired.subscriptions.filter(item => item.identityId === 'bob' && item.deviceId === 'bob-device').length, 1);
      assert.ok(repaired.subscriptions.some(item => item.endpoint === other.endpoint));
      assert.ok(repaired.subscriptions.some(item => item.endpoint === 'https://push.invalid/replacement-fixture'));
      await Promise.all(Array.from({ length: 12 }, (_, n) => (n % 2 ? restarted : store).savePushSubscription({
        ...other, endpoint: `https://push.invalid/bundle-${n}`, deviceId: `bundle-${n}`,
      })));
      assert.equal((await saved()).subscriptions.length, 14, 'independent route bundles must retain every device');
      await assert.rejects(restarted.savePushSubscription(subscription), { name: 'RejectedPushSubscriptionError' });
    }

    // Temporary provider failures are not permanent rejection markers.
    for (const statusCode of [503, 429, undefined]) {
      await writeFile(storeFile, JSON.stringify({ version: 1, subscriptions: [subscription] }));
      webPush.sendNotification = async () => { throw { statusCode }; };
      assert.equal(await store.sendRingPush({ id: 'temporary-fixture', recipientId: 'bob', senderName: 'Alice', expiresAt: Date.now() + 120000 }), 'failed');
      await store.savePushSubscription(subscription);
      assert.equal((await saved()).rejectedEndpoints.length, 0);
    }

    // Expired metadata is discarded, and long-running records remain bounded.
    await writeFile(storeFile, JSON.stringify({ version: 1, subscriptions: [], rejectedEndpoints: [{ hash: hash(endpoint), rejectedAt: Date.now() - 180 * 86400000 - 1 }] }));
    await store.savePushSubscription(subscription);
    assert.equal((await saved()).rejectedEndpoints.length, 0);
    const rejectedEndpoints = Array.from({ length: 1100 }, (_, index) => ({ hash: hash(`fixture-${index}`), rejectedAt: Date.now() - index - 1000 }));
    await writeFile(storeFile, JSON.stringify({ version: 1, subscriptions: [subscription], rejectedEndpoints }));
    webPush.sendNotification = async () => { throw { statusCode: 410 }; };
    assert.equal((await store.sendDeviceTestPush('bob', endpoint)).status, 410);
    const bounded = await saved();
    assert.equal(bounded.rejectedEndpoints.length, 1024);
    assert.ok(bounded.rejectedEndpoints.some(item => item.hash === hash(endpoint)));
    await assert.rejects(store.savePushSubscription(subscription), { name: 'RejectedPushSubscriptionError' });

    // Execute the actual registration route with only authentication stubbed.
    const routeOutput = path.join(directory, 'subscription-route.cjs');
    await build({ entryPoints: ['app/api/push/subscriptions/route.ts'], bundle: true, packages: 'external', platform: 'node', format: 'cjs', outfile: routeOutput, logLevel: 'silent', plugins: [{
      name: 'fixture-authentication', setup(builder) {
        builder.onResolve({ filter: /identity\/session$/ }, () => ({ path: 'fixture-authentication', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export async function currentIdentityId() { return "bob"; }', loader: 'js' }));
      },
    }] });
    const route = createRequire(import.meta.url)(routeOutput);
    const register = item => route.POST(new Request('https://study.example/api/push/subscriptions', {
      method: 'POST', headers: { Host: 'study.example', Origin: 'https://study.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: item, deviceId: 'bob-device' }),
    }));
    assert.equal((await register(subscription)).status, 410);
    assert.equal((await register({ ...subscription, endpoint: 'https://push.invalid/route-replacement-fixture' })).status, 200);
  } finally {
    webPush.sendNotification = originalSend;
    for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
