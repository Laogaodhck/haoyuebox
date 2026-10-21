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

    /* 增强链路冒烟：低对比度（深灰字浅灰底）+ 倾斜 2.5° 的退化图，
     * 走 opts.enhance 管线（纠偏 + 百分位拉伸 + Sauvola 二值化）后应仍可识别。
     * 同时确认 App.ocrEnhance 模块已挂载。 */
    assert(await page.evaluate(() => !!(window.App && window.App.ocrEnhance
      && typeof window.App.ocrEnhance.enhance === 'function')), 'App.ocrEnhance 模块已挂载');
    const r2 = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 560; c.height = 160;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#d9d9d9';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.save();
      ctx.translate(280, 80);
      ctx.rotate(-2.5 * Math.PI / 180);
      ctx.fillStyle = '#666666';
      ctx.font = 'bold 48px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText('HELLO 123', -160, 0);
      ctx.restore();
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      const file = new File([blob], 'ocr-degraded.png', { type: 'image/png' });
      return await window.App.docsOcr._test.ocrRef(file, 'both', { enhance: true });
    }, null, { timeout: 180000 });
    const flat2 = String((r2 && r2.text) || '').replace(/\s+/g, '');
    assert(/HELLO/i.test(flat2), '增强链路识别出 HELLO（实际: ' + JSON.stringify(r2 && r2.text) + '）');
    assert(/123/.test(flat2), '增强链路识别出 123（实际: ' + JSON.stringify(r2 && r2.text) + '）');

    /* 结构化导出链路（真实浏览器内跑）：合成 blocks（含左右不同对齐的两列表格）
     * → buildDoc 结构化模型 → buildDocxXmlFromUnits → 断言真 w:tbl / tblGrid / 列对齐，
     * 并确认 ZipUtil.store 能打出非空 DOCX 包。覆盖「导出保持行列与对齐」的回归。 */
    const doc = await page.evaluate(async () => {
      const word = (text, x0, y0, x1, y1, conf) => ({ text, confidence: conf, bbox: { x0, y0, x1, y1 } });
      const row = (y, c1, c2, x2, x3) => ({
        text: c1 + ' ' + c2, bbox: { x0: 20, y0: y, x1: 400, y1: y + 24 },
        words: [word(c1, 20, y, 140, y + 24, 90), word(c2, x2, y, x3, y + 24, 90)]
      });
      const blocks = [{ paragraphs: [{ lines: [
        row(10, '项目', '数量', 300, 400),
        row(40, '合计', '9', 340, 400),
        row(70, '均摊', '12', 320, 400)
      ] }] }];
      const built = window.App.ocrEnhance.buildFromBlocks({ blocks });
      const xml = window.App.docsOcr._test.buildDocxXmlFromUnits([{ label: '', doc: built.doc }]);
      const files = window.App.docsOcr._test.buildDocxFiles([{ label: '', doc: built.doc }]);
      const xmlFromFiles = new TextDecoder().decode(files[2].data);
      let zipSize = 0;
      try {
        const blob = window.ZipUtil.store(files);
        zipSize = blob && blob.size ? blob.size : 0;
      } catch (e) { zipSize = -1; }
      return {
        hasTable: built.hasTable,
        textHasCells: built.text.indexOf('合计') >= 0 && built.text.indexOf('均摊') >= 0,
        aligns: (built.doc.blocks.filter(function (b) { return b.type === 'table'; })[0] || {}).aligns,
        hasTbl: xml.indexOf('<w:tbl>') >= 0,
        gridCols: (xml.match(/<w:gridCol w:w="\d+"\/>/g) || []).length,
        rightJc: (xml.match(/<w:jc w:val="right"\/>/g) || []).length,
        xmlSame: xmlFromFiles === xml,
        zipSize: zipSize,
        /* Excel 结构化导出：每个表格块一张工作表 */
        xlsx: (function () {
          var builtXl = window.App.xlsxLite.buildXlsxFromUnits([{ label: '扫描件', doc: built.doc }]);
          if (!builtXl) return { ok: false };
          var sheet = new TextDecoder().decode(
            builtXl.files.filter(function (f) { return f.name === 'xl/worksheets/sheet1.xml'; })[0].data);
          var size = 0;
          try { size = window.ZipUtil.store(builtXl.files).size; } catch (e) { size = -1; }
          return {
            ok: true,
            parts: builtXl.files.length,
            stats: builtXl.stats,
            hasHeader: sheet.indexOf('<c r="A1" s="3"') >= 0,
            numeric: /<c r="B2" s="2"><v>\d+<\/v><\/c>/.test(sheet),
            size: size
          };
        })()
      };
    });
    assert(doc.hasTable === true && doc.textHasCells === true, '版面模型识别出表格并保留单元格文本');
    assert(Array.isArray(doc.aligns) && doc.aligns[1] === 'right',
      '右对齐列被识别（实际 ' + JSON.stringify(doc.aligns) + '）');
    assert(doc.hasTbl === true && doc.gridCols === 2, 'DOCX 导出含真表格且两列（gridCol=' + doc.gridCols + '）');
    assert(doc.rightJc === 3, 'DOCX 单元格保留右对齐（jc 数 ' + doc.rightJc + '）');
    assert(doc.xmlSame === true, 'buildDocxFiles 结构化路径与 XML 生成一致');
    assert(doc.zipSize > 500, 'ZipUtil 打出非空 DOCX 包（' + doc.zipSize + ' 字节）');

    /* Excel 结构化导出（真实浏览器内）：表格 → 工作表部件 + 表头样式 + 数值单元格 + 可打包 */
    assert(!!doc.xlsx && doc.xlsx.ok === true, 'App.xlsxLite 可生成表格工作簿');
    assert(doc.xlsx.parts === 6 && doc.xlsx.stats.sheets === 1,
      '单表工作簿 6 个部件 / 1 个工作表（实际 ' + doc.xlsx.parts + ' / ' + doc.xlsx.stats.sheets + '）');
    assert(doc.xlsx.hasHeader === true, '工作表首行表头加粗样式');
    assert(doc.xlsx.numeric === true, '数字单元格保持数值类型（含右对齐样式）');
    assert(doc.xlsx.size > 500, 'ZipUtil 打出非空 XLSX 包（' + doc.xlsx.size + ' 字节）');

    /* A4 固定版心与竖向/横向切换（真实布局）：比例恒为 A4，切换即改比例与导出方向 */
    await page.click('.module-tab[data-module="print"]');
    await page.click('#print-open-ocr');
    await page.waitForFunction(() => {
      const el = document.getElementById('docs-ocr');
      return el && !el.hidden && el.getBoundingClientRect().width > 0;
    }, null, { timeout: 15000 });
    const ratio = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), cls: el.className };
    }, sel);
    const p0 = await ratio('#do-page');
    assert(!/landscape/.test(p0.cls), '结果区默认竖向');
    assert(Math.abs(p0.w / p0.h - 210 / 297) < 0.02,
      '版心比例符合 A4 竖向 210:297（实际 ' + p0.w + '×' + p0.h + '）');
    await page.click('#do-page-l');
    const p1 = await ratio('#do-page');
    assert(/landscape/.test(p1.cls) && Math.abs(p1.w / p1.h - 297 / 210) < 0.02,
      '切换横向后比例符合 A4 横向 297:210（实际 ' + p1.w + '×' + p1.h + '）');
    assert(await page.evaluate(() => document.getElementById('do-page-label').textContent.indexOf('横向') >= 0),
      '横向时标签同步为 A4 横向');
    const landXml = await page.evaluate(() => window.App.docsOcr._test.buildDocxXml('横', { landscape: true }));
    assert(landXml.indexOf('w:orient="landscape"') >= 0 && landXml.indexOf('w:w="16838"') >= 0,
      '横向导出 DOCX 页面尺寸转置并标 orient');
    await page.click('#do-page-p');
    const p2 = await ratio('#do-page');
    assert(!/landscape/.test(p2.cls), '切回竖向恢复版心');
    assert(await page.evaluate(() => document.getElementById('do-page-p').classList.contains('active')),
      '竖向按钮选中态同步');

    /* 清空列表：同时复位识别结果区（文本 / 统计 / 导出按钮 / 空态提示） */
    const cleared = await page.evaluate(() => {
      const ta = document.getElementById('do-text');
      ta.value = '识别结果示例文本';
      const ids = ['do-copy', 'do-txt', 'do-docx', 'do-xlsx'];
      ids.forEach(function (id) { document.getElementById(id).disabled = false; });
      document.getElementById('do-clear').click();
      return {
        text: ta.value,
        allDisabled: ids.every(function (id) { return document.getElementById(id).disabled; }),
        meta: document.getElementById('do-meta').textContent,
        hintShown: !document.getElementById('do-empty-hint').hidden,
        label: document.getElementById('do-clear').textContent
      };
    });
    assert(cleared.text === '', '清空列表同时清空识别结果文本');
    assert(cleared.allDisabled === true, '清空后导出按钮（含 Excel）全部禁用');
    assert(cleared.meta === '' && cleared.hintShown === true, '清空后统计行复位并回到空态提示');
    assert(/列表与结果/.test(cleared.label), '按钮文案明示清空范围（列表与结果）');
  } finally {
    await browser.close();
  }
}).then(checker.finish, (e) => { console.error('脚本异常:', (e && e.message) || e); process.exit(2); });
