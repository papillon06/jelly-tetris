import { SHAPES } from './engine.js';
export { SHAPES };

const TYPES = Object.keys(SHAPES);
const copy = matrix => matrix.map(row => [...row]);

/** Integer occupancy with continuous, accelerating motion between rows. */
export class GelGame {
  constructor({ cols = 4, rows = 8, width = cols, height = rows, onEvent = () => {}, random = Math.random } = {}) {
    if (!Number.isInteger(width) || width < 4 || !Number.isInteger(height) || height < 4) {
      throw new RangeError('The well needs at least four integer columns and rows.');
    }
    this.width = width;
    this.height = height;
    this.onEvent = onEvent;
    this.random = random;
    this.lockDelay = 420;
    this.maxLockResets = 8;
    this.spawnDelay = 500;
    this.state = 'idle';
    this.board = this._emptyBoard();
    this.active = null;
    this.next = [];
    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.combo = 0;
    this.fallY = 0;
    this.fallVelocity = 0;
    this.hardDropping = false;
    this._bag = [];
    this._serial = 0;
    this._spawnWait = 0;
    this._lockTime = 0;
    this._lockResets = 0;
    this._lastDx = 0;
    this._contact = false;
    this._contactImpact = 1;
    this._dropDistance = 0;
    this._soft = false;
  }

  _emptyRow() { return Array(this.width).fill(null); }
  _emptyBoard() { return Array.from({ length: this.height }, () => this._emptyRow()); }
  _emit(type, detail = {}) { this.onEvent({ type, ...detail }); }
  get grounded() { return this._grounded(); }
  get gravity() { return 6 + Math.min(5, (this.level - 1) * .6); }
  get maxFallVelocity() { return 7 + Math.min(5, (this.level - 1) * .5); }

  start() {
    this.board = this._emptyBoard();
    this.active = null;
    this.next = [];
    this._bag = [];
    this._serial = 0;
    this.score = this.lines = this.combo = 0;
    this.level = 1;
    this.fallY = this.fallVelocity = 0;
    this._spawnWait = 0;
    this.hardDropping = false;
    this.state = 'playing';
    this._fillQueue();
    this._emit('state', { state: this.state });
    this._spawn();
  }

  togglePause() {
    if (!['playing', 'paused'].includes(this.state)) return false;
    this.state = this.state === 'playing' ? 'paused' : 'playing';
    this._emit('state', { state: this.state });
    return true;
  }

  _nextType() {
    if (!this._bag.length) {
      this._bag = [...TYPES];
      for (let i = this._bag.length - 1; i > 0; i--) {
        const j = Math.min(i, Math.max(0, Math.floor(this.random() * (i + 1))));
        [this._bag[i], this._bag[j]] = [this._bag[j], this._bag[i]];
      }
    }
    return this._bag.pop();
  }
  _fillQueue() { while (this.next.length < 5) this.next.push(this._nextType()); }

  _spawn() {
    const type = this.next.shift();
    this._fillQueue();
    const matrix = copy(SHAPES[type]);
    this.active = { type, matrix, x: Math.floor((this.width - matrix.length) / 2), y: 0, id: ++this._serial };
    this.fallY = 0;
    this.fallVelocity = .65;
    this.hardDropping = this._soft = this._contact = false;
    this._dropDistance = this._lastDx = this._lockTime = this._lockResets = 0;
    this._contactImpact = 1;
    this._spawnWait = 0;
    if (!this._valid(this.active)) { this._gameOver(); return; }
    this._emit('spawn', { piece: this.active, cells: this.getCells() });
  }

  getCells(piece = this.active) {
    if (!piece) return [];
    const cells = [];
    piece.matrix.forEach((row, y) => row.forEach((value, x) => {
      if (value) cells.push({ x: piece.x + x, y: piece.y + y, type: piece.type, id: piece.id });
    }));
    return cells;
  }
  _valid(piece) {
    return this.getCells(piece).every(({ x, y }) => x >= 0 && x < this.width && y < this.height && (y < 0 || !this.board[y][x]));
  }
  _grounded() { return Boolean(this.active && !this._valid({ ...this.active, y: this.active.y + 1 })); }
  ghostY() {
    if (!this.active) return null;
    let y = this.active.y;
    while (this._valid({ ...this.active, y: y + 1 })) y++;
    return y;
  }
  _canAct() { return this.state === 'playing' && this.active && !this.hardDropping; }
  _fitsDuringFall(piece, fraction) {
    return this._valid(piece) && (fraction < .001 || this._valid({ ...piece, y: piece.y + 1 }));
  }
  _afterAdjustment(wasGrounded) {
    if (wasGrounded && this._lockResets < this.maxLockResets) {
      this._lockTime = 0;
      this._lockResets++;
    }
    if (!this._grounded()) {
      this._contact = false;
      this.fallVelocity = Math.max(.65, this.fallVelocity);
    }
  }

  move(dx) {
    if (!this._canAct() || !dx) return false;
    dx = Math.sign(dx);
    const candidate = { ...this.active, x: this.active.x + dx };
    if (!this._fitsDuringFall(candidate, this.fallY - this.active.y)) return false;
    const grounded = this._grounded();
    this.active = candidate;
    this._lastDx = dx;
    this._afterAdjustment(grounded);
    this._emit('move', { dx, dy: 0, cells: this.getCells() });
    return true;
  }

  rotate(dir = 1) {
    if (!this._canAct() || this.active.type === 'O') return false;
    const previous = this.active;
    const n = previous.matrix.length;
    const matrix = Array.from({ length: n }, () => Array(n).fill(0));
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (dir >= 0) matrix[x][n - 1 - y] = previous.matrix[y][x];
      else matrix[n - 1 - x][y] = previous.matrix[y][x];
    }
    const fraction = Math.max(0, this.fallY - previous.y);
    const grounded = this._grounded();
    const kicks = [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1], [-1, -1], [1, -1], [0, -2]];
    for (const [dx, dy] of kicks) {
      const candidate = { ...previous, matrix, x: previous.x + dx, y: previous.y + dy };
      if (!this._fitsDuringFall(candidate, dy < 0 ? 0 : fraction)) continue;
      this.active = candidate;
      this.fallY = candidate.y + (dy < 0 ? 0 : fraction);
      this._afterAdjustment(grounded);
      this._emit('rotate', { dir: Math.sign(dir) || 1, dx, dy, cells: this.getCells() });
      return true;
    }
    return false;
  }

  softDrop() {
    if (!this._canAct()) return false;
    this._soft = true;
    this.fallVelocity = Math.max(10, this.fallVelocity);
    return true;
  }
  hardDrop() {
    if (!this._canAct()) return false;
    this.hardDropping = true;
    this.fallVelocity = Math.max(23, this.fallVelocity);
    this._dropDistance = 0;
    this._emit('drop', { cells: this.getCells(), distance: this.ghostY() - this.active.y });
    return true;
  }

  _touch() {
    if (this._contact || !this.active) return;
    this._contact = true;
    this.fallY = this.active.y;
    this._contactImpact = Math.min(2.5, .8 + this.fallVelocity * .085);
    this._emit('contact', { cells: this.getCells(), impact: this._contactImpact, dx: this._lastDx, hardDrop: this.hardDropping, velocity: this.fallVelocity });
    this.fallVelocity = 0;
  }

  update(dtMs) {
    if (this.state !== 'playing' || !Number.isFinite(dtMs) || dtMs <= 0) return;
    let remaining = Math.min(2000, dtMs);
    while (remaining > .00001 && this.state === 'playing') {
      const step = Math.min(8, remaining);
      remaining -= step;
      if (!this.active) {
        this._spawnWait -= step;
        if (this._spawnWait <= 0) this._spawn();
        continue;
      }
      if (this._grounded()) {
        this._touch();
        this._lockTime += step;
        if (this.hardDropping || this._lockTime >= this.lockDelay) this._lock();
        continue;
      }
      this._contact = false;
      const dt = step / 1000;
      const cap = this.hardDropping ? 30 : this._soft ? 12 : this.maxFallVelocity;
      this.fallVelocity = Math.min(cap, this.fallVelocity + this.gravity * dt);
      this.fallY += this.fallVelocity * dt;
      while (this.active && this.fallY >= this.active.y + 1) {
        const next = { ...this.active, y: this.active.y + 1 };
        if (!this._valid(next)) { this.fallY = this.active.y; break; }
        this.active = next;
        if (this.hardDropping) { this.score += 2; this._dropDistance++; }
        else if (this._soft) this.score++;
        this._emit('move', { dx: 0, dy: 1, manual: this._soft, hardDrop: this.hardDropping, cells: this.getCells() });
        if (this._grounded()) {
          this.fallY = this.active.y;
          this._touch();
          if (this.hardDropping) this._lock();
          break;
        }
      }
    }
  }

  _lock() {
    const cells = this.getCells();
    if (cells.some(cell => cell.y < 0)) { this._gameOver(); return; }
    if (!this._contact) this._touch();
    for (const { x, y, type, id } of cells) this.board[y][x] = { type, id };
    this._emit('land', { cells, impact: this._contactImpact, dx: this._lastDx, hardDrop: this.hardDropping, distance: this._dropDistance, contactAlready: true });
    const rows = [];
    for (let y = 0; y < this.height; y++) if (this.board[y].every(Boolean)) rows.push(y);
    if (rows.length) {
      this.combo++;
      const points = (([0, 100, 300, 500, 800][rows.length] || 800 + (rows.length - 4) * 300) + (this.combo - 1) * 50) * this.level;
      this.score += points;
      this.lines += rows.length;
      this.level = 1 + Math.floor(this.lines / 10);
      const clearedCells = rows.flatMap(y => this.board[y].map((cell, x) => ({ ...cell, x, y })));
      this._emit('clear', { rows, cells: clearedCells, count: rows.length, points, combo: this.combo });
      this.board = this.board.filter((_, y) => !rows.includes(y));
      while (this.board.length < this.height) this.board.unshift(this._emptyRow());
    } else this.combo = 0;
    this.active = null;
    this.hardDropping = false;
    this.fallVelocity = 0;
    this._spawnWait = this.spawnDelay;
  }

  _gameOver() {
    this.state = 'over';
    this.active = null;
    this.hardDropping = false;
    this.fallVelocity = 0;
    this._emit('state', { state: this.state, score: this.score, lines: this.lines });
  }
}
