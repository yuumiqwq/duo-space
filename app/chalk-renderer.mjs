// Versioned chalk geometry shared by live boards, replay and PNG export.
import { strokePath } from './board-stroke-path.mjs';
export const CHALK_RENDERER_VERSION = 1;
export function seedFromId(id) {
  let hash = 2166136261;
  for (const ch of String(id)) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return hash >>> 0;
}
export function noise(seed, index) {
  let n = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  n ^= n >>> 16; n = Math.imul(n, 0x85ebca6b); n ^= n >>> 13;
  n = Math.imul(n, 0xc2b2ae35); n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
export function resample(points, spacing = 1) {
  const clean = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!clean.length) return [];
  const result = [{ x: clean[0].x, y: clean[0].y }];
  const step = Math.max(.25, spacing);
  let distance = 0, next = step;
  for (let i = 1; i < clean.length; i++) {
    const a = clean[i - 1], b = clean[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!length) continue;
    while (next <= distance + length + 1e-9) {
      const t = Math.min(1, (next - distance) / length);
      result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      next += step;
    }
    distance += length;
  }
  const last = clean.at(-1), tail = result.at(-1);
  if (Math.hypot(last.x - tail.x, last.y - tail.y) > .01) result.push({ x: last.x, y: last.y });
  return result;
}
export function buildChalkOutline(stroke) {
  const width = Math.max(.5, Math.min(80, Number(stroke.width) || 8));
  const points = resample(strokePath(stroke), Math.max(.6, width * .16));
  if (!points.length) return null;
  const seed = seedFromId(stroke.id), left = [], right = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i], before = points[Math.max(0, i - 1)], after = points[Math.min(points.length - 1, i + 1)];
    const dx = after.x - before.x, dy = after.y - before.y;
    const length = Math.hypot(dx, dy) || 1, nx = -dy / length, ny = dx / length;
    const wave = Math.sin(i * .12 + seed % 17) * .045;
    const r = width * .5 * (.94 + wave + (noise(seed, i) - .5) * .14);
    left.push({ x: p.x + nx * r, y: p.y + ny * r });
    right.push({ x: p.x - nx * r, y: p.y - ny * r });
  }
  const padding = width + 3;
  return {
    polygon: [...left, ...right.reverse()], points, width,
    bounds: {
      x: Math.floor(Math.min(...points.map(p => p.x)) - padding),
      y: Math.floor(Math.min(...points.map(p => p.y)) - padding),
      width: Math.ceil(Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)) + padding * 2),
      height: Math.ceil(Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y)) + padding * 2)
    }
  };
}
export function createChalkRenderer(createCanvas) {
  const textures = new Map();
  const make = (w,h) => { const c = createCanvas(w,h); c.width=w; c.height=h; return c; };
  function texture(strength) {
    const key = Math.round(Math.max(0, Math.min(1, strength)) * 100);
    if (textures.has(key)) return textures.get(key);
    const tile = make(192,192), ctx = tile.getContext('2d'), pixels = ctx.createImageData(192,192);
    for (let y=0;y<192;y++) for (let x=0;x<192;x++) {
      const i=y*192+x, fine=noise(317,i), cluster=noise(193,Math.floor(x/3)+Math.floor(y/3)*64);
      const tooth=fine < .075 ? .12 : .58 + .42 * fine;
      const alpha=1 - key/100 * (1 - tooth * (.79 + .21 * cluster));
      pixels.data[i*4]=pixels.data[i*4+1]=pixels.data[i*4+2]=255;
      pixels.data[i*4+3]=Math.round(alpha*255);
    }
    ctx.putImageData(pixels,0,0); textures.set(key,tile); return tile;
  }
  function applyGrain(ctx, x, y, w, h, strength) {
    if (strength<=0) return;
    const tile=texture(strength), mask=make(w,h), maskContext=mask.getContext('2d');
    // Anchor grain to board coordinates. Explicit tiles avoid canvas engines
    // disagreeing about a pattern's origin in translated offscreen canvases.
    for(let ty=Math.floor(y/192)*192;ty<y+h;ty+=192)
      for(let tx=Math.floor(x/192)*192;tx<x+w;tx+=192) maskContext.drawImage(tile,tx-x,ty-y);
    ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.globalCompositeOperation='destination-in';
    ctx.drawImage(mask,0,0); ctx.restore();
  }
  function drawStroke(target, stroke, strength=.72) {
    const shape=buildChalkOutline(stroke); if (!shape) return;
    const b=shape.bounds;
    if (b.width>10000 || b.height>10000) return;
    const c=make(b.width,b.height),ctx=c.getContext('2d');
    ctx.translate(-b.x,-b.y);ctx.fillStyle=stroke.color;
    if (shape.points.length>1) {
      ctx.beginPath();
      shape.polygon.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));
      ctx.closePath();ctx.fill();
    }
    for (const p of [shape.points[0], shape.points.at(-1)]) {
      ctx.beginPath();ctx.arc(p.x,p.y,shape.width*.43,0,Math.PI*2);ctx.fill();
    }
    applyGrain(ctx,b.x,b.y,b.width,b.height,strength);
    target.drawImage(c,b.x,b.y);
  }
  function drawText(target, {text,x,y,font,color='#f6f1dc'}, strength=.72) {
    const c=make(target.canvas.width,target.canvas.height),ctx=c.getContext('2d');
    ctx.font=font;ctx.fillStyle=color;ctx.textBaseline='alphabetic';ctx.fillText(text,x,y);
    applyGrain(ctx,0,0,c.width,c.height,strength);target.drawImage(c,0,0);
  }
  function erase(target, stroke) {
    const p=strokePath(stroke);if(!p.length)return;
    target.save();target.globalCompositeOperation='destination-out';target.lineWidth=stroke.width;
    target.lineCap='round';target.lineJoin='round';target.beginPath();target.moveTo(p[0].x,p[0].y);
    if(p.length===1)target.lineTo(p[0].x+.01,p[0].y);
    else p.slice(1).forEach(pt=>target.lineTo(pt.x,pt.y));
    target.stroke();target.restore();
  }
  return {drawStroke, drawText, erase};
}
