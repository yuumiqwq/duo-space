// Read all hardware samples in one dispatched event before the UI/network
// update. Browsers without coalesced events still supply the dispatched point.
export function boardPointerPoints(event, rect) {
  if (!(rect.width > 0 && rect.height > 0)) return [];
  let samples = [];
  try { samples = event.getCoalescedEvents?.() || []; } catch { /* Unsupported context: use the dispatched event. */ }
  return [...samples, event].flatMap(sample => Number.isFinite(sample.clientX) && Number.isFinite(sample.clientY) ? [{
    x: Math.max(0, Math.min(1200, (sample.clientX - rect.left) * 1200 / rect.width)),
    y: Math.max(0, Math.min(720, (sample.clientY - rect.top) * 720 / rect.height)),
  }] : []);
}

export function appendStrokePoints(points, samples, includeEndpoint = false) {
  const added = [];
  for (let i = 0; i < samples.length; i++) {
    const point = samples[i], previous = added.at(-1) || points.at(-1);
    const distance = previous ? Math.hypot(point.x - previous.x, point.y - previous.y) : Infinity;
    if (distance >= .5 || (includeEndpoint && i === samples.length - 1 && distance > 0)) added.push(point);
  }
  return added.length ? [...points, ...added] : points;
}
