import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';

const PORT = 3017;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'integration-admin-secret';

function once(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), timeout);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function until(socket, event, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const listener = (data) => {
      if (!predicate(data)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(data);
    };
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`等待 ${event} 状态超时`));
    }, timeout);
    socket.on(event, listener);
  });
}

async function emit(socket, event, data, reply) {
  const response = once(socket, reply);
  socket.emit(event, data);
  return response;
}

async function connect(name, id, token) {
  const socket = io(BASE, { transports: ['websocket'], reconnection: false, timeout: 5000 });
  await once(socket, 'connect');
  const hello = once(socket, 'hello:ok');
  socket.emit('hello', { name, clientId: id, authToken: token });
  await hello;
  return socket;
}

test('管理后台、用户权限与房间解散联调', { timeout: 30000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'majiang-admin-'));
  const server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), MAJIANG_DATA_DIR: dataDir, ADMIN_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (data) => { serverOutput += data; });
  server.stderr.on('data', (data) => { serverOutput += data; });
  t.after(async () => {
    if (server.exitCode == null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode != null) break;
    try {
      const response = await fetch(`${BASE}/healthz`);
      if (response.ok) { ready = true; break; }
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `测试服务器未启动：${serverOutput}`);

  const admin = await connect('管理员', 'admin_12345678', 'd'.repeat(48));
  const host = await connect('房主', 'host_12345678', 'h'.repeat(48));
  const guest = await connect('访客', 'guest_123456', 'g'.repeat(48));
  t.after(() => { admin.close(); host.close(); guest.close(); });

  const unauthorized = once(admin, 'error:msg');
  admin.emit('admin:state');
  assert.match((await unauthorized).message, /先登录/);

  const wrongPassword = once(admin, 'error:msg');
  admin.emit('admin:login', { token: 'wrong-secret' });
  assert.match((await wrongPassword).message, /口令错误/);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const login = await emit(admin, 'admin:login', { token: ADMIN_TOKEN }, 'admin:ok');
  assert.equal(login.users.length, 3);
  assert.equal(login.rooms.length, 0);
  await emit(admin, 'admin:setFeatures', {
    clientId: 'admin_12345678',
    features: { vip: true },
  }, 'admin:state');

  await emit(admin, 'admin:setFeatures', {
    clientId: 'guest_123456',
    features: { admin: true },
  }, 'admin:state');
  const guestLogin = await emit(guest, 'admin:login', { token: ADMIN_TOKEN }, 'admin:ok');
  assert.equal(guestLogin.users.length, 3);
  await emit(guest, 'admin:logout', {}, 'admin:logged-out');
  const loggedOutState = once(guest, 'error:msg');
  guest.emit('admin:state');
  assert.match((await loggedOutState).message, /先登录/);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await emit(guest, 'admin:login', { token: ADMIN_TOKEN }, 'admin:ok');
  const guestRevoked = once(guest, 'admin:revoked');
  const guestFeatures = once(guest, 'user:features');
  await emit(admin, 'admin:setFeatures', {
    clientId: 'guest_123456',
    features: { admin: false },
  }, 'admin:state');
  await guestRevoked;
  assert.equal((await guestFeatures).features.admin, false);
  const revokedState = once(guest, 'error:msg');
  guest.emit('admin:state');
  assert.match((await revokedState).message, /先登录/);

  const impostor = io(BASE, { transports: ['websocket'], reconnection: false });
  await once(impostor, 'connect');
  const reset = once(impostor, 'identity:reset');
  impostor.emit('hello', { name: '冒名者', clientId: 'host_12345678', authToken: 'x'.repeat(48) });
  assert.match((await reset).message, /身份|凭证/);
  impostor.close();

  const created = await emit(host, 'room:create', { name: '房主' }, 'room:created');
  const code = created.code;
  assert.ok(code);
  await emit(guest, 'room:join', { code, name: '访客' }, 'room:joined');

  const featureUpdate = once(host, 'user:features');
  const adminUpdate = await emit(admin, 'admin:setFeatures', {
    clientId: 'host_12345678',
    features: { vip: true, canDissolveRooms: true },
  }, 'admin:state');
  assert.equal((await featureUpdate).features.vip, true);
  assert.equal(adminUpdate.users.find((user) => user.id === 'host_12345678').features.vip, true);
  assert.equal(adminUpdate.rooms.find((room) => room.code === code).hostName, '房主');

  const guestDenied = once(guest, 'error:msg');
  guest.emit('room:dissolve');
  assert.match((await guestDenied).message, /只有房主/);

  const hostClosed = once(host, 'room:closed');
  await emit(admin, 'admin:dissolveRoom', { code }, 'admin:state');
  assert.match((await hostClosed).reason, /管理员解散/);

  const secondRoom = await emit(host, 'room:create', { name: '房主' }, 'room:created');
  assert.ok(secondRoom.code);
  const hostDissolved = once(host, 'room:closed');
  host.emit('room:dissolve');
  assert.match((await hostDissolved).reason, /已被解散/);
  const finalAdminState = await emit(admin, 'admin:state', {}, 'admin:state');
  assert.equal(finalAdminState.rooms.length, 0);

  const createRevoked = once(host, 'error:msg');
  await emit(admin, 'admin:setFeatures', {
    clientId: 'host_12345678',
    features: { canCreateRooms: false },
  }, 'admin:state');
  host.emit('room:create', { name: '房主' });
  assert.match((await createRevoked).message, /取消创建房间权限/);

  const restored = once(host, 'user:features');
  await emit(admin, 'admin:setFeatures', {
    clientId: 'host_12345678',
    features: { canCreateRooms: true },
  }, 'admin:state');
  assert.equal((await restored).features.canCreateRooms, true);

  const transferRoom = await emit(host, 'room:create', { name: '房主' }, 'room:created');
  await emit(guest, 'room:join', { code: transferRoom.code, name: '访客' }, 'room:joined');
  const transferred = until(guest, 'room:state', (snap) => snap.isHost && snap.seats[0]?.connected === false);
  host.close();
  const guestSnapshot = await transferred;
  assert.equal(guestSnapshot.isHost, true, JSON.stringify({ seats: guestSnapshot.seats, mySeat: guestSnapshot.mySeat }));
  assert.equal(guestSnapshot.seats[guestSnapshot.mySeat].isHost, true);
  const guestDissolved = once(guest, 'room:closed');
  guest.emit('room:dissolve');
  assert.match((await guestDissolved).reason, /已被解散/);
  const idleState = await emit(admin, 'admin:state', {}, 'admin:state');
  assert.equal(idleState.rooms.length, 0);
});
