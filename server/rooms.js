// 房间与对局生命周期管理
import { Round } from './game.js';
import { buildRoomRules, getPresets } from './rules.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_CHAT = 40;

function randomCode(n = 5) {
  let s = '';
  for (let i = 0; i < n; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12) || '玩家';
}

export function normalizeConfig(input = {}) {
  const cfg = {
    ruleSet: ['harbin', 'shuangyashan'].includes(input.ruleSet) ? input.ruleSet : 'harbin',
    rounds: Math.max(1, Math.min(32, Number(input.rounds) || 8)),
    baseScore: Math.max(1, Math.min(10, Number(input.baseScore) || 1)),
    turnSeconds: Math.max(8, Math.min(60, Number(input.turnSeconds) || 20)),
    claimSeconds: Math.max(5, Math.min(30, Number(input.claimSeconds) || 12)),
    cap: input.cap != null ? Math.max(8, Math.min(256, Number(input.cap) || 64)) : undefined,
    allowChi: input.allowChi !== false,
    allowMultiHu: !!input.allowMultiHu,
    autoFillBots: input.autoFillBots !== false,
    isPublic: input.isPublic !== false,
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
      return p;
    }
    const isHost = id === this.hostId;
    p = {
      id, name: cleanName(name), socketId: socket.id, seat: null,
      connected: true, ready: false, bot: false, isHost,
      joinedAt: Date.now(), lastSeen: Date.now(),
    };
    this.members.set(id, p);
    this.spectators.add(id);
    return p;
  }

  removeMember(id) {
    const p = this.members.get(id);
    if (!p) return;
    if (p.seat != null) {
      if (this.state === 'playing' || this.state === 'result') {
        // 对局中离开：座位保留，转为托管人机
        p.connected = false;
        p.bot = true;
        if (!p.name.endsWith('(托管)')) p.name += '(托管)';
        if (this.round) {
          const rp = this.round.players[p.seat];
          rp.connected = false;
          rp.bot = true;
        }
        if (p.isHost) {
          const next = Array.from(this.members.values()).find((m) => !m.bot && m.id !== id);
          if (next) { next.isHost = true; this.hostId = next.id; }
        }
        this.lastActivity = Date.now();
        return;
      }
      this.seats[p.seat] = null;
      if (this.round) {
        const rp = this.round.players[p.seat];
        rp.connected = false;
        rp.bot = true;
      }
    }
    this.members.delete(id);
    this.spectators.delete(id);
    if (p.isHost) {
      const next = Array.from(this.members.values()).find((m) => !m.bot);
      if (next) { next.isHost = true; this.hostId = next.id; }
      else this.hostId = null;
    }
    this.lastActivity = Date.now();
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
    this.lastActivity = Date.now();
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
    this.config = normalizeConfig({ ...this.config, ...cfg });
    this.rules = buildRoomRules({ ...this.config, options: this.config });
    this.totalRounds = this.rules.__config.rounds;
  }

  // ---------- 对局 ----------
  canStart() {
    return this.state === 'waiting' && this.seats.every((s) => s);
  }

  startGame(id) {
    if (this.state !== 'waiting') throw new Error('当前不能开始');
    const host = this.members.get(this.hostId);
    if (id && id !== this.hostId && host && host.connected) throw new Error('只有房主可以开始游戏');
    const seatIds = this.seats.slice();
    if (this.config.autoFillBots) {
      for (let i = 0; i < 4; i++) if (!seatIds[i]) { this.addBot(i); seatIds[i] = this.seats[i]; }
    }
    if (!seatIds.every(Boolean)) throw new Error('人数不够，请先补满 4 个座位（可添加人机）');
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
    if (this.state === 'result') {
      this.nextAt = Math.min(this.nextAt, Date.now() + 800);
      this.autoNext = true;
    } else if (this.state === 'finished') {
      this.restart(id);
    }
  }

  nextRound() {
    if (this.state !== 'result') return;
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
    const now = Date.now();
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
      if (Date.now() >= this.nextAt) {
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
      humans: Array.from(this.members.values()).filter((m) => !m.bot).length,
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
        id: sid,
        name: p ? p.name : '?',
        bot: p ? !!p.bot : true,
        connected: p ? p.connected : false,
        ready: p ? p.ready : false,
        isHost: sid === this.hostId,
      };
    });
    return {
      code: this.code,
      state: this.state,
      hostId: this.hostId,
      config: this.config,
      rules: {
        id: this.rules.id, name: this.rules.name, tagline: this.rules.tagline,
        description: this.rules.description,
        allowChi: this.rules.allowChi, allowMultiHu: this.rules.allowMultiHu,
        requireTing: this.rules.win.requireTing, bao: !!this.rules.bao?.enabled,
        cap: this.rules.scoring.cap,
      },
      seats: seated,
      mySeat: seat,
      myReady: me ? me.ready : false,
      isHost: id === this.hostId,
      roundNo: this.roundNo,
      totalRounds: this.totalRounds,
      dealer: this.dealer,
      scores: this.scores,
      game: this.round ? this.round.snapshot(seat) : null,
      result: this.result,
      chat: this.chat.slice(-30),
      spectators: Array.from(this.members.values()).filter((m) => m.seat == null).length,
      nextAt: this.nextAt || 0,
      serverNow: Date.now(),
    };
  }

  broadcast() {
    if (!this.io) return;
    for (const p of this.members.values()) {
      if (!p.socketId) continue;
      this.io.to(p.socketId).emit('room:state', this.snapshotFor(p.id));
    }
  }
}

export class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
    this.timer = setInterval(() => this.tick(), 250);
    this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
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

  tick() {
    for (const room of this.rooms.values()) room.tick();
  }

  cleanup() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const humans = Array.from(room.members.values()).filter((m) => !m.bot && m.connected);
      if (humans.length === 0 && now - room.lastActivity > 10 * 60 * 1000) {
        this.rooms.delete(code);
      }
    }
  }

  findRoomOf(id) {
    for (const room of this.rooms.values()) if (room.members.has(id)) return room;
    return null;
  }
}

export { getPresets };
