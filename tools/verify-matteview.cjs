/* ============================================================
 * verify-matteview.cjs — 抠图换底自由缩放/平移 真机验证
 * 1. 加载真实照片走完整 AI 抠图流程进入换底步骤
 * 2. 滚轮锚点缩放 / 按钮 / 适应重置 / 下滚钳制
 * 3. 空格+拖动平移（画面变化、笔刷不落笔）
 * 4. 放大状态下擦除笔刷：采样点必须精确变为背景红色（坐标映射验证）
 * ============================================================ */
'use strict';
const { createChecker, sleep, resolvePhoto, launchBrowser, withServer } = require('./_lib.cjs');

const PORT = 8431;
const PHOTO = resolvePhoto();
const checker = createChecker();
const assert = checker.assert;

withServer(PORT, async (port) => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', e => console.log('  [pageerror]', e.message));

    await page.goto('http://localhost:' + port + '/');
    await page.click('#home-photo'); // 从首页进入照片模块
    await page.click('#photo-open-idphoto'); // 进入「证照生成」子功能
    await page.setInputFiles('#file-input', PHOTO);
    await page.waitForSelector('#step-matte.active', { timeout: 90000 });
    await sleep(300);

    const box = await (await page.$('#matte-view')).boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

    const label = () => page.$eval('#mv-zoom-label', el => el.textContent);
    const snap = () => page.$eval('#matte-view', c => c.toDataURL());
    const sample = (x, y) => page.evaluate(([x, y]) => {
      const c = document.getElementById('matte-view');
      const r = c.getBoundingClientRect();
      const px = Math.min(c.width - 1, Math.max(0, Math.round((x - r.left) * c.width / r.width)));
      const py = Math.min(c.height - 1, Math.max(0, Math.round((y - r.top) * c.height / r.height)));
      return Array.from(c.getContext('2d').getImageData(px, py, 1, 1).data);
    }, [x, y]);
    const isRed = (d) => d[0] === 255 && d[1] === 0 && d[2] === 0 && d[3] === 255;

    /* 1. 初始状态（留基准快照，供适应复位比对） */
    assert((await label()) === '100%', '初始缩放 100%');
    const baseSnap = await snap();

    /* 2. 滚轮放大（锚点=中心） */
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -240);
    await sleep(200);
    const z1 = await label();
    assert(z1 !== '100%' && parseInt(z1) > 100, '滚轮放大生效（' + z1 + '）');

    /* 3. 下滚钳制到 100% */
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 240); await sleep(60); }
    await sleep(150);
    assert((await label()) === '100%', '缩小钳制到 100%');

    /* 4. 工具栏按钮 */
    await page.click('#mv-zoom-in'); await sleep(150);
    assert((await label()) === '125%', '放大按钮 → 125%');
    await page.click('#mv-zoom-out'); await sleep(150);
    assert((await label()) === '100%', '缩小按钮 → 100%');

    /* 5. 放大到约 3 倍做平移与笔刷测试 */
    for (let i = 0; i < 5; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -240); await sleep(60); }
    await sleep(200);
    const zoomedLabel = await label();
    assert(parseInt(zoomedLabel) > 150, '已放大到 ' + zoomedLabel);

    /* 6. 空格 + 拖动平移：画面变化，松开后恢复笔刷模式 */
    const beforePan = await snap();
    await page.keyboard.down('Space');
    await sleep(100);
    assert(await page.$eval('#matte-view', c => c.classList.contains('panning')), '空格进入平移模式（cursor 类）');
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 140, cy + 90, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Space');
    await sleep(250);
    assert((await snap()) !== beforePan, '平移后画面内容变化');
    assert((await label()) === zoomedLabel, '平移不改变缩放比例');
    assert(!(await page.$eval('#matte-view', c => c.classList.contains('panning'))), '松开空格退出平移模式');

    /* 7. 适应按钮：视图完整复位（与初始基准渲染逐像素一致） */
    await page.click('#mv-zoom-fit');
    await sleep(250);
    assert((await label()) === '100%', '适应按钮恢复 100%');
    assert((await snap()) === baseSnap, '适应后渲染与初始基准完全一致');

    /* 8. 放大状态擦除笔刷：采样点必须精确变红（验证显示→工作图坐标映射） */
    for (let i = 0; i < 5; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -240); await sleep(60); }
    await sleep(200);
    await page.click('button[data-mode="erase"]');
    await page.click('.swatch[data-color="#FF0000"]');
    await sleep(200);
    // 找一个当前不是纯红的点
    let P = null, c1 = null;
    outer:
    for (let dy = -60; dy <= 60; dy += 20) {
      for (let dx = -60; dx <= 60; dx += 20) {
        const px = cx + dx, py = cy + dy;
        if (px < box.x + 20 || py < box.y + 20 || px > box.x + box.width - 20 || py > box.y + box.height - 20) continue;
        const d = await sample(px, py);
        if (!isRed(d)) { P = [px, py]; c1 = d; break outer; }
      }
    }
    assert(!!P, '找到非红色采样点 ' + JSON.stringify(c1));
    const beforeStroke = await snap();
    await page.mouse.move(P[0], P[1]);
    await page.mouse.down();
    await page.mouse.move(P[0] + 24, P[1] + 12, { steps: 6 });
    await page.mouse.up();
    await sleep(300);
    const after = await sample(P[0], P[1]);
    assert(isRed(after), '放大状态擦除：采样点精确变为背景红 ' + JSON.stringify(after));
    const afterStroke = await snap();

    /* 9. 撤销在缩放流程后仍可用 */
    await page.click('#btn-undo');
    await sleep(250);
    assert((await snap()) !== afterStroke, '撤销后蒙版恢复（画面变化）');
    assert((await snap()) === beforeStroke, '撤销逐像素恢复原画面和半透明发丝');
  } finally {
    await browser.close();
  }
}).then(checker.finish, e => { console.error('脚本异常:', e && e.message || e); process.exit(2); });
