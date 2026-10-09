import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the page's real send, scroll and history handlers with controlled DOM geometry.
const source = ['app/room/model.ts', 'app/room/use-room-chat.ts', 'app/page.tsx'].map(file => readFileSync(file, 'utf8')).join('\n');
const tree = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['sendMessage', 'sendVoice', 'handleChatScroll', 'loadOlderChatMessages', 'scrollChatToBottom'];
const declarations = [], imageLoads = [];
let updateLayout;
function visit(node) {
  if (ts.isVariableDeclaration(node) && [...names, 'mergeChatMessages'].includes(node.name.getText(tree))) declarations.push(`const ${node.getText(tree)};`);
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'mergeChatMessages') declarations.push(node.getText(tree));
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useLayoutEffect' && node.arguments[0].getText(tree).includes('pendingHistoryScrollRef')) updateLayout = node.arguments[0].getText(tree);
  if (ts.isJsxAttribute(node) && node.name.getText(tree) === 'onLoad' && node.initializer?.getText(tree).includes('scrollChatToBottom')) imageLoads.push(node.initializer.expression.getText(tree));
  ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(declarations.length, names.length + 1);
assert.ok(updateLayout);
const code = ts.transpileModule(`${declarations.join('\n')}\nreturn {${names.join(',')}, updateLayout:${updateLayout}, imageLoads:[${imageLoads.join(',')}]};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture({ top = 200, height = 1000, clientHeight = 400 } = {}) {
  let actualTop = top, messages = [];
  const list = { scrollHeight: height, clientHeight,
    get scrollTop() { return actualTop; },
    set scrollTop(value) { actualTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, value)); },
    scrollTo({ top }) { this.scrollTop = top; },
  };
  const ref = current => ({ current });
  let respond;
  const response = new Promise(resolve => { respond = resolve; });
  const env = {
    useCallback: fn => fn, messageListRef: ref(list), chatAtBottomRef: ref(height - clientHeight - top <= 1),
    recalledChatIdsRef: ref(new Set()),
    chatSavedScrollTopRef: ref(top), chatImageViewerOpenRef: ref(false), pendingHistoryScrollRef: ref(null),
    outgoingChatRef: ref(new Map()), identityIdRef: ref('alice'), displayNameRef: ref('Alice'), displayName: 'Alice',
    chatQuote: null, chatDraft: 'new message', chatImage: null, chatHistoryLoading: false, chatHistoryCursor: 'older', sideView: 'chat',
    beijingTimeFormatter: { format: () => '12:00' }, deliverChat() {}, clearChatImage() {}, setChatDraft() {}, setChatQuote() {}, setChatImageError() {}, setChatHistoryLoading() {}, setChatHistoryCursor() {},
    setMessages: change => { messages = change(messages); }, normalizeIncomingMessage: message => message,
    fetch: () => response,
  };
  const api = new Function(...Object.keys(env), code)(...Object.values(env));
  const grow = amount => { list.scrollHeight += amount; api.updateLayout(); };
  return { api, list, env, grow, respond, receive() { env.setMessages(current => [...current, { id: 'peer-message' }]); } };
}

test('text, voice and received messages preserve a reading position, including near the bottom', () => {
  for (const top of [180, 590]) for (const kind of ['text', 'voice', 'received']) {
    const f = fixture({ top });
    f.api.handleChatScroll();
    if (kind === 'text') f.api.sendMessage({ preventDefault() {} });
    else if (kind === 'voice') f.api.sendVoice({ name: 'voice.webm' });
    else f.receive();
    f.grow(60);
    assert.equal(f.list.scrollTop, top, `${kind} must not interrupt reading`);
    assert.equal(f.env.chatAtBottomRef.current, false);
    f.list.scrollHeight += 160;
    f.api.imageLoads.forEach(load => load());
    assert.equal(f.list.scrollTop, top, 'late image loading also preserves the position');
  }
});

test('messages and late images follow the bottom only while the reader remains there', () => {
  for (const kind of ['text', 'voice', 'received']) {
    const f = fixture({ top: 600 });
    f.api.handleChatScroll();
    if (kind === 'text') f.api.sendMessage({ preventDefault() {} });
    else if (kind === 'voice') f.api.sendVoice({ name: 'voice.webm' });
    else f.receive();
    f.grow(60);
    assert.equal(f.list.scrollTop, 660);
    assert.equal(f.env.chatSavedScrollTopRef.current, 660, 'save the actual clamped scroll position');
    f.list.scrollHeight += 100;
    f.api.imageLoads.forEach(load => load());
    assert.equal(f.list.scrollTop, 760);
    f.list.scrollTop = 320; f.api.handleChatScroll(); f.grow(60);
    assert.equal(f.list.scrollTop, 320, 'scrolling up stops following immediately');
  }
});

test('a pending history request never treats newly appended messages as prepended history', async () => {
  const f = fixture({ top: 10 });
  const pending = f.api.loadOlderChatMessages();
  assert.equal(f.env.pendingHistoryScrollRef.current, null);
  f.receive(); f.grow(50);
  assert.equal(f.list.scrollTop, 10);
  f.list.scrollTop = 150; f.api.handleChatScroll();
  f.respond({ ok: true, json: async () => ({ messages: [{ id: 'old-message', createdAt: 1 }], nextCursor: null }) });
  await pending;
  f.grow(300);
  assert.equal(f.list.scrollTop, 450, 'retain the same messages on screen after prepending history');
  assert.equal(f.env.pendingHistoryScrollRef.current, null);
});
