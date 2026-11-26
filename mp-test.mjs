// 双人联机 + 移动端布局检查（独立浏览器上下文，避免共享 localStorage）
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const LOG = 'D:\\awork\\majiang\\mp-test.log';
fs.writeFileSync(LOG, '');
const log = (...a) => fs.appendFileSync(LOG, a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:3001';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });

const ctxA = await browser.createBrowserContext();
const A = await ctxA.newPage();
await A.setViewport({ width: 1280, height: 800 });
const ctxB = await browser.createBrowserContext();
const B = await ctxB.newPage();
await B.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const errs = [];
B.on('pageerror', (e) => { errs.push('B:' + e.message); log('B pageerror', e.message); });
A.on('pageerror', (e) => { errs.push('A:' + e.message); log('A pageerror', e.message); });

await A.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 15000 });
await A.waitForSelector('#createBtn', { timeout: 5000 });
await A.type('#nickname', 'HostA');
await A.evaluate(() => document.querySelector('#createBtn').click());
await A.waitForSelector('#waitOverlay:not(.hidden)', { timeout: 8000 });
const code = await A.evaluate(() => window.__snap.code);
log('room', code);

await B.goto(`${BASE}/?r=${code}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
await B.waitForFunction(() => !!window.__snap, { timeout: 10000 });
await new Promise((r) => setTimeout(r, 500));
const bSat = await B.evaluate(() => {
  const btn = document.querySelector('#waitSeats [data-sit]');
  if (btn) { btn.click(); return true; }
  return false;
});
log('B sat', bSat);
await new Promise((r) => setTimeout(r, 800));
for (let i = 0; i < 2; i++) {
  await A.evaluate(() => document.querySelector('#waitSeats [data-bot]')?.click());
  await new Promise((r) => setTimeout(r, 350));
}
log('bots', await A.evaluate(() => window.__snap.seats.map((s) => s && s.name)));
await A.screenshot({ path: 'shot-mp-wait.png' });
await A.evaluate(() => document.querySelector('#startBtn').click());
await new Promise((r) => setTimeout(r, 2500));
await A.screenshot({ path: 'shot-mp-desktop.png' });
await B.screenshot({ path: 'shot-mobile-table.png' });
const bState = await B.evaluate(() => ({ seat: window.__snap.mySeat, state: window.__snap.state, hand: window.__snap.game?.myHand?.length, name: window.__snap.seats[window.__snap.mySeat]?.name }));
log('B state', bState);

await B.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await new Promise((r) => setTimeout(r, 900));
await B.screenshot({ path: 'shot-mobile-landscape.png' });
log('done errs', errs);
await browser.close();
