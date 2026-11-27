// 人机 AI：基于向听数与进张的启发式
import { shanten, ukeire, getWaits, sortTiles, countsOf, isHonor, rankOf, suitOf } from './mahjong.js';
import { analyzeWin, getTingInfo } from './rules.js';

function distinct(hand) { return Array.from(new Set(hand)); }

function shantenOf(hand, meldCount, rules) {
  return shanten(hand, meldCount, rules);
}

function ukeireCount(hand, meldCount, rules, visible) {
  try {
    return ukeire(hand, meldCount, rules, visible).total;
  } catch { return 0; }
}

function visibleTiles(round, seat) {
  const vis = [];
  for (const p of round.players) {
    vis.push(...p.discards);
    for (const m of p.melds) vis.push(...m.tiles);
  }
  return vis;
}

/** 静态牌效分：对子、搭子、中张更值得留 */
function tileKeepValue(tile, c) {
  let v = 0;
  if (tile >= 41) {
    return c[tile] >= 2 ? 5 : -1;
  }
  const r = rankOf(tile);
  if (c[tile] >= 3) v += 10;
  else if (c[tile] === 2) v += 7;
  else v += 2;
  const suit = suitOf(tile);
  for (const d of [-2, -1, 1, 2]) {
    const r2 = r + d;
    if (r2 < 1 || r2 > 9) continue;
    if (c[suit * 10 + r2] > 0) v += Math.abs(d) === 1 ? 3 : 1;
  }
  if (r === 1 || r === 9) v -= 2;
  if (r >= 4 && r <= 6) v += 1;
  return v;
}

/** 选一张最该打出的牌 */
function chooseDiscard(round, seat) {
  const p = round.players[seat];
  const rules = round.rules;
  const meldCount = p.melds.length;
  const hand = p.hand;
  const c = countsOf(hand);
  const base = shantenOf(hand, meldCount, rules);
  let best = null;
  for (const tile of distinct(hand)) {
    const rest = hand.slice();
    rest.splice(rest.indexOf(tile), 1);
    const sh = shantenOf(rest, meldCount, rules);
    let keep = 0;
    const restCounts = countsOf(rest);
    for (const t of distinct(rest)) keep += tileKeepValue(t, restCounts) * restCounts[t];
    const score = -sh * 1000 + keep * 0.6;
    if (!best || score > best.score) best = { tile, score, sh };
  }
  return best ? best.tile : hand[hand.length - 1];
}

export function botTurnAction(round, seat) {
  const p = round.players[seat];
  const rules = round.rules;
  const meldCount = p.melds.length;

  // 能胡就胡
  if (p.drawn != null) {
    const a = analyzeWin({
      tiles: p.hand, melds: p.melds, winTile: p.drawn, zimo: true, ting: p.ting,
      baoRank: round.bao?.rank ?? null,
    }, rules);
    if (a.ok) return { type: 'hu' };
  }

  // 已报听：打摸到的牌
  if (p.ting) {
    return { type: 'discard', tile: p.drawn ?? sortTiles(p.hand).pop() };
  }

  // 报听判断
  if (rules.win.requireTing) {
    let bestTing = null;
    for (const tile of distinct(p.hand)) {
      const rest = p.hand.slice();
      rest.splice(rest.indexOf(tile), 1);
      if (rest.length % 3 !== 1) continue;
      const info = getTingInfo(rest, p.melds, rules);
      if (!info.ting) continue;
      const waitsLeft = info.waits.reduce((acc, w) => acc + Math.max(0, 4 - (countsOf(p.hand)[w] || 0)), 0);
      if (!bestTing || waitsLeft > bestTing.waitsLeft) bestTing = { tile, waitsLeft, waits: info.waits };
    }
    if (bestTing) return { type: 'ting', tile: bestTing.tile };
  }

  // 暗杠/补杠：不破坏听牌才杠（已听则跳过）
  if (rules.allowGang) {
    const c = countsOf(p.hand);
    for (let t = 11; t <= 47; t++) {
      if (c[t] === 4) {
        const rest = p.hand.filter((x) => x !== t);
        if (shantenOf(rest, meldCount + 1, rules) <= shantenOf(p.hand, meldCount, rules)) {
          return { type: 'angang', tile: t };
        }
      }
    }
    for (const m of p.melds) {
      if (m.type === 'peng' && p.hand.includes(m.tiles[0])) {
        const rest = p.hand.slice();
        rest.splice(rest.indexOf(m.tiles[0]), 1);
        if (shantenOf(rest, meldCount, rules) <= shantenOf(p.hand, meldCount, rules)) {
          return { type: 'bugang', tile: m.tiles[0] };
        }
      }
    }
  }

  return { type: 'discard', tile: chooseDiscard(round, seat) };
}

export function botClaimAction(round, seat) {
  const pending = round.pending;
  const opts = pending.options[seat];
  if (!opts) return { type: 'pass' };
  const p = round.players[seat];
  const rules = round.rules;
  const meldCount = p.melds.length;

  if (opts.hu) return { type: 'hu' };

  const curSh = shantenOf(p.hand, meldCount, rules);
  const mustOpen = rules.win.mustOpen && meldCount === 0;

  // 评估碰/杠/吃后的向听
  const evalAfter = (removeTiles, addMeld = 1) => {
    const rest = p.hand.slice();
    for (const t of removeTiles) {
      const i = rest.indexOf(t);
      if (i < 0) return 99;
      rest.splice(i, 1);
    }
    return shantenOf(rest, meldCount + addMeld, rules);
  };

  if (opts.gang) {
    const after = evalAfter([pending.tile, pending.tile, pending.tile]);
    if (after <= curSh + 1 || rules.scoring.gangScore?.ming) return { type: 'gang' };
  }
  if (opts.peng) {
    const after = evalAfter([pending.tile, pending.tile]);
    if (after < curSh || (mustOpen && meldCount === 0) || (after === curSh && curSh >= 0 && mustOpen)) {
      return { type: 'peng' };
    }
  }
  if (opts.chi) {
    let best = null;
    for (const combo of opts.chi) {
      const after = evalAfter(combo);
      if (!best || after < best.after) best = { combo, after };
    }
    if (best && (best.after < curSh || (mustOpen && meldCount === 0) || (mustOpen && best.after <= curSh))) {
      return { type: 'chi', tiles: best.combo };
    }
  }
  return { type: 'pass' };
}
