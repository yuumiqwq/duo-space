import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID, createECDH, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import webPush from 'web-push';

test('real push routes authenticate, repair subscription records, isolate deletion and retain chat after delivery is unavailable', { timeout: 45000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), '11scat-push-http-'));
  await writeFile(path.join(dir, 'identities.json'), JSON.stringify({ version: 1, users: { alice: { nickname: 'Alice' }, bob: { nickname: 'Bob' } } }));
  const secret = randomUUID(), vapid = webPush.generateVAPIDKeys();
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    windowsHide: true, stdio: 'ignore', env: { ...process.env, DATA_DIR: dir, AUTH_SESSION_SECRET: secret, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey },
  });
  const origin = `http://127.0.0.1:${port}`;
  const cookie = identity => { const payload = `${identity}.${Math.floor(Date.now() / 1000) + 600}`; return `ss_access=${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`; };
  const call = (identity, route, method = 'GET', body, headers = {}) => fetch(origin + route, {
    method, redirect: 'manual', headers: { Cookie: cookie(identity), 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    let ready = false;
    for (let i = 0; i < 90; i++) { try { if ((await fetch(origin + '/access')).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 200)); }
    assert.ok(ready);
    assert.equal((await call('alice', '/api/push/public-key')).status, 200);
    assert.ok([307, 401].includes((await fetch(origin + '/api/push/subscriptions', { method: 'POST', redirect: 'manual' })).status));
    assert.equal((await call('alice', '/api/push/test', 'POST', { endpoint: 'https://push.example/not-registered' })).status, 404);
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
    const subscription = { endpoint: 'https://push.example/device', expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    const save = () => call('alice', '/api/push/subscriptions', 'POST', { subscription, deviceId: 'device-a' });
    assert.equal((await call('alice', '/api/push/subscriptions', 'POST', { subscription, deviceId: 'device-a' }, { Origin: 'https://foreign.invalid' })).status, 403);
    assert.equal((await save()).status, 200);
    await writeFile(path.join(dir, 'push-subscriptions.json'), JSON.stringify({ version: 1, subscriptions: [] }));
    assert.equal((await save()).status, 200);
    const saved = () => readFile(path.join(dir, 'push-subscriptions.json'), 'utf8').then(JSON.parse);
    assert.equal((await saved()).subscriptions.length, 1);
    assert.equal((await call('bob', '/api/push/subscriptions', 'DELETE', { endpoint: subscription.endpoint })).status, 200);
    assert.equal((await saved()).subscriptions.length, 1);
    assert.equal((await call('alice', '/api/push/subscriptions', 'DELETE', { endpoint: subscription.endpoint })).status, 200);
    assert.equal((await saved()).subscriptions.length, 0);
    // No recipients: do not contact a push provider or any real user in this test.
    const id = randomUUID(), body = '中'.repeat(3000);
    assert.equal((await call('alice', '/api/chat/messages', 'POST', { id, body })).status, 201);
    assert.equal((await call('alice', '/api/chat/messages', 'POST', { id, body })).status, 201);
    const messages = await (await call('bob', '/api/chat/messages?since=0')).json();
    assert.equal(messages.messages.length, 1); assert.equal(messages.messages[0].body, body);
  } finally { child.kill(); }
});
