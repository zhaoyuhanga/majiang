// 客户端主逻辑
const socket = io({ transports: ['websocket', 'polling'] });

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const SUIT_NAMES = { 1: '万', 2: '筒', 3: '条' };
const HONOR_NAMES = { 41: '东', 42: '南', 43: '西', 44: '北', 45: '中', 46: '发', 47: '白' };

const state = {
  me: {
    clientId: localStorage.getItem('mj_cid') || newClientId(),
    name: localStorage.getItem('mj_name') || '',
  },
  presets: [],
  config: { ruleSet: 'harbin', rounds: 8, turnSeconds: 20, baseScore: 1, autoFillBots: true },
  roomCode: new URLSearchParams(location.search).get('r') || '',
  snap: null,
  sel: null,
  lastEventSeq: 0,
  lastRoundKey: '',
  clockOffset: 0,
  chatOpen: false,
  chatUnread: 0,
  sound: localStorage.getItem('mj_sound') !== 'off',
  hostFlags: {},
};

function newClientId() {
  const id = 'c' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
  localStorage.setItem('mj_cid', id);
  return id;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- 牌面 ----------------
function tileInfo(t) {
  if (t == null) return null;
  if (t >= 51) return { cls: 'honor', top: '花', bottom: String(t - 50), color: 'honor-fa' };
  if (t >= 41) {
    const ch = HONOR_NAMES[t] || '?';
    const cls = t === 45 ? 'honor-zhong' : t === 46 ? 'honor-fa' : t === 47 ? 'honor-bai' : '';
    return { cls: 'honor ' + cls, top: ch, bottom: '' };
  }
  const suit = Math.floor(t / 10);
  const rank = t % 10;
  return { cls: `suit-${suit}`, top: String(rank), bottom: SUIT_NAMES[suit] || '' };
}

function tileHTML(t, extra = '') {
  const i = tileInfo(t);
  if (!i) return '';
  return `<div class="tile ${i.cls} ${extra}" data-tile="${t}">
    <span class="tn">${i.top}</span>${i.bottom ? `<span class="ts">${i.bottom}</span>` : ''}
  </div>`;
}

function backHTML(cls = '') {
  return `<div class="tile back ${cls}"></div>`;
}

function meldHTML(meld) {
  const tiles = meld.tiles.map((t) => tileHTML(t, 'small')).join('');
  return `<div class="meld-group" title="${meld.type}">${tiles}</div>`;
}

function riverHTML(seatIndex, g) {
  const p = g.players[seatIndex];
  if (!p || !p.discards.length) return '';
  const last = g.lastDiscard;
  const tiles = p.discards.map((t, i) => {
    const isLast = last && last.seat === seatIndex && i === p.discards.length - 1;
    return tileHTML(t, 'small' + (isLast ? ' last-discard' : ''));
  }).join('');
  return `<div class="seat-river">${tiles}</div>`;
}

// ---------------- 音效 ----------------
let audioCtx = null;
function beep(kind) {
  if (!state.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    const notes = kind === 'win' ? [523, 659, 784, 1046]
      : kind === 'claim' ? [660, 880]
        : kind === 'turn' ? [560, 720]
          : [420];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      o.type = kind === 'win' ? 'triangle' : 'sine';
      o.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, now + i * 0.09);
      gain.gain.exponentialRampToValueAtTime(0.12, now + i * 0.09 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.22);
      o.connect(gain).connect(audioCtx.destination);
      o.start(now + i * 0.09);
      o.stop(now + i * 0.09 + 0.25);
    });
  } catch { /* ignore */ }
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toastRoot').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2200);
  setTimeout(() => el.remove(), 2600);
}

// ---------------- 网络 ----------------
socket.on('connect', () => {
  socket.emit('hello', { clientId: state.me.clientId, name: state.me.name });
});

socket.on('hello:ok', () => {
  if (state.roomCode && !state.snap) socket.emit('room:join', { code: state.roomCode });
  else socket.emit('lobby:list');
});

socket.on('room:created', ({ code }) => {
  state.roomCode = code;
});

socket.on('room:joined', ({ code, snapshot }) => {
  state.roomCode = code;
  applySnapshot(snapshot);
});

socket.on('room:state', (snap) => applySnapshot(snap));

socket.on('room:left', () => {
  state.snap = null;
  state.roomCode = '';
  history.replaceState(null, '', location.pathname);
  render();
});

socket.on('error:msg', ({ message }) => toast(message, 'err'));

socket.on('lobby:list', ({ rooms }) => {
  renderRoomList(rooms);
});

socket.on('disconnect', () => {
  toast('连接断开，正在重连…');
});

function emit(event, data) {
  socket.emit(event, data);
}

// ---------------- 快照处理 ----------------
function applySnapshot(snap) {
  const prev = state.snap;
  state.snap = snap;
  window.__snap = snap;
  state.clockOffset = (snap.serverNow || Date.now()) - Date.now();
  if (snap.code && snap.code !== state.roomCode) state.roomCode = snap.code;
  const url = new URL(location.href);
  if (url.searchParams.get('r') !== snap.code) {
    url.searchParams.set('r', snap.code);
    history.replaceState(null, '', url);
  }
  const prevTurn = prev?.game?.turn;
  const prevPhase = prev?.game?.phase;
  const myTurnNow = snap.game?.turn === snap.mySeat && snap.game?.phase === 'discard' && snap.state === 'playing';
  const myTurnBefore = prevTurn === snap.mySeat && prevPhase === 'discard';
  if (myTurnNow && !myTurnBefore) {
    toast('轮到你出牌');
    beep('turn');
  }
  if (prev?.chat && snap.chat && snap.chat.length > prev.chat.length && !state.chatOpen) {
    state.chatUnread += snap.chat.length - prev.chat.length;
  }
  handleEvents(snap, prev);
  if (snap.state === 'waiting') state.chatUnread = 0;
  render();
  if (state.chatOpen) renderChat();
  if (!prev && snap.state === 'playing') toast('对局进行中');
}

function handleEvents(snap, prev) {
  const g = snap.game;
  if (!g || !g.events?.length) return;
  const roundKey = `${snap.code}:${snap.roundNo}:${g.dealer}`;
  const lastSeq = g.events[g.events.length - 1].seq;
  if (state.lastEventSeq === 0 || state.lastRoundKey !== roundKey) {
    state.lastEventSeq = lastSeq;
    state.lastRoundKey = roundKey;
    return;
  }
  const fresh = g.events.filter((e) => e.seq > state.lastEventSeq);
  state.lastEventSeq = lastSeq;
  for (const e of fresh) {
    if (e.type === 'discard') beep('tap');
    else if (e.type === 'peng') { toast(`${nameOfSeat(e.seat)} 碰`); beep('claim'); }
    else if (e.type === 'chi') { toast(`${nameOfSeat(e.seat)} 吃`); beep('claim'); }
    else if (e.type === 'gang') { toast(`${nameOfSeat(e.seat)} 杠`); beep('claim'); }
    else if (e.type === 'ting') { toast(`${nameOfSeat(e.seat)} 报听`, ''); beep('claim'); }
    else if (e.type === 'win') { beep('win'); }
    else if (e.type === 'bao_swap') { toast('宝牌已更换'); }
    else if (e.type === 'gang_score' && e.value) { toast(`${nameOfSeat(e.seat)} 杠分 ${e.value}`); }
  }
}

function nameOfSeat(seat) {
  const g = state.snap?.game;
  return g?.players?.[seat]?.name || `座位${seat + 1}`;
}

// ---------------- 首页 ----------------
function renderHome() {
  $('#home').classList.remove('hidden');
  $('#room').classList.add('hidden');
  $('#nickname').value = state.me.name || '';
  renderRules();
  renderRoomList([]);
  emit('lobby:list');
}

function renderRules() {
  const wrap = $('#rulePicker');
  if (!state.presets.length) return;
  wrap.innerHTML = state.presets.map((r) => `
    <div class="rule-card ${r.id === state.config.ruleSet ? 'active' : ''}" data-rule="${r.id}">
      <div class="rc-name">${esc(r.name)}</div>
      <div class="rc-tag">${esc(r.tagline)}</div>
      <div class="rc-feat">${(r.features || []).slice(0, 5).map((f) => `<i>${esc(f)}</i>`).join('')}</div>
    </div>`).join('');
  wrap.querySelectorAll('.rule-card').forEach((el) => {
    el.addEventListener('click', () => {
      state.config.ruleSet = el.dataset.rule;
      renderRules();
    });
  });
}

function renderRoomList(rooms) {
  const wrap = $('#roomList');
  if (!rooms || !rooms.length) {
    wrap.innerHTML = '<div class="empty">暂无公开房间，创建一个吧</div>';
    return;
  }
  wrap.innerHTML = rooms.map((r) => `
    <div class="room-item" data-code="${esc(r.code)}">
      <span class="ri-code">${esc(r.code)}</span>
      <span>${esc(r.ruleName)}</span>
      <span class="ri-meta">${r.occupied}/4 人 · 第${r.roundNo || 0}/${r.rounds}局</span>
    </div>`).join('');
  wrap.querySelectorAll('.room-item').forEach((el) => {
    el.addEventListener('click', () => { state.roomCode = el.dataset.code; joinRoom(el.dataset.code); });
  });
}

// ---------------- 房间渲染 ----------------
function render() {
  const snap = state.snap;
  if (!snap) { renderHome(); return; }
  $('#home').classList.add('hidden');
  $('#room').classList.remove('hidden');
  renderRoom(snap);
}

function seatOrder(mySeat) {
  const m = mySeat >= 0 ? mySeat : 0;
  return { s: m, e: (m + 1) % 4, n: (m + 2) % 4, w: (m + 3) % 4 };
}

function renderRoom(snap) {
  const g = snap.game;
  const mySeat = snap.mySeat;
  const order = seatOrder(mySeat);
  $('#roomCodeLabel').textContent = snap.code;
  $('#ruleNameLabel').textContent = snap.rules.name;
  $('#roundLabel').textContent = snap.state === 'waiting'
    ? `${snap.totalRounds} 局`
    : `第 ${snap.roundNo}/${snap.totalRounds} 局`;

  // 座位
  const slots = { n: $('.slot-n'), e: $('.slot-e'), s: $('.slot-s'), w: $('.slot-w') };
  for (const [pos, el] of Object.entries(slots)) {
    const seatIndex = order[pos];
    el.innerHTML = renderSeat(pos, seatIndex, snap);
  }
  // 自己座位永远显示底部信息但手牌在底部
  const meActive = g && g.turn === mySeat && g.phase === 'discard';
  document.body.classList.toggle('my-turn', !!meActive);

  // 中央信息
  $('#wallInfo').innerHTML = g ? `牌墙 <b>${g.wall}</b> 张` : '';
  $('#baoInfo').innerHTML = renderBao(g, mySeat);
  $('#centerMsg').innerHTML = centerMessage(snap);

  // 等待层
  const waiting = snap.state === 'waiting';
  $('#waitOverlay').classList.toggle('hidden', !waiting);
  if (waiting) renderWait(snap);

  // 结果层
  const showResult = (snap.state === 'result' || snap.state === 'finished') && snap.result;
  $('#resultOverlay').classList.toggle('hidden', !showResult);
  if (showResult) renderResult(snap);

  // 手牌 & 操作
  renderHand(snap);
  renderActions(snap);
  renderMyBar(snap);
  updateInvite(snap);
  renderChatBadge();
  updateTimer();
}

function renderSeat(pos, seatIndex, snap) {
  const g = snap.game;
  const seatMeta = snap.seats[seatIndex];
  const gp = g?.players?.[seatIndex];
  const name = gp?.name || seatMeta?.name || '空位';
  const isBot = gp?.bot ?? seatMeta?.bot;
  const offline = seatMeta && seatMeta.connected === false && !isBot;
  const score = g ? gp.score : snap.scores[seatIndex];
  const isDealer = g ? g.dealer === seatIndex : false;
  const isTurn = g && g.turn === seatIndex && g.phase !== 'ended';
  const isMe = seatIndex === snap.mySeat;

  if (!seatMeta && !g) {
    return `<div class="seat empty-seat"><div class="seat-name"><div class="avatar">+</div><span class="nm">空位</span></div></div>`;
  }

  let backs = '';
  if (g && !isMe) {
    const n = Math.min(gp.handCount, 14);
    backs = `<div class="seat-backs">${Array.from({ length: n }, () => backHTML('sm')).join('')}</div>`;
  }

  const melds = g && gp.melds?.length ? `<div class="seat-melds">${gp.melds.map(meldHTML).join('')}</div>` : '';
  const river = g ? riverHTML(seatIndex, g) : '';
  // 自己的手牌在底部，座位区只显示副露与牌河
  if (isMe && g) {
    return `<div class="seat" data-seat="${seatIndex}">${melds}${river}</div>`;
  }
  const badges = [
    isDealer ? '<span class="badge">庄</span>' : '',
    gp?.ting ? '<span class="badge ting">听</span>' : '',
    isBot ? '<span class="badge">机</span>' : '',
    offline ? '<span class="badge red">断</span>' : '',
    isMe ? '<span class="badge">我</span>' : '',
  ].join('');

  const cls = ['seat', isTurn ? 'active' : '', offline ? 'offline' : ''].join(' ');
  return `<div class="${cls}" data-seat="${seatIndex}">
    <div class="seat-name">
      <div class="avatar ${isBot ? 'bot' : ''}">${esc(name.slice(0, 1))}</div>
      <span class="nm">${esc(name)}</span>
      <span class="sc ${score < 0 ? 'neg' : ''}">${score > 0 ? '+' : ''}${score}</span>
      ${badges}
    </div>
    ${melds}
    ${backs}
    ${river}
  </div>`;
}

function renderBao(g, mySeat) {
  if (!g || !g.bao) return '';
  if (g.bao.rank == null) return '<span class="bao-label">宝 ？</span>';
  const revealed = g.phase === 'ended';
  return `<span class="bao-label">宝</span>${tileHTML(g.bao.rank, 'small')}${revealed ? '' : ''}`;
}

function centerMessage(snap) {
  const g = snap.game;
  if (!g) return '<span>等待开局</span>';
  if (g.phase === 'ended') return '<span class="hl">本局结束</span>';
  const name = (i) => esc(g.players[i]?.name || `座位${i + 1}`);
  const mine = snap.mySeat;
  if (g.phase === 'claim' && g.pending) {
    const waiting = g.pending.waiting || [];
    if (waiting.includes(mine)) return '<span class="hl">请响应</span>';
    return `<span>${name(g.pending.from)} 打出 ${tileNameText(g.pending.tile)}，等待响应</span>`;
  }
  if (g.turn === mine && g.phase === 'discard') return '<span class="hl">轮到你出牌</span>';
  return `<span>${name(g.turn)} 出牌中…</span>`;
}

function tileNameText(t) {
  if (t == null) return '';
  const i = tileInfo(t);
  return i ? `${i.top}${i.bottom || ''}` : '';
}

function renderHand(snap) {
  const g = snap.game;
  const area = $('#handArea');
  const mySeat = snap.mySeat;
  if (!g || mySeat < 0) {
    area.innerHTML = '<div class="hand-empty">观战中</div>';
    return;
  }
  const p = g.players[mySeat];
  let hand = (g.myHand || []).slice();
  let drawn = p?.drawn;
  if (drawn != null) {
    const idx = hand.indexOf(drawn);
    if (idx >= 0) hand.splice(idx, 1);
  }
  if (state.sel != null && !hand.includes(state.sel) && state.sel !== drawn) state.sel = null;
  const discards = g.options?.discards;
  const canPick = g.phase === 'discard' && g.turn === mySeat;
  const allowed = canPick ? new Set(discards || []) : new Set();
  const tiles = [];
  for (const t of hand) {
    const sel = state.sel === t && allowed.has(t);
    tiles.push(tileHTML(t, `${allowed.has(t) ? 'clickable' : ''} ${sel ? 'selected' : ''}`));
  }
  if (drawn != null) {
    const sel = state.sel === drawn && allowed.has(drawn);
    tiles.push(tileHTML(drawn, `drawn ${allowed.has(drawn) ? 'clickable' : ''} ${sel ? 'selected' : ''}`));
  }
  area.innerHTML = tiles.join('') || '<div class="hand-empty">暂无手牌</div>';
  area.querySelectorAll('.tile.clickable').forEach((el) => {
    el.addEventListener('click', (ev) => {
      const t = Number(el.dataset.tile);
      if (state.sel === t) { state.sel = null; renderHand(state.snap); renderActions(state.snap); return; }
      state.sel = t;
      renderHand(state.snap);
      renderActions(state.snap);
      if (ev.detail >= 2) doDiscard(t);
    });
  });
}

function renderActions(snap) {
  const bar = $('#actionBar');
  const g = snap.game;
  const mySeat = snap.mySeat;
  if (!g || mySeat < 0 || g.phase === 'ended') { bar.innerHTML = ''; return; }
  const o = g.options;
  const btns = [];
  if (o?.phase === 'claim') {
    if (o.hu) btns.push(`<button class="act-btn danger" data-act="hu">胡</button>`);
    if (o.peng) btns.push(`<button class="act-btn" data-act="peng">碰</button>`);
    if (o.gang) btns.push(`<button class="act-btn" data-act="gang">杠</button>`);
    if (o.chi) {
      const claimTile = g.pending?.tile;
      o.chi.forEach((combo) => {
        const shown = claimTile != null ? [...combo, claimTile].sort((a, b) => a - b) : combo;
        btns.push(`<button class="act-btn small" data-act="chi" data-tiles="${combo.join(',')}">吃 ${shown.map(tileNameText).join(' ')}</button>`);
      });
    }
    btns.push(`<button class="act-btn plain" data-act="pass">过</button>`);
  } else if (o?.phase === 'discard') {
    if (o.hu) btns.push(`<button class="act-btn danger" data-act="hu">自摸胡</button>`);
    if (o.ting) {
      const defTing = state.sel ?? g.players[mySeat]?.drawn ?? '';
      btns.push(`<button class="act-btn" data-act="ting" data-tile="${defTing}">报听</button>`);
    }
    for (const t of (o.angang || [])) btns.push(`<button class="act-btn small" data-act="angang" data-tile="${t}">暗杠 ${tileNameText(t)}</button>`);
    for (const t of (o.bugang || [])) btns.push(`<button class="act-btn small" data-act="bugang" data-tile="${t}">补杠 ${tileNameText(t)}</button>`);
    btns.push(`<button class="act-btn" data-act="discard" id="discardBtn" ${state.sel == null ? 'disabled' : ''}>出牌</button>`);
  }
  bar.innerHTML = btns.join('') || `<span class="act-hint">${g.phase === 'claim' ? '等待其他玩家…' : '等待出牌…'}</span>`;
  bar.querySelectorAll('button[data-act]').forEach((el) => {
    el.addEventListener('click', () => {
      const act = el.dataset.act;
      if (act === 'discard') {
        if (state.sel == null) { toast('先选一张牌', 'err'); return; }
        doDiscard(state.sel);
      } else if (act === 'chi') {
        const tiles = el.dataset.tiles.split(',').map(Number);
        sendAction({ type: 'chi', tiles });
      } else if (act === 'ting') {
        const tile = state.sel != null ? state.sel : Number(el.dataset.tile);
        if (!tile) { toast('先选择要打出的牌，再报听', 'err'); return; }
        sendAction({ type: 'ting', tile });
      } else if (act === 'angang' || act === 'bugang') {
        sendAction({ type: act, tile: Number(el.dataset.tile) });
      } else {
        sendAction({ type: act });
      }
    });
  });
}

function doDiscard(tile) {
  sendAction({ type: 'discard', tile });
  state.sel = null;
}

function renderMyBar(snap) {
  const bar = $('#myBar');
  const g = snap.game;
  const mySeat = snap.mySeat;
  if (!g || mySeat < 0) {
    if (snap.state === 'playing') bar.innerHTML = '<span class="m-tag">观战中</span><span style="color:#93ac9e">本局结束后可入座</span>';
    else bar.innerHTML = '';
    return;
  }
  const p = g.players[mySeat];
  const waits = p.tingWaits || [];
  bar.innerHTML = `
    <div class="m-avatar">${esc(p.name.slice(0, 1))}</div>
    <span>${esc(p.name)}</span>
    <span class="m-score">${p.score > 0 ? '+' : ''}${p.score}</span>
    ${g.dealer === mySeat ? '<span class="m-tag">庄</span>' : ''}
    ${p.ting ? '<span class="m-tag ting">已报听</span>' : ''}
    ${p.ting && waits.length ? `<span class="m-waits">听 ${waits.map((t) => tileHTML(t, 'tiny')).join('')}</span>` : ''}`;
}

function sendAction(action) {
  emit('game:act', { action });
}

function updateInvite(snap) {
  const link = `${location.origin}/?r=${snap.code}`;
  const input = $('#inviteInput');
  if (input && input.value !== link) input.value = link;
}

// ---------------- 等待面板 ----------------
function renderWait(snap) {
  const rows = [];
  const positions = ['东', '南', '西', '北'];
  for (let i = 0; i < 4; i++) {
    const s = snap.seats[i];
    const isMe = snap.mySeat === i;
    if (s) {
      rows.push(`<div class="ws-row filled">
        <span class="ws-pos">${positions[i]}</span>
        <span class="ws-name">${esc(s.name)}${s.bot ? '<span class="sub">人机</span>' : ''}${s.isHost ? '<span class="sub">房主</span>' : ''}${isMe ? '<span class="sub">你</span>' : ''}${s.ready ? '<span class="sub">已准备</span>' : ''}</span>
        ${snap.isHost && !isMe ? `<button class="btn ghost mini" data-kick="${i}">移除</button>` : ''}
        ${isMe ? `<button class="btn ghost mini" data-stand="1">离座</button>` : ''}
      </div>`);
    } else {
      rows.push(`<div class="ws-row">
        <span class="ws-pos">${positions[i]}</span>
        <span class="ws-name">空位</span>
        ${snap.mySeat < 0 ? `<button class="btn ghost mini" data-sit="${i}">坐下</button>` : ''}
        ${snap.isHost ? `<button class="btn ghost mini" data-bot="${i}">加人机</button>` : ''}
      </div>`);
    }
  }
  $('#waitSeats').innerHTML = rows.join('');
  $('#waitSeats').querySelectorAll('[data-sit]').forEach((b) => b.onclick = () => emit('room:sit', { seat: Number(b.dataset.sit) }));
  $('#waitSeats').querySelectorAll('[data-bot]').forEach((b) => b.onclick = () => emit('room:addBot', { seat: Number(b.dataset.bot) }));
  $('#waitSeats').querySelectorAll('[data-kick]').forEach((b) => b.onclick = () => emit('room:removeSeat', { seat: Number(b.dataset.kick) }));
  $('#waitSeats').querySelectorAll('[data-stand]').forEach((b) => b.onclick = () => emit('room:stand'));

  const isHost = snap.isHost;
  const filled = snap.seats.filter(Boolean).length;
  $('#startBtn').classList.toggle('hidden', !isHost);
  $('#fillBotsBtn').classList.toggle('hidden', !isHost || filled >= 4);
  $('#readyBtn').classList.toggle('hidden', isHost);
  $('#startBtn').disabled = filled < 4 && !snap.config.autoFillBots;
  $('#waitTip').textContent = isHost
    ? (filled < 4 ? '可点空位加人机，或直接把链接发给朋友' : '人齐了，开始吧')
    : '等待房主开始…';
  $('#readyBtn').textContent = snap.myReady ? '取消准备' : '准备';
}

// ---------------- 结算 ----------------
function renderResult(snap) {
  const r = snap.result;
  const card = $('#resultCard');
  if (!r) return;
  const finished = snap.state === 'finished';
  const winners = r.winners || [];
  let head = '';
  if (r.type === 'draw') {
    head = `<div class="result-title">荒庄</div><div class="result-sub">牌墙摸完，本局流局</div>`;
  } else {
    head = `<div class="result-title">${finished ? '对局结束' : '胡牌'}</div>
      <div class="result-sub">${winners.map((w) => `${esc(w.name)} · ${esc(w.label)} ${w.fan ?? w.total}${r.zimo || w.zimo ? '（自摸）' : ''}`).join('　')}</div>`;
  }

  let winnerBlocks = winners.map((w) => `
    <div class="winner-row">
      <div class="avatar">${esc(w.name.slice(0, 1))}</div>
      <div style="flex:1">
        <div class="w-name">${esc(w.name)} <span class="w-label">${esc(w.label)}</span></div>
        <div class="fan-list">${(w.items || []).map((it) => `<span class="fan-item">${esc(it.name)}${it.value !== '' && it.value != null ? ' ' + it.value : ''}${it.note ? ' ' + esc(it.note) : ''}</span>`).join('')}</div>
      </div>
      <div class="w-label">+${w.total ?? 0}</div>
    </div>`).join('');

  const posNames = ['东', '南', '西', '北'];
  const rows = snap.seats.map((s, i) => {
    if (!s) return '';
    const d = r.deltas?.[i] ?? 0;
    return `<tr>
      <td>${esc(s.name)}${i === snap.dealer ? ' <span class="badge">庄</span>' : ''}</td>
      <td class="num ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}">${d > 0 ? '+' : ''}${d}</td>
      <td class="num">${snap.scores[i]}</td>
    </tr>`;
  }).join('');

  const reveal = (r.hands || []).map((hand, i) => {
    const s = snap.seats[i];
    if (!s) return '';
    const melds = (r.melds?.[i] || []).map(meldHTML).join('');
    return `<div class="reveal-row"><span class="rn">${esc(s.name)}</span>${hand.map((t) => tileHTML(t, 'tiny')).join('')}${melds}</div>`;
  }).join('');

  const actions = finished
    ? `<button class="btn" data-act="home">回首页</button>
       ${snap.isHost ? '<button class="btn primary" data-act="restart">再来一局</button>' : ''}`
    : `<button class="btn primary" data-act="continue">继续下一局</button>`;

  card.innerHTML = `${head}${winnerBlocks}
    <table class="score-table"><thead><tr><th>玩家</th><th style="text-align:right">本局</th><th style="text-align:right">总分</th></tr></thead><tbody>${rows}</tbody></table>
    ${r.type === 'win' ? `<div class="reveal-hands">${reveal}</div>` : ''}
    <div class="result-actions">${actions}</div>
    <div class="result-sub" id="resultHint" style="margin-top:10px"></div>`;

  card.querySelectorAll('button[data-act]').forEach((b) => {
    b.onclick = () => {
      const act = b.dataset.act;
      if (act === 'continue') emit('room:continue');
      else if (act === 'restart') emit('room:restart');
      else if (act === 'home') { emit('room:leave'); }
    };
  });
  updateResultCountdown();
}

function updateResultCountdown() {
  const snap = state.snap;
  const hint = $('#resultHint');
  if (!snap || !hint || !snap.nextAt) return;
  const left = Math.max(0, Math.ceil((snap.nextAt - (Date.now() + state.clockOffset)) / 1000));
  hint.textContent = snap.state === 'finished' ? '' : `${left} 秒后自动开始下一局`;
}

// ---------------- 聊天 ----------------
function renderChatBadge() {
  $('#chatDot').classList.toggle('hidden', state.chatUnread === 0);
}

function renderChat() {
  const snap = state.snap;
  if (!snap) return;
  const list = $('#chatList');
  list.innerHTML = (snap.chat || []).map((m) => `
    <div class="chat-msg"><span class="cn">${esc(m.name)}</span><span class="ct">${esc(m.text)}</span></div>`).join('') || '<div class="chat-msg"><span class="ct">还没有消息，打个招呼吧</span></div>';
  list.scrollTop = list.scrollHeight;
}

function openChat() {
  state.chatOpen = true;
  $('#chatPanel').classList.remove('hidden');
  state.chatUnread = 0;
  renderChat();
  renderChatBadge();
  setTimeout(() => $('#chatInput')?.focus(), 50);
}

function closeChat() {
  state.chatOpen = false;
  $('#chatPanel').classList.add('hidden');
}

// ---------------- 计时 ----------------
function updateTimer() {
  const snap = state.snap;
  const g = snap?.game;
  const ring = $('#timerRing');
  if (!g || !g.deadline || g.phase === 'ended' || snap.state !== 'playing') {
    ring.classList.add('hidden');
    return;
  }
  const left = Math.max(0, g.deadline - (Date.now() + state.clockOffset));
  const total = (g.phase === 'claim' ? snap.config.claimSeconds : snap.config.turnSeconds) * 1000;
  const p = Math.max(0, Math.min(1, left / total));
  ring.classList.remove('hidden');
  ring.style.setProperty('--p', p.toFixed(3));
  const span = ring.querySelector('span');
  if (span) span.textContent = Math.ceil(left / 1000);
  updateResultCountdown();
}

setInterval(() => {
  if (!state.snap) return;
  updateTimer();
  if (state.chatOpen) { /* noop */ }
}, 250);

// 首页房间列表定时刷新
setInterval(() => {
  if (!state.snap && socket.connected) emit('lobby:list');
}, 15000);

// ---------------- 事件绑定 ----------------
$('#createBtn').addEventListener('click', createRoom);
$('#joinBtn').addEventListener('click', () => {
  const code = $('#joinCode').value.trim().toUpperCase();
  if (!code) { toast('请输入房间号', 'err'); return; }
  state.roomCode = code;
  joinRoom(code);
});
$('#joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinBtn').click(); });
$('#refreshRooms').addEventListener('click', () => emit('lobby:list'));
$('#nickname').addEventListener('change', () => {
  state.me.name = $('#nickname').value.trim().slice(0, 12);
  localStorage.setItem('mj_name', state.me.name);
});

$('#homeBtn').addEventListener('click', () => {
  if (state.snap?.state === 'playing') { toast('对局中不能离开，可关闭页面稍后重连', 'err'); return; }
  emit('room:leave');
});
$('#readyBtn').addEventListener('click', () => emit('room:ready', { ready: !state.snap?.myReady }));
$('#startBtn').addEventListener('click', () => emit('room:start'));
$('#fillBotsBtn').addEventListener('click', () => {
  const snap = state.snap;
  if (!snap) return;
  for (let i = 0; i < 4; i++) if (!snap.seats[i]) emit('room:addBot', { seat: i });
});
$('#copyInvite').addEventListener('click', async () => {
  const link = $('#inviteInput').value;
  try { await navigator.clipboard.writeText(link); toast('链接已复制'); }
  catch { $('#inviteInput').select(); document.execCommand('copy'); toast('链接已复制'); }
});
$('#chatBtn').addEventListener('click', () => { state.chatOpen ? closeChat() : openChat(); });
$('#chatClose').addEventListener('click', closeChat);
$('#chatSend').addEventListener('click', sendChat);
$('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
$('#soundBtn').addEventListener('click', () => {
  state.sound = !state.sound;
  localStorage.setItem('mj_sound', state.sound ? 'on' : 'off');
  $('#soundBtn').textContent = state.sound ? '🔊' : '🔇';
});
if (!state.sound) $('#soundBtn').textContent = '🔇';
$('#rulesBtn').addEventListener('click', showRules);
$('#inviteBtn').addEventListener('click', async () => {
  const snap = state.snap;
  if (!snap) return;
  const link = `${location.origin}/?r=${snap.code}`;
  try { await navigator.clipboard.writeText(link); toast('邀请链接已复制：' + snap.code); }
  catch { window.prompt('复制下面的邀请链接', link); }
});

const QUICK = ['快点出牌', '手气不错', '这牌没法打了', '哈哈哈', '胡了！', '再来一局'];
function renderQuick() {
  $('#chatQuick').innerHTML = QUICK.map((q) => `<button>${esc(q)}</button>`).join('');
  $('#chatQuick').querySelectorAll('button').forEach((b) => {
    b.onclick = () => { emit('chat', { text: b.textContent }); };
  });
}
renderQuick();

function sendChat() {
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  emit('chat', { text });
  input.value = '';
}

// ---------------- 动作 ----------------
function createRoom() {
  const name = $('#nickname').value.trim().slice(0, 12);
  if (!name) { toast('请先填写昵称', 'err'); $('#nickname').focus(); return; }
  state.me.name = name;
  localStorage.setItem('mj_name', name);
  // 确保 hello 已发送
  state.config.rounds = Number($('#optRounds').value);
  state.config.turnSeconds = Number($('#optTurn').value);
  state.config.baseScore = Number($('#optBase').value);
  state.config.autoFillBots = $('#optBots').checked;
  state.config.allowChi = $('#optChi').checked;
  state.config.allowMultiHu = $('#optMultiHu').checked;
  state.config.cap = Number($('#optCap').value);
  emit('room:create', { config: state.config, name });
}

function joinRoom(code) {
  const name = $('#nickname').value.trim().slice(0, 12) || state.me.name;
  if (name) { state.me.name = name; localStorage.setItem('mj_name', name); }
  emit('room:join', { code, name: state.me.name });
}

// ---------------- 规则弹窗 ----------------
function showRules() {
  const snap = state.snap;
  const r = snap?.rules;
  const preset = state.presets.find((p) => p.id === r?.id);
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `<div class="modal">
    <h2>${esc(r?.name || '规则')}</h2>
    <p>${esc(r?.description || preset?.description || '')}</p>
    <div class="kv">${(preset?.features || []).map((f) => `<span>${esc(f)}</span>`).join('')}</div>
    <h3>本房间设置</h3>
    <p>${snap.state === 'waiting' ? snap.totalRounds : snap.totalRounds} 局 · 底分 ${snap.config.baseScore} · 出牌 ${snap.config.turnSeconds}s · 响应 ${snap.config.claimSeconds}s · 封顶 ${r?.cap ?? '-'}</p>
    <h3>玩法要点</h3>
    ${rulesDetail(r?.id)}
    <div class="close-row"><button class="btn" data-close>关闭</button></div>
  </div>`;
  document.body.appendChild(modal);
  modal.querySelector('[data-close]').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

function rulesDetail(id) {
  if (id === 'harbin') {
    return `<ul>
      <li>112 张：万筒条 + 4 张红中，无风牌花牌。</li>
      <li>必须开门（吃/碰/杠过），至少两门花色，牌型须有幺九、有刻有顺。</li>
      <li>听牌需点“报听”，报听后手牌锁定、自动打摸牌；只能自摸或点炮胡。</li>
      <li>牌墙末张为宝，报听后可见；自摸到宝可当任意牌，卡当听牌中宝为“宝中宝”。</li>
      <li>禁止七对、清一色；点炮者未听牌要包三家。</li>
    </ul>`;
  }
  if (id === 'shuangyashan') {
    return `<ul>
      <li>112 张：万筒条 + 4 张红中，无宝牌。</li>
      <li>胡牌须有幺（1/9 或红中）；可门清（闷听）、可手把一、可七对、可清一色。</li>
      <li>屁胡 1 分、夹胡 2 分、飘胡/七小对 4 分；自摸、点炮、闷听、杠开、流泪、海底、手把一、清一色各 ×2，庄家 ×2。</li>
      <li>明杠、暗杠各 2 分即时结算；点炮包三家。</li>
    </ul>`;
  }
  return '<p>规则详情见房间设置。</p>';
}

// ---------------- 启动 ----------------
async function init() {
  $('#nickname').value = state.me.name || '';
  try {
    const res = await fetch('/api/rules');
    const data = await res.json();
    state.presets = data.presets || [];
  } catch { state.presets = []; }
  renderHome();
  if ('serviceWorker' in navigator) { /* 预留 PWA */ }
  if (state.roomCode) {
    // 等待 hello:ok 后自动加入
    setTimeout(() => { if (!state.snap && state.roomCode) joinRoom(state.roomCode); }, 800);
  }
}

$('#createBtn').disabled = false;
init();

// 防止移动端双击缩放
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
