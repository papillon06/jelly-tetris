/** Continuous gel silhouettes: grid cells are only construction data, never visible seams. */
export const PALETTE = Object.freeze({
  T: { base: '#FA47A3', light: '#FFC3E5', dark: '#B8166D', glow: '#FF7CC5', rim: '#DC2082' },
  TR: { base: '#FA47A3', light: '#FFC3E5', dark: '#B8166D', glow: '#FF7CC5', rim: '#DC2082' },
  Z: { base: '#F5459C', light: '#FFC6E0', dark: '#B51A66', glow: '#FF7FB9', rim: '#D6207B' },
  J: { base: '#0E58F7', light: '#8ECEFF', dark: '#0B32AE', glow: '#448FFF', rim: '#0B43CF' },
  L: { base: '#0E58F7', light: '#8ECEFF', dark: '#0B32AE', glow: '#448FFF', rim: '#0B43CF' },
  I: { base: '#0AC2F5', light: '#AEFAFF', dark: '#057EB8', glow: '#5EEBFF', rim: '#0798D4' },
  C: { base: '#0AC2F5', light: '#AEFAFF', dark: '#057EB8', glow: '#5EEBFF', rim: '#0798D4' },
  O: { base: '#FFC71F', light: '#FFF6B3', dark: '#CF8D08', glow: '#FFE56B', rim: '#E09E0C' },
  S: { base: '#5EDB44', light: '#DCFFAD', dark: '#2F9626', glow: '#98F468', rim: '#42B532' },
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

function makePath(contours, map, rounding = .135) {
  const path = new Path2D();
  for (const vertices of contours) {
    const rounded = vertices.map((v, i) => {
      const prev = vertices[(i + vertices.length - 1) % vertices.length], next = vertices[(i + 1) % vertices.length];
      const inLength = Math.hypot(prev.x - v.x, prev.y - v.y), outLength = Math.hypot(next.x - v.x, next.y - v.y);
      const r = Math.min(rounding, inLength * .32, outLength * .32);
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
      // Dense sampling + midpoint quadratic smoothing lets soft-body bending curve long edges smoothly
      const divisions = Math.max(2, Math.ceil(Math.hypot(next.x - exit.x, next.y - exit.y) / .14));
      const samples = [];
      for (let j = 1; j <= divisions; j++) {
        const t = j / divisions;
        samples.push(map(exit.x + (next.x - exit.x) * t, exit.y + (next.y - exit.y) * t));
      }
      for (let j = 0; j < samples.length - 1; j++) {
        const cur = samples[j], nxt = samples[j + 1];
        path.quadraticCurveTo(cur.x, cur.y, (cur.x + nxt.x) * .5, (cur.y + nxt.y) * .5);
      }
      const last = samples[samples.length - 1];
      path.lineTo(last.x, last.y);
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
  return { cellSize, map, contours, path: makePath(contours, map, opts.rounding ?? .135), minX, maxX, minY, maxY };
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

  // 1. Translucent candy gel volume with soft drop shadow
  const body = ctx.createLinearGradient(minX, minY, minX + w * .25, maxY);
  body.addColorStop(0, color.light);
  body.addColorStop(.08, color.base);
  body.addColorStop(.58, color.base);
  body.addColorStop(.86, color.glow);
  body.addColorStop(1, color.dark);
  ctx.fillStyle = body;
  ctx.shadowColor = color.dark + '44';
  ctx.shadowOffsetY = s * .05;
  ctx.shadowBlur = s * .08;
  ctx.fill(path, 'evenodd');
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

  ctx.save();
  ctx.clip(path, 'evenodd');

  // 2. Thick rounded darker gel rim (圆润厚边，边缘颜色略深)
  ctx.save();
  ctx.strokeStyle = (color.rim || color.dark) + 'CC';
  ctx.lineWidth = s * .21;
  ctx.lineJoin = 'round';
  ctx.stroke(path);
  ctx.restore();

  // 3. Bottom depth shading (底缘稍深，立体果冻厚度感)
  ctx.save();
  ctx.translate(0, -s * .045);
  ctx.strokeStyle = color.dark + '95';
  ctx.lineWidth = s * .14;
  ctx.lineJoin = 'round';
  ctx.stroke(path);
  ctx.restore();

  // 4. Inner soft subsurface refraction / transmission (内部透光与柔和折射)
  const transmission = ctx.createRadialGradient(
    minX + w * .52, minY + h * .46, s * .05,
    minX + w * .50, minY + h * .48, Math.max(w, h) * .68
  );
  transmission.addColorStop(0, color.light + '88');
  transmission.addColorStop(.48, color.glow + '32');
  transmission.addColorStop(1, color.dark + '12');
  ctx.fillStyle = transmission;
  ctx.fillRect(minX - s, minY - s, w + 2 * s, h + 2 * s);

  // 5. Continuous wet inner rim highlight following all concave & convex turns
  ctx.save();
  ctx.translate(s * .042, s * .046);
  const edgeLight = ctx.createLinearGradient(minX, minY, maxX, maxY);
  edgeLight.addColorStop(0, '#FFFFFFCC');
  edgeLight.addColorStop(.45, color.light + '88');
  edgeLight.addColorStop(1, '#FFFFFF55');
  ctx.strokeStyle = edgeLight;
  ctx.lineWidth = s * .125;
  ctx.lineJoin = 'round';
  ctx.stroke(path);
  ctx.restore();

  ctx.save();
  ctx.translate(-s * .038, -s * .038);
  const bottomRim = ctx.createLinearGradient(minX, minY, maxX, maxY);
  bottomRim.addColorStop(0, '#FFFFFF20');
  bottomRim.addColorStop(.65, '#FFFFFF50');
  bottomRim.addColorStop(1, '#FFFFFF95');
  ctx.strokeStyle = bottomRim;
  ctx.lineWidth = s * .065;
  ctx.lineJoin = 'round';
  ctx.stroke(path);
  ctx.restore();

  // 6. Surface-following corner white highlights (角落白色高光，随形变和旋转一起变化)
  const glint = (x, y, rx, ry, angle, alpha) => {
    const p = map(x, y), px = map(x + .1, y), py = map(x, y + .1);
    ctx.save();
    ctx.transform(
      (px.x - p.x) / (.1 * s), (px.y - p.y) / (.1 * s),
      (py.x - p.x) / (.1 * s), (py.y - p.y) / (.1 * s),
      p.x, p.y
    );
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx * s, ry * s, angle, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const leftmost = Math.min(...cells.map(c => c.x));
  const lowLeft = cells.filter(c => c.x === leftmost).sort((a, b) => b.y - a.y)[0];
  if (lowLeft) {
    glint(lowLeft.x + .16, lowLeft.y + .72, .085, .135, -.22, .95);
    glint(lowLeft.x + .13, lowLeft.y + .48, .042, .058, -.16, .92);
  }

  const rightmost = Math.max(...cells.map(c => c.x));
  const lowRight = cells.filter(c => c.x === rightmost).sort((a, b) => b.y - a.y)[0];
  if (lowRight && lowRight !== lowLeft) {
    glint(lowRight.x + .74, lowRight.y + .78, .078, .052, -.28, .88);
    glint(lowRight.x + .54, lowRight.y + .82, .035, .028, -.12, .82);
  }

  const topmost = Math.min(...cells.map(c => c.y));
  const upperRight = cells.filter(c => c.y === topmost).sort((a, b) => b.x - a.x)[0];
  if (upperRight) {
    glint(upperRight.x + .77, upperRight.y + .18, .085, .125, -.24, .92);
    glint(upperRight.x + .83, upperRight.y + .42, .038, .055, -.14, .86);
  }

  const upperLeft = cells.filter(c => c.y === topmost).sort((a, b) => a.x - b.x)[0];
  if (upperLeft && upperLeft !== upperRight) {
    glint(upperLeft.x + .21, upperLeft.y + .16, .078, .048, -.18, .90);
    glint(upperLeft.x + .40, upperLeft.y + .15, .036, .030, -.08, .84);
  }

  ctx.restore();

  // Outer coloured gel edge
  ctx.strokeStyle = color.dark + '85';
  ctx.lineWidth = Math.max(1, s * .022);
  ctx.stroke(path);
  ctx.restore();
}

export function renderGhost(ctx, cells, options = {}) {
  if (!ctx || !cells?.length) return;
  const g = geometry(cells, options);
  if (!g) return;
  const color = PALETTE[options.type] || PALETTE.T;
  ctx.save();
  ctx.globalAlpha *= clamp(options.alpha ?? .35, 0, 1);
  ctx.fillStyle = color.light + '1C';
  ctx.fill(g.path, 'evenodd');
  ctx.setLineDash([g.cellSize * .10, g.cellSize * .10]);
  ctx.lineWidth = Math.max(1, g.cellSize * .023);
  ctx.strokeStyle = color.dark + '70';
  ctx.stroke(g.path);
  ctx.restore();
}
