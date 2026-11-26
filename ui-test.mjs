// UI 冒烟测试：用真实浏览器创建房间 → 加人机 → 开局 → 打几手 → 截图
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:3001';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));

await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
await page.type('#nickname', '测试玩家');
await page.screenshot({ path: 'shot-lobby2.png' });

// 找出那个白色方块是什么
const probe = await page.evaluate(() => {
  const el = document.elementFromPoint(820, 668);
  return el ? `${el.tagName}.${el.className} id=${el.id}` : 'none';
});
console.log('probe at (820,668):', probe);

await page.click('#createBtn');
await page.waitForSelector('#waitOverlay:not(.hidden)', { timeout: 8000 });
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: 'shot-wait.png' });

// 加满 3 个人机
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => {
    const btn = document.querySelector('#room .wait-card #waitSeats [data-bot]');
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 350));
}
await page.screenshot({ path: 'shot-wait-full.png' });

await page.click('#startBtn');
await page.waitForFunction(() => !document.querySelector('#waitOverlay') || document.querySelector('#waitOverlay').classList.contains('hidden'), { timeout: 8000 });
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: 'shot-table.png' });

// 等待轮到自己，选一张牌打出
for (let i = 0; i < 40; i++) {
  const canAct = await page.evaluate(() => {
    const o = window.__snap?.game?.options;
    return !!(o && o.phase === 'discard' && o.discards?.length);
  });
  if (canAct) break;
  await new Promise((r) => setTimeout(r, 500));
}
const hand = await page.evaluate(() => {
  const el = document.querySelector('#handArea .tile.clickable');
  if (el) el.click();
  return document.querySelectorAll('#handArea .tile').length;
});
console.log('hand tiles:', hand);
await new Promise((r) => setTimeout(r, 400));
const discardBtn = await page.$('#discardBtn');
if (discardBtn) await discardBtn.click();
await new Promise((r) => setTimeout(r, 1800));
await page.screenshot({ path: 'shot-table2.png' });

const state = await page.evaluate(() => {
  const s = window.__snap;
  return s ? { state: s.state, phase: s.game?.phase, turn: s.game?.turn, wall: s.game?.wall, mySeat: s.mySeat } : null;
});
console.log('state:', JSON.stringify(state));
console.log('logs:', logs.slice(-12).join('\n'));
await browser.close();
