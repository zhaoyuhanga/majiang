// 服务入口：HTTP + Socket.IO
import express from 'express';
import compression from 'compression';
import http from 'http';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { RoomManager } from './rooms.js';
import { UserStore, PERMISSION_DEFINITIONS } from './users.js';
import { getPresets } from './rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_ROOMS = 200;

const app = express();
app.disable('x-powered-by');
app.use(compression({ threshold: 1024 }));
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 20000,
});

const users = new UserStore();
const manager = new RoomManager(io);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  const versionedAsset = req.query.v === VERSION && /^\/(?:css|js|images)\//.test(req.path);
  res.setHeader('Cache-Control', versionedAsset ? 'public, max-age=31536000, immutable' : 'no-cache');
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: 0,
  etag: false,
  lastModified: false,
  cacheControl: false,
}));

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
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
  if (io.engine.clientsCount > 500) {
    socket.emit('error:msg', { message: '服务器当前人数较多，请稍后再试' });
    socket.disconnect(true);
    return;
  }
  socket.data.clientId = null;
  socket.data.authToken = null;
  socket.data.features = {};
  socket.data.name = '玩家';
  socket.data.joinedRoom = null;
  socket.data.lastActionAt = 0;
  socket.data.admin = false;
  socket.data.adminFailures = 0;
  socket.data.adminLockedUntil = 0;

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

  function adminState() {
    return {
      rooms: manager.listAll(),
      users: users.list().map((user) => ({
        ...user,
        roomCode: manager.findRoomOf(user.id)?.code || '',
      })),
    };
  }

  socket.on('admin:login', (data = {}) => {
    if (!rateLimit(1000)) return;
    const now = Date.now();
    if (socket.data.adminLockedUntil > now) {
      fail('尝试次数过多，请稍后再试');
      return;
    }
    if (!users.verifyAdmin(data.token)) {
      socket.data.adminFailures++;
      if (socket.data.adminFailures >= 5) socket.data.adminLockedUntil = now + 30000;
      fail('管理员口令错误');
      return;
    }
    socket.data.admin = true;
    socket.data.adminFailures = 0;
    reply('admin:ok', { permissions: PERMISSION_DEFINITIONS, ...adminState() });
  });

  socket.on('admin:logout', () => {
    socket.data.admin = false;
    socket.data.adminFailures = 0;
    socket.data.adminLockedUntil = 0;
    reply('admin:logged-out', {});
  });

  socket.on('admin:state', () => {
    if (!socket.data.admin) { fail('请先登录管理后台'); return; }
    reply('admin:state', adminState());
  });

  socket.on('admin:setFeatures', async (data = {}) => {
    if (!socket.data.admin) { fail('请先登录管理后台'); return; }
    const id = String(data.clientId || '');
    if (!ID_RE.test(id)) { fail('用户标识无效'); return; }
    try {
      const user = users.updateFeatures(id, data.features || {}, socket.data.clientId);
      const revokeAdmin = data.features?.admin === false;
      manager.refreshUser(id, user);
      const targets = await io.fetchSockets();
      for (const target of targets) {
        if (target.data.clientId !== id) continue;
        target.data.features = { ...user.features };
        target.emit('user:features', { features: target.data.features });
        if (target.data.admin && revokeAdmin) {
          target.data.admin = false;
          target.emit('admin:revoked');
        }
      }
      reply('admin:state', adminState());
    } catch (e) { fail(e.message); }
  });

  socket.on('admin:dissolveRoom', (data = {}) => {
    if (!socket.data.admin) { fail('请先登录管理后台'); return; }
    const code = String(data.code || '').toUpperCase();
    if (!manager.destroy(code, '房间已被管理员解散')) fail('房间不存在或已结束');
    else reply('admin:state', adminState());
  });

  socket.on('hello', (data = {}) => {
    if (socket.data.clientId) { fail('请勿重复初始化'); return; }
    const cid = String(data.clientId || '');
    if (!ID_RE.test(cid)) { fail('客户端标识无效，请刷新页面'); return; }
    let user;
    try {
      user = users.register(cid, data.authToken, sanitizeName(data.name) || '玩家');
    } catch (e) {
      if (e.code === 'IDENTITY_MISMATCH') {
        socket.emit('identity:reset', { message: e.message });
        return;
      }
      fail(e.message);
      return;
    }
    socket.data.clientId = cid;
    socket.data.authToken = String(data.authToken || '');
    socket.data.features = { ...user.features };
    socket.data.name = user.name;
    users.connected(cid);
    const room = manager.findRoomOf(cid);
    if (room) {
      const p = room.addPlayer(socket, socket.data.name);
      socket.data.joinedRoom = room.code;
      if (p && p.seat != null) p.connected = true;
      room.broadcast();
      reply('room:joined', { code: room.code, snapshot: room.snapshotFor(cid) });
    }
    reply('hello:ok', { clientId: cid, name: socket.data.name, features: socket.data.features });
  });

  socket.on('lobby:list', () => {
    reply('lobby:list', { rooms: manager.list() });
  });

  socket.on('room:create', (data = {}) => {
    if (!socket.data.clientId) { fail('请先初始化'); return; }
    if (!users.can(socket.data.clientId, 'canCreateRooms')) { fail('你已被管理员取消创建房间权限'); return; }
    if (manager.rooms.size >= MAX_ROOMS) { fail('房间数量已达上限，请加入现有房间'); return; }
    if (socket.data.joinedRoom) {
      const old = manager.get(socket.data.joinedRoom);
      if (old) {
        old.removeMember(socket.data.clientId);
        if (old.state === 'closed') manager.destroy(old.code, old.closeReason);
      }
      socket.data.joinedRoom = null;
    }
    if (data.name) {
      const user = users.register(socket.data.clientId, socket.data.authToken, sanitizeName(data.name) || socket.data.name);
      socket.data.name = user.name;
      socket.data.features = { ...user.features };
    }
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
    if (data.name) {
      const user = users.register(socket.data.clientId, socket.data.authToken, sanitizeName(data.name) || socket.data.name);
      socket.data.name = user.name;
      socket.data.features = { ...user.features };
    }
    const code = String(data.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const room = manager.get(code);
    if (!room) { fail('房间不存在或已解散'); return; }
    if (socket.data.joinedRoom && socket.data.joinedRoom !== code) {
      const old = manager.get(socket.data.joinedRoom);
      if (old) {
        old.removeMember(socket.data.clientId);
        if (old.state === 'closed') manager.destroy(old.code, old.closeReason);
      }
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
    room.removeMember(socket.data.clientId);
    socket.data.joinedRoom = null;
    if (room.state === 'closed') manager.destroy(room.code, room.closeReason);
    else room.broadcast();
    reply('room:left', {});
  });

  socket.on('room:dissolve', () => {
    const room = currentRoom();
    if (!room || !socket.data.clientId) return;
    if (room.hostId !== socket.data.clientId && !users.can(socket.data.clientId, 'canDissolveRooms')) {
      fail('只有房主或授权用户可以解散房间');
      return;
    }
    manager.destroy(room.code, '房间已被解散');
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
      room.startGame(socket.data.clientId, { allowBots: users.can(socket.data.clientId, 'canUseBots') });
      room.broadcast();
    } catch (e) { fail(e.message); }
  });

  socket.on('room:addBot', (data = {}) => {
    const room = currentRoom();
    if (!room || !socket.data.clientId) return;
    if (room.hostId !== socket.data.clientId) { fail('只有房主可以添加人机'); return; }
    if (!users.can(socket.data.clientId, 'canUseBots')) { fail('你已被管理员取消添加人机权限'); return; }
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

  let connectionCleaned = false;
  function cleanupConnection() {
    if (connectionCleaned) return;
    connectionCleaned = true;
    const cid = socket.data.clientId;
    const room = currentRoom();
    if (room && cid) {
      const p = room.members.get(cid);
      if (!p || !p.socketId || p.socketId === socket.id) {
        room.disconnected(cid);
        room.broadcast();
      }
    }
    if (cid) users.disconnected(cid);
  }
  socket.once('disconnect', cleanupConnection);
  socket.conn?.once('close', cleanupConnection);
  socket.conn?.once('error', () => {
    cleanupConnection();
    socket.disconnect(true);
  });
  socket.once('error', () => {
    cleanupConnection();
    socket.disconnect(true);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[majiang] v${VERSION} listening on http://${HOST}:${PORT}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  manager.dispose();
  io.close(() => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
