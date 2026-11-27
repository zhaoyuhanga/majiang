import { shanten } from './server/mahjong.js';
import { getRule } from './server/rules.js';
import { botTurnAction } from './server/bot.js';
import { Round } from './server/game.js';

function makeRules(id) {
  const r = getRule(id);
  r.__config = { rounds: 8, baseScore: 1, turnSeconds: 20, claimSeconds: 12, cap: r.scoring.cap, autoFillBots: true, botThinkingMs: 0 };
  return r;
}

function randomHand(rules, n = 14) {
  const wall = [];
  for (const s of rules.wall.suits) for (let r = 1; r <= 9; r++) for (let k = 0; k < 4; k++) wall.push(s * 10 + r);
  for (const t of rules.wall.extra || []) for (let k = 0; k < 4; k++) wall.push(t);
  for (let i = wall.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [wall[i], wall[j]] = [wall[j], wall[i]]; }
  return wall.slice(0, n).sort((a, b) => a - b);
}

const rules = makeRules('harbin');
const hands = Array.from({ length: 300 }, () => randomHand(rules, 13));
let t0 = performance.now();
let total = 0;
for (const h of hands) { shanten(h, 0, rules); total++; }
let t1 = performance.now();
console.log('13张向听: ', total, '次', (t1 - t0).toFixed(1), 'ms, 平均', ((t1 - t0) / total).toFixed(2), 'ms');

// 最坏情况：随机 14 张首打决策
const round = new Round({ rules, seats: [0,1,2,3].map(i => ({ id: 'p'+i, name: 'P'+i, bot: true })), dealer: 0, scores: [0,0,0,0], roundNo: 1 });
t0 = performance.now();
for (let i = 0; i < 20; i++) {
  // 直接调用机器人决策（构造一个临时 14 张手牌）
  round.players[0].hand = randomHand(rules, 14);
  round.players[0].drawn = round.players[0].hand[0];
  round.players[0].melds = [];
  round.players[0].ting = false;
  round.phase = 'discard'; round.turn = 0;
  try { botTurnAction(round, 0); } catch (e) { console.log('bot err', e.message); }
}
t1 = performance.now();
console.log('20 次机器人出牌决策:', (t1 - t0).toFixed(1), 'ms, 平均', ((t1 - t0) / 20).toFixed(1), 'ms');

t0 = performance.now();
for (let i = 0; i < 300; i++) {
  round.players[0].hand = randomHand(rules, 11);
  round.players[0].drawn = round.players[0].hand.at(-1);
  round.players[0].melds = [{ type: 'chi', tiles: [31, 32, 33], from: 1 }];
  round.players[0].ting = false;
  round.optionsFor(0);
}
t1 = performance.now();
console.log('300 次报听提示:', (t1 - t0).toFixed(1), 'ms, 平均', ((t1 - t0) / 300).toFixed(2), 'ms');
