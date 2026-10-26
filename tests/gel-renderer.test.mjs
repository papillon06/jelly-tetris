import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContours } from '../dist/gel-renderer.js';
import { SHAPES } from '../dist/engine.js';

const signedArea = loop => loop.reduce((area, a, i) => {
  const b = loop[(i + 1) % loop.length];
  return area + a.x * b.y - a.y * b.x;
}, 0) / 2;
const totalArea = loops => loops.reduce((area, loop) => area + signedArea(loop), 0);
const perimeter = loops => loops.reduce((sum, loop) => sum + loop.reduce((length, a, i) => {
  const b = loop[(i + 1) % loop.length];
  return length + Math.hypot(b.x - a.x, b.y - a.y);
}, 0), 0);
const cellsFrom = matrix => matrix.flatMap((row, y) => row.flatMap((v, x) => v ? [{ x, y }] : []));

test('every tetromino is one connected, area-preserving gel outline', () => {
  for (const [name, matrix] of Object.entries(SHAPES)) {
    const contours = buildContours(cellsFrom(matrix));
    assert.equal(contours.length, 1, name);
    assert.equal(totalArea(contours), 4, name);
    assert.equal(perimeter(contours), name === 'O' ? 8 : 10, name);
  }
});

test('a square block has no internal tile seams and only four corners', () => {
  const contours = buildContours(cellsFrom([[1, 1], [1, 1]]));
  assert.equal(contours[0].length, 4);
  assert.equal(perimeter(contours), 8);
});

test('removing a middle row leaves separate gel remnants without a phantom bridge', () => {
  const before = [{ x: 1, y: 2 }, { x: 1, y: 3 }, { x: 1, y: 4 }, { x: 1, y: 5 }];
  const remnants = before.filter(c => c.y !== 4);
  const contours = buildContours(remnants);
  assert.equal(contours.length, 2);
  assert.equal(totalArea(contours), 3);
  assert.deepEqual(contours.map(signedArea).sort((a, b) => a - b), [1, 2]);
  assert.equal(perimeter(contours), 10);
});

test('diagonal remnants touching at one point remain separate outlines', () => {
  const contours = buildContours([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  assert.equal(contours.length, 2);
  assert.equal(totalArea(contours), 2);
  assert(contours.every(loop => loop.length === 4));
});

test('a hole has opposite winding and is excluded from the filled area', () => {
  const ring = cellsFrom([[1, 1, 1], [1, 0, 1], [1, 1, 1]]);
  const contours = buildContours(ring);
  assert.equal(contours.length, 2);
  assert.equal(totalArea(contours), 8);
  assert.deepEqual(contours.map(signedArea).sort((a, b) => a - b), [-1, 9]);
  assert.equal(perimeter(contours), 16);
});

test('an empty or duplicate cell list does not create stray contours', () => {
  assert.deepEqual(buildContours([]), []);
  const contours = buildContours([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
  assert.equal(contours.length, 1);
  assert.equal(totalArea(contours), 1);
});
