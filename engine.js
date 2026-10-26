/** Grid rules are independent of the spring animation and canvas renderer. */
export const SHAPES = Object.freeze({
  I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
  O: [[1, 1], [1, 1]],
  T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
  S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
  Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
  J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
  L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
});

const TYPES = Object.keys(SHAPES);
const emptyRow = () => Array(10).fill(null);
const cloneMatrix = matrix => matrix.map(row => [...row]);

export class Game {
  constructor({ onEvent = () => {}, random = Math.random } = {}) {
    this.width = 10;
    this.height = 20;
    this.onEvent = onEvent;
    this.random = random;
    this.lockDelay = 420;
    this.maxLockResets = 12;
    this.state = 'idle';
    this.board = Array.from({ length: this.height }, emptyRow);
    this.active = null;
    this.next = [];
    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.combo = 0;
    this._bag = [];
    this._serial = 0;
    this._gravityTime = 0;
    this._lockTime = 0;
    this._lockResets = 0;
    this._lastDx = 0;
  }

  get gravityInterval() {
    return Math.max(75, 760 * Math.pow(0.82, this.level - 1));
  }

  _emit(type, details = {}) {
    this.onEvent({ type, ...details });
  }

  start() {
    this.board = Array.from({ length: this.height }, emptyRow);
    this.active = null;
    this.next = [];
    this._bag = [];
    this._serial = 0;
    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.combo = 0;
    this.state = 'playing';
    this._fillQueue();
    this._emit('state', { state: this.state });
    this._spawn();
  }

  togglePause() {
    if (this.state !== 'playing' && this.state !== 'paused') return false;
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

  _fillQueue() {
    while (this.next.length < 5) this.next.push(this._nextType());
  }

  _spawn() {
    const type = this.next.shift();
    this._fillQueue();
    const matrix = cloneMatrix(SHAPES[type]);
    this.active = {
      type,
      matrix,
      x: Math.floor((this.width - matrix.length) / 2),
      y: 0,
      id: ++this._serial,
    };
    this._gravityTime = 0;
    this._lockTime = 0;
    this._lockResets = 0;
    this._lastDx = 0;
    if (!this._valid(this.active)) {
      this._gameOver();
      return;
    }
    this._emit('spawn', { piece: this.active, cells: this.getCells() });
  }

  getCells(piece = this.active) {
    if (!piece) return [];
    const cells = [];
    for (let row = 0; row < piece.matrix.length; row++) {
      for (let col = 0; col < piece.matrix[row].length; col++) {
        if (piece.matrix[row][col]) {
          cells.push({ x: piece.x + col, y: piece.y + row, type: piece.type, id: piece.id });
        }
      }
    }
    return cells;
  }

  _valid(piece) {
    return this.getCells(piece).every(({ x, y }) =>
      x >= 0 && x < this.width && y < this.height && (y < 0 || !this.board[y][x]));
  }

  _grounded() {
    return this.active && !this._valid({ ...this.active, y: this.active.y + 1 });
  }

  ghostY() {
    if (!this.active) return null;
    let y = this.active.y;
    while (this._valid({ ...this.active, y: y + 1 })) y++;
    return y;
  }

  _resetLockAfterAction(wasGrounded) {
    if (wasGrounded && this._lockResets < this.maxLockResets) {
      this._lockTime = 0;
      this._lockResets++;
    }
  }

  move(dx) {
    if (this.state !== 'playing' || !this.active || !dx) return false;
    dx = Math.sign(dx);
    const candidate = { ...this.active, x: this.active.x + dx };
    if (!this._valid(candidate)) return false;
    const grounded = this._grounded();
    this.active = candidate;
    this._lastDx = dx;
    this._resetLockAfterAction(grounded);
    this._emit('move', { dx, dy: 0, cells: this.getCells() });
    return true;
  }

  rotate(dir = 1) {
    if (this.state !== 'playing' || !this.active || this.active.type === 'O') return false;
    const current = this.active;
    const size = current.matrix.length;
    const matrix = Array.from({ length: size }, () => Array(size).fill(0));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (dir >= 0) matrix[x][size - 1 - y] = current.matrix[y][x];
        else matrix[size - 1 - x][y] = current.matrix[y][x];
      }
    }
    // Compact wall/floor kick search, including two-cell I-piece kicks.
    const kicks = [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1], [-1, -1], [1, -1], [0, -2]];
    const grounded = this._grounded();
    for (const [dx, dy] of kicks) {
      const candidate = { ...current, matrix, x: current.x + dx, y: current.y + dy };
      if (!this._valid(candidate)) continue;
      this.active = candidate;
      this._resetLockAfterAction(grounded);
      this._emit('rotate', { dir: Math.sign(dir) || 1, dx, dy, cells: this.getCells() });
      return true;
    }
    return false;
  }

  _fall(manual = false) {
    const candidate = { ...this.active, y: this.active.y + 1 };
    if (!this._valid(candidate)) return false;
    this.active = candidate;
    if (manual) this.score++;
    this._emit('move', { dx: 0, dy: 1, manual, cells: this.getCells() });
    return true;
  }

  softDrop() {
    if (this.state !== 'playing' || !this.active) return false;
    const moved = this._fall(true);
    if (moved) this._gravityTime = 0;
    return moved;
  }

  hardDrop() {
    if (this.state !== 'playing' || !this.active) return false;
    const distance = this.ghostY() - this.active.y;
    this.active = { ...this.active, y: this.active.y + distance };
    this.score += distance * 2;
    this._emit('move', { dx: 0, dy: distance, hardDrop: true, cells: this.getCells() });
    this._lock({ hardDrop: true, distance });
    return true;
  }

  update(dtMs) {
    if (this.state !== 'playing' || !this.active || !Number.isFinite(dtMs) || dtMs <= 0) return;
    // Bound background catch-up and step the lock clock independently of frame rate.
    let remaining = Math.min(dtMs, 2000);
    while (remaining > 0 && this.state === 'playing') {
      const step = Math.min(16, remaining);
      remaining -= step;
      if (this._grounded()) {
        this._lockTime += step;
        if (this._lockTime >= this.lockDelay) this._lock();
      } else {
        this._gravityTime += step;
        while (this._gravityTime >= this.gravityInterval && this.state === 'playing') {
          this._gravityTime -= this.gravityInterval;
          if (!this._fall()) break;
        }
      }
    }
  }

  _lock({ hardDrop = false, distance = 0 } = {}) {
    const cells = this.getCells();
    if (cells.some(cell => cell.y < 0)) {
      this._gameOver();
      return;
    }
    for (const { x, y, type, id } of cells) this.board[y][x] = { type, id };
    this._emit('land', {
      cells,
      impact: hardDrop ? Math.min(2.5, 1.35 + distance * 0.06) : 1,
      dx: this._lastDx,
      hardDrop,
      distance,
    });
    const rows = [];
    for (let y = 0; y < this.height; y++) {
      if (this.board[y].every(Boolean)) rows.push(y);
    }
    if (rows.length) {
      this.combo++;
      const points = ([0, 100, 300, 500, 800][rows.length] + (this.combo - 1) * 50) * this.level;
      this.score += points;
      this.lines += rows.length;
      this.level = 1 + Math.floor(this.lines / 10);
      const clearedCells = rows.flatMap(y => this.board[y].map((cell, x) => ({ ...cell, x, y })));
      this._emit('clear', { rows, cells: clearedCells, count: rows.length, points, combo: this.combo });
      this.board = this.board.filter((_, y) => !rows.includes(y));
      while (this.board.length < this.height) this.board.unshift(emptyRow());
    } else {
      this.combo = 0;
    }
    this._spawn();
  }

  _gameOver() {
    this.state = 'over';
    this.active = null;
    this._emit('state', { state: this.state, score: this.score, lines: this.lines });
  }
}
