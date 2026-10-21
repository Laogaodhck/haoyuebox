/* ============================================================
 * verify-ocr.cjs — OCR 主链路真机冒烟（QA-A5）
 * test-docs-ocr 只覆盖后处理纯函数；本脚本在真实 Chromium 里跑完整链路：
 * 页内 canvas 生成已知文字图片 → App.docsOcr._test.ocrRef（真实创建
 * Tesseract worker：vendor/ocr core wasm + lang 语言包 + recognize）→
 * 断言识别结果包含期望文本与正置信度。
 * 运行：node tools/verify-ocr.cjs（依赖 Chromium，见 _lib 环境变量说明）
 * ============================================================ */
'use strict';
const { createChecker, launchBrowser, withServer } = require('./_lib.cjs');

const PORT = 8440;
const checker = createChecker();
const assert = checker.assert;

withServer(PORT, async (port) => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

    await page.goto('http://localhost:' + port + '/');
    // 等 app.js 引导完成、docsOcr 模块注册
    await page.waitForFunction(() => window.App && window.App.docsOcr && window.App.docsOcr._test
      && typeof window.App.docsOcr._test.ocrRef === 'function', null, { timeout: 30000 });

    /* 主链路冒烟：页内生成含已知文字的图片（避免二进制 fixture 入库存放问题），
     * 走默认 'both'（chi_sim + eng）语言组合的真实 worker */
    const r = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 560; c.height = 120;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 48px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText('HELLO 123', 24, 62);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      const file = new File([blob], 'ocr-smoke.png', { type: 'image/png' });
      return await window.App.docsOcr._test.ocrRef(file, 'both');
    }, null, { timeout: 180000 });

    const flat = String((r && r.text) || '').replace(/\s+/g, '');
    assert(/HELLO/i.test(flat), 'OCR 识别出 HELLO（实际: ' + JSON.stringify(r && r.text) + '）');
    assert(/123/.test(flat), 'OCR 识别出 123（实际: ' + JSON.stringify(r && r.text) + '）');
    assert(typeof r.conf === 'number' && r.conf > 30,
      '识别置信度 > 30（实际: ' + (r && r.conf) + '）');
  } finally {
    await browser.close();
  }
}).then(checker.finish, (e) => { console.error('脚本异常:', (e && e.message) || e); process.exit(2); });
