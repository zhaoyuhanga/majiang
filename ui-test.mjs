import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:3012';
const ADMIN_TOKEN = 'ui-admin-secret';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'majiang-ui-'));
let server;

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(BASE + '/healthz');
      if (res.ok) return;
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('测试服务器启动超时');
}

if (!process.env.BASE) {
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: '3012', MAJIANG_DATA_DIR: dataDir, ADMIN_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (data) => process.stdout.write(data));
  server.stderr.on('data', (data) => process.stderr.write(data));
}

await waitForServer();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  assert.equal(await page.$$eval('#tileSprite symbol', (nodes) => nodes.length), 42);
  assert.equal(await page.$$eval('#tileSprite image', (nodes) => nodes.length), 42);
  const tileCodes = [
    ...Array.from({ length: 9 }, (_, index) => 11 + index),
    ...Array.from({ length: 9 }, (_, index) => 21 + index),
    ...Array.from({ length: 9 }, (_, index) => 31 + index),
    ...Array.from({ length: 7 }, (_, index) => 41 + index),
    ...Array.from({ length: 8 }, (_, index) => 51 + index),
  ];
  const tileHrefs = await page.$$eval('#tileSprite image', (nodes) => nodes.map((node) => node.getAttribute('href')));
  assert.deepEqual(tileHrefs, tileCodes.map((tile) => `/images/tiles/${tile}.png?v=1.6.0`));
  assert.ok(await page.$$eval('#tileSprite image', (nodes) => nodes.every((node) => node.getAttribute('width') === '48' && node.getAttribute('height') === '64')));
  const assetStatus = await page.evaluate(async () => Promise.all(
    [...document.querySelectorAll('#tileSprite image')].map(async (node) => {
      const response = await fetch(node.getAttribute('href'));
      return { ok: response.ok, cacheControl: response.headers.get('cache-control') };
    })
  ));
  assert.ok(assetStatus.every((asset) => asset.ok), '完整麻将牌面加载失败');
  assert.ok(assetStatus.every((asset) => asset.cacheControl === 'public, max-age=31536000, immutable'), '牌图长效缓存未生效');
  const decoded = await page.evaluate(async () => Promise.all(
    [...document.querySelectorAll('#tileSprite image')].map(async (node) => {
      const image = new Image();
      image.src = node.getAttribute('href');
      await image.decode();
      return image.naturalWidth === 300 && image.naturalHeight === 420;
    })
  ));
  assert.ok(decoded.every(Boolean), '麻将牌面尺寸不正确');
  const gallery = await page.evaluateHandle((codes) => {
    const element = document.createElement('div');
    element.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#12382f;padding:28px;display:grid;grid-template-columns:repeat(9,72px);gap:10px;align-content:center;justify-content:center';
    element.innerHTML = codes.map((tile) => `<div class="tile" style="--tile-w:64px;--tile-h:90px"><svg class="tile-face" viewBox="0 0 48 64"><use href="#tile-${tile}"></use></svg></div>`).join('');
    document.body.appendChild(element);
    return element;
  }, tileCodes);
  await gallery.screenshot({ path: 'shot-ui-tile-gallery.png' });
  await gallery.evaluate((element) => element.remove());

  assert.equal((await page.$eval('#adminBtn', (node) => node.textContent)).trim(), 'v1.6.0');
  assert.equal(await page.$eval('#adminBtn', (node) => node.textContent.includes('管理')), false);
  if (!process.env.BASE) {
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await page.type('#adminPassword', ADMIN_TOKEN);
    await page.click('[data-login]');
    await page.waitForSelector('#adminPanel', { timeout: 5000 });
    assert.equal(await page.$$eval('#adminPanel [data-user-row]', (nodes) => nodes.length), 1);
    await page.click('#adminPanel input[data-feature="vip"]');
    await page.waitForFunction(() => document.querySelector('#adminPanel input[data-feature="vip"]')?.checked);
    await page.evaluate(() => document.querySelector('#adminPanel input[data-feature="canSwapDraw"]').click());
    await page.waitForFunction(() => [...document.querySelectorAll('#adminPanel input[data-feature="vip"], #adminPanel input[data-feature="canSwapDraw"]')].every((input) => input.disabled || input.checked));
    await page.evaluate(() => document.querySelector('#adminPanel [data-logout]').click());
    await page.waitForFunction(() => !document.querySelector('#adminPanel'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await page.waitForSelector('#adminPassword', { timeout: 2000 });
    await page.click('[data-close]');
  }

  await page.type('#nickname', '交互测试');
  await page.click('#optBots');
  await page.click('#createBtn');
  await page.waitForSelector('.rule-builder', { timeout: 5000 });
  assert.equal(await page.$eval('[data-config="autoFillBots"]', (node) => node.checked), false);
  await page.click('[data-config="autoFillBots"]');
  assert.equal(await page.$eval('[data-builder-rule="harbin"]', (node) => node.getAttribute('aria-pressed')), 'true');
  assert.ok(await page.$$eval('.rb-option input:disabled', (nodes) => nodes.length) > 0);
  assert.equal(await page.$$eval('.rb-number-picker button:disabled', (nodes) => nodes.length), 2);
  await page.select('[data-setting="turnSeconds"]', '12');
  await page.click('[data-builder-rule="harbin"]');
  assert.equal(await page.$$eval('[data-setting="scene"] option', (nodes) => nodes.length), 3);
  await page.select('[data-setting="scene"]', 'high');
  await page.click('[data-builder-rule="shuangyashan"]');
  assert.equal(await page.$eval('[data-builder-rule="shuangyashan"]', (node) => node.getAttribute('aria-pressed')), 'true');
  assert.equal(await page.$('[data-setting="scene"]'), null);
  await page.click('[data-rule-key="shouBaYiSwap"]');
  await page.screenshot({ path: 'shot-ui-rule-builder.png' });
  await page.click('[data-builder-save]');
  await page.waitForSelector('#waitOverlay:not(.hidden)', { timeout: 8000 });
  assert.equal(await page.evaluate(() => window.__snap.config.ruleSet), 'shuangyashan');
  assert.equal(await page.evaluate(() => window.__snap.config.turnSeconds), 12);
  assert.equal(await page.evaluate(() => window.__snap.config.ruleOptions.shouBaYiSwap), true);

  await page.click('#roomSettingsBtn');
  await page.waitForSelector('.rule-builder', { timeout: 5000 });
  await page.click('[data-rule-key="dianpaoBaoSanjia"]');
  await page.select('[data-setting="turnSeconds"]', '20');
  await page.click('[data-builder-save]');
  await page.waitForFunction(() => window.__snap?.config.turnSeconds === 20 && window.__snap.config.ruleOptions.dianpaoBaoSanjia === false);
  await page.click('#rulesBtn');
  await page.waitForSelector('.modal[aria-label="麻将规则"]');
  const roomRuleText = await page.$eval('.modal[aria-label="麻将规则"]', (node) => node.textContent);
  assert.ok(roomRuleText.includes('手把一可换牌'));
  assert.equal(roomRuleText.includes('点炮包三家'), false);
  await page.click('.modal[aria-label="麻将规则"] [data-close]');

  await page.click('#roomSettingsBtn');
  await page.waitForSelector('.rule-builder');
  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }, { width: 844, height: 390 }]) {
    await page.setViewport(viewport);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const metrics = await page.evaluate(() => {
      const builder = document.querySelector('.rule-builder').getBoundingClientRect();
      const footer = document.querySelector('.rb-footer').getBoundingClientRect();
      return {
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        builderRight: builder.right,
        builderBottom: builder.bottom,
        footerBottom: footer.bottom,
      };
    });
    assert.ok(metrics.scrollWidth <= metrics.width + 1, `规则面板横向溢出: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.builderRight <= metrics.width + 1 && metrics.builderBottom <= metrics.height + 1, `规则面板被裁切: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.footerBottom <= metrics.height + 1, `规则操作栏不可见: ${JSON.stringify(metrics)}`);
    if (viewport.width === 390) await page.screenshot({ path: 'shot-ui-rule-builder-mobile.png' });
    if (viewport.width === 844) await page.screenshot({ path: 'shot-ui-rule-builder-landscape.png' });
  }
  await page.setViewport({ width: 1440, height: 900 });
  await page.click('[data-builder-close]');

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => document.querySelector('#waitSeats [data-bot]')?.click());
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await page.waitForFunction(() => window.__snap.seats.filter(Boolean).length === 4);
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__snap?.state === 'playing', { timeout: 8000 });
  if (!process.env.BASE) {
    assert.equal(await page.evaluate(() => window.__snap.myFeatures.vip), true);
    assert.equal(await page.evaluate(() => window.__snap.myFeatures.canSwapDraw), true);
  }

  if (!process.env.BASE) {
    await page.waitForFunction(() => window.__snap?.game?.options?.canSwapDraw && !window.__snap.game.options.drawSwapUsed, { timeout: 45000 });
    await page.evaluate(() => document.querySelector('#wallInfo').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await page.waitForSelector('#drawSwapModal', { timeout: 5000 });
    const swapInfo = await page.evaluate(() => ({
      drawn: window.__snap.game.players[window.__snap.mySeat].drawn,
      choices: [...document.querySelectorAll('[data-swap-tile]')].map((node) => Number(node.dataset.swapTile)),
    }));
    assert.ok(swapInfo.choices.length > 0);
    assert.ok(swapInfo.choices.some((tile) => tile !== swapInfo.drawn));
    await page.screenshot({ path: 'shot-ui-draw-swap.png' });
    const replacement = swapInfo.choices.find((tile) => tile !== swapInfo.drawn);
    await page.evaluate((tile) => document.querySelector(`[data-swap-tile="${tile}"]`).click(), replacement);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await page.waitForFunction(() => window.__snap?.game?.options?.drawSwapUsed === true);
    assert.equal(await page.evaluate(() => window.__snap.game.players[window.__snap.mySeat].drawn), replacement);
    assert.equal(await page.evaluate(() => !!document.querySelector('#drawSwapModal')), false);
  }

  let chosen = null;
  for (let i = 0; i < 120; i++) {
    const info = await page.evaluate(() => {
      const snap = window.__snap;
      const options = snap?.game?.options;
      if (!snap || snap.state !== 'playing') return {};
      if (options?.phase === 'claim') return { pass: true };
      if (options?.phase !== 'discard') return {};
      const counts = new Map();
      for (const node of document.querySelectorAll('#handArea .tile.clickable')) {
        const tile = Number(node.dataset.tile);
        counts.set(tile, (counts.get(tile) || 0) + 1);
      }
      const duplicate = [...counts.entries()].find(([, count]) => count > 1)?.[0];
      return { tile: duplicate ?? options.discards?.[0], before: snap.game.players[snap.mySeat].discards.length };
    });
    if (info.pass) {
      await page.evaluate(() => document.querySelector('#actionBar [data-act="pass"]')?.click());
    } else if (info.tile != null) {
      chosen = info;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(chosen, '未能进入自己的出牌回合');

  await page.evaluate((tile) => {
    document.querySelector(`#handArea .tile.clickable[data-tile="${tile}"]`)?.click();
  }, chosen.tile);
  assert.equal(await page.$$eval('#handArea .tile.selected', (nodes) => nodes.length), 1);
  assert.equal(await page.$eval('#discardBtn', (button) => button.disabled), false);
  await page.screenshot({ path: 'shot-selected.png' });

  await page.click('#handArea .tile.selected');
  await page.waitForFunction((before) => {
    const snap = window.__snap;
    return snap.game.players[snap.mySeat].discards.length > before;
  }, {}, chosen.before);

  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }, { width: 844, height: 390 }]) {
    await page.setViewport(viewport);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const metrics = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll('#handArea .tile')];
      const last = tiles.at(-1)?.getBoundingClientRect();
      return {
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        lastRight: last?.right ?? 0,
        selected: document.querySelectorAll('#handArea .tile.selected').length,
      };
    });
    assert.ok(metrics.scrollWidth <= metrics.width + 1, `横向溢出: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.lastRight <= metrics.width + 1, `手牌被裁切: ${JSON.stringify(metrics)}`);
    assert.equal(metrics.selected, 0);
    if (viewport.width === 390) await page.screenshot({ path: 'shot-mobile-upgraded.png' });
  }

  await page.setViewport({ width: 1440, height: 900 });
  assert.equal(await page.$eval('#homeBtn', (button) => button.textContent.trim()), '退出');
  await page.click('#homeBtn');
  await page.waitForSelector('.modal-mask [aria-label="退出房间"]');
  await page.click('[data-leave]');
  await new Promise((resolve) => setTimeout(resolve, 800));
  await page.screenshot({ path: 'shot-ui-after-leave.png' });
  await page.waitForFunction(() => !document.querySelector('#home').classList.contains('hidden') && document.querySelector('#room').classList.contains('hidden'), { timeout: 5000 });
  const stateAfterExit = await page.evaluate(() => ({
    code: window.__snap?.code ?? '',
    mySeat: window.__snap?.mySeat ?? -1,
    state: window.__snap?.state ?? 'lobby',
  }));
  assert.equal(stateAfterExit.state, 'lobby');
  assert.equal(stateAfterExit.mySeat, -1);
  assert.ok(stateAfterExit.code === '' || stateAfterExit.code == null);

  assert.deepEqual(errors, []);
  console.log('UI 冒烟测试通过：牌面、用户权限、房间设置、单张选中、再次点击出牌、移动端布局、退出房间');
} finally {
  await browser.close();
  server?.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
}
