import test from 'node:test';
import assert from 'node:assert/strict';
import webPush from 'web-push';
import { chatPushPayload, deliverChatNotification } from '../app/api/push/delivery.ts';

test('long Chinese, emoji and escaped text fit a push without modifying saved message content', () => {
  for (const body of ['中'.repeat(8000), '🎉'.repeat(4000), '\u0000'.repeat(8000)]) {
    const message = { id: 'test', sender: '人'.repeat(100), body };
    const payload = chatPushPayload(message);
    assert.ok(Buffer.byteLength(payload) < 3993);
    assert.equal(message.body, body);
    assert.equal(JSON.parse(payload).body.endsWith('…'), true);
  }
  assert.equal(JSON.parse(chatPushPayload({ sender: 'A', body: '', attachment: { kind: 'audio', name: 'voice.webm' } })).body, '发送了一条语音');
});

test('temporary failures retry, permanent rejection does not, and Retry-After is respected', async () => {
  const original = webPush.sendNotification;
  let attempts = 0;
  const delays = [];
  try {
    webPush.sendNotification = async () => { if (++attempts < 3) throw { statusCode: 503 }; return { statusCode: 201 }; };
    assert.equal((await deliverChatNotification({}, '{}', async delay => delays.push(delay))).statusCode, 201);
    assert.equal(attempts, 3); assert.deepEqual(delays, [500, 1000]);
    attempts = 0;
    webPush.sendNotification = async () => { attempts++; throw { statusCode: 410 }; };
    await assert.rejects(deliverChatNotification({}, '{}', async () => {}));
    assert.equal(attempts, 1);
    attempts = 0; delays.length = 0;
    webPush.sendNotification = async () => { if (++attempts < 2) throw { statusCode: 429, headers: { 'retry-after': '2' } }; return { statusCode: 201 }; };
    await deliverChatNotification({}, '{}', async delay => delays.push(delay));
    assert.deepEqual(delays, [2000]);
    attempts = 0;
    webPush.sendNotification = async () => { attempts++; throw { statusCode: 429, headers: { 'retry-after': '90' } }; };
    await assert.rejects(deliverChatNotification({}, '{}', async () => assert.fail('must not retry early')));
    assert.equal(attempts, 1);
  } finally { webPush.sendNotification = original; }
});
