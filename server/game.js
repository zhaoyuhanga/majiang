// 单局对局引擎（服务端权威）
import {
  buildWall, shuffle, sortTiles, getWaits, canPeng, canGangFromDiscard,
  canConcealedGang, canAddGang, chiOptions, countsOf, tileName,
} from './mahjong.js';
import { analyzeWin, getTingInfo } from './rules.js';
import { scoreRound, gangDeltas, emptyDeltas } from './scoring.js';
import { botTurnAction, botClaimAction } from './bot.js';

const PASS = { type: 'pass' };

export class Round {
  /**
   * @param {object} opts
   * @param {object} opts.rules 房间规则
   * @param {{id:string,name:string,bot:boolean}[]} opts.seats 四个座位
   * @param {number} opts.dealer 庄家座位
   * @param {number[]} opts.scores 累计分
   * @param {number} opts.roundNo 第几局
   */
  constructor({ rules, seats, dealer = 0, scores = [0, 0, 0, 0], roundNo = 1 }) {
    this.rules = rules;
    this.cfg = rules.__config;
    this.roundNo = roundNo;
    this.dealer = dealer;
    this.startScores = scores.slice();
    this.deltas = emptyDeltas();
    this.players = seats.map((s, i) => ({
      seat: i,
      id: s.id,
      name: s.name,
      bot: !!s.bot,
      connected: s.connected !== false,
      hand: [],
      melds: [],
      discards: [],
      ting: false,
      tingWaits: [],
      drawn: null,
      auto: false,
    }));
    this.wall = [];
    this.bao = null;
    this.phase = 'init';
    this.turn = dealer;
    this.pending = null;
    this.result = null;
    this.deadline = 0;
    this.botAt = 0;
    this.claimBotAt = {};
    this.autoAction = null;
    this.seq = 0;
    this.eventSeq = 0;
    this.events = [];
    this.lastDiscard = null;
    this.flags = {};
    this.lastGangDiscard = false; // 流泪判定：杠后打出的牌
    this.start();
  }

  // ---------- 基础 ----------
  emit(type, data = {}) {
    const ev = { seq: ++this.eventSeq, type, ...data };
    this.events.push(ev);
    if (this.events.length > 60) this.events.shift();
    return ev;
  }

  touch() { this.seq++; }

  start() {
    const rules = this.rules;
    this.wall = shuffle(buildWall({ ...rules.wall }), Math.random);
    if (rules.bao?.enabled) {
      const indicator = this.wall.pop();
      this.bao = { rank: indicator, indicator, swaps: 0 };
    }
    for (const p of this.players) {
      for (let i = 0; i < 13; i++) p.hand.push(this.wall.shift());
      p.hand = sortTiles(p.hand);
    }
    this.phase = 'draw';
    this.emit('start', { dealer: this.dealer, wall: this.wall.length });
    this.beginTurn(this.dealer, { first: true });
  }

  nextSeat(seat) { return (seat + 1) % 4; }

  resetAuto() { this.autoAction = null; }

  beginTurn(seat, { gangShang = false, first = false } = {}) {
    const p = this.players[seat];
    this.turn = seat;
    this.pending = null;
    this.flags = {};
    if (this.wall.length === 0) {
      this.endDraw();
      return;
    }
    const tile = this.wall.shift();
    p.hand.push(tile);
    p.drawn = tile;
    this.lastGangDiscard = false;
    this.phase = 'discard';
    this.deadline = Date.now() + this.cfg.turnSeconds * 1000;
    this.botAt = Date.now() + this.cfg.botThinkingMs + Math.floor(Math.random() * 500);
    if (gangShang) this.flags.gangShangSeat = seat;
    if (this.wall.length === 0) this.flags.haidi = true;
    this.emit('draw', { seat, stone: p.ting ? tile : undefined, wall: this.wall.length });
    this.touch();
    this.maybeAutoTingPlay(seat);
  }

  maybeAutoTingPlay(seat) {
    const p = this.players[seat];
    if (!p.ting) return;
    if (p.bot) return; // 机器人走正常决策
    const canWin = this.canSelfWin(seat);
    const at = Date.now() + 700;
    if (canWin && this.rules.autoHuOnTing) {
      this.autoAction = { at, fn: () => this.act(seat, { type: 'hu' }) };
    } else {
      this.autoAction = { at, fn: () => this.autoDiscardForTing(seat) };
    }
  }

  autoDiscardForTing(seat) {
    const p = this.players[seat];
    if (!p.ting || this.phase !== 'discard' || this.turn !== seat) return;
    if (!p.drawn) return;
    try { this.discard(seat, p.drawn); } catch (e) { /* ignore */ }
  }

  canSelfWin(seat) {
    const p = this.players[seat];
    const a = analyzeWin({
      tiles: p.hand, melds: p.melds, winTile: p.drawn, zimo: true, ting: p.ting,
      baoRank: this.bao?.rank ?? null,
    }, this.rules);
    return a.ok ? a : null;
  }

  // ---------- 动作入口 ----------
  act(seat, action) {
    if (!action || typeof action.type !== 'string') throw new Error('无效操作');
    if (this.phase === 'ended') throw new Error('本局已结束');
    if (this.phase === 'claim' && this.pending?.options[seat]) {
      return this.respondClaim(seat, action);
    }
    if (this.phase !== 'discard' || this.turn !== seat) throw new Error('还没轮到你');
    return this.applyTurnAction(seat, action);
  }

  applyTurnAction(seat, action) {
    const p = this.players[seat];
    switch (action.type) {
      case 'discard':
        return this.discard(seat, action.tile);
      case 'hu': {
        const a = this.canSelfWin(seat);
        if (!a) throw new Error('不能胡');
        return this.settleWin({ winnerSeat: seat, winTile: p.drawn, zimo: true, analysis: a });
      }
      case 'angang':
        return this.doConcealedGang(seat, action.tile);
      case 'bugang':
        return this.doAddGang(seat, action.tile);
      case 'ting':
        return this.declareTing(seat, action.tile);
      case 'pass':
        throw new Error('现在不能过');
      default:
        throw new Error('未知操作: ' + action.type);
    }
  }

  // ---------- 打牌 ----------
  discard(seat, tile) {
    const p = this.players[seat];
    if (this.phase !== 'discard' || this.turn !== seat) throw new Error('还没轮到你');
    if (!p.hand.includes(tile)) throw new Error('你没有这张牌');
    if (p.ting && p.drawn != null && tile !== p.drawn) throw new Error('报听后只能打出刚摸的牌');
    const idx = p.hand.indexOf(tile);
    p.hand.splice(idx, 1);
    const wasDrawn = p.drawn;
    p.drawn = null;
    p.discards.push(tile);
    this.lastDiscard = { seat, tile, at: Date.now() };
    this.flags.haidi = this.wall.length === 0;
    this.emit('discard', { seat, tile, ting: p.ting });
    this.touch();
    this.maybeSwapBao();
    const fromGang = this.lastGangDiscard;
    this.lastGangDiscard = false;
    this.openClaims(tile, seat, { fromGang });
  }

  // ---------- 吃碰杠胡的响应 ----------
  computeClaims(tile, fromSeat, { qiangGang = false } = {}) {
    const out = {};
    const rules = this.rules;
    for (let i = 0; i < 4; i++) {
      if (i === fromSeat) continue;
      const p = this.players[i];
      const opts = {};
      const a = analyzeWin({
        tiles: p.hand.concat(tile), melds: p.melds, winTile: tile,
        zimo: false, ting: p.ting, baoRank: null,
      }, rules);
      if (a.ok) opts.hu = true;
      if (!p.ting && !qiangGang) {
        const meldsLeft = (rules.win.maxMelds ?? 4) - p.melds.length;
        if (rules.allowGang && meldsLeft >= 1 && canGangFromDiscard(p.hand, tile)) opts.gang = true;
        if (rules.allowPeng && meldsLeft >= 1 && canPeng(p.hand, tile)) opts.peng = true;
        if (rules.allowChi && i === this.nextSeat(fromSeat) && meldsLeft >= 1) {
          const c = chiOptions(p.hand, tile);
          if (c.length) opts.chi = c;
        }
      }
      if (Object.keys(opts).length) out[i] = opts;
    }
    return out;
  }

  openClaims(tile, fromSeat, { qiangGang = false, fromGang = false } = {}) {
    const options = this.computeClaims(tile, fromSeat, { qiangGang });
    const seats = Object.keys(options).map(Number);
    if (!seats.length) {
      if (qiangGang) {
        this.afterGangDraw(fromSeat);
        return;
      }
      this.advance(fromSeat);
      return;
    }
    this.phase = 'claim';
    this.pending = {
      tile, from: fromSeat, options, responses: {},
      qiangGang, fromGang,
      deadline: Date.now() + this.cfg.claimSeconds * 1000,
    };
    this.deadline = this.pending.deadline;
    this.claimBotAt = {};
    const now = Date.now();
    for (const s of seats) {
      if (this.players[s].bot) this.claimBotAt[s] = now + this.cfg.botThinkingMs + Math.floor(Math.random() * 400);
    }
    this.emit('claim_open', { from: fromSeat, tile, seats });
    this.touch();
    // 报听后自动胡
    for (const s of seats) {
      if (this.players[s].ting && options[s].hu && this.rules.autoHuOnTing) {
        this.pending.responses[s] = { type: 'hu' };
      }
    }
    this.checkAllResponded();
  }

  respondClaim(seat, action) {
    if (this.phase !== 'claim' || !this.pending) throw new Error('现在不能响应');
    const opts = this.pending.options[seat];
    if (!opts) throw new Error('你没有可响应的操作');
    if (this.pending.responses[seat]) throw new Error('已经响应过了');
    let resp;
    if (action.type === 'pass') resp = PASS;
    else if (action.type === 'hu' && opts.hu) resp = { type: 'hu' };
    else if (action.type === 'peng' && opts.peng) resp = { type: 'peng' };
    else if (action.type === 'gang' && opts.gang) resp = { type: 'gang' };
    else if (action.type === 'chi' && opts.chi) {
      const tiles = (action.tiles || []).slice().sort((a, b) => a - b);
      const ok = opts.chi.some((c) => c.slice().sort((a, b) => a - b).join(',') === tiles.join(','));
      if (!ok) throw new Error('无效的吃牌组合');
      resp = { type: 'chi', tiles };
    } else throw new Error('无效的响应');
    this.pending.responses[seat] = resp;
    this.touch();
    this.checkAllResponded();
  }

  allClaimantsResponded() {
    if (!this.pending) return true;
    return Object.keys(this.pending.options).every((s) => this.pending.responses[s]);
  }

  checkAllResponded() {
    if (this.phase !== 'claim') return;
    if (!this.allClaimantsResponded()) return;
    this.resolveClaims();
  }

  resolveClaims() {
    const pending = this.pending;
    if (!pending) return;
    const responses = pending.responses;
    const seatOrder = [];
    for (let k = 1; k <= 3; k++) seatOrder.push((pending.from + k) % 4);

    const huSeats = seatOrder.filter((s) => responses[s]?.type === 'hu');
    if (huSeats.length) {
      const winners = this.rules.allowMultiHu ? huSeats : [huSeats[0]];
      this.settleMultiWin(winners, pending);
      return;
    }
    const pengSeat = seatOrder.find((s) => responses[s]?.type === 'gang' || responses[s]?.type === 'peng');
    if (pengSeat != null) {
      const resp = responses[pengSeat];
      if (resp.type === 'gang') this.applyMingGang(pengSeat, pending);
      else this.applyPeng(pengSeat, pending);
      return;
    }
    const chiSeat = seatOrder.find((s) => responses[s]?.type === 'chi');
    if (chiSeat != null) {
      this.applyChi(chiSeat, pending, responses[chiSeat].tiles);
      return;
    }
    // 全部过
    const from = pending.from;
    this.pending = null;
    if (pending.qiangGang) {
      this.afterGangDraw(from);
      return;
    }
    this.advance(from);
  }

  removeClaimedDiscard(fromSeat, tile) {
    const p = this.players[fromSeat];
    if (p.discards.length && p.discards[p.discards.length - 1] === tile) p.discards.pop();
    else {
      const i = p.discards.lastIndexOf(tile);
      if (i >= 0) p.discards.splice(i, 1);
    }
  }

  applyPeng(seat, pending) {
    const p = this.players[seat];
    const t = pending.tile;
    for (let k = 0; k < 2; k++) p.hand.splice(p.hand.indexOf(t), 1);
    p.melds.push({ type: 'peng', tiles: [t, t, t], from: pending.from });
    this.removeClaimedDiscard(pending.from, t);
    this.pending = null;
    this.emit('peng', { seat, tile: t, from: pending.from });
    this.turn = seat;
    this.phase = 'discard';
    p.drawn = null;
    this.deadline = Date.now() + this.cfg.turnSeconds * 1000;
    this.botAt = Date.now() + this.cfg.botThinkingMs;
    this.lastGangDiscard = false;
    this.touch();
    this.maybeSwapBao();
  }

  applyChi(seat, pending, tiles) {
    const p = this.players[seat];
    const t = pending.tile;
    for (const x of tiles) p.hand.splice(p.hand.indexOf(x), 1);
    p.melds.push({ type: 'chi', tiles: sortTiles([t, ...tiles]), from: pending.from });
    this.removeClaimedDiscard(pending.from, t);
    this.pending = null;
    this.emit('chi', { seat, tile: t, tiles, from: pending.from });
    this.turn = seat;
    this.phase = 'discard';
    p.drawn = null;
    this.deadline = Date.now() + this.cfg.turnSeconds * 1000;
    this.botAt = Date.now() + this.cfg.botThinkingMs;
    this.lastGangDiscard = false;
    this.touch();
    this.maybeSwapBao();
  }

  applyMingGang(seat, pending) {
    const p = this.players[seat];
    const t = pending.tile;
    for (let k = 0; k < 3; k++) p.hand.splice(p.hand.indexOf(t), 1);
    p.melds.push({ type: 'gang', tiles: [t, t, t, t], from: pending.from });
    this.removeClaimedDiscard(pending.from, t);
    this.pending = null;
    this.emit('gang', { seat, tile: t, from: pending.from, kind: 'ming' });
    this.applyGangScore(seat, 'ming', pending.from);
    this.afterGangDraw(seat);
  }

  applyGangScore(seat, type, fromSeat) {
    const { deltas, value, items } = gangDeltas(this.rules, seat, type, fromSeat);
    if (!value) return;
    for (let i = 0; i < 4; i++) this.deltas[i] += deltas[i] * this.cfg.baseScore;
    this.emit('gang_score', { seat, type, value, items });
  }

  doConcealedGang(seat, tile) {
    if (this.phase !== 'discard' || this.turn !== seat) throw new Error('还没轮到你');
    const p = this.players[seat];
    if (!this.rules.allowGang) throw new Error('本规则不能杠');
    if ((this.rules.win.maxMelds ?? 4) - p.melds.length < 1) throw new Error('副露已满，不能杠');
    if (p.ting) throw new Error('报听后不能杠');
    const c = countsOf(p.hand);
    if (c[tile] !== 4) throw new Error('不能暗杠');
    for (let k = 0; k < 4; k++) p.hand.splice(p.hand.indexOf(tile), 1);
    p.melds.push({ type: 'angang', tiles: [tile, tile, tile, tile] });
    p.drawn = null;
    this.emit('gang', { seat, tile, kind: 'angang' });
    this.applyGangScore(seat, 'an');
    this.afterGangDraw(seat);
  }

  doAddGang(seat, tile) {
    if (this.phase !== 'discard' || this.turn !== seat) throw new Error('还没轮到你');
    const p = this.players[seat];
    if (p.ting) throw new Error('报听后不能杠');
    const meld = p.melds.find((m) => m.type === 'peng' && m.tiles[0] === tile);
    if (!meld) throw new Error('没有可以补杠的碰');
    if (!p.hand.includes(tile)) throw new Error('手里没有这张牌');
    p.hand.splice(p.hand.indexOf(tile), 1);
    meld.type = 'bugang';
    meld.tiles = [tile, tile, tile, tile];
    this.emit('gang', { seat, tile, kind: 'bugang' });
    this.applyGangScore(seat, 'bu');
    p.drawn = null;
    if (this.rules.allowQiangGang) {
      const options = {};
      for (let i = 0; i < 4; i++) {
        if (i === seat) continue;
        const op = this.players[i];
        const a = analyzeWin({
          tiles: op.hand.concat(tile), melds: op.melds, winTile: tile,
          zimo: false, ting: op.ting, baoRank: null,
        }, this.rules);
        if (a.ok) options[i] = { hu: true };
      }
      if (Object.keys(options).length) {
        this.phase = 'claim';
        this.pending = {
          tile, from: seat, options, responses: {}, qiangGang: true, fromGang: false,
          deadline: Date.now() + this.cfg.claimSeconds * 1000,
        };
        this.deadline = this.pending.deadline;
        this.claimBotAt = {};
        for (const s of Object.keys(options).map(Number)) {
          if (this.players[s].bot) this.claimBotAt[s] = Date.now() + this.cfg.botThinkingMs;
        }
        this.emit('claim_open', { from: seat, tile, seats: Object.keys(options).map(Number), qiangGang: true });
        this.touch();
        for (const s of Object.keys(options).map(Number)) {
          if (this.players[s].ting && this.rules.autoHuOnTing) this.pending.responses[s] = { type: 'hu' };
        }
        this.checkAllResponded();
        return;
      }
    }
    this.afterGangDraw(seat);
  }

  afterGangDraw(seat) {
    this.pending = null;
    this.lastGangDiscard = true;
    this.emit('gang_draw', { seat });
    this.touch();
    this.beginTurn(seat, { gangShang: true });
  }

  advance(fromSeat) {
    this.pending = null;
    const next = this.nextSeat(fromSeat);
    this.beginTurn(next);
  }

  // ---------- 报听 ----------
  declareTing(seat, tile) {
    if (this.phase !== 'discard' || this.turn !== seat) throw new Error('还没轮到你');
    const p = this.players[seat];
    if (p.ting) throw new Error('已报听');
    if (!this.rules.win.requireTing) throw new Error('本规则无需报听');
    if (!p.hand.includes(tile)) throw new Error('你没有这张牌');
    const rest = p.hand.slice();
    rest.splice(rest.indexOf(tile), 1);
    const info = getTingInfo(rest, p.melds, this.rules);
    if (!info.ting) throw new Error('未听牌，不能报听');
    // 先打牌再锁定手牌，避免「报听后只能打摸牌」限制误伤报听动作本身
    this.discard(seat, tile);
    p.ting = true;
    p.tingWaits = info.waits;
    this.emit('ting', { seat, waits: info.waits });
    this.touch();
  }

  // ---------- 结算 ----------
  settleMultiWin(winners, pending) {
    const results = [];
    for (const w of winners) {
      const p = this.players[w];
      const a = analyzeWin({
        tiles: p.hand.concat(pending.tile), melds: p.melds, winTile: pending.tile,
        zimo: false, ting: p.ting, baoRank: null,
      }, this.rules);
      if (!a.ok) continue;
      const score = scoreRound({
        rules: this.rules, analysis: { ...a, melds: p.melds },
        zimo: pending.qiangGang, winnerSeat: w,
        discarderSeat: pending.from,
        discarderTing: this.players[pending.from].ting,
        flags: { liulei: pending.fromGang, haidi: this.wall.length === 0 },
        isDealer: w === this.dealer,
      });
      for (let i = 0; i < 4; i++) this.deltas[i] += score.deltas[i] * this.cfg.baseScore;
      results.push({
        seat: w, name: p.name, label: score.label, fan: score.total,
        total: score.deltas[w] * this.cfg.baseScore,
        items: score.items, winTile: pending.tile, zimo: pending.qiangGang,
        discarder: pending.from,
      });
    }
    if (!results.length) {
      this.pending = null;
      this.advance(pending.from);
      return;
    }
    this.pending = null;
    this.phase = 'ended';
    this.result = {
      type: 'win',
      winners: results,
      discarder: pending.from,
      qiangGang: !!pending.qiangGang,
      deltas: this.deltas.slice(),
      hands: this.players.map((p) => sortTiles(p.hand)),
      melds: this.players.map((p) => p.melds),
      bao: this.bao ? { rank: this.bao.rank, indicator: this.bao.indicator } : null,
    };
    this.emit('win', { winners: results.map((r) => r.seat), zimo: false });
    this.touch();
  }

  settleWin({ winnerSeat, winTile, zimo, analysis }) {
    const p = this.players[winnerSeat];
    const score = scoreRound({
      rules: this.rules, analysis: { ...analysis, melds: p.melds },
      zimo, winnerSeat,
      discarderSeat: null,
      flags: {
        gangShang: !!this.flags.gangShangSeat && this.flags.gangShangSeat === winnerSeat,
        haidi: this.wall.length === 0,
      },
      isDealer: winnerSeat === this.dealer,
    });
    for (let i = 0; i < 4; i++) this.deltas[i] += score.deltas[i] * this.cfg.baseScore;
    this.phase = 'ended';
    this.pending = null;
    this.result = {
      type: 'win',
      winners: [{
        seat: winnerSeat, name: p.name, label: score.label, fan: score.total,
        total: score.deltas[winnerSeat] * this.cfg.baseScore,
        items: score.items, winTile: analysis.effectiveTile ?? winTile, zimo, useBao: analysis.useBao,
      }],
      deltas: this.deltas.slice(),
      hands: this.players.map((pp) => sortTiles(pp.hand)),
      melds: this.players.map((pp) => pp.melds),
      bao: this.bao ? { rank: this.bao.rank, indicator: this.bao.indicator } : null,
    };
    this.emit('win', { winners: [winnerSeat], zimo });
    this.touch();
  }

  endDraw() {
    this.phase = 'ended';
    this.pending = null;
    this.result = {
      type: 'draw',
      winners: [],
      deltas: this.deltas.slice(),
      hands: this.players.map((p) => sortTiles(p.hand)),
      melds: this.players.map((p) => p.melds),
      bao: this.bao ? { rank: this.bao.rank, indicator: this.bao.indicator } : null,
    };
    this.emit('draw_end', {});
    this.touch();
  }

  // ---------- 宝牌 ----------
  visibleBaoCount() {
    if (!this.bao) return 0;
    let n = 0;
    for (const p of this.players) {
      for (const d of p.discards) if (d === this.bao.rank) n++;
      for (const m of p.melds) for (const t of m.tiles) if (t === this.bao.rank) n++;
    }
    return n;
  }

  maybeSwapBao() {
    if (!this.bao || !this.rules.bao?.swapOnThreeVisible) return;
    if (this.wall.length < 2) return;
    if (this.visibleBaoCount() >= 3) {
      const old = this.bao.rank;
      const indicator = this.wall.pop();
      this.bao = { rank: indicator, indicator, swaps: (this.bao.swaps || 0) + 1 };
      this.emit('bao_swap', { from: old, to: this.bao.rank });
      this.touch();
    }
  }

  // ---------- 查询 ----------
  optionsFor(seat) {
    if (seat < 0 || seat > 3) return null;
    if (this.phase === 'ended') return { ended: true };
    if (this.phase === 'claim') {
      const o = this.pending?.options?.[seat];
      if (!o || this.pending.responses[seat]) return null;
      return { phase: 'claim', ...o };
    }
    if (this.phase === 'discard' && this.turn === seat) {
      const p = this.players[seat];
      const o = { phase: 'discard' };
      const a = this.canSelfWin(seat);
      if (a) o.hu = true;
      if (!p.ting) {
        const meldsLeft = (this.rules.win.maxMelds ?? 4) - p.melds.length;
        if (this.rules.allowGang && meldsLeft >= 1) {
          const angang = canConcealedGang(p.hand);
          const bugang = canAddGang(p.hand, p.melds);
          if (angang.length) o.angang = angang;
          if (bugang.length) o.bugang = bugang;
        }
        if (this.rules.win.requireTing && p.drawn != null) {
          const rest = p.hand.filter((t, i) => i !== p.hand.indexOf(p.drawn));
          const info = getTingInfo(rest, p.melds, this.rules);
          if (info.ting) { o.ting = true; o.tingWaits = info.waits; }
        }
      }
      o.discards = p.ting ? [p.drawn] : sortTiles(p.hand);
      return o;
    }
    return null;
  }

  // ---------- 快照 ----------
  snapshot(seat) {
    const p = seat >= 0 ? this.players[seat] : null;
    const now = Date.now();
    return {
      seq: this.seq,
      roundNo: this.roundNo,
      dealer: this.dealer,
      phase: this.phase,
      turn: this.turn,
      wall: this.wall.length,
      deadline: this.deadline,
      now,
      bao: this.bao
        ? {
          rank: (p && p.ting) || this.phase === 'ended' || seat < 0 ? this.bao.rank : null,
          indicator: this.phase === 'ended' || seat < 0 ? this.bao.indicator : undefined,
          swaps: this.bao.swaps || 0,
        }
        : null,
      players: this.players.map((pl, i) => ({
        seat: i,
        id: pl.id,
        name: pl.name,
        bot: pl.bot,
        connected: pl.connected,
        score: this.startScores[i] + this.deltas[i],
        delta: this.deltas[i],
        handCount: pl.hand.length,
        melds: pl.melds,
        discards: pl.discards,
        ting: pl.ting,
        tingWaits: pl.ting ? pl.tingWaits : undefined,
        drawn: i === seat && this.phase !== 'ended' ? pl.drawn : undefined,
      })),
      myHand: p ? sortTiles(p.hand) : [],
      myMelds: p ? p.melds : [],
      lastDiscard: this.lastDiscard,
      pending: this.pending
        ? {
          tile: this.pending.tile,
          from: this.pending.from,
          deadline: this.pending.deadline,
          qiangGang: this.pending.qiangGang,
          fromGang: this.pending.fromGang,
          waiting: Object.keys(this.pending.options).filter((s) => !this.pending.responses[s]).map(Number),
        }
        : null,
      options: this.optionsFor(seat),
      result: this.result,
      events: this.events.slice(-12),
    };
  }

  // ---------- 驱动 ----------
  poll(now = Date.now()) {
    if (this.phase === 'ended') return;
    if (this.autoAction && now >= this.autoAction.at) {
      const fn = this.autoAction.fn;
      this.autoAction = null;
      try { fn(); } catch (e) { /* 状态已变化 */ }
      return;
    }
    if (this.phase === 'discard') {
      const p = this.players[this.turn];
      if (p.bot && now >= this.botAt) {
        const action = botTurnAction(this, this.turn);
        try { this.applyTurnAction(this.turn, action); } catch (e) {
          this.autoDiscard(this.turn);
        }
        return;
      }
      if (now >= this.deadline) {
        this.autoDiscard(this.turn);
      }
      return;
    }
    if (this.phase === 'claim') {
      const seats = Object.keys(this.pending.options).map(Number);
      for (const s of seats) {
        if (this.pending.responses[s]) continue;
        const p = this.players[s];
        if (p.bot && now >= (this.claimBotAt[s] || 0)) {
          const action = botClaimAction(this, s);
          try { this.respondClaim(s, action); } catch (e) { this.respondClaim(s, PASS); }
          return;
        }
      }
      if (!this.allClaimantsResponded() && now >= this.pending.deadline) {
        for (const s of seats) if (!this.pending.responses[s]) this.pending.responses[s] = PASS;
        this.resolveClaims();
      }
    }
  }

  autoDiscard(seat) {
    if (this.phase !== 'discard' || this.turn !== seat) return;
    const p = this.players[seat];
    const tile = p.drawn != null ? p.drawn : sortTiles(p.hand)[p.hand.length - 1];
    try { this.discard(seat, tile); } catch (e) { /* ignore */ }
  }
}
