import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { prepareRenderedClassroom } from '../app/classroom-render-ready.ts';
import { loadClassroomImage } from '../app/classroom-loading.ts';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function browserFixture(t) {
  const saved = new Map();
  const replace = (key, value) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const requests = [], fontRequests = [], frames = new Map(), observers = [], gates = new Map();
  let sequence = 0;
  class Element {
    childNodes = [];
    styles = {};
    getClientRects() { return this.hidden ? [] : [{}]; }
  }
  class Image extends Element {
    naturalWidth = 20;
    decodes = 0;
    set src(value) { this.url = value; if (value) { requests.push(this); queueMicrotask(() => this.onload?.()); } }
    get src() { return this.url; }
    decode() { this.decodes++; return gates.get(this.src)?.promise || Promise.resolve(); }
  }
  replace('Image', Image); replace('HTMLImageElement', Image);
  replace('HTMLInputElement', class extends Element {}); replace('HTMLTextAreaElement', class extends Element {});
  replace('MutationObserver', class {
    constructor(notify) { this.notify = notify; observers.push(this); }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
  });
  const fontGate = deferred(), layoutGate = deferred();
  replace('document', { baseURI: 'https://classroom.test/', fonts: { load: (font, text) => { fontRequests.push({ font, text }); return fontGate.promise; }, ready: layoutGate.promise } });
  replace('getComputedStyle', (element, pseudo) => ({ fontStyle: 'normal', fontWeight: '400', fontSize: '32px', fontFamily: '"Classroom Yan", "Long Cang", cursive', ...element.styles[pseudo || 'self'] }));
  replace('requestAnimationFrame', callback => { frames.set(++sequence, callback); return sequence; });
  replace('cancelAnimationFrame', id => frames.delete(id));
  const children = [], root = new Element();
  root.querySelectorAll = () => children;
  return { root, children, Element, Image, requests, fontRequests, gates, fontGate, layoutGate, observers, frames,
    mutate() { observers.filter(item => item.active).forEach(item => item.notify()); },
    async frame() { const current = [...frames]; frames.clear(); for (const [, callback] of current) callback(); await tick(); },
  };
}

test('mounted entry waits for device backgrounds, chalk masks, actual text fonts and two render frames', async t => {
  const b = browserFixture(t), tablet = new b.Element(), laptop = new b.Element(), projector = new b.Element(), lettering = new b.Element();
  tablet.styles.self = { backgroundImage: 'url("/classroom/tablet-on.svg")' };
  laptop.styles.self = { backgroundImage: 'url("/classroom/laptop-off.svg")' };
  laptop.styles['::after'] = { backgroundImage: 'url("/classroom/mouse-white.svg")' };
  projector.styles.self = { backgroundImage: 'url("/classroom/projector-off.svg")' };
  lettering.styles.self = { maskImage: 'url("/classroom/chalk-grain.png")' };
  lettering.childNodes = [{ nodeType: 3, textContent: '中文 Aa' }];
  b.children.push(tablet, laptop, projector, lettering);
  const imageGate = deferred(); b.gates.set('https://classroom.test/classroom/tablet-on.svg', imageGate);
  let entered = false;
  const loading = prepareRenderedClassroom(b.root, new AbortController().signal).then(() => { entered = true; });
  await tick();
  assert.deepEqual(new Set(b.requests.map(item => new URL(item.src).pathname)), new Set(['/classroom/tablet-on.svg', '/classroom/laptop-off.svg', '/classroom/mouse-white.svg', '/classroom/projector-off.svg', '/classroom/chalk-grain.png']));
  assert.ok(b.fontRequests.some(item => item.text.includes('中文') && item.font.includes('Long Cang')));
  b.fontGate.resolve(); b.layoutGate.resolve(); await tick();
  assert.equal(entered, false, 'font completion cannot bypass the slow tablet image');
  imageGate.resolve(); await tick();
  assert.equal(entered, false, 'decoded resources still need a mounted rendering opportunity');
  await b.frame(); assert.equal(entered, false);
  await b.frame(); await loading; assert.equal(entered, true);
  assert.ok(b.observers.every(item => !item.active));
});

test('late scene changes are rescanned, including CSS pseudo-elements and lazy chat images', async t => {
  const b = browserFixture(t), text = new b.Element();
  text.childNodes = [{ nodeType: 3, textContent: '首批黑板文字' }]; b.children.push(text);
  b.fontGate.resolve(); b.layoutGate.resolve();
  let entered = false;
  const loading = prepareRenderedClassroom(b.root, new AbortController().signal).then(() => { entered = true; });
  await tick(); await b.frame();
  const late = new b.Element(); late.styles['::before'] = { backgroundImage: 'url("/classroom/newly-mounted.svg")' };
  const chat = new b.Image(); chat.src = '/chat.png'; chat.loading = 'lazy';
  const imageGate = deferred(); b.gates.set('/chat.png', imageGate);
  const closed = new b.Element(); closed.hidden = true; closed.styles.self = { backgroundImage: 'url("/closed-dialog.png")' };
  b.children.push(late, chat, closed); b.mutate();
  await b.frame(); await tick();
  assert.equal(entered, false); assert.equal(chat.loading, 'eager');
  assert.ok(b.requests.some(item => item.src.endsWith('/newly-mounted.svg')));
  assert.ok(!b.requests.some(item => item.src.endsWith('/closed-dialog.png')));
  imageGate.resolve(); await tick(); await b.frame(); await b.frame(); await loading;
  assert.equal(entered, true);
});

test('render preparation rechecks decoding even after a shared preload succeeded', async t => {
  const b = browserFixture(t), url = '/classroom/retained-device.svg';
  await loadClassroomImage(url);
  const image = b.requests[0], gate = deferred(); b.gates.set(image.src, gate);
  let decoded = false;
  const again = loadClassroomImage(url).then(() => { decoded = true; });
  await tick(); assert.equal(decoded, false); assert.equal(b.requests.length, 1); assert.equal(image.decodes, 2);
  gate.resolve(); await again;
});

test('font failure, timeout and leaving during a render frame never complete entry', async t => {
  const b = browserFixture(t), text = new b.Element(); text.childNodes = [{ nodeType: 3, textContent: '黑板' }]; b.children.push(text);
  const failed = prepareRenderedClassroom(b.root, new AbortController().signal);
  b.fontGate.reject(new Error('font unavailable')); await assert.rejects(failed, /font unavailable/);
  const fontRetry = deferred(); document.fonts.load = () => fontRetry.promise;
  const timedOut = prepareRenderedClassroom(b.root, new AbortController().signal, 5);
  await assert.rejects(Promise.race([timedOut, new Promise((_, reject) => { const id = setTimeout(() => reject(new Error('test timeout')), 100); timedOut.finally(() => clearTimeout(id)).catch(() => {}); })]), { name: 'TimeoutError' });
  fontRetry.resolve(); b.layoutGate.resolve();
  const controller = new AbortController(), cancelled = prepareRenderedClassroom(b.root, controller.signal);
  await tick(); assert.equal(b.frames.size, 1);
  controller.abort(); await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(b.frames.size, 0); assert.ok(b.observers.every(item => !item.active));
});

test('the entry hook waits for initial content and rejects completion from an abandoned preparation', async () => {
  const source = ts.createSourceFile('use-classroom-entry.ts', readFileSync('app/use-classroom-entry.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const hook = source.statements.find(node => ts.isFunctionDeclaration(node));
  const code = ts.transpileModule(hook.getText(source).replace('export ', '') + '\nreturn useClassroomEntry;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const pending = [], state = [false, '']; let effect, cleanup, cursor;
  const runEntry = new Function('useEffect', 'useRef', 'useState', 'prepareRenderedClassroom', code)(fn => { effect = fn; }, () => ({ current: {} }), initial => { const index = cursor++; return [state[index] ?? initial, value => { state[index] = value; }]; }, (root, signal) => { const gate = deferred(); pending.push({ ...gate, signal }); return gate.promise; });
  const render = contentReady => { cleanup?.(); cursor = 0; const value = runEntry(contentReady); cleanup = effect(); return value; };
  assert.equal(render(false).ready, false); assert.equal(pending.length, 0);
  assert.equal(render(true).ready, false); assert.equal(pending.length, 1);
  render(false); pending[0].resolve(); await tick(); assert.equal(state[0], false);
  render(true); pending[1].reject(new Error('decode failed')); await tick();
  assert.equal(state[0], false); assert.equal(state[1], 'decode failed');
  render(true); pending[2].resolve(); await tick(); assert.equal(state[0], true); cleanup?.();
});
