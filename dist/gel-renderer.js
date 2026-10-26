/** Continuous gel silhouettes: grid cells are only construction data, never visible seams. */
export const PALETTE = Object.freeze({
  T: { base: '#EF43AD', light: '#FFB9E3', dark: '#B31D7D', glow: '#FF73C9' },
  Z: { base: '#F3469B', light: '#FFC4DE', dark: '#B61C68', glow: '#FF7CB9' },
  J: { base: '#1264F7', light: '#88CFFF', dark: '#1639B8', glow: '#398BFF' },
  I: { base: '#10D4EF', light: '#A9FAFF', dark: '#098DBF', glow: '#51EEFF' },
  O: { base: '#FFD52A', light: '#FFF5AC', dark: '#DAA315', glow: '#FFE861' },
  S: { base: '#74D749', light: '#DDFFAC', dark: '#3B9D32', glow: '#A4F26B' },
  L: { base: '#FF9741', light: '#FFE3A8', dark: '#D45B22', glow: '#FFB562' },
});

const contourCache = new Map();
const pointKey = (x, y) => `${x},${y}`;
const edgeKey = (a, b) => `${a.x},${a.y}>${b.x},${b.y}`;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/** Returns ordered boundary loops, without internal edges or collinear vertices. */
export function buildContours(cells) {
  const unique = new Map();
  for (const c of cells || []) {
    if (Number.isFinite(c.x) && Number.isFinite(c.y)) unique.set(pointKey(c.x, c.y), { x: c.x, y: c.y });
  }
  const sorted = [...unique.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  const key = sorted.map(p => pointKey(p.x, p.y)).join(';');
  if (contourCache.has(key)) return contourCache.get(key);
  const edges = new Map();
  for (const { x, y } of sorted) {
    const corners = [{ x, y }, { x: x + 1, y }, { x: x + 1, y: y + 1 }, { x, y: y + 1 }];
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      const reverse = edgeKey(b, a);
      if (edges.has(reverse)) edges.delete(reverse);
      else edges.set(edgeKey(a, b), { a, b });
    }
  }
  const outgoing = new Map();
  for (const [id, edge] of edges) {
    const k = pointKey(edge.a.x, edge.a.y);
    if (!outgoing.has(k)) outgoing.set(k, []);
    outgoing.get(k).push({ id, ...edge });
  }
  const remaining = new Set(edges.keys()), loops = [];
  while (remaining.size) {
    const startId = remaining.values().next().value;
    const first = edges.get(startId), loop = [];
    let edge = { id: startId, ...first };
    for (let safety = 0; edge && safety <= edges.size; safety++) {
      loop.push(edge.a); remaining.delete(edge.id);
      if (edge.b.x === first.a.x && edge.b.y === first.a.y) break;
      const candidates = (outgoing.get(pointKey(edge.b.x, edge.b.y)) || []).filter(e => remaining.has(e.id));
      // At diagonal contacts, a right turn keeps the separate gel islands separate.
      const dx = edge.b.x - edge.a.x, dy = edge.b.y - edge.a.y;
      const rank = e => {
        const nx = e.b.x - e.a.x, ny = e.b.y - e.a.y;
        const cross = dx * ny - dy * nx, dot = dx * nx + dy * ny;
        return cross > 0 ? 3 : dot > 0 ? 2 : cross < 0 ? 1 : 0;
      };
      candidates.sort((a, b) => rank(b) - rank(a));
      edge = candidates[0];
    }
    const corners = loop.filter((p, i) => {
      const a = loop[(i + loop.length - 1) % loop.length], b = loop[(i + 1) % loop.length];
      return (p.x - a.x) * (b.y - p.y) !== (p.y - a.y) * (b.x - p.x);
    });
    if (corners.length >= 3) loops.push(corners);
  }
  if (contourCache.size > 256) contourCache.clear();
  contourCache.set(key, loops);
  return loops;
}

function makePath(contours, map, rounding = .115) {
  const path = new Path2D();
  for (const vertices of contours) {
    const rounded = vertices.map((v, i) => {
      const prev = vertices[(i + vertices.length - 1) % vertices.length], next = vertices[(i + 1) % vertices.length];
      const inLength = Math.hypot(prev.x - v.x, prev.y - v.y), outLength = Math.hypot(next.x - v.x, next.y - v.y);
      const r = Math.min(rounding, inLength * .3, outLength * .3);
      return {
        v,
        entry: { x: v.x + (prev.x - v.x) / inLength * r, y: v.y + (prev.y - v.y) / inLength * r },
        exit: { x: v.x + (next.x - v.x) / outLength * r, y: v.y + (next.y - v.y) / outLength * r },
      };
    });
    let p = map(rounded[0].entry.x, rounded[0].entry.y);
    path.moveTo(p.x, p.y);
    for (let i = 0; i < rounded.length; i++) {
      const { v, exit } = rounded[i], next = rounded[(i + 1) % rounded.length].entry;
      const control = map(v.x, v.y), end = map(exit.x, exit.y);
      path.quadraticCurveTo(control.x, control.y, end.x, end.y);
      // Sampling lets a nonlinear body deformation bend long outside edges as well.
      const divisions = Math.max(1, Math.ceil(Math.hypot(next.x - exit.x, next.y - exit.y) / .27));
      for (let j = 1; j <= divisions; j++) {
        const t = j / divisions;
        p = map(exit.x + (next.x - exit.x) * t, exit.y + (next.y - exit.y) * t);
        path.lineTo(p.x, p.y);
      }
    }
    path.closePath();
  }
  return path;
}

function geometry(cells, opts) {
  const cellSize = opts.cellSize ?? 50, ox = opts.offsetX || 0, oy = opts.offsetY || 0;
  const deform = opts.deform || ((x, y) => ({ x, y }));
  const map = (x, y) => { const p = deform(x, y); return { x: p.x * cellSize + ox, y: p.y * cellSize + oy }; };
  const contours = buildContours(cells);
  const points = contours.flat().map(p => map(p.x, p.y));
  if (!points.length || cellSize <= 0) return null;
  const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
  return { cellSize, map, contours, path: makePath(contours, map, opts.rounding ?? .115), minX, maxX, minY, maxY };
}

/** Draw a seamless tetromino or row-cleared remainder. Coordinates are in cell units. */
export function renderGel(ctx, cells, options = {}) {
  if (!ctx || !cells?.length) return;
  const g = geometry(cells, options);
  if (!g) return;
  const { cellSize: s, map, path, minX, maxX, minY, maxY } = g;
  const color = PALETTE[options.type] || PALETTE.T;
  const w = Math.max(s * .3, maxX - minX), h = Math.max(s * .3, maxY - minY);
  ctx.save();
  ctx.globalAlpha *= clamp(options.alpha ?? 1, 0, 1);

  // Colour through the full volume; each tetromino is a single piece of gel.
  const body = ctx.createLinearGradient(minX, minY, maxX * .25 + minX * .75, maxY);
  body.addColorStop(0, color.light);
  body.addColorStop(.065, color.base);
  body.addColorStop(.5, color.base);
  body.addColorStop(.88, color.glow);
  body.addColorStop(1, color.dark);
  ctx.fillStyle = body;
  ctx.shadowColor = color.dark + '42';
  ctx.shadowOffsetY = s * .055;
  ctx.shadowBlur = s * .08;
  ctx.fill(path, 'evenodd');
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

  ctx.save();
  ctx.clip(path, 'evenodd');

  // A dark internal lip and opposite white lip create a rounded, wet edge.
  ctx.save();
  ctx.translate(-s * .022, -s * .035);
  ctx.strokeStyle = color.dark + 'A0';
  ctx.lineWidth = s * .15;
  ctx.lineJoin = 'round';
  ctx.stroke(path);
  ctx.restore();
  ctx.save();
  ctx.translate(s * .037, s * .042);
  const edgeLight = ctx.createLinearGradient(minX, minY, maxX, maxY);
  edgeLight.addColorStop(0, '#FFFFFFB5');
  edgeLight.addColorStop(.46, color.light + '75');
  edgeLight.addColorStop(1, '#FFFFFF3C');
  ctx.strokeStyle = edgeLight;
  ctx.lineWidth = s * .13;
  ctx.lineJoin = 'round';
  ctx.stroke(path);
  ctx.restore();

  // The centre transmits light, keeping the saturated rim visible.
  const transmission = ctx.createRadialGradient(minX + w * .62, minY + h * .42, 0,
    minX + w * .58, minY + h * .45, Math.max(w, h) * .67);
  transmission.addColorStop(0, color.light + '65');
  transmission.addColorStop(.5, color.glow + '26');
  transmission.addColorStop(1, color.dark + '16');
  ctx.fillStyle = transmission;
  ctx.fillRect(minX - s, minY - s, w + 2 * s, h + 2 * s);

  // A broad inner reflection follows the complete contour, including concave turns.
  ctx.save();
  ctx.translate(s * .073, s * .078);
  const sheen = ctx.createLinearGradient(minX, minY, minX + w * .2, maxY);
  sheen.addColorStop(0, '#FFFFFF8C');
  sheen.addColorStop(.4, '#FFFFFF15');
  sheen.addColorStop(.7, '#FFFFFF05');
  sheen.addColorStop(1, '#FFFFFF48');
  ctx.strokeStyle = sheen;
  ctx.lineWidth = s * .045;
  ctx.lineJoin = 'round';
  ctx.stroke(path);
  ctx.restore();

  const leftmost = Math.min(...cells.map(c => c.x));
  const lowLeft = cells.filter(c => c.x === leftmost).sort((a, b) => b.y - a.y)[0];
  const glint = (x, y, rx, ry, angle, alpha) => {
    const p = map(x, y), px = map(x + .1, y), py = map(x, y + .1);
    ctx.save();
    // Highlights deform with the material rather than floating over its surface.
    ctx.transform((px.x - p.x) / (.1 * s), (px.y - p.y) / (.1 * s),
      (py.x - p.x) / (.1 * s), (py.y - p.y) / (.1 * s), p.x, p.y);
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.beginPath(); ctx.ellipse(0, 0, rx * s, ry * s, angle, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  };
  if (lowLeft) {
    glint(lowLeft.x + .145, lowLeft.y + .70, .075, .12, -.20, .93);
    glint(lowLeft.x + .12, lowLeft.y + .485, .036, .052, -.16, .9);
  }
  const topmost = Math.min(...cells.map(c => c.y));
  const upperRight = cells.filter(c => c.y === topmost).sort((a, b) => b.x - a.x)[0];
  if (upperRight) {
    glint(upperRight.x + .76, upperRight.y + .13, .10, .027, .24, .50);
    glint(upperRight.x + .88, upperRight.y + .22, .023, .046, -.14, .31);
  }
  ctx.restore();

  // Thin outer contour is coloured gel, not a hard black outline.
  ctx.strokeStyle = color.dark + '65';
  ctx.lineWidth = Math.max(.75, s * .018);
  ctx.stroke(path);
  ctx.restore();
}

export function renderGhost(ctx, cells, options = {}) {
  if (!ctx || !cells?.length) return;
  const g = geometry(cells, options);
  if (!g) return;
  const color = PALETTE[options.type] || PALETTE.T;
  ctx.save();
  ctx.globalAlpha *= clamp(options.alpha ?? .4, 0, 1);
  ctx.fillStyle = color.light + '17';
  ctx.fill(g.path, 'evenodd');
  ctx.setLineDash([g.cellSize * .10, g.cellSize * .10]);
  ctx.lineWidth = Math.max(1, g.cellSize * .023);
  ctx.strokeStyle = color.dark + '70';
  ctx.stroke(g.path);
  ctx.restore();
}
