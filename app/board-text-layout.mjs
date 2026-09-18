export const CHALK_FONT = '"Classroom Yan", "Long Cang", cursive';
export const BOARD_TEXT_PADDING_X = .12;
export const BOARD_TEXT_PADDING_Y = .08;
export const BOARD_TEXT_LINE_HEIGHT = 1.25;

/** @param {{fontSize:number, material?:string}} item */
export function boardTextFont(item) {
  return `${item.fontSize}px ${item.material === 'chalk-v1' ? CHALK_FONT : 'system-ui, sans-serif'}`;
}

/** @param {CanvasRenderingContext2D} ctx @param {{text:string, width:number, fontSize:number, material?:string}} item */
export function measureBoardText(ctx, item) {
  ctx.font = boardTextFont(item);
  const padX = item.fontSize * BOARD_TEXT_PADDING_X, padY = item.fontSize * BOARD_TEXT_PADDING_Y;
  const lineHeight = item.fontSize * BOARD_TEXT_LINE_HEIGHT;
  const metrics = ctx.measureText('Mg');
  const ascent = metrics.fontBoundingBoxAscent ?? item.fontSize * .8;
  const descent = metrics.fontBoundingBoxDescent ?? item.fontSize * .2;
  const baseline = (lineHeight - ascent - descent) / 2 + ascent;
  const lines = [];
  const available = Math.max(1, item.width - 2 * padX);
  for (const paragraph of item.text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    for (const character of paragraph.replace(/\t/g, '    ')) {
      const next = line + character;
      if (line && ctx.measureText(next).width > available) { lines.push(line); line = character; }
      else line = next;
    }
    lines.push(line);
  }
  // Include glyph ink bounds as well as line boxes, so a tall glyph is never cut in half.
  const bottom = Math.max(...lines.map((line, index) => baseline + index * lineHeight + (ctx.measureText(line).actualBoundingBoxDescent ?? descent)));
  return { font: ctx.font, padX, padY, lineHeight, baseline, lines, height: Math.ceil(2 * padY + Math.max(lines.length * lineHeight, bottom)) };
}

/**
 * New boxes grow horizontally until the board edge; a chosen wrapping width
 * and legacy boxes retain their width. Never shrink dimensions while typing.
 * @template {{text:string, x:number, y:number, width:number, height:number, fontSize:number, material?:string, autoWidth?:boolean}} T
 * @param {CanvasRenderingContext2D} ctx @param {T} item
 * @returns {T}
 */
export function fitBoardText(ctx, item) {
  ctx.font = boardTextFont(item);
  const widestGlyph = Math.max(0, ...Array.from(item.text, char => ctx.measureText(char).width));
  let width = Math.min(1200, Math.max(item.width, Math.ceil(widestGlyph + 2 * item.fontSize * BOARD_TEXT_PADDING_X)));
  if (item.autoWidth) {
    const longestLine = Math.max(...item.text.replace(/\r\n?/g, '\n').split('\n').map(line => ctx.measureText(line.replace(/\t/g, '    ')).width));
    const naturalWidth = Math.ceil(longestLine + 2 * item.fontSize * BOARD_TEXT_PADDING_X);
    width = Math.max(width, Math.min(naturalWidth, 1200 - item.x));
  }
  // When wrapping would exceed the whole board height, use horizontal space too.
  if (measureBoardText(ctx, { ...item, width }).height > 720 && width < 1200) {
    let low = Math.ceil(width), high = 1200;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (measureBoardText(ctx, { ...item, width: middle }).height > 720) low = middle + 1;
      else high = middle;
    }
    width = low;
  }
  const height = Math.max(item.height, measureBoardText(ctx, { ...item, width }).height);
  return { ...item, width, height, x: Math.max(0, Math.min(item.x, 1200 - width)), y: Math.max(0, Math.min(item.y, 720 - height)) };
}
