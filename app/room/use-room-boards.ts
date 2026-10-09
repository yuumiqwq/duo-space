"use client";

import { useCallback,useEffect,useRef,useState } from "react";
import { BoardStroke,BoardText,RoomBoard } from "../Whiteboard";
import { assertBoardCapacity,BOARD_CAPACITY_NOTICE,BoardCapacityError } from '../board-limits';
import { upsertBoardText as applyBoardText,INITIAL_BOARD_EPOCH,mergeBoard,normalizeBoard,normalizeBoardStroke,normalizeBoardText,upsertBoardStroke } from "../board-state";
import { orderClassroomBoards } from "../classroom-boards";
import { createPacketReceiver } from "../room-packets";
import { useClassroomBoards } from "../use-classroom-boards";

type Options = {
  joined: boolean;
  broadcastRoomMessage: (message: object) => void;
};

export function useRoomBoards({ joined, broadcastRoomMessage }: Options) {

  const { boards, setBoards, activeBoardId, setActiveBoardId, createAndSelect } = useClassroomBoards();
  const [boardNotice, setBoardNotice] = useState("");
  const boardsRef = useRef<RoomBoard[]>([]);
  const packetReceiverRef = useRef(createPacketReceiver());
  const deletedBoardIdsRef = useRef(new Set<string>());

  const updateBoards = useCallback((update: (current: RoomBoard[]) => RoomBoard[]) => {
    try {
      const next = update(boardsRef.current).filter(board => !deletedBoardIdsRef.current.has(board.id));
      next.forEach(assertBoardCapacity);
      if (boardsRef.current.some(board => !deletedBoardIdsRef.current.has(board.id) && !next.some(item => item.id === board.id))) {
        setBoardNotice("最多保留 12 张画板，可点击画板右上角删除不用的画板");
      }
      boardsRef.current = next;
      setBoards(next);
      return true;
    } catch (error) {
      if (!(error instanceof BoardCapacityError)) throw error;
      setBoardNotice(BOARD_CAPACITY_NOTICE);
      return false;
    }
  }, [setBoards]);

  const refreshDeletedBoards = useCallback(async () => {
    const response = await fetch('/api/room/boards', { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('画板暂时无法读取，请重试。');
    const data = await response.json() as { deletedBoardIds: string[] };
    data.deletedBoardIds.forEach(id => deletedBoardIdsRef.current.add(id));
    updateBoards(current => current);
  }, [updateBoards]);

  useEffect(() => {
    if (!joined) return;
    const refresh = () => { if (!document.hidden) void refreshDeletedBoards().catch(() => undefined); };
    const timer = window.setInterval(refresh, 10_000);
    window.addEventListener('online', refresh); window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('online', refresh); window.removeEventListener('focus', refresh); };
  }, [joined, refreshDeletedBoards]);

  const receiveBoardMessage = useCallback(function receiveBoardMessage(message: { type?: string; boards?: unknown; deletedBoardIds?: unknown; board?: unknown; id?: unknown; boardId?: unknown; stroke?: unknown; strokeId?: unknown; text?: unknown; textId?: unknown; epoch?: unknown }) {
    if (message.type === "board-chunk") {
      const assembled = packetReceiverRef.current(message);
      if (assembled) receiveBoardMessage(assembled);
      return true;
    }
    if (message.type === "board-snapshot" && Array.isArray(message.boards)) {
      if (Array.isArray(message.deletedBoardIds)) message.deletedBoardIds.forEach((id) => { if (typeof id === "string") deletedBoardIdsRef.current.add(id); });
      const incoming = message.boards.flatMap((item) => {
        const board = normalizeBoard(item);
        if (!board) setBoardNotice(BOARD_CAPACITY_NOTICE);
        return board ? [board] : [];
      });
      updateBoards((current) => {
        const merged = new Map(current.filter((board) => !deletedBoardIdsRef.current.has(board.id)).map((board) => [board.id, board]));
        incoming.forEach((board) => {
          if (deletedBoardIdsRef.current.has(board.id)) return;
          const existing = merged.get(board.id);
          try { merged.set(board.id, existing ? mergeBoard(existing, board) : board); }
          catch (error) {
            if (!(error instanceof BoardCapacityError)) throw error;
            setBoardNotice(BOARD_CAPACITY_NOTICE);
          }
        });
        const next = orderClassroomBoards([...merged.values()]).slice(0, 12);
        return next;
      });
      return true;
    }
    if (message.type === "board-create" || message.type === "board-upsert") {
      const board = normalizeBoard(message.board);
      if (!board) { setBoardNotice(BOARD_CAPACITY_NOTICE); return true; }
      if (deletedBoardIdsRef.current.has(board.id)) return true;
      updateBoards((current) => {
        const next = current.some((item) => item.id === board.id)
          ? current.map((item) => item.id === board.id ? mergeBoard(item, board) : item)
          : orderClassroomBoards([...current, board]).slice(0, 12);
        return next;
      });
      return true;
    }
    if (typeof message.boardId === "string" && typeof message.epoch === "string") {
      if (message.type === "board-clear") {
        updateBoards((current) => {
          const next = current.map((board) => board.id === message.boardId && message.epoch! > board.epoch
            ? { ...board, epoch: message.epoch as string, strokes: [], texts: [], deletedStrokeIds: [], deletedTextIds: [] }
            : board);
          return next;
        });
        return true;
      }
      if (message.type === "board-stroke-add") {
        const stroke = normalizeBoardStroke(message.stroke);
        if (!stroke) { setBoardNotice(BOARD_CAPACITY_NOTICE); return true; }
        updateBoards((current) => {
          const next = current.map((board) => {
            return board.id === message.boardId ? upsertBoardStroke(board, stroke, message.epoch as string) ?? board : board;
          });
          return next;
        });
        return true;
      }
      if (message.type === "board-stroke-delete" && typeof message.strokeId === "string") {
        updateBoards((current) => {
          const next = current.map((board) => board.id === message.boardId && board.epoch === message.epoch
            ? { ...board, strokes: board.strokes.filter((stroke) => stroke.id !== message.strokeId), deletedStrokeIds: [...new Set([...board.deletedStrokeIds, message.strokeId as string])] }
            : board);
          return next;
        });
        return true;
      }
      if (message.type === "board-text-upsert") {
        const text = normalizeBoardText(message.text);
        if (!text) { setBoardNotice(BOARD_CAPACITY_NOTICE); return true; }
        updateBoards((current) => {
          const next = current.map((board) => {
            return board.id === message.boardId ? applyBoardText(board, text, message.epoch as string) ?? board : board;
          });
          return next;
        });
        return true;
      }
      if (message.type === "board-text-delete" && typeof message.textId === "string") {
        updateBoards((current) => {
          const next = current.map((board) => board.id === message.boardId && board.epoch === message.epoch
            ? { ...board, texts: board.texts.filter((text) => text.id !== message.textId), deletedTextIds: [...new Set([...board.deletedTextIds, message.textId as string])] }
            : board);
          return next;
        });
        return true;
      }
    }
    if (message.type === "board-delete" && typeof message.id === "string") {
      deletedBoardIdsRef.current.add(message.id);
      updateBoards((current) => {
        const next = current.filter((item) => item.id !== message.id);
        return next;
      });
      return true;
    }
    return false;
  }, [updateBoards]);

  useEffect(() => {
    if (!joined) return;
    const reconcile = () => {
      if (document.visibilityState === "visible" && (boardsRef.current.length || deletedBoardIdsRef.current.size)) broadcastRoomMessage({ type: "board-snapshot", boards: boardsRef.current, deletedBoardIds: [...deletedBoardIdsRef.current] });
    };
    const timer = window.setInterval(reconcile, 10_000);
    window.addEventListener("online", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => { window.clearInterval(timer); window.removeEventListener("online", reconcile); document.removeEventListener("visibilitychange", reconcile); };
  }, [joined, broadcastRoomMessage]);
  const createBoard = () => {
    if (boardsRef.current.length >= 12) { setBoardNotice("最多保留 12 张画板，可点击画板右上角删除不用的画板"); return false; }
    const board: RoomBoard = { id: crypto.randomUUID(), name: `画板 ${boardsRef.current.length + 1}`, strokes: [], texts: [], deletedStrokeIds: [], deletedTextIds: [], epoch: INITIAL_BOARD_EPOCH, createdAt: Date.now() };
    const next = [...boardsRef.current, board].slice(0, 12);
    boardsRef.current = next;
    createAndSelect(board);
    broadcastRoomMessage({ type: "board-create", board });
    return true;
  };

  const deleteBoard = async (id: string) => {
    if (!id || !boardsRef.current.some(board => board.id === id)) return;
    try {
      const response = await fetch('/api/room/boards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }), signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error('画板删除失败，请重试。');
      deletedBoardIdsRef.current.add(id);
      updateBoards(current => current.filter(board => board.id !== id));
        broadcastRoomMessage({ type: 'board-delete', id });
      return true;
    } catch { setBoardNotice('画板删除暂未完成，请检查网络后重试。'); }
  };

  const addBoardStroke = (boardId: string, stroke: BoardStroke, epoch: string, publish = true) => {
    let accepted = false;
    const applied = updateBoards(current => current.map(board => {
      if (board.id !== boardId) return board;
      const next = upsertBoardStroke(board, stroke, epoch);
      accepted = next !== null;
      return next ?? board;
    }));
    if (!applied || !accepted) { setBoardNotice(BOARD_CAPACITY_NOTICE); return false; }
    if (publish) broadcastRoomMessage({ type: "board-stroke-add", boardId, stroke, epoch });
    return true;
  };

  const deleteBoardStroke = (boardId: string, strokeId: string, epoch: string) => {
    const next = boardsRef.current.map((board) => board.id === boardId && board.epoch === epoch
      ? { ...board, strokes: board.strokes.filter((stroke) => stroke.id !== strokeId), deletedStrokeIds: [...new Set([...board.deletedStrokeIds, strokeId])] }
      : board);
    boardsRef.current = next; setBoards(next);
    broadcastRoomMessage({ type: "board-stroke-delete", boardId, strokeId, epoch });
  };

  const clearBoard = (boardId: string) => {
    const observed = Number(boardsRef.current.find((board) => board.id === boardId)?.epoch.split(":")[0]) || 0;
    const epoch = `${Math.max(Date.now(), observed + 1).toString().padStart(13, "0")}:${crypto.randomUUID()}`;
    const next = boardsRef.current.map((board) => board.id === boardId ? { ...board, epoch, strokes: [], texts: [], deletedStrokeIds: [], deletedTextIds: [] } : board);
    boardsRef.current = next; setBoards(next);
    broadcastRoomMessage({ type: "board-clear", boardId, epoch });
  };

  const upsertBoardText = (boardId: string, text: BoardText, epoch: string) => {
    let accepted = false;
    const applied = updateBoards(current => current.map(board => {
      if (board.id !== boardId) return board;
      const next = applyBoardText(board, text, epoch);
      accepted = next !== null;
      return next ?? board;
    }));
    if (!applied || !accepted) { setBoardNotice(BOARD_CAPACITY_NOTICE); return false; }
    broadcastRoomMessage({ type: "board-text-upsert", boardId, text, epoch });
    return true;
  };

  const deleteBoardText = (boardId: string, textId: string, epoch: string) => {
    const next = boardsRef.current.map((board) => board.id === boardId && board.epoch === epoch
      ? { ...board, texts: board.texts.filter((text) => text.id !== textId), deletedTextIds: [...new Set([...board.deletedTextIds, textId])] }
      : board);
    boardsRef.current = next; setBoards(next);
    broadcastRoomMessage({ type: "board-text-delete", boardId, textId, epoch });
  };

  return { createBoard, deleteBoard, addBoardStroke, deleteBoardStroke, clearBoard, upsertBoardText, deleteBoardText, boards, setBoards, activeBoardId, setActiveBoardId, createAndSelect, boardNotice, setBoardNotice, boardsRef, deletedBoardIdsRef, updateBoards, refreshDeletedBoards, receiveBoardMessage };
}
