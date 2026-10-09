export const MAX_BOARD_STROKES = 2000;
export const MAX_STROKE_POINTS = 10000;
export const MAX_BOARD_TEXTS = 200;
export const MAX_BOARD_TEXT_LENGTH = 4000;
// Twelve complete boards still fit the existing 12,288,000-byte transport.
export const MAX_BOARD_BYTES = 750_000;
export const BOARD_CAPACITY_NOTICE = '画板同步数据过大，请保存后新建画板。';
export class BoardCapacityError extends Error {}

export function assertBoardCapacity(board: { strokes: { points: unknown[] }[]; texts?: { text: string }[] }) {
  if (board.strokes.length > MAX_BOARD_STROKES
    || board.strokes.some(stroke => stroke.points.length > MAX_STROKE_POINTS)
    || (board.texts?.length ?? 0) > MAX_BOARD_TEXTS
    || board.texts?.some(text => text.text.length > MAX_BOARD_TEXT_LENGTH)
    || new TextEncoder().encode(JSON.stringify(board)).length > MAX_BOARD_BYTES) throw new BoardCapacityError();
}
