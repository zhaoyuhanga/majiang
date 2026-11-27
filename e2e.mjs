// 生产环境端到端测试（WebSocket 直连公网服务器）
import { io } from 'socket.io-client';

const BASE = process.env.BASE || 'http://39.106.36.10';
const cid = 'e2e' + Math.random().toString(36).slice(2, 10);
const socket = io(BASE, { transports: ['websocket'], timeout: 10000 });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let states = 0, actions = 0, started = false, done = false;
const requestedSeats = new Set();

function finish(code) {
  if (done) return;
  done = true;
  log('states received:', states, 'actions:', actions);
  socket.close();
  setTimeout(() => process.exit(code), 300);
}

socket.on('connect', () => {
  log('connected', socket.id, 'transport=', socket.io.engine.transport.name);
  socket.emit('hello', { clientId: cid, authToken: 'e2etoken'.repeat(4) + cid, name: 'E2E测试' });
});
socket.on('connect_error', (e) => log('connect_error', e.message));
socket.on('error:msg', (e) => log('server error:', e.message));
socket.on('hello:ok', () => {
  log('hello ok, creating room');
  socket.emit('room:create', { config: { ruleSet: 'harbin', rounds: 1, turnSeconds: 10, autoFillBots: true } });
});
socket.on('room:created', ({ code }) => log('room created', code));

socket.on('room:state', (snap) => {
  states++;
  if (states <= 3 || states % 20 === 0) {
    log('state', snap.state, 'round', snap.roundNo, 'phase', snap.game?.phase, 'wall', snap.game?.wall, 'seats', snap.seats.filter(Boolean).length);
  }
  if (snap.state === 'waiting') {
    const filled = snap.seats.filter(Boolean).length;
    if (filled < 4) {
      const empty = snap.seats.findIndex((s, seat) => !s && !requestedSeats.has(seat));
      if (empty >= 0) {
        requestedSeats.add(empty);
        socket.emit('room:addBot', { seat: empty });
      }
      return;
    }
    if (!started) { started = true; log('starting'); socket.emit('room:start'); }
    return;
  }
  if (snap.state === 'result' || snap.state === 'finished') {
    const r = snap.result;
    log('RESULT', r.type, (r.winners || []).map((w) => `${w.name} ${w.label} fan=${w.fan} total=${w.total}`).join(' | '),
      'deltas', JSON.stringify(r.deltas), 'scores', JSON.stringify(snap.scores));
    finish(0);
    return;
  }
  const o = snap.game?.options;
  if (snap.state !== 'playing' || !o) return;
  if (o.phase === 'discard') {
    if (o.hu) { socket.emit('game:act', { action: { type: 'hu' } }); actions++; return; }
    if (o.ting) { socket.emit('game:act', { action: { type: 'ting', tile: Number(Object.keys(o.tingDiscards || {})[0]) } }); actions++; return; }
    const tile = o.discards?.[0];
    if (tile != null) { socket.emit('game:act', { action: { type: 'discard', tile } }); actions++; }
  } else if (o.phase === 'claim') {
    socket.emit('game:act', { action: { type: 'pass' } });
    actions++;
  }
});

setTimeout(() => { log('TIMEOUT'); finish(1); }, 90000);
