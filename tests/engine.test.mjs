import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, SHAPES } from '../dist/engine.js';

const fill = (type = 'Z', id = 1000) => ({ type, id });
const piece = (type, x, y, id = 900) => ({ type, matrix: SHAPES[type].map(row => [...row]), x, y, id });
const fresh = () => {
  const events = [];
  const game = new Game({ random: () => 0.37, onEvent: event => events.push(event) });
  game.start();
  return { game, events };
};

test('start initializes an empty playable board and a five-piece preview', () => {
  const { game } = fresh();
  assert.equal(game.state, 'playing');
  assert.equal(game.board.length, 20);
  assert(game.board.every(row => row.length === 10 && row.every(cell => cell === null)));
  assert.equal(game.getCells().length, 4);
  assert.equal(game.next.length, 5);
});

test('seven-bag distribution contains all seven types in each bag', () => {
  const { game } = fresh();
  const sequence = [];
  for (let i = 0; i < 28; i++) {
    sequence.push(game.active.type);
    game.board = Array.from({ length: 20 }, () => Array(10).fill(null));
    game.hardDrop();
  }
  for (let i = 0; i < sequence.length; i += 7) {
    assert.deepEqual([...sequence.slice(i, i + 7)].sort(), Object.keys(SHAPES).sort());
  }
});

test('horizontal movement stops at walls and stacked cells', () => {
  const { game } = fresh();
  game.active = piece('O', 4, 5);
  while (game.move(-1)) {}
  assert.equal(game.active.x, 0);
  assert.equal(game.move(-1), false);
  while (game.move(1)) {}
  assert.equal(game.active.x, 8);
  game.board[5][7] = fill();
  assert.equal(game.move(-1), false);
  assert.equal(game.active.x, 8);
});

test('rotation uses wall and floor kicks without crossing the board', () => {
  const { game } = fresh();
  game.active = piece('I', 0, 3);
  assert(game.rotate());
  while (game.move(-1)) {}
  assert.equal(game.active.x, -2);
  assert(game.rotate());
  assert(game.getCells().every(cell => cell.x >= 0 && cell.x < 10));
  game.active = piece('I', 3, 18);
  assert(game.rotate());
  assert(game.getCells().every(cell => cell.y < 20));
});

test('rotation is rejected when every valid kick is obstructed', () => {
  const { game } = fresh();
  game.active = piece('T', 3, 7);
  const occupied = new Set(game.getCells().map(cell => `${cell.x},${cell.y}`));
  game.board = game.board.map((row, y) => row.map((_, x) => occupied.has(`${x},${y}`) ? null : fill()));
  const before = structuredClone(game.active);
  assert.equal(game.rotate(), false);
  assert.deepEqual(game.active, before);
});

test('ghost and hard drop stop above existing stacks and score actual distance', () => {
  const { game, events } = fresh();
  game.active = piece('O', 4, 2);
  game.board[17][4] = fill();
  assert.equal(game.ghostY(), 15);
  game.hardDrop();
  assert.equal(game.score, 26);
  assert.equal(game.board[15][4].type, 'O');
  assert.equal(game.board[16][5].type, 'O');
  const land = events.find(event => event.type === 'land');
  assert.equal(land.distance, 13);
  assert(land.impact > 1);
  assert.equal(game.next.length, 5);
});

test('soft drop scores one point per successful cell and never locks immediately', () => {
  const { game } = fresh();
  game.active = piece('O', 4, 17);
  assert(game.softDrop());
  assert.equal(game.score, 1);
  assert.equal(game.softDrop(), false);
  assert.equal(game.score, 1);
  assert.equal(game.active.id, 900);
});

test('one completed line clears and all rows above shift down exactly once', () => {
  const { game, events } = fresh();
  game.board[19] = Array.from({ length: 10 }, (_, x) => x < 6 ? fill() : null);
  game.board[17][0] = fill('T', 777);
  game.active = piece('I', 6, 17);
  game.hardDrop();
  assert.equal(game.lines, 1);
  assert.equal(game.score, 102);
  assert.equal(game.board[18][0].id, 777);
  assert(game.board[19].every(cell => !cell));
  const clear = events.find(event => event.type === 'clear');
  assert.deepEqual(clear.rows, [19]);
  assert.equal(clear.cells.length, 10);
  assert.equal(clear.points, 100);
  assert.equal(clear.combo, 1);
});

test('four rows clear simultaneously with correct score, level and collapse', () => {
  const { game, events } = fresh();
  game.lines = 6;
  for (let y = 16; y < 20; y++) game.board[y] = Array.from({ length: 10 }, (_, x) => x === 5 ? null : fill());
  game.board[15][0] = fill('S', 321);
  game.active = piece('I', 3, 10);
  assert(game.rotate());
  assert.equal(game.ghostY(), 16);
  game.hardDrop();
  assert.equal(game.lines, 10);
  assert.equal(game.level, 2);
  assert.equal(game.score, 812);
  assert.equal(game.board[19][0].id, 321);
  assert.equal(game.board.flat().filter(Boolean).length, 1);
  const clear = events.find(event => event.type === 'clear');
  assert.deepEqual(clear.rows, [16, 17, 18, 19]);
  assert.equal(clear.count, 4);
  assert.equal(clear.cells.length, 40);
  assert.equal(clear.points, 800);
  assert(game.gravityInterval < 760);
});

test('consecutive clears earn combo points and non-clearing placement resets combo', () => {
  const { game, events } = fresh();
  for (let n = 0; n < 2; n++) {
    game.board[19] = Array.from({ length: 10 }, (_, x) => x < 6 ? fill() : null);
    game.active = piece('I', 6, 18);
    game.hardDrop();
  }
  assert.equal(game.score, 250);
  assert.equal(game.combo, 2);
  assert.deepEqual(events.filter(event => event.type === 'clear').map(event => event.points), [100, 150]);
  game.hardDrop();
  assert.equal(game.combo, 0);
});

test('ground contact gives 420 ms to adjust, with bounded lock resets', () => {
  const { game } = fresh();
  game.active = piece('O', 4, 18);
  game.update(419);
  assert.equal(game.active.id, 900);
  game.move(1);
  game.update(419);
  assert.equal(game.active.id, 900);
  game.update(1);
  assert.notEqual(game.active.id, 900);
  assert.equal(game.board.flat().filter(Boolean).length, 4);

  const other = fresh().game;
  other.active = piece('O', 4, 18);
  for (let i = 0; i < 12; i++) {
    other.update(100);
    other.move(i % 2 ? -1 : 1);
  }
  other.update(400);
  other.move(1); // The thirteenth move cannot reset the clock again.
  other.update(20);
  assert.notEqual(other.active.id, 900);
});

test('paused game cannot advance or accept gameplay inputs', () => {
  const { game } = fresh();
  game.togglePause();
  const before = structuredClone(game.active);
  game.update(2000);
  assert.equal(game.move(1), false);
  assert.equal(game.rotate(), false);
  assert.equal(game.hardDrop(), false);
  assert.equal(game.softDrop(), false);
  assert.deepEqual(game.active, before);
  game.togglePause();
  game.update(760);
  assert.equal(game.active.y, before.y + 1);
});

test('blocked spawn ends the game; restart removes all prior state', () => {
  const { game, events } = fresh();
  game.board[0] = Array.from({ length: 10 }, () => fill());
  game.board[1] = Array.from({ length: 10 }, () => fill());
  // Prevent full-row clearing while preserving the center spawn obstruction.
  game.board[0][0] = null;
  game.board[1][0] = null;
  game.active = piece('O', 4, 18);
  game.hardDrop();
  assert.equal(game.state, 'over');
  assert.equal(game.active, null);
  assert(events.some(event => event.type === 'state' && event.state === 'over'));
  assert.equal(game.hardDrop(), false);
  game.start();
  assert.equal(game.state, 'playing');
  assert.equal(game.score, 0);
  assert.equal(game.lines, 0);
  assert.equal(game.board.flat().filter(Boolean).length, 0);
});
