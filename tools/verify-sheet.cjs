/* verify-sheet.cjs — 排版模块相纸扩展真机验证：5 种相纸逐个排版出图 */
'use strict';
const { createChecker, sleep, resolvePhoto, launchBrowser, withServer, countNonWhite } = require('./_lib.cjs');

const PORT = 8435;
const PHOTO = resolvePhoto();
const checker = createChecker();
const assert = checker.assert;

withServer(PORT, async (port) => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));

    await page.goto('http://localhost:' + port + '/');
    await page.click('#home-sheet');                 // 进入排版模块（第 1 步：选择模板）
    await page.setInputFiles('#sheet-file-input', PHOTO);
    await sleep(1500);                               // 等图片加载与首版排版

    const info = () => page.$eval('#sheet-info', el => el.textContent);

    assert((await info()).includes('A4'), '默认相纸 A4：' + (await info()));

    for (const [key, name] of [['b5', 'B5'], ['a5', 'A5'], ['a3', 'A3'], ['6inch', '六寸']]) {
      await page.selectOption('#sheet-paper', key);
      await sleep(400);
      const txt = await info();
      const nw = await page.$eval('#laysheet-preview', countNonWhite);
      assert(txt.includes('张') && nw > 50, name + ' 排版出图（非白像素 ' + nw + '）：' + txt.slice(0, 30) + '…');
    }

    // 分步导航：第 1 步 → 第 2 步（导入）→ 第 3 步（预览）→ 第 4 步（打印）
    await page.selectOption('#sheet-paper', 'a4');
    await page.click('#btn-sheet-to-import');
    await sleep(200);
    await page.click('#btn-sheet-to-preview');
    await sleep(300);
    await page.click('#btn-sheet-goto-print');
    await sleep(300);
    await page.selectOption('#print-paper', 'B5');
    await sleep(300);
    const previewOk = await page.$eval('#print-preview-canvas', c => c.width > 100 && c.height > 100);
    assert(previewOk, '打印预览 B5 纸张可渲染');

    assert(pageErrors.length === 0, '无页面脚本错误' + (pageErrors.length ? '：' + pageErrors.join(' | ') : ''));
  } finally {
    await browser.close();
  }
}).then(checker.finish, e => { console.error('脚本异常:', e && e.message || e); process.exit(2); });
