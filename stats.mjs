import { getRule } from './server/rules.js';
import { Round } from './server/game.js';

function makeRules(id) {
  const r = getRule(id);
  r.__config = { rounds: 8, baseScore: 1, turnSeconds: 20, claimSeconds: 12, cap: r.scoring.cap, autoFillBots: true, botThinkingMs: 0 };
  return r;
}

for (const id of ['harbin', 'shuangyashan']) {
  const labels = {};
  let draw = 0, wallLeft = 0, zimo = 0;
  const t0 = performance.now();
  for (let n = 0; n < 100; n++) {
    const rules = makeRules(id);
    const seats = [0, 1, 2, 3].map((i) => ({ id: `p${i}`, name: `P${i}`, bot: true }));
    const round = new Round({ rules, seats, dealer: n % 4, scores: [0, 0, 0, 0], roundNo: 1 });
    let t = Date.now();
    let steps = 0;
    while (round.phase !== 'ended' && steps < 20000) { round.poll(t); t += 400; steps++; }
    if (round.phase !== 'ended') { console.log('STUCK', id, n); break; }
    const r = round.result;
    if (r.type === 'draw') draw++;
    else {
      wallLeft += round.wall.length;
      for (const w of r.winners) { labels[w.label] = (labels[w.label] || 0) + 1; if (w.zimo) zimo++; }
    }
  }
  console.log(id, '100局', (performance.now() - t0).toFixed(0) + 'ms', '荒庄', draw, '平均剩余墙', (wallLeft / (100 - draw)).toFixed(1), '自摸', zimo);
  console.log('  番型', JSON.stringify(labels));
}
