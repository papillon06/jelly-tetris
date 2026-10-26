export const PALETTE = Object.freeze({
  I: { base: '#59C9CF', light: '#C8FFF2', dark: '#278C9B', glow: '#A8F5F0' },
  O: { base: '#F3C951', light: '#FFF5B7', dark: '#C59030', glow: '#FFECAE' },
  T: { base: '#B89BDB', light: '#EDDFFF', dark: '#8061B7', glow: '#DDC8F5' },
  S: { base: '#8DCB92', light: '#DFF3BB', dark: '#539D72', glow: '#CEF1BD' },
  Z: { base: '#ED96A9', light: '#FFE2D9', dark: '#BD587D', glow: '#FFD1D9' },
  J: { base: '#88B4E4', light: '#DAF0FF', dark: '#557FC0', glow: '#C7E8FF' },
  L: { base: '#EDA66C', light: '#FFE6B7', dark: '#BD744E', glow: '#FFDEB0' },
});

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

function jellyPath(ctx, s, wobble = 0) {
  const l = -s * 0.455;
  const r = s * 0.455;
  const top = -s * 0.91;
  const a = wobble * s * 0.027;
  ctx.beginPath();
  ctx.moveTo(-s * 0.23, top + a * 0.3);
  ctx.bezierCurveTo(-s * 0.39, top - a * 0.35, l + a, top + s * 0.07, l + a, top + s * 0.235);
  ctx.bezierCurveTo(l - a * 0.65, top + s * 0.39, l - a * 0.25, -s * 0.24, l + s * 0.018, -s * 0.17);
  ctx.bezierCurveTo(l + s * 0.04, -s * 0.035, -s * 0.29, s * 0.009, -s * 0.12, 0);
  ctx.bezierCurveTo(s * 0.04, s * 0.012, s * 0.21, s * 0.013, s * 0.29, -s * 0.015);
  ctx.bezierCurveTo(r - s * 0.005, -s * 0.04, r + a * 0.6, -s * 0.15, r + a * 0.5, -s * 0.25);
  ctx.bezierCurveTo(r + a * 0.8, -s * 0.4, r - a, top + s * 0.29, r - s * 0.012 - a, top + s * 0.19);
  ctx.bezierCurveTo(r - s * 0.035 - a, top + s * 0.045, s * 0.32, top - a * 0.2, s * 0.18, top);
  ctx.bezierCurveTo(s * 0.08, top - s * 0.007, -s * 0.12, top - a * 0.2, -s * 0.23, top + a * 0.3);
  ctx.closePath();
}

/** A single soft translucent tile. All coordinates and effects stay local. */
export function drawJelly(ctx, x, y, size, type, opts = {}) {
  if (!ctx || size <= 0) return;
  const color = PALETTE[type] || PALETTE.S;
  const squash = clamp(Number(opts.squash) || 0, -0.5, 0.65);
  const tilt = clamp(Number(opts.tilt) || 0, -0.45, 0.45);
  const wobble = clamp(Number(opts.wobble) || 0, -2, 2);
  const alpha = clamp(opts.alpha ?? 1, 0, 1);
  const sx = 1 + squash * 0.34;
  const sy = 1 - squash * 0.48;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x + size / 2, y + size * 0.956);
  ctx.transform(sx, 0, tilt, sy, 0, 0);

  if (opts.ghost) {
    jellyPath(ctx, size, 0);
    ctx.fillStyle = color.glow + '22';
    ctx.fill();
    ctx.strokeStyle = color.dark + '60';
    ctx.lineWidth = Math.max(1, size * 0.034);
    ctx.setLineDash([size * 0.07, size * 0.07]);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // A very short contact shadow makes the soft edge feel lifted above the glass.
  ctx.save();
  ctx.shadowColor = color.dark + '45';
  ctx.shadowBlur = size * 0.095;
  ctx.shadowOffsetY = size * 0.047;
  jellyPath(ctx, size, wobble);
  const body = ctx.createLinearGradient(-size * 0.2, -size * 0.94, size * 0.24, size * 0.04);
  body.addColorStop(0, color.light);
  body.addColorStop(0.18, color.base);
  body.addColorStop(0.57, color.base);
  body.addColorStop(1, color.dark);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.restore();

  ctx.save();
  jellyPath(ctx, size, wobble);
  ctx.clip();

  // Light passes through the centre and gathers along the lower inside edge.
  const transmitted = ctx.createRadialGradient(size * 0.15, -size * 0.31, size * 0.02, size * 0.11, -size * 0.36, size * 0.57);
  transmitted.addColorStop(0, color.glow + '8A');
  transmitted.addColorStop(0.62, color.glow + '26');
  transmitted.addColorStop(1, color.light + '00');
  ctx.fillStyle = transmitted;
  ctx.fillRect(-size * 0.6, -size, size * 1.2, size * 1.1);

  // Broad curved top reflection, softer on the right as the jelly surface turns.
  const shine = ctx.createLinearGradient(-size * 0.33, -size * 0.82, size * 0.26, -size * 0.55);
  shine.addColorStop(0, '#FFFFFFC7');
  shine.addColorStop(0.55, '#FFFFFF51');
  shine.addColorStop(1, '#FFFFFF05');
  ctx.beginPath();
  ctx.moveTo(-size * 0.335, -size * 0.67);
  ctx.bezierCurveTo(-size * 0.37, -size * 0.83, -size * 0.18, -size * 0.88, size * 0.16, -size * 0.84);
  ctx.bezierCurveTo(size * 0.29, -size * 0.82, size * 0.34, -size * 0.75, size * 0.32, -size * 0.65);
  ctx.bezierCurveTo(size * 0.12, -size * 0.735, -size * 0.1, -size * 0.72, -size * 0.29, -size * 0.60);
  ctx.bezierCurveTo(-size * 0.32, -size * 0.585, -size * 0.34, -size * 0.62, -size * 0.335, -size * 0.67);
  ctx.fillStyle = shine;
  ctx.fill();

  // Bottom refraction lip: a dark rim and one soft bright seam, never an outline.
  ctx.beginPath();
  ctx.moveTo(-size * 0.35, -size * 0.19);
  ctx.bezierCurveTo(-size * 0.25, -size * 0.055, size * 0.22, -size * 0.035, size * 0.36, -size * 0.18);
  ctx.strokeStyle = color.dark + '70';
  ctx.lineWidth = size * 0.055;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-size * 0.28, -size * 0.12);
  ctx.bezierCurveTo(-size * 0.13, -size * 0.06, size * 0.16, -size * 0.055, size * 0.29, -size * 0.12);
  ctx.strokeStyle = color.light + '88';
  ctx.lineWidth = size * 0.021;
  ctx.stroke();

  // A slim side reflection and two pinpricks give the gel its wet finish.
  ctx.beginPath();
  ctx.moveTo(-size * 0.365, -size * 0.55);
  ctx.quadraticCurveTo(-size * 0.385, -size * 0.42, -size * 0.35, -size * 0.31);
  ctx.strokeStyle = '#FFFFFF50';
  ctx.lineWidth = size * 0.026;
  ctx.stroke();
  ctx.fillStyle = '#FFFFFFDA';
  ctx.beginPath();
  ctx.ellipse(-size * 0.255, -size * 0.77, size * 0.052, size * 0.024, -0.35, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#FFFFFFA6';
  ctx.beginPath();
  ctx.arc(size * 0.31, -size * 0.3, size * 0.018, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Fine soft outer rim connects the glossy surface without heavy borders.
  jellyPath(ctx, size, wobble);
  ctx.strokeStyle = color.dark + '38';
  ctx.lineWidth = Math.max(0.65, size * 0.017);
  ctx.stroke();

  if (opts.face) {
    const eyeY = -size * 0.43;
    const eyeSpace = size * 0.115;
    const blink = Number(opts.time) > 0 && (Number(opts.time) % 5200) > 5010;
    ctx.fillStyle = '#325D4E';
    for (const eyeX of [-eyeSpace, eyeSpace]) {
      ctx.beginPath();
      ctx.ellipse(eyeX, eyeY, size * 0.027, blink ? size * 0.008 : size * 0.036, 0, 0, Math.PI * 2);
      ctx.fill();
      if (!blink) {
        ctx.fillStyle = '#FFFFFFA8';
        ctx.beginPath();
        ctx.arc(eyeX - size * 0.008, eyeY - size * 0.012, size * 0.009, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#325D4E';
      }
    }
    ctx.beginPath();
    ctx.moveTo(-size * 0.043, -size * 0.34);
    ctx.quadraticCurveTo(0, -size * 0.285, size * 0.043, -size * 0.34);
    ctx.strokeStyle = '#325D4E';
    ctx.lineWidth = size * 0.019;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  ctx.restore();
}

export function drawCluster(ctx, matrix, x, y, size, type, opts = {}) {
  for (let row = 0; row < matrix.length; row++) {
    for (let col = 0; col < matrix[row].length; col++) {
      if (matrix[row][col]) drawJelly(ctx, x + col * size, y + row * size, size, type, opts);
    }
  }
}
