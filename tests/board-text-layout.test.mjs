import test from 'node:test';
import assert from 'node:assert/strict';
import { fitBoardText, measureBoardText } from '../app/board-text-layout.mjs';
import { resizeTextGeometry } from '../app/board-text-geometry.ts';
import { normalizeBoardText } from '../app/board-state.ts';

const context = { font: '', measureText(value) { const size = parseFloat(this.font); return { width: Array.from(value).reduce((sum, char) => sum + (/[\x00-\x7f]/.test(char) ? .55 : 1), 0) * size, fontBoundingBoxAscent: size * .9, fontBoundingBoxDescent: size * .3, actualBoundingBoxDescent: size * .3 }; } };
const box = { text: 'test测试，你好呀！\n这是第二行文字', x: 100, y: 80, width: 400, height: 55, fontSize: 36, material: 'chalk-v1' };

test('compact auto-width text stays one line while typing and grows down for explicit line breaks', () => {
  const empty = fitBoardText(context, { ...box, text: '', width: 117, height: 51, autoWidth: true });
  assert.equal(empty.width, 117); assert.equal(empty.height, 51);
  const short = fitBoardText(context, { ...empty, text: '三个字' });
  assert.equal(short.width, empty.width); assert.equal(short.height, empty.height);
  const typed = fitBoardText(context, { ...short, text: '惊叹中恍惚中' });
  assert.ok(typed.width > empty.width); assert.equal(typed.height, empty.height);
  assert.equal(typed.fontSize, empty.fontSize); assert.equal(measureBoardText(context, typed).lines.length, 1);
  const multiline = fitBoardText(context, { ...typed, text: typed.text + '\n第二行' });
  assert.equal(multiline.width, typed.width); assert.ok(multiline.height > typed.height);
  assert.deepEqual(fitBoardText(context, multiline), multiline);
  assert.equal(fitBoardText(context, { ...multiline, text: '短' }).width, multiline.width);
});

test('auto width uses available space before wrapping while manual width keeps its chosen boundary', () => {
  const source = { ...box, text: '输入文字自动扩大文本框', x: 1050, width: 117, height: 51, autoWidth: true };
  const edge = fitBoardText(context, source);
  assert.equal(edge.width, 150); assert.equal(edge.x, source.x); assert.ok(edge.height > source.height);
  const manual = fitBoardText(context, { ...source, x: 100, width: 200, autoWidth: false });
  assert.equal(manual.width, 200); assert.ok(manual.height > source.height);
  const widened = fitBoardText(context, { ...manual, ...resizeTextGeometry(manual, 'e', 200, 0) });
  assert.equal(widened.width, 400); assert.equal(widened.fontSize, manual.fontSize);
  const typing = fitBoardText(context, { ...widened, text: source.text.repeat(3) });
  assert.equal(typing.width, 400); assert.ok(typing.height > widened.height);
});

test('automatic and manually chosen widths survive board normalization without changing old boxes', () => {
  const source = { ...box, id: 'text', color: '#f6f1dc', confirmed: true, updatedAt: 1, revision: 'r1' };
  for (const autoWidth of [true, false]) {
    const saved = normalizeBoardText(JSON.parse(JSON.stringify({ ...source, autoWidth })));
    assert.equal(saved.autoWidth, autoWidth);
    assert.equal(saved.width, source.width); assert.equal(saved.height, source.height);
  }
  assert.equal(normalizeBoardText(source).autoWidth, undefined);
  assert.equal(normalizeBoardText({ ...source, autoWidth: 'true' }).autoWidth, undefined);
});

test('text box grows for explicit and wrapped lines without changing font or wrapping width', () => {
  for (const text of [box.text, '连续输入的中文文字'.repeat(7), '第一行\n第二行\n']) {
    const fitted = fitBoardText(context, { ...box, text });
    const layout = measureBoardText(context, fitted);
    assert.equal(fitted.width, box.width); assert.equal(fitted.fontSize, box.fontSize);
    assert.ok(fitted.height > box.height);
    assert.ok(layout.padY + layout.baseline + (layout.lines.length - 1) * layout.lineHeight + box.fontSize * .3 <= fitted.height);
    assert.deepEqual(fitBoardText(context, fitted), fitted, 'repeated paints and reloads do not keep growing the box');
  }
});
test('horizontal glyph overflow grows width and bottom overflow moves the box within the board', () => {
  const fitted = fitBoardText(context, { ...box, x: 1120, y: 665, width: 80, fontSize: 96, text: '你\n好' });
  assert.ok(fitted.width > 80); assert.ok(fitted.x + fitted.width <= 1200); assert.ok(fitted.y + fitted.height <= 720);
  assert.equal(fitted.fontSize, 96);
});
test('narrowing a side reflows content and expands height instead of clipping it', () => {
  const fitted = fitBoardText(context, box);
  const narrow = fitBoardText(context, { ...fitted, ...resizeTextGeometry(fitted, 'e', -240, 0) });
  assert.equal(narrow.width, 160); assert.equal(narrow.fontSize, 36); assert.ok(narrow.height > fitted.height);
  const deleted = fitBoardText(context, { ...narrow, text: '短' });
  assert.equal(deleted.height, narrow.height, 'deleting text preserves the chosen box size');
});

test('long wrapped text expands sideways when it would exceed the board height', () => {
  const fitted = fitBoardText(context, { ...box, width: 80, fontSize: 64, text: '继续输入完整的文字'.repeat(8) });
  assert.ok(fitted.width > 80); assert.ok(fitted.height <= 720);
  assert.equal(fitted.fontSize, 64); assert.ok(fitted.y + fitted.height <= 720);
});
