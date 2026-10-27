import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SoftWorld,
  SoftJellyGame,
  JELLY_SHAPES,
  sampleBody,
  getBodyBounds,
  getBodyCentroid,
  getBodyAngle,
} from '../dist/soft-physics.js';

test('soft body accelerates under gravity, squashes & bulges on floor impact, then rebounds', () => {
  const world = new SoftWorld({ width: 4, height: 8 });
  const body = world.addBody('L', JELLY_SHAPES.L, { x: 0.8, y: 0, angle: 0.12, vy: 5 });

  for (let i = 0; i < 240; i++) world.step(1 / 60);

  const bounds = getBodyBounds(body);
  // Rest height of L is 3.0, rest width is 2.0: impact must compress height and bulge width
  assert(body.minHeightObserved < 2.82, `expected vertical squash, got ${body.minHeightObserved}`);
  assert(body.maxWidthObserved > 2.35, `expected lateral bulge, got ${body.maxWidthObserved}`);
  // After settling, bounds remain inside container and recover near rest dimensions
  assert(bounds.minX >= 0 && bounds.maxX <= 4);
  assert(bounds.maxY <= 8);
  assert(bounds.height > 2.75 && bounds.height < 3.2);
});

test('overhanging center of mass causes soft body to bend and tip over into empty space', () => {
  const world = new SoftWorld({ width: 4, height: 8 });
  world.addBody('O', [{ x: 0, y: 0 }], { x: 1.1, y: 7 });
  const bar = world.addBody('I', [
    { x: 0, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: 2 },
    { x: 0, y: 3 },
  ], { x: 1.6, y: 3, angle: 0.08 });

  const initialAngle = Math.abs(getBodyAngle(bar));
  for (let i = 0; i < 300; i++) world.step(1 / 60);

  const finalAngleDeg = Math.abs(getBodyAngle(bar)) * (180 / Math.PI);
  assert(finalAngleDeg > initialAngle * (180 / Math.PI) + 45, `expected tipping > 45 deg, got ${finalAngleDeg}`);
});

test('falling jelly squeezes and pushes an already landed jelly sideways into an adjacent empty slot', () => {
  const world = new SoftWorld({ width: 4, height: 8 });
  const landed = world.addBody('O', JELLY_SHAPES.O, { x: 0.9, y: 5.95 });
  for (let i = 0; i < 30; i++) world.step(1 / 60);

  const startX = getBodyCentroid(landed).x;
  const incoming = world.addBody('O', JELLY_SHAPES.O, { x: 1.85, y: 1.0, vy: 4 });
  for (let i = 0; i < 240; i++) world.step(1 / 60);

  const endX = getBodyCentroid(landed).x;
  const incomingX = getBodyCentroid(incoming).x;

  // Landed block was squeezed left by > 0.6 cells into [0, 2], while incoming block settled into [2, 4]
  assert(startX - endX > 0.6, `expected landed block to be squeezed left, shift=${endX - startX}`);
  assert(endX < 1.25 && incomingX > 2.75);
});

test('horizontal row filled by squeezed soft bodies clears and lets upper bodies fall & tip', () => {
  const world = new SoftWorld({ width: 4, height: 8 });
  world.addBody('O', JELLY_SHAPES.O, { x: 0.9, y: 5.95 });
  world.addBody('O', JELLY_SHAPES.O, { x: 1.85, y: 1.0, vy: 4 });
  for (let i = 0; i < 160; i++) world.step(1 / 60);

  const upper = world.addBody('T', JELLY_SHAPES.T, { x: 0.4, y: 3.5 });
  for (let i = 0; i < 90; i++) world.step(1 / 60);

  const upperBeforeY = getBodyCentroid(upper).y;
  const clearRes = world.clearFilledRows();
  assert(clearRes && clearRes.rows.length >= 1, 'expected bottom row(s) to be filled and cleared');

  for (let i = 0; i < 120; i++) world.step(1 / 60);
  const upperAfterY = getBodyCentroid(upper).y;
  assert(upperAfterY > upperBeforeY + 1.2, 'expected upper jelly to fall after lower row cleared');
});

test('strict row clear rejects rows with any unfilled column or gap', () => {
  const world = new SoftWorld({ width: 6, height: 10 });
  // Place 5 columns out of 6 on the floor (leaving 1 column empty on the right)
  world.addBody('I', JELLY_SHAPES.I, { x: 0.02, y: 8.95 });
  world.addBody('O', [{ x: 0, y: 0 }], { x: 4.02, y: 8.95 });
  for (let i = 0; i < 60; i++) world.step(1 / 60);

  assert.equal(world.clearFilledRows(), null, '5/6 filled row must not clear');
});

test('SoftJellyGame supports play, video-demo, and squeeze-demo modes plus player steering', () => {
  const events = [];
  const game = new SoftJellyGame({ onEvent: e => events.push(e), random: () => 0.42 });
  game.start('play');
  assert.equal(game.state, 'playing');

  // Step until first piece spawns
  for (let i = 0; i < 20; i++) game.update(1 / 60);
  assert(game.active, 'active soft body spawned');

  const x0 = getBodyCentroid(game.active).x;
  assert(game.move(1));
  assert(getBodyCentroid(game.active).x > x0);
  assert(game.rotate(1));
  assert(game.softDrop());
  assert(game.hardDrop());

  // Video choreography mode spawns steps and advances skyProgress
  game.start('video-demo');
  for (let i = 0; i < 180; i++) game.update(1 / 60);
  assert(game.world.bodies.length >= 1);
  assert(game.skyProgress > 0.1);
  assert(events.some(e => e.type === 'demo-step'));

  // sampleBody smoothly maps local cell coordinates to world coordinates
  const sample = sampleBody(game.world.bodies[0], 0.5, 0.5);
  assert(Number.isFinite(sample.x) && Number.isFinite(sample.y));
});
