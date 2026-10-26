import test from 'node:test';
import assert from 'node:assert/strict';
import { GelGame, SHAPES } from '../dist/gel-engine.js';
const fill = (type = 'Z', id = 1000) => ({ type, id });
const piece = (type, x, y, id = 900) => ({ type, matrix: SHAPES[type].map(row => [...row]), x, y, id });
const fresh = options => { const events = []; const game = new GelGame({ ...options, random: () => .37, onEvent: e => events.push(e) }); game.start(); return { game, events }; };
const put = (game, type, x, y) => { game.active = piece(type, x, y); game.fallY = y; game.fallVelocity = .65; game._contact = false; game._lockTime = 0; game.hardDropping = false; };
const advanceUntil = (game, predicate, limit = 10000) => { for (let t = 0; t < limit && !predicate(); t += 8) game.update(8); assert(predicate(), 'condition reached'); };

test('the reference-sized well is four by eight and supports configurable dimensions', () => {
  const { game } = fresh();
  assert.equal(game.width, 4); assert.equal(game.height, 8); assert.equal(game.board.length, 8); assert(game.board.every(r => r.length === 4));
  const wider = fresh({ cols: 6, rows: 12 }).game;
  assert(wider.board.every(r => r.length === 6)); assert.equal(wider.board.length, 12);
  assert.throws(() => new GelGame({ cols: 3 }), RangeError);
});

test('fall position is fractional and accelerates before crossing a logical row', () => {
  const { game } = fresh(); put(game, 'O', 1, 0);
  game.update(100);
  assert(game.fallY > 0 && game.fallY < 1); assert.equal(game.active.y, 0);
  const speed = game.fallVelocity; game.update(100); assert(game.fallVelocity > speed);
  assert(game.fallY > 0 && game.fallY < 1);
});

test('hard drop travels continuously, locks once, then waits before the next spawn', () => {
  const { game, events } = fresh(); put(game, 'O', 1, 0);
  assert(game.hardDrop()); assert.equal(game.active.y, 0); assert.equal(game.board.flat().filter(Boolean).length, 0);
  assert.equal(game.move(1), false); assert.equal(game.rotate(), false);
  game.update(16); assert(game.fallY > 0 && game.fallY < 1);
  advanceUntil(game, () => game.active === null);
  assert.equal(game.score, 12); assert.equal(game.board.flat().filter(Boolean).length, 4);
  assert.equal(events.filter(e => e.type === 'contact').length, 1); assert.equal(events.filter(e => e.type === 'land').length, 1);
  game.update(400); assert.equal(game.active, null); game.update(100); assert(game.active);
});

test('contact leaves a 420ms adjustment window and grounded moves extend it', () => {
  const { game, events } = fresh(); put(game, 'O', 0, 6);
  game.update(400); assert.equal(game.active.id, 900); assert.equal(events.filter(e => e.type === 'contact').length, 1);
  assert(game.move(1)); game.update(400); assert.equal(game.active.id, 900);
  game.update(20); assert.equal(game.active, null); assert.equal(events.filter(e => e.type === 'contact').length, 1);
});

test('a complete row clears at contact and the remaining board collapses exactly', () => {
  const { game, events } = fresh();
  game.board[7][0] = fill(); game.board[7][1] = fill(); game.board[5][0] = fill('J', 777);
  put(game, 'O', 2, 0); game.hardDrop(); advanceUntil(game, () => game.active === null);
  assert.equal(game.lines, 1); assert.equal(game.board[6][0].id, 777); assert.equal(game.board.flat().filter(Boolean).length, 3);
  assert.equal(game.board[7][2].type, 'O'); assert.equal(game.board[7][3].type, 'O');
  const clear = events.find(e => e.type === 'clear'); assert.equal(clear.cells.length, 4); assert.deepEqual(clear.rows, [7]);
});

test('four lines clear and increase the level', () => {
  const { game, events } = fresh(); game.lines = 6;
  for (let y = 4; y < 8; y++) game.board[y] = Array.from({ length: 4 }, (_, x) => x === 2 ? null : fill());
  put(game, 'I', 0, 0); assert(game.rotate()); game.hardDrop(); advanceUntil(game, () => game.active === null);
  assert.equal(game.lines, 10); assert.equal(game.level, 2); assert.equal(game.board.flat().filter(Boolean).length, 0);
  assert.equal(events.find(e => e.type === 'clear').count, 4);
});

test('movement and wall kicks remain inside the narrow well', () => {
  const { game } = fresh(); put(game, 'I', 0, 1); assert(game.rotate()); while(game.move(-1)) {}
  assert(game.rotate()); assert(game.getCells().every(c => c.x >= 0 && c.x < 4));
  put(game, 'O', 0, 4); assert.equal(game.move(-1), false); while(game.move(1)) {} assert.equal(game.active.x, 2);
});

test('pause freezes fractional motion, spawn delay, and gameplay actions', () => {
  const { game } = fresh(); game.update(100); game.togglePause();
  const before = { y: game.fallY, v: game.fallVelocity, piece: structuredClone(game.active) };
  game.update(2000); assert.equal(game.fallY, before.y); assert.equal(game.fallVelocity, before.v); assert.deepEqual(game.active, before.piece);
  assert.equal(game.hardDrop(), false); assert.equal(game.softDrop(), false); assert.equal(game.move(1), false);
  game.togglePause(); game.update(100); assert(game.fallY > before.y);
});

test('blocked spawn ends the game and restart resets all motion and board state', () => {
  const { game } = fresh(); put(game, 'O', 0, 6);
  game.board[0] = [null, fill(), fill(), fill()]; game.board[1] = [null, fill(), fill(), fill()];
  game.hardDrop(); game.update(8); game.update(500); assert.equal(game.state, 'over');
  game.start(); assert.equal(game.state, 'playing'); assert(game.active); assert.equal(game.fallY, 0); assert.equal(game.score, 0); assert.equal(game.board.flat().filter(Boolean).length, 0);
});

test('fractional horizontal motion cannot slide through the occupied row below', () => {
  const { game } = fresh(); put(game, 'O', 0, 3);
  game.fallY = 3.6; game.board[5][2] = fill();
  assert.equal(game.move(1), false);
  assert.equal(game.active.x, 0); assert.equal(game.fallY, 3.6);
  game.fallY = 3; assert.equal(game.move(1), true);
  assert(game.grounded); game.update(8); assert.equal(game.fallY, 3);
});

test('fractional floor rotation kicks upward without penetrating the bottom', () => {
  const { game } = fresh(); put(game, 'I', 0, 5); game.fallY = 5.4;
  assert(game.rotate()); assert.equal(game.active.y, 4); assert.equal(game.fallY, 4);
  assert(game.getCells().every(c => c.x >= 0 && c.x < 4 && c.y >= 0 && c.y < 8));
  assert(game.grounded);
});

test('pause also freezes the gap between pieces', () => {
  const { game } = fresh(); put(game, 'O', 0, 6); game.hardDrop(); game.update(8);
  assert.equal(game.active, null); const waiting = game._spawnWait;
  game.togglePause(); game.update(1000); assert.equal(game._spawnWait, waiting); assert.equal(game.active, null);
  game.togglePause(); game.update(waiting); assert(game.active);
});
