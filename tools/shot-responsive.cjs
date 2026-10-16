/* shot-responsive.cjs — 桌面/移动双宽度截图，检查响应式适配 */
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const playwright = require(path.join('C:', 'Users', 'laogao', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright'));
const ROOT = 'E:/GitHub/photo';
const OUT = 'E:/tmp/ui-shots';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = spawn(process.execPath, [ROOT + '/tools/server.js'], { env: Object.assign({}, process.env, { PORT: '8451' }) });
  await sleep(800);
  const browser = await playwright.chromium.launch({ executablePath: 'C:\\Users\\laogao\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe' });

  // 桌面端 1400×900
  const desktop = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await desktop.goto('http://localhost:8451/');
  await sleep(400);
  await desktop.screenshot({ path: OUT + '/desktop-home.png' });
  await desktop.click('#home-photo');
  await desktop.click('#photo-open-idphoto'); // 进入「证照生成」子功能
  await sleep(300);
  await desktop.screenshot({ path: OUT + '/desktop-upload.png' });
  // 检查横向滚动
  const dScroll = await desktop.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  console.log('desktop horizontal scroll:', dScroll);
  await desktop.close();

  // 移动端 390×844
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto('http://localhost:8451/');
  await sleep(400);
  await mobile.screenshot({ path: OUT + '/mobile-home.png', fullPage: true });
  await mobile.click('#home-photo');
  await mobile.click('#photo-open-idphoto'); // 进入「证照生成」子功能
  await sleep(300);
  await mobile.screenshot({ path: OUT + '/mobile-upload.png' });
  const mScroll = await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  console.log('mobile horizontal scroll:', mScroll);
  // 排版模块小屏
  await mobile.click('.module-tab[data-module="sheet"]');
  await sleep(300);
  await mobile.screenshot({ path: OUT + '/mobile-sheet.png' });
  const mScroll2 = await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  console.log('mobile sheet horizontal scroll:', mScroll2);
  await mobile.close();

  await browser.close();
  server.kill();
  console.log('shots saved to ' + OUT);
})().catch(e => { console.error('ERR', e.message); process.exit(2); });
