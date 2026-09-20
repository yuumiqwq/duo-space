import test from 'node:test';
import assert from 'node:assert/strict';
import { boardPointerPoints, appendStrokePoints } from '../app/board-pointer.mjs';
import { strokePath, strokeContainsPoint } from '../app/board-stroke-path.mjs';
import { buildChalkOutline } from '../app/chalk-renderer.mjs';
import { normalizeBoard, normalizeBoardStroke, mergeBoard } from '../app/board-state.ts';
import { encodeRoomPackets, createPacketReceiver } from '../app/room-packets.ts';

const rect = { left: 20, top: 40, width: 600, height: 360 };
const point = (clientX, clientY) => ({ clientX, clientY });
const stroke = { id: 'curve', color: '#e0a7b5', width: 6, material: 'chalk-v1', tool: 'pen', path: 'smooth-v1', createdAt: 1, revision: 'r1', points: [] };

test('batched device samples retain their order, map to board coordinates and do not duplicate the dispatched point', () => {
  const event = { ...point(60, 80), getCoalescedEvents: () => [point(30, 50), point(45, 70), point(60, 80)] };
  assert.deepEqual(appendStrokePoints([{ x: 0, y: 0 }], boardPointerPoints(event, rect)), [
    { x: 0, y: 0 }, { x: 20, y: 20 }, { x: 50, y: 60 }, { x: 80, y: 80 },
  ]);
});

test('pointer collection falls back without coalesced support and clamps captured movement outside the board', () => {
  for (const support of [{}, { getCoalescedEvents: () => [] }, { getCoalescedEvents: () => { throw new Error('unavailable'); } }]) {
    assert.deepEqual(boardPointerPoints({ ...point(30, 50), ...support }, rect), [{ x: 20, y: 20 }]);
  }
  assert.deepEqual(boardPointerPoints(point(-1, 1000), rect), [{ x: 0, y: 720 }]);
  assert.deepEqual(boardPointerPoints(point(NaN, 0), rect), []);
  assert.deepEqual(boardPointerPoints(point(0, 0), { ...rect, width: 0 }), []);
  const previous = [{ x: 10, y: 10 }], endpoint = [{ x: 10.2, y: 10 }];
  assert.equal(appendStrokePoints(previous, endpoint), previous);
  assert.deepEqual(appendStrokePoints(previous, endpoint, true).at(-1), endpoint[0]);
});

function largestTurn(points) {
  let maximum = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    const first = Math.hypot(b.x - a.x, b.y - a.y), second = Math.hypot(c.x - b.x, c.y - b.y);
    if (first < .01 || second < .01) continue;
    maximum = Math.max(maximum, Math.acos(Math.max(-1, Math.min(1, ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (first * second)))));
  }
  return maximum;
}

test('sparse loops have gradual direction changes, keep endpoints and stay inside the sampled shape', () => {
  const points = Array.from({ length: 13 }, (_, i) => ({ x: 400 + 180 * Math.cos(i * Math.PI / 6), y: 300 + 180 * Math.sin(i * Math.PI / 6) }));
  const smooth = buildChalkOutline({ ...stroke, points }).points;
  const old = buildChalkOutline({ ...stroke, path: undefined, points }).points;
  assert.deepEqual(smooth[0], points[0]);
  assert.deepEqual(smooth.at(-1), points.at(-1));
  assert.ok(largestTurn(smooth) < largestTurn(old) / 3);
  assert.ok(smooth.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.hypot(p.x - 400, p.y - 300) <= 180.0001));
  const triangle = strokePath({ ...stroke, points: [{ x: 0, y: 0 }, { x: 1200, y: 0 }, { x: 0, y: 720 }] });
  assert.ok(triangle.every(p => p.x >= 0 && p.y >= 0 && p.x / 1200 + p.y / 720 <= 1.000001));
});

test('dots, straight lines, duplicate samples and reversals stay finite; old geometry is preserved', () => {
  for (const points of [[], [{ x: 10, y: 20 }], [{ x: 10, y: 20 }, { x: 90, y: 20 }]]) {
    assert.deepEqual(strokePath({ ...stroke, points }), points);
  }
  const points = [{ x: 10, y: 20 }, { x: 10, y: 20 }, { x: 90, y: 20 }, { x: 10, y: 20 }];
  assert.ok(strokePath({ ...stroke, points }).every(p => Number.isFinite(p.x) && p.x >= 10 && p.x <= 90 && p.y === 20));
  assert.deepEqual(strokePath({ points }), points);
  assert.deepEqual(strokePath({ ...stroke, points: [{ x: NaN, y: 0 }, { x: 10, y: 20 }] }), [{ x: 10, y: 20 }]);
  assert.equal(normalizeBoardStroke({ ...stroke, path: 'unknown' }).path, undefined);
});

test('whole-stroke erasure hits visible curves and the middle of a sparse straight segment', () => {
  assert.equal(strokeContainsPoint({ ...stroke, points: [{ x: 10, y: 10 }, { x: 300, y: 10 }] }, { x: 150, y: 10 }, 14), true);
  const curve = { ...stroke, points: [{ x: 0, y: 100 }, { x: 100, y: 0 }, { x: 200, y: 100 }] };
  assert.equal(strokeContainsPoint(curve, { x: 100, y: 25 }, 2), true);
  assert.equal(strokeContainsPoint(curve, { x: 100, y: 0 }, 14), false);
});

test('curve metadata and geometry survive fragmented packets, normalization and snapshot merge', () => {
  const points = Array.from({ length: 3000 }, (_, i) => ({ x: 600 + 200 * Math.cos(i / 50), y: 300 + 200 * Math.sin(i / 50) }));
  const board = { id: crypto.randomUUID(), name: '画板', strokes: [{ ...stroke, points }], texts: [], deletedStrokeIds: [], deletedTextIds: [], epoch: '0000000000000:initial', createdAt: 1 };
  const packets = encodeRoomPackets({ type: 'board-snapshot', boards: [board] });
  assert.ok(packets.length > 1);
  const receive = createPacketReceiver(); let decoded;
  for (const packet of packets.reverse()) decoded = receive(packet) || decoded;
  const replay = mergeBoard({ ...board, strokes: [] }, normalizeBoard(decoded.boards[0]));
  assert.equal(replay.strokes[0].path, 'smooth-v1');
  assert.deepEqual(buildChalkOutline(replay.strokes[0]), buildChalkOutline(board.strokes[0]));
});
