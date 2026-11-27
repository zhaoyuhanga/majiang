import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = process.env.MAJIANG_DATA_DIR || path.dirname(fileURLToPath(new URL('../data/users.json', import.meta.url)));
const MAX_USERS = 10000;

export const PERMISSION_DEFINITIONS = [
  { key: 'canCreateRooms', label: '创建房间', value: true },
  { key: 'canUseBots', label: '添加人机', value: true },
  { key: 'canDissolveRooms', label: '解散房间', value: false },
  { key: 'vip', label: 'VIP 标识', value: false },
  { key: 'canSwapDraw', label: '摸牌换牌标识', value: false },
  { key: 'admin', label: '管理员', value: false },
];

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function defaultFeatures() {
  return Object.fromEntries(PERMISSION_DEFINITIONS.map((p) => [p.key, p.value]));
}

export class UserStore {
  constructor({
    filePath = path.join(DEFAULT_DIR, 'users.json'),
    secretPath = path.join(DEFAULT_DIR, 'admin-secret.txt'),
    adminToken = process.env.ADMIN_TOKEN || '',
  } = {}) {
    this.filePath = filePath;
    this.secretPath = secretPath;
    this.users = new Map();
    this.connections = new Map();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const [id, user] of Object.entries(saved)) {
        this.users.set(id, {
          ...user,
          features: { ...defaultFeatures(), ...(user.features || {}) },
        });
      }
    }
    this.adminToken = adminToken || (fs.existsSync(secretPath) ? fs.readFileSync(secretPath, 'utf8').trim() : '');
  }

  get(id) {
    return this.users.get(id) || null;
  }

  can(id, key) {
    const user = this.get(id);
    return !!user?.features?.[key];
  }

  register(id, token, name) {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(String(token || ''))) throw new Error('身份凭证无效，请刷新页面');
    let user = this.users.get(id);
    const hash = tokenHash(token);
    if (user && user.tokenHash !== hash) {
      const error = new Error('浏览器身份与服务器记录不一致');
      error.code = 'IDENTITY_MISMATCH';
      throw error;
    }
    if (!user) {
      if (this.users.size >= MAX_USERS) throw new Error('用户数量已达上限，请稍后再试');
      user = {
        id,
        name: String(name || '玩家').slice(0, 12),
        features: defaultFeatures(),
        tokenHash: hash,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
      };
      this.users.set(id, user);
      this.save();
    } else if (name && user.name !== String(name).slice(0, 12)) {
      user.name = String(name).slice(0, 12);
      this.save();
    }
    user.lastSeenAt = Date.now();
    return user;
  }

  connected(id) {
    this.connections.set(id, (this.connections.get(id) || 0) + 1);
  }

  disconnected(id) {
    const count = (this.connections.get(id) || 0) - 1;
    if (count > 0) this.connections.set(id, count);
    else this.connections.delete(id);
  }

  verifyAdmin(token) {
    if (!this.adminToken || !token) return false;
    const a = crypto.createHash('sha256').update(String(token)).digest();
    const b = crypto.createHash('sha256').update(this.adminToken).digest();
    return crypto.timingSafeEqual(a, b);
  }

  list(limit = 500) {
    return [...this.users.values()]
      .sort((a, b) => Number(this.connections.has(b.id)) - Number(this.connections.has(a.id)) || b.lastSeenAt - a.lastSeenAt)
      .slice(0, limit)
      .map((user) => ({
        id: user.id,
        name: user.name,
        features: { ...user.features },
        online: this.connections.has(user.id),
        createdAt: user.createdAt,
        lastSeenAt: user.lastSeenAt,
      }));
  }

  updateFeatures(id, changes, actorId) {
    const user = this.users.get(id);
    if (!user) throw new Error('用户不存在');
    const next = {};
    for (const { key } of PERMISSION_DEFINITIONS) {
      if (Object.hasOwn(changes, key)) {
        if (typeof changes[key] !== 'boolean') throw new Error('权限值无效');
        next[key] = changes[key];
      }
    }
    if (actorId === id && next.admin === false) throw new Error('不能取消自己的管理员权限');
    user.features = { ...user.features, ...next };
    this.save();
    return user;
  }

  save() {
    const data = Object.fromEntries([...this.users.values()].map((user) => [user.id, {
      name: user.name,
      features: user.features,
      tokenHash: user.tokenHash,
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt,
    }]));
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }
}
