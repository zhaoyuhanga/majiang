import test from 'node:test';
import assert from 'node:assert/strict';
import { getRule } from '../server/rules.js';
import { analyzeWin, getTingInfo } from '../server/rules.js';

const harbin = getRule('harbin');
const sys = getRule('shuangyashan');

test('哈尔滨：必须开门', () => {
  const hand = [11, 12, 13, 14, 15, 16, 17, 17];
  const melds = [
    { type: 'peng', tiles: [21, 21, 21] },
    { type: 'chi', tiles: [31, 32, 33] },
  ];
  const a = analyzeWin({ tiles: hand, melds, winTile: 17, zimo: false, ting: true }, harbin);
  assert.equal(a.ok, true, a.reason);
  const noOpen = analyzeWin({ tiles: hand, melds: [], winTile: 17, zimo: false, ting: true }, harbin);
  assert.equal(noOpen.ok, false);
});

test('哈尔滨：必须报听', () => {
  const hand = [11, 12, 13, 14, 15, 16, 17, 17];
  const melds = [{ type: 'peng', tiles: [21, 21, 21] }, { type: 'chi', tiles: [31, 32, 33] }];
  const a = analyzeWin({ tiles: hand, melds, winTile: 17, zimo: true, ting: false }, harbin);
  assert.equal(a.ok, false);
});

test('哈尔滨：禁清一色', () => {
  const hand = [11, 12, 13, 14, 15, 16, 17, 17];
  const melds = [{ type: 'peng', tiles: [11, 11, 11] }, { type: 'chi', tiles: [12, 13, 14] }];
  const a = analyzeWin({ tiles: hand, melds, winTile: 17, zimo: false, ting: true }, harbin);
  assert.equal(a.ok, false);
});

test('哈尔滨：禁七对', () => {
  const hand = [11, 11, 13, 13, 15, 15, 17, 17, 19, 19, 21, 21, 23, 23];
  const a = analyzeWin({ tiles: hand, melds: [], winTile: 23, zimo: false, ting: true }, harbin);
  assert.equal(a.ok, false);
});

test('双鸭山：七小对', () => {
  const hand = [11, 11, 13, 13, 15, 15, 17, 17, 19, 19, 21, 21, 23, 23];
  const a = analyzeWin({ tiles: hand, melds: [], winTile: 23, zimo: false, ting: false }, sys);
  assert.equal(a.ok, true, a.reason);
  assert.equal(a.sevenPairs, true);
});

test('双鸭山：必须有幺', () => {
  const hand = [12, 13, 14, 15, 16, 17, 22, 23, 24, 25, 26, 27, 28, 28];
  const a = analyzeWin({ tiles: hand, melds: [], winTile: 28, zimo: false, ting: false }, sys);
  assert.equal(a.ok, false);
});

test('双鸭山：飘胡', () => {
  const hand = [11, 11, 11, 21, 21, 21, 31, 31, 31, 19, 19, 19, 45, 45];
  const a = analyzeWin({ tiles: hand, melds: [], winTile: 45, zimo: false, ting: false }, sys);
  assert.equal(a.ok, true, a.reason);
  assert.equal(a.allTriplets, true);
  const s = analyzeWin({ tiles: [11, 11, 11, 21, 21, 21, 31, 31, 31, 19, 19, 19, 45, 45], melds: [], winTile: 45, zimo: false, ting: false }, sys);
  assert.equal(s.kadan, true);
});

test('哈尔滨：报听信息', () => {
  const hand = [11, 12, 13, 14, 15, 16, 21, 21, 21, 45];
  const melds = [{ type: 'chi', tiles: [31, 32, 33] }];
  const info = getTingInfo(hand, melds, harbin);
  assert.equal(info.ting, true);
  assert.ok(info.waits.length > 0);
});
