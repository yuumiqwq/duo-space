import test from 'node:test';
import assert from 'node:assert/strict';
import { showCollaborationDialog } from '../app/collaboration-dialog.ts';

test('opening an error from the closed task board opens the board first and leaves details interactive', () => {
  const stack = [];
  const dialog = (name, parent) => ({ open: false, parentElement: { closest: () => parent }, showModal() { assert.equal(this.open, false); this.open = true; stack.push(name); } });
  const board = dialog('board', null), detail = dialog('detail', board);
  // React runs the newly mounted child effect before the parent's effect.
  showCollaborationDialog(detail); showCollaborationDialog(board);
  assert.deepEqual(stack, ['board', 'detail']);
  showCollaborationDialog(detail); assert.equal(stack.length, 2);
  const planning = dialog('planning', detail); showCollaborationDialog(planning);
  assert.deepEqual(stack, ['board', 'detail', 'planning']);
  showCollaborationDialog(null);
});
