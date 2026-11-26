// 完整对局 UI 测试：创建双鸭山房间，自动打完一局，检查结算与下一局
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:3001';
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
await page.type('#nickname', '测试玩家');
// 选择双鸭山
await page.evaluate(() => { document.querySelector('[data-rule="shuangyashan"]').click(); });
await page.click('#createBtn');
await page.waitForSelector('#waitOverlay:not(.hidden)', { timeout: 8000 });
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => document.querySelector('#waitSeats [data-bot]')?.click());
  await new Promise((r) => setTimeout(r, 300));
}
await page.click('#startBtn');
await new Promise((r) => setTimeout(r, 1500));

const t0 = Date.now();
let acted = 0;
while (Date.now() - t0 < 150000) {
  const info = await page.evaluate(() => {
    const s = window.__snap;
    if (!s) return { state: 'none' };
    if (s.state === 'result' || s.state === 'finished') return { state: s.state };
    const o = s.game?.options;
    if (!o) return { state: s.state, phase: s.game?.phase };
    if (o.phase === 'discard') {
      if (o.hu) return { state: s.state, act: 'hu' };
      const tile = o.discards?.[0];
      if (tile != null) return { state: s.state, act: 'discard', tile };
      return { state: s.state, act: 'wait' };
    }
    if (o.phase === 'claim') return { state: s.state, act: 'pass' };
    return { state: s.state, phase: s.game?.phase };
  });
  if (info.state === 'result' || info.state === 'finished') break;
  if (info.act === 'discard') {
    await page.evaluate((tile) => {
      const el = document.querySelector(`#handArea .tile.clickable[data-tile="${tile}"]`);
      if (el) el.click();
      document.querySelector('#discardBtn')?.click();
    }, info.tile);
    acted++;
  } else if (info.act === 'pass') {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('#actionBar button')].find((x) => x.textContent.trim() === '过');
      b?.click();
    });
    acted++;
  } else if (info.act === 'hu') {
    await page.evaluate(() => [...document.querySelectorAll('#actionBar button')].find((x) => x.textContent.includes('胡'))?.click());
    acted++;
  }
  await new Promise((r) => setTimeout(r, 350));
}

const st = await page.evaluate(() => ({
  state: window.__snap?.state,
  result: window.__snap?.result?.type,
  winners: window.__snap?.result?.winners?.map((w) => `${w.name}:${w.label}:${w.fan ?? w.total}`),
  roundNo: window.__snap?.roundNo,
  ended: window.__snap?.game?.phase,
}));
console.log('acted:', acted, 'state:', JSON.stringify(st));
await page.screenshot({ path: 'shot-result.png' });
console.log('errors:', errors.slice(0, 5));
await browser.close();
