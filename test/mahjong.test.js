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

function referenceMelds(c, need) {
  if (need === 0) return c.every((count) => count === 0);
  let tile = c.findIndex((count) => count > 0);
  if (tile < 0) return false;
  if (c[tile] >= 3) {
    c[tile] -= 3;
    const ok = referenceMelds(c, need - 1);
    c[tile] += 3;
    if (ok) return true;
  }
  if (tile >= 11 && tile <= 39 && tile % 10 <= 7 && c[tile + 1] > 0 && c[tile + 2] > 0) {
    c[tile]--; c[tile + 1]--; c[tile + 2]--;
    const ok = referenceMelds(c, need - 1);
    c[tile]++; c[tile + 1]++; c[tile + 2]++;
    if (ok) return true;
  }
  return false;
}

function referenceStandardWin(hand) {
  const c = countsOf(hand);
  if (c.some((count) => count > 4)) return false;
  for (let pair = 11; pair <= 47; pair++) {
    if (c[pair] < 2) continue;
    c[pair] -= 2;
    const ok = referenceMelds(c, 4);
    c[pair] += 2;
    if (ok) return true;
  }
  return false;
}

test('分组剪枝与朴素枚举结果一致且不修改输入', () => {
  let seed = 0x6d616a69;
  const random = (limit) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  const wall = buildWall({ suits: [1, 2, 3], honors: true, copies: 4 });
  const standardRules = { suits: [1, 2, 3], honors: true, allowSevenPairs: false };
  const meldOptions = [];
  for (const base of [10, 20, 30]) {
    for (let rank = 1; rank <= 7; rank++) meldOptions.push([base + rank, base + rank + 1, base + rank + 2]);
    for (let rank = 1; rank <= 9; rank++) meldOptions.push([base + rank, base + rank, base + rank]);
  }
  for (let honor = 41; honor <= 47; honor++) meldOptions.push([honor, honor, honor]);

  for (let sample = 0; sample < 1200; sample++) {
    let hand;
    if (sample < 600) {
      const c = new Array(48).fill(0);
      for (let meld = 0; meld < 4; meld++) {
        let options = meldOptions.filter((tiles) => tiles.every((tile) => c[tile] < 4));
        const chosen = options[random(options.length)];
        for (const tile of chosen) c[tile]++;
      }
      const pairs = [];
      for (let tile = 11; tile <= 47; tile++) if (c[tile] > 0 && c[tile] <= 2) pairs.push(tile);
      const pair = pairs[random(pairs.length)];
      c[pair] += 2;
      hand = [];
      for (let tile = 11; tile <= 47; tile++) for (let i = 0; i < c[tile]; i++) hand.push(tile);
    } else {
      hand = Array.from({ length: 14 }, () => wall[random(wall.length)]);
    }
    const before = hand.slice();
    assert.equal(isWinningHand(hand, 0, standardRules), referenceStandardWin(hand), `牌型不一致: ${hand.join(',')}`);
    assert.deepEqual(hand, before);
  }

  const tenpai = [11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24];
  const counts = countsOf(tenpai);
  const expected = [];
  for (let tile = 11; tile <= 47; tile++) {
    if (counts[tile] >= 4) continue;
    if (referenceStandardWin(tenpai.concat(tile))) expected.push(tile);
  }
  assert.deepEqual(getWaits(tenpai, 0, standardRules), expected);
  assert.deepEqual(getWaits(tenpai, 0, standardRules, 23), expected.filter((tile) => tile <= 23));
});

test('向听性能', () => {
  const h = [11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 24];
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) shanten(h, 0, rules);
  const dt = performance.now() - t0;
  assert.ok(dt < 2000, `too slow: ${dt}ms`);
});
