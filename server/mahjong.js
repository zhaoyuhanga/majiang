// 麻将牌与牌型核心算法（规则无关）
// 牌编码：万 11-19，筒 21-29，条 31-39，风/箭 41-47（东南西北中发白），花 51-58

export const WAN = 1;
export const TONG = 2;
export const TIAO = 3;
export const HONOR = 4;
export const FLOWER = 5;

export const HONOR_NAMES = {
  41: '东', 42: '南', 43: '西', 44: '北', 45: '中', 46: '发', 47: '白',
};

export const SUIT_NAMES = { 1: '万', 2: '筒', 3: '条' };

export function suitOf(t) { return Math.floor(t / 10); }
export function rankOf(t) { return t % 10; }
export function isHonor(t) { return t >= 41 && t <= 47; }
export function isFlower(t) { return t >= 51 && t <= 58; }
export function isSuited(t) { return t >= 11 && t <= 39; }
export function isTerminal(t) { return isSuited(t) && (rankOf(t) === 1 || rankOf(t) === 9); }

export function tileName(t) {
  if (t == null) return '?';
  if (isHonor(t)) return HONOR_NAMES[t] || '?';
  if (isFlower(t)) return '花' + (t - 50);
  const s = suitOf(t), r = rankOf(t);
  return `${r}${SUIT_NAMES[s] || '?'}`;
}

export function tileLabel(t) {
  // 供 UI 使用的结构
  const s = suitOf(t);
  if (isHonor(t)) return { t, kind: 'honor', text: HONOR_NAMES[t] };
  if (isFlower(t)) return { t, kind: 'flower', text: '花' + (t - 50) };
  return { t, kind: 'suit', suit: s, rank: rankOf(t), text: `${rankOf(t)}${SUIT_NAMES[s]}` };
}

export function sortTiles(tiles) {
  return tiles.slice().sort((a, b) => a - b);
}

export function countsOf(tiles) {
  const c = new Array(48).fill(0);
  for (const t of tiles) if (t > 0 && t < 48) c[t]++;
  return c;
}

export function tilesOfCounts(c) {
  const out = [];
  for (let t = 1; t < 48; t++) for (let i = 0; i < c[t]; i++) out.push(t);
  return out;
}

export function countOf(tiles, tile) {
  let n = 0;
  for (const t of tiles) if (t === tile) n++;
  return n;
}

// 牌墙
export function buildWall(rules) {
  const wall = [];
  const copies = rules.copies || 4;
  const suits = rules.suits || [WAN, TONG, TIAO];
  for (const s of suits) {
    for (let r = 1; r <= 9; r++) {
      for (let k = 0; k < copies; k++) wall.push(s * 10 + r);
    }
  }
  if (rules.honors) {
    for (let r = 1; r <= 7; r++) {
      for (let k = 0; k < copies; k++) wall.push(40 + r);
    }
  }
  if (rules.flowers) {
    for (let r = 1; r <= 8; r++) {
      for (let k = 0; k < 1; k++) wall.push(50 + r);
    }
  }
  if (Array.isArray(rules.extra)) {
    for (const t of rules.extra) {
      for (let k = 0; k < copies; k++) wall.push(t);
    }
  }
  return wall;
}

export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- 胡牌判定 ----------

// 剩余的牌能否恰好组成 need 副面子
function canFormMelds(c, need) {
  if (need === 0) {
    for (let i = 1; i < 48; i++) if (c[i] > 0) return false;
    return true;
  }
  let i = -1;
  for (let k = 1; k < 48; k++) if (c[k] > 0) { i = k; break; }
  if (i < 0) return false;
  const s = suitOf(i), r = rankOf(i);
  if (c[i] >= 3) {
    c[i] -= 3;
    if (canFormMelds(c, need - 1)) { c[i] += 3; return true; }
    c[i] += 3;
  }
  if (s >= WAN && s <= TIAO && r <= 7 && c[i + 1] > 0 && c[i + 2] > 0) {
    c[i]--; c[i + 1]--; c[i + 2]--;
    if (canFormMelds(c, need - 1)) { c[i]++; c[i + 1]++; c[i + 2]++; return true; }
    c[i]++; c[i + 1]++; c[i + 2]++;
  }
  return false;
}

function standardWin(c, need) {
  for (let i = 1; i < 48; i++) {
    if (c[i] >= 2) {
      c[i] -= 2;
      const ok = canFormMelds(c, need);
      c[i] += 2;
      if (ok) return true;
    }
  }
  return false;
}

function sevenPairsWin(c) {
  let pairs = 0, total = 0;
  for (let i = 1; i < 48; i++) {
    total += c[i];
    if (c[i] % 2 !== 0) return false;
    pairs += c[i] / 2;
  }
  return total === 14 && pairs === 7;
}

function thirteenOrphansWin(c) {
  const need = [11, 19, 21, 29, 31, 39, 41, 42, 43, 44, 45, 46, 47];
  let total = 0, pair = 0;
  for (const t of need) {
    if (c[t] === 0) return false;
    if (c[t] >= 2) pair++;
    total += c[t];
  }
  for (let i = 1; i < 48; i++) {
    if (!need.includes(i) && c[i] > 0) return false;
  }
  return total === 14 && pair === 1;
}

/**
 * 判定是否胡牌
 * @param {number[]} tiles 暗牌（不含副露）
 * @param {number} meldCount 已副露副数
 * @param {object} rules
 */
export function isWinningHand(tiles, meldCount, rules) {
  const win = rules.win || rules;
  const need = 4 - meldCount;
  if (need < 0 || tiles.length !== need * 3 + 2) return false;
  if (win.mustOpen && meldCount === 0) return false;
  const c = countsOf(tiles);
  if (standardWin(c, need)) return true;
  if (need === 4 && !win.mustOpen) {
    if (win.allowSevenPairs && sevenPairsWin(c)) return true;
    if (win.allowThirteenOrphans && thirteenOrphansWin(c)) return true;
  }
  return false;
}

/** 七对（含豪华七对）判定，用于番型 */
export function isSevenPairs(tiles, meldCount) {
  if (meldCount !== 0 || tiles.length !== 14) return false;
  return sevenPairsWin(countsOf(tiles));
}

export function isThirteenOrphans(tiles, meldCount) {
  if (meldCount !== 0 || tiles.length !== 14) return false;
  return thirteenOrphansWin(countsOf(tiles));
}

// ---------- 听牌 ----------

/** 返回所有能胡的牌（用于听牌提示 / 等待判定） */
export function getWaits(tiles, meldCount, rules, maxTile = 47) {
  const waits = [];
  const c = countsOf(tiles);
  for (let t = 11; t <= 47; t++) {
    if (!isValidTileForRules(t, rules)) continue;
    if (c[t] >= 4) continue;
    const next = tiles.concat(t);
    if (isWinningHand(next, meldCount, rules)) waits.push(t);
  }
  return waits;
}

export function isValidTileForRules(t, rules) {
  const wall = rules.wall || rules;
  if (isFlower(t)) return !!wall.flowers;
  if (isHonor(t)) {
    if (wall.honors) return true;
    return Array.isArray(wall.extra) && wall.extra.includes(t);
  }
  if (isSuited(t)) {
    const s = suitOf(t);
    return (wall.suits || [1, 2, 3]).includes(s);
  }
  return false;
}

// ---------- 向听数 ----------

function scoreShanten(melds, partials, hasPair, fixedMelds) {
  const m = melds + fixedMelds;
  let t = Math.min(partials, Math.max(0, 4 - m));
  let sh = 8 - 2 * m - t - (hasPair ? 1 : 0);
  return sh;
}

function stdShantenCounts(c, fixedMelds) {
  const memo = new Map();
  const arr = c.slice();

  function dfs(melds, partials, hasPair) {
    if (melds + fixedMelds + partials > 4) return 8;
    const key = arr.join(',') + '|' + melds + '|' + partials + '|' + (hasPair ? 1 : 0);
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let i = -1;
    for (let k = 1; k < 48; k++) if (arr[k] > 0) { i = k; break; }
    let best;
    if (i < 0) {
      best = scoreShanten(melds, partials, hasPair, fixedMelds);
    } else {
      best = 8;
      const s = suitOf(i), r = rankOf(i);
      const suited = s >= WAN && s <= TIAO;
      // 刻子
      if (arr[i] >= 3) {
        arr[i] -= 3;
        const v = dfs(melds + 1, partials, hasPair);
        arr[i] += 3;
        if (v < best) best = v;
      }
      // 顺子
      if (suited && r <= 7 && arr[i + 1] > 0 && arr[i + 2] > 0) {
        arr[i]--; arr[i + 1]--; arr[i + 2]--;
        const v = dfs(melds + 1, partials, hasPair);
        arr[i]++; arr[i + 1]++; arr[i + 2]++;
        if (v < best) best = v;
      }
      // 对子：做将 或 做搭子
      if (arr[i] >= 2) {
        arr[i] -= 2;
        if (!hasPair) {
          const v = dfs(melds, partials, true);
          if (v < best) best = v;
        }
        const v2 = dfs(melds, partials + 1, hasPair);
        if (v2 < best) best = v2;
        arr[i] += 2;
      }
      // 两面 / 边张搭子
      if (suited && r <= 8 && arr[i + 1] > 0) {
        arr[i]--; arr[i + 1]--;
        const v = dfs(melds, partials + 1, hasPair);
        arr[i]++; arr[i + 1]++;
        if (v < best) best = v;
      }
      // 坎张搭子
      if (suited && r <= 7 && arr[i + 2] > 0) {
        arr[i]--; arr[i + 2]--;
        const v = dfs(melds, partials + 1, hasPair);
        arr[i]++; arr[i + 2]++;
        if (v < best) best = v;
      }
      // 弃掉这张
      arr[i]--;
      const vSkip = dfs(melds, partials, hasPair);
      arr[i]++;
      if (vSkip < best) best = vSkip;
    }
    memo.set(key, best);
    return best;
  }

  return dfs(0, 0, false);
}

/**
 * 向听数：-1 表示已胡，0 表示听牌
 * 对 14 张牌取打出某张后的最小值
 */
const shantenCache = new Map();
export function shanten(tiles, meldCount, rules) {
  let hand = tiles;
  if (hand.length % 3 === 2) {
    if (isWinningHand(hand, meldCount, rules)) return -1;
    // 14 张（或副露后等价的 3n+2）：取最优打出
    let best = 8;
    const seen = new Set();
    for (const t of hand) {
      if (seen.has(t)) continue;
      seen.add(t);
      const rest = hand.slice();
      rest.splice(rest.indexOf(t), 1);
      best = Math.min(best, shanten(rest, meldCount, rules));
    }
    return best;
  }
  const sorted = sortTiles(hand);
  const win = rules.win || rules;
  const cacheKey = `${sorted.length}|${meldCount}|${win.allowSevenPairs ? 1 : 0}|${win.mustOpen ? 1 : 0}|${win.allowThirteenOrphans ? 1 : 0}|${sorted.join(',')}`;
  const hit = shantenCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const c = countsOf(sorted);
  let best = stdShantenCounts(c, meldCount);
  if (meldCount === 0 && win.allowSevenPairs) {
    let pairs = 0;
    for (let i = 1; i < 48; i++) pairs += Math.floor(c[i] / 2);
    let sh = 6 - pairs;
    if (hand.length % 3 === 1) sh = Math.max(-1, sh);
    best = Math.min(best, sh);
  }
  if (shantenCache.size > 60000) shantenCache.clear();
  shantenCache.set(cacheKey, best);
  return best;
}

/** 进张：对 13 张手牌，哪些牌能降低向听数，并统计剩余张数 */
export function ukeire(tiles, meldCount, rules, visible) {
  const base = shanten(tiles, meldCount, rules);
  const c = countsOf(tiles);
  const vis = visible ? countsOf(visible) : new Array(48).fill(0);
  const out = [];
  for (let t = 11; t <= 47; t++) {
    if (!isValidTileForRules(t, rules)) continue;
    if (c[t] >= 4) continue;
    const remain = 4 - c[t] - vis[t];
    if (remain <= 0) continue;
    const next = tiles.concat(t);
    const sh = shanten(next, meldCount, rules);
    if (sh < base) out.push({ tile: t, shanten: sh, remain });
  }
  return { base, tiles: out, total: out.reduce((a, b) => a + b.remain, 0) };
}

/** 计算打出一张后的向听（用于机器人） */
export function shantenAfterDiscard(hand, tile, meldCount, rules) {
  const rest = hand.slice();
  rest.splice(rest.indexOf(tile), 1);
  return shanten(rest, meldCount, rules);
}

// ---------- 其他 ----------

export function canPeng(hand, tile) {
  return countOf(hand, tile) >= 2;
}

export function canGangFromDiscard(hand, tile) {
  return countOf(hand, tile) >= 3;
}

export function canConcealedGang(hand) {
  const c = countsOf(hand);
  const out = [];
  for (let t = 1; t < 48; t++) if (c[t] === 4) out.push(t);
  return out;
}

export function canAddGang(hand, melds) {
  const out = [];
  for (const m of melds) {
    if (m.type === 'peng' && countOf(hand, m.tiles[0]) > 0) out.push(m.tiles[0]);
  }
  return out;
}

/** 可吃的组合（返回需要从手牌中拿出的两张牌） */
export function chiOptions(hand, tile) {
  if (!isSuited(tile)) return [];
  const s = suitOf(tile), r = rankOf(tile);
  const has = (t) => hand.includes(t);
  const out = [];
  if (r >= 3 && has(tile - 1) && has(tile - 2)) out.push([tile - 2, tile - 1]);
  if (r >= 2 && r <= 8 && has(tile - 1) && has(tile + 1)) out.push([tile - 1, tile + 1]);
  if (r <= 7 && has(tile + 1) && has(tile + 2)) out.push([tile + 1, tile + 2]);
  return out;
}

export function meldTiles(meld) {
  return meld.tiles.slice().sort((a, b) => a - b);
}

// ---------- 手牌分解（用于番型判定） ----------

/**
 * 枚举标准胡牌分解：4 副面子 + 将
 * @returns {{sets: {kind:'triplet'|'sequence', tiles:number[]}[], pair:number[]}[]}
 */
export function decompositions(tiles, meldCount, limit = 12) {
  const need = 4 - meldCount;
  if (tiles.length !== need * 3 + 2) return [];
  const out = [];
  const c = countsOf(tiles);

  function buildMelds(melds) {
    if (out.length >= limit) return;
    let i = -1;
    for (let k = 1; k < 48; k++) if (c[k] > 0) { i = k; break; }
    if (i < 0) {
      out.push({ sets: melds.slice(), pair: null });
      return;
    }
    const s = suitOf(i), r = rankOf(i);
    if (c[i] >= 3) {
      c[i] -= 3;
      melds.push({ kind: 'triplet', tiles: [i, i, i] });
      buildMelds(melds);
      melds.pop();
      c[i] += 3;
    }
    if (s >= WAN && s <= TIAO && r <= 7 && c[i + 1] > 0 && c[i + 2] > 0) {
      c[i]--; c[i + 1]--; c[i + 2]--;
      melds.push({ kind: 'sequence', tiles: [i, i + 1, i + 2] });
      buildMelds(melds);
      melds.pop();
      c[i]++; c[i + 1]++; c[i + 2]++;
    }
  }

  for (let p = 1; p < 48 && out.length < limit; p++) {
    if (c[p] < 2) continue;
    c[p] -= 2;
    buildMelds([]);
    c[p] += 2;
  }
  // pair 单独记录
  for (const d of out) {
    // 重新推导将牌：完整牌 - 面子
    const cc = countsOf(tiles);
    for (const s of d.sets) for (const t of s.tiles) cc[t]--;
    for (let p = 1; p < 48; p++) if (cc[p] === 2) d.pair = [p, p];
  }
  return out;
}
