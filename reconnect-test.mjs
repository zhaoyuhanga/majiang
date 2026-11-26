// 断线重连测试
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const LOG = 'D:\\awork\\majiang\\reconnect.log';
fs.writeFileSync(LOG, '');
const log = (...a) => fs.appendFileSync(LOG, a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:3001';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#createBtn');
await page.type('#nickname', 'Reconnect');
await page.evaluate(() => document.querySelector('#createBtn').click());
await page.waitForSelector('#waitOverlay:not(.hidden)', { timeout: 8000 });
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => document.querySelector('#waitSeats [data-bot]')?.click());
  await new Promise((r) => setTimeout(r, 300));
}
await page.evaluate(() => document.querySelector('#startBtn').click());
await new Promise((r) => setTimeout(r, 2500));
const before = await page.evaluate(() => ({ code: window.__snap.code, seat: window.__snap.mySeat, hand: window.__snap.game.myHand.length, phase: window.__snap.game.phase, turn: window.__snap.game.turn }));
log('before reload', before);
const cid1 = await page.evaluate(() => localStorage.getItem('mj_cid'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__snap, { timeout: 10000 });
await new Promise((r) => setTimeout(r, 1200));
const after = await page.evaluate(() => ({ code: window.__snap.code, seat: window.__snap.mySeat, hand: window.__snap.game?.myHand?.length, phase: window.__snap.game?.phase, turn: window.__snap.game?.turn, state: window.__snap.state, bot: window.__snap.game?.players?.[window.__snap.mySeat]?.bot, connected: window.__snap.game?.players?.[window.__snap.mySeat]?.connected }));
const cid2 = await page.evaluate(() => localStorage.getItem('mj_cid'));
log('after reload', after, 'cid same:', cid1 === cid2);
await page.screenshot({ path: 'shot-reconnect.png' });
log('errors', errs);
await browser.close();
