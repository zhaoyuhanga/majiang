import test from 'node:test';
import assert from 'node:assert/strict';
import { getRule } from '../server/rules.js';
import { Round } from '../server/game.js';
import { analyzeWin } from '../server/rules.js';

function setup(ruleId, opts = {}) {
  const rules = getRule(ruleId);
  rules.__config = { rounds: 8, baseScore: 1, turnSeconds: 20, claimSeconds: 12, cap: rules.scoring.cap, autoFillBots: true, botThinkingMs: 0 };
  const seats = [0, 1, 2, 3].map((i) => ({ id: `p${i}`, name: `P${i}`, bot: true }));
  const round = new Round({ rules, seats, dealer: opts.dealer ?? 0, scores: [0, 0, 0, 0], roundNo: 1 });
  round.autoAction = null;
  round.events = [];
  round.wall = (opts.wall || [21, 22, 23, 24, 25, 26, 27, 28, 29, 11, 12, 13, 14, 15, 16, 17, 18, 19, 31, 32, 33, 34, 35, 36]).slice();
  round.players.forEach((p, i) => {
    p.hand = (opts.hands?.[i] || []).slice();
    p.melds = (opts.melds?.[i] || []).slice();
    p.ting = !!opts.ting?.[i];
    p.tingWaits = opts.tingWaits?.[i] || [];
    p.discards = (opts.discards?.[i] || []).slice();
    p.drawn = opts.drawn?.[i] ?? null;
    p.bot = true;
  });
  round.phase = 'discard';
  round.turn = opts.dealer ?? 0;
  round.pending = null;
  round.result = null;
  round.bao = opts.bao || null;
  round.deadline = Date.now() + 20000;
  round.botAt = Date.now() + 100000; // 不让机器人自动行动
  return round;
}

test('哈尔滨报听：锁定手牌并自动打牌', () => {
  const round = setup('harbin', {
    hands: [
      [11, 12, 13, 14, 15, 16, 21, 21, 21, 45, 46],
      [12, 13, 14, 16, 17, 18, 22, 23, 24, 32, 33, 34, 36],
      [12, 13, 14, 16, 17, 18, 22, 23, 24, 32, 33, 34, 36],
      [12, 13, 14, 16, 17, 18, 22, 23, 24, 32, 33, 34, 36],
    ],
    melds: [[{ type: 'chi', tiles: [31, 32, 33], from: 3 }], [], [], []],
    drawn: [46, null, null, null],
  });
  round.act(0, { type: 'ting', tile: 46 });
  assert.equal(round.players[0].ting, true);
  assert.equal(round.players[0].hand.length, 10);
  assert.ok(round.players[0].tingWaits.length > 0);
  assert.deepEqual(round.players[0].tingWaits, [45]);
  // 报听后只能打摸到的牌
  round.turn = 0;
  round.phase = 'discard';
  round.players[0].drawn = 12;
  round.players[0].hand.push(12);
  assert.throws(() => round.discard(0, 11), /只能打出刚摸的牌/);
});

test('哈尔滨抢杠：补杠被抢，按自摸三家付', () => {
  const round = setup('harbin', {
    hands: [
      [11, 12, 13, 14, 15, 16, 21, 21, 21, 22, 45],
      [14, 15, 16, 21, 21, 21, 31, 32, 33, 45],
      [12, 13, 14, 16, 17, 18, 22, 23, 24, 32, 33, 34, 36],
      [12, 13, 14, 16, 17, 18, 22, 23, 24, 32, 33, 34, 36],
    ],
    melds: [[{ type: 'peng', tiles: [45, 45, 45], from: 2 }], [{ type: 'chi', tiles: [11, 12, 13], from: 3 }], [], []],
    ting: [false, true, false, false],
    tingWaits: [[], [45], [], []],
  });
  round.players[0].drawn = 45;
  round.doAddGang(0, 45);
  assert.equal(round.phase, 'ended');
  assert.equal(round.result.type, 'win');
  assert.equal(round.result.winners[0].seat, 1);
  assert.equal(round.result.winners[0].zimo, true);
  const sum = round.result.deltas.reduce((a, b) => a + b, 0);
  assert.equal(sum, 0);
  // 自摸：三家各付；卡当 ×2 -> 4 番 × 底分 1，赢家 +12
  assert.equal(round.result.deltas[1], 12);
});

test('哈尔滨宝中宝：卡当听牌摸到宝', () => {
  const rules = getRule('harbin');
  const a = analyzeWin({
    tiles: [11, 12, 13, 21, 21, 21, 31, 31, 31, 45, 45],
    melds: [{ type: 'chi', tiles: [41, 41, 41] }],
    winTile: 45, zimo: true, ting: true, baoRank: 45,
  }, rules);
  // 需要两门、有幺、有刻有顺；这里用 11-13 万 + 筒/条刻子 + 中作将，但中不参与花色
  assert.equal(a.ok, true, a.reason);
  assert.equal(a.useBao, true);
  assert.equal(a.kadan, true);
});

test('换宝：牌河出现三张宝后换宝', () => {
  const round = setup('harbin', {
    hands: [[], [], [], []],
    wall: [21, 22, 23],
    bao: { rank: 11, indicator: 11, swaps: 0 },
  });
  round.players[0].discards = [11, 11];
  round.players[1].discards = [11];
  round.maybeSwapBao();
  assert.notEqual(round.bao.rank, 11);
  assert.equal(round.bao.swaps, 1);
});

test('双鸭山杠分：明杠放杠者付，暗杠三家付', () => {
  const round = setup('shuangyashan', { hands: [[], [], [], []] });
  round.applyGangScore(0, 'ming', 2);
  assert.deepEqual(round.deltas, [2, 0, -2, 0]);
  const round2 = setup('shuangyashan', { hands: [[], [], [], []] });
  round2.applyGangScore(1, 'an');
  assert.deepEqual(round2.deltas, [-2, 6, -2, -2]);
});

test('荒庄：牌墙摸完结束', () => {
  const round = setup('shuangyashan', {
    hands: [[11, 12, 13, 14, 15, 16, 21, 21, 21, 31, 32, 33, 45], [], [], []],
    wall: [],
  });
  round.beginTurn(0);
  assert.equal(round.phase, 'ended');
  assert.equal(round.result.type, 'draw');
  assert.deepEqual(round.result.deltas, [0, 0, 0, 0]);
});
