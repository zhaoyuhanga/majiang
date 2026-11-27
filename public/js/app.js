// 客户端主逻辑
import { actionStillMatchesSnapshot } from './action-state.js';

const socket = io({ transports: ['websocket', 'polling'] });

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const SUIT_NAMES = { 1: '万', 2: '筒', 3: '条' };
const HONOR_NAMES = { 41: '东', 42: '南', 43: '西', 44: '北', 45: '中', 46: '发', 47: '白' };

const state = {
  me: {
    clientId: localStorage.getItem('mj_cid') || newClientId(),
    authToken: localStorage.getItem('mj_auth') || newAuthToken(),
    name: localStorage.getItem('mj_name') || '',
    features: {},
  },
  presets: [],
  config: {
    ruleSet: 'harbin', rounds: 8, turnSeconds: 20, claimSeconds: 12, baseScore: 1,
    autoFillBots: true, isPublic: true, allowChi: true, allowMultiHu: false,
    ruleOptions: {},
  },
  roomCode: new URLSearchParams(location.search).get('r') || '',
  snap: null,
  sel: null,
  selDrawn: false,
  actionPending: null,
  timerWarnedFor: '',
  everConnected: false,
  lastEventSeq: 0,
  lastRoundKey: '',
  clockOffset: 0,
  chatOpen: false,
  chatUnread: 0,
  sound: localStorage.getItem('mj_sound') !== 'off',
  hostFlags: {},
  admin: false,
  adminPermissions: [],
  adminData: { rooms: [], users: [] },
  adminEntryClicks: 0,
  adminEntryAt: 0,
  adminLoginPending: false,
  swapDismissedSerial: null,
};

function newClientId(force = false) {
  if (!force) {
    const saved = localStorage.getItem('mj_cid');
    if (saved) return saved;
  }
  const id = 'c' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
  localStorage.setItem('mj_cid', id);
  return id;
}

function newAuthToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  localStorage.setItem('mj_auth', token);
  return token;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- 牌面 ----------------
const TILE_NUMERALS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const TILE_VERSION = '1.6.0';

function tileInfo(t) {
  if (t == null) return null;
  if (t >= 51 && t <= 58) return { cls: 'flower', top: '', bottom: '', label: `花${t - 50}` };
  if (t >= 41 && t <= 47) {
    const ch = HONOR_NAMES[t] || '?';
    const cls = t === 45 ? 'honor-zhong' : t === 46 ? 'honor-fa' : t === 47 ? 'honor-bai' : '';
    return { cls: 'honor ' + cls, top: ch, bottom: '', label: ch };
  }
  if (t < 11 || t > 39) return null;
  const suit = Math.floor(t / 10);
  const rank = t % 10;
  return { cls: `suit-${suit}`, top: String(rank), bottom: SUIT_NAMES[suit] || '', label: `${TILE_NUMERALS[rank]}${SUIT_NAMES[suit] || ''}` };
}

function tileSymbol(t) {
  if (!tileInfo(t)) return '';
  return `<image href="/images/tiles/${t}.png?v=${TILE_VERSION}" width="48" height="64" preserveAspectRatio="xMidYMid meet"/>`;
}

function installTileSprites() {
  const tiles = [
    ...Array.from({ length: 9 }, (_, i) => 11 + i),
    ...Array.from({ length: 9 }, (_, i) => 21 + i),
    ...Array.from({ length: 9 }, (_, i) => 31 + i),
    ...Array.from({ length: 7 }, (_, i) => 41 + i),
    ...Array.from({ length: 8 }, (_, i) => 51 + i),
  ];
  $('#tileSprite').innerHTML = `<defs>${tiles.map((t) => `<symbol id="tile-${t}" viewBox="0 0 48 64">${tileSymbol(t)}</symbol>`).join('')}</defs>`;
}

function tileHTML(t, extra = '') {
  const i = tileInfo(t);
  if (!i) return '';
  const interactive = extra.includes('clickable');
  return `<div class="tile ${i.cls} ${extra}" data-tile="${t}" aria-label="${i.label}"${interactive ? ' role="button" tabindex="0"' : ''}>
    <svg class="tile-face" viewBox="0 0 48 64" aria-hidden="true"><use href="#tile-${t}"></use></svg>
  </div>`;
}

function backHTML(cls = '') {
  return `<div class="tile back ${cls}" aria-hidden="true"></div>`;
}

function meldHTML(meld) {
  const tiles = meld.tiles.map((t) => tileHTML(t, 'small')).join('');
  const label = { chi: '吃', peng: '碰', gang: '明杠', angang: '暗杠', bugang: '补杠' }[meld.type] || meld.type;
  return `<div class="meld-group" aria-label="${label}">${tiles}</div>`;
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
function haptic(pattern = 8) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

function beep(kind) {
  if (!state.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const now = audioCtx.currentTime;
    const notes = kind === 'win' ? [523, 659, 784, 1046]
      : kind === 'claim' ? [660, 880]
        : kind === 'turn' ? [560, 720]
          : kind === 'tap' ? [260] : [420];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const start = now + i * 0.09;
      const duration = kind === 'tap' ? 0.07 : 0.2;
      o.type = kind === 'win' || kind === 'claim' ? 'triangle' : 'sine';
      o.frequency.setValueAtTime(f, start);
      if (kind === 'tap') o.frequency.exponentialRampToValueAtTime(150, start + duration);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(kind === 'tap' ? 0.055 : 0.1, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      o.connect(gain).connect(audioCtx.destination);
      o.start(start);
      o.stop(start + duration + 0.02);
    });
  } catch { /* ignore */ }
}

function toast(msg, kind = '') {
  const root = $('#toastRoot');
  root.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 1300);
  setTimeout(() => el.remove(), 1700);
}

// ---------------- 网络 ----------------
socket.on('connect', () => {
  const reconnected = state.everConnected;
  state.everConnected = true;
  $('#networkState').textContent = '';
  document.body.classList.remove('is-offline');
  if (reconnected) {
    state.admin = false;
    document.querySelectorAll('#modalRoot .admin-modal').forEach((modal) => modal.remove());
    toast('连接已恢复');
  }
  socket.emit('hello', { clientId: state.me.clientId, authToken: state.me.authToken, name: state.me.name });
});

socket.on('identity:reset', ({ message }) => {
  state.me.clientId = newClientId(true);
  state.me.authToken = newAuthToken();
  state.me.features = {};
  state.admin = false;
  resetRoomView();
  toast(message || '身份已重置，请重新进房', 'err');
  socket.emit('hello', { clientId: state.me.clientId, authToken: state.me.authToken, name: state.me.name });
});

socket.on('hello:ok', ({ features }) => {
  state.me.features = features || {};
  if (state.roomCode && !state.snap) socket.emit('room:join', { code: state.roomCode });
  else if (!state.snap) renderHome();
});

socket.on('room:created', ({ code }) => {
  state.roomCode = code;
});

socket.on('room:joined', ({ code, snapshot }) => {
  state.roomCode = code;
  applySnapshot(snapshot);
});

socket.on('room:state', (snap) => applySnapshot(snap));

function resetRoomView() {
  state.snap = null;
  window.__snap = null;
  state.roomCode = '';
  resetSelection();
  state.actionPending = null;
  state.swapDismissedSerial = null;
  $('#drawSwapModal')?.closest('.modal-mask')?.remove();
  history.replaceState(null, '', location.pathname);
  render();
}

socket.on('room:left', () => resetRoomView());

socket.on('room:closed', ({ reason }) => {
  resetRoomView();
  toast(reason || '房间已结束');
});

socket.on('user:features', ({ features }) => {
  state.me.features = features || {};
  if (!state.snap) renderHome();
  else {
    state.snap.myFeatures = { ...features };
    render();
  }
});

socket.on('admin:revoked', () => {
  state.admin = false;
  state.adminData = { rooms: [], users: [] };
  state.adminPermissions = [];
  const panel = $('#adminPanel')?.closest('.modal-mask');
  if (panel) closeModal(panel);
  if (!state.snap) renderHome();
  toast('管理员权限已被撤销', 'err');
});

socket.on('admin:ok', (data) => {
  state.adminLoginPending = false;
  state.admin = true;
  state.adminPermissions = data.permissions || [];
  state.adminData = { rooms: data.rooms || [], users: data.users || [] };
  showAdminPanel();
});

socket.on('admin:state', (data) => {
  state.adminData = { rooms: data.rooms || [], users: data.users || [] };
  const panel = $('#adminPanel');
  if (panel) renderAdminPanel(panel);
});

socket.on('admin:logged-out', () => {
  state.admin = false;
  state.adminData = { rooms: [], users: [] };
  state.adminPermissions = [];
  const panel = $('#adminPanel')?.closest('.modal-mask');
  if (panel) closeModal(panel);
  if (!state.snap) renderHome();
});

socket.on('error:msg', ({ message }) => {
  state.actionPending = null;
  state.adminLoginPending = false;
  if (state.snap) renderActions(state.snap);
  toast(message, 'err');
});

socket.on('lobby:list', ({ rooms }) => {
  renderRoomList(rooms);
});

socket.on('disconnect', () => {
  $('#networkState').textContent = '重连中';
  document.body.classList.add('is-offline');
  toast('连接断开，正在重连…', 'err');
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
  const newRound = prev && (prev.roundNo !== snap.roundNo || prev.code !== snap.code);
  if (newRound || (myTurnNow && !myTurnBefore)) resetSelection();
  const swapped = state.actionPending?.type === 'swapDraw' && state.actionPending.drawSerial !== snap.game?.drawSerial;
  if (state.actionPending && !actionStillMatchesSnapshot(state.actionPending, snap)) state.actionPending = null;
  if (swapped) toast('换牌成功');
  if (prev && prev.isHost !== snap.isHost) {
    const nextHost = snap.seats.find((seat) => seat?.isHost)?.name;
    toast(snap.isHost ? '你已成为房主' : `房主已转交给${nextHost || '其他玩家'}`);
  }
  if (myTurnNow && (!myTurnBefore || newRound)) {
    state.timerWarnedFor = '';
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
  $('#optBots').checked = state.config.autoFillBots !== false;
  renderRules();
  renderRoomList([]);
  const canCreate = state.me.features.canCreateRooms !== false;
  $('#createBtn').disabled = !canCreate;
  $('#createBtn').textContent = canCreate ? '配置玩法并创建' : '创建权限已关闭';
  emit('lobby:list');
}

function presetById(id) {
  return state.presets.find((r) => r.id === id);
}

function applyPreset(id, config = state.config) {
  const preset = presetById(id);
  if (!preset) return;
  config.ruleSet = id;
  config.ruleOptions = { ...(preset.ruleOptions || {}) };
  delete config.cap;
}

function renderRules() {
  const wrap = $('#rulePicker');
  if (!state.presets.length) return;
  wrap.innerHTML = state.presets.map((r) => `
    <div class="rule-card ${r.id === state.config.ruleSet ? 'active' : ''}" data-rule="${r.id}" role="button" tabindex="0" aria-pressed="${r.id === state.config.ruleSet}">
      <div class="rc-name">${esc(r.name)}</div>
      <div class="rc-tag">${esc(r.tagline)}</div>
      <div class="rc-feat">${(r.features || []).slice(0, 4).map((f) => `<i>${esc(f)}</i>`).join('')}</div>
    </div>`).join('');
  wrap.querySelectorAll('.rule-card').forEach((el) => {
    const choose = () => {
      applyPreset(el.dataset.rule);
      renderRules();
    };
    el.addEventListener('click', choose);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
  });
  const preset = presetById(state.config.ruleSet);
  const summary = $('#playSummary');
  if (preset && summary) {
    const enabled = (preset.optionSchema || []).filter((item) => item.available && item.type === 'boolean' && state.config.ruleOptions[item.key]);
    summary.innerHTML = `<div><strong>${esc(preset.name)}</strong><span>4 人 · ${state.config.rounds} 局 · 底分 ${state.config.baseScore}</span></div>
      <div class="ps-tags">${enabled.slice(0, 4).map((item) => `<i>${esc(item.label)}</i>`).join('')}<i>自定义规则</i></div>`;
  }
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
      <span class="ri-meta">${r.humans ?? 0} 真人 · ${r.occupied}/4 席位 · 第${r.roundNo || 0}/${r.rounds}局</span>
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
  const swapReady = snap.state === 'playing' && g?.options?.phase === 'discard' && g.options.canSwapDraw && !g.options.drawSwapUsed;
  $('#wallInfo').classList.toggle('swap-ready', !!swapReady);
  $('#wallInfo').innerHTML = g ? `牌墙 <b>${g.wall}</b> 张${swapReady ? '<i>双击换牌</i>' : ''}` : '';
  if (swapReady) {
    $('#wallInfo').setAttribute('role', 'button');
    $('#wallInfo').setAttribute('tabindex', '0');
    $('#wallInfo').setAttribute('aria-label', `牌墙剩余 ${g.wall} 张，双击选择换牌`);
    $('#wallInfo').title = '双击查看本次可换牌';
  } else {
    $('#wallInfo').removeAttribute('role');
    $('#wallInfo').removeAttribute('tabindex');
    $('#wallInfo').removeAttribute('aria-label');
    $('#wallInfo').removeAttribute('title');
  }
  $('#baoInfo').innerHTML = renderBao(g);
  $('#centerMsg').innerHTML = centerMessage(snap);
  renderLastPlay(g, mySeat);
  $('#roomSettingsBtn').classList.toggle('hidden', !(snap.state === 'waiting' && snap.isHost));

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
  syncDrawSwapPicker(snap);
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
    seatMeta?.vip ? '<span class="badge vip">VIP</span>' : '',
    seatMeta?.canSwapDraw ? '<span class="badge swap">换牌</span>' : '',
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

function renderBao(g) {
  if (!g || !g.bao) return '';
  if (g.bao.rank == null) return '<span class="bao-label">宝 ？</span>';
  return `<span class="bao-label">宝</span>${tileHTML(g.bao.rank, 'small')}`;
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

function renderLastPlay(g, mySeat) {
  const root = $('#lastPlay');
  const last = g?.lastDiscard;
  if (!last || g.phase === 'ended') {
    root.innerHTML = '';
    root.classList.remove('visible');
    return;
  }
  const pending = g.phase === 'claim' && g.pending?.tile === last.tile;
  const who = last.seat === mySeat ? '你' : (g.players[last.seat]?.name || '玩家');
  root.innerHTML = `<div class="last-play-tile">${tileHTML(last.tile, 'small')}</div><span>${esc(who)}${pending ? ' · 待响应' : '打出'}</span>`;
  root.classList.add('visible');
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
    area.innerHTML = g
      ? '<div class="hand-empty">观战模式 · 离座后原位置由人机接管</div>'
      : '<div class="hand-empty">观战中</div>';
    area.classList.remove('can-pick', 'action-pending');
    return;
  }
  const p = g.players[mySeat];
  let hand = (g.myHand || []).slice();
  const drawn = p?.drawn;
  if (drawn != null) {
    const idx = hand.indexOf(drawn);
    if (idx >= 0) hand.splice(idx, 1);
  }
  if (state.sel != null && !hand.includes(state.sel) && state.sel !== drawn) resetSelection();
  const discards = g.options?.discards || [];
  const canPick = g.phase === 'discard' && g.turn === mySeat && !state.actionPending;
  const allowed = canPick ? new Set(discards) : new Set();
  const tingTiles = new Set(Object.keys(g.options?.tingDiscards || {}).map(Number));
  const tiles = [];
  for (const t of hand) {
    const cls = [allowed.has(t) ? 'clickable' : '', tingTiles.has(t) ? 'can-ting' : ''].join(' ');
    tiles.push(tileHTML(t, cls));
  }
  if (drawn != null) {
    const cls = [allowed.has(drawn) ? 'clickable' : '', tingTiles.has(drawn) ? 'can-ting' : ''].join(' ');
    tiles.push(tileHTML(drawn, `drawn ${cls}`));
  }
  area.innerHTML = tiles.join('') || '<div class="hand-empty">暂无手牌</div>';
  area.classList.toggle('can-pick', canPick);
  area.classList.toggle('action-pending', !!state.actionPending);
  area.querySelectorAll('.tile.clickable').forEach((el) => {
    const activate = (ev) => selectTile(Number(el.dataset.tile), el.classList.contains('drawn'), ev);
    el.addEventListener('click', activate);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(ev); }
    });
  });
  updateHandSelection();
}

function resetSelection() {
  state.sel = null;
  state.selDrawn = false;
}

function updateHandSelection() {
  const nodes = Array.from($('#handArea').querySelectorAll('.tile.clickable'));
  nodes.forEach((el) => {
    el.classList.remove('selected', 'same-tile');
    el.setAttribute('aria-pressed', 'false');
  });
  if (state.sel == null) return;
  const matches = nodes.filter((el) => Number(el.dataset.tile) === state.sel);
  const selected = state.selDrawn
    ? matches.find((el) => el.classList.contains('drawn'))
    : matches.find((el) => !el.classList.contains('drawn')) || matches[0];
  matches.forEach((el) => {
    if (el === selected) return;
    el.classList.add('same-tile');
  });
  if (selected) {
    selected.classList.add('selected');
    selected.setAttribute('aria-pressed', 'true');
  }
}

function selectTile(tile, isDrawn, ev) {
  const snap = state.snap;
  const o = snap?.game?.options;
  if (state.actionPending || o?.phase !== 'discard' || !o.discards?.includes(tile)) return;
  if (state.sel === tile && state.selDrawn === isDrawn) {
    doDiscard(tile);
    return;
  }
  state.sel = tile;
  state.selDrawn = isDrawn;
  updateHandSelection();
  renderActions(snap);
  haptic(7);
  if (ev?.key === ' ' || ev?.key === 'Enter') beep('tap');
}

function animateDiscard(tile) {
  const source = $('#handArea .tile.selected') || $('#handArea .tile.drawn[data-tile="' + tile + '"]');
  const target = $('#center');
  if (!source || !target || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const rect = source.getBoundingClientRect();
  const dest = target.getBoundingClientRect();
  const clone = source.cloneNode(true);
  clone.className = source.className.replace(/clickable|selected|same-tile|can-ting/g, '') + ' tile-flight';
  clone.removeAttribute('role');
  clone.removeAttribute('tabindex');
  clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;margin:0;z-index:120;pointer-events:none;`;
  document.body.appendChild(clone);
  const animation = clone.animate([
    { transform: 'translate(0, 0) scale(1)', opacity: 1 },
    { transform: `translate(${dest.left + dest.width / 2 - rect.left - rect.width / 2}px, ${dest.top + dest.height / 2 - rect.top - rect.height / 2}px) scale(.72)`, opacity: 0.15 },
  ], { duration: 300, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' });
  animation.onfinish = () => clone.remove();
}

function renderActions(snap) {
  const bar = $('#actionBar');
  const g = snap.game;
  const mySeat = snap.mySeat;
  bar.setAttribute('aria-busy', state.actionPending ? 'true' : 'false');
  if (!g || mySeat < 0 || g.phase === 'ended') { bar.innerHTML = ''; return; }
  const o = g.options;
  const pending = !!state.actionPending;
  const disabled = pending ? ' disabled' : '';
  const btns = [];
  let context = '';
  if (o?.phase === 'claim') {
    const tile = g.pending?.tile;
    if (o.hu) btns.push(`<button class="act-btn danger" data-act="hu"${disabled}>胡</button>`);
    if (o.peng) btns.push(`<button class="act-btn" data-act="peng"${disabled}>碰 ${tileHTML(tile, 'tiny')}</button>`);
    if (o.gang) btns.push(`<button class="act-btn" data-act="gang"${disabled}>杠 ${tileHTML(tile, 'tiny')}</button>`);
    if (o.chi) {
      o.chi.forEach((combo) => {
        const shown = tile != null ? [...combo, tile].sort((a, b) => a - b) : combo;
        btns.push(`<button class="act-btn small" data-act="chi" data-tiles="${combo.join(',')}"${disabled}>吃 ${shown.map(tileNameText).join(' ')}</button>`);
      });
    }
    btns.push(`<button class="act-btn plain" data-act="pass"${disabled}>过</button>`);
  } else if (o?.phase === 'discard') {
    if (o.hu) btns.push(`<button class="act-btn danger" data-act="hu"${disabled}>自摸胡</button>`);
    const tingTiles = o.tingDiscards || {};
    if (o.tingHintAvailable && !o.ting) btns.push(`<button class="act-btn small" data-act="tingHint"${disabled}>听牌提示</button>`);
    if (o.tingHintChecked && !o.ting) context = `<span class="act-hint">当前未听牌</span>`;
    if (o.ting) {
      const selectedTing = state.sel != null && Object.hasOwn(tingTiles, state.sel);
      const waits = selectedTing ? tingTiles[state.sel] : [];
      const label = pending ? '发送中' : selectedTing ? '报听' : state.sel == null ? '选择听牌' : '此牌不听';
      btns.push(`<button class="act-btn ${selectedTing ? 'ting-action' : ''}" data-act="ting" data-tile="${state.sel ?? ''}"${!selectedTing || pending ? ' disabled' : ''}>${label}</button>`);
      if (waits.length) context = `<span class="ting-preview">听 ${waits.map((t) => tileHTML(t, 'tiny')).join('')}</span>`;
    }
    for (const t of (o.angang || [])) btns.push(`<button class="act-btn small" data-act="angang" data-tile="${t}"${disabled}>暗杠 ${tileNameText(t)}</button>`);
    for (const t of (o.bugang || [])) btns.push(`<button class="act-btn small" data-act="bugang" data-tile="${t}"${disabled}>补杠 ${tileNameText(t)}</button>`);
    const label = pending ? '发送中' : state.sel != null ? `出 ${tileNameText(state.sel)}` : '出牌';
    btns.push(`<button class="act-btn discard-action" data-act="discard" id="discardBtn"${state.sel == null || pending ? ' disabled' : ''}>${label}</button>`);
  }
  bar.innerHTML = btns.join('') + context || `<span class="act-hint">${g.phase === 'claim' ? '等待其他玩家…' : '等待出牌…'}</span>`;
  bar.querySelectorAll('button[data-act]').forEach((el) => {
    el.addEventListener('click', () => {
      const act = el.dataset.act;
      if (act === 'discard') {
        if (state.sel == null) { toast('先选一张牌', 'err'); return; }
        doDiscard(state.sel);
      } else if (act === 'chi') {
        sendAction({ type: 'chi', tiles: el.dataset.tiles.split(',').map(Number) });
      } else if (act === 'ting') {
        const tile = state.sel;
        if (tile == null) { toast('先选择要打出的牌，再报听', 'err'); return; }
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
  const snap = state.snap;
  const o = snap?.game?.options;
  if (state.actionPending || o?.phase !== 'discard' || !o.discards?.includes(tile)) return;
  animateDiscard(tile);
  beep('tap');
  haptic(12);
  resetSelection();
  sendAction({ type: 'discard', tile });
}

function syncDrawSwapPicker(snap) {
  const g = snap.game;
  const choices = g?.options?.wallChoices;
  const existing = $('#drawSwapModal')?.closest('.modal-mask');
  if (!choices) {
    if (existing) closeModal(existing);
    return;
  }
  if (existing || state.swapDismissedSerial === g.drawSerial) return;
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `<div id="drawSwapModal" class="modal" role="dialog" aria-modal="true" aria-label="摸牌换牌">
    <h2>选择一张换牌</h2>
    <p>仅展示牌墙中现有的牌，每次摸牌可换一次。原摸到的牌会放回牌墙。</p>
    <div class="swap-grid">${Object.entries(choices).map(([tile, count]) => `<button class="swap-choice" data-swap-tile="${tile}">${tileHTML(Number(tile), 'small')}<small>牌墙剩余 ${count} 张</small></button>`).join('')}</div>
    <div class="close-row"><button class="btn" data-close>暂不换牌</button></div>
  </div>`;
  $('#modalRoot').appendChild(modal);
  modal.querySelector('[data-close]').onclick = () => {
    state.swapDismissedSerial = g.drawSerial;
    closeModal(modal);
  };
  modal.querySelectorAll('[data-swap-tile]').forEach((button) => {
    button.onclick = () => {
      if (state.actionPending) return;
      closeModal(modal);
      resetSelection();
      sendAction({ type: 'swapDraw', tile: Number(button.dataset.swapTile) });
    };
  });
  modal.onclick = (e) => {
    if (e.target !== modal) return;
    state.swapDismissedSerial = g.drawSerial;
    closeModal(modal);
  };
}

function renderMyBar(snap) {
  const bar = $('#myBar');
  const g = snap.game;
  const mySeat = snap.mySeat;
  if (!g || mySeat < 0) {
    bar.innerHTML = '';
    return;
  }
  const p = g.players[mySeat];
  const waits = p.tingWaits || [];
  bar.innerHTML = `
    <div class="m-avatar">${esc(p.name.slice(0, 1))}</div>
    <span>${esc(p.name)}</span>
    <span class="m-score">${p.score > 0 ? '+' : ''}${p.score}</span>
    ${g.dealer === mySeat ? '<span class="m-tag">庄</span>' : ''}
    ${snap.myFeatures?.vip ? '<span class="m-tag vip">VIP</span>' : ''}
    ${snap.myFeatures?.canSwapDraw ? '<span class="m-tag swap">换牌</span>' : ''}
    ${p.ting ? '<span class="m-tag ting">已报听</span>' : ''}
    ${p.ting && waits.length ? `<span class="m-waits">听 ${waits.map((t) => tileHTML(t, 'tiny')).join('')}</span>` : ''}`;
}

function sendAction(action) {
  if (state.actionPending || !socket.connected) {
    if (!socket.connected) toast('网络连接中，请稍候', 'err');
    return;
  }
  const snap = state.snap;
  const pending = {
    type: action.type,
    at: Date.now(),
    roundNo: snap?.roundNo,
    phase: snap?.game?.options?.phase,
    drawSerial: snap?.game?.drawSerial,
  };
  state.actionPending = pending;
  $('#handArea').classList.add('action-pending');
  emit('game:act', { action });
  haptic(action.type === 'hu' ? [15, 40, 15] : 8);
  renderActions(snap);
  setTimeout(() => {
    if (state.actionPending !== pending) return;
    state.actionPending = null;
    if (state.snap) {
      renderHand(state.snap);
      renderActions(state.snap);
    }
  }, 2500);
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
  $('#waitSeats').querySelectorAll('[data-kick]').forEach((b) => b.onclick = () => {
    const seat = Number(b.dataset.kick);
    const name = snap.seats[seat]?.name || '该玩家';
    if (confirm(`确认将 ${name} 移出座位？对方仍可作为观战者留在房间。`)) emit('room:removeSeat', { seat });
  });
  $('#waitSeats').querySelectorAll('[data-stand]').forEach((b) => b.onclick = () => emit('room:stand'));

  const isHost = snap.isHost;
  const filled = snap.seats.filter(Boolean).length;
  const unready = snap.seats.filter((s) => s && !s.bot && !s.isHost && !s.ready).length;
  $('#startBtn').classList.toggle('hidden', !isHost);
  $('#fillBotsBtn').classList.toggle('hidden', !isHost || filled >= 4 || snap.myFeatures?.canUseBots === false);
  $('#dissolveBtn').classList.toggle('hidden', !snap.canDissolve);
  $('#readyBtn').classList.toggle('hidden', isHost);
  $('#startBtn').disabled = (filled < 4 && !snap.config.autoFillBots) || unready > 0 || (filled < 4 && snap.config.autoFillBots && snap.myFeatures?.canUseBots === false);
  $('#waitTip').textContent = isHost
    ? (unready > 0 ? `等待 ${unready} 位玩家准备` : filled < 4 ? '可点空位加人机，或直接把链接发给朋友' : '人齐了，开始吧')
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
      else if (act === 'home') { confirmLeave(); }
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
    ring.classList.remove('urgent');
    return;
  }
  const left = Math.max(0, g.deadline - (Date.now() + state.clockOffset));
  const total = (g.phase === 'claim' ? snap.config.claimSeconds : snap.config.turnSeconds) * 1000;
  const p = Math.max(0, Math.min(1, left / total));
  ring.classList.remove('hidden');
  ring.classList.toggle('urgent', left > 0 && left <= 5000);
  ring.style.setProperty('--p', p.toFixed(3));
  const span = ring.querySelector('span');
  if (span) span.textContent = Math.ceil(left / 1000);
  const timerKey = `${snap.roundNo}:${g.phase}:${g.turn}:${g.deadline}`;
  if (left > 0 && left <= 5000 && state.timerWarnedFor !== timerKey) {
    state.timerWarnedFor = timerKey;
    beep('tap');
  }
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
const revealDraw = () => {
  const o = state.snap?.game?.options;
  if (state.actionPending || !socket.connected) return;
  if (o?.phase !== 'discard' || !o.canSwapDraw || o.drawSwapUsed) {
    toast('当前摸牌不能换牌', 'err');
    return;
  }
  state.swapDismissedSerial = null;
  emit('game:act', { action: { type: 'revealDraw' } });
};
$('#wallInfo').addEventListener('dblclick', revealDraw);
$('#wallInfo').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); revealDraw(); }
});
$('#nickname').addEventListener('input', () => {
  state.me.name = $('#nickname').value.trim().slice(0, 12);
  localStorage.setItem('mj_name', state.me.name);
});
$('#optBots').addEventListener('change', () => {
  state.config.autoFillBots = $('#optBots').checked;
});

$('#homeBtn').addEventListener('click', () => {
  if (state.snap) confirmLeave();
});
$('#dissolveBtn').addEventListener('click', confirmDissolve);
$('#adminBtn').addEventListener('click', () => {
  const now = Date.now();
  state.adminEntryClicks = now - state.adminEntryAt < 2000 ? state.adminEntryClicks + 1 : 1;
  state.adminEntryAt = now;
  if (state.adminEntryClicks < 7) return;
  state.adminEntryClicks = 0;
  state.admin ? showAdminPanel() : showAdminLogin();
});
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || !e.shiftKey || e.key.toLowerCase() !== 'a') return;
  e.preventDefault();
  state.admin ? showAdminPanel() : showAdminLogin();
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
  $('#soundBtn').textContent = state.sound ? '音效' : '静音';
  $('#soundBtn').setAttribute('aria-pressed', String(state.sound));
  if (state.sound) beep('turn');
});
if (!state.sound) $('#soundBtn').textContent = '静音';
$('#soundBtn').setAttribute('aria-pressed', String(state.sound));
$('#rulesBtn').addEventListener('click', showRules);
$('#roomSettingsBtn').addEventListener('click', showRoomSettings);
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
  if (!socket.connected) { toast('网络连接中，消息尚未发送', 'err'); return; }
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  emit('chat', { text });
  input.value = '';
}

// ---------------- 动作 ----------------
function createRoom() {
  if (!socket.connected) { toast('网络连接中，请稍候再创建房间', 'err'); return; }
  showRuleBuilder('create');
}

function joinRoom(code) {
  if (!socket.connected) { toast('网络连接中，请稍候再加入房间', 'err'); return; }
  const name = $('#nickname').value.trim().slice(0, 12) || state.me.name;
  if (name) { state.me.name = name; localStorage.setItem('mj_name', name); }
  emit('room:join', { code, name: state.me.name });
}

// ---------------- 规则弹窗 ----------------
function closeModal(modal) {
  modal.remove();
}

function showRules() {
  const snap = state.snap;
  const r = snap?.rules;
  const preset = state.presets.find((p) => p.id === r?.id);
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="麻将规则">
    <h2>${esc(r?.name || '规则')}</h2>
    <p>${snap ? '当前房间实际启用的规则如下，完整选项以房主设置为准。' : esc(r?.description || preset?.description || '')}</p>
    <div class="kv">${activeRoomRules(r, preset).map((label) => `<span>${esc(label)}</span>`).join('')}</div>
    <h3>本房间设置</h3>
    <p>${snap.totalRounds} 局 · 底分 ${snap.config.baseScore} · 出牌 ${snap.config.turnSeconds}s · 响应 ${snap.config.claimSeconds}s · 封顶 ${r?.cap ?? '-'}</p>
    <h3>玩法要点</h3>
    ${rulesDetail(r?.id)}
    <div class="close-row"><button class="btn" data-close>关闭</button></div>
  </div>`;
  $('#modalRoot').appendChild(modal);
  modal.querySelector('[data-close]').onclick = () => closeModal(modal);
  modal.onclick = (e) => { if (e.target === modal) closeModal(modal); };
}

function showRoomSettings() {
  if (!state.snap || state.snap.state !== 'waiting' || !state.snap.isHost) return;
  showRuleBuilder('edit');
}

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

function showRuleBuilder(mode) {
  if (!state.presets.length) { toast('玩法配置加载中，请稍后再试', 'err'); return; }
  const snap = mode === 'edit' ? state.snap : null;
  const draft = mode === 'edit'
    ? cloneConfig({ ...snap.config, ruleOptions: snap.config.ruleOptions || snap.rules.ruleOptions || {} })
    : cloneConfig(state.config);
  const previousFocus = document.activeElement;
  const modal = document.createElement('div');
  modal.className = 'modal-mask rule-builder-mask';
  modal.innerHTML = `<div class="rule-builder" role="dialog" aria-modal="true" aria-label="${mode === 'edit' ? '房间设置' : '创建房间'}">
    <header class="rb-header">
      <div><span class="rb-eyebrow">${mode === 'edit' ? 'ROOM SETTINGS' : 'NEW ROOM'}</span><h2>${mode === 'edit' ? '房间设置' : '配置玩法'}</h2></div>
      <button class="rb-close" type="button" data-builder-close aria-label="关闭">×</button>
    </header>
    <div class="rb-body" id="ruleBuilderBody"></div>
    <footer class="rb-footer">
      <div class="rb-footer-summary" id="builderSummary"></div>
      <div class="rb-footer-actions">
        <button class="btn ghost" type="button" data-builder-defaults>重置规则</button>
        <button class="btn" type="button" data-builder-close>取消</button>
        <button class="btn primary" type="button" data-builder-save>${mode === 'edit' ? '保存设置' : '创建房间'}</button>
      </div>
    </footer>
  </div>`;
  $('#modalRoot').appendChild(modal);

  const close = () => {
    closeModal(modal);
    previousFocus?.focus?.();
  };
  const renderBody = () => {
    const preset = presetById(draft.ruleSet);
    const body = $('#ruleBuilderBody');
    const groups = [...new Set((preset.optionSchema || []).map((item) => item.group))];
    body.innerHTML = `
      <aside class="rb-sidebar">
        <div class="rb-side-heading">选择玩法</div>
        <div class="rb-rule-list">
          ${state.presets.map((item) => `<button type="button" class="rb-rule ${item.id === draft.ruleSet ? 'active' : ''}" data-builder-rule="${item.id}" aria-pressed="${item.id === draft.ruleSet}">
            <span>${esc(item.name)}</span><small>${esc(item.tagline)}</small>
          </button>`).join('')}
        </div>
        <div class="rb-side-note">规则保存后由服务端统一校验。标注“待确认”的地方变体暂不开放。</div>
      </aside>
      <main class="rb-main">
        <section class="rb-section rb-basics">
          <div class="rb-section-head"><div><h3>基础设置</h3><p>${esc(preset.description)}</p></div><span class="rb-badge">4 人玩法</span></div>
          <div class="rb-number-picker" role="group" aria-label="玩家人数">
            ${[2, 3, 4].map((count) => `<button type="button" class="${count === 4 ? 'active' : ''}"${count === 4 ? '' : ' disabled'} title="${count === 4 ? '当前版本开放四人对局' : '暂仅支持四人对局'}"><strong>${count} 人</strong><small>${count === 4 ? '已开放' : '待支持'}</small></button>`).join('')}
          </div>
          <div class="rb-field-grid">
            ${builderSelect('rounds', '局数', [1, 2, 4, 8, 16, 32], draft.rounds, ' 局')}
            ${builderSelect('baseScore', '底分', [1, 2, 3, 5, 10], draft.baseScore, ' 分')}
            ${builderSelect('turnSeconds', '出牌时间', [8, 12, 20, 30, 45, 60], draft.turnSeconds, ' 秒')}
            ${builderSelect('claimSeconds', '响应时间', [5, 8, 12, 20, 30], draft.claimSeconds, ' 秒')}
            ${builderSelect('cap', '封顶分数', [8, 16, 32, 36, 48, 64, 96, 128, 256], draft.cap ?? '', ' 分', `规则默认 ${preset.cap}`)}
            ${builderScene(preset, draft)}
          </div>
          <div class="rb-checks">
            <label class="check"><input type="checkbox" data-config="autoFillBots"${draft.autoFillBots !== false ? ' checked' : ''}>人数不足自动补人机</label>
            <label class="check"><input type="checkbox" data-config="isPublic"${draft.isPublic !== false ? ' checked' : ''}>公开房间</label>
            <label class="check"><input type="checkbox" data-config="allowChi"${draft.allowChi !== false ? ' checked' : ''}>允许吃牌</label>
            <label class="check"><input type="checkbox" data-config="allowMultiHu"${draft.allowMultiHu ? ' checked' : ''}>一炮多响</label>
          </div>
        </section>
        <div class="rb-groups">
          ${groups.map((group) => `<section class="rb-rule-group" data-rule-group="${esc(group)}">
            <div class="rb-group-head"><h3>${esc(group)}</h3><span>${(preset.optionSchema || []).filter((item) => item.group === group && item.available && item.type === 'boolean' && draft.ruleOptions[item.key]).length} 项启用</span></div>
            ${(preset.optionSchema || []).filter((item) => item.group === group && item.type === 'boolean').map((item) => `<label class="rb-option${item.available ? '' : ' disabled'}">
              <span class="rb-option-copy"><span class="rb-option-title">${esc(item.label)}${item.available ? '' : '<em>待确认</em>'}</span><small>${esc(item.help || item.reason || '')}</small></span>
              <input type="checkbox" data-rule-key="${esc(item.key)}"${item.available && draft.ruleOptions[item.key] ? ' checked' : ''}${item.available ? '' : ' disabled'}>
            </label>`).join('')}
          </section>`).join('')}
        </div>
      </main>`;
    body.querySelectorAll('[data-builder-rule]').forEach((button) => {
      button.onclick = () => {
        if (button.dataset.builderRule === draft.ruleSet) return;
        applyPreset(button.dataset.builderRule, draft);
        renderBody();
      };
    });
    body.querySelectorAll('[data-config]').forEach((input) => {
      input.onchange = () => { draft[input.dataset.config] = input.checked; };
    });
    body.querySelectorAll('[data-setting]').forEach((input) => {
      input.onchange = () => {
        const key = input.dataset.setting;
        if (key === 'scene') {
          draft.ruleOptions.scene = input.value;
        } else if (key === 'cap') {
          if (input.value) draft.cap = Number(input.value);
          else delete draft.cap;
        } else {
          draft[key] = Number(input.value);
        }
        updateSummary();
      };
    });
    body.querySelectorAll('[data-rule-key]').forEach((input) => {
      input.onchange = () => {
        draft.ruleOptions[input.dataset.ruleKey] = input.checked;
        const group = input.closest('[data-rule-group]');
        const count = [...group.querySelectorAll('[data-rule-key]:checked')].length;
        group.querySelector('.rb-group-head span').textContent = `${count} 项启用`;
        updateSummary();
      };
    });
    updateSummary();
  };
  const updateSummary = () => {
    const preset = presetById(draft.ruleSet);
    const enabled = (preset.optionSchema || []).filter((item) => item.available && item.type === 'boolean' && draft.ruleOptions[item.key]);
    $('#builderSummary').innerHTML = `<strong>${esc(preset.name)}</strong><span>${draft.rounds} 局 · 底分 ${draft.baseScore} · ${enabled.length} 项规则</span>`;
  };
  const resetDefaults = () => {
    applyPreset(draft.ruleSet, draft);
    renderBody();
  };

  renderBody();
  modal.querySelectorAll('[data-builder-close]').forEach((button) => { button.onclick = close; });
  modal.querySelector('[data-builder-defaults]').onclick = resetDefaults;
  modal.querySelector('[data-builder-save]').onclick = () => {
    if (!socket.connected) { toast('网络连接中，设置尚未保存', 'err'); return; }
    bodyConfig();
    close();
  };
  modal.onclick = (event) => { if (event.target === modal) close(); };

  function bodyConfig() {
    const config = cloneConfig(draft);
    if (mode === 'create') {
      const name = $('#nickname').value.trim().slice(0, 12);
      if (!name) {
        close();
        toast('请先填写昵称', 'err');
        $('#nickname').focus();
        return;
      }
      state.me.name = name;
      localStorage.setItem('mj_name', name);
      state.config = config;
      emit('room:create', { config, name });
      return;
    }
    emit('room:config', { config: { ...config, cap: config.cap ?? null } });
    toast('设置已提交，正在同步');
  }

  modal.querySelector('.rb-close').focus();
}

function builderSelect(key, label, values, current, suffix = '', emptyLabel = '') {
  const allValues = [...new Set([...values, Number(current)].filter((value) => Number.isFinite(value) && value !== 0))].sort((a, b) => a - b);
  return `<label class="field small"><span>${esc(label)}</span><select data-setting="${key}">
    ${current === '' && emptyLabel ? `<option value="">${esc(emptyLabel)}</option>` : ''}
    ${allValues.map((value) => `<option value="${value}"${Number(current) === value ? ' selected' : ''}>${value}${esc(suffix)}</option>`).join('')}
  </select></label>`;
}

function builderScene(preset, draft) {
  const scene = (preset.optionSchema || []).find((item) => item.type === 'select');
  if (!scene) return '<div class="rb-scene-none"><span>玩法场次</span><strong>经典玩法</strong></div>';
  return `<label class="field small"><span>${esc(scene.label)}</span><select data-setting="scene">
    ${scene.values.map((item) => `<option value="${item.value}"${draft.ruleOptions[scene.key] === item.value ? ' selected' : ''}>${esc(item.label)}</option>`).join('')}
  </select></label>`;
}

function confirmLeave() {
  const snap = state.snap;
  if (!snap) return;
  const inGame = snap.state === 'playing' || snap.state === 'result';
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `<div class="modal compact" role="dialog" aria-modal="true" aria-label="退出房间">
    <h2>${inGame ? '退出牌桌？' : '退出房间？'}</h2>
    <p>${inGame ? '退出后本座位会由人机接管，其他真人玩家可继续对局。重新进房只能作为观战者。' : '退出后需要重新输入房间号或打开邀请链接加入。'}</p>
    <div class="close-row">
      <button class="btn" data-stay>继续对局</button>
      <button class="btn danger-btn" data-leave>退出房间</button>
      ${snap.canDissolve ? '<button class="btn danger-btn" data-dissolve>解散房间</button>' : ''}
    </div>
  </div>`;
  $('#modalRoot').appendChild(modal);
  modal.querySelector('[data-stay]').onclick = () => closeModal(modal);
  modal.querySelector('[data-leave]').onclick = () => {
    closeModal(modal);
    emit('room:leave');
  };
  modal.querySelector('[data-dissolve]')?.addEventListener('click', () => {
    closeModal(modal);
    emit('room:dissolve');
  });
  modal.onclick = (e) => { if (e.target === modal) closeModal(modal); };
}

function confirmDissolve() {
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `<div class="modal compact" role="dialog" aria-modal="true" aria-label="解散房间">
    <h2>解散这个房间？</h2>
    <p>所有玩家都会被移出房间，当前对局立即结束，此操作不可撤销。</p>
    <div class="close-row"><button class="btn" data-close>取消</button><button class="btn danger-btn" data-confirm>确认解散</button></div>
  </div>`;
  $('#modalRoot').appendChild(modal);
  modal.querySelector('[data-close]').onclick = () => closeModal(modal);
  modal.querySelector('[data-confirm]').onclick = () => {
    closeModal(modal);
    emit('room:dissolve');
  };
  modal.onclick = (e) => { if (e.target === modal) closeModal(modal); };
}

function showAdminLogin() {
  if (state.adminLoginPending) return;
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `<div class="modal compact" role="dialog" aria-modal="true" aria-label="管理员登录">
    <h2>管理后台</h2>
    <p>登录后可查看在线用户、解散房间并设置用户特殊权限。</p>
    <label class="field"><span>管理员口令</span><input id="adminPassword" type="password" autocomplete="current-password" placeholder="请输入服务器配置的口令"></label>
    <div class="close-row"><button class="btn" data-close>取消</button><button class="btn primary" data-login>登录</button></div>
  </div>`;
  $('#modalRoot').appendChild(modal);
  modal.querySelector('[data-close]').onclick = () => closeModal(modal);
  const login = () => {
    const token = $('#adminPassword').value.trim();
    if (!token) { toast('请输入管理员口令', 'err'); return; }
    if (state.adminLoginPending) return;
    state.adminLoginPending = true;
    const button = modal.querySelector('[data-login]');
    button.disabled = true;
    button.textContent = '验证中';
    $('#adminPassword').disabled = true;
    emit('admin:login', { token });
    setTimeout(() => {
      if (state.adminLoginPending) return;
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = '登录';
        $('#adminPassword').disabled = false;
      }
    }, 2500);
  };
  modal.querySelector('[data-login]').onclick = login;
  modal.querySelector('#adminPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  modal.onclick = (e) => { if (e.target === modal) closeModal(modal); };
  setTimeout(() => $('#adminPassword')?.focus(), 50);
}

function showAdminPanel() {
  document.querySelectorAll('#modalRoot .modal-mask').forEach((modal) => modal.remove());
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = '<div class="modal admin-modal" role="dialog" aria-modal="true" aria-label="管理后台"><div id="adminPanel"></div></div>';
  $('#modalRoot').appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) closeModal(modal); };
  renderAdminPanel($('#adminPanel'));
  emit('admin:state');
}

function renderAdminPanel(panel) {
  const stateName = { waiting: '等待中', playing: '对局中', result: '结算中', finished: '已结束' };
  const rooms = state.adminData.rooms || [];
  const userList = state.adminData.users || [];
  panel.innerHTML = `<div class="admin-head">
      <div><h2>管理后台</h2><p>权限修改实时生效并保存到服务器。</p></div>
      <div class="admin-tools"><button class="btn ghost small" data-refresh>刷新</button><button class="btn ghost small" data-close-admin>关闭</button><button class="btn ghost small" data-logout>退出登录</button></div>
    </div>
    <h3>房间管理（${rooms.length}）</h3>
    <div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>房间</th><th>状态</th><th>房主</th><th>真人</th><th>局数</th><th>操作</th></tr></thead><tbody>
      ${rooms.map((room) => `<tr><td><b>${esc(room.code)}</b><br><small>${esc(room.ruleName)}</small></td><td>${esc(stateName[room.state] || room.state)}</td><td>${esc(room.hostName || '-')}</td><td>${room.humans}/4</td><td>${room.roundNo || 0}/${room.rounds}</td><td><button class="btn danger-btn mini" data-dissolve-room="${esc(room.code)}">解散</button></td></tr>`).join('') || '<tr><td colspan="6">暂无房间</td></tr>'}
    </tbody></table></div>
    <h3>用户与特殊权限</h3>
    <label class="field admin-search"><span>搜索昵称或用户标识</span><input id="adminSearch" placeholder="输入关键词筛选"></label>
    <div class="admin-table-wrap"><table class="admin-table user-table"><thead><tr><th>用户</th><th>状态</th><th>房间</th>${state.adminPermissions.map((p) => `<th>${esc(p.label)}</th>`).join('')}</tr></thead><tbody>
      ${userList.map((user) => `<tr data-user-row><td><b>${esc(user.name)}</b><br><small>${esc(user.id)}</small></td><td>${user.online ? '<span class="online-dot">在线</span>' : '离线'}</td><td>${esc(user.roomCode || '-')}</td>${state.adminPermissions.map((p) => `<td><input type="checkbox" data-user="${esc(user.id)}" data-feature="${esc(p.key)}"${user.features?.[p.key] ? ' checked' : ''}${user.id === state.me.clientId && p.key === 'admin' ? ' disabled title="不能取消自己的管理员权限"' : ''} aria-label="${esc(user.name)} ${esc(p.label)}"></td>`).join('')}</tr>`).join('') || '<tr><td colspan="8">暂无用户</td></tr>'}
    </tbody></table></div>`;
  panel.querySelector('[data-refresh]').onclick = () => emit('admin:state');
  panel.querySelector('[data-close-admin]').onclick = () => closeModal(panel.closest('.modal-mask'));
  panel.querySelector('[data-logout]').onclick = () => {
    emit('admin:logout');
    closeModal(panel.closest('.modal-mask'));
  };
  panel.querySelectorAll('[data-dissolve-room]').forEach((button) => {
    button.onclick = () => {
      if (!confirm(`确认解散房间 ${button.dataset.dissolveRoom}？当前对局会立即结束。`)) return;
      emit('admin:dissolveRoom', { code: button.dataset.dissolveRoom });
    };
  });
  panel.querySelectorAll('[data-feature]').forEach((input) => {
    input.onchange = () => emit('admin:setFeatures', {
      clientId: input.dataset.user,
      features: { [input.dataset.feature]: input.checked },
    });
  });
  panel.querySelector('#adminSearch').addEventListener('input', (e) => {
    const query = e.target.value.trim().toLowerCase();
    panel.querySelectorAll('[data-user-row]').forEach((row) => {
      row.hidden = !row.textContent.toLowerCase().includes(query);
    });
  });
}

function activeRoomRules(rules, preset) {
  const options = rules?.ruleOptions || {};
  const active = (preset?.optionSchema || []).filter((item) => item.available && (
    item.type === 'select'
      ? item.values.some((value) => value.value === options[item.key])
      : options[item.key]
  ));
  return active.map((item) => item.type === 'select'
    ? `${item.label}：${item.values.find((value) => value.value === item.value)?.label || item.value}`
    : item.label);
}

function rulesDetail(r) {
  const ro = r?.ruleOptions || {};
  if (r?.id === 'harbin') {
    return `<ul>
      <li>112 张：万筒条 + 4 张红中，无风牌花牌。</li>
      <li>${ro.zhanLiLiTing ? '允许站立立听（门清听牌额外计 3 番）' : '必须开门（吃/碰/杠过）'}，${ro.qingYiSe ? '允许清一色' : '至少两门花色'}，牌型须有幺九、有刻有顺。</li>
      <li>听牌需点“报听”，报听后手牌锁定、自动打摸牌；只能自摸或点炮胡。</li>
      <li>牌墙末张为宝，自摸到宝可当任意牌；${ro.anBao === false ? '宝牌对所有玩家公开' : ro.kuaiBao ? '报听后立即公开宝牌' : '未报听玩家看不到宝牌，报听后于下一次摸牌公开'}。</li>
      <li>${ro.qiDui ? '允许门清七对' : '默认禁止七对'}；${ro.qingYiSe ? '已开放清一色' : '默认禁止清一色'}；点炮者未听牌要包三家。</li>
    </ul>`;
  }
  if (r?.id === 'shuangyashan') {
    return `<ul>
      <li>112 张：万筒条 + 4 张红中，无宝牌。</li>
      <li>胡牌须有幺（1/9 或红中）；可门清（闷听）、可手把一、可七对、可清一色。</li>
      <li>屁胡 1 分、夹胡 2 分、飘胡/七小对 4 分；自摸、点炮、闷听、杠开、流泪、海底、手把一、清一色各 ×2，庄家 ×2。</li>
      <li>${ro.gangScore === false ? '本房间关闭杠分' : '明杠、暗杠各 2 分即时结算'}；${ro.dianpaoBaoSanjia === false ? '点炮仅由放炮者支付' : '点炮包三家'}。</li>
      ${ro.shouBaYiSwap ? '<li>手把一剩 2 张暗牌时，本次摸牌可查看牌墙并换牌一次。</li>' : ''}
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
    if (presetById(state.config.ruleSet)) applyPreset(state.config.ruleSet);
  } catch { state.presets = []; }
  renderHome();
  if ('serviceWorker' in navigator) { /* 预留 PWA */ }
  if (state.roomCode) {
    // 等待 hello:ok 后自动加入
    setTimeout(() => { if (!state.snap && state.roomCode) joinRoom(state.roomCode); }, 800);
  }
}

installTileSprites();
init();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#modalRoot .modal-mask')?.remove();
});
