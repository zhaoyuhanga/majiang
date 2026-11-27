import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserStore } from '../server/users.js';

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majiang-users-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new UserStore({
    filePath: path.join(dir, 'users.json'),
    secretPath: path.join(dir, 'admin-secret.txt'),
    adminToken: 'admin-test-secret',
  });
}

test('用户身份：凭证校验、默认权限与持久化', (t) => {
  const store = tempStore(t);
  const token = 'a'.repeat(48);
  const user = store.register('user_12345678', token, '测试玩家');
  assert.equal(user.features.canCreateRooms, true);
  assert.equal(user.features.canUseBots, true);
  assert.equal(user.features.canDissolveRooms, false);
  assert.equal(user.features.admin, false);
  assert.throws(() => store.register('user_12345678', 'b'.repeat(48), '冒名者'), { code: 'IDENTITY_MISMATCH' });

  store.updateFeatures('user_12345678', { vip: true, canDissolveRooms: true }, 'admin_12345678');
  const reopened = new UserStore({
    filePath: store.filePath,
    secretPath: store.secretPath,
    adminToken: 'admin-test-secret',
  });
  assert.equal(reopened.get('user_12345678').features.vip, true);
  assert.equal(reopened.get('user_12345678').features.canDissolveRooms, true);
});

test('管理员：口令校验、在线计数与自我降权保护', (t) => {
  const store = tempStore(t);
  assert.equal(store.verifyAdmin('admin-test-secret'), true);
  assert.equal(store.verifyAdmin('wrong'), false);
  store.register('admin_12345678', 'c'.repeat(48), '管理员');
  store.updateFeatures('admin_12345678', { admin: true }, 'admin_12345678');
  assert.throws(() => store.updateFeatures('admin_12345678', { admin: false }, 'admin_12345678'), /不能取消自己的管理员权限/);
  store.connected('admin_12345678');
  store.connected('admin_12345678');
  assert.equal(store.list()[0].online, true);
  store.disconnected('admin_12345678');
  assert.equal(store.list()[0].online, true);
  store.disconnected('admin_12345678');
  assert.equal(store.list()[0].online, false);
});
