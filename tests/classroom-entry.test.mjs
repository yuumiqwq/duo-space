import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClassroomPublicTasks, prepareClassroomFrame } from '../app/classroom-entry.ts';

test('the initial blackboard distinguishes an empty board from an unavailable or invalid response', async () => {
  const requests = [];
  const read = value => loadClassroomPublicTasks(async (url, options) => {
    requests.push(url);
    assert.equal(options.cache, 'no-store');
    return Response.json(value);
  });
  assert.deepEqual(await read({ buffer: [] }), []);
  assert.deepEqual(await read({ buffer: [{ id: 'a', title: '中文 task', ownerId: null }] }), [{ id: 'a', title: '中文 task' }]);
  await assert.rejects(read({ error: 'unavailable' }), /invalid response/);
  await assert.rejects(read({ buffer: [{ title: 'missing ID' }] }), /invalid response/);
  await assert.rejects(loadClassroomPublicTasks(async () => new Response('', { status: 503 })), /could not be loaded/);
  assert.ok(requests.every(url => url === '/api/room/tasks?local=1'));
});

test('mounted scene waits for critical decode and selected text faces, then two layout frames; unrelated font work is excluded', async () => {
  const names = ['Image', 'HTMLTextAreaElement', 'document', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const decode = deferred(), fonts = deferred(), frames = new Map(), requestedFonts = [];
  let sequence = 0, finished = false;
  const flush = () => new Promise(resolve => setImmediate(resolve));
  globalThis.Image = class {
    naturalWidth = 100;
    set src(value) { if (value) queueMicrotask(() => this.onload()); }
    decode() { return decode.promise; }
  };
  globalThis.HTMLTextAreaElement = class {};
  globalThis.document = { fonts: {
    load: (font, text) => { requestedFonts.push({ font, text }); return fonts.promise; },
    get ready() { throw new Error('The whole font set may include unrelated dialog downloads'); },
  } };
  globalThis.getComputedStyle = () => ({ fontStyle: 'normal', fontWeight: '400', fontSize: '32px', fontFamily: '"Classroom Yan", cursive' });
  globalThis.requestAnimationFrame = callback => { const id = ++sequence; frames.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const root = { querySelectorAll: () => [{ textContent: '黑板任务' }] };
  const nextFrame = async () => { const [id, callback] = frames.entries().next().value; frames.delete(id); callback(); await flush(); };
  try {
    const controller = new AbortController();
    const pending = prepareClassroomFrame(root, controller.signal).then(() => { finished = true; });
    fonts.resolve([]); await flush();
    assert.equal(finished, false); assert.equal(frames.size, 0);
    decode.resolve(); await flush();
    assert.equal(finished, false); assert.equal(frames.size, 1);
    await nextFrame(); assert.equal(finished, false);
    await nextFrame(); await pending; assert.equal(finished, true);
    assert.equal(requestedFonts[0].text, '黑板任务');

    const cancelled = new AbortController();
    const abandoned = prepareClassroomFrame(root, cancelled.signal);
    await flush(); cancelled.abort(new Error('left room'));
    await assert.rejects(abandoned, /left room/);
    assert.equal(frames.size, 0);
  } finally { Object.assign(globalThis, previous); }
});
