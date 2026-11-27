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

const option = (key, label, group, defaultValue, help, extra = {}) => ({
  key, label, group, type: 'boolean', default: defaultValue, available: true, help, ...extra,
});

export const RULE_OPTION_SCHEMA = {
  shuangyashan: [
    option('gangScore', '杠分', '计分', true, '明杠由放杠者付，暗杠和补杠由三家付。'),
    option('dianpaoBaoSanjia', '点炮包三家', '计分', true, '点炮者一份支付三家的分数。'),
    option('shouBaYiSwap', '手把一可换牌', '胡牌', false, '本房规：仅剩 2 张暗牌时，本次摸牌可查看牌墙种类并更换一次。'),
    option('pureKan', '纯夹（只胡一张牌）', '胡牌', false, '只听一张牌时才能胡。'),
    option('buJiaBuHu', '不夹不胡', '胡牌', false, '只能胡唯一夹张，边张和单吊不能胡。'),
    option('lianZhuangSuanJu', '连庄算局', '地方变体', false, '连庄局的计数方式缺少统一口径，暂不开放。', { available: false, reason: '规则口径待确认' }),
    option('zhouYiZhang', '周一张', '地方变体', false, '该变体缺少统一公开口径，暂不开放。', { available: false, reason: '规则口径待确认' }),
    option('allowTwoSuits', '两色可胡', '地方变体', false, '该变体缺少统一公开口径，暂不开放。', { available: false, reason: '规则口径待确认' }),
    option('liangMen', '两闷', '地方变体', false, '闷数的计分公式存在平台冲突，暂不开放。', { available: false, reason: '规则口径待确认' }),
    option('fourMen', '四闷', '地方变体', false, '闷数的计分公式存在平台冲突，暂不开放。', { available: false, reason: '规则口径待确认' }),
    option('duiHaiYang', '对海洋', '地方变体', false, '该变体缺少统一公开口径，暂不开放。', { available: false, reason: '规则口径待确认' }),
    option('chiPengOceanScore', '吃碰算海洋分', '地方变体', false, '该变体缺少统一公开口径，暂不开放。', { available: false, reason: '规则口径待确认' }),
    option('kaiPaiZha', '开牌炸', '地方变体', false, '四张同牌与天胡两种口径冲突，暂不开放。', { available: false, reason: '规则口径待确认' }),
  ],
  harbin: [
    option('scene', '玩法场', '计分', 'classic', '经典场 ×1，传统场 ×2，高分场 ×4；房间封顶仍优先生效。', {
      type: 'select', values: [{ value: 'classic', label: '经典场' }, { value: 'traditional', label: '传统场' }, { value: 'high', label: '高分场' }],
    }),
    option('anBao', '暗宝', '宝牌', true, '未报听玩家看不到宝牌种类，报听后按快宝设置公开。'),
    option('louHu', '漏胡', '宝牌', false, '报听后摸到宝牌且正是所听牌，立即按摸宝胡牌。'),
    option('guaFeng', '刮风', '杠分', false, '报听后摸到明刻或暗刻的第四张，立即胡牌并结算杠分。'),
    option('sanQiJia', '三七夹', '胡牌', true, '3/7 边张和单吊也按夹胡计分。'),
    option('danDiaoJia', '单吊夹', '胡牌', false, '单吊将牌也按夹胡计分。'),
    option('buJiaBuHu', '不夹不胡', '胡牌', false, '只能胡唯一夹张，边张和单吊不能胡。'),
    option('tingHouChuShouPao', '听后出手炮', '计分', false, '刚报听时打出的牌点炮，按包三家结算。'),
    option('zhanLiLiTing', '站立立听', '胡牌', false, '允许门清听牌胡牌，并额外计 3 番。'),
    option('gangSuanFen', '杠算分', '杠分', false, '开启时杠分立即结算；关闭时累计到本局结算。'),
    option('qiangGangHu', '抢杠胡', '杠分', true, '别人补杠时可以抢杠胡，按点炮结算。'),
    option('hongZhongManTianFei', '红中满天飞', '宝牌', true, '报听后摸到红中可立即胡牌，计 2 番。'),
    option('kuaiBao', '快宝', '宝牌', false, '报听后立即公开宝牌，不必等下一次摸牌。'),
    option('piaoHu', '飘胡', '胡牌', false, '允许四个刻子（含副露）加将牌，不要求顺子。'),
    option('qiDui', '七对', '胡牌', false, '允许门清七对胡牌。'),
    option('hongZhongBuDingDaCha', '红中不顶大叉', '胡牌', false, '红中刻子不计入“有刻有顺”的刻子要求。'),
    option('qingYiSe', '清一色', '胡牌', false, '允许清一色胡牌，覆盖至少两门的限制。'),
    option('siKa', '死卡', '胡牌', false, '只能胡唯一夹张，边张和单吊不能胡。'),
    option('kanDuiBao', '坎对宝', '宝牌', false, '该变体缺少统一公开口径，暂不开放。', { available: false, reason: '规则口径待确认' }),
    option('siKaSuanFen', '死卡算分', '地方变体', false, '独立番率及组合语义未证实，暂不开放。', { available: false, reason: '规则口径待确认' }),
    option('daiKe', '带壳', '地方变体', false, '“壳”的牌墙构成与替代规则口径待确认，暂不开放。', { available: false, reason: '规则口径待确认' }),
    option('qiDuiDaiNian', '七对带粘', '地方变体', false, '仅找到邻近地区旁证，最终结构未确认，暂不开放。', { available: false, reason: '规则口径待确认' }),
    option('shangGunBao', '上滚宝', '地方变体', false, '公开资料仅有近似玩法，命名与翻宝方式未确认，暂不开放。', { available: false, reason: '规则口径待确认' }),
    option('sanKan', '三坎', '地方变体', false, '该变体缺少统一公开口径，暂不开放。', { available: false, reason: '规则口径待确认' }),
    option('lianZhuangSuanJu', '连庄算局', '地方变体', false, '连庄局的计数方式缺少统一口径，暂不开放。', { available: false, reason: '规则口径待确认' }),
  ],
};

export function normalizeRuleOptions(ruleSet, input = {}) {
  const out = {};
  for (const item of RULE_OPTION_SCHEMA[ruleSet] || []) {
    if (!item.available) continue;
    const value = input?.[item.key];
    if (item.type === 'select') {
      out[item.key] = item.values.some((v) => v.value === value) ? value : item.default;
    } else {
      out[item.key] = typeof value === 'boolean' ? value : item.default;
    }
  }
  return out;
}

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
    allowDiscardAfterTing: false,
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
    cap: r.scoring.cap,
    optionSchema: RULE_OPTION_SCHEMA[r.id],
    ruleOptions: normalizeRuleOptions(r.id),
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
  const rules = JSON.parse(JSON.stringify(base));
  rules.ruleOptions = normalizeRuleOptions(id);
  return rules;
}

/**
 * 生成房间实际使用的规则（应用房间级可配置项）
 */
export function buildRoomRules(config) {
  const rules = getRule(config.ruleSet || 'harbin');
  const opt = config.options || {};
  rules.ruleOptions = normalizeRuleOptions(rules.id, config.ruleOptions);
  const ro = rules.ruleOptions;
  if (opt.allowChi !== undefined) rules.allowChi = !!opt.allowChi;
  if (opt.allowMultiHu !== undefined) rules.allowMultiHu = !!opt.allowMultiHu;
  if (opt.requireTing !== undefined && !rules.win.requireTing) rules.win.requireTing = !!opt.requireTing;
  if (opt.bao !== undefined && rules.bao) rules.bao.enabled = !!opt.bao;

  if (rules.id === 'harbin') {
    rules.win.mustOpen = !ro.zhanLiLiTing;
    rules.win.minSuits = ro.qingYiSe ? 1 : 2;
    rules.win.allowSevenPairs = ro.qiDui;
    rules.win.allowPureSuit = ro.qingYiSe;
    rules.win.requireTerminal = true;
    rules.win.zhongNotTriplet = ro.hongZhongBuDingDaCha;
    rules.win.requireKanWait = ro.buJiaBuHu || ro.siKa;
    rules.allowQiangGang = ro.qiangGangHu;
    rules.bao.revealToTingOnly = ro.anBao;
    rules.scoring.sceneMultiplier = { classic: 1, traditional: 2, high: 4 }[ro.scene] || 1;
    rules.scoring.tingShooterAlwaysBao = ro.tingHouChuShouPao;
    rules.scoring.gangImmediate = ro.gangSuanFen;
    rules.scoring.gangScore = ro.guaFeng ? { ming: 1, an: 1, bu: 1 } : { ming: 0, an: 0, bu: 0 };
  } else {
    rules.win.requireSingleWait = ro.pureKan;
    rules.win.requireKanWait = ro.buJiaBuHu;
    rules.scoring.gangScore = ro.gangScore
      ? { ming: 2, an: 2, bu: 2 }
      : { ming: 0, an: 0, bu: 0 };
    rules.scoring.dianpaoBaoSanjia = ro.dianpaoBaoSanjia;
    rules.scoring.gangImmediate = true;
  }

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

function hasTerminalOrHonor(tiles, rules) {
  return tiles.some((t) => {
    if (t >= 11 && t <= 39) return rankOf(t) === 1 || rankOf(t) === 9;
    return isHonor(t) && !(rules.win.terminalExcludesZhong && t === 45);
  });
}

function classifyWait(hand, effTile, meldCount) {
  if (meldCount !== 0) {
    const kinds = new Set();
    for (const d of decompositions(hand, meldCount)) {
      for (const set of d.sets) {
        if (!set.tiles.includes(effTile)) continue;
        const rank = rankOf(effTile);
        if (set.kind === 'triplet') kinds.add('single');
        else if (rankOf(set.tiles[0]) === rank) kinds.add('edge');
        else if (rankOf(set.tiles[2]) === rank) kinds.add('edge');
        else kinds.add('kan');
      }
      if (d.pair?.[0] === effTile) kinds.add('single');
    }
    return kinds;
  }
  const kinds = new Set();
  if (isSevenPairs(hand, 0)) return new Set(['single']);
  for (const d of decompositions(hand, 0)) {
    for (const set of d.sets) {
      if (!set.tiles.includes(effTile)) continue;
      const rank = rankOf(effTile);
      if (set.kind === 'triplet') kinds.add('single');
      else if (rankOf(set.tiles[0]) === rank || rankOf(set.tiles[2]) === rank) kinds.add('edge');
      else kinds.add('kan');
    }
    if (d.pair?.[0] === effTile) kinds.add('single');
  }
  return kinds;
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
    if (rules.win.requireTerminal && !hasTerminalOrHonor(all, rules)) return null;

    const rest = hand.slice();
    rest.splice(rest.indexOf(effTile), 1);
    const waits = getWaits(rest, meldCount, rules);
    const kadan = waits.length === 1;
    const waitKinds = classifyWait(hand, effTile, meldCount);
    const twoSidedWait = waits.some((a, i) => waits.slice(i + 1).some((b) => {
      if (!isValidTileForRules(a, rules) || !isValidTileForRules(b, rules) || suitOf(a) !== suitOf(b) || suitOf(a) > 3 || b - a !== 3) return false;
      return rest.includes(a + 1) && rest.includes(a + 2);
    }));
    if (rules.win.requireSingleWait && !kadan) return null;
    if (rules.win.requireKanWait && (!kadan || !waitKinds.has('kan'))) return null;

    let allTriplets = false;
    let allSequences = false;
    let tripletCount = melds.filter((m) => m.type !== 'chi').length;
    let concealedTriplets = 0;
    if (!seven && !thirteen) {
      const exposedPeng = melds.some((m) => m.type !== 'chi');
      const exposedTriplet = melds.some((m) => m.type !== 'chi' && !(rules.win.zhongNotTriplet && m.tiles[0] === 45));
      const exposedChi = melds.some((m) => m.type === 'chi');
      const decomps = decompositions(hand, meldCount);
      const exposedTriplets = melds.filter((m) => m.type !== 'chi').length;
      tripletCount = Math.max(exposedTriplets, ...decomps.map((d) => d.sets.filter((s) => s.kind === 'triplet').length + exposedTriplets));
      concealedTriplets = Math.max(0, ...decomps.map((d) => d.sets.filter((s) => s.kind === 'triplet').length));
      allTriplets = exposedChi ? false : decomps.every((d) => d.sets.every((s) => s.kind === 'triplet')) && decomps.length > 0;
      if (rules.win.requireTripletAndSequence && !(rules.ruleOptions?.piaoHu && allTriplets)) {
        let ok = false;
        let onlySeq = false;
        for (const d of decomps) {
          const hasTrip = exposedTriplet || d.sets.some((s) => s.kind === 'triplet' && !(rules.win.zhongNotTriplet && s.tiles[0] === 45));
          const hasSeq = exposedChi || d.sets.some((s) => s.kind === 'sequence');
          if (hasTrip && hasSeq) { ok = true; break; }
          if (hasSeq && !hasTrip) onlySeq = true;
        }
        if (!ok && !(onlySeq && rules.win.allowAllSequences)) return null;
        allSequences = !ok && onlySeq;
      }
    }

    if (rules.win.requireTripletCount != null && tripletCount !== rules.win.requireTripletCount) return null;

    const rank = rankOf(effTile);
    const sanQiJia = effTile >= 11 && effTile <= 39 && (rank === 3 || rank === 7) && waitKinds.has('kan');
    const zhongCount = all.filter((t) => t === 45).length;
    const sevenPairsNian = seven ? Object.values(countsOf(tiles)).filter((n) => n === 4).length : 0;

    return {
      ok: true,
      useBao: !!useBao,
      effectiveTile: effTile,
      kadan,
      singleWait: waitKinds.has('single'),
      edgeWait: waitKinds.has('edge'),
      kanWait: waitKinds.has('kan'),
      twoSidedWait,
      waitKinds: [...waitKinds],
      sanQiJia,
      sevenPairs: seven,
      sevenPairsNian,
      thirteenOrphans: thirteen,
      allTriplets,
      allSequences,
      tripletCount,
      concealedTriplets,
      zhongCount,
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
  const waits = getWaits(tiles, meldCount, rules).filter((tile) => analyzeWin({
    tiles: tiles.concat(tile), melds, winTile: tile, zimo: false, ting: true, baoRank: null,
  }, rules).ok);
  return { ting: waits.length > 0, waits };
}
