// 计分：哈尔滨（累进番）与双鸭山（底分×倍数）

function emptyDeltas() {
  return [0, 0, 0, 0];
}

function item(name, value, note) {
  return { name, value, note: note || '' };
}

/**
 * 哈尔滨：平胡1番、自摸2番、摸宝3番、卡当×2、宝中宝12番、封顶36
 * 点炮：放炮者未听牌时包三家（付3份）
 */
export function scoreHarbin(ctx) {
  const { rules, analysis, zimo, winnerSeat, discarderSeat, discarderTing } = ctx;
  const cfg = rules.scoring;
  const ro = rules.ruleOptions || {};
  const items = [];
  const multiply = (name, value) => {
    fan *= value;
    items.push(item(name, '', '×' + value));
  };
  let fan;
  let label;
  const edgeSanQi = analysis.edgeWait && analysis.effectiveTile >= 11 && analysis.effectiveTile <= 39 && [3, 7].includes(analysis.effectiveTile % 10);
  const kadan = analysis.kanWait || ((ro.sanQiJia || ro.danDiaoJia) && analysis.singleWait) || (ro.sanQiJia && edgeSanQi);
  if (analysis.useBao && kadan) {
    fan = cfg.baoZhongBao;
    label = '宝中宝';
    items.push(item('宝中宝', fan));
  } else {
    if (analysis.useBao) { fan = cfg.mobao; label = '摸宝'; items.push(item('摸宝', cfg.mobao)); }
    else if (zimo) { fan = cfg.zimo; label = '自摸'; items.push(item('自摸', cfg.zimo)); }
    else { fan = cfg.pinghu; label = '平胡'; items.push(item('平胡', cfg.pinghu)); }
    if (kadan) multiply('卡当', cfg.kadanMultiplier);
  }
  if (ro.zhanLiLiTing && analysis.melds?.length === 0) multiply('站立立听', 3);
  if (cfg.sceneMultiplier > 1) multiply('场次', cfg.sceneMultiplier);
  const capped = Math.min(fan, cfg.cap);
  if (capped !== fan) items.push(item('封顶', cfg.cap));

  const deltas = emptyDeltas();
  if (zimo) {
    for (let i = 0; i < 4; i++) {
      if (i === winnerSeat) continue;
      deltas[i] -= capped;
      deltas[winnerSeat] += capped;
    }
  } else {
    const payer = discarderSeat;
    const bao = cfg.dianpaoBaoSanjia && (discarderTing === false || (cfg.tingShooterAlwaysBao && ctx.flags?.tingShooter));
    const amount = bao ? capped * 3 : capped;
    deltas[payer] -= amount;
    deltas[winnerSeat] += amount;
    if (bao) items.push(item('包三家', '', '放炮者付三家'));
  }
  return { label, total: capped, items, deltas, zimo };
}

/**
 * 双鸭山：底分×倍数
 * 屁胡1 / 夹胡2 / 飘胡4 / 七小对4；自摸、点炮、闷听、杠上花、流泪、海底、手把一、清一色、庄家 各×2
 * 点炮包三家
 */
export function scoreShuangyashan(ctx) {
  const { rules, analysis, zimo, winnerSeat, discarderSeat, flags = {}, isDealer } = ctx;
  const cfg = rules.scoring;
  const items = [];
  let base = cfg.basePatterns.pinghu;
  let label = '屁胡';
  if (analysis.sevenPairs) { base = cfg.basePatterns.qixiaodui; label = '七小对'; }
  else if (analysis.allTriplets) { base = cfg.basePatterns.piaohu; label = '飘胡'; }
  else if (analysis.kadan) { base = cfg.basePatterns.jiahu; label = '夹胡'; }
  items.push(item(label, base));

  let mult = 1;
  const add = (name, key) => {
    const m = cfg.multipliers[key] || 1;
    mult *= m;
    items.push(item(name, '', '×' + m));
  };
  if (zimo) add('自摸', 'zimo'); else add('点炮', 'dianpao');
  if (!analysis.melds || analysis.melds.length === 0) add('闷听', 'menting');
  if (flags.gangShang) add('杠上开花', 'gangshang');
  if (flags.liulei) add('流泪', 'liulei');
  if (flags.haidi) add('海底捞月', 'haidi');
  if (analysis.concealed === 2 && analysis.melds?.length === 3) add('手把一', 'shoubaiyi');
  if (analysis.pureSuit) add('清一色', 'qingyise');
  if (isDealer) add('庄家', 'zhuangjia');

  let total = base * mult;
  const capped = Math.min(total, cfg.cap);
  if (capped !== total) items.push(item('封顶', cfg.cap));

  const deltas = emptyDeltas();
  if (zimo) {
    for (let i = 0; i < 4; i++) {
      if (i === winnerSeat) continue;
      deltas[i] -= capped;
      deltas[winnerSeat] += capped;
    }
  } else {
    const payer = discarderSeat;
    const amount = cfg.dianpaoBaoSanjia ? capped * 3 : capped;
    deltas[payer] -= amount;
    deltas[winnerSeat] += amount;
    if (cfg.dianpaoBaoSanjia) items.push(item('包三家', '', '点炮付三家'));
  }
  return { label, total: capped, items, deltas, zimo };
}

export function scoreRound(ctx) {
  if (ctx.rules.scoring.engine === 'harbin') return scoreHarbin(ctx);
  return scoreShuangyashan(ctx);
}

/** 杠分（立即结算） */
export function gangDeltas(rules, seat, type, fromSeat) {
  const g = rules.scoring.gangScore || {};
  const value = g[type] || 0;
  const deltas = emptyDeltas();
  if (!value) return { deltas, value, items: [] };
  if (type === 'ming' && fromSeat != null) {
    deltas[fromSeat] -= value;
    deltas[seat] += value;
    return { deltas, value, items: [item('明杠', value)] };
  }
  for (let i = 0; i < 4; i++) {
    if (i === seat) continue;
    deltas[i] -= value;
    deltas[seat] += value;
  }
  return { deltas, value, items: [item(type === 'an' ? '暗杠' : '补杠', value)] };
}

export { emptyDeltas };
