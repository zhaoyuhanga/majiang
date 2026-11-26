import test from 'node:test';
import assert from 'node:assert/strict';
import { getRule } from '../server/rules.js';
import { Round } from '../server/game.js';

function makeRules(id) {
  const r = getRule(id);
  r.__config = {
    rounds: 8, baseScore: 1, turnSeconds: 20, claimSeconds: 12,
    cap: r.scoring.cap, autoFillBots: true, botThinkingMs: 0,
  };
  return r;
}

function playOne(id, seed) {
  const rules = makeRules(id);
  const seats = [0, 1, 2, 3].map((i) => ({ id: `p${i}`, name: `P${i}`, bot: true }));
  const round = new Round({ rules, seats, dealer: seed % 4, scores: [0, 0, 0, 0], roundNo: 1 });
  let t = Date.now();
  let steps = 0;
  while (round.phase !== 'ended' && steps < 20000) {
    round.poll(t);
    t += 400;
    steps++;
    if (round.phase === 'ended') break;
    // 不变量：手牌张数合法
    for (const p of round.players) {
      const meldTiles = p.melds.reduce((a, m) => a + m.tiles.length, 0);
      const kongs = p.melds.filter((m) => m.tiles.length === 4).length;
      assert.ok(p.hand.length + meldTiles <= 15 + kongs, `手牌过多 seat=${p.seat} hand=${p.hand.length}`);
      if (round.phase === 'discard' || round.phase === 'claim') {
        const total = p.hand.length + meldTiles;
        assert.ok(total === 13 + kongs || total === 14 + kongs, `手牌张数异常 seat=${p.seat} total=${total}`);
      }
    }
  }
  assert.equal(round.phase, 'ended', `第 ${seed} 局没有结束，steps=${steps}`);
  const sum = round.result.deltas.reduce((a, b) => a + b, 0);
  assert.equal(sum, 0, '分数不守恒: ' + JSON.stringify(round.result.deltas));
  return round.result;
}

for (const ruleId of ['harbin', 'shuangyashan']) {
  test(`${ruleId} 机器人对局 30 局`, () => {
    let win = 0, draw = 0;
    const winners = [0, 0, 0, 0];
    for (let i = 0; i < 30; i++) {
      const r = playOne(ruleId, i);
      if (r.type === 'win') {
        win++;
        for (const w of r.winners) winners[w.seat]++;
      } else draw++;
    }
    console.log(`${ruleId}: 胡牌 ${win} 局 / 荒庄 ${draw} 局, 各座位胡牌数 ${winners.join(',')}`);
    assert.ok(win + draw === 30);
  });
}
