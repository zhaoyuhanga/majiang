import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, RoomManager } from '../server/rooms.js';

function socket(id) {
  return { id: `socket-${id}`, data: { clientId: id, features: {} } };
}

function playingRoom(humans = 1) {
  const room = new Room('TEST2', 'p0', { rounds: 4, autoFillBots: true });
  const host = room.addPlayer(socket('p0'), '房主');
  room.hostId = host.id;
  room.sit(host.id, 0);
  for (let i = 1; i < humans; i++) {
    const guest = room.addPlayer(socket(`p${i}`), `玩家${i}`);
    room.sit(guest.id, i);
    room.setReady(guest.id, true);
  }
  while (room.seats.some((seat) => !seat)) room.addBot(room.seats.findIndex((seat) => !seat));
  room.startGame(host.id);
  return room;
}

test('最后一个真人主动退出：房间立即结束', () => {
  const room = playingRoom(1);
  room.removeMember('p0');
  assert.equal(room.state, 'closed');
  assert.equal(room.members.has('p0'), false);
  assert.equal([...room.members.values()].some((p) => !p.bot), false);
});

test('有其他真人时退出：座位交给机器人并转移房主', () => {
  const room = playingRoom(2);
  room.removeMember('p0');
  assert.equal(room.state, 'playing');
  assert.equal(room.members.has('p0'), false);
  assert.equal(room.hostId, 'p1');
  assert.equal(room.members.get(room.seats[0]).bot, true);
  assert.equal(room.round.players[0].bot, true);
});

test('最后一个真人断线：保留重连机会，30 秒后自动结束', () => {
  const room = playingRoom(1);
  room.disconnected('p0');
  assert.equal(room.state, 'playing');
  assert.equal(room.members.get('p0').connected, false);
  assert.equal(room.members.get('p0').bot, false);
  room.noActiveHumanAt = Date.now() - 30001;
  room.tick();
  assert.equal(room.state, 'closed');
  assert.match(room.closeReason, /自动结束/);
});

test('房主断线：管理权转移给在线真人，重连后不夺回', () => {
  const room = playingRoom(2);
  room.disconnected('p0');
  assert.equal(room.hostId, 'p1');
  assert.equal(room.members.get('p0').isHost, false);
  assert.equal(room.members.get('p1').isHost, true);
  room.addPlayer(socket('p0'), '房主');
  assert.equal(room.hostId, 'p1');
  assert.equal(room.snapshotFor('p0').isHost, false);
  assert.equal(room.snapshotFor('p1').isHost, true);
});

test('特殊换牌：房间层实时校验权限并展示标识', () => {
  const room = playingRoom(1);
  const member = room.members.get('p0');
  const player = room.round.players[0];
  member.features.canSwapDraw = true;
  player.canSwapDraw = true;
  room.round.turn = 0;
  room.round.phase = 'discard';
  player.drawn = player.hand[player.hand.length - 1];
  const before = player.drawn;
  const result = room.act('p0', { type: 'revealDraw' });
  assert.ok(Object.keys(result.wallChoices).length > 0);
  assert.equal(room.snapshotFor('p0').seats[0].canSwapDraw, true);
  assert.equal(Object.hasOwn(room.snapshotFor('p0').game.options, 'wallChoices'), true);
  member.features.canSwapDraw = false;
  assert.throws(() => room.act('p0', { type: 'swapDraw', tile: 21 }), /没有.*权限/);
  assert.equal(player.drawn, before);
});

test('广播跳过失效连接，权限撤销关闭换牌 reveal，定时器可释放', (t) => {
  const sent = [];
  const active = { connected: true, data: { clientId: 'p0' }, emit: (event, data) => sent.push({ event, data }) };
  const stale = { connected: false, data: { clientId: 'p0' }, emit: () => assert.fail('不应向失效连接发送消息') };
  const io = { sockets: { sockets: new Map([['socket-p0', active], ['stale-socket', stale]]) } };
  const manager = new RoomManager(io);
  t.after(() => manager.dispose());
  assert.equal(manager.timer.hasRef(), false);
  assert.equal(manager.cleanupTimer.hasRef(), false);
  const room = playingRoom(1);
  room.io = io;
  manager.rooms.set(room.code, room);
  room.members.get('p0').socketId = 'socket-p0';
  const player = room.round.players[0];
  room.members.get('p0').features.canSwapDraw = true;
  player.canSwapDraw = true;
  room.round.turn = 0;
  room.round.phase = 'discard';
  player.drawn = player.hand[player.hand.length - 1];
  room.act('p0', { type: 'revealDraw' });
  room.broadcast();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, 'room:state');
  assert.equal(Object.hasOwn(sent[0].data.game.options, 'wallChoices'), true);
  manager.refreshUser('p0', { features: { canSwapDraw: false } });
  assert.equal(player.canSwapDraw, false);
  assert.equal(player.drawSwapOpen, false);
  assert.equal(Object.hasOwn(sent.at(-1).data.game.options, 'wallChoices'), false);
  manager.dispose();
});

test('普通快照不暴露用户标识', () => {
  const room = playingRoom(1);
  room.chatMsg('p0', '你好');
  const snap = room.snapshotFor('p0');
  assert.equal(Object.hasOwn(snap, 'hostId'), false);
  assert.equal(Object.hasOwn(snap.seats[0], 'id'), false);
  assert.equal(Object.hasOwn(snap.game.players[0], 'id'), false);
  assert.equal(Object.hasOwn(snap.chat[0], 'id'), false);
});
