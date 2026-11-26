// 截取对局进行中的桌面/手机画面
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:3001';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 1440, height: 900 });
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
while (Date.now() - t0 < 22000) {
  const info = await page.evaluate(() => {
    const s = window.__snap;
    if (!s?.game) return {};
    if (s.state !== 'playing') return { state: s.state };
    const o = s.game.options;
    if (!o) return {};
    if (o.phase === 'discard') {
      if (o.hu) return { act: 'hu' };
      return { act: 'discard', tile: o.discards?.[0] };
    }
    if (o.phase === 'claim') return { act: 'pass' };
    return {};
  });
  if (info.state === 'result' || info.state === 'finished') break;
  if (info.act === 'discard') {
    await page.evaluate((tile) => {
      document.querySelector(`#handArea .tile.clickable[data-tile="${tile}"]`)?.click();
      document.querySelector('#discardBtn')?.click();
    }, info.tile);
  } else if (info.act === 'pass') {
    await page.evaluate(() => [...document.querySelectorAll('#actionBar button')].find((x) => x.textContent.trim() === '过')?.click());
  } else if (info.act === 'hu') {
    await page.evaluate(() => [...document.querySelectorAll('#actionBar button')].find((x) => x.textContent.includes('胡'))?.click());
  }
  await new Promise((r) => setTimeout(r, 400));
}
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: 'shot-final-desktop.png' });

const m = await browser.createBrowserContext();
const mp = await m.newPage();
await mp.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const code = await page.evaluate(() => window.__snap.code);
await mp.goto(`${BASE}/?r=${code}`, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3000));
await mp.screenshot({ path: 'shot-final-mobile.png' });
await browser.close();
console.log('code', code);
