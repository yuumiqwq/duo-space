import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withLoadingTimeout } from '../app/loading-timeout.ts';
import { classroomEntryFonts, classroomEntryImages, loadClassroomImage, prepareClassroomAssets } from '../app/classroom-loading.ts';

test('entry assets exist and entry remains pending until font loading and image decoding finish', async () => {
  for (const resource of classroomEntryFonts) assert.equal((await readFile('public' + resource.url)).subarray(0,4).toString(), 'wOF2');
  for (const url of classroomEntryImages) assert.ok((await readFile('public' + url)).length);
  const original = { FontFace: globalThis.FontFace, Image: globalThis.Image, document: globalThis.document };
  let releaseFont, releaseImage, complete = false, failImage = true;
  const fontGate = new Promise(resolve => { releaseFont = resolve; });
  const imageGate = new Promise(resolve => { releaseImage = resolve; });
  globalThis.document = { fonts: { add() {} } };
  globalThis.FontFace = class { async load() { await fontGate; return this; } };
  globalThis.Image = class {
    naturalWidth = 20;
    set src(value) { if(value) queueMicrotask(() => { if (failImage) this.onerror(); else this.onload(); }); }
    async decode() { await imageGate; }
  };
  try {
    await assert.rejects(prepareClassroomAssets(), /图片/);
    failImage = false;
    const request = prepareClassroomAssets().then(() => { complete = true; });
    releaseFont(); await new Promise(resolve => setTimeout(resolve,5)); assert.equal(complete, false);
    releaseImage(); await request; assert.equal(complete, true);
    await prepareClassroomAssets();
  } finally { Object.assign(globalThis, original); }
});

test('a hung font times out and retry uses a fresh request', async () => {
  const original = { FontFace: globalThis.FontFace, document: globalThis.document };
  let calls = 0;
  globalThis.document = { fonts: { add() {} } };
  globalThis.FontFace = class { load() { return ++calls === 1 ? new Promise(() => {}) : Promise.resolve(this); } };
  try {
    const { loadFontResources } = await import('../app/device-fonts.ts?timeout-test');
    const resources = [{ family: 'Test', url: '/test.woff2', weight: '400' }];
    await assert.rejects(loadFontResources(resources, 5), /超时/);
    await loadFontResources(resources, 100); assert.equal(calls,2);
    await assert.rejects(withLoadingTimeout(new Promise(() => {}), 5), /超时/);
  } finally { Object.assign(globalThis, original); }
});

test('image decode failures can retry and a mounted scene redecodes the retained image', async () => {
  const original = globalThis.Image;
  let created = 0, decoded = 0;
  globalThis.Image = class {
    naturalWidth = 20;
    constructor() { created++; }
    set src(value) { if (value) queueMicrotask(() => this.onload()); }
    decode() { return ++decoded === 1 ? Promise.reject(new Error('decode failed')) : Promise.resolve(); }
  };
  try {
    await assert.rejects(loadClassroomImage('/decode-test.svg'), /decode failed/);
    await loadClassroomImage('/decode-test.svg');
    await loadClassroomImage('/decode-test.svg');
    assert.equal(created, 2, 'failed images are replaced; successful image objects are retained');
    assert.equal(decoded, 3, 'mounting can request a fresh decode even after preload');
  } finally { globalThis.Image = original; }
});
