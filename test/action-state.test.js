import test from 'node:test';
import assert from 'node:assert/strict';
import { actionStillMatchesSnapshot } from '../public/js/action-state.js';

function snapshot(phase, roundNo = 1) {
  return {
    state: 'playing',
    roundNo,
    mySeat: 1,
    game: {
      turn: phase === 'discard' ? 1 : 0,
      options: phase ? { phase } : null,
    },
  };
}

test('碰杠响应不会因无关快照提前解锁', () => {
  const pending = { type: 'peng', phase: 'claim', roundNo: 1 };
  assert.equal(actionStillMatchesSnapshot(pending, snapshot('claim')), true);
  assert.equal(actionStillMatchesSnapshot(pending, snapshot('claim', 2)), false);
  assert.equal(actionStillMatchesSnapshot(pending, snapshot(null)), false);
});

test('出牌操作只在自己的有效回合保持锁定', () => {
  const pending = { type: 'discard', phase: 'discard', roundNo: 1 };
  assert.equal(actionStillMatchesSnapshot(pending, snapshot('discard')), true);
  const waiting = snapshot('discard');
  waiting.game.turn = 0;
  assert.equal(actionStillMatchesSnapshot(pending, waiting), false);
});
