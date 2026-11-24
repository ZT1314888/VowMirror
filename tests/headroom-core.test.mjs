import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HEADER_IDLE_MS, HEADER_TOLERANCE, headroomStep, initialHeadroomState } from '../web/headroom-core.mjs';

function run(events, from = initialHeadroomState()) {
  return events.reduce((state, event) => headroomStep(state, event), from);
}

test('initial state is pinned and locked', () => {
  assert.deepEqual(initialHeadroomState(), { pinned: true, locked: true, accum: 0 });
  assert.equal(HEADER_TOLERANCE.down, 24);
  assert.equal(HEADER_TOLERANCE.up, 12);
  assert.equal(HEADER_IDLE_MS, 3000);
});

test('accumulates to tolerance and reversals reset the accumulator', () => {
  const unlocked = [{ type: 'unlock' }];
  let state = run(unlocked);
  state = run([{ type: 'delta', dy: 12 }], state);
  assert.equal(state.pinned, true, 'still pinned under the down tolerance');
  state = run([{ type: 'delta', dy: 12 }], state);
  assert.equal(state.pinned, false, 'crossing the down tolerance unpins');

  state = run([{ type: 'delta', dy: -5 }], state);
  assert.equal(state.pinned, false, 'reversed gesture below the up tolerance keeps the header hidden');
  state = run([{ type: 'delta', dy: 6 }], state);
  assert.equal(state.pinned, false, 'reversal resets accumulation before hiding further is irrelevant');
  state = run([{ type: 'delta', dy: 20 }], state);
  assert.equal(state.pinned, false, 'a fresh reversal must start from zero');
  state = run([{ type: 'delta', dy: -12 }], state);
  assert.equal(state.pinned, true, 'crossing the up tolerance re-pins');
});

test('locked states stay pinned and ignore gestures and idle', () => {
  let state = initialHeadroomState();
  state = run([{ type: 'delta', dy: 1000 }], state);
  assert.equal(state.pinned, true, 'locked (initial) ignores hide gestures');
  state = run([{ type: 'idle' }], state);
  assert.equal(state.pinned, true, 'locked ignores idle');

  state = run([{ type: 'unlock' }, { type: 'delta', dy: 24 }], state);
  assert.equal(state.pinned, false, 'unlocked can hide');
  state = run([{ type: 'lock' }], state);
  assert.equal(state.pinned, true, 'locking pins again');
  assert.equal(run([{ type: 'delta', dy: -1000 }], state).pinned, true, 'locked ignores reveal gestures too');
});

test('unlock keeps the header visible until an explicit hide event', () => {
  let state = run([{ type: 'unlock' }]);
  assert.equal(state.pinned, true, 'unlock alone does not hide the header');
  state = run([{ type: 'idle' }], state);
  assert.equal(state.pinned, false, 'idle hides only when unlocked');
  state = run([{ type: 'reveal' }], state);
  assert.equal(state.pinned, true, 'reveal re-pins');
  state = run([{ type: 'reveal' }, { type: 'reveal' }], state);
  assert.equal(state.pinned, true, 'reveal is idempotent');
});

test('zero and unknown deltas keep state without thrashing', () => {
  const state = run([{ type: 'unlock' }]);
  assert.equal(run([], state).pinned, true);
  assert.throws(() => headroomStep(state, { type: 'bogus' }), /unknown headroom event/);
});

test('a zero-length delta still clamps to the current direction and never unpins by itself', () => {
  const state = run([{ type: 'unlock' }]);
  const afterZero = run([{ type: 'delta', dy: 0 }], state);
  assert.equal(afterZero.accum, 0);
  assert.equal(afterZero.pinned, true);
});

test('noop changes nothing but is accepted for visual reconciliation', () => {
  const state = run([{ type: 'unlock' }, { type: 'delta', dy: 24 }], initialHeadroomState());
  assert.equal(state.pinned, false, 'hidden before reconciliation');
  // lock 只置 locked 并由结尾规则把 pinned 拉回 true；视觉校正用 noop 再走一遍。
  const locked = run([{ type: 'lock' }], state);
  assert.equal(locked.pinned, true, 'lock pins via the tail rule');
  const noop = run([{ type: 'noop' }], locked);
  assert.deepEqual(noop, locked, 'noop leaves state untouched');
});
