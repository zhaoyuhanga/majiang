// 规则预设与胡牌条件校验
import {
  isWinningHand, isSevenPairs, isThirteenOrphans, getWaits, decompositions,
  suitOf, rankOf, isHonor, isValidTileForRules, tilesOfCounts, countsOf,
} from './mahjong.js';

// 通用默认值
const WIN_DEFAULTS = {
  mustOpen: false,
  minSuits: 0,
  requireTerminal: false,
  requireTripletAndSequence: false,
  allowAllSequences: false,
  allowSevenPairs: false,
  allowThirteenOrphans: false,
  allowPureSuit: true,
  requireTing: false,
  minConcealed: 0,
  maxMelds: 4,
};

export const RULE_PRESETS = {
  harbin: {
    id: 'harbin',
    name: '哈尔滨麻将',
    tagline: '112张 · 带宝 · 必须开门 · 报听',
    description: '万筒条108张+4张红中。必须开门（吃/碰/杠过）、至少两门、有幺九、有刻有顺；听牌需报听，报听后手牌锁定；牌墙末张为宝，听牌后自摸到宝可当任意牌；不允许七对与清一色。',
    wall: { suits: [1, 2, 3], copies: 4, extra: [45], honors: false, flowers: false },
    allowChi: true,
    allowPeng: true,
    allowGang: true,
    allowMultiHu: false,
    allowQiangGang: true,
    allowDiscardAfterTing: true,
    autoHuOnTing: true,
    bao: {
      enabled: true,
      indicatorFromWallTail: true,
      swapOnThreeVisible: true,
      revealToTingOnly: true,
    },
    win: {
      ...WIN_DEFAULTS,
      mustOpen: true,
      minSuits: 2,
      requireTerminal: true,
      requireTripletAndSequence: true,
      allowAllSequences: true,
      allowSevenPairs: false,
      allowPureSuit: false,
      requireTing: true,
      minConcealed: 4,
      maxMelds: 3,
    },
    scoring: {
      engine: 'harbin',
      pinghu: 1,
      zimo: 2,
      mobao: 3,
      kadanMultiplier: 2,
      baoZhongBao: 12,
      cap: 36,
      dianpaoBaoSanjia: true,
      gangScore: { ming: 0, an: 0, bu: 0 },
    },
    options: { rounds: 8, baseScore: 1 },
  },

  shuangyashan: {
    id: 'shuangyashan',
    name: '双鸭山麻将',
    tagline: '112张 · 有幺 · 闷听加番 · 杠计分',
    description: '万筒条108张+4张红中。胡牌须有幺（1/9或红中）；可门清（闷听）、可手把一、可七对、可清一色；点炮包三家；明杠暗杠计分；无宝牌。',
    wall: { suits: [1, 2, 3], copies: 4, extra: [45], honors: false, flowers: false },
    allowChi: true,
    allowPeng: true,
    allowGang: true,
    allowMultiHu: false,
    allowQiangGang: true,
    allowDiscardAfterTing: false,
    autoHuOnTing: false,
    bao: { enabled: false },
    win: {
      ...WIN_DEFAULTS,
      mustOpen: false,
      minSuits: 0,
      requireTerminal: true,
      requireTripletAndSequence: false,
      allowSevenPairs: true,
      allowPureSuit: true,
      requireTing: false,
      minConcealed: 0,
      maxMelds: 4,
    },
    scoring: {
      engine: 'shuangyashan',
      basePatterns: { pinghu: 1, jiahu: 2, piaohu: 4, qixiaodui: 4 },
      multipliers: {
        zimo: 2, dianpao: 2, menting: 2, gangshang: 2, liulei: 2,
        haidi: 2, shoubaiyi: 2, qingyise: 2, zhuangjia: 2,
      },
      cap: 64,
      dianpaoBaoSanjia: true,
      gangScore: { ming: 2, an: 2, bu: 2 },
    },
    options: { rounds: 8, baseScore: 1 },
  },
};

export function getPresets() {
  return Object.values(RULE_PRESETS).map((r) => ({
    id: r.id, name: r.name, tagline: r.tagline, description: r.description,
    features: ruleFeatures(r),
    options: r.options,
  }));
}

export function ruleFeatures(r) {
  const f = [];
  f.push(`${r.wall.suits.length * 36 + (r.wall.extra?.length || 0) * r.wall.copies}张`);
  if (r.bao?.enabled) f.push('带宝');
  if (r.win.mustOpen) f.push('必须开门');
  if (r.win.requireTing) f.push('须报听');
  if (r.win.requireTerminal) f.push('须有幺');
  if (r.win.requireTripletAndSequence) f.push('有刻有顺');
  if (r.win.allowSevenPairs) f.push('可七对');
  if (!r.win.allowPureSuit) f.push('禁清一色');
  if (r.allowChi) f.push('可吃');
  if (r.allowMultiHu) f.push('一炮多响');
  if (r.scoring.gangScore && (r.scoring.gangScore.ming || r.scoring.gangScore.an)) f.push('杠计分');
  if (r.scoring.dianpaoBaoSanjia) f.push('点炮包三家');
  return f;
}

export function getRule(id) {
  const base = RULE_PRESETS[id];
  if (!base) throw new Error('未知规则: ' + id);
  return JSON.parse(JSON.stringify(base));
}

/**
 * 生成房间实际使用的规则（应用房间级可配置项）
 */
export function buildRoomRules(config) {
  const rules = getRule(config.ruleSet || 'harbin');
  const opt = config.options || {};
  if (opt.allowChi !== undefined) rules.allowChi = !!opt.allowChi;
  if (opt.allowMultiHu !== undefined) rules.allowMultiHu = !!opt.allowMultiHu;
  if (opt.requireTing !== undefined && !rules.win.requireTing) rules.win.requireTing = !!opt.requireTing;
  if (opt.bao !== undefined && rules.bao) rules.bao.enabled = !!opt.bao;
  rules.__config = {
    rounds: clampInt(opt.rounds ?? rules.options.rounds, 1, 32, 8),
    baseScore: clampInt(opt.baseScore ?? rules.options.baseScore, 1, 10, 1),
    turnSeconds: clampInt(opt.turnSeconds ?? 20, 8, 60, 20),
    claimSeconds: clampInt(opt.claimSeconds ?? 12, 5, 30, 12),
    cap: clampInt(opt.cap ?? rules.scoring.cap, 8, 256, rules.scoring.cap),
    autoFillBots: opt.autoFillBots !== false,
    botThinkingMs: clampInt(opt.botThinkingMs ?? 900, 200, 3000, 900),
  };
  rules.scoring.cap = rules.__config.cap;
  return rules;
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function distinctSuits(tiles) {
  const s = new Set();
  for (const t of tiles) if (t >= 11 && t <= 39) s.add(suitOf(t));
  return s;
}

function hasTerminalOrHonor(tiles) {
  return tiles.some((t) => (t >= 11 && t <= 39 && (rankOf(t) === 1 || rankOf(t) === 9)) || isHonor(t));
}

/**
 * 分析一手牌是否胡牌，并给出番型所需信息
 * ctx: { tiles, melds, winTile, zimo, ting, baoRank }
 */
export function analyzeWin(ctx, rules) {
  const { tiles, melds = [], winTile, zimo = false, ting = false, baoRank = null } = ctx;
  const meldCount = melds.length;
  const need = 4 - meldCount;
  if (need < 0 || tiles.length !== need * 3 + 2) return { ok: false, reason: '张数不对' };
  if (rules.win.requireTing && !ting && !zimo) return { ok: false, reason: '未报听' };
  if (rules.win.requireTing && !ting && zimo) return { ok: false, reason: '未报听' };
  if (rules.win.mustOpen && meldCount === 0) return { ok: false, reason: '必须开门' };
  if (rules.win.maxMelds != null && meldCount > rules.win.maxMelds) return { ok: false, reason: '副露过多（手把一）' };
  if (rules.win.minConcealed && tiles.length < rules.win.minConcealed) return { ok: false, reason: '手把一不能胡' };

  const baoActive = rules.bao?.enabled && zimo && ting && baoRank != null && winTile === baoRank;

  const evaluate = (hand, effTile, useBao) => {
    if (!isWinningHand(hand, meldCount, rules)) return null;
    const all = hand.concat(...melds.map((m) => m.tiles));
    const seven = meldCount === 0 && isSevenPairs(hand, 0);
    const thirteen = meldCount === 0 && isThirteenOrphans(hand, 0);
    const suits = distinctSuits(all);
    if (rules.win.allowPureSuit === false && suits.size < 2) return null;
    if (rules.win.minSuits && suits.size < rules.win.minSuits) return null;
    if (rules.win.requireTerminal && !hasTerminalOrHonor(all)) return null;

    let allTriplets = false;
    let allSequences = false;
    if (!seven && !thirteen) {
      const exposedPeng = melds.some((m) => m.type !== 'chi');
      const exposedChi = melds.some((m) => m.type === 'chi');
      const decomps = decompositions(hand, meldCount);
      allTriplets = exposedChi ? false : decomps.every((d) => d.sets.every((s) => s.kind === 'triplet')) && decomps.length > 0;
      if (rules.win.requireTripletAndSequence) {
        let ok = false;
        let onlySeq = false;
        for (const d of decomps) {
          const hasTrip = exposedPeng || d.sets.some((s) => s.kind === 'triplet');
          const hasSeq = exposedChi || d.sets.some((s) => s.kind === 'sequence');
          if (hasTrip && hasSeq) { ok = true; break; }
          if (hasSeq && !hasTrip) onlySeq = true;
        }
        if (!ok && !(onlySeq && rules.win.allowAllSequences)) return null;
        allSequences = !ok && onlySeq;
      }
    }

    // 卡当：胡牌前只听这一张（边/夹/单吊）
    const rest = hand.slice();
    rest.splice(rest.indexOf(effTile), 1);
    const waits = getWaits(rest, meldCount, rules);
    const kadan = waits.length === 1;

    return {
      ok: true,
      useBao: !!useBao,
      effectiveTile: effTile,
      kadan,
      sevenPairs: seven,
      thirteenOrphans: thirteen,
      allTriplets,
      allSequences,
      pureSuit: suits.size === 1,
      suits: suits.size,
      waits,
      concealed: hand.length,
    };
  };

  if (baoActive) {
    for (let x = 11; x <= 47; x++) {
      if (!isValidTileForRules(x, rules)) continue;
      const hand = tiles.slice();
      hand.splice(hand.indexOf(winTile), 1);
      hand.push(x);
      const r = evaluate(hand, x, true);
      if (r) return r;
    }
    return { ok: false, reason: '宝无法成胡' };
  }

  const r = evaluate(tiles.slice(), winTile, false);
  if (!r) return { ok: false, reason: '不符合胡牌条件' };
  return r;
}

/** 是否听牌，返回听的牌 */
export function getTingInfo(tiles, melds, rules) {
  const meldCount = melds.length;
  if (tiles.length % 3 !== 1) return { ting: false, waits: [] };
  if (rules.win.maxMelds != null && meldCount > rules.win.maxMelds) return { ting: false, waits: [] };
  if (rules.win.minConcealed && tiles.length + 1 < rules.win.minConcealed) return { ting: false, waits: [] };
  if (rules.win.mustOpen && meldCount === 0) return { ting: false, waits: [] };
  const waits = getWaits(tiles, meldCount, rules);
  return { ting: waits.length > 0, waits };
}
