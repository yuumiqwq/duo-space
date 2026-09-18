import type { BoardStroke, BoardText, RoomBoard } from "./Whiteboard";
export const INITIAL_BOARD_EPOCH = "0000000000000:initial";

export const normalizeBoardStroke = (value: unknown): BoardStroke | null => {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<BoardStroke>;
  if (typeof item.id !== "string" || typeof item.color !== "string" || !/^#[0-9a-f]{6}$/i.test(item.color)
    || typeof item.width !== "number" || item.width < 1 || item.width > 120 || !Array.isArray(item.points)) return null;
  const points = item.points.slice(0, 10000).flatMap((point) => (
    point && typeof point.x === "number" && typeof point.y === "number" && Number.isFinite(point.x) && Number.isFinite(point.y)
      ? [{ x: Math.max(0, Math.min(1200, point.x)), y: Math.max(0, Math.min(720, point.y)) }]
      : []
  ));
  return {
    id: item.id.slice(0, 80), color: item.color, width: item.width, points,
    ...(item.material === "chalk-v1" ? { material: "chalk-v1" as const } : {}),
    ...(item.tool === "pen" || item.tool === "erase" ? { tool: item.tool } : {}),
    createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : 0,
    revision: typeof item.revision === "string" ? item.revision.slice(0, 120) : `${String(typeof item.createdAt === "number" ? item.createdAt : 0).padStart(13, "0")}:${item.id}`,
  };
};

export const normalizeBoardText = (value: unknown): BoardText | null => {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<BoardText>;
  if (typeof item.id !== "string" || typeof item.text !== "string" || typeof item.x !== "number" || typeof item.y !== "number"
    || typeof item.width !== "number" || typeof item.height !== "number" || typeof item.color !== "string" || !/^#[0-9a-f]{6}$/i.test(item.color)) return null;
  return {
    id: item.id.slice(0, 80), text: item.text.slice(0, 4000),
    x: Math.max(0, Math.min(1200, item.x)), y: Math.max(0, Math.min(720, item.y)),
    width: Math.max(80, Math.min(1200, item.width)), height: Math.max(40, Math.min(720, item.height)),
    color: item.color, fontSize: typeof item.fontSize === "number" ? Math.max(10, Math.min(96, item.fontSize)) : 20,
    ...(typeof item.autoWidth === 'boolean' ? { autoWidth: item.autoWidth } : {}),
    ...(item.material === "chalk-v1" ? { material: "chalk-v1" as const } : {}),
    confirmed: item.confirmed !== false, updatedAt: typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
    revision: typeof item.revision === "string" ? item.revision.slice(0, 120) : `${String(typeof item.updatedAt === "number" ? item.updatedAt : 0).padStart(13, "0")}:${item.id}`,
  };
};

export const normalizeBoard = (value: unknown): RoomBoard | null => {
  if (!value || typeof value !== "object") return null;
  const board = value as Partial<RoomBoard>;
  if (typeof board.id !== "string" || !/^[0-9a-f-]{36}$/i.test(board.id) || typeof board.name !== "string" || !Array.isArray(board.strokes)) return null;
  const strokes = board.strokes.slice(0, 2000).flatMap((stroke) => { const normalized = normalizeBoardStroke(stroke); return normalized ? [normalized] : []; });
  const texts = Array.isArray(board.texts) ? board.texts.slice(0, 200).flatMap((text) => { const normalized = normalizeBoardText(text); return normalized ? [normalized] : []; }) : [];
  const deletedStrokeIds = Array.isArray(board.deletedStrokeIds) ? board.deletedStrokeIds.filter((id): id is string => typeof id === "string") : [];
  const deletedTextIds = Array.isArray(board.deletedTextIds) ? board.deletedTextIds.filter((id): id is string => typeof id === "string") : [];
  const deletedStrokes = new Set(deletedStrokeIds);
  const deletedTexts = new Set(deletedTextIds);
  return {
    id: board.id, name: board.name.trim().slice(0, 40) || "画板", strokes: strokes.filter((stroke) => !deletedStrokes.has(stroke.id)), texts: texts.filter((text) => !deletedTexts.has(text.id)),
    deletedStrokeIds, deletedTextIds,
    epoch: typeof board.epoch === "string" && /^\d{13}:[0-9a-z-]{1,80}$/i.test(board.epoch) ? board.epoch : INITIAL_BOARD_EPOCH,
    createdAt: typeof board.createdAt === "number" ? board.createdAt : Date.now(),
  };
};

export const sortBoardStrokes = (strokes: BoardStroke[]) => [...strokes].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));

export const mergeBoard = (current: RoomBoard, incoming: RoomBoard): RoomBoard => {
  if (incoming.epoch > current.epoch) return { ...incoming, strokes: sortBoardStrokes(incoming.strokes) };
  if (incoming.epoch < current.epoch) return current;
  const strokeMap = new Map(current.strokes.map((stroke) => [stroke.id, stroke]));
  incoming.strokes.forEach((stroke) => { const previous = strokeMap.get(stroke.id); if (!previous || stroke.revision > previous.revision) strokeMap.set(stroke.id, stroke); });
  const textMap = new Map(current.texts.map((text) => [text.id, text]));
  incoming.texts.forEach((text) => { const previous = textMap.get(text.id); if (!previous || text.revision > previous.revision) textMap.set(text.id, text); });
  const deletedStrokeIds = [...new Set([...current.deletedStrokeIds, ...incoming.deletedStrokeIds])];
  const deletedTextIds = [...new Set([...current.deletedTextIds, ...incoming.deletedTextIds])];
  const deletedStrokes = new Set(deletedStrokeIds);
  const deletedTexts = new Set(deletedTextIds);
  return { ...current, name: incoming.name || current.name, strokes: sortBoardStrokes([...strokeMap.values()].filter((stroke) => !deletedStrokes.has(stroke.id))), texts: [...textMap.values()].filter((text) => !deletedTexts.has(text.id)), deletedStrokeIds, deletedTextIds };
};
