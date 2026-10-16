/* ============================================================
 * verify-print-batch.cjs — 批量打印真机验证（Playwright + 真实 pdf.js）
 * stub window.haoyuePrint（页面脚本执行前注入），文件字节经 base64 预埋：
 * PDF / TXT / PNG 用真实字节走完整渲染与打印链路。
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChecker, launchBrowser, withServer, ROOT } = require('./_lib.cjs');

const t = createChecker();
const assert = (c, n) => t.assert(c, n);

/* ---------- 最小合法 PDF（单页文本） ---------- */
function buildPdf(text) {
  const objs = [
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Kids [3 0 R] /Count 1>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>>',
    '<</Length ' + ('BT /F1 24 Tf 72 720 Td (' + text + ') Tj ET').length + '>>\nstream\nBT /F1 24 Tf 72 720 Td (' + text + ') Tj ET\nendstream',
    '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>'
  ];
  let out = '%PDF-1.4\n';
  const offsets = [0];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n';
  });
  const xref = out.length;
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  for (let i = 1; i <= objs.length; i++) {
    out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  out += 'trailer\n<</Size ' + (objs.length + 1) + ' /Root 1 0 R>>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.from(out, 'latin1');
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haoyue-print-'));
  fs.writeFileSync(path.join(tmp, '文档A.pdf'), buildPdf('Hello Haoyue PDF'));
  fs.writeFileSync(path.join(tmp, '文档B.txt'), '第一行浩玥\n第二行测试\n第三行结束\n', 'utf8');
  const pngB64 = fs.readFileSync(path.join(ROOT, 'assets', 'icon.png')).toString('base64');
  const pdfB64 = fs.readFileSync(path.join(tmp, '文档A.pdf')).toString('base64');
  const txtB64 = fs.readFileSync(path.join(tmp, '文档B.txt')).toString('base64');

  await withServer(8614, async () => {
    const browser = await launchBrowser();
    try {
      const ctx = await browser.newContext();
      await ctx.addInitScript(([pdf, txt, png]) => {
        const bytes = (b64) => {
          const bin = atob(b64);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          return u8.buffer;
        };
        window.haoyuePrint = {
          isDesktop: true,
          calls: [],
          _pick: null,
          pickPaths(kind) {
            this.calls.push(['pickPaths', kind]);
            return Promise.resolve(this._pick || []);
          },
          readFile(p) {
            this.calls.push(['readFile', p]);
            const b64 = p.endsWith('.pdf') ? pdf : p.endsWith('.txt') ? txt : png;
            return Promise.resolve({ ok: true, data: bytes(b64), size: b64.length });
          },
          printImage(p) {
            this.calls.push(['printImage', p]);
            return Promise.resolve({ ok: true });
          }
        };
      }, [pdfB64, txtB64, pngB64]);

      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto('http://127.0.0.1:8614/', { waitUntil: 'load' });

      /* ---------- 1. 模块导航 ---------- */
      await page.click('#home-print');
      assert(await page.$eval('#view-print', (el) => el.style.display === 'block'), '首页卡进入打印工具');
      assert(await page.$eval('#print-menu', (el) => !el.hidden), '打印工具子功能菜单可见');
      assert(await page.$eval('#print-batch', (el) => el.hidden), '批量打印面板初始隐藏');
      await page.click('#print-open-batch');
      assert(await page.$eval('#print-menu', (el) => el.hidden), '进入批量打印后菜单收纳');
      assert(await page.$eval('#print-batch', (el) => !el.hidden), '批量打印面板可见');
      assert(await page.$eval('#pb-img', (el) => !el.hidden), '默认显示图片面板');
      assert(await page.$eval('#pd-doc', (el) => el.hidden), '文档面板初始隐藏');

      /* ---------- 2. 图片面板：选择 / 旋转 / 统一打印 ---------- */
      await page.evaluate(() => {
        window.haoyuePrint._pick = [
          { path: 'C:\\t\\a.png', name: 'a.png', isDir: false, size: 1024 },
          { path: 'C:\\t\\b.png', name: 'b.png', isDir: false, size: 1024 }
        ];
      });
      await page.click('#pb-pick');
      await page.waitForFunction(() => document.querySelectorAll('#pb-grid .pb-card').length === 2);
      assert(true, '选择图片后两张卡片渲染');
      await page.waitForFunction(() => {
        const t = document.getElementById('pb-count');
        return /就绪 2 张/.test(t.textContent);
      });
      assert(true, '图片解码就绪计数正确');

      await page.click('#pb-grid .pb-card .pb-op');
      await page.waitForFunction(() => document.querySelector('#pb-grid .pb-card img').style.transform === 'rotate(90deg)');
      assert(await page.$eval('#pb-grid .pb-card .pb-deg', (el) => el.textContent === '90°'), '单张旋转 90° 后标记更新');

      await page.click('#pb-run');
      await page.waitForFunction(() => {
        const c = window.haoyuePrint.calls.filter((c) => c[0] === 'printImage');
        return c.length >= 1;
      });
      const imgPayload = await page.evaluate(() => window.haoyuePrint.calls.filter((c) => c[0] === 'printImage')[0][1]);
      assert(imgPayload.dataUrls.length === 2, '统一打印两页（两图）');
      assert(/^data:image\/jpeg/.test(imgPayload.dataUrls[0]), '页面以 JPEG dataUrl 发送');
      assert(imgPayload.pageSize === 'A4', 'A4 纸张');
      assert(imgPayload.landscape !== true, '竖向方向');
      assert(imgPayload.duplex === 'simplex', '默认单面');
      assert(imgPayload.copies === 1, '默认 1 份');

      await page.selectOption('#pb-duplex', 'longEdge');
      await page.selectOption('#pb-orient', '1');
      await page.click('#pb-run');
      await page.waitForFunction(() => window.haoyuePrint.calls.filter((c) => c[0] === 'printImage').length >= 2);
      const p2 = await page.evaluate(() => {
        const c = window.haoyuePrint.calls.filter((c) => c[0] === 'printImage');
        return c[c.length - 1][1];
      });
      assert(p2.duplex === 'longEdge', '双面长边透传');
      assert(p2.landscape === true && p2.pageSize === 'A4', '横向时 landscape 置位');
      await page.selectOption('#pb-duplex', 'simplex');
      await page.selectOption('#pb-orient', '0');

      /* 勾选：取消第一张 → 只打印勾选的图 */
      await page.click('#pb-grid .pb-card:nth-child(1) .pb-pick input');
      assert(await page.$eval('#pb-grid .pb-card:nth-child(1)', (el) => el.classList.contains('pb-card-off')),
        '取消勾选后卡片弱化');
      assert(await page.$eval('#pb-check-all', (el) => el.indeterminate), '部分勾选时全选框半选');
      assert(await page.$eval('#pb-count', (el) => /已勾选 1 张/.test(el.textContent)), '计数含已勾选数');
      await page.click('#pb-run');
      await page.waitForFunction(() => window.haoyuePrint.calls.filter((c) => c[0] === 'printImage').length >= 3);
      const p3 = await page.evaluate(() => {
        const c = window.haoyuePrint.calls.filter((c) => c[0] === 'printImage');
        return c[c.length - 1][1];
      });
      assert(p3.dataUrls.length === 1, '取消勾选后仅打印勾选的图片');
      await page.click('#pb-grid .pb-card:nth-child(1) .pb-pick input');   // 勾回
      assert(await page.$eval('#pb-check-all', (el) => el.checked && !el.indeterminate), '勾回后全选框恢复全选');

      /* ---------- 3. 文档面板：列队 / 合并 ---------- */
      await page.click('#pb-tab-doc');
      assert(await page.$eval('#pd-doc', (el) => !el.hidden), '切换到文档面板');
      await page.evaluate(() => {
        window.haoyuePrint._pick = [
          { path: 'C:\\t\\文档A.pdf', name: '文档A.pdf', isDir: false, size: 800 },
          { path: 'C:\\t\\文档B.txt', name: '文档B.txt', isDir: false, size: 48 }
        ];
      });
      await page.click('#pd-pick');
      await page.waitForFunction(() => document.querySelectorAll('#pd-table tbody tr').length === 2);
      assert(true, '选择文档后表格两行');
      await page.waitForFunction(() => {
        const cells = document.querySelectorAll('#pd-table tbody td:nth-child(5)');
        return cells.length === 2 && /1 页/.test(cells[0].textContent) && /页/.test(cells[1].textContent);
      }, null, { timeout: 15000 });
      assert(true, 'PDF 与 TXT 页数解析完成（真实 pdf.js / 排版）');
      const cntTxt = await page.$eval('#pd-count', (el) => el.textContent);
      assert(/共 2 页/.test(cntTxt), '计数含总页数');

      /* 列队顺序打印：每文档一个任务，按表格顺序（文档任务特征：pageSize 为字符串且无 landscape 字段） */
      await page.click('#pd-run');
      await page.waitForFunction(() => {
        const c = window.haoyuePrint.calls.filter((c) => c[0] === 'printImage' && c[1].landscape === undefined);
        return c.length >= 2;
      });
      const docCalls = await page.evaluate(() =>
        window.haoyuePrint.calls.filter((c) => c[0] === 'printImage' && c[1].landscape === undefined));
      assert(docCalls.length === 2, '列队模式两个打印任务');
      assert(docCalls[0][1].dataUrls.length === 1 && docCalls[1][1].dataUrls.length === 1, '每任务各自文档页');
      assert(docCalls[0][1].duplex === 'simplex', '文档任务默认单面');

      /* 合并打印 */
      await page.selectOption('#pd-mode', 'merge');
      await page.click('#pd-run');
      await page.waitForFunction(() => {
        const c = window.haoyuePrint.calls.filter((c) => c[0] === 'printImage' && c[1].landscape === undefined);
        return c.length >= 3;
      });
      const mergeCall = await page.evaluate(() => {
        const c = window.haoyuePrint.calls.filter((c) => c[0] === 'printImage' && c[1].landscape === undefined);
        return c[c.length - 1][1];
      });
      assert(mergeCall.dataUrls.length === 2, '合并模式一个任务含全部页');

      /* 勾选：取消第一个文档 → 列队打印只含剩余文档 */
      await page.click('#pd-table tbody tr:first-child td:nth-child(1) input');
      assert(await page.$eval('#pd-table tbody tr:first-child', (el) => el.classList.contains('row-unchecked')),
        '取消勾选后文档行弱化');
      assert(await page.$eval('#pd-check-all', (el) => el.indeterminate), '文档部分勾选时全选框半选');
      assert(await page.$eval('#pd-count', (el) => /共 1 页/.test(el.textContent)), '计数仅统计勾选文档页数');
      await page.click('#pd-run');
      await page.waitForFunction(() => {
        const c = window.haoyuePrint.calls.filter((c) => c[0] === 'printImage' && c[1].landscape === undefined);
        return c.length >= 4;
      });
      const ckCall = await page.evaluate(() => {
        const c = window.haoyuePrint.calls.filter((c) => c[0] === 'printImage' && c[1].landscape === undefined);
        return c[c.length - 1][1];
      });
      assert(ckCall.dataUrls.length === 1, '取消勾选的文档不参与列队打印');
      await page.click('#pd-table tbody tr:first-child td:nth-child(1) input');   // 勾回
      assert(await page.$eval('#pd-check-all', (el) => el.checked && !el.indeterminate), '文档勾回后全选框恢复全选');

      /* 顺序调整与移除（勾选列后文件名在第 3 列） */
      await page.click('#pd-table tbody tr:first-child button:nth-of-type(2)');   // ↓ 下移第一个
      const order = await page.$$eval('#pd-table tbody tr td:nth-child(3)', (tds) => tds.map((x) => x.textContent));
      assert(order[0] === '文档B.txt' && order[1] === '文档A.pdf', '下移后队列顺序更新');
      await page.click('#pd-table tbody tr:last-child button:nth-of-type(3)');
      assert(await page.$$eval('#pd-table tbody tr', (trs) => trs.length) === 1, '移除后剩一行');

      /* 清空返回 */
      await page.click('#pd-clear');
      assert(await page.$eval('#pd-empty', (el) => !el.hidden), '清空后空态提示显示');
      await page.click('#pd-back');
      assert(await page.$eval('#print-menu', (el) => !el.hidden), '返回打印工具菜单');

      /* ---------- 4. 浏览器降级 ---------- */
      const page2 = await ctx.newPage();
      await page2.addInitScript(() => { delete window.haoyuePrint; });
      await page2.goto('http://127.0.0.1:8614/', { waitUntil: 'load' });
      await page2.click('#home-print');
      await page2.click('#print-open-batch');
      assert(await page2.$eval('#pb-unsupported', (el) => !el.hidden), '浏览器模式显示不支持提示');
      assert(await page2.$eval('#pb-pick', (el) => el.disabled), '浏览器模式选择按钮禁用');
      assert(await page2.$eval('#pd-pick', (el) => el.disabled), '文档面板同样禁用');

      assert(errors.length === 0, '无页面脚本错误' + (errors.length ? '：' + errors[0] : ''));
    } finally {
      await browser.close();
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }
  });
})().then(() => t.finish()).catch((e) => { console.error('脚本异常：', e.message); process.exit(1); });
