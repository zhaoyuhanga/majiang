// 手机竖屏玩家视角截图
import puppeteer from 'puppeteer-core';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:3001';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#createBtn');
await page.type('#nickname', '小明');
await page.evaluate(() => document.querySelector('#createBtn').click());
await page.waitForSelector('#waitOverlay:not(.hidden)', { timeout: 8000 });
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => document.querySelector('#waitSeats [data-bot]')?.click());
  await new Promise((r) => setTimeout(r, 300));
}
await page.evaluate(() => document.querySelector('#startBtn').click());
const t0 = Date.now();
while (Date.now() - t0 < 15000) {
  const info = await page.evaluate(() => {
    const s = window.__snap;
    if (!s?.game || s.state !== 'playing') return {};
    const o = s.game.options;
    if (!o) return {};
    if (o.phase === 'discard') return { act: 'discard', tile: o.discards?.[0] };
    if (o.phase === 'claim') return { act: 'pass' };
    if (o.hu) return { act: 'hu' };
    return {};
  });
  if (info.act === 'discard') {
    await page.evaluate((tile) => {
      document.querySelector(`#handArea .tile.clickable[data-tile="${tile}"]`)?.click();
      document.querySelector('#discardBtn')?.click();
    }, info.tile);
  } else if (info.act === 'pass') {
    await page.evaluate(() => [...document.querySelectorAll('#actionBar button')].find((x) => x.textContent.trim() === '过')?.click());
  }
  await new Promise((r) => setTimeout(r, 450));
}
await page.screenshot({ path: 'shot-final-mobile-player.png' });
await browser.close();
