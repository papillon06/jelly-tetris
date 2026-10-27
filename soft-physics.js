import { SHAPES } from './engine.js';
import { buildContours } from './gel-renderer.js';

export { SHAPES };

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const hypot = Math.hypot;

/**
 * Normalize a shape definition (either a 2D 0/1 matrix or an array of {x, y} cells)
 * into an array of integer {x, y} cell objects.
 */
export function normalizeCells(cellsOrMatrix) {
  if (!cellsOrMatrix) return [];
  if (Array.isArray(cellsOrMatrix[0]) && typeof cellsOrMatrix[0][0] === 'number') {
    const out = [];
    cellsOrMatrix.forEach((row, y) => row.forEach((v, x) => {
      if (v) out.push({ x, y });
    }));
    return out;
  }
  return cellsOrMatrix.map(c => ({ x: Number(c.x), y: Number(c.y) }));
}

function closestPointOnSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 > 1e-10 ? clamp(((px - ax) * abx + (py - ay) * aby) / len2, 0, 1) : 0;
  const qx = ax + abx * t, qy = ay + aby * t;
  return { x: qx, y: qy, t, dist2: (px - qx) ** 2 + (py - qy) ** 2 };
}

function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Compute the world-space bounding box of a soft body.
 */
export function getBodyBounds(body) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of body.nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Compute the world-space center of mass of a soft body.
 */
export function getBodyCentroid(body) {
  let sx = 0, sy = 0, wSum = 0;
  for (const n of body.nodes) {
    const w = n.mass || 1;
    sx += n.x * w;
    sy += n.y * w;
    wSum += w;
  }
  const inv = wSum > 0 ? 1 / wSum : 1 / (body.nodes.length || 1);
  return { x: sx * inv, y: sy * inv };
}

/**
 * Extract the best-fit rigid orientation angle (in radians) of a soft body
 * via 2D polar decomposition of its deformed nodes against its rest shape.
 */
export function getBodyAngle(body) {
  const c = getBodyCentroid(body);
  let dot = 0, cross = 0;
  for (const n of body.nodes) {
    const dx = n.x - c.x, dy = n.y - c.y;
    dot += n.rx * dx + n.ry * dy;
    cross += n.rx * dy - n.ry * dx;
  }
  return Math.atan2(cross, dot);
}

/**
 * Map a local coordinate (x, y) in the coordinate system of `body.cells`
 * to its deformed world-space coordinate `{ x, y }`.
 */
export function sampleBody(body, lx, ly) {
  if (!body || !body.subQuads?.length) return { x: lx, y: ly };

  const qx = Math.floor(lx * 2) / 2;
  const qy = Math.floor(ly * 2) / 2;
  let quad = body.subQuadMap.get(`${qx},${qy}`);

  if (!quad) {
    let bestD2 = Infinity;
    for (const q of body.subQuads) {
      const cx = q.lx + 0.25, cy = q.ly + 0.25;
      const d2 = (lx - cx) ** 2 + (ly - cy) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        quad = q;
      }
    }
  }

  const u = clamp((lx - quad.lx) / 0.5, -0.35, 1.35);
  const v = clamp((ly - quad.ly) / 0.5, -0.35, 1.35);
  const { n00, n10, n01, n11 } = quad;

  let wx = (1 - u) * (1 - v) * n00.x + u * (1 - v) * n10.x + (1 - u) * v * n01.x + u * v * n11.x;
  let wy = (1 - u) * (1 - v) * n00.y + u * (1 - v) * n10.y + (1 - u) * v * n01.y + u * v * n11.y;

  if (body.waveAmp > 0.002) {
    const angle = body._cachedAngle ?? 0;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const rx = lx - body.localCx, ry = ly - body.localCy;
    const phase = rx * 2.6 + ry * 2.1 - body.wavePhase;
    const ripple = Math.sin(phase) * body.waveAmp;
    wx += (cos * ripple * 0.42 - sin * ripple * 0.22) * (rx >= 0 ? 1 : -1);
    wy += (sin * ripple * 0.42 + cos * ripple * 0.22);
  }

  return { x: wx, y: wy };
}

/**
 * True 2D Corotational Soft-Body Physics World for Jelly Tetrominoes.
 * Combines:
 * - 0.5-cell sub-quad mass-spring lattice (structural, shear, and bending fibers)
 * - Exact cell area preservation (Poisson lateral bulge on vertical compression)
 * - Corotational polar-decomposition oscillator (unrestricted 360° tipping & rotation
 *   with underdamped 3.5 Hz jelly rebound & oscillation decay)
 * - Compound soft-disk volume colliders (5 disks per unit cell) for interpenetration-free
 *   contact, overhang tipping torque, and mutual lateral squeezing into empty slots.
 */
export class SoftWorld {
  constructor({
    width = 4,
    height = 8,
    gravity = 13.5,
    substeps = 12,
    wallPad = 0.02,
    floorFriction = 0.36,
    wallFriction = 0.05,
    bodyFriction = 0.18,
    onImpact = null,
  } = {}) {
    this.width = width;
    this.height = height;
    this.gravity = gravity;
    this.substeps = substeps;
    this.wallPad = wallPad;
    this.floorFriction = floorFriction;
    this.wallFriction = wallFriction;
    this.bodyFriction = bodyFriction;
    this.onImpact = onImpact;
    this.bodies = [];
    this._serial = 0;
    this.time = 0;
  }

  addBody(type, cellsOrMatrix, options = {}) {
    const rawCells = normalizeCells(cellsOrMatrix || SHAPES[type] || SHAPES.T);
    if (!rawCells.length) throw new Error('Soft body requires at least one cell.');

    const minCellX = Math.min(...rawCells.map(c => c.x));
    const maxCellX = Math.max(...rawCells.map(c => c.x)) + 1;
    const minCellY = Math.min(...rawCells.map(c => c.y));
    const maxCellY = Math.max(...rawCells.map(c => c.y)) + 1;

    const cells = rawCells.map(c => ({ x: c.x, y: c.y, type }));

    const nodeMap = new Map();
    const nodes = [];
    const getNode = (lx, ly) => {
      const key = `${lx},${ly}`;
      if (nodeMap.has(key)) return nodeMap.get(key);
      const node = {
        index: nodes.length,
        lx,
        ly,
        rx: 0,
        ry: 0,
        x: lx,
        y: ly,
        vx: 0,
        vy: 0,
        mass: 1,
        contactY: false,
      };
      nodeMap.set(key, node);
      nodes.push(node);
      return node;
    };

    const subQuads = [];
    const subQuadMap = new Map();
    const unitQuads = [];
    const colliders = [];

    for (const c of cells) {
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const lx = c.x + sx * 0.5;
          const ly = c.y + sy * 0.5;
          const n00 = getNode(lx, ly);
          const n10 = getNode(lx + 0.5, ly);
          const n01 = getNode(lx, ly + 0.5);
          const n11 = getNode(lx + 0.5, ly + 0.5);
          const quad = {
            lx,
            ly,
            cellX: c.x,
            cellY: c.y,
            n00,
            n10,
            n01,
            n11,
            restArea: 0.25,
          };
          subQuads.push(quad);
          subQuadMap.set(`${lx},${ly}`, quad);
          colliders.push({
            nodes: [n00, n10, n01, n11],
            radius: 0.245,
            x: 0,
            y: 0,
            vx: 0,
            vy: 0,
          });
        }
      }
      const u00 = getNode(c.x, c.y);
      const u10 = getNode(c.x + 1, c.y);
      const u01 = getNode(c.x, c.y + 1);
      const u11 = getNode(c.x + 1, c.y + 1);
      const uCenter = getNode(c.x + 0.5, c.y + 0.5);
      unitQuads.push({
        cellX: c.x,
        cellY: c.y,
        n00: u00,
        n10: u10,
        n01: u01,
        n11: u11,
        restArea: 1.0,
      });
      colliders.push({
        nodes: [uCenter, u00, u10, u01, u11],
        radius: 0.34,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
      });
    }

    const localCx = nodes.reduce((s, n) => s + n.lx, 0) / nodes.length;
    const localCy = nodes.reduce((s, n) => s + n.ly, 0) / nodes.length;
    let rotationalInertia = 0;
    for (const n of nodes) {
      n.rx = n.lx - localCx;
      n.ry = n.ly - localCy;
      rotationalInertia += n.rx * n.rx + n.ry * n.ry;
    }
    rotationalInertia = Math.max(0.5, rotationalInertia);

    const spawnX = options.x ?? (this.width - (maxCellX - minCellX)) * 0.5;
    const spawnY = options.y ?? 0;
    const angle = options.angle ?? 0;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const worldCx = spawnX + (localCx - minCellX);
    const worldCy = spawnY + (localCy - minCellY);
    const vx = options.vx ?? 0;
    const vy = options.vy ?? 0;
    const omega = options.angularVelocity ?? 0;

    for (const n of nodes) {
      const rx = n.rx * cos - n.ry * sin;
      const ry = n.rx * sin + n.ry * cos;
      n.x = worldCx + rx;
      n.y = worldCy + ry;
      n.vx = vx - omega * ry;
      n.vy = vy + omega * rx;
    }

    let shiftX = 0;
    const minNx = Math.min(...nodes.map(n => n.x));
    const maxNx = Math.max(...nodes.map(n => n.x));
    if (minNx < this.wallPad) shiftX = this.wallPad - minNx;
    else if (maxNx > this.width - this.wallPad) shiftX = (this.width - this.wallPad) - maxNx;
    if (shiftX !== 0) {
      for (const n of nodes) n.x += shiftX;
    }

    const springs = [];
    const seenPairs = new Set();
    const addSpring = (a, b, freq, dampRatio, relax) => {
      if (!a || !b || a === b) return;
      const i = Math.min(a.index, b.index), j = Math.max(a.index, b.index);
      const key = `${i}:${j}`;
      if (seenPairs.has(key)) return;
      seenPairs.add(key);
      const rest = hypot(b.lx - a.lx, b.ly - a.ly);
      springs.push({ a, b, rest, freq, dampRatio, relax });
    };

    const sScale = clamp(options.stiffness ?? 1, 0.6, 1.4);
    for (const n of nodes) {
      addSpring(n, nodeMap.get(`${n.lx + 0.5},${n.ly}`), 30 * sScale, 0.25, 0.28);
      addSpring(n, nodeMap.get(`${n.lx},${n.ly + 0.5}`), 30 * sScale, 0.25, 0.28);
      addSpring(n, nodeMap.get(`${n.lx + 0.5},${n.ly + 0.5}`), 25 * sScale, 0.25, 0.22);
      addSpring(n, nodeMap.get(`${n.lx - 0.5},${n.ly + 0.5}`), 25 * sScale, 0.25, 0.22);
      addSpring(n, nodeMap.get(`${n.lx + 1},${n.ly}`), 19 * sScale, 0.22, 0.14);
      addSpring(n, nodeMap.get(`${n.lx},${n.ly + 1}`), 19 * sScale, 0.22, 0.14);
      addSpring(n, nodeMap.get(`${n.lx + 1},${n.ly + 1}`), 16 * sScale, 0.22, 0.10);
      addSpring(n, nodeMap.get(`${n.lx - 1},${n.ly + 1}`), 16 * sScale, 0.22, 0.10);
      addSpring(n, nodeMap.get(`${n.lx + 1.5},${n.ly}`), 13 * sScale, 0.20, 0.06);
      addSpring(n, nodeMap.get(`${n.lx},${n.ly + 1.5}`), 13 * sScale, 0.20, 0.06);
      addSpring(n, nodeMap.get(`${n.lx + 2},${n.ly}`), 11 * sScale, 0.20, 0.04);
      addSpring(n, nodeMap.get(`${n.lx},${n.ly + 2}`), 11 * sScale, 0.20, 0.04);
    }

    const contours = buildContours(cells);
    const boundaryLoops = [];
    for (const loop of contours) {
      const bNodes = [];
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        const segLen = hypot(b.x - a.x, b.y - a.y);
        const steps = Math.max(1, Math.round(segLen * 2));
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          const lx = Math.round((a.x + (b.x - a.x) * t) * 2) / 2;
          const ly = Math.round((a.y + (b.y - a.y) * t) * 2) / 2;
          const nd = nodeMap.get(`${lx},${ly}`);
          if (nd && bNodes[bNodes.length - 1] !== nd) bNodes.push(nd);
        }
      }
      if (bNodes.length >= 4) boundaryLoops.push(bNodes);
    }

    const body = {
      id: options.id ?? ++this._serial,
      type: type || 'T',
      cells,
      minCellX,
      maxCellX,
      minCellY,
      maxCellY,
      localCx,
      localCy,
      rotationalInertia,
      nodes,
      nodeMap,
      subQuads,
      subQuadMap,
      unitQuads,
      colliders,
      springs,
      boundaryLoops,
      boundaryNodes: boundaryLoops[0] || nodes,
      gravityScale: options.gravityScale ?? 1,
      omega0: options.omega0 ?? 22,
      dampingRatio: options.dampingRatio ?? 0.26,
      isControlled: Boolean(options.isControlled),
      hasTouched: false,
      touchTime: 0,
      settleTime: 0,
      lastImpact: 0,
      waveAmp: 0,
      wavePhase: 0,
      peakSquash: 0,
      minHeightObserved: maxCellY - minCellY,
      maxWidthObserved: maxCellX - minCellX,
      _cachedCentroid: { x: worldCx, y: worldCy },
      _cachedAngle: angle,
      _cachedBounds: null,
    };

    this._updateBodyCache(body);
    this.bodies.push(body);
    return body;
  }

  removeBody(bodyOrId) {
    const id = typeof bodyOrId === 'object' ? bodyOrId.id : bodyOrId;
    const idx = this.bodies.findIndex(b => b.id === id);
    if (idx !== -1) this.bodies.splice(idx, 1);
  }

  _updateBodyCache(body) {
    body._cachedCentroid = getBodyCentroid(body);
    body._cachedAngle = getBodyAngle(body);
    body._cachedBounds = getBodyBounds(body);
    if (body._cachedBounds.height < body.minHeightObserved) {
      body.minHeightObserved = body._cachedBounds.height;
    }
    if (body._cachedBounds.width > body.maxWidthObserved) {
      body.maxWidthObserved = body._cachedBounds.width;
    }
  }

  applyImpulse(body, vx, vy) {
    for (const n of body.nodes) {
      n.vx += vx;
      n.vy += vy;
    }
  }

  applyTorqueAround(body, px, py, deltaOmega) {
    for (const n of body.nodes) {
      const rx = n.x - px, ry = n.y - py;
      n.vx -= deltaOmega * ry;
      n.vy += deltaOmega * rx;
    }
  }

  rotateBody(body, deltaAngle) {
    const c = getBodyCentroid(body);
    const cos = Math.cos(deltaAngle), sin = Math.sin(deltaAngle);
    for (const n of body.nodes) {
      const dx = n.x - c.x, dy = n.y - c.y;
      n.x = c.x + dx * cos - dy * sin;
      n.y = c.y + dx * sin + dy * cos;
      const vx = n.vx, vy = n.vy;
      n.vx = vx * cos - vy * sin;
      n.vy = vx * sin + vy * cos;
    }
    const b = getBodyBounds(body);
    let kx = 0, ky = 0;
    if (b.minX < this.wallPad) kx = this.wallPad - b.minX;
    else if (b.maxX > this.width - this.wallPad) kx = (this.width - this.wallPad) - b.maxX;
    if (b.maxY > this.height - this.wallPad) ky = (this.height - this.wallPad) - b.maxY;
    if (kx !== 0 || ky !== 0) {
      for (const n of body.nodes) {
        n.x += kx;
        n.y += ky;
      }
    }
    body.waveAmp = Math.max(body.waveAmp, 0.045);
    this._updateBodyCache(body);
  }

  step(dtSeconds) {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    const clampedDt = Math.min(0.035, dtSeconds);
    const substeps = this.substeps;
    const dt = clampedDt / substeps;
    this.time += clampedDt;

    for (const body of this.bodies) {
      body.wavePhase += clampedDt * 18;
      body.waveAmp *= Math.exp(-clampedDt * 3.8);
    }

    for (let step = 0; step < substeps; step++) {
      // 1. Gravity + Corotational Harmonic Shape Memory + Spring Damper Forces
      for (const body of this.bodies) {
        const g = this.gravity * body.gravityScale;
        const airDamp = Math.exp(-dt * 0.35);
        for (const n of body.nodes) {
          n.contactY = false;
          n.vy += g * dt;
          n.vx *= airDamp;
          n.vy *= airDamp;
        }
        this._applyCorotationalForces(body, dt);
        this._applySpringForces(body, dt);
      }

      // 2. Advance positions
      for (const body of this.bodies) {
        for (const n of body.nodes) {
          n.x += n.vx * dt;
          n.y += n.vy * dt;
        }
        // Gentle position-space area & spring relaxation (prevents cell inversion & preserves volume)
        this._solveAreaConservation(body, dt);
      }

      // 3. Compound Soft-Disk Inter-Body Collisions & Mutual Lateral Squeezing
      this._solveBodyCollisions(dt);

      // 4. Container Wall & Floor Collisions + Overhang Tipping Torque
      for (const body of this.bodies) {
        const supportPoints = this._solveContainerConstraints(body, dt);
        this._updateBodyCache(body);
        if (supportPoints.length > 0) {
          this._applyOverhangTipping(body, supportPoints, dt);
        }
      }
    }

    for (const body of this.bodies) {
      this._updateBodyCache(body);
      const speed = hypot(
        body.nodes.reduce((s, n) => s + n.vx, 0) / body.nodes.length,
        body.nodes.reduce((s, n) => s + n.vy, 0) / body.nodes.length
      );
      if (body.hasTouched && speed < 0.42) {
        body.settleTime += clampedDt;
      } else if (speed > 0.85) {
        body.settleTime = Math.max(0, body.settleTime - clampedDt * 0.5);
      }
    }
  }

  _applyCorotationalForces(body, dt) {
    const nodes = body.nodes;
    const N = nodes.length;
    let cx = 0, cy = 0, vxAvg = 0, vyAvg = 0;
    for (let i = 0; i < N; i++) {
      const n = nodes[i];
      cx += n.x;
      cy += n.y;
      vxAvg += n.vx;
      vyAvg += n.vy;
    }
    cx /= N;
    cy /= N;
    vxAvg /= N;
    vyAvg /= N;

    let dot = 0, cross = 0, angMom = 0, r2Sum = 0;
    for (let i = 0; i < N; i++) {
      const n = nodes[i];
      const dx = n.x - cx, dy = n.y - cy;
      dot += n.rx * dx + n.ry * dy;
      cross += n.rx * dy - n.ry * dx;
      angMom += dx * (n.vy - vyAvg) - dy * (n.vx - vxAvg);
      r2Sum += dx * dx + dy * dy;
    }

    const angle = Math.atan2(cross, dot);
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const omegaAvg = r2Sum > 0.1 ? angMom / r2Sum : 0;

    const w0 = body.omega0;
    const k = w0 * w0;
    const cDamp = 2 * body.dampingRatio * w0;

    for (let i = 0; i < N; i++) {
      const n = nodes[i];
      const tx = cx + n.rx * cos - n.ry * sin;
      const ty = cy + n.rx * sin + n.ry * cos;
      const dx = n.x - cx, dy = n.y - cy;
      const tvx = vxAvg - omegaAvg * dy;
      const tvy = vyAvg + omegaAvg * dx;

      n.vx += (k * (tx - n.x) - cDamp * (n.vx - tvx)) * dt;
      n.vy += (k * (ty - n.y) - cDamp * (n.vy - tvy)) * dt;
    }
  }

  _applySpringForces(body, dt) {
    for (const s of body.springs) {
      const { a, b, rest, freq, dampRatio, relax } = s;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = hypot(dx, dy);
      if (dist < 1e-8) continue;
      const ux = dx / dist, uy = dy / dist;
      const stretch = dist - rest;
      const relV = (b.vx - a.vx) * ux + (b.vy - a.vy) * uy;
      const k = freq * freq * 0.35;
      const c = 2 * dampRatio * freq * 0.35;
      const impulse = (k * stretch + c * relV) * dt * 0.5;

      a.vx += ux * impulse;
      a.vy += uy * impulse;
      b.vx -= ux * impulse;
      b.vy -= uy * impulse;

      // Mild position relaxation keeps mesh crisp
      const pCorr = stretch * relax * 0.25;
      a.x += ux * pCorr;
      a.y += uy * pCorr;
      b.x -= ux * pCorr;
      b.y -= uy * pCorr;
    }
  }

  _solveAreaConservation(body, dt) {
    const solveQuadList = (quads, kPos, kVel) => {
      for (const q of quads) {
        const { n00, n10, n11, n01, restArea } = q;
        const d0x = n11.x - n00.x, d0y = n11.y - n00.y;
        const d1x = n01.x - n10.x, d1y = n01.y - n10.y;
        const area = 0.5 * (d0x * d1y - d0y * d1x);
        const err = restArea - area;
        if (Math.abs(err) < 1e-5) continue;

        const g00x = -0.5 * d1y, g00y = 0.5 * d1x;
        const g11x = 0.5 * d1y, g11y = -0.5 * d1x;
        const g10x = 0.5 * d0y, g10y = -0.5 * d0x;
        const g01x = -0.5 * d0y, g01y = 0.5 * d0x;
        const denom = g00x * g00x + g00y * g00y + g11x * g11x + g11y * g11y +
          g10x * g10x + g10y * g10y + g01x * g01x + g01y * g01y;
        if (denom < 1e-8) continue;

        const scalePos = (err / denom) * kPos;
        const scaleVel = (err / denom) * kVel * dt;
        n00.x += g00x * scalePos; n00.y += g00y * scalePos;
        n11.x += g11x * scalePos; n11.y += g11y * scalePos;
        n10.x += g10x * scalePos; n10.y += g10y * scalePos;
        n01.x += g01x * scalePos; n01.y += g01y * scalePos;

        n00.vx += g00x * scaleVel; n00.vy += g00y * scaleVel;
        n11.vx += g11x * scaleVel; n11.vy += g11y * scaleVel;
        n10.vx += g10x * scaleVel; n10.vy += g10y * scaleVel;
        n01.vx += g01x * scaleVel; n01.vy += g01y * scaleVel;
      }
    };

    solveQuadList(body.subQuads, 0.72, 26);
    solveQuadList(body.unitQuads, 0.55, 18);
  }

  _applyImpactDeformation(body, power) {
    const bounds = getBodyBounds(body);
    const c = getBodyCentroid(body);
    const h = Math.max(0.5, bounds.height);
    body.waveAmp = Math.min(0.12, body.waveAmp + power * 0.14);
    body.peakSquash = Math.max(body.peakSquash, power);

    for (const n of body.nodes) {
      const relY = clamp((n.y - bounds.minY) / h, 0, 1);
      const bulge = (0.35 + 0.65 * relY) * power;
      // Squash down + Poisson lateral bulge velocity (lets harmonic oscillator rebound smoothly)
      n.x = clamp(n.x + (n.x - c.x) * bulge * 0.18, this.wallPad, this.width - this.wallPad);
      n.y = Math.min(this.height - this.wallPad, n.y + (bounds.maxY - n.y) * power * 0.16);
      n.vx += (n.x - c.x) * bulge * 2.6;
      n.vy += (bounds.maxY - n.y) * power * 1.4;
    }
    this._updateBodyCache(body);
  }

  _applyOverhangTipping(body, supportPoints, dt) {
    const c = body._cachedCentroid || getBodyCentroid(body);
    let minSupX = Infinity, maxSupX = -Infinity;
    let minSupNode = supportPoints[0], maxSupNode = supportPoints[0];

    for (const p of supportPoints) {
      if (p.x < minSupX) { minSupX = p.x; minSupNode = p; }
      if (p.x > maxSupX) { maxSupX = p.x; maxSupNode = p; }
    }

    const supportSpan = maxSupX - minSupX;
    const bodySpan = Math.max(0.8, body._cachedBounds?.width || 1);
    let lever = 0;
    let pivot = null;

    if (c.x > maxSupX - 0.04 && supportSpan < bodySpan * 0.72) {
      lever = c.x - maxSupX + 0.1;
      pivot = maxSupNode;
    } else if (c.x < minSupX + 0.04 && supportSpan < bodySpan * 0.72) {
      lever = c.x - minSupX - 0.1;
      pivot = minSupNode;
    }

    if (pivot && Math.abs(lever) > 0.02) {
      const angularAcc = (this.gravity * lever * 2.2) / Math.max(0.6, body.rotationalInertia * 0.25);
      const dOmega = clamp(angularAcc * dt, -0.45, 0.45);
      for (const n of body.nodes) {
        const rx = n.x - pivot.x, ry = n.y - pivot.y;
        n.vx -= dOmega * ry;
        n.vy += dOmega * rx;
        if (Math.sign(rx) === Math.sign(lever) && Math.abs(rx) > 0.3) {
          n.vy += Math.abs(rx) * Math.abs(dOmega) * 0.35;
        }
      }
    }
  }

  _solveContainerConstraints(body, dt) {
    const minX = this.wallPad;
    const maxX = this.width - this.wallPad;
    const maxY = this.height - this.wallPad;
    const floorFric = Math.exp(-dt * this.floorFriction * 22);
    const wallFric = Math.exp(-dt * this.wallFriction * 12);
    const supportPoints = [];
    let maxImpactVy = 0;

    for (const n of body.nodes) {
      if (n.x < minX) {
        n.x = minX;
        if (n.vx < 0) n.vx = -n.vx * 0.22;
        n.vy *= wallFric;
      } else if (n.x > maxX) {
        n.x = maxX;
        if (n.vx > 0) n.vx = -n.vx * 0.22;
        n.vy *= wallFric;
      }

      if (n.y > maxY) {
        n.y = maxY;
        n.contactY = true;
        supportPoints.push(n);
        if (n.vy > maxImpactVy) maxImpactVy = n.vy;
        if (n.vy > 0) {
          n.vy = n.vy > 1.25 ? -n.vy * 0.28 : 0;
        }
        n.vx *= floorFric;
      } else if (n.contactY) {
        supportPoints.push(n);
      }
    }

    if (maxImpactVy > 1.8 && !body.hasTouched) {
      const power = clamp((maxImpactVy - 1.4) * 0.14, 0.08, 0.48);
      this._applyImpactDeformation(body, power);
      body.hasTouched = true;
      body.touchTime = this.time;
      body.lastImpact = Math.max(body.lastImpact, power);
      if (this.onImpact) this.onImpact({ body, power, velocity: maxImpactVy });
    } else if (supportPoints.length > 0 && !body.hasTouched) {
      body.hasTouched = true;
      body.touchTime = this.time;
    }

    return supportPoints;
  }

  _updateColliders(body) {
    for (const col of body.colliders) {
      let sx = 0, sy = 0, svx = 0, svy = 0;
      const ns = col.nodes;
      const len = ns.length;
      for (let i = 0; i < len; i++) {
        const n = ns[i];
        sx += n.x;
        sy += n.y;
        svx += n.vx;
        svy += n.vy;
      }
      const inv = 1 / len;
      col.x = sx * inv;
      col.y = sy * inv;
      col.vx = svx * inv;
      col.vy = svy * inv;
    }
  }

  _solveBodyCollisions(dt) {
    const nBodies = this.bodies.length;
    if (nBodies < 2) return;

    for (const b of this.bodies) {
      this._updateBodyCache(b);
      this._updateColliders(b);
    }

    for (let i = 0; i < nBodies; i++) {
      const A = this.bodies[i];
      for (let j = i + 1; j < nBodies; j++) {
        const B = this.bodies[j];
        const bA = A._cachedBounds, bB = B._cachedBounds;
        if (
          bA.maxX + 0.15 < bB.minX ||
          bB.maxX + 0.15 < bA.minX ||
          bA.maxY + 0.15 < bB.minY ||
          bB.maxY + 0.15 < bA.minY
        ) {
          continue;
        }

        let pairContacts = 0;
        let maxImpactRelVy = 0;
        let netNx = 0, netNy = 0;

        const colsA = A.colliders, colsB = B.colliders;
        for (let ia = 0; ia < colsA.length; ia++) {
          const cA = colsA[ia];
          for (let ib = 0; ib < colsB.length; ib++) {
            const cB = colsB[ib];
            const minSep = cA.radius + cB.radius;
            const dx = cB.x - cA.x;
            if (Math.abs(dx) >= minSep) continue;
            const dy = cB.y - cA.y;
            if (Math.abs(dy) >= minSep) continue;

            const d2 = dx * dx + dy * dy;
            if (d2 >= minSep * minSep) continue;

            const dist = Math.sqrt(d2);
            let nx, ny;
            if (dist > 1e-6) {
              nx = dx / dist;
              ny = dy / dist;
            } else {
              const cdx = B._cachedCentroid.x - A._cachedCentroid.x;
              const cdy = B._cachedCentroid.y - A._cachedCentroid.y;
              const clen = hypot(cdx, cdy) || 1;
              nx = cdx / clen;
              ny = cdy / clen;
            }

            const overlap = minSep - dist;
            pairContacts++;
            netNx += nx;
            netNy += ny;

            const posCorr = overlap * 0.36;
            const px = nx * posCorr, py = ny * posCorr;
            for (const n of cA.nodes) {
              n.x -= px;
              n.y -= py;
              if (ny > 0.35) n.contactY = true;
            }
            for (const n of cB.nodes) {
              n.x += px;
              n.y += py;
              if (ny < -0.35) n.contactY = true;
            }

            const rvx = cB.vx - cA.vx;
            const rvy = cB.vy - cA.vy;
            const vn = rvx * nx + rvy * ny;
            if (vn < 0) {
              if (-vn > maxImpactRelVy) maxImpactRelVy = -vn;
              const restitution = -vn > 1.2 ? 0.22 : 0.04;
              const jn = -(1 + restitution) * vn * 0.25;
              const jnx = nx * jn, jny = ny * jn;

              const tx = -ny, ty = nx;
              const vt = rvx * tx + rvy * ty;
              const jt = -vt * this.bodyFriction * 0.2;
              const jtx = tx * jt, jty = ty * jt;

              for (const n of cA.nodes) {
                n.vx -= jnx + jtx;
                n.vy -= jny + jty;
              }
              for (const n of cB.nodes) {
                n.vx += jnx + jtx;
                n.vy += jny + jty;
              }
            }
          }
        }

        if (pairContacts > 0) {
          const cdx = B._cachedCentroid.x - A._cachedCentroid.x;
          const horizDir = Math.abs(cdx) > 0.04 ? Math.sign(cdx) : (netNx >= 0 ? 1 : -1);
          const squeezeVel = horizDir * clamp(pairContacts * 0.18, 0.3, 1.6) * dt;
          for (const n of A.nodes) n.vx -= squeezeVel;
          for (const n of B.nodes) n.vx += squeezeVel;

          if (maxImpactRelVy > 1.8 && (!A.hasTouched || !B.hasTouched)) {
            const power = clamp((maxImpactRelVy - 1.4) * 0.12, 0.06, 0.38);
            this._applyImpactDeformation(A, power * 0.8);
            this._applyImpactDeformation(B, power * 0.8);
            A.hasTouched = true;
            B.hasTouched = true;
          } else {
            if (netNy > 0.2) A.hasTouched = true;
            if (netNy < -0.2) B.hasTouched = true;
          }
        }
      }
    }
  }

  getRowCoverageStats({ includeControlled = false, samplesPerCol = 10, samplesY = 5 } = {}) {
    const stats = Array.from({ length: this.height }, () => ({
      ratio: 0,
      minColRatio: 0,
      maxGap: this.width,
      colRatios: new Array(this.width).fill(0),
    }));
    const candidates = this.bodies.filter(b => (includeControlled || !b.isControlled) && b.hasTouched);
    if (!candidates.length) return stats;

    for (const b of candidates) {
      b._cachedBounds = getBodyBounds(b);
    }

    const skin2 = 0.028 * 0.028;
    const pointOccupied = (wx, wy) => {
      for (const b of candidates) {
        const bounds = b._cachedBounds;
        if (wx < bounds.minX - 0.035 || wx > bounds.maxX + 0.035 || wy < bounds.minY - 0.035 || wy > bounds.maxY + 0.035) {
          continue;
        }
        const loop = b.boundaryNodes;
        if (pointInPolygon(wx, wy, loop)) return true;
        for (let i = 0; i < loop.length; i++) {
          const a = loop[i], c = loop[(i + 1) % loop.length];
          if (closestPointOnSegment(wx, wy, a.x, a.y, c.x, c.y).dist2 <= skin2) {
            return true;
          }
        }
      }
      return false;
    };

    const totalSamplesX = this.width * samplesPerCol;
    const dx = 1 / samplesPerCol;

    for (let row = 0; row < this.height; row++) {
      let rowFilled = 0;
      const colFilled = new Array(this.width).fill(0);
      let maxEmptyRun = 0;

      // Sample central 80% vertical band [row + 0.1 .. row + 0.9] so top/bottom rounded corners don't skew
      for (let sy = 0; sy < samplesY; sy++) {
        const wy = row + 0.1 + ((sy + 0.5) / samplesY) * 0.8;
        let currentEmptyRun = 0;
        for (let sx = 0; sx < totalSamplesX; sx++) {
          const wx = (sx + 0.5) * dx;
          const col = Math.min(this.width - 1, Math.floor(wx));
          if (pointOccupied(wx, wy)) {
            rowFilled++;
            colFilled[col]++;
            if (currentEmptyRun > maxEmptyRun) maxEmptyRun = currentEmptyRun;
            currentEmptyRun = 0;
          } else {
            currentEmptyRun++;
          }
        }
        if (currentEmptyRun > maxEmptyRun) maxEmptyRun = currentEmptyRun;
      }

      const samplesPerColTotal = samplesPerCol * samplesY;
      const colRatios = colFilled.map(c => c / samplesPerColTotal);
      stats[row] = {
        ratio: rowFilled / (totalSamplesX * samplesY),
        minColRatio: Math.min(...colRatios),
        maxGap: maxEmptyRun * dx,
        colRatios,
      };
    }
    return stats;
  }

  getRowFillRatios(options = {}) {
    return this.getRowCoverageStats(options).map(s => s.ratio);
  }

  clearFilledRows({
    threshold = 0.92,
    minColRatio = 0.82,
    maxGap = 0.24,
  } = {}) {
    const stats = this.getRowCoverageStats({ includeControlled: false });
    const ratios = stats.map(s => s.ratio);
    const rows = [];
    for (let r = 0; r < this.height; r++) {
      const s = stats[r];
      if (s.ratio >= threshold && s.minColRatio >= minColRatio && s.maxGap <= maxGap) {
        rows.push(r);
      }
    }
    if (!rows.length) return null;

    const rowSet = new Set(rows);
    const clearedVisuals = [];
    const nextBodies = [];

    for (const body of this.bodies) {
      if (body.isControlled) {
        nextBodies.push(body);
        continue;
      }

      const keptCells = [];
      const removedCells = [];
      const cellWorldMap = new Map();

      for (const c of body.cells) {
        const wCenter = sampleBody(body, c.x + 0.5, c.y + 0.5);
        const bandRow = clamp(Math.floor(wCenter.y), 0, this.height - 1);
        cellWorldMap.set(`${c.x},${c.y}`, wCenter);
        if (rowSet.has(bandRow)) {
          removedCells.push({ ...c, wx: wCenter.x, wy: wCenter.y, type: body.type, id: body.id });
        } else {
          keptCells.push(c);
        }
      }

      if (!removedCells.length) {
        const c = getBodyCentroid(body);
        if (rows.some(r => c.y < r + 0.5)) {
          body.settleTime = 0;
          for (const n of body.nodes) n.vy += 0.45;
        }
        nextBodies.push(body);
        continue;
      }

      clearedVisuals.push({
        type: body.type,
        id: body.id,
        cells: removedCells,
      });

      if (!keptCells.length) continue;

      const islands = connectedCellIslands(keptCells);
      const angle = getBodyAngle(body);
      for (const island of islands) {
        const avgWorld = island.reduce((acc, cell) => {
          const w = cellWorldMap.get(`${cell.x},${cell.y}`);
          acc.x += w.x;
          acc.y += w.y;
          return acc;
        }, { x: 0, y: 0 });
        avgWorld.x /= island.length;
        avgWorld.y /= island.length;

        const minIx = Math.min(...island.map(c => c.x));
        const maxIx = Math.max(...island.map(c => c.x)) + 1;
        const minIy = Math.min(...island.map(c => c.y));
        const maxIy = Math.max(...island.map(c => c.y)) + 1;

        const remBody = this.addBody(body.type, island, {
          x: clamp(avgWorld.x - (maxIx - minIx) * 0.5, this.wallPad, this.width - (maxIx - minIx) - this.wallPad),
          y: avgWorld.y - (maxIy - minIy) * 0.5,
          angle: angle + (Math.random() - 0.5) * 0.08,
          vy: 0.45,
        });
        this.bodies.pop();
        remBody.hasTouched = false;
        nextBodies.push(remBody);
      }
    }

    this.bodies = nextBodies;
    return { rows, clearedVisuals, ratios };
  }
}

function connectedCellIslands(cells) {
  const byKey = new Map(cells.map(c => [`${c.x},${c.y}`, c]));
  const visited = new Set();
  const islands = [];

  for (const cell of cells) {
    const startKey = `${cell.x},${cell.y}`;
    if (visited.has(startKey)) continue;
    const queue = [cell];
    visited.add(startKey);
    const group = [];
    while (queue.length) {
      const cur = queue.shift();
      group.push(cur);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${cur.x + dx},${cur.y + dy}`;
        if (byKey.has(k) && !visited.has(k)) {
          visited.add(k);
          queue.push(byKey.get(k));
        }
      }
    }
    islands.push(group);
  }
  return islands;
}

/**
 * Extended piece definitions including the 3-cell corner block ('C') from the reference video.
 */
export const JELLY_SHAPES = Object.freeze({
  T: [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
  TR: [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }],
  J: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }],
  L: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }],
  O: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
  I: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }],
  C: [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
  S: [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
  Z: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
});

const PLAYABLE_BAG = ['T', 'J', 'L', 'O', 'C', 'I', 'S', 'Z'];

/**
 * Playable & Demo-capable Soft-Body Jelly Tetris Engine.
 */
export class SoftJellyGame {
  constructor({
    width = 6,
    height = 10,
    dangerLineY = 2.1,
    onEvent = () => {},
    random = Math.random,
  } = {}) {
    this.width = width;
    this.height = height;
    this.dangerLineY = dangerLineY;
    this.onEvent = onEvent;
    this.random = random;
    this.state = 'idle';
    this.mode = 'play'; // 'play' | 'video-demo' | 'squeeze-demo'
    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.combo = 0;
    this.next = [];
    this._bag = [];
    this.active = null;
    this._spawnTimer = 0;
    this._demoSteps = [];
    this._demoIndex = 0;
    this._demoClock = 0;
    this.skyProgress = 0; // 0 = bright day (sun), 0.5 = warm dusk, 1 = night (moon)

    this.world = new SoftWorld({
      width,
      height,
      onImpact: ({ body, power, velocity }) => {
        this._emit('contact', { body, impact: power, velocity });
      },
    });
  }

  _emit(type, detail = {}) {
    this.onEvent({ type, ...detail });
  }

  _nextType() {
    if (!this._bag.length) {
      this._bag = [...PLAYABLE_BAG];
      for (let i = this._bag.length - 1; i > 0; i--) {
        const j = Math.min(i, Math.max(0, Math.floor(this.random() * (i + 1))));
        [this._bag[i], this._bag[j]] = [this._bag[j], this._bag[i]];
      }
    }
    return this._bag.pop();
  }

  _fillQueue() {
    while (this.next.length < 4) {
      this.next.push(this._nextType());
    }
  }

  start(mode = 'play') {
    this.mode = mode;
    this.world.bodies = [];
    this.active = null;
    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.combo = 0;
    this.next = [];
    this._bag = [];
    this._spawnTimer = 0.15;
    this._demoIndex = 0;
    this._demoClock = 0;
    this.skyProgress = 0;
    this.state = 'playing';

    if (mode === 'video-demo') {
      // Reference video choreography adapted to the wider 6x10 container
      this._demoSteps = [
        {
          delay: 0.15,
          type: 'T',
          cells: JELLY_SHAPES.T,
          x: 0.35,
          y: -1.6,
          vy: 2.3,
          angle: 0,
          caption: '1/6 玫粉 T 形果冻加速下落，触底压扁回弹',
        },
        {
          delay: 2.6,
          type: 'T',
          cells: JELLY_SHAPES.TR,
          x: 2.45,
          y: -1.8,
          vy: 2.5,
          angle: 0.04,
          caption: '2/6 转向粉色果冻落向中右侧，与已有果冻挤压接触',
        },
        {
          delay: 5.2,
          type: 'J',
          cells: JELLY_SHAPES.J,
          x: 0.25,
          y: -1.8,
          vy: 2.6,
          angle: -0.05,
          caption: '3/6 宝蓝 L/J 形落点偏斜，连体弯曲并向一侧歪倒挤动',
        },
        {
          delay: 8.0,
          type: 'O',
          cells: JELLY_SHAPES.O,
          x: 3.75,
          y: -1.8,
          vy: 2.7,
          angle: 0.05,
          caption: '4/6 明黄方形落入右侧，碰撞挤压相邻果冻滑入空位',
        },
        {
          delay: 10.8,
          type: 'O',
          cells: JELLY_SHAPES.O,
          x: 0.65,
          y: -1.8,
          vy: 2.7,
          angle: 0.03,
          caption: '5/6 明黄方形压住蓝色果冻，引起局部压缩与二次滑动',
        },
        {
          delay: 13.5,
          type: 'I',
          cells: JELLY_SHAPES.C,
          x: 2.65,
          y: -1.8,
          vy: 2.7,
          angle: -0.04,
          caption: '6/6 青蓝弯折块填入剩余空间，挤开相邻果冻并一起停稳',
        },
      ];
      this.next = ['T', 'J', 'O', 'I'];
    } else if (mode === 'squeeze-demo') {
      // Dedicated showcase of center-of-mass toppling + lateral squeezing into empty slot + row clear
      this._demoSteps = [
        {
          delay: 0.1,
          type: 'O',
          cells: JELLY_SHAPES.O,
          x: 0.9,
          y: 7.2,
          vy: 1.5,
          angle: 0,
          caption: '实验 1：底部果冻落在偏左位置，右侧与左侧留出空位',
        },
        {
          delay: 1.4,
          type: 'O',
          cells: JELLY_SHAPES.O,
          x: 3.9,
          y: 7.2,
          vy: 1.5,
          angle: 0,
          caption: '实验 1：右侧再放入一块果冻，中间留出两格偏斜空隙',
        },
        {
          delay: 3.0,
          type: 'O',
          cells: JELLY_SHAPES.O,
          x: 1.85,
          y: -1.2,
          vy: 4.2,
          angle: 0.08,
          caption: '实验 2：新果冻斜撞肩部，把下方果冻挤进左侧空位并填满整行消除！',
        },
        {
          delay: 6.5,
          type: 'T',
          cells: JELLY_SHAPES.T,
          x: 0.2,
          y: -1.4,
          vy: 2.6,
          angle: 0,
          caption: '实验 3：玫粉 T 形果冻落下奠定不对称支撑台阶',
        },
        {
          delay: 9.2,
          type: 'L',
          cells: JELLY_SHAPES.L,
          x: 1.15,
          y: -1.6,
          vy: 2.9,
          angle: 0.22,
          caption: '实验 4：宝蓝长臂落在台阶边缘，重心失衡大幅歪倒翻入右侧空位！',
        },
      ];
      this.next = ['O', 'T', 'L'];
    } else {
      this._fillQueue();
    }

    this._emit('state', { state: this.state, mode: this.mode });
  }

  togglePause() {
    if (!['playing', 'paused'].includes(this.state)) return false;
    this.state = this.state === 'playing' ? 'paused' : 'playing';
    this._emit('state', { state: this.state, mode: this.mode });
    return true;
  }

  _spawnNextPlayable() {
    const type = this.next.shift() || this._nextType();
    this._fillQueue();
    const cells = JELLY_SHAPES[type] || JELLY_SHAPES.T;
    const minX = Math.min(...cells.map(c => c.x));
    const maxX = Math.max(...cells.map(c => c.x)) + 1;
    const spanX = maxX - minX;
    const x = clamp((this.width - spanX) * 0.5 + (this.random() - 0.5) * 0.2, 0.08, this.width - spanX - 0.08);

    const body = this.world.addBody(type === 'C' ? 'I' : type, cells, {
      x,
      y: -1.45,
      vy: 1.65 + Math.min(1.5, (this.level - 1) * 0.15),
      angle: (this.random() - 0.5) * 0.06,
      isControlled: true,
      gravityScale: 0.72,
    });
    body.pieceKind = type;
    this.active = body;
    this._emit('spawn', { body, next: [...this.next] });
  }

  move(dir) {
    if (this.state !== 'playing' || !this.active) return false;
    const sign = Math.sign(dir);
    if (!sign) return false;
    const bounds = getBodyBounds(this.active);
    const stepX = 0.42 * sign;
    const allowed = sign < 0
      ? Math.max(stepX, this.world.wallPad - bounds.minX)
      : Math.min(stepX, (this.width - this.world.wallPad) - bounds.maxX);

    for (const n of this.active.nodes) {
      n.x += allowed * 0.68;
      n.vx = clamp(n.vx + sign * 2.1, -5.5, 5.5);
    }
    // Slight inertial tilt when steering horizontally
    this.world.applyTorqueAround(
      this.active,
      this.active._cachedCentroid.x,
      this.active._cachedCentroid.y,
      sign * 0.32
    );
    this.active.waveAmp = Math.max(this.active.waveAmp, 0.03);
    this.world._updateBodyCache(this.active);
    this._emit('move', { dir: sign, body: this.active });
    return true;
  }

  rotate(dir = 1) {
    if (this.state !== 'playing' || !this.active) return false;
    const sign = dir >= 0 ? 1 : -1;
    this.world.rotateBody(this.active, sign * (Math.PI * 0.5));
    this._emit('rotate', { dir: sign, body: this.active });
    return true;
  }

  softDrop() {
    if (this.state !== 'playing' || !this.active) return false;
    this.active.gravityScale = 1.45;
    for (const n of this.active.nodes) {
      n.vy = Math.max(n.vy + 1.8, 5.2);
    }
    this.score += 1;
    return true;
  }

  hardDrop() {
    if (this.state !== 'playing' || !this.active) return false;
    this.active.gravityScale = 1.85;
    for (const n of this.active.nodes) {
      n.vy = Math.max(n.vy + 4.8, 8.2);
    }
    this.score += 6;
    this._emit('drop', { body: this.active });
    return true;
  }

  update(dtSeconds) {
    if (this.state !== 'playing' || !Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    const dt = Math.min(0.035, dtSeconds);

    if (this.mode === 'video-demo' || this.mode === 'squeeze-demo') {
      this._demoClock += dt;
      this.skyProgress = clamp(this._demoClock / 16.5, 0, 1);

      while (
        this._demoIndex < this._demoSteps.length &&
        this._demoClock >= this._demoSteps[this._demoIndex].delay
      ) {
        const stepSpec = this._demoSteps[this._demoIndex++];
        if (this.active) this.active.isControlled = false;
        const b = this.world.addBody(stepSpec.type, stepSpec.cells, {
          x: stepSpec.x,
          y: stepSpec.y,
          vy: stepSpec.vy,
          angle: stepSpec.angle,
          isControlled: true,
        });
        this.active = b;
        this.next = this._demoSteps.slice(this._demoIndex).map(s => s.type);
        this._emit('demo-step', { step: stepSpec, index: this._demoIndex, total: this._demoSteps.length });
        this._emit('spawn', { body: b, next: [...this.next] });
      }
    } else {
      // Gently cycle day -> dusk -> night over time & score in playable mode
      this.skyProgress = (Math.sin(this.world.time * 0.045 - Math.PI * 0.5) + 1) * 0.5;
    }

    this.world.step(dt);

    // Release active piece control after it has touched & settled (or after contact window)
    if (this.active) {
      const sinceTouch = this.active.hasTouched ? (this.world.time - this.active.touchTime) : 0;
      if (this.active.hasTouched && (this.active.settleTime >= 0.28 || sinceTouch >= 0.72)) {
        this.active.isControlled = false;
        this.active.gravityScale = 1.0;
        const landedBody = this.active;
        this.active = null;
        this._spawnTimer = 0.42;
        this._emit('land', { body: landedBody });
        this._checkRowClearsAndTopOut();
      }
    } else if (this.mode === 'play') {
      this._spawnTimer -= dt;
      if (this._spawnTimer <= 0) {
        this._checkRowClearsAndTopOut();
        if (this.state === 'playing') {
          this._spawnNextPlayable();
        }
      }
    } else if (this.mode === 'squeeze-demo') {
      // Also allow row clears in squeeze-demo so Experiment 2 visibly pops the filled bottom rows!
      this._checkRowClearsAndTopOut({ allowGameOver: false });
    }
  }

  _checkRowClearsAndTopOut({ allowGameOver = true } = {}) {
    // Only check row clear when settled jellies are relatively calm
    const clearResult = this.world.clearFilledRows({
      threshold: 0.92,
      minColRatio: 0.82,
      maxGap: 0.24,
    });
    if (clearResult && clearResult.rows.length) {
      const count = clearResult.rows.length;
      this.combo++;
      const basePoints = [0, 120, 320, 560, 880][count] || 900;
      const points = (basePoints + (this.combo - 1) * 60) * this.level;
      this.score += points;
      this.lines += count;
      this.level = 1 + Math.floor(this.lines / 8);
      this._emit('clear', {
        rows: clearResult.rows,
        count,
        points,
        combo: this.combo,
        clearedVisuals: clearResult.clearedVisuals,
      });
      return;
    }

    this.combo = 0;

    if (allowGameOver && this.mode === 'play') {
      // Check if any settled body has piled above the dashed top line
      const overflow = this.world.bodies.some(
        b => !b.isControlled && b.hasTouched && b.settleTime > 0.35 && getBodyBounds(b).minY < this.dangerLineY
      );
      if (overflow) {
        this.state = 'over';
        this._emit('state', { state: 'over', score: this.score, lines: this.lines });
      }
    }
  }
}
