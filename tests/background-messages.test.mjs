import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createChatSyncRequest } from '../app/chat-sync-request.ts';
import { startChatSyncLifecycle } from '../app/chat-sync-lifecycle.ts';
import { subscriptionNeedsRenewal } from '../app/push-subscription.ts';

test('expired and rotated-key subscriptions must be replaced while unchanged subscriptions are reused', () => {
  const subscription = { expirationTime: null, options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer } };
  assert.equal(subscriptionNeedsRenewal(subscription, 'AQID'), false);
  assert.equal(subscriptionNeedsRenewal(subscription, 'AQIE'), true);
  assert.equal(subscriptionNeedsRenewal({ ...subscription, expirationTime: Date.now() - 1 }, 'AQID'), true);
});

test('hidden desktop tabs keep fallback polling, push triggers a sync, and resume replaces suspended requests', () => {
  const document = new EventTarget(), window = new EventTarget(), worker = new EventTarget();
  document.visibilityState = 'visible';
  const timers = new Map(), calls = [];
  let nextId = 0, cancellations = 0;
  const stop = startChatSyncLifecycle({ document, window, worker,
    sync: async restart => { calls.push(restart); }, cancel: () => { cancellations++; },
    setTimer: (callback, delay) => { timers.set(++nextId, { callback, delay }); return nextId; },
    clearTimer: id => timers.delete(id),
  });
  assert.equal(calls.length, 1);
  assert.equal([...timers.values()][0].delay, 1500);
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal([...timers.values()][0].delay, 15_000);
  [...timers.values()][0].callback();
  assert.equal(calls.length, 2);
  worker.dispatchEvent(new MessageEvent('message', { data: { type: 'chat-updated' } }));
  assert.equal(calls.length, 3);
  document.dispatchEvent(new Event('freeze'));
  assert.equal(timers.size, 0);
  assert.equal(cancellations, 1);
  document.dispatchEvent(new Event('resume'));
  assert.equal(calls.at(-1), true);
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal([...timers.values()][0].delay, 1500);
  stop();
  const count = calls.length;
  window.dispatchEvent(new Event('online'));
  assert.equal(calls.length, count);
  assert.equal(timers.size, 0);
});

test('foreground recovery cancels a frozen fetch and stale completion cannot unlock its replacement', () => {
  const sync = createChatSyncRequest();
  const old = sync.begin();
  assert.equal(sync.begin(), null);
  const resumed = sync.begin(true);
  assert.equal(old.signal.aborted, true);
  assert.equal(old.isCurrent(), false);
  old.finish();
  assert.equal(sync.begin(), null);
  assert.equal(resumed.isCurrent(), true);
  resumed.finish();
  assert.ok(sync.begin());
  sync.cancel();
});

test('wall time releases a request even when the browser paused its active-time timeout', () => {
  const original = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const sync = createChatSyncRequest();
    const old = sync.begin();
    now += 60_000;
    assert.ok(sync.begin());
    assert.equal(old.signal.aborted, true);
    sync.cancel();
    assert.equal(old.isCurrent(), false);
  } finally { Date.now = original; }
});

test('background chat pushes display without a page or fetch, preserve different messages and deduplicate retries', async () => {
  const handlers = {}, shown = [], received = [];
  let windows = [];
  const self = {
    addEventListener: (name, handler) => { handlers[name] = handler; },
    clients: { matchAll: async () => windows },
    registration: {
      getNotifications: async ({ tag }) => shown.filter(item => item.tag === tag),
      showNotification: async (title, options) => shown.push({ title, ...options }),
    },
  };
  runInNewContext(await readFile('public/sw.js', 'utf8'), { self });
  const push = async messageId => {
    let done;
    handlers.push({ data: { json: () => ({ kind: 'chat', messageId, title: '新消息', body: messageId }) }, waitUntil: p => { done = p; } });
    await done;
  };
  await push('first');
  windows = [{ postMessage: data => received.push(data) }];
  await push('second');
  await push('second');
  assert.deepEqual(shown.map(item => item.tag), ['11scat-chat-first', '11scat-chat-second']);
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'chat-updated');
});

test('notification enumeration failure still displays a push and invalid click destinations stay on the site', async () => {
  const handlers = {}, shown = [], opened = [];
  const self = { location: { origin: 'https://study.example' },
    addEventListener: (name, handler) => { handlers[name] = handler; },
    clients: { matchAll: async () => [], openWindow: async url => opened.push(url) },
    registration: { getNotifications: async () => { throw Error('unavailable'); }, showNotification: async (title, options) => shown.push({ title, options }) },
  };
  runInNewContext(await readFile('public/sw.js', 'utf8'), { self, URL });
  let done;
  handlers.push({ data: { json: () => ({ kind: 'chat', messageId: 'one', url: '//other.example' }) }, waitUntil: p => { done = p; } });
  await done;
  assert.equal(shown.length, 1); assert.equal(shown[0].options.data.url, '/');
  handlers.notificationclick({ notification: { close() {}, data: { url: 'https://other.example' } }, waitUntil: p => { done = p; } });
  await done; assert.deepEqual(opened, ['https://study.example/']);
});

test('an existing browser subscription is restored on the server, and a rejected restore is not shown as enabled', async () => {
  const page = (await readFile('app/page.tsx', 'utf8')).replace(/\r\n/g, '\n');
  const start = page.indexOf('  useEffect(() => {\n    if (!("serviceWorker" in navigator)');
  const end = page.indexOf('\n  const enablePushNotifications', start);
  assert.ok(start > 0 && end > start);
  const listeners = {}, states = [], saved = [];
  let cleanup, ok = true;
  const context = {
    createChatSyncRequest, subscriptionNeedsRenewal, identityId: 'alice', pushBusy: false,
    pushDeviceIdRef: { current: '' },
    setPushEnabled: value => states.push(value), setPushMessage: () => {},
    useEffect: effect => { cleanup = effect(); },
    crypto: { randomUUID: () => 'device-1' },
    document: { visibilityState: 'visible', addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener: () => {} },
    window: { PushManager: {}, localStorage: { getItem: () => 'device-1', setItem: () => {} }, addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener: () => {} },
    navigator: { serviceWorker: { register: async () => ({ pushManager: { getSubscription: async () => ({ expirationTime: null, options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer }, toJSON: () => ({ endpoint: 'https://push.example/device-1' }) }) } }) } },
    fetch: async (url, options) => {
      if (url === '/api/push/public-key') return { ok: true, json: async () => ({ publicKey: 'AQID' }) };
      saved.push({ url, body: JSON.parse(options.body) }); return { ok, redirected: false };
    },
  };
  try {
    runInNewContext(page.slice(start, end), context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].url, '/api/push/subscriptions');
    assert.equal(saved[0].body.deviceId, 'device-1');
    assert.equal(states.at(-1), true);
    context.document.visibilityState = 'hidden';
    await listeners.visibilitychange();
    assert.equal(saved.length, 1);
    ok = false;
    context.document.visibilityState = 'visible';
    await listeners.visibilitychange();
    assert.equal(saved.length, 2);
    assert.equal(states.at(-1), false);
  } finally { cleanup?.(); }
});
