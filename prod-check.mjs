// 生产环境完整流程验证：创建 → 第二人链接加入 → 自动入座 → 开局 → 断线托管 → 重连
import { io } from 'socket.io-client';

const BASE = process.env.BASE || 'http://39.106.36.10';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(cid, name) {
  const socket = io(BASE, { transports: ['websocket'], reconnection: false });
  const c = { socket, cid, name, snap: null };
  socket.on('connect', () => socket.emit('hello', { clientId: cid, name }));
  socket.on('room:state', (s) => { c.snap = s; });
  socket.on('error:msg', (e) => { c.lastError = e.message; log(name, 'ERR', e.message); });
  return c;
}

const A = client('proda_' + Date.now().toString(36), '房主A');
const B = client('prodb_' + Date.now().toString(36), '玩家B');
await wait(800);
A.socket.emit('room:create', { config: { ruleSet: 'shuangyashan', rounds: 2, turnSeconds: 12, baseScore: 1, autoFillBots: true, cap: 64 } });
await wait(600);
const code = A.snap?.code;
log('room', code, 'A seat', A.snap?.mySeat);
B.socket.emit('room:join', { code, name: '玩家B' });
await wait(600);
log('B seat after join', B.snap?.mySeat, 'seats', B.snap?.seats.filter(Boolean).length);

// A 补两个机器人
for (let i = 0; i < 2; i++) {
  const empty = A.snap.seats.findIndex((s) => !s);
  if (empty >= 0) A.socket.emit('room:addBot', { seat: empty });
  await wait(350);
}
log('seats full:', A.snap.seats.filter(Boolean).length);
A.socket.emit('room:start');
await wait(1500);
log('state', A.snap.state, 'round', A.snap.roundNo, 'B hand', B.snap.game?.myHand?.length, 'B seat', B.snap.mySeat);

// B 断线，等 10 秒看是否托管
B.socket.close();
await wait(10000);
const bSeat = 1;
const botAfterDisconnect = A.snap.game?.players?.[bSeat]?.bot;
const nameAfter = A.snap.game?.players?.[bSeat]?.name;
log('after disconnect: bot=', botAfterDisconnect, 'name=', nameAfter);

// B 重连
const B2 = client(B.cid, '玩家B');
await wait(1200);
log('B reconnected seat', B2.snap?.mySeat, 'bot=', B2.snap?.game?.players?.[B2.snap.mySeat]?.bot, 'connected=', B2.snap?.game?.players?.[B2.snap.mySeat]?.connected);
log('final errors:', A.lastError || '-', B.lastError || '-', B2.lastError || '-');
A.socket.close(); B2.socket.close();
process.exit(0);
