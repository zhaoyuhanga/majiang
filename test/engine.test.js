import test from 'node:test';
import assert from 'node:assert/strict';
import { getRule, buildRoomRules } from '../server/rules.js';
import { Round } from '../server/game.js';
import { Room } from '../server/rooms.js';
import { analyzeWin, getTingInfo } from '../server/rules.js';

function setup(ruleId, opts = {}) {
  const rules = buildRoomRules({
    ruleSet: ruleId,
    ruleOptions: opts.ruleOptions || {},
    options: { cap: getRule(ruleId).scoring.cap },
  });
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
    p.canSwapDraw = !!opts.canSwapDraw?.[i];
    p.drawSwapOpen = false;
    p.drawSwapUsed = false;
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

test('哈尔滨抢杠：补杠被抢，按点炮结算', () => {
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
  assert.equal(round.result.winners[0].zimo, false);
  const sum = round.result.deltas.reduce((a, b) => a + b, 0);
  assert.equal(sum, 0);
  // 抢杠按点炮；卡当 ×2，放炮者未听包三家，赢家 +6。
  assert.equal(round.result.deltas[1], 6);
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

test('开局准备：房主需等待其他真人玩家准备', () => {
  const room = new Room('TEST1', 'p0', { rounds: 1, autoFillBots: true });
  const socket = (id) => ({ id: `socket-${id}`, data: { clientId: id } });
  const host = room.addPlayer(socket('p0'), '房主');
  room.hostId = host.id;
  room.sit(host.id, 0);
  const guest = room.addPlayer(socket('p1'), '玩家');
  room.sit(guest.id, 1);
  room.addBot(2);
  room.addBot(3);
  assert.throws(() => room.startGame(host.id), /1 位玩家未准备/);
  room.setReady(guest.id, true);
  room.startGame(host.id);
  assert.equal(room.state, 'playing');
});

test('报听提示：只返回实际可听的弃牌', () => {
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
  assert.equal(round.optionsFor(0).ting, undefined);
  round.act(0, { type: 'tingHint' });
  const options = round.optionsFor(0);
  assert.equal(options.ting, true);
  assert.ok(options.tingDiscards[46]);
  assert.deepEqual(options.tingDiscards[46], [45]);
  for (const [tile, waits] of Object.entries(options.tingDiscards)) {
    const rest = round.players[0].hand.slice();
    rest.splice(rest.indexOf(Number(tile)), 1);
    const info = getTingInfo(rest, round.players[0].melds, round.rules);
    assert.equal(info.ting, true);
    assert.deepEqual(waits, info.waits);
  }
});

test('特殊换牌：仅本人可见、保持牌数守恒且每次摸牌限一次', () => {
  const round = setup('harbin', {
    hands: [
      [11, 12, 13, 14, 15, 16, 21, 21, 21, 45, 46, 47],
      [12, 13, 14, 16, 17, 18, 22, 23, 24, 32, 33, 34, 36],
      [12, 13, 14, 16, 17, 18, 22, 23, 24, 32, 33, 34, 36],
      [12, 13, 14, 16, 17, 18, 22, 23, 24, 32, 33, 34, 36],
    ],
    wall: [21, 21, 22, 23, 24, 25],
    drawn: [46, null, null, null],
    canSwapDraw: [true, false, false, false],
  });
  const before = round.players.flatMap((p) => p.hand).concat(round.wall).sort((a, b) => a - b);
  assert.throws(() => round.revealDraw(1), /没有.*权限|只能在本次摸牌/);
  const revealed = round.revealDraw(0).wallChoices;
  assert.deepEqual(revealed, { 21: 2, 22: 1, 23: 1, 24: 1, 25: 1 });
  assert.equal(round.snapshot(0).options.wallChoices[21], 2);
  assert.equal(round.snapshot(1).options, null);
  assert.equal(round.snapshot(-1).options, null);
  const reconnect = round.snapshot(0);
  assert.equal(reconnect.myHand.includes(46), true);
  assert.equal(reconnect.options.wallChoices[21], 2);
  round.swapDraw(0, 21);
  assert.equal(round.players[0].drawn, 21);
  assert.equal(round.players[0].hand.filter((tile) => tile === 46).length, 0);
  assert.equal(round.wall.filter((tile) => tile === 46).length, 1);
  assert.equal(round.wall.filter((tile) => tile === 21).length, 1);
  assert.deepEqual(round.players.flatMap((p) => p.hand).concat(round.wall).sort((a, b) => a - b), before);
  assert.throws(() => round.swapDraw(0, 22), /已经换过牌/);
  round.beginTurn(0);
  assert.equal(round.players[0].drawSwapUsed, false);
  assert.equal(round.players[0].drawSwapOpen, false);
});

test('特殊换牌：权限、报听和重复请求由服务端拦截', () => {
  const round = setup('harbin', {
    hands: [[11, 12, 13, 14, 15, 16, 21, 21, 21, 45, 46, 47], [], [], []],
    wall: [22, 23, 24],
    drawn: [46, null, null, null],
    canSwapDraw: [false, false, false, false],
  });
  assert.throws(() => round.revealDraw(0), /没有.*权限/);
  round.players[0].canSwapDraw = true;
  assert.throws(() => round.swapDraw(0, 22), /请先双击/);
  round.revealDraw(0);
  round.players[0].ting = true;
  assert.throws(() => round.swapDraw(0, 22), /报听后/);
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

test('双鸭山手把一规则：本次摸牌可换牌，关闭后不可用', () => {
  const melds = [
    { type: 'chi', tiles: [11, 12, 13] },
    { type: 'chi', tiles: [21, 22, 23] },
    { type: 'chi', tiles: [31, 32, 33] },
  ];
  const round = setup('shuangyashan', {
    ruleOptions: { shouBaYiSwap: true },
    hands: [[45, 45, 46], [], [], []],
    melds: [melds, [], [], []],
    drawn: [46, null, null, null],
    wall: [21, 22, 23],
  });
  assert.equal(round.canSwapDraw(0), true);
  assert.equal(round.revealDraw(0).wallChoices[21], 1);
  round.swapDraw(0, 21);
  assert.equal(round.players[0].drawn, 21);
  assert.equal(round.players[0].hand.includes(46), false);
  assert.equal(round.wall.includes(46), true);

  const disabled = setup('shuangyashan', {
    hands: [[45, 45, 46], [], [], []],
    melds: [melds, [], [], []],
    drawn: [46, null, null, null],
  });
  assert.equal(disabled.canSwapDraw(0), false);
});

test('哈尔滨漏胡：报听后摸到所听宝牌立即结算', () => {
  const round = setup('harbin', {
    ruleOptions: { louHu: true },
    hands: [[11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24], [], [], []],
    ting: [true, false, false, false],
    tingWaits: [[45], [], [], []],
    wall: [45, 21, 22],
    bao: { rank: 45, indicator: 19, swaps: 0 },
  });
  round.beginTurn(0);
  assert.equal(round.phase, 'ended');
  assert.equal(round.result.winners[0].label, '漏胡');
  assert.equal(round.result.winners[0].fan, 3);
  assert.deepEqual(round.result.deltas, [9, -3, -3, -3]);
});

test('哈尔滨红中满天飞：立即胡牌并应用场次倍率', () => {
  const round = setup('harbin', {
    ruleOptions: { hongZhongManTianFei: true, scene: 'high' },
    hands: [[11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24], [], [], []],
    ting: [true, false, false, false],
    wall: [45, 21, 22],
  });
  round.beginTurn(0);
  assert.equal(round.result.winners[0].label, '红中满天飞');
  assert.equal(round.result.winners[0].fan, 8);
  assert.deepEqual(round.result.deltas, [24, -8, -8, -8]);
});

test('哈尔滨刮风：听牌后摸到暗刻第四张立即结算', () => {
  const round = setup('harbin', {
    ruleOptions: { guaFeng: true },
    hands: [[21, 21, 21, 11, 12, 13, 14, 15, 16, 17, 18, 19, 31], [], [], []],
    ting: [true, false, false, false],
    wall: [21, 22, 23],
  });
  round.beginTurn(0);
  assert.equal(round.result.winners[0].label, '刮风');
  assert.equal(round.result.winners[0].fan, 1);
});

test('哈尔滨快宝与暗宝：按玩家控制宝牌公开', () => {
  const quick = setup('harbin', {
    ruleOptions: { kuaiBao: true },
    ting: [true, false, false, false],
    bao: { rank: 11, indicator: 19, swaps: 0 },
  });
  assert.equal(quick.snapshot(0).bao.rank, 11);
  assert.equal(quick.snapshot(-1).bao.rank, null);

  const hidden = setup('harbin', {
    ting: [true, false, false, false],
    bao: { rank: 11, indicator: 19, swaps: 0 },
  });
  assert.equal(hidden.snapshot(0).bao.rank, null);
  hidden.players[0].baoRevealed = true;
  assert.equal(hidden.snapshot(0).bao.rank, 11);
  assert.equal(hidden.snapshot(-1).bao.rank, null);
});

test('哈尔滨杠分延迟到本局结算', () => {
  const round = setup('harbin', { ruleOptions: { guaFeng: true, gangSuanFen: false } });
  round.applyGangScore(0, 'an');
  assert.deepEqual(round.deltas, [0, 0, 0, 0]);
  assert.deepEqual(round.pendingGangDeltas, [3, -1, -1, -1]);
  round.flushGangDeltas();
  assert.deepEqual(round.deltas, [3, -1, -1, -1]);
  assert.deepEqual(round.pendingGangDeltas, [0, 0, 0, 0]);
});
