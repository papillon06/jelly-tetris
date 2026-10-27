import {
  SoftWorld,
  SoftJellyGame,
  JELLY_SHAPES,
  sampleBody,
  getBodyBounds,
} from './soft-physics.js';
import { renderGel, PALETTE } from './gel-renderer.js';

const $ = id => document.getElementById(id);
const canvas = $('game-canvas');
const ctx = canvas.getContext('2d');
const nextCtx = $('next-canvas').getContext('2d');

// Logical canvas coordinates (520 x 820) mapped to wider & taller 6x10 soft-body container
const W = 520, H = 820;
const COLS = 6, ROWS = 10;
const C = 64; // 6 cols * 64 = 384px wide, 10 rows * 64 = 640px tall
const OX = (W - COLS * C) / 2; // 68
const OY = 24; // Floor at OY + 10 * 64 = 664
const WALL_TOP = OY + 1.0 * C; // 88 (top of U-shaped dark grey container walls)
const DASH_Y = OY + 2.15 * C; // 161.6 (horizontal 3-dash line inside container)
const FLOOR_Y = OY + ROWS * C; // 664

const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
let reduced = reduceQuery.matches;
reduceQuery.addEventListener('change', e => { reduced = e.matches; });

const read = (key, fallback) => {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};
const save = (key, v) => {
  try { localStorage.setItem(key, String(v)); } catch {}
};

let best = Number(read('jelly-gel-best', 0)) || 0;
let sound = read('jelly-drop-sound', 'true') !== 'false';
let audioCtx;
let lastTime = 0;
let particles = [];
let clearBands = [];
let poppedPieces = [];
let lastUI = '';
let helpWasPlaying = false;
let toastTimer;
let captionTimer;
const held = new Map();

// Idle background live soft-body world (matching 6x10 container)
const idleWorld = new SoftWorld({ width: COLS, height: ROWS });
function resetIdleWorld() {
  idleWorld.bodies = [];
  idleWorld.addBody('T', JELLY_SHAPES.T, { x: 0.35, y: 7.9 });
  idleWorld.addBody('T', JELLY_SHAPES.TR, { x: 2.45, y: 6.8 });
  idleWorld.addBody('O', JELLY_SHAPES.O, { x: 3.85, y: 7.8 });
  idleWorld.addBody('J', JELLY_SHAPES.J, { x: 0.25, y: 5.5, angle: -0.05 });
  idleWorld.addBody('O', JELLY_SHAPES.O, { x: 0.65, y: 2.4, vy: 1.5 });
}
resetIdleWorld();

const game = new SoftJellyGame({
  width: COLS,
  height: ROWS,
  dangerLineY: 2.15,
  onEvent: handleEvent,
});

function unlock() {
  if (!sound) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch {}
}

function tone(f, d = 0.14, v = 0.045, delay = 0, end = f * 0.58, type = 'sine') {
  if (!sound || !audioCtx || audioCtx.state !== 'running') return;
  try {
    const t = audioCtx.currentTime + delay;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(24, end), t + d);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t);
    o.stop(t + d + 0.02);
  } catch {}
}

function syncSound() {
  $('sound-btn').setAttribute('aria-label', sound ? '关闭音效' : '开启音效');
  $('sound-btn').setAttribute('aria-pressed', String(sound));
  $('sound-btn').querySelector('use').setAttribute('href', sound ? '#sound' : '#mute');
}

function syncModeButtons() {
  $('mode-play-btn').classList.toggle('active', game.mode === 'play');
  $('mode-video-btn').classList.toggle('active', game.mode === 'video-demo');
  $('mode-squeeze-btn').classList.toggle('active', game.mode === 'squeeze-demo');
}

function showCaption(text, durationMs = 3600) {
  const banner = $('caption-banner');
  if (!text) {
    banner.classList.add('hidden');
    return;
  }
  banner.textContent = text;
  banner.classList.remove('hidden');
  clearTimeout(captionTimer);
  if (durationMs > 0) {
    captionTimer = setTimeout(() => banner.classList.add('hidden'), durationMs);
  }
}

function syncUI() {
  const signature = [game.score, game.lines, game.level, best, game.mode].join(':');
  if (signature === lastUI) return;
  lastUI = signature;
  if (game.score > best) {
    best = game.score;
    save('jelly-gel-best', best);
  }
  $('score').textContent = String(game.score).padStart(4, '0');
  $('score-mobile').textContent = game.score;
  $('lines').textContent = game.lines;
  $('lines-mobile').textContent = game.lines;
  $('level').textContent = String(game.level).padStart(2, '0');
  $('best-score').textContent = best;
  $('best-mobile').textContent = best;
  syncModeButtons();
}

function setState(state) {
  $('game-overlay').classList.toggle('hidden', state === 'playing');
  $('pause-btn').disabled = ['idle', 'over'].includes(state);
  $('restart-btn').disabled = state === 'idle';
  $('pause-btn').setAttribute('aria-label', state === 'paused' ? '继续游戏' : '暂停游戏');
  $('pause-btn').querySelector('use').setAttribute('href', state === 'paused' ? '#play' : '#pause');

  const modeLabels = {
    play: '落地会弯曲歪倒，侧面碰撞可挤入空位',
    'video-demo': '正在回放：参考视频 5 步果冻软体堆叠与昼夜变化',
    'squeeze-demo': '正在演示：重心失衡歪倒 & 碰撞挤压滑入空位',
  };
  $('status-label').textContent = {
    idle: '准备好，接住软糯小果冻',
    playing: modeLabels[game.mode] || modeLabels.play,
    paused: '让Q弹果冻歇一会儿',
    over: '这罐快乐果冻装满啦',
  }[state];

  if (state === 'paused') {
    $('overlay-kicker').textContent = 'TAKE A LITTLE BREAK';
    $('overlay-title').textContent = '暂停一下下';
    $('overlay-description').textContent = '软糯果冻都在容器里等你回来。';
    $('start-btn').querySelector('span').textContent = '继续游戏';
    $('overlay-hint').textContent = '按 P 或 Enter 继续';
  } else if (state === 'over') {
    $('overlay-kicker').textContent = 'TANK FULL OF JELLY';
    $('overlay-title').textContent = '装满快乐啦';
    $('overlay-description').textContent = `本局 ${game.score} 分 · 消除 ${game.lines} 行`;
    $('start-btn').querySelector('span').textContent = '再来一局';
    $('overlay-hint').textContent = '按 Enter 重新开始';
    $('announcer').textContent = `游戏结束，${game.score} 分，消除了 ${game.lines} 行。`;
  }
  if (state !== 'playing') release();
}

function handleEvent(e) {
  if (e.type === 'state') {
    setState(e.state);
    syncModeButtons();
    return;
  }
  if (e.type === 'demo-step') {
    showCaption(e.step.caption, 3800);
    return;
  }
  if (e.type === 'spawn') {
    drawNext();
    return;
  }
  if (e.type === 'move') {
    tone(220, 0.055, 0.018, 0, 175);
  }
  if (e.type === 'rotate') {
    tone(340, 0.09, 0.026, 0, 490);
  }
  if (e.type === 'drop') {
    tone(320, 0.14, 0.022, 0, 95);
  }
  if (e.type === 'contact') {
    // Soft "噗 / 啵" jelly impact sound
    const p = Math.min(1.5, e.impact * 2.2);
    tone(145, 0.19, 0.055 * p, 0, 58);
    tone(260, 0.13, 0.022 * p, 0.055, 340);
    if (!reduced && e.body) {
      const bounds = getBodyBounds(e.body);
      const col = PALETTE[e.body.type] || PALETTE.T;
      for (let i = 0; i < 7; i++) {
        particles.push({
          x: OX + ((bounds.minX + bounds.maxX) * 0.5 + (Math.random() - 0.5) * 1.2) * C,
          y: OY + bounds.maxY * C,
          vx: (Math.random() - 0.5) * 110,
          vy: -25 - Math.random() * 45,
          r: 2 + Math.random() * 2.8,
          color: col.light,
          life: 0.34,
          max: 0.34,
        });
      }
    }
  }
  if (e.type === 'clear') {
    for (const row of e.rows) {
      clearBands.push({ y: row, life: 0.48, max: 0.48 });
    }
    for (const vis of e.clearedVisuals || []) {
      const col = PALETTE[vis.type] || PALETTE.T;
      for (const c of vis.cells) {
        poppedPieces.push({
          wx: c.wx,
          wy: c.wy,
          type: vis.type,
          life: 0.28,
          max: 0.28,
        });
        for (let i = 0; i < (reduced ? 3 : 11); i++) {
          particles.push({
            x: OX + c.wx * C,
            y: OY + c.wy * C,
            vx: (Math.random() - 0.5) * 230,
            vy: -50 - Math.random() * 140,
            r: 3 + Math.random() * 6.5,
            color: i % 2 === 0 ? col.light : col.base,
            life: 0.55 + Math.random() * 0.35,
            max: 0.9,
          });
        }
      }
    }

    const label = ['', '啵！满行消除', 'DOUBLE POP!', 'TRIPLE POP!', 'JELLY PARTY!'][e.count] || 'JELLY PARTY!';
    $('clear-toast').textContent = e.count === 1 ? `啵！+${e.points}` : `${label} +${e.points}`;
    $('clear-toast').classList.remove('show');
    void $('clear-toast').offsetWidth;
    $('clear-toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('clear-toast').classList.remove('show'), 1400);
    $('announcer').textContent = `消除 ${e.count} 行，获得 ${e.points} 分，上层果冻继续落下重堆叠。`;
    [420, 540, 660, 880].slice(0, Math.min(4, e.count + 1)).forEach((f, i) => {
      tone(f, 0.19, 0.035, i * 0.065, f * 1.18);
    });
  }
}

function lerpColor(hexA, hexB, t) {
  const a = parseInt(hexA.slice(1), 16);
  const b = parseInt(hexB.slice(1), 16);
  const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
  const g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
  const bl = Math.round((a & 255) * (1 - t) + (b & 255) * t);
  return `rgb(${r},${g},${bl})`;
}

/**
 * Draw the sky (day -> warm sunset -> night with sun & crescent moon),
 * low-contrast distant horizon, water surface below, and the dark U-shaped container.
 */
function drawEnvironment(skyProgress, timeSec) {
  ctx.clearRect(0, 0, W, H);

  // 1. Sky gradient (cyan-blue day -> warm sunset -> indigo night)
  let topCol, midCol, horCol;
  if (skyProgress < 0.5) {
    const t = skyProgress * 2;
    topCol = lerpColor('#1ca7ec', '#6784bd', t);
    midCol = lerpColor('#7fd4f7', '#a8b7d8', t);
    horCol = lerpColor('#eef6f2', '#f7d5ab', t);
  } else {
    const t = (skyProgress - 0.5) * 2;
    topCol = lerpColor('#6784bd', '#4466a3', t);
    midCol = lerpColor('#a8b7d8', '#7896c7', t);
    horCol = lerpColor('#f7d5ab', '#b8c8e3', t);
  }

  const skyGrad = ctx.createLinearGradient(0, 0, 0, FLOOR_Y + 12);
  skyGrad.addColorStop(0, topCol);
  skyGrad.addColorStop(0.58, midCol);
  skyGrad.addColorStop(1, horCol);
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, W, FLOOR_Y + 15);

  // 2. Sun (daytime) & Crescent Moon (nighttime) passing behind the U-shaped container
  if (skyProgress < 0.62) {
    const sunAlpha = Math.max(0, 1 - skyProgress * 1.65);
    const sunX = OX + 46 + skyProgress * 95;
    const sunY = WALL_TOP + 22 + skyProgress * 45;
    ctx.save();
    ctx.globalAlpha = sunAlpha;
    const glow = ctx.createRadialGradient(sunX, sunY, 6, sunX, sunY, 54);
    glow.addColorStop(0, '#ffffff');
    glow.addColorStop(0.42, '#fffbe6ee');
    glow.addColorStop(1, '#fffbe600');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(sunX, sunY, 54, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(sunX, sunY, 23, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (skyProgress > 0.38) {
    const moonAlpha = Math.min(1, (skyProgress - 0.38) * 1.8);
    const moonX = OX + COLS * C - 56 - (1 - skyProgress) * 85;
    const moonY = WALL_TOP + 18;
    ctx.save();
    ctx.globalAlpha = moonAlpha;
    const mGlow = ctx.createRadialGradient(moonX, moonY, 6, moonX, moonY, 48);
    mGlow.addColorStop(0, '#ffffffcc');
    mGlow.addColorStop(1, '#ffffff00');
    ctx.fillStyle = mGlow;
    ctx.beginPath();
    ctx.arc(moonX, moonY, 48, 0, Math.PI * 2);
    ctx.fill();

    // Crescent moon shape (matching frame_07 & frame_08)
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(moonX, moonY, 21, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = lerpColor(topCol, midCol, 0.35);
    ctx.beginPath();
    ctx.arc(moonX + 10, moonY - 5, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 3. Soft low-contrast distant hills near the horizon (远处低对比地平线)
  ctx.save();
  ctx.fillStyle = skyProgress < 0.5
    ? lerpColor('#d9ece9', '#ecc69c', skyProgress * 2)
    : lerpColor('#ecc69c', '#9db2d6', (skyProgress - 0.5) * 2);
  ctx.globalAlpha = 0.65;
  ctx.beginPath();
  ctx.moveTo(0, FLOOR_Y + 8);
  ctx.quadraticCurveTo(W * 0.18, FLOOR_Y - 62, W * 0.42, FLOOR_Y - 18);
  ctx.quadraticCurveTo(W * 0.72, FLOOR_Y - 56, W, FLOOR_Y - 8);
  ctx.lineTo(W, FLOOR_Y + 12);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 4. Water / Sea surface below the U-shaped container
  const waterGrad = ctx.createLinearGradient(0, FLOOR_Y + 4, 0, H);
  waterGrad.addColorStop(0, lerpColor('#749bc4', '#5076a8', skyProgress));
  waterGrad.addColorStop(0.38, lerpColor('#3f6fa6', '#2c5891', skyProgress));
  waterGrad.addColorStop(1, lerpColor('#1d4b87', '#153a6e', skyProgress));
  ctx.fillStyle = waterGrad;
  ctx.fillRect(0, FLOOR_Y + 4, W, H - FLOOR_Y);

  // Subtle animated water ripples
  ctx.save();
  ctx.strokeStyle = '#ffffff24';
  ctx.lineWidth = 2.2;
  for (let i = 0; i < 6; i++) {
    const ry = FLOOR_Y + 22 + i * 24;
    const shift = Math.sin(timeSec * 1.2 + i * 1.3) * 14;
    ctx.beginPath();
    ctx.moveTo(22 + shift, ry);
    ctx.quadraticCurveTo(W * 0.35, ry - 4, W * 0.65, ry + 4);
    ctx.quadraticCurveTo(W * 0.85, ry - 3, W - 22 + shift, ry);
    ctx.stroke();
  }
  ctx.restore();

  // 5. Translucent vertical drop beam under active falling piece (matching frame_04 & frame_07)
  if (game.state === 'playing' && game.active) {
    const b = getBodyBounds(game.active);
    const beamX = OX + b.minX * C;
    const beamW = Math.max(C * 0.8, (b.maxX - b.minX) * C);
    const beamGrad = ctx.createLinearGradient(0, Math.max(0, OY + b.minY * C), 0, FLOOR_Y);
    beamGrad.addColorStop(0, '#ffffff28');
    beamGrad.addColorStop(0.7, '#ffffff14');
    beamGrad.addColorStop(1, '#ffffff00');
    ctx.fillStyle = beamGrad;
    ctx.fillRect(beamX, Math.max(0, OY + b.minY * C), beamW, FLOOR_Y - Math.max(0, OY + b.minY * C));
  }

  // 6. Horizontal 3-dash black line near top of container (上方一条横向虚线)
  ctx.save();
  ctx.strokeStyle = '#11161d';
  ctx.lineWidth = 6.5;
  ctx.lineCap = 'butt';
  const innerW = COLS * C;
  const dashLen = innerW * 0.25;
  const gapLen = (innerW - dashLen * 3) / 2;
  for (let i = 0; i < 3; i++) {
    const x0 = OX + i * (dashLen + gapLen);
    ctx.beginPath();
    ctx.moveTo(x0, DASH_Y);
    ctx.lineTo(x0 + dashLen, DASH_Y);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Draw the thick dark slate U-shaped container walls over the scene edges,
 * plus the floating upcoming jelly pieces in the water below!
 */
function drawContainerAndWaterQueue(timeSec) {
  // Thick U-shaped dark slate walls (居中的深灰色 U 形容器，两侧直立粗边框，底部封闭，顶部敞开)
  const wallThickness = 15;
  ctx.save();
  ctx.strokeStyle = '#2d333b';
  ctx.lineWidth = wallThickness;
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(OX - wallThickness * 0.5, WALL_TOP);
  ctx.lineTo(OX - wallThickness * 0.5, FLOOR_Y + wallThickness * 0.5);
  ctx.lineTo(OX + COLS * C + wallThickness * 0.5, FLOOR_Y + wallThickness * 0.5);
  ctx.lineTo(OX + COLS * C + wallThickness * 0.5, WALL_TOP);
  ctx.stroke();

  // Subtle inner edge bevel
  ctx.strokeStyle = '#1c2127';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(OX, WALL_TOP);
  ctx.lineTo(OX, FLOOR_Y);
  ctx.lineTo(OX + COLS * C, FLOOR_Y);
  ctx.lineTo(OX + COLS * C, WALL_TOP);
  ctx.stroke();
  ctx.restore();

  // Floating next-queue jelly previews in the water below the container (matching reference video!)
  const queueTypes = game.next.length ? game.next.slice(0, 3) : ['O', 'C', 'T'];
  queueTypes.forEach((type, idx) => {
    const cells = JELLY_SHAPES[type] || JELLY_SHAPES.T;
    const minX = Math.min(...cells.map(c => c.x));
    const maxX = Math.max(...cells.map(c => c.x)) + 1;
    const minY = Math.min(...cells.map(c => c.y));
    const maxY = Math.max(...cells.map(c => c.y)) + 1;
    const miniSize = idx === 0 ? 22 : 18;
    const bobY = Math.sin(timeSec * 2.4 + idx * 1.6) * 2.5;
    const baseX = OX + 92 + idx * 102;
    const baseY = FLOOR_Y + 62 + bobY;

    renderGel(ctx, cells, {
      cellSize: miniSize,
      offsetX: baseX - ((minX + maxX) * 0.5) * miniSize,
      offsetY: baseY - ((minY + maxY) * 0.5) * miniSize,
      type: type === 'C' ? 'I' : type,
      alpha: idx === 0 ? 0.88 : 0.72,
    });
  });
}

function drawScene(dt) {
  const timeSec = performance.now() * 0.001;
  const sky = game.state === 'idle' ? 0.08 : game.skyProgress;
  drawEnvironment(sky, timeSec);

  ctx.save();
  ctx.beginPath();
  ctx.rect(OX - 2, 0, COLS * C + 4, FLOOR_Y + 2);
  ctx.clip();

  const activeWorld = game.state === 'idle' ? idleWorld : game.world;
  for (const body of activeWorld.bodies) {
    renderGel(ctx, body.cells, {
      cellSize: C,
      offsetX: OX,
      offsetY: OY,
      type: body.type,
      deform: (x, y) => sampleBody(body, x, y),
    });
  }

  // Popped cells shrinking & flashing during row clear
  for (const pop of poppedPieces) {
    const ratio = Math.max(0.05, pop.life / pop.max);
    renderGel(ctx, [{ x: 0, y: 0 }], {
      cellSize: C * ratio,
      offsetX: OX + (pop.wx - 0.5 * ratio) * C,
      offsetY: OY + (pop.wy - 0.5 * ratio) * C,
      type: pop.type,
      alpha: ratio,
    });
  }

  // Row clear flash band
  for (const f of clearBands) {
    ctx.globalAlpha = (f.life / f.max) * 0.75;
    const grad = ctx.createLinearGradient(OX, 0, OX + COLS * C, 0);
    grad.addColorStop(0, '#ffffff00');
    grad.addColorStop(0.35, '#ffffff');
    grad.addColorStop(0.65, '#ffffff');
    grad.addColorStop(1, '#ffffff00');
    ctx.fillStyle = grad;
    ctx.fillRect(OX, OY + f.y * C, COLS * C, C);
    ctx.globalAlpha = 1;
  }

  // Jelly splash particles
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(0.5, p.r * (p.life / p.max)), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffffaa';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  drawContainerAndWaterQueue(timeSec);
  void dt;
}

function drawNext() {
  nextCtx.clearRect(0, 0, 180, 200);
  const types = game.next.length ? game.next.slice(0, 3) : ['T', 'J', 'O'];
  types.forEach((type, i) => {
    const cells = JELLY_SHAPES[type] || JELLY_SHAPES.T;
    const minX = Math.min(...cells.map(c => c.x));
    const maxX = Math.max(...cells.map(c => c.x)) + 1;
    const minY = Math.min(...cells.map(c => c.y));
    const maxY = Math.max(...cells.map(c => c.y)) + 1;
    const s = i === 0 ? 25 : 21;
    renderGel(nextCtx, cells, {
      cellSize: s,
      offsetX: (180 - (maxX - minX) * s) / 2 - minX * s,
      offsetY: 16 + i * 64 - minY * s,
      type: type === 'C' ? 'I' : type,
      alpha: i === 0 ? 1 : 0.76,
    });
  });
}

function fit(element, context, w, h) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  element.width = w * dpr;
  element.height = h * dpr;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function resize() {
  fit(canvas, ctx, W, H);
  fit($('next-canvas'), nextCtx, 180, 200);
  drawNext();
}

function startMode(mode = 'play') {
  unlock();
  particles = [];
  clearBands = [];
  poppedPieces = [];
  clearTimeout(toastTimer);
  $('clear-toast').classList.remove('show');
  $('clear-toast').textContent = '';
  $('announcer').textContent = '';
  if (mode === 'play') showCaption('', 0);
  game.start(mode);
  lastUI = '';
  syncUI();
  drawNext();
  canvas.focus({ preventScroll: true });
  tone(330, 0.12, 0.03);
  tone(495, 0.15, 0.025, 0.09, 660);
}

function resume() {
  unlock();
  if (game.state === 'paused') game.togglePause();
  else startMode(game.mode || 'play');
  canvas.focus({ preventScroll: true });
}

function action(name) {
  if (game.state !== 'playing') return;
  if (name === 'left') game.move(-1);
  if (name === 'right') game.move(1);
  if (name === 'rotate') game.rotate(1);
  if (name === 'rotate-ccw') game.rotate(-1);
  if (name === 'drop') game.hardDrop();
  if (name === 'down') game.softDrop();
}

function release() {
  held.clear();
  document.querySelectorAll('.held').forEach(b => b.classList.remove('held'));
}

$('start-btn').addEventListener('click', () => {
  if (game.state === 'paused') resume();
  else startMode('play');
});
$('overlay-video-btn').addEventListener('click', () => startMode('video-demo'));
$('overlay-squeeze-btn').addEventListener('click', () => startMode('squeeze-demo'));
$('mode-play-btn').addEventListener('click', () => startMode('play'));
$('mode-video-btn').addEventListener('click', () => startMode('video-demo'));
$('mode-squeeze-btn').addEventListener('click', () => startMode('squeeze-demo'));

$('pause-btn').addEventListener('click', () => {
  game.togglePause();
  canvas.focus({ preventScroll: true });
});
$('restart-btn').addEventListener('click', () => startMode(game.mode || 'play'));
$('sound-btn').addEventListener('click', () => {
  sound = !sound;
  save('jelly-drop-sound', sound);
  syncSound();
  unlock();
  if (sound) tone(440, 0.1, 0.025);
});

$('help-btn').addEventListener('click', () => {
  helpWasPlaying = game.state === 'playing';
  if (helpWasPlaying) game.togglePause();
  $('help-dialog').showModal();
});
function closeHelp() {
  $('help-dialog').close();
  if (helpWasPlaying && game.state === 'paused') game.togglePause();
  helpWasPlaying = false;
}
$('close-help').addEventListener('click', closeHelp);
$('got-it').addEventListener('click', closeHelp);
$('help-dialog').addEventListener('cancel', e => {
  e.preventDefault();
  closeHelp();
});

const keys = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'rotate',
  ArrowDown: 'down',
  ' ': 'drop',
  a: 'left',
  d: 'right',
  w: 'rotate',
  e: 'rotate',
  q: 'rotate-ccw',
  s: 'down',
};

window.addEventListener('keydown', e => {
  if ($('help-dialog').open) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === 'v') {
    e.preventDefault();
    startMode('video-demo');
    return;
  }
  if (key === 'p' || key === 'Escape') {
    if (['playing', 'paused'].includes(game.state)) {
      e.preventDefault();
      if (!e.repeat) game.togglePause();
    }
    return;
  }
  if (key === 'Enter' && game.state !== 'playing' && e.target.tagName !== 'BUTTON') {
    e.preventDefault();
    resume();
    return;
  }
  const act = keys[key];
  if (!act || game.state !== 'playing' || (key === ' ' && e.target.tagName === 'BUTTON')) return;
  e.preventDefault();
  if (e.repeat) return;
  unlock();
  action(act);
  if (['left', 'right', 'down'].includes(act)) {
    held.set(key, { act, t: 0, next: 150 });
  }
});

window.addEventListener('keyup', e => {
  held.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
});
window.addEventListener('blur', () => {
  release();
  if (game.state === 'playing' && game.mode === 'play') game.togglePause();
});

for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('pointerdown', e => {
    e.preventDefault();
    unlock();
    button.setPointerCapture(e.pointerId);
    button.classList.add('held');
    action(button.dataset.action);
    if (['left', 'right'].includes(button.dataset.action)) {
      held.set(e.pointerId, { act: button.dataset.action, t: 0, next: 150 });
    }
  });
  const up = e => {
    held.delete(e.pointerId);
    button.classList.remove('held');
  };
  button.addEventListener('pointerup', up);
  button.addEventListener('pointercancel', up);
  button.addEventListener('lostpointercapture', up);
  button.addEventListener('click', e => {
    if (e.detail === 0) action(button.dataset.action);
  });
}

let gesture = null;
canvas.addEventListener('pointerdown', e => {
  if (game.state !== 'playing') return;
  unlock();
  canvas.setPointerCapture(e.pointerId);
  gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, moved: false };
});
canvas.addEventListener('pointermove', e => {
  if (!gesture || gesture.id !== e.pointerId) return;
  const threshold = canvas.getBoundingClientRect().width * 0.13;
  while (Math.abs(e.clientX - gesture.lastX) > threshold) {
    const dir = Math.sign(e.clientX - gesture.lastX);
    action(dir > 0 ? 'right' : 'left');
    gesture.lastX += dir * threshold;
    gesture.moved = true;
  }
});
canvas.addEventListener('pointerup', e => {
  if (!gesture || gesture.id !== e.pointerId) return;
  if (e.clientY - gesture.y > 35) action('drop');
  else if (!gesture.moved && Math.abs(e.clientY - gesture.y) < 12) action('rotate');
  gesture = null;
});
canvas.addEventListener('pointercancel', () => { gesture = null; });

function frame(t) {
  const dt = Math.min((t - lastTime) / 1000 || 0.016, 0.033);
  lastTime = t;

  if (game.state === 'idle') {
    idleWorld.step(dt);
  } else if (game.state === 'playing') {
    game.update(dt);
    particles = particles.filter(p => {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 210 * dt;
      return p.life > 0;
    });
    clearBands = clearBands.filter(f => (f.life -= dt) > 0);
    poppedPieces = poppedPieces.filter(r => (r.life -= dt) > 0);
  }

  for (const h of held.values()) {
    h.t += dt * 1000;
    if (h.t >= h.next) {
      action(h.act);
      h.next += 95;
    }
  }

  drawScene(dt);
  syncUI();
  requestAnimationFrame(frame);
}

resize();
window.addEventListener('resize', resize);
syncSound();
syncUI();
requestAnimationFrame(frame);
