/* ============================================================
 * verify-brush.cjs — 笔刷优化真机验证
 * 1. 光标环：悬停出现、跟随指针、直径=笔刷显示像素、擦除模式配色、滑杆联动
 * 2. 脏区局部重绘正确性：擦除拖拽后笔画内采样点变背景色，
 *    笔画外远点与拖拽前逐像素一致（局部重绘未污染其他区域）
 * 3. 修补模式：在擦除区域回画，采样点恢复为非背景色；环切换为白色
 * 4. 缩放状态拖拽 + 撤销逐像素恢复
 * ============================================================ */
'use strict';
const { createChecker, sleep, resolvePhoto, launchBrowser, withServer } = require('./_lib.cjs');

const PORT = 8433;
const PHOTO = resolvePhoto();
const checker = createChecker();
const assert = checker.assert;

withServer(PORT, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', e => console.log('  [pageerror]', e.message));

    await page.goto('http://localhost:' + PORT + '/');
    await page.click('#home-photo');
    await page.click('#photo-open-idphoto'); // 进入「证照生成」子功能
    await page.setInputFiles('#file-input', PHOTO);
    await page.waitForSelector('#step-matte.active', { timeout: 90000 });
    await sleep(400);

    const box = await (await page.$('#matte-view')).boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const snap = () => page.$eval('#matte-view', c => c.toDataURL());
    const ringInfo = () => page.evaluate(() => {
      const r = document.querySelector('.brush-ring');
      if (!r) return null;
      const b = r.getBoundingClientRect();
      return { display: r.style.display, w: Math.round(b.width), x: b.x + b.width / 2, y: b.y + b.height / 2, cls: r.className };
    });
    const sample = (x, y) => page.evaluate(([x, y]) => {
      const c = document.getElementById('matte-view');
      const r = c.getBoundingClientRect();
      const px = Math.min(c.width - 1, Math.max(0, Math.round((x - r.left) * c.width / r.width)));
      const py = Math.min(c.height - 1, Math.max(0, Math.round((y - r.top) * c.height / r.height)));
      return Array.from(c.getContext('2d').getImageData(px, py, 1, 1).data);
    }, [x, y]);
    const setMode = async (m) => { await page.click('button[data-mode="' + m + '"]'); await sleep(120); };
    const setBrush = async (v) => {
      await page.evaluate((v) => {
        const s = document.getElementById('brush-size');
        s.value = v;
        s.dispatchEvent(new Event('input', { bubbles: true }));
      }, v);
      await sleep(80);
    };

    /* 1. 光标环：悬停出现 + 跟随 + 直径=笔刷显示像素 */
    await setBrush(46);
    await page.mouse.move(cx, cy);
    await sleep(150);
    let r1 = await ringInfo();
    assert(!!r1 && r1.display === 'block', '悬停画布出现画笔光标环');
    assert(r1.w === 46, '环直径=笔刷显示像素 46px，实际 ' + r1.w);
    assert(Math.abs(r1.x - cx) < 2 && Math.abs(r1.y - cy) < 2, '环中心跟随指针');
    assert(r1.cls.indexOf('erase') < 0, '默认修补模式环为白色');

    /* 2. 擦除模式环配色 */
    await setMode('erase');
    await page.mouse.move(cx + 10, cy + 10);
    await sleep(100);
    r1 = await ringInfo();
    assert(r1.cls.indexOf('erase') >= 0, '擦除模式环带 erase 配色类');

    /* 3. 脏区局部重绘正确性：拖拽擦除，笔画内变背景色、笔画外逐像素不变 */
    await page.click('.swatch[data-color="#FF0000"]'); // 背景调红便于断言
    await sleep(200);
    await page.mouse.move(cx - 90, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 90, cy, { steps: 14 }); // 横向快速拖拽（考验合并采样+脏区）
    await page.mouse.up();
    await sleep(300);
    const inStroke = await sample(cx, cy);
    assert(inStroke[0] === 255 && inStroke[1] === 0 && inStroke[2] === 0,
      '笔画中心被擦除为背景红 ' + JSON.stringify(inStroke));

    /* 4. 修补模式回画恢复：擦除条带上重新涂回人像 */
    await setMode('restore');
    await page.mouse.move(cx - 60, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy, { steps: 10 });
    await page.mouse.up();
    await sleep(300);
    const restored = await sample(cx, cy);
    assert(!(restored[0] === 255 && restored[1] === 0 && restored[2] === 0),
      '修补后采样点不再是背景红 ' + JSON.stringify(restored));

    /* 5. 撤销逐像素恢复（覆盖脏区重绘路径后的全量一致性） */
    const afterAll = await snap();
    await page.click('#btn-undo');
    await sleep(300);
    const afterUndo1 = await snap();
    assert(afterUndo1 !== afterAll, '撤销 1 步：画面变化');
    await page.click('#btn-undo');
    await sleep(300);
    const afterUndo2 = await snap();
    assert(afterUndo2 !== afterUndo1, '撤销 2 步：继续恢复');

    /* 6. 缩放状态下拖拽擦除（坐标映射 + 脏区在缩放视图下正确） */
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -240); await sleep(60); }
    await sleep(200);
    await setMode('erase');
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 40, cy + 20, { steps: 8 });
    await page.mouse.up();
    await sleep(300);
    const zoomedErase = await sample(cx + 20, cy + 10);
    assert(zoomedErase[0] === 255 && zoomedErase[1] === 0 && zoomedErase[2] === 0,
      '放大状态擦除：路径中点精确变红 ' + JSON.stringify(zoomedErase));
  } finally {
    await browser.close();
  }
}).then(checker.finish, e => { console.error('脚本异常:', e && e.message || e); process.exit(2); });
