import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoomRules, analyzeWin, getTingInfo } from '../server/rules.js';
import { scoreRound } from '../server/scoring.js';
import { Room, normalizeConfig } from '../server/rooms.js';

const harbinMelds = [
  { type: 'chi', tiles: [21, 22, 23] },
  { type: 'peng', tiles: [45, 45, 45] },
];

function roomRules(ruleSet, ruleOptions = {}, options = {}) {
  return buildRoomRules({ ruleSet, ruleOptions, options });
}

test('房间规则：白名单归一化、默认封顶与局部更新', () => {
  const config = normalizeConfig({
    ruleSet: 'shuangyashan',
    ruleOptions: { shouBaYiSwap: true, pureKan: true, unknownRule: true },
  });
  assert.equal(config.ruleOptions.shouBaYiSwap, true);
  assert.equal(config.ruleOptions.pureKan, true);
  assert.equal(Object.hasOwn(config.ruleOptions, 'unknownRule'), false);
  assert.equal(roomRules('shuangyashan').scoring.cap, 64);
  assert.equal(roomRules('harbin').scoring.cap, 36);

  const room = new Room('RULE1', 'p0', config);
  room.updateConfig('p0', { ruleOptions: { dianpaoBaoSanjia: false } });
  assert.equal(room.config.ruleOptions.shouBaYiSwap, true);
  assert.equal(room.config.ruleOptions.pureKan, true);
  assert.equal(room.config.ruleOptions.dianpaoBaoSanjia, false);
});

test('哈尔滨规则开关映射到实际规则', () => {
  const rules = roomRules('harbin', {
    scene: 'high', zhanLiLiTing: true, qiDui: true, qingYiSe: true,
    qiangGangHu: false, kuaiBao: true, gangSuanFen: true, guaFeng: true,
  });
  assert.equal(rules.win.mustOpen, false);
  assert.equal(rules.win.minSuits, 1);
  assert.equal(rules.win.allowSevenPairs, true);
  assert.equal(rules.win.allowPureSuit, true);
  assert.equal(rules.allowQiangGang, false);
  assert.equal(rules.scoring.sceneMultiplier, 4);
  assert.equal(rules.scoring.gangImmediate, true);
  assert.deepEqual(rules.scoring.gangScore, { ming: 1, an: 1, bu: 1 });
});

test('纯夹与不夹不胡：只接受唯一夹张', () => {
  const pureKan = roomRules('shuangyashan', { pureKan: true });
  const hand = [11, 12, 13, 21, 22, 23, 31, 32, 33, 19, 19, 19, 45, 45];
  assert.equal(analyzeWin({ tiles: hand, winTile: 32 }, pureKan).kanWait, true);
  assert.equal(analyzeWin({ tiles: hand, winTile: 32 }, pureKan).ok, true);
  assert.equal(analyzeWin({ tiles: hand, winTile: 33 }, pureKan).ok, true);
  assert.equal(analyzeWin({ tiles: hand, winTile: 31 }, pureKan).ok, false);
  assert.equal(analyzeWin({ tiles: hand, winTile: 45 }, pureKan).ok, true);

  const noKanNoWin = roomRules('shuangyashan', { buJiaBuHu: true });
  assert.equal(analyzeWin({ tiles: hand, winTile: 32 }, noKanNoWin).ok, true);
  assert.equal(analyzeWin({ tiles: hand, winTile: 33 }, noKanNoWin).ok, false);
  assert.equal(analyzeWin({ tiles: hand, winTile: 45 }, noKanNoWin).ok, false);

  const harbinNoKan = roomRules('harbin', { siKa: true });
  const harbinKan = [11, 12, 13, 21, 21, 31, 32, 33];
  const harbinEdge = [11, 12, 13, 21, 21, 31, 32, 33];
  assert.equal(analyzeWin({ tiles: harbinKan, melds: harbinMelds, winTile: 32, ting: true }, harbinNoKan).ok, true);
  assert.equal(analyzeWin({ tiles: harbinEdge, melds: harbinMelds, winTile: 33, ting: true }, harbinNoKan).ok, false);
});

test('听牌提示过滤高级胡牌约束', () => {
  const rules = roomRules('harbin', { siKa: true });
  const kanRest = [11, 12, 13, 21, 21, 31, 33];
  const edgeRest = [11, 12, 13, 21, 21, 31, 32];
  const singleRest = [11, 12, 13, 21, 21, 45, 45];
  assert.deepEqual(getTingInfo(kanRest, harbinMelds, rules), { ting: true, waits: [32] });
  assert.deepEqual(getTingInfo(edgeRest, harbinMelds, rules), { ting: false, waits: [] });
  assert.deepEqual(getTingInfo(singleRest, harbinMelds, rules), { ting: false, waits: [] });
  assert.ok(getTingInfo(singleRest, harbinMelds, roomRules('harbin')).waits.length > 0);
});

test('双鸭山手把一：2 张暗牌时计手把一番', () => {
  const rules = roomRules('shuangyashan');
  const score = scoreRound({
    rules,
    analysis: {
      sevenPairs: false, allTriplets: false, kadan: false,
      melds: [{}, {}, {}], concealed: 2, pureSuit: false,
    },
    zimo: false, winnerSeat: 0, discarderSeat: 1, isDealer: false,
  });
  assert.equal(score.total, 4);
  assert.ok(score.items.some((item) => item.name === '手把一'));
});

test('哈尔滨听后出手炮与场次倍率参与计分', () => {
  const rules = roomRules('harbin', { scene: 'high', tingHouChuShouPao: true });
  const score = scoreRound({
    rules,
    analysis: {
      useBao: false, kanWait: false, singleWait: false, edgeWait: false,
      effectiveTile: 21, melds: [{}],
    },
    zimo: false, winnerSeat: 0, discarderSeat: 1, discarderTing: true,
    flags: { tingShooter: true }, isDealer: false,
  });
  assert.equal(score.total, 4);
  assert.equal(score.deltas[0], 12);
  assert.equal(score.deltas[1], -12);
  assert.ok(score.items.some((item) => item.name === '场次'));
  assert.ok(score.items.some((item) => item.name === '包三家'));
});
