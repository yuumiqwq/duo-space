import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createRoomPresence } from '../app/room/room-presence.ts';

const participant = (overrides = {}) => ({ peerId: 'remote-peer', deviceId: 'remote-tab', identityId: 'bob', name: '同桌', expiresAt: 60_000, ...overrides });
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function clock() {
  let time = 0, sequence = 0;
  const jobs = new Map();
  return {
    now: () => time,
    setTimer: (callback, delay) => { const id = ++sequence; jobs.set(id, { callback, at: time + delay }); return id; },
    clearTimer: id => jobs.delete(id),
    advance(next) {
      time = next;
      while (true) {
        const job = [...jobs.entries()].find(([, item]) => item.at <= time);
        if (!job) break;
        jobs.delete(job[0]); job[1].callback();
      }
    },
    jobs,
  };
}

function fixture(request, extra = {}) {
  const timer = clock(), changes = [], calls = [];
  const session = createRoomPresence({
    deviceId: 'local-tab', mobile: false, peerId: () => '', name: () => '自己',
    changed: next => changes.push(next), now: timer.now, setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    request: async (url, options) => {
      calls.push({ url, ...options, body: JSON.parse(options.body) });
      return request(url, options);
    },
    ...extra,
  });
  return { session, timer, changes, calls };
}

test('server membership works before PeerJS has an identity or any data connection', async () => {
  const f = fixture(async () => Response.json({ participants: [participant({ peerId: '' })] }));
  const members = await f.session.sync();
  assert.equal(f.calls[0].body.peerId, '');
  assert.equal(f.calls[0].body.deviceId, 'local-tab');
  assert.equal(members[0].identityId, 'bob');
  assert.equal(f.changes.at(-1)[0].identityId, 'bob');
  f.session.close(false);
});

test('five-second polls share a slow successful response without invalidating membership', async () => {
  const response = deferred();
  const f = fixture(() => response.promise);
  const first = f.session.sync(); await flush();
  f.timer.advance(5000);
  const second = f.session.sync();
  assert.equal(second, first);
  assert.equal(f.calls.length, 1);
  f.timer.advance(6000);
  response.resolve(Response.json({ participants: [participant()] }));
  assert.equal((await second)[0].identityId, 'bob');
  assert.equal(f.changes.length, 1);
  f.session.close(false);
});

test('a fresh server snapshot removes members who left and preserves replacement tab identities', async () => {
  let snapshot = [participant()];
  const f = fixture(async () => Response.json({ participants: snapshot }));
  await f.session.sync();
  snapshot = [participant({ peerId: 'replacement-peer' })];
  const replacement = await f.session.sync();
  assert.deepEqual(replacement.map(item => item.peerId), ['replacement-peer']);
  snapshot = [];
  assert.deepEqual(await f.session.sync(), []);
  assert.deepEqual(f.changes.at(-1), []);
  f.session.close(false);
});

test('network failures expire desktop leases while retaining the existing thirty-minute mobile lease', async () => {
  let fail = false;
  const f = fixture(async () => {
    if (fail) throw new TypeError('offline');
    return Response.json({ participants: [participant(), participant({ deviceId: 'mobile-tab', peerId: 'mobile-peer', identityId: 'carol', expiresAt: 30 * 60_000 })] });
  });
  await f.session.sync(); fail = true;
  f.timer.advance(30_000);
  assert.equal((await f.session.sync()).length, 2);
  f.timer.advance(60_001);
  assert.deepEqual(f.changes.at(-1).map(item => item.identityId), ['carol']);
  f.timer.advance(30 * 60_000 + 1);
  assert.deepEqual(f.changes.at(-1), []);
  assert.deepEqual(await f.session.sync(), []);
  f.session.close(false);
});

test('a cancelled older response cannot restore a member after a foreground refresh removes them', async () => {
  const old = deferred(), fresh = deferred(); let request = 0;
  const f = fixture(() => ++request === 1 ? old.promise : fresh.promise);
  const oldSync = f.session.sync(); await flush();
  const newSync = f.session.sync(false, true); await flush();
  assert.equal(f.calls[0].signal.aborted, true);
  fresh.resolve(Response.json({ participants: [] })); await newSync;
  old.resolve(Response.json({ participants: [participant()] })); await oldSync;
  assert.deepEqual(f.changes, [[]]);
  f.session.close(false);
});

test('a signalling identity change is registered after the pending request completes', async () => {
  const response = deferred(); let peer = '';
  const f = fixture((_url, options) => JSON.parse(options.body).peerId ? Promise.resolve(Response.json({ participants: [] })) : response.promise, { peerId: () => peer });
  const initial = f.session.sync(); await flush();
  peer = 'opened-peer'; f.session.sync();
  response.resolve(Response.json({ participants: [] })); await initial; await flush();
  assert.deepEqual(f.calls.map(item => item.body.peerId), ['', 'opened-peer']);
  f.session.close(false);
});

test('explicit leave cancels pending state, deletes only its own tab, and stops expiration timers', async () => {
  const response = deferred();
  const f = fixture((_url, options) => options.method === 'DELETE' ? Promise.resolve(new Response(null, { status: 204 })) : response.promise);
  const pending = f.session.sync(); await flush();
  f.session.close(true); await flush();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.deepEqual(f.calls.find(item => item.method === 'DELETE').body, { deviceId: 'local-tab' });
  response.resolve(Response.json({ participants: [participant()] })); await pending;
  assert.deepEqual(f.changes, []);
  assert.equal(f.timer.jobs.size, 0);
  assert.deepEqual(await f.session.sync(), []);
});

test('a mobile background heartbeat keeps its lease and an ordinary background disposal sends no leave', async () => {
  const f = fixture(async () => Response.json({ participants: [] }), { mobile: true });
  await f.session.sync(true);
  assert.equal(f.calls[0].body.mobile, true);
  assert.equal(f.calls[0].body.background, true);
  assert.equal(f.calls[0].keepalive, true);
  f.session.close(false); await flush();
  assert.ok(f.calls.every(item => item.method === 'POST'));
});

test('the actual presence hook starts and resumes HTTP heartbeat while signalling is unavailable', async () => {
  const timer = clock(), effects = [], states = [], calls = [], intervals = new Map();
  const win = new EventTarget(), doc = new EventTarget(); doc.hidden = false;
  let sequence = 1000;
  Object.assign(win, {
    setTimeout: timer.setTimer, clearTimeout: timer.clearTimer,
    setInterval: callback => { const id = ++sequence; intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id),
  });
  const react = {
    useCallback: callback => callback, useRef: value => ({ current: value }),
    useState: value => [value, next => states.push(next)], useEffect: callback => effects.push(callback),
  };
  const presence = {
    createRoomPresence: options => createRoomPresence({ ...options, now: timer.now, request: async (_url, options) => {
      calls.push({ ...options, body: JSON.parse(options.body) });
      return options.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ participants: [participant({ peerId: '' })] });
    } }),
  };
  const compiled = ts.transpileModule(readFileSync('app/room/use-room-presence.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  runInNewContext(compiled, {
    exports, window: win, document: doc, crypto,
    require: id => id === 'react' ? react : id === './model' ? { isMobileBrowser: () => false } : presence,
  });
  const room = exports.useRoomPresence({ joined: true, selfPeerIdRef: { current: '' }, displayNameRef: { current: '自己' }, intentionalLeaveRef: { current: false } });
  const dispose = effects[0](); await flush();
  assert.equal(calls[0].body.peerId, '');
  assert.equal(states.at(-1)[0].identityId, 'bob');
  assert.ok(room.deviceIdRef.current);
  for (const callback of intervals.values()) callback(); await flush();
  assert.equal(calls.filter(item => item.method === 'POST').length, 2);
  win.dispatchEvent(new Event('focus')); await flush();
  assert.equal(calls.filter(item => item.method === 'POST').length, 3);
  dispose(); await flush();
  assert.equal(intervals.size, 0);
  assert.equal(calls.filter(item => item.method === 'DELETE').length, 1);
});

function peerFunction(start, end, environment, result) {
  const source = readFileSync('app/room/use-peer-room.ts', 'utf8');
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  const js = ts.transpileModule(source.slice(first, last), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(environment), js + '\nreturn ' + result)(...Object.values(environment));
}

test('the actual peer discovery asks for HTTP membership before requiring an open signalling peer', async () => {
  let heartbeats = 0;
  const sync = peerFunction('    const syncRoomPresence =', '    const startMediaHeartbeat', {
    disposed: false, document: { visibilityState: 'visible' }, localPeer: null, localDeviceId: 'local-tab',
    syncPresence: async () => { heartbeats++; return [participant()]; },
  }, 'syncRoomPresence');
  await sync();
  assert.equal(heartbeats, 1);
});

test('the actual media heartbeat asks for membership even when a closed data channel throws', () => {
  let heartbeats = 0, tick;
  const start = peerFunction('    const startMediaHeartbeat =', '    const rememberPeerName', {
    mediaHeartbeatTimer: null,
    window: { clearInterval() {}, setInterval: callback => { tick = callback; return 1; } },
    syncRoomPresence: () => { heartbeats++; return Promise.resolve(); }, recoverRoomConnection() {},
    mediaRecovery: { flush() {} }, incomingRecovery: { flush() {} },
    connections: new Map([['remote', { open: true, send() { throw new Error('channel closed during send'); } }]]),
    incomingCalls: new Map(), cameraStreamRef: { current: null }, screenStreamRef: { current: null }, microphoneStreamRef: { current: null },
  }, 'startMediaHeartbeat');
  start(); assert.equal(heartbeats, 1);
  assert.throws(() => tick(), /channel closed during send/);
  assert.equal(heartbeats, 2);
});
