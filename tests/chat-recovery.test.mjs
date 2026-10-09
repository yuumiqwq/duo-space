import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createChatSyncRequest } from '../app/chat-sync-request.ts';

const source = ['app/room/model.ts', 'app/room/use-room-chat.ts'].map(file => readFileSync(file, 'utf8')).join('\n');
const tree = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) nodes.set(node.name.text, node);
  ts.forEachChild(node, visit);
}
visit(tree);
const selected = ['chatImageUrlPattern', 'normalizeChatAttachment', 'validChatContent', 'normalizeChatQuote', 'normalizeIncomingMessage', 'mergeChatMessages', 'loadInitialChat', 'syncLatestChatMessages'];
const code = ts.transpileModule(selected.map(name => `const ${nodes.get(name).getText(tree)};`).join('\n') + '\nreturn { loadInitialChat, syncLatestChatMessages, mergeChatMessages };', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const ref = current => ({ current });
const message = (id, createdAt) => ({ id, body: id, sender: 'Other', identityId: 'other', time: '12:00', createdAt });
function fixture(fetch) {
  const state = { messages: [], sounds: [], ready: false };
  const env = {
    fetch, disposed: false, useCallback: fn => fn,
    identityIdRef: ref('self'), chatSyncCursorRef: ref(0), chatHistoryInitializedRef: ref(false),
    chatSyncRequestRef: ref(createChatSyncRequest()), recalledChatIdsRef: ref(new Set()), outgoingChatRef: ref(new Map()),
    setMessages: fn => { state.messages = fn(state.messages); },
    playNotificationSound: id => state.sounds.push(id), setChatQuote() {},
    setChatHistoryLoading() {}, setChatHistoryReady: value => { state.ready = value; },
    setChatHistoryCursor: value => { state.historyCursor = value; }, setChatImageError() {},
  };
  return { state, env, actions: new Function(...Object.keys(env), code)(...Object.values(env)) };
}
test('initial history failure recovers the latest page silently before reading new changes', async () => {
  const requests = [], history = Array.from({ length: 30 }, (_, i) => message(`old-${i}`, 1000 + i));
  const f = fixture(async url => {
    requests.push(url);
    if (requests.length === 1) return { ok: false };
    if (!url.includes('since=')) return Response.json({ messages: history, nextCursor: '1000', cursor: 9000 });
    return Response.json({ messages: [message('new', 10000)], recalledIds: [], cursor: 10000 });
  });
  await f.actions.loadInitialChat();
  assert.equal(f.state.ready, true, 'chat failure must not block the room');
  await f.actions.syncLatestChatMessages();
  assert.equal(f.state.messages.length, 30);
  assert.equal(f.state.historyCursor, '1000');
  assert.deepEqual(f.state.sounds, []);
  await f.actions.syncLatestChatMessages();
  assert.deepEqual(f.state.sounds, ['new']);
  assert.ok(requests[2].includes('since=8000'));
});
test('a recall wins over late history and outgoing confirmations clear retry state', async () => {
  const own = { ...message('saved-own', 2000), identityId: 'self' };
  const f = fixture(async () => Response.json({ messages: [own], recalledIds: ['recalled'], cursor: 3000 }));
  f.env.chatHistoryInitializedRef.current = true;
  f.env.outgoingChatRef.current.set(own.id, {});
  f.state.messages = [{ ...own, delivery: 'failed' }, message('recalled', 1000)];
  await f.actions.syncLatestChatMessages();
  assert.equal(f.env.outgoingChatRef.current.size, 0);
  assert.equal(f.state.messages.length, 1);
  assert.equal(f.state.messages[0].delivery, undefined);
  const merged = f.actions.mergeChatMessages([message('recalled', 1000)], f.state.messages, f.env.recalledChatIdsRef.current);
  assert.equal(merged.length, 1);
  assert.deepEqual(f.state.sounds, []);
});
