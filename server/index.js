// 服务入口：HTTP + Socket.IO
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { RoomManager } from './rooms.js';
import { getPresets } from './rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 20000,
});

const manager = new RoomManager(io);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public'), {
  // 更新后立即生效，避免玩家拿到旧的前端
  maxAge: 0,
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    version: '1.1.0',
    rooms: manager.rooms.size,
    players: Array.from(manager.rooms.values()).reduce((a, r) => a + r.members.size, 0),
    uptime: process.uptime(),
  });
});

app.get('/api/rules', (req, res) => {
  res.json({ presets: getPresets() });
});

app.get('/r/:code', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ---------- Socket 校验 ----------
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function sanitizeName(name) {
  return String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
}

io.use((socket, next) => {
  socket.data.events = [];
  next();
});

io.on('connection', (socket) => {
  socket.data.clientId = null;
  socket.data.name = '玩家';
  socket.data.joinedRoom = null;
  socket.data.lastActionAt = 0;

  const reply = (event, payload) => socket.emit(event, payload);
  const fail = (msg) => socket.emit('error:msg', { message: msg });

  function currentRoom() {
    return socket.data.joinedRoom ? manager.get(socket.data.joinedRoom) : null;
  }

  function rateLimit(minGap = 60) {
    const now = Date.now();
    if (now - socket.data.lastActionAt < minGap) return false;
    socket.data.lastActionAt = now;
    return true;
  }

  socket.on('hello', (data = {}) => {
    const cid = String(data.clientId || '');
    if (!ID_RE.test(cid)) { fail('客户端标识无效，请刷新页面'); return; }
    socket.data.clientId = cid;
    socket.data.name = sanitizeName(data.name) || '玩家';
    // 断线重连：找回房间
    const room = manager.findRoomOf(cid);
    if (room) {
      const p = room.addPlayer(socket, socket.data.name);
      socket.data.joinedRoom = room.code;
      if (p && p.seat != null) p.connected = true;
      room.broadcast();
      reply('room:joined', { code: room.code, snapshot: room.snapshotFor(cid) });
    }
    reply('hello:ok', { clientId: cid, name: socket.data.name });
  });

  socket.on('lobby:list', () => {
    reply('lobby:list', { rooms: manager.list() });
  });

  socket.on('room:create', (data = {}) => {
    if (!socket.data.clientId) { fail('请先初始化'); return; }
    if (socket.data.joinedRoom) {
      const old = manager.get(socket.data.joinedRoom);
      if (old) old.removeMember(socket.data.clientId);
      socket.data.joinedRoom = null;
    }
    if (data.name) socket.data.name = sanitizeName(data.name) || socket.data.name;
    const room = manager.create(socket.data.clientId, data.config || {});
    const p = room.addPlayer(socket, socket.data.name);
    p.isHost = true;
    room.hostId = p.id;
    // 自动坐下第一个空位
    try { room.sit(p.id, 0); } catch { /* ignore */ }
    socket.data.joinedRoom = room.code;
    room.broadcast();
    reply('room:created', { code: room.code });
    reply('room:state', room.snapshotFor(p.id));
  });

  socket.on('room:join', (data = {}) => {
    if (!socket.data.clientId) { fail('请先初始化'); return; }
    if (data.name) socket.data.name = sanitizeName(data.name) || socket.data.name;
    const code = String(data.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const room = manager.get(code);
    if (!room) { fail('房间不存在或已解散'); return; }
    if (socket.data.joinedRoom && socket.data.joinedRoom !== code) {
      const old = manager.get(socket.data.joinedRoom);
      if (old) old.removeMember(socket.data.clientId);
    }
    const p = room.addPlayer(socket, socket.data.name);
    socket.data.joinedRoom = code;
    // 等待中的房间：自动坐到第一个空位，省去手动坐下
    if (room.state === 'waiting' && p.seat == null) {
      const empty = room.seats.findIndex((s) => !s);
      if (empty >= 0) { try { room.sit(p.id, empty); } catch { /* ignore */ } }
    }
    room.broadcast();
    reply('room:joined', { code, snapshot: room.snapshotFor(p.id) });
    reply('room:state', room.snapshotFor(p.id));
  });

  socket.on('room:leave', () => {
    const room = currentRoom();
    if (!room || !socket.data.clientId) return;
    const p = room.members.get(socket.data.clientId);
    if (p && p.seat != null) {
      if (room.state === 'waiting') { try { room.stand(p.id); } catch { /* ignore */ } }
    }
    room.removeMember(socket.data.clientId);
    socket.data.joinedRoom = null;
    room.broadcast();
    reply('room:left', {});
  });

  socket.on('room:sit', (data = {}) => {
    const room = currentRoom();
    if (!room || !socket.data.clientId) { fail('不在房间'); return; }
    try {
      room.sit(socket.data.clientId, Number(data.seat));
      room.broadcast();
    } catch (e) { fail(e.message); }
  });

  socket.on('room:stand', () => {
    const room = currentRoom();
    if (!room || !socket.data.clientId) return;
    try { room.stand(socket.data.clientId); room.broadcast(); } catch (e) { fail(e.message); }
  });

  socket.on('room:ready', (data = {}) => {
    const room = currentRoom();
    if (!room || !socket.data.clientId) return;
    room.setReady(socket.data.clientId, data.ready);
    room.broadcast();
  });

  socket.on('room:config', (data = {}) => {
    const room = currentRoom();
    if (!room || !socket.data.clientId) return;
    try {
      room.updateConfig(socket.data.clientId, data.config || {});
      room.broadcast();
    } catch (e) { fail(e.message); }
  });

  socket.on('room:start', () => {
    const room = currentRoom();
    if (!room || !socket.data.clientId) return;
    try {
      room.startGame(socket.data.clientId);
      room.broadcast();
    } catch (e) { fail(e.message); }
  });

  socket.on('room:addBot', (data = {}) => {
    const room = currentRoom();
    if (!room || !socket.data.clientId) return;
    if (room.hostId !== socket.data.clientId) { fail('只有房主可以添加人机'); return; }
    try {
      let seat = Number(data.seat);
      if (!Number.isInteger(seat) || seat < 0 || seat > 3) {
        seat = room.seats.findIndex((s) => !s);
        if (seat < 0) throw new Error('没有空位');
      }
      room.addBot(seat);
      room.broadcast();
    } catch (e) { fail(e.message); }
  });

  socket.on('room:removeSeat', (data = {}) => {
    const room = currentRoom();
    if (!room || !socket.data.clientId) return;
    if (room.hostId !== socket.data.clientId) { fail('只有房主可以操作'); return; }
    try { room.removeSeat(Number(data.seat)); room.broadcast(); } catch (e) { fail(e.message); }
  });

  socket.on('room:continue', () => {
    const room = currentRoom();
    if (!room || !socket.data.clientId) return;
    try { room.continueRound(socket.data.clientId); room.broadcast(); } catch (e) { fail(e.message); }
  });

  socket.on('room:restart', () => {
    const room = currentRoom();
    if (!room || !socket.data.clientId) return;
    try { room.restart(socket.data.clientId); room.broadcast(); } catch (e) { fail(e.message); }
  });

  socket.on('game:act', (data = {}) => {
    const room = currentRoom();
    if (!room || !socket.data.clientId) { fail('不在房间'); return; }
    if (!rateLimit(40)) return;
    try {
      room.act(socket.data.clientId, data.action || {});
      room.broadcast();
    } catch (e) { fail(e.message); }
  });

  socket.on('chat', (data = {}) => {
    const room = currentRoom();
    if (!room || !socket.data.clientId) return;
    room.chatMsg(socket.data.clientId, data.text);
    room.broadcast();
  });

  socket.on('disconnect', () => {
    const cid = socket.data.clientId;
    const room = currentRoom();
    if (room && cid) {
      const p = room.members.get(cid);
      // 已经被同一玩家的新连接接管，不要误标记离线
      if (p && p.socketId && p.socketId !== socket.id) return;
      room.disconnected(cid);
      room.broadcast();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[majiang] listening on http://${HOST}:${PORT}`);
});
