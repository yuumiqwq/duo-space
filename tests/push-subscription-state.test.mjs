import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPushSubscription } from '../app/push-subscription.ts';

const key = 'AQID';
function fixture() {
  const subscription = {
    expirationTime: null, options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
    toJSON: () => ({ endpoint: 'https://push.example/device', keys: {} }),
    unsubscribe: () => assert.fail('checking must not cancel a subscription'),
  };
  const registration = { pushManager: {
    getSubscription: async () => subscription,
    subscribe: () => assert.fail('checking must not recreate a subscription'),
  } };
  return { subscription, registration, signal: new AbortController().signal };
}

test('temporary failures remain unknown and recovery reuses the existing subscription', async () => {
  const { registration, signal } = fixture();
  for (const request of [
    async () => { throw new TypeError('offline'); },
    async () => new Response('Unavailable', { status: 503 }),
    async () => Response.json({}, { status: 401 }),
    async () => new Response('<html>login</html>'),
    async url => url.endsWith('public-key') ? Response.json({ publicKey: key }) : new Response(null, { status: 503 }),
  ]) assert.equal(await checkPushSubscription(registration, 'device', signal, request), 'unknown');
  const saved = [];
  const request = async (url, init) => {
    if (url.endsWith('public-key')) return Response.json({ publicKey: key });
    saved.push(JSON.parse(init.body));
    return Response.json({ enabled: true });
  };
  assert.equal(await checkPushSubscription(registration, 'device', signal, request), 'enabled');
  assert.equal(saved[0].subscription.endpoint, 'https://push.example/device');
  assert.equal(saved[0].deviceId, 'device');
});

test('absent subscriptions and expired or changed keys are distinct from network failures', async () => {
  const { registration, subscription, signal } = fixture();
  const request = async url => {
    assert.ok(url.endsWith('public-key'), 'invalid subscription must not be saved');
    return Response.json({ publicKey: key });
  };
  subscription.expirationTime = Date.now() - 1;
  assert.equal(await checkPushSubscription(registration, 'device', signal, request), 'renewal');
  subscription.expirationTime = null;
  subscription.options.applicationServerKey = new Uint8Array([4, 5, 6]).buffer;
  assert.equal(await checkPushSubscription(registration, 'device', signal, request), 'renewal');
  registration.pushManager.getSubscription = async () => null;
  assert.equal(await checkPushSubscription(registration, 'device', signal, async () => assert.fail('no subscription needs no request')), 'disabled');
});

test('cancelled checks cannot publish a misleading disabled or enabled result', async () => {
  const { registration } = fixture();
  const controller = new AbortController();
  const request = async () => { controller.abort(); throw controller.signal.reason; };
  await assert.rejects(checkPushSubscription(registration, 'device', controller.signal, request), { name: 'AbortError' });
});

test('a known provider-rejected endpoint requires explicit renewal without changing the local subscription', async () => {
  const { registration, signal } = fixture();
  const request = async url => url.endsWith('public-key') ? Response.json({ publicKey: key }) : Response.json({ error: '推送订阅无效' }, { status: 410 });
  assert.equal(await checkPushSubscription(registration, 'device', signal, request), 'renewal');
  assert.ok(await registration.pushManager.getSubscription(), 'checking must preserve the local subscription for explicit user repair');
});
