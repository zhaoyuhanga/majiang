// 房间与对局生命周期管理
import { Round } from './game.js';
import { buildRoomRules, getPresets, getRule, normalizeRuleOptions } from './rules.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_CHAT = 40;
const AUTO_CLOSE_MS = 30000;

function randomCode(n = 5) {
  let s = '';
  for (let i = 0; i < n; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12) || '玩家';
}

export function normalizeConfig(input = {}) {
  const ruleSet = ['harbin', 'shuangyashan'].includes(input.ruleSet) ? input.ruleSet : 'harbin';
  const cfg = {
    ruleSet,
    rounds: Math.max(1, Math.min(32, Number(input.rounds) || 8)),
    baseScore: Math.max(1, Math.min(10, Number(input.baseScore) || 1)),
    turnSeconds: Math.max(8, Math.min(60, Number(input.turnSeconds) || 20)),
    claimSeconds: Math.max(5, Math.min(30, Number(input.claimSeconds) || 12)),
    cap: input.cap != null ? Math.max(8, Math.min(256, Number(input.cap) || getRule(ruleSet).scoring.cap)) : undefined,
    allowChi: input.allowChi !== false,
    allowMultiHu: !!input.allowMultiHu,
    autoFillBots: input.autoFillBots !== false,
    isPublic: input.isPublic !== false,
    ruleOptions: normalizeRuleOptions(ruleSet, input.ruleOptions),
  };
  return cfg;
}

export class Room {
  constructor(code, hostId, config) {
    this.code = code;
    this.hostId = hostId;
    this.config = normalizeConfig(config);
    this.rules = buildRoomRules({ ...this.config, options: this.config });
    this.seats = [null, null, null, null];
    this.members = new Map(); // id -> player
    this.spectators = new Set();
    this.state = 'waiting';
    this.round = null;
    this.roundNo = 0;
    this.totalRounds = this.rules.__config.rounds;
    this.dealer = 0;
    this.scores = [0, 0, 0, 0];
    this.result = null;
    this.history = [];
    this.chat = [];
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.nextAt = 0;
    this.lastSeq = -1;
    this.settingsLocked = false;
  }

  // ---------- 成员 ----------
  addPlayer(socket, name) {
    const id = socket.data.clientId;
    let p = this.members.get(id);
    if (p) {
      p.socketId = socket.id;
      p.name = cleanName(name || p.name.replace('(托管)', ''));
      p.features = socket.data.features || p.features || {};
      p.connected = true;
      p.bot = false;
      p.disconnectedAt = null;
      p.lastSeen = Date.now();
      if (p.seat != null && this.round) {
        const rp = this.round.players[p.seat];
        rp.connected = true;
        rp.name = p.name;
        rp.bot = false;
      }
      this.noteHumanActivity();
      return p;
    }
    const isHost = id === this.hostId;
    p = {
      id, name: cleanName(name), socketId: socket.id, seat: null,
      connected: true, ready: false, bot: false, isHost,
      features: socket.data.features || {},
      joinedAt: Date.now(), lastSeen: Date.now(),
    };
    this.members.set(id, p);
    this.spectators.add(id);
    this.noteHumanActivity();
    return p;
  }

  hasConnectedHuman(seatedOnly = false) {
    return [...this.members.values()].some((p) => !p.bot && p.connected && (!seatedOnly || p.seat != null));
  }

  noteHumanActivity() {
    if (this.state === 'waiting' || this.state === 'finished' || this.hasConnectedHuman(true)) {
      this.noActiveHumanAt = 0;
    } else if (!this.noActiveHumanAt) {
      this.noActiveHumanAt = Date.now();
    }
  }

  takeoverSeat(seat, name) {
    const id = `bot:takeover:${this.code}:${seat}:${Date.now().toString(36)}`;
    const botName = `${String(name || '玩家').replace('(托管)', '')}(机器人)`;
    this.seats[seat] = id;
    this.members.set(id, {
      id, name: botName, socketId: null, seat, connected: true,
      ready: true, bot: true, isHost: false, features: {}, lastSeen: Date.now(),
    });
    if (this.round) {
      const rp = this.round.players[seat];
      rp.id = id;
      rp.name = botName;
      rp.bot = true;
      rp.connected = true;
      rp.canSwapDraw = false;
      rp.drawSwapOpen = false;
    }
  }

  close(reason = '房间已结束') {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.closeReason = reason;
    this.settingsLocked = true;
    this.nextAt = 0;
    this.round = null;
    this.lastActivity = Date.now();
  }

  removeMember(id) {
    const p = this.members.get(id);
    if (!p) return;
    const seat = p.seat;
    const inGame = this.state === 'playing' || this.state === 'result';
    this.members.delete(id);
    this.spectators.delete(id);
    if (seat != null) {
      if (inGame) this.takeoverSeat(seat, p.name);
      else this.seats[seat] = null;
    }
    if (p.isHost || id === this.hostId) {
      const next = [...this.members.values()]
        .filter((m) => !m.bot && m.connected)
        .sort((a, b) => Number(b.seat != null) - Number(a.seat != null))[0];
      if (next) {
        next.isHost = true;
        this.hostId = next.id;
      } else {
        this.hostId = null;
      }
    }
    this.lastActivity = Date.now();
    this.noteHumanActivity();
    if ((inGame && !this.hasConnectedHuman(true)) || ((this.state === 'waiting' || this.state === 'finished') && !this.hasConnectedHuman())) {
      this.close('玩家已离开，房间自动结束');
    }
  }

  disconnected(id) {
    const p = this.members.get(id);
    if (!p) return;
    p.connected = false;
    p.disconnectedAt = Date.now();
    p.lastSeen = Date.now();
    if (p.seat != null && this.round) {
      this.round.players[p.seat].connected = false;
    }
    if (p.isHost || id === this.hostId) {
      const next = [...this.members.values()]
        .filter((m) => !m.bot && m.connected && m.id !== id)
        .sort((a, b) => Number(b.seat != null) - Number(a.seat != null))[0];
      if (next) {
        p.isHost = false;
        next.isHost = true;
        this.hostId = next.id;
      }
    }
    this.lastActivity = Date.now();
    this.noteHumanActivity();
  }

  getPlayer(id) { return this.members.get(id); }

  sit(id, seat) {
    if (this.settingsLocked) throw new Error('对局进行中，不能换座');
    const p = this.members.get(id);
    if (!p) throw new Error('不在房间');
    if (seat < 0 || seat > 3) throw new Error('座位无效');
    if (this.seats[seat]) throw new Error('该座位已有人');
    if (p.seat != null) this.seats[p.seat] = null;
    else this.spectators.delete(id);
    p.seat = seat;
    p.ready = false;
    this.seats[seat] = id;
    this.lastActivity = Date.now();
    this.noteHumanActivity();
  }

  stand(id) {
    if (this.settingsLocked) throw new Error('对局进行中，不能离座');
    const p = this.members.get(id);
    if (!p) return;
    if (p.seat != null) this.seats[p.seat] = null;
    p.seat = null;
    p.ready = false;
    this.spectators.add(id);
  }

  addBot(seat) {
    if (this.settingsLocked) throw new Error('对局进行中，不能加人机');
    if (this.seats[seat]) throw new Error('该座位已有人');
    const id = `bot:${this.code}:${seat}:${Date.now().toString(36)}`;
    const botNames = ['小明', '小红', '阿强', '花花', '老李', '大伟'];
    this.botSeq = (this.botSeq || 0) + 1;
    const suffix = this.botSeq > botNames.length ? String(this.botSeq) : '';
    const p = {
      id, name: `${botNames[(this.botSeq - 1) % botNames.length]}${suffix}(机器人)`,
      socketId: null, seat, connected: true, ready: true, bot: true, isHost: false,
      joinedAt: Date.now(), lastSeen: Date.now(),
    };
    this.members.set(id, p);
    this.seats[seat] = id;
    this.spectators.delete(id);
    return p;
  }

  removeSeat(seat) {
    if (this.settingsLocked) throw new Error('对局进行中，不能踢人');
    const id = this.seats[seat];
    if (!id) return;
    const p = this.members.get(id);
    if (p && !p.bot) {
      p.seat = null;
      this.spectators.add(id);
      p.ready = false;
    } else {
      this.members.delete(id);
    }
    this.seats[seat] = null;
  }

  setReady(id, ready) {
    const p = this.members.get(id);
    if (p) p.ready = !!ready;
  }

  updateConfig(id, cfg) {
    if (id !== this.hostId) throw new Error('只有房主可以修改设置');
    if (this.state !== 'waiting') throw new Error('对局中不能修改设置');
    this.config = normalizeConfig({
      ...this.config,
      ...cfg,
      ruleOptions: { ...this.config.ruleOptions, ...(cfg.ruleOptions || {}) },
    });
    this.rules = buildRoomRules({ ...this.config, options: this.config });
    this.totalRounds = this.rules.__config.rounds;
  }

  // ---------- 对局 ----------
  canStart() {
    return this.state === 'waiting' && this.seats.every((s) => s);
  }

  startGame(id, { allowBots = true } = {}) {
    if (this.state !== 'waiting') throw new Error('当前不能开始');
    if (!this.hasConnectedHuman(true)) throw new Error('没有在线玩家，房间已结束');
    const host = this.members.get(this.hostId);
    if (id && id !== this.hostId && host && host.connected) throw new Error('只有房主可以开始游戏');
    const seatIds = this.seats.slice();
    if (this.config.autoFillBots && allowBots) {
      for (let i = 0; i < 4; i++) if (!seatIds[i]) { this.addBot(i); seatIds[i] = this.seats[i]; }
    }
    if (!seatIds.every(Boolean)) throw new Error('人数不够，请先补满 4 个座位（可添加人机）');
    const unready = seatIds.filter((id) => {
      const p = this.members.get(id);
      return p && !p.bot && id !== this.hostId && !p.ready;
    });
    if (unready.length) throw new Error(`还有 ${unready.length} 位玩家未准备`);
    this.scores = [0, 0, 0, 0];
    this.dealer = Math.floor(Math.random() * 4);
    this.roundNo = 0;
    this.state = 'playing';
    this.settingsLocked = true;
    this.result = null;
    this.startRound();
  }

  startRound() {
    this.roundNo++;
    this.lastSeq = -1;
    const seats = this.seats.map((sid) => {
      const p = this.members.get(sid);
      return {
        id: sid,
        name: p ? p.name : '玩家',
        bot: p ? !!p.bot || !p.connected : true,
        connected: p ? p.connected : false,
        canSwapDraw: !!p?.features?.canSwapDraw,
      };
    });
    this.round = new Round({
      rules: this.rules,
      seats,
      dealer: this.dealer,
      scores: this.scores,
      roundNo: this.roundNo,
    });
    this.playStartedAt = Date.now();
  }

  finishRound() {
    const r = this.round;
    if (!r || !r.result) return;
    for (let i = 0; i < 4; i++) this.scores[i] += r.result.deltas[i];
    this.result = r.result;
    this.history.push({ roundNo: this.roundNo, result: r.result });
    this.state = 'result';
    this.nextAt = Date.now() + 15000;
    const win = r.result.type === 'win' && r.result.winners.length;
    this.lastWinner = win ? r.result.winners[0].seat : null;
    this.settingsLocked = true;
  }

  continueRound(id) {
    if (!this.hasConnectedHuman(true)) throw new Error('没有在线玩家，房间已结束');
    if (this.state === 'result') {
      this.nextAt = Math.min(this.nextAt, Date.now() + 800);
      this.autoNext = true;
    } else if (this.state === 'finished') {
      this.restart(id);
    }
  }

  nextRound() {
    if (this.state !== 'result' || !this.hasConnectedHuman(true)) return;
    if (this.roundNo >= this.totalRounds) {
      this.state = 'finished';
      this.settingsLocked = false;
      this.round = null;
      this.nextAt = 0;
      return;
    }
    if (this.lastWinner != null && this.lastWinner === this.dealer) {
      // 庄家连庄
    } else if (this.lastWinner == null) {
      // 荒庄：庄家连庄
    } else {
      this.dealer = (this.dealer + 1) % 4;
    }
    this.state = 'playing';
    this.result = null;
    this.startRound();
  }

  restart(id) {
    if (id !== this.hostId) throw new Error('只有房主可以重开');
    this.scores = [0, 0, 0, 0];
    this.roundNo = 0;
    this.state = 'waiting';
    this.result = null;
    this.round = null;
    this.settingsLocked = false;
    this.history = [];
  }

  act(id, action) {
    if (this.state !== 'playing' || !this.round) throw new Error('对局未开始');
    const p = this.members.get(id);
    if (!p || p.seat == null) throw new Error('你不在座位上');
    this.lastActivity = Date.now();
    if (p.seat != null && this.round) this.round.players[p.seat].canSwapDraw = !!p.features?.canSwapDraw;
    if ((action?.type === 'revealDraw' || action?.type === 'swapDraw') && !this.round.canSwapDraw(p.seat)) {
      throw new Error('当前没有可用的摸牌换牌权限');
    }
    return this.round.act(p.seat, action);
  }

  chatMsg(id, text) {
    const p = this.members.get(id);
    if (!p) return;
    const clean = String(text || '').replace(/[\u0000-\u001f]/g, '').slice(0, 80).trim();
    if (!clean) return;
    const now = Date.now();
    if (now - (p.lastChatAt || 0) < 800) return;
    p.lastChatAt = now;
    this.chat.push({ id, name: p.name, text: clean, at: now });
    if (this.chat.length > MAX_CHAT) this.chat.shift();
  }

  tick() {
    if (this.state === 'closed') return;
    const now = Date.now();
    this.noteHumanActivity();
    if ((this.state === 'playing' || this.state === 'result') && this.noActiveHumanAt && now - this.noActiveHumanAt >= AUTO_CLOSE_MS) {
      this.close('长时间无人在线，房间已自动结束');
      this.broadcast();
      return;
    }
    // 断线 8 秒后转托管
    if (this.state === 'playing' && this.round) {
      for (const p of this.members.values()) {
        if (p.seat == null || p.connected || p.bot || p.id.startsWith('bot:')) continue;
        if (p.disconnectedAt && now - p.disconnectedAt > 8000) {
          p.bot = true;
          if (!p.name.endsWith('(托管)')) p.name += '(托管)';
          const rp = this.round.players[p.seat];
          rp.bot = true;
          rp.name = p.name;
          this.lastSeq = -1;
          this.broadcast();
        }
      }
    }
    if (this.state === 'playing' && this.round) {
      this.round.poll(Date.now());
      if (this.round.seq !== this.lastSeq) {
        this.lastSeq = this.round.seq;
        this.broadcast();
      }
      if (this.round.phase === 'ended') {
        this.finishRound();
        this.broadcast();
      }
    } else if (this.state === 'result') {
      if (this.hasConnectedHuman(true) && Date.now() >= this.nextAt) {
        this.nextRound();
        this.broadcast();
      }
    }
  }

  // ---------- 视图 ----------
  summarize() {
    return {
      code: this.code,
      ruleSet: this.config.ruleSet,
      ruleName: this.rules.name,
      state: this.state,
      players: this.members.size,
      humans: [...this.members.values()].filter((m) => !m.bot && m.connected).length,
      occupied: this.seats.filter(Boolean).length,
      rounds: this.config.rounds,
      roundNo: this.roundNo,
      createdAt: this.createdAt,
      hostName: (this.members.get(this.hostId) || {}).name || '',
      isPublic: this.config.isPublic,
    };
  }

  snapshotFor(id) {
    const me = this.members.get(id);
    const seat = me && me.seat != null ? me.seat : -1;
    const seated = this.seats.map((sid) => {
      if (!sid) return null;
      const p = this.members.get(sid);
      return {
        name: p ? p.name : '?',
        bot: p ? !!p.bot : true,
        connected: p ? p.connected : false,
        ready: p ? p.ready : false,
        isHost: sid === this.hostId,
        vip: !!p?.features?.vip,
        canSwapDraw: !!p?.features?.canSwapDraw,
      };
    });
    return {
      code: this.code,
      state: this.state,
      config: this.config,
      rules: {
        id: this.rules.id, name: this.rules.name, tagline: this.rules.tagline,
        description: this.rules.description,
        allowChi: this.rules.allowChi, allowMultiHu: this.rules.allowMultiHu,
        allowDiscardAfterTing: this.rules.allowDiscardAfterTing,
        requireTing: this.rules.win.requireTing, bao: !!this.rules.bao?.enabled,
        cap: this.rules.scoring.cap,
        ruleOptions: { ...this.rules.ruleOptions },
      },
      seats: seated,
      mySeat: seat,
      myReady: me ? me.ready : false,
      isHost: id === this.hostId,
      myFeatures: { ...(me?.features || {}) },
      canDissolve: id === this.hostId || !!me?.features?.canDissolveRooms,
      roundNo: this.roundNo,
      totalRounds: this.totalRounds,
      dealer: this.dealer,
      scores: this.scores,
      game: this.round ? this.round.snapshot(seat) : null,
      result: this.result,
      chat: this.chat.slice(-30).map(({ name, text, at }) => ({ name, text, at })),
      spectators: Array.from(this.members.values()).filter((m) => m.seat == null).length,
      nextAt: this.nextAt || 0,
      serverNow: Date.now(),
    };
  }

  broadcast() {
    if (!this.io) return;
    for (const p of this.members.values()) {
      if (!p.socketId) continue;
      const socket = this.io.sockets.sockets.get(p.socketId);
      if (!socket?.connected || socket.data.clientId !== p.id) continue;
      socket.emit('room:state', this.snapshotFor(p.id));
    }
  }
}

export class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
    this.timer = setInterval(() => this.tick(), 250);
    this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
    this.timer.unref();
    this.cleanupTimer.unref();
  }

  dispose() {
    clearInterval(this.timer);
    clearInterval(this.cleanupTimer);
  }

  create(hostId, config) {
    let code;
    do { code = randomCode(); } while (this.rooms.has(code));
    const room = new Room(code, hostId, config);
    room.io = this.io;
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code || '').toUpperCase());
  }

  list() {
    return Array.from(this.rooms.values())
      .filter((r) => r.config.isPublic && r.members.size > 0)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 30)
      .map((r) => r.summarize());
  }

  listAll(limit = 200) {
    return Array.from(this.rooms.values())
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, limit)
      .map((room) => ({ ...room.summarize(), hostId: room.hostId }));
  }

  destroy(code, reason = '房间已解散') {
    const room = this.get(code);
    if (!room) return false;
    room.close(reason);
    for (const p of room.members.values()) {
      const socket = p.socketId ? this.io.sockets.sockets.get(p.socketId) : null;
      if (socket?.connected && socket.data.clientId === p.id) {
        socket.data.joinedRoom = null;
        socket.emit('room:closed', { code: room.code, reason });
      }
    }
    this.rooms.delete(room.code);
    return true;
  }

  refreshUser(id, user) {
    if (!user) return;
    for (const room of this.rooms.values()) {
      const member = room.members.get(id);
      if (!member) continue;
      member.features = { ...user.features };
      const player = member.seat != null ? room.round?.players[member.seat] : null;
      if (player) player.canSwapDraw = !!user.features.canSwapDraw;
      if (player && !player.canSwapDraw) player.drawSwapOpen = false;
      room.broadcast();
    }
  }

  tick() {
    for (const room of this.rooms.values()) {
      room.tick();
      if (room.state === 'closed') this.destroy(room.code, room.closeReason);
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const humans = [...room.members.values()].filter((m) => !m.bot && m.connected);
      if (humans.length === 0 && now - room.lastActivity > 10 * 60 * 1000) {
        this.destroy(code, '房间长时间无人，已自动清理');
      }
    }
  }

  findRoomOf(id) {
    for (const room of this.rooms.values()) if (room.members.has(id)) return room;
    return null;
  }
}

export { getPresets };
