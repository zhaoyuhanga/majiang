// 负载测试：并行 N 个房间（每房 3 个机器人），自动出牌/过，检查稳定性
import { io } from 'socket.io-client';

const BASE = process.env.BASE || 'http://39.106.36.10';
const ROOMS = Number(process.env.ROOMS || 4);
const DURATION = Number(process.env.DURATION || 60);
const clients = [];
const stats = { states: 0, actions: 0, errors: [] };

function startRoom(k) {
  const cid = `load${k}_${Math.random().toString(36).slice(2, 8)}`;
  const socket = io(BASE, { transports: ['websocket'], reconnection: false });
  clients.push(socket);
  let started = false, roundKey = null;
  socket.on('connect', () => socket.emit('hello', { clientId: cid, authToken: 'loadtoken'.repeat(4) + cid, name: `负载房${k}` }));
  socket.on('connect_error', (e) => stats.errors.push('connect:' + e.message));
  socket.on('error:msg', (e) => { if (!/座位已有人/.test(e.message)) stats.errors.push('srv:' + e.message); });
  socket.on('hello:ok', () => socket.emit('room:create', { config: { ruleSet: k % 2 ? 'harbin' : 'shuangyashan', rounds: 32, turnSeconds: 10, autoFillBots: true } }));
  socket.on('room:state', (snap) => {
    stats.states++;
    const rk = snap.code;
    if (snap.state === 'waiting') {
      if (!started) {
        const filled = snap.seats.filter(Boolean).length;
        if (filled < 4) {
          const empty = snap.seats.findIndex((s) => !s);
          if (empty >= 0) socket.emit('room:addBot', { seat: empty });
          return;
        }
        started = true;
        socket.emit('room:start');
      }
      return;
    }
    if (snap.state === 'playing' && snap.game) {
      const o = snap.game.options;
      if (!o) return;
      if (o.phase === 'discard') {
        if (o.hu) { socket.emit('game:act', { action: { type: 'hu' } }); stats.actions++; }
        else if (o.ting) { socket.emit('game:act', { action: { type: 'ting', tile: Number(Object.keys(o.tingDiscards || {})[0]) } }); stats.actions++; }
        else if (o.discards?.length) { socket.emit('game:act', { action: { type: 'discard', tile: o.discards[0] } }); stats.actions++; }
      } else if (o.phase === 'claim') {
        socket.emit('game:act', { action: { type: 'pass' } }); stats.actions++;
      }
    }
  });
}

for (let i = 0; i < ROOMS; i++) startRoom(i);

setTimeout(() => {
  console.log('LOAD RESULT', JSON.stringify({ rooms: ROOMS, seconds: DURATION, ...stats, errors: stats.errors.slice(0, 10) }));
  for (const s of clients) s.close();
  setTimeout(() => process.exit(0), 300);
}, DURATION * 1000);
