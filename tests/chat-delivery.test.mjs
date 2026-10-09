import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmChatDelivery } from '../app/chat-delivery.ts';

const payload = { id: 'confirmed-id', body: 'hello' };
const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
test('a saved message is confirmed by id when its send response is lost', async () => {
  const calls = [];
  const result = await confirmChatDelivery(payload, 'device', { request: async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') throw new TypeError('Failed to fetch');
    return response(200, { message: payload });
  }, wait: async () => assert.fail('confirmed delivery must not retry') });
  assert.deepEqual(result, { message: payload, recalled: false });
  assert.equal(calls.length, 2);
});
test('temporary failure retries the same message id and stops after success', async () => {
  const posted = [], waits = [];
  const result = await confirmChatDelivery(payload, 'device', { request: async (_url, options) => {
    if (options.method !== 'POST') return response(404, { message: null });
    posted.push(JSON.parse(options.body));
    return posted.length === 1 ? response(503, {}) : response(201, { message: payload });
  }, wait: async ms => { waits.push(ms); } });
  assert.equal(result.message.id, payload.id);
  assert.deepEqual(posted, [payload, payload]);
  assert.deepEqual(waits, [750]);
});
test('authorization and validation failures are not automatically retried', async () => {
  let calls = 0;
  await assert.rejects(confirmChatDelivery(payload, 'device', { request: async () => { calls++; return response(401, {}); } }));
  assert.equal(calls, 1);
});

test('a response for a different message cannot confirm this send', async () => {
  let posts = 0;
  const result = await confirmChatDelivery(payload, 'device', { request: async (_url, options) => {
    if (options.method === 'POST') posts++;
    return response(200, { message: posts < 2 ? { id: 'another-message' } : payload });
  }, wait: async () => {} });
  assert.equal(result.message.id, payload.id);
  assert.equal(posts, 2);
});
test('sync confirmation wins over a late failed send response', async () => {
  let confirmed = false;
  const result = await confirmChatDelivery(payload, 'device', { confirmed: () => confirmed,
    request: async () => { confirmed = true; throw new TypeError('connection closed'); } });
  assert.equal(result, null);
});
test('read-back preserves a recall and bounds retries when nothing can confirm delivery', async () => {
  const recalled = await confirmChatDelivery(payload, 'device', { request: async (_url, options) => {
    if (options.method === 'POST') throw Error('offline');
    return response(200, { message: { ...payload, recalled: true } });
  } });
  assert.equal(recalled.recalled, true);
  let posts = 0;
  await assert.rejects(confirmChatDelivery(payload, 'device', { request: async (_url, options) => {
    if (options.method === 'POST') posts++;
    throw Error('offline');
  }, wait: async () => {} }), /offline/);
  assert.equal(posts, 3);
});
