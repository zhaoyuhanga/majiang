// 压力测试：大量机器人对局，检查异常
import { getRule } from './server/rules.js';
import { Round } from './server/game.js';

function makeRules(id) {
  const r = getRule(id);
  r.__config = { rounds: 8, baseScore: 1, turnSeconds: 20, claimSeconds: 12, cap: r.scoring.cap, autoFillBots: true, botThinkingMs: 0 };
  return r;
}

const N = Number(process.argv[2] || 300);
for (const id of ['harbin', 'shuangyashan']) {
  const labels = {};
  let draw = 0, stuck = 0, bad = 0, wins = 0;
  const t0 = performance.now();
  for (let n = 0; n < N; n++) {
    const rules = makeRules(id);
    const seats = [0, 1, 2, 3].map((i) => ({ id: `p${i}`, name: `P${i}`, bot: true }));
    const round = new Round({ rules, seats, dealer: n % 4, scores: [0, 0, 0, 0], roundNo: 1 });
    let t = Date.now();
    let steps = 0;
    try {
      while (round.phase !== 'ended' && steps < 20000) { round.poll(t); t += 400; steps++; }
    } catch (e) {
      bad++;
      console.log('ERROR', id, n, e.stack);
      continue;
    }
    if (round.phase !== 'ended') { stuck++; continue; }
    const r = round.result;
    const sum = r.deltas.reduce((a, b) => a + b, 0);
    if (sum !== 0) { bad++; console.log('BAD DELTAS', id, n, r.deltas); }
    if (r.type === 'draw') draw++;
    else {
      wins++;
      for (const w of r.winners) labels[w.label] = (labels[w.label] || 0) + 1;
      for (const w of r.winners) {
        const p = round.players[w.seat];
        if (!p.melds) { bad++; }
      }
    }
  }
  console.log(id, N + '局', (performance.now() - t0).toFixed(0) + 'ms', '胡', wins, '荒庄', draw, '卡住', stuck, '异常', bad, JSON.stringify(labels));
}
