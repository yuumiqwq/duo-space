const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// Flatten midpoint quadratics to subpixel accuracy. Each curve stays inside
// its control triangle, so smoothing cannot overshoot the recorded gesture.
export function strokePath(stroke) {
  const points = (stroke.points || []).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (stroke.path !== 'smooth-v1' || points.length < 3) return points;
  const clean = points.filter((p, i) => !i || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
  if (clean.length < 3) return clean;
  const result = [clean[0], midpoint(clean[0], clean[1])];
  function flatten(a, control, b, depth = 0) {
    const error = Math.hypot(a.x - 2 * control.x + b.x, a.y - 2 * control.y + b.y) / 4;
    if (error <= .15 || depth >= 12) { result.push(b); return; }
    const left = midpoint(a, control), right = midpoint(control, b), middle = midpoint(left, right);
    flatten(a, left, middle, depth + 1);
    flatten(middle, right, b, depth + 1);
  }
  for (let i = 1; i < clean.length - 1; i++) {
    flatten(result.at(-1), clean[i], midpoint(clean[i], clean[i + 1]));
  }
  result.push(clean.at(-1));
  return result;
}

export function strokeContainsPoint(stroke, point, radius) {
  const points = strokePath(stroke);
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[i + 1] || a;
    const dx = b.x - a.x, dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0;
    if (Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy) <= radius) return true;
  }
  return false;
}
