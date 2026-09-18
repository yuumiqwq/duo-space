"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { resizeTextGeometry, scaleTextGeometry, type ResizeHandle } from './board-text-geometry';
import { ChalkToolIcon, ClassroomFullscreenIcon } from "./ClassroomScene";
import { BOARD_COLOR, CHALK_COLORS, CHALK_FONT, createBoardPainter, visibleBoardColor } from "./board-painter.mjs";
import { BOARD_TEXT_PADDING_X, BOARD_TEXT_PADDING_Y, BOARD_TEXT_LINE_HEIGHT, fitBoardText } from './board-text-layout.mjs';

export type BoardPoint = { x: number; y: number };
export type BoardStroke = { id: string; color: string; width: number; points: BoardPoint[]; createdAt: number; revision: string; tool?: "pen" | "erase"; material?: "chalk-v1" };
export type BoardText = { id: string; text: string; x: number; y: number; width: number; height: number; color: string; fontSize: number; confirmed: boolean; updatedAt: number; revision: string; material?: "chalk-v1"; autoWidth?: boolean };
export type RoomBoard = { id: string; name: string; strokes: BoardStroke[]; texts: BoardText[]; deletedStrokeIds: string[]; deletedTextIds: string[]; epoch: string; createdAt: number };

const BOARD_WIDTH = 1200;
const BOARD_HEIGHT = 720;

function pointDistance(left: BoardPoint, right: BoardPoint) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

let lastBoardRevisionMs = 0;
let boardRevisionSequence = 0;
function makeBoardRevision(observed = "") {
  const now = Math.max(Date.now(), lastBoardRevisionMs, (Number(observed.split(":")[0]) || 0) + 1);
  boardRevisionSequence = now === lastBoardRevisionMs ? boardRevisionSequence + 1 : 0;
  lastBoardRevisionMs = now;
  return `${now.toString().padStart(13, "0")}:${boardRevisionSequence.toString().padStart(4, "0")}:${crypto.randomUUID()}`;
}

function makeBoardTextUpdate(current: BoardText, patch: Partial<BoardText>): BoardText {
  return { ...current, ...patch, updatedAt: Date.now(), revision: makeBoardRevision(current.revision) };
}

export function Whiteboard({ board, fullscreen, onToggleFullscreen, onDelete, onAddStroke, onDeleteStroke, onClear, onUpsertText, onDeleteText, onSaved, onExport }: {
  board: RoomBoard;
  fullscreen: boolean;
  onToggleFullscreen: () => Promise<void>;
  onDelete: () => void | Promise<void>;
  onAddStroke: (stroke: BoardStroke, epoch: string) => void;
  onDeleteStroke: (strokeId: string, epoch: string) => void;
  onClear: () => void;
  onUpsertText: (text: BoardText, epoch: string) => void;
  onDeleteText: (textId: string, epoch: string) => void;
  onSaved: (message: string, error?: boolean) => void;
  onExport?: (blob: Blob) => Promise<void>;
}) {
  const [tool, setTool] = useState<"pen" | "erase-stroke" | "erase-area" | "text">("pen");
  const [eraseMode, setEraseMode] = useState<'erase-stroke' | 'erase-area'>('erase-stroke');
  const [color, setColor] = useState("#f6f1dc");
  const width = 6;
  const [draft, setDraft] = useState<BoardStroke | null>(null);
  const [draftEpoch, setDraftEpoch] = useState(board.epoch);
  const [editingTextId, setEditingTextId] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [measuredTexts, setMeasuredTexts] = useState<{ source: BoardText; fitted: BoardText }[]>([]);
  const [paperScale, setPaperScale] = useState({ x: 1, y: 1 });
  const paperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textCanvasRef = useRef<HTMLCanvasElement>(null);
  const painterRef = useRef<ReturnType<typeof createBoardPainter> | null>(null);
  const draftRef = useRef<BoardStroke | null>(null);
  const draftEpochRef = useRef(board.epoch);
  const lastStrokeBroadcastRef = useRef(0);
  const erasedDuringGestureRef = useRef(new Set<string>());
  const activePointerRef = useRef<number | null>(null);
  const dragRef = useRef<{ id: string; pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const resizeRef = useRef<{ text: BoardText; handle: ResizeHandle; pointerId: number; x: number; y: number } | null>(null);
  const dismissedPointer = useRef<number | null>(null);

  const visibleStrokes = useMemo(() => draft && draftEpoch === board.epoch && !board.deletedStrokeIds.includes(draft.id) ? [...board.strokes.filter((stroke) => stroke.id !== draft.id), draft] : board.strokes, [board.strokes, board.epoch, board.deletedStrokeIds, draft, draftEpoch]);
  const visibleTexts = board.texts.map(text => measuredTexts.find(item => item.source === text)?.fitted ?? text);

  useEffect(() => {
    const paper = paperRef.current;
    if (!paper) return;
    const observer = new ResizeObserver(([entry]) => {
      setPaperScale({ x: entry.contentRect.width / BOARD_WIDTH, y: entry.contentRect.height / BOARD_HEIGHT });
    });
    observer.observe(paper);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const ctx = canvasRef.current?.getContext("2d"); if (!ctx) return;
      painterRef.current ||= createBoardPainter(() => document.createElement("canvas"));
      painterRef.current.drawStrokes(ctx, visibleStrokes, board.epoch);
    });
    return () => cancelAnimationFrame(frame);
  }, [visibleStrokes, board.epoch]);
  useEffect(() => {
    let cancelled = false;
    const paint = () => {
      const ctx = textCanvasRef.current?.getContext("2d"); if (!ctx || cancelled) return;
      painterRef.current ||= createBoardPainter(() => document.createElement("canvas"));
      setMeasuredTexts(board.texts.map(source => ({ source, fitted: fitBoardText(ctx, source) })));
      ctx.clearRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
      painterRef.current.drawTexts(ctx, board.texts.filter(text => text.confirmed && text.id !== editingTextId));
    };
    const frame = requestAnimationFrame(paint);
    void Promise.all([document.fonts.load('32px "Classroom Yan"', board.texts.map(text => text.text).join("")), document.fonts.load('32px "Long Cang"', board.texts.map(text => text.text).join(""))]).then(paint, () => undefined);
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [board.texts, editingTextId]);

  useEffect(() => {
    const paper = paperRef.current;
    if (!paper) return;
    const adjustFont = (event: WheelEvent) => {
      const text = board.texts.find((item) => item.id === editingTextId);
      if (!text || !event.deltaY || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const next = { ...text, ...scaleTextGeometry(text, event.deltaY < 0 ? 1.08 : 1 / 1.08) };
      const ctx = textCanvasRef.current?.getContext('2d');
      onUpsertText(makeBoardTextUpdate(text, ctx ? fitBoardText(ctx, next) : next), board.epoch);
    };
    paper.addEventListener("wheel", adjustFont, { passive: false });
    return () => paper.removeEventListener("wheel", adjustFont);
  }, [board.texts, board.epoch, onUpsertText, editingTextId]);

  useEffect(() => {
    if (!editingTextId) return;
    const dismiss = (event: PointerEvent) => {
      const box = (event.target as Element | null)?.closest('.board-text-box');
      if (box?.getAttribute('data-text-id') === editingTextId) return;
      const text = board.texts.find(item => item.id === editingTextId);
      const ctx = textCanvasRef.current?.getContext('2d');
      if (text) onUpsertText(makeBoardTextUpdate(text, { ...(ctx ? fitBoardText(ctx, text) : text), confirmed: true }), board.epoch);
      dismissedPointer.current = event.target instanceof HTMLCanvasElement && paperRef.current?.contains(event.target) ? event.pointerId : null;
      setEditingTextId('');
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [editingTextId, board.texts, board.epoch, onUpsertText]);

  const pointerPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(BOARD_WIDTH, ((event.clientX - rect.left) / rect.width) * BOARD_WIDTH)),
      y: Math.max(0, Math.min(BOARD_HEIGHT, ((event.clientY - rect.top) / rect.height) * BOARD_HEIGHT)),
    };
  };

  const eraseWholeStroke = (point: BoardPoint) => {
    const hitDistance = Math.max(14, width * 2.2);
    const hit = [...board.strokes].reverse().find((stroke) => !erasedDuringGestureRef.current.has(stroke.id) && stroke.points.some((candidate) => pointDistance(candidate, point) <= hitDistance));
    if (!hit) return;
    erasedDuringGestureRef.current.add(hit.id);
    onDeleteStroke(hit.id, board.epoch);
  };

  const beginStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (dismissedPointer.current === event.pointerId) { dismissedPointer.current = null; return; }
    if (event.button !== 0 && event.pointerType === "mouse") return;
    if (activePointerRef.current !== null) return;
    event.preventDefault();
    const point = pointerPoint(event);
    if (tool === "text") {
      const fontSize = 36;
      const width = Math.ceil(fontSize * (3 + 2 * BOARD_TEXT_PADDING_X));
      const height = Math.ceil(fontSize * (BOARD_TEXT_LINE_HEIGHT + 2 * BOARD_TEXT_PADDING_Y));
      const text: BoardText = { id: crypto.randomUUID(), text: "", x: Math.min(point.x, BOARD_WIDTH - width), y: Math.min(point.y, BOARD_HEIGHT - height), width, height, color, fontSize, confirmed: false, updatedAt: Date.now(), revision: makeBoardRevision(), material: "chalk-v1", autoWidth: true };
      const ctx = textCanvasRef.current?.getContext('2d');
      setEditingTextId(text.id);
      onUpsertText(ctx ? fitBoardText(ctx, text) : text, board.epoch);
      return;
    }
    activePointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    erasedDuringGestureRef.current.clear();
    if (tool === "erase-stroke") { eraseWholeStroke(point); return; }
    const stroke: BoardStroke = { id: crypto.randomUUID(), color, width: tool === "erase-area" ? Math.max(24, width * 4) : width, points: [point], createdAt: Date.now(), revision: makeBoardRevision(), material: "chalk-v1", tool: tool === "erase-area" ? "erase" : "pen" };
    draftRef.current = stroke;
    draftEpochRef.current = board.epoch;
    setDraftEpoch(board.epoch);
    setDraft(stroke);
    onAddStroke(stroke, board.epoch);
    lastStrokeBroadcastRef.current = event.timeStamp;
  };

  const continueStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    const point = pointerPoint(event);
    if (tool === "erase-stroke") { eraseWholeStroke(point); return; }
    const current = draftRef.current;
    if (draftEpochRef.current !== board.epoch || (current && board.deletedStrokeIds.includes(current.id))) {
      draftRef.current = null;
      setDraft(null);
      return;
    }
    if (!current || pointDistance(current.points[current.points.length - 1], point) < 1.5) return;
    const next = { ...current, points: [...current.points, point], revision: makeBoardRevision() };
    draftRef.current = next;
    setDraft(next);
    if (event.timeStamp - lastStrokeBroadcastRef.current >= 32) {
      onAddStroke(next, board.epoch);
      lastStrokeBroadcastRef.current = event.timeStamp;
    }
  };

  const finishStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    activePointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    erasedDuringGestureRef.current.clear();
    const finished = draftRef.current;
    if (!finished) return;
    if (draftEpochRef.current === board.epoch && !board.deletedStrokeIds.includes(finished.id)) onAddStroke(finished, draftEpochRef.current);
    draftRef.current = null;
    setDraft(null);
  };

  const updateText = (current: BoardText, patch: Partial<BoardText>) => {
    const ctx = textCanvasRef.current?.getContext('2d');
    const next = { ...current, ...patch };
    onUpsertText(makeBoardTextUpdate(current, ctx ? fitBoardText(ctx, next) : next), board.epoch);
  };

  const beginTextDrag = (event: React.PointerEvent<HTMLButtonElement>, text: BoardText) => {
    event.preventDefault(); event.stopPropagation();
    const rect = paperRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id: text.id, pointerId: event.pointerId, offsetX: ((event.clientX - rect.left) / rect.width) * BOARD_WIDTH - text.x, offsetY: ((event.clientY - rect.top) / rect.height) * BOARD_HEIGHT - text.y };
  };

  const moveText = (event: React.PointerEvent<HTMLButtonElement>, text: BoardText) => {
    const drag = dragRef.current;
    const rect = paperRef.current?.getBoundingClientRect();
    if (!drag || drag.id !== text.id || drag.pointerId !== event.pointerId || !rect) return;
    const x = ((event.clientX - rect.left) / rect.width) * BOARD_WIDTH - drag.offsetX;
    const y = ((event.clientY - rect.top) / rect.height) * BOARD_HEIGHT - drag.offsetY;
    updateText(text, { x: Math.max(0, Math.min(BOARD_WIDTH - text.width, x)), y: Math.max(0, Math.min(BOARD_HEIGHT - text.height, y)) });
  };

  const finishTextDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
  };

  const beginResize = (event: React.PointerEvent<HTMLButtonElement>, text: BoardText, handle: ResizeHandle) => {
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { text, handle, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const moveResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    const gesture = resizeRef.current;
    const rect = paperRef.current?.getBoundingClientRect();
    if (!gesture || gesture.pointerId !== event.pointerId || !rect) return;
    const current = board.texts.find(item => item.id === gesture.text.id);
    if (current) updateText(current, { ...resizeTextGeometry(gesture.text, gesture.handle, (event.clientX - gesture.x) * BOARD_WIDTH / rect.width, (event.clientY - gesture.y) * BOARD_HEIGHT / rect.height), ...(['e', 'w'].includes(gesture.handle) ? { autoWidth: false } : {}) });
  };
  const finishResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    resizeRef.current = null;
  };

  const saveBoard = async () => {
    setSaving(true);
    try {
      const rect = paperRef.current?.getBoundingClientRect();
      const visibleAspect = rect && rect.width > 10 && rect.height > 10 ? rect.width / rect.height : BOARD_WIDTH / BOARD_HEIGHT;
      const outputWidth = visibleAspect >= 1 ? 1920 : Math.round(1920 * visibleAspect);
      const outputHeight = visibleAspect >= 1 ? Math.round(1920 / visibleAspect) : 1920;
      const canvas = document.createElement("canvas");
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("画板生成失败");
      await Promise.all([document.fonts.load('32px "Classroom Yan"', board.texts.map(text => text.text).join("")), document.fonts.load('32px "Long Cang"', board.texts.map(text => text.text).join(""))]);
      const layer = document.createElement("canvas"); layer.width = BOARD_WIDTH; layer.height = BOARD_HEIGHT;
      const layerContext = layer.getContext("2d"); if (!layerContext) throw new Error("画板生成失败");
      const painter = createBoardPainter(() => document.createElement("canvas"));
      painter.drawStrokes(layerContext, board.strokes, board.epoch);
      painter.drawTexts(layerContext, board.texts);
      const outputBoardColor = paperRef.current && getComputedStyle(paperRef.current).getPropertyValue('--board-color').trim();
      context.fillStyle = outputBoardColor || BOARD_COLOR; context.fillRect(0, 0, outputWidth, outputHeight);
      const texture = new Image(); texture.src = "/classroom/board-grain.png";
      await texture.decode().catch(() => undefined);
      if (texture.complete && texture.naturalWidth) {
        const pattern = context.createPattern(texture, "repeat");
        if (pattern) {
          // Match the muted grain used by the classroom CSS background.
          context.save(); context.globalAlpha = 0.44;
          context.fillStyle = pattern; context.fillRect(0, 0, outputWidth, outputHeight);
          context.restore();
        }
      }
      context.drawImage(layer, 0, 0, outputWidth, outputHeight);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("画板生成失败")), "image/png"));
      if (onExport) { await onExport(blob); onSaved("已导出到本地"); return; }
      const timestamp = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date()).replace(/\D/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
      const response = await fetch("/api/cloud/files?path=board", { method: "POST", headers: { "Content-Type": "image/png", "X-File-Name": encodeURIComponent(`${board.name}-${timestamp}.png`) }, body: blob });
      const result = await response.json().catch(() => null) as { error?: unknown } | null;
      if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "保存失败，请重试");
      onSaved("已保存到/board");
    } catch (error) { onSaved(error instanceof Error ? error.message : "保存失败，请重试", true); }
    finally { setSaving(false); }
  };

  return (
    <div className="whiteboard-shell">
      <button className="board-close-button" type="button" onClick={() => { if (deleting) return; setDeleting(true); void Promise.resolve(onDelete()).finally(() => setDeleting(false)); }} disabled={deleting} aria-label="删除画板" title="删除画板" ><ChalkToolIcon name="close" /></button>
      <div className={`whiteboard-paper tool-${tool}`} ref={paperRef}>
        <canvas className="chalk-stroke-canvas" ref={canvasRef} width={BOARD_WIDTH} height={BOARD_HEIGHT} role="img" aria-label={board.name} onPointerDown={beginStroke} onPointerMove={continueStroke} onPointerUp={finishStroke} onPointerCancel={finishStroke} onLostPointerCapture={finishStroke} />
        <canvas className="chalk-text-canvas" ref={textCanvasRef} width={BOARD_WIDTH} height={BOARD_HEIGHT} aria-hidden="true" />
        <div className="board-text-layer" style={{ '--board-text-pad-x': `${BOARD_TEXT_PADDING_X}em`, '--board-text-pad-y': `${BOARD_TEXT_PADDING_Y}em`, '--board-text-line-height': BOARD_TEXT_LINE_HEIGHT } as CSSProperties}>
          {visibleTexts.map((text) => {
            const editing = editingTextId === text.id || !text.confirmed;
            const textStyle: CSSProperties = { width: text.width, height: text.height, fontSize: text.fontSize, transform: `scale(${paperScale.x}, ${paperScale.y})`, transformOrigin: 'top left' };
            return <div className={editing ? "board-text-box editing" : "board-text-box"} key={text.id} data-text-id={text.id} style={{ left: `${(text.x / BOARD_WIDTH) * 100}%`, top: `${(text.y / BOARD_HEIGHT) * 100}%`, width: `${(text.width / BOARD_WIDTH) * 100}%`, height: `${(text.height / BOARD_HEIGHT) * 100}%`, color: visibleBoardColor(text), fontFamily: text.material === "chalk-v1" ? CHALK_FONT : "system-ui, sans-serif", fontSize: `${text.fontSize / 12}cqw` }}>
              {editing ? <>
                <button className="board-text-drag" type="button" aria-label="拖动文本框"  onPointerDown={(event) => beginTextDrag(event, text)} onPointerMove={(event) => moveText(event, text)} onPointerUp={finishTextDrag} onPointerCancel={finishTextDrag}><span aria-hidden="true" /></button>
                <button className="board-text-delete" type="button" aria-label="删除文本框"  onClick={() => onDeleteText(text.id, board.epoch)}><ChalkToolIcon name="close" /></button>
                {(['n','s','e','w','ne','nw','se','sw'] as ResizeHandle[]).map(handle => <button key={handle} className={`text-resize-handle handle-${handle}`} type="button" aria-label={`${handle.length === 2 ? '缩放文字' : '调整文本边界'} ${handle}`} onPointerDown={event => beginResize(event, text, handle)} onPointerMove={moveResize} onPointerUp={finishResize} onPointerCancel={finishResize} />)}
                <textarea style={textStyle} value={text.text} autoFocus={editingTextId === text.id} aria-label="画板文本" onChange={(event) => updateText(text, { text: event.target.value })} onKeyDown={(event) => { if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return; event.preventDefault(); updateText(text, { confirmed: true }); setEditingTextId(""); }} />
              </> : <button className="board-text-content" style={textStyle} type="button" onClick={() => { if (tool === "text") { setEditingTextId(text.id); updateText(text, { confirmed: false }); } }}>{text.text}</button>}
            </div>;
          })}
        </div>
      </div>
      <div className="chalk-palette" role="group" aria-label="粉笔颜色">
        <button className={tool.startsWith("erase") ? "ledge-eraser selected" : "ledge-eraser"} type="button" onClick={() => {
          const next = tool.startsWith('erase') ? (eraseMode === 'erase-stroke' ? 'erase-area' : 'erase-stroke') : eraseMode;
          setEraseMode(next); setTool(next);
        }} aria-label={eraseMode === "erase-area" ? "板擦：局部擦除" : "板擦：整笔擦除"} aria-pressed={tool.startsWith('erase')} ><span className="chalk-eraser" />{tool.startsWith('erase') && <span className={`eraser-mode-art ${eraseMode}`} aria-hidden="true" />}</button>
        {CHALK_COLORS.map(item => <button key={item.color} className="chalk-choice" type="button" aria-label={item.name} aria-pressed={color === item.color && tool === "pen"}  onClick={() => { setColor(item.color); setTool("pen"); }}><span className="chalk-stick" style={{background:item.color}} /></button>)}
        <label className="rainbow-chalk" ><input aria-label="自定义粉笔颜色" type="color" value={color} onChange={event => { setColor(event.target.value); setTool('pen'); }} /><span className="chalk-stick" /></label>
      </div>
      <aside className="whiteboard-tools" aria-label="画板工具栏">
        <button className={tool === "text" ? "active" : ""} type="button" onClick={() => setTool("text")}  aria-label="文本"><ChalkToolIcon name="text" /></button>
        <button type="button" onClick={onClear}  aria-label="清屏"><ChalkToolIcon name="clear" /></button>
        <button type="button" onClick={() => void saveBoard()} disabled={saving}  aria-label="保存到云盘">{saving ? "…" : <ChalkToolIcon name="save" />}</button>
        <button type="button" onClick={() => void onToggleFullscreen()} aria-keyshortcuts="f"  aria-label={fullscreen ? "退出全屏" : "全屏"}><ClassroomFullscreenIcon fullscreen={fullscreen} /></button>
      </aside>
    </div>
  );
}
