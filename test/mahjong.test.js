import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWinningHand, shanten, getWaits, chiOptions, buildWall, countsOf,
  canConcealedGang, canAddGang, tileName,
} from '../server/mahjong.js';

const rules = {
  suits: [1, 2, 3], honors: false, copies: 4,
  allowSevenPairs: true, allowThirteenOrphans: false, mustOpen: false,
};

test('牌墙 108 张', () => {
  const wall = buildWall(rules);
  assert.equal(wall.length, 108);
  const c = countsOf(wall);
  for (const s of [1, 2, 3]) for (let r = 1; r <= 9; r++) assert.equal(c[s * 10 + r], 4);
});

test('基本胡牌', () => {
  // 123 456 789 万 + 123 筒 + 44 筒
  const h = [11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 24];
  assert.equal(isWinningHand(h, 0, rules), true);
  assert.equal(isWinningHand([11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25], 0, rules), false);
});

test('刻子胡牌', () => {
  const h = [11, 11, 11, 21, 21, 21, 31, 31, 31, 45, 45, 45, 47, 47];
  assert.equal(isWinningHand(h, 0, rules), true);
});

test('七对', () => {
  const h = [11, 11, 12, 12, 13, 13, 21, 21, 31, 31, 45, 45, 47, 47];
  assert.equal(isWinningHand(h, 0, rules), true);
  assert.equal(isWinningHand(h, 0, { ...rules, allowSevenPairs: false }), false);
});

test('副露后胡牌', () => {
  // 两组副露，剩余 123 456 77
  const h = [11, 12, 13, 14, 15, 16, 17, 17];
  assert.equal(isWinningHand(h, 2, rules), true);
  assert.equal(isWinningHand([11, 12, 13, 14, 15, 16, 17, 18], 2, rules), false);
});

test('必须开门规则', () => {
  const h = [11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 24];
  assert.equal(isWinningHand(h, 0, { ...rules, mustOpen: true }), false);
  assert.equal(isWinningHand([11, 12, 13, 14, 15, 16, 17, 17], 2, { ...rules, mustOpen: true }), true);
});

test('向听数', () => {
  const complete = [11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 24];
  assert.equal(shanten(complete, 0, rules), -1);
  const tenpai = [11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24];
  assert.equal(shanten(tenpai, 0, rules), 0);
  const one = [11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 25];
  assert.equal(shanten(one, 0, rules), 1);
  const random = [11, 14, 17, 22, 25, 28, 31, 34, 37, 45, 46, 47, 13];
  assert.ok(shanten(random, 0, rules) > 2);
});

test('听牌', () => {
  const tenpai = [11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24];
  const w = getWaits(tenpai, 0, rules);
  assert.ok(w.includes(24));
});

test('吃牌组合', () => {
  const hand = [11, 12, 13, 15, 17];
  const opts = chiOptions(hand, 14);
  assert.deepEqual(opts.sort(), [[12, 13], [13, 15]].sort());
  assert.deepEqual(chiOptions(hand, 16).sort(), [[15, 17]].sort());
  assert.deepEqual(chiOptions([11, 12], 13), [[11, 12]]);
});

test('杠判定', () => {
  assert.deepEqual(canConcealedGang([11, 11, 11, 11, 12]), [11]);
  assert.deepEqual(canAddGang([11], [{ type: 'peng', tiles: [11, 11, 11] }]), [11]);
});

test('牌名', () => {
  assert.equal(tileName(11), '1万');
  assert.equal(tileName(45), '中');
});

test('向听性能', () => {
  const h = [11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 24];
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) shanten(h, 0, rules);
  const dt = performance.now() - t0;
  assert.ok(dt < 2000, `too slow: ${dt}ms`);
});
