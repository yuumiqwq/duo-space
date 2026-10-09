import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as state from '../app/board-state.ts';
import * as limits from '../app/board-limits.ts';
import { orderClassroomBoards, replaceClassroomBoards } from '../app/classroom-boards.ts';
import { appendStrokePoints, boardPointerPoints } from '../app/board-pointer.mjs';
import { encodeRoomPackets, createPacketReceiver } from '../app/room-packets.ts';

const page = readFileSync('app/page.tsx', 'utf8').replaceAll('\r\n', '\n');
function extract(source, start, end, env, result) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first);
  const js = ts.transpileModule(source.slice(first, last), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), js + '\nreturn ' + result)(...Object.values(env));
}
const board = (id = 1, createdAt = id) => ({ id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, name: 'board', createdAt,
  epoch: state.INITIAL_BOARD_EPOCH, strokes: [], texts: [], deletedStrokeIds: [], deletedTextIds: [] });
const stroke = (id, count = 1) => ({ id: String(id), createdAt: 1, revision: '0001', width: 6, color: '#f6f1dc',
  points: Array.from({ length: count }, (_, i) => ({ x: i % 1200, y: i % 720 })) });
function client(boards, activeBoardId = '') {
  const boardsRef = { current: boards }, notices = [], sent = [];
  let selection = { boards, activeBoardId };
  const env = { ...state, ...limits, applyBoardText: state.upsertBoardText, orderClassroomBoards, boardsRef,
    useCallback: fn => fn, deletedBoardIdsRef: { current: new Set() }, packetReceiverRef: { current: createPacketReceiver() },
    setBoardNotice: value => notices.push(value), setBoards: next => { selection = replaceClassroomBoards(selection, next); },
    broadcastRoomMessage: message => sent.push(message),
  };
  delete env.upsertBoardText;
  env.updateBoards = extract(page, '  const updateBoards = useCallback', '  const refreshDeletedBoards', env, 'updateBoards');
  return {
    boardsRef, notices, sent, selection: () => selection,
    receive: extract(page, '  const receiveBoardMessage = useCallback', '\n\n  useEffect(() => {', env, 'receiveBoardMessage'),
    add: extract(page, '  const addBoardStroke =', '  const deleteBoardStroke =', env, 'addBoardStroke'),
    text: extract(page, '  const upsertBoardText =', '  const deleteBoardText =', env, 'upsertBoardText'),
  };
}

test('production local and remote stroke admission accept exactly the same complete 2000 strokes', () => {
  const initial = { ...board(), strokes: Array.from({ length: 1999 }, (_, i) => stroke(i)) };
  const local = client([initial]), remote = client([initial]);
  assert.equal(local.add(initial.id, stroke('last'), initial.epoch), true);
  remote.receive(local.sent.at(-1));
  assert.deepEqual(remote.boardsRef.current, local.boardsRef.current);
  assert.deepEqual(state.normalizeBoard(local.boardsRef.current[0]), local.boardsRef.current[0]);
  const accepted = local.boardsRef.current;
  assert.equal(local.add(initial.id, stroke('overflow'), initial.epoch), false);
  assert.deepEqual(local.boardsRef.current, accepted);
  remote.receive({ type: 'board-stroke-add', boardId: initial.id, stroke: stroke('overflow'), epoch: initial.epoch });
  assert.deepEqual(remote.boardsRef.current, accepted);
  assert.equal(local.sent.length, 1); assert.equal(local.notices.at(-1), limits.BOARD_CAPACITY_NOTICE);
  assert.equal(remote.notices.at(-1), limits.BOARD_CAPACITY_NOTICE);
  const updated = { ...stroke('last'), points: [{ x: 12, y: 13 }], revision: '0002' };
  assert.equal(local.add(initial.id, updated, initial.epoch), true);
  remote.receive(local.sent.at(-1)); assert.deepEqual(remote.boardsRef.current, local.boardsRef.current);
});

test('long strokes round-trip without truncation; overlong strokes are rejected before local acceptance', () => {
  const initial = board(), local = client([initial]), remote = client([initial]);
  const complete = stroke('long', limits.MAX_STROKE_POINTS);
  assert.equal(local.add(initial.id, complete, initial.epoch), true);
  const packets = encodeRoomPackets({ type: 'board-snapshot', boards: local.boardsRef.current });
  for (const packet of packets.reverse()) remote.receive(packet);
  assert.deepEqual(remote.boardsRef.current, local.boardsRef.current);
  const accepted = local.boardsRef.current;
  assert.equal(local.add(initial.id, { ...stroke('long', limits.MAX_STROKE_POINTS + 1), revision: '0002' }, initial.epoch), false);
  assert.deepEqual(local.boardsRef.current, accepted);
  assert.equal(state.normalizeBoardStroke(stroke('long', limits.MAX_STROKE_POINTS + 1)), null);
  assert.equal(state.normalizeBoard({ ...initial, strokes: Array.from({ length: 2001 }, (_, i) => stroke(i)) }), null);
});

test('Whiteboard does not render or broadcast unaccepted samples and retains the last accepted endpoint', () => {
  const initial = board(), local = client([initial]);
  const accepted = stroke('long', limits.MAX_STROKE_POINTS);
  local.add(initial.id, accepted, initial.epoch);
  const draftRef = { current: accepted }, visible = [], saved = [];
  const env = { ...limits, board: local.boardsRef.current[0], draftRef, draftEpochRef: { current: initial.epoch },
    activePointerRef: { current: 1 }, lastStrokeBroadcastRef: { current: 0 }, erasedDuringGestureRef: { current: new Set() },
    appendStrokePoints, boardPointerPoints, tool: 'pen', makeBoardRevision: () => '9999',
    setDraft: value => visible.push(value), onSaved: (...args) => saved.push(args),
    onAddStroke: (...args) => local.add(initial.id, ...args),
  };
  const source = readFileSync('app/Whiteboard.tsx', 'utf8').replaceAll('\r\n', '\n');
  const handlers = extract(source, '  const acceptStroke =', '  const updateText =', env, '{ continueStroke, finishStroke }');
  const event = { pointerId: 1, timeStamp: 100, nativeEvent: { clientX: 900, clientY: 500 },
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 720 }), hasPointerCapture: () => false } };
  handlers.continueStroke(event);
  assert.equal(draftRef.current, accepted); assert.deepEqual(visible, []);
  assert.equal(saved.at(-1)[0], limits.BOARD_CAPACITY_NOTICE);
  handlers.finishStroke({ ...event, type: 'pointerup' });
  assert.equal(draftRef.current, null); assert.equal(local.boardsRef.current[0].strokes[0].points.length, 10000);
  assert.deepEqual(local.boardsRef.current[0].strokes[0].points.at(-1), accepted.points.at(-1));
});

test('full text capacity rejects additions without removing accepted text and existing text remains editable', () => {
  const text = i => ({ id: String(i), text: '字', x: 0, y: 0, width: 80, height: 40, color: '#f6f1dc', fontSize: 20,
    updatedAt: 1, revision: '0001', confirmed: true });
  const initial = { ...board(), texts: Array.from({ length: 200 }, (_, i) => text(i)) }, local = client([initial]);
  assert.equal(local.text(initial.id, text(200), initial.epoch), false);
  assert.deepEqual(local.boardsRef.current[0].texts, initial.texts);
  assert.equal(local.text(initial.id, { ...text(199), text: '更新', revision: '0002' }, initial.epoch), true);
  assert.equal(local.boardsRef.current[0].texts.length, 200);
  assert.equal(state.normalizeBoardText({ ...text(1), text: '字'.repeat(4001) }), null);
});

test('capacity conflicts preserve the entire accepted local board and expose the existing notice', () => {
  const common = { ...board(), strokes: Array.from({ length: 1999 }, (_, i) => stroke(i)) };
  const local = client([{ ...common, strokes: [...common.strokes, stroke('local')] }]);
  const previous = local.boardsRef.current;
  local.receive({ type: 'board-snapshot', boards: [{ ...common, strokes: [...common.strokes, stroke('remote')] }] });
  assert.deepEqual(local.boardsRef.current, previous);
  assert.equal(local.notices.at(-1), limits.BOARD_CAPACITY_NOTICE);
  assert.equal(state.normalizeBoard(previous[0]).strokes.length, 2000);
  local.receive({ type: 'board-snapshot', boards: [{ ...common, strokes: [...common.strokes, stroke('remote')] }, board(2)] });
  assert.equal(local.boardsRef.current[0], previous[0]);
  assert.equal(local.boardsRef.current[1].id, board(2).id, 'one full board cannot block other boards');
  const oversized = { ...board(), strokes: Array.from({ length: 5 }, (_, i) => stroke(i, 10000)) };
  assert.throws(() => limits.assertBoardCapacity(oversized), limits.BoardCapacityError);
  assert.equal(state.normalizeBoard(oversized), null);
});

test('last-board races converge for both create events and snapshots, including selected-board fallback', () => {
  for (const firstMessage of ['board-create', 'board-upsert', 'board-snapshot']) {
    const common = Array.from({ length: 11 }, (_, i) => board(i + 1));
    const winner = board(12, 12), loser = board(13, 12);
    const left = client([...common, winner], winner.id), right = client([...common, loser], loser.id);
    left.receive(firstMessage === 'board-snapshot' ? { type: firstMessage, boards: [loser] } : { type: firstMessage, board: loser });
    right.receive(firstMessage === 'board-snapshot' ? { type: firstMessage, boards: [winner] } : { type: firstMessage, board: winner });
    for (let i = 0; i < 3; i++) {
      const a = left.boardsRef.current, b = right.boardsRef.current;
      left.receive({ type: 'board-snapshot', boards: b.toReversed() }); right.receive({ type: 'board-snapshot', boards: a });
    }
    assert.deepEqual(left.boardsRef.current, right.boardsRef.current);
    assert.equal(right.boardsRef.current.length, 12);
    assert.equal(left.selection().activeBoardId, winner.id);
    assert.equal(right.selection().activeBoardId, common.at(-1).id);
    assert.equal(right.add(loser.id, stroke('late'), loser.epoch), false);
    assert.ok(right.notices.length > 0);
  }
});
