import { getRule } from './server/rules.js';
import { Round } from './server/game.js';

const r = getRule('harbin');
r.__config = { rounds: 8, baseScore: 1, turnSeconds: 20, claimSeconds: 12, cap: 36, autoFillBots: true, botThinkingMs: 0 };
const seats = [0, 1, 2, 3].map((i) => ({ id: `p${i}`, name: `P${i}`, bot: true }));
const round = new Round({ rules: r, seats, dealer: 0, scores: [0, 0, 0, 0], roundNo: 1 });
let t = Date.now();
for (let step = 0; step < 400; step++) {
  try {
    round.poll(t);
  } catch (e) {
    console.log('POLL ERROR', e.message);
  }
  t += 400;
  if (step % 20 === 0 || round.phase === 'ended') {
    console.log(step, 'phase', round.phase, 'turn', round.turn, 'wall', round.wall.length,
      'hands', round.players.map((p) => p.hand.length).join(','),
      'melds', round.players.map((p) => p.melds.length).join(','),
      'ting', round.players.map((p) => p.ting ? 'T' : '-').join(''),
      'drawn', round.players.map((p) => p.drawn ?? '-').join(','),
      'pending', round.pending ? JSON.stringify(round.pending.responses) : '-');
  }
  if (round.phase === 'ended') { console.log('RESULT', JSON.stringify(round.result.winners)); break; }
}
