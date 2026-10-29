/* ============================================================
 * verify-batch.cjs — 批量工具「格式转换 / 去除水印」真机验证
 * 用 addInitScript 把 showDirectoryPicker / showOpenFilePicker
 * stub 成返回 OPFS 内测试文件句柄，走真实选择 / 扫描 / 转换 /
 * 写盘 / 读回校验链路：
 *   1. OPFS 准备 3 张图片（png/jpg/webp）+ 1 个 txt + 1 个子文件夹
 *   2. 格式转换：JPG / PNG / WebP（含同名跳过）/ PDF 合并与单页
 *   3. 去除水印：选择图片 → 拖拽框选 → 纯色填充另存副本 →
 *      涂抹蒙版 → 蒙版填充覆盖原文件 → 逐图读回像素验证
 * ============================================================ */
'use strict';
const { createChecker, sleep, launchBrowser, withServer } = require('./_lib.cjs');

const PORT = 8435;
const checker = createChecker();
const assert = checker.assert;

withServer(PORT, async (port) => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', e => console.log('  [pageerror]', e.message));

    // stub：文件夹选择返回 OPFS 内的 photo-tool-test（真实 FileSystemDirectoryHandle）
    await page.addInitScript(() => {
      window.showDirectoryPicker = function () {
        return navigator.storage.getDirectory()
          .then(root => root.getDirectoryHandle('photo-tool-test', { create: true }));
      };
      // stub：图片选择返回 OPFS 内的 a.png / b.jpg / c.webp（真实 FileSystemFileHandle）
      window.showOpenFilePicker = function () {
        return navigator.storage.getDirectory()
          .then(root => root.getDirectoryHandle('photo-tool-test', { create: true }))
          .then(dir => Promise.all([
            dir.getFileHandle('a.png'), dir.getFileHandle('b.jpg'), dir.getFileHandle('c.webp')
          ]));
      };
    });

    await page.goto('http://localhost:' + port + '/');
    await sleep(400);

    // ---------- 准备 OPFS 测试数据 ----------
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('photo-tool-test', { recursive: true }).catch(() => {});
      const dir = await root.getDirectoryHandle('photo-tool-test', { create: true });
      async function put(name, blob) {
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
      }
      async function img(name, mime, draw) {
        const c = document.createElement('canvas');
        c.width = 200; c.height = 150;
        draw(c.getContext('2d'));
        const blob = await new Promise(r => c.toBlob(r, mime, 0.92));
        await put(name, blob);
      }
      await img('a.png', 'image/png', ctx => {
        ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 200, 150);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(140, 10, 50, 30); // 模拟水印块
      });
      await img('b.jpg', 'image/jpeg', ctx => { ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 200, 150); });
      await img('c.webp', 'image/webp', ctx => { ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, 200, 150); });
      await put('说明.txt', new Blob(['hello']));
      const sub = await dir.getDirectoryHandle('sub', { create: true });
      const fh = await sub.getFileHandle('hidden.png', { create: true });
      const w = await fh.createWritable();
      await w.write(new Blob([new Uint8Array([137, 80, 78, 71])]));
      await w.close();
    });

    // ---------- 占位项收敛：批量加水印不再重复占位（能力归入文档工具） ----------
    await page.click('#home-batch');
    assert(await page.$('#batch-open-addwm') === null, '批量工具不再重复占位「批量加水印」');
    assert(await page.$('#batch-soon') === null, '旧占位页 #batch-soon 已移除');
    assert((await page.$$eval('#batch-menu .home-card', els => els.length)) === 5, '批量工具菜单收敛为 5 张可用卡片');
    await page.click('.module-tab[data-module="home"]');

    // ---------- 格式转换：扫描 ----------
    await page.click('#home-batch');
    await page.click('#batch-open-format');
    await page.waitForSelector('#batch-format:not([hidden])');
    await page.click('#bf-pick');
    await page.waitForFunction(() => !document.getElementById('bf-run').disabled, { timeout: 20000 });
    await sleep(200);

    const scanRows = await page.$$eval('#bf-table tbody tr', trs => trs.length);
    assert(scanRows === 3, '扫描到 3 张图片（txt 与子文件夹被忽略）');
    const summary = await page.$eval('#bf-summary', el => el.textContent);
    assert(/已识别 3 张图片/.test(summary), '汇总提示正确');

    // ---------- JPG → 子文件夹「转换输出」 ----------
    await page.selectOption('#bf-fmt', 'jpeg');
    await page.click('#bf-run');
    await page.waitForFunction(() => !document.getElementById('bf-run').disabled, { timeout: 30000 });
    await sleep(200);
    const jpgRes = await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('photo-tool-test');
      const out = await dir.getDirectoryHandle('转换输出');
      const names = [];
      for await (const it of out.values()) names.push(it.name);
      const fh = await out.getFileHandle('a.jpg');
      const b = new Uint8Array(await (await fh.getFile()).slice(0, 3).arrayBuffer());
      return { names, head: [b[0], b[1], b[2]] };
    });
    assert(jpgRes.names.length === 3 && jpgRes.names.every(n => n.endsWith('.jpg')), '3 张图全部转为 .jpg');
    assert(jpgRes.head[0] === 0xFF && jpgRes.head[1] === 0xD8, 'a.jpg 为合法 JPEG（魔数 FFD8）');

    // ---------- PNG → 追加输出 ----------
    await page.selectOption('#bf-fmt', 'png');
    await page.click('#bf-run');
    await page.waitForFunction(() => !document.getElementById('bf-run').disabled, { timeout: 30000 });
    await sleep(200);
    const pngRes = await page.evaluate(async () => {
      const out = await (await (await navigator.storage.getDirectory())
        .getDirectoryHandle('photo-tool-test')).getDirectoryHandle('转换输出');
      const fh = await out.getFileHandle('b.png');
      const b = new Uint8Array(await (await fh.getFile()).slice(0, 4).arrayBuffer());
      return [b[0], b[1], b[2], b[3]];
    });
    assert(pngRes[0] === 137 && pngRes[1] === 80 && pngRes[2] === 78 && pngRes[3] === 71,
      'b.png 为合法 PNG（魔数 89 50 4E 47）');

    // ---------- WebP → 原文件夹覆盖（同名同格式应跳过） ----------
    await page.selectOption('#bf-fmt', 'webp');
    await page.selectOption('#bf-out', 'same');
    await page.click('#bf-run');
    await page.waitForFunction(() => !document.getElementById('bf-run').disabled, { timeout: 30000 });
    await sleep(200);
    const webpRes = await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('photo-tool-test');
      const names = [];
      for await (const it of dir.values()) if (it.kind === 'file') names.push(it.name);
      async function head4(name) {
        const fh = await dir.getFileHandle(name);
        const b = new Uint8Array(await (await fh.getFile()).slice(0, 4).arrayBuffer());
        return String.fromCharCode.apply(null, b);
      }
      return { names, c: await head4('c.webp'), a: await head4('a.webp') };
    });
    assert(webpRes.names.includes('a.webp') && webpRes.names.includes('b.webp'), '覆盖模式输出 a.webp / b.webp');
    assert(webpRes.a === 'RIFF', 'a.webp 为合法 WebP（RIFF 头）');
    assert(webpRes.names.includes('c.webp'), 'c.webp 仍在原文件夹');

    // ---------- PDF 合并 + 每图单页 ----------
    await page.selectOption('#bf-out', 'sub');
    await page.selectOption('#bf-fmt', 'pdf');
    await page.click('#bf-run');
    await page.waitForFunction(() => !document.getElementById('bf-run').disabled, { timeout: 30000 });
    await sleep(200);
    const pdfRes = await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('photo-tool-test');
      const out = await dir.getDirectoryHandle('转换输出');
      const fh = await out.getFileHandle('photo-tool-test.pdf');
      const f = await fh.getFile();
      const head = String.fromCharCode.apply(null, new Uint8Array(await f.slice(0, 5).arrayBuffer()));
      const tail = await f.slice(Math.max(0, f.size - 32)).text();
      return { head, tail, size: f.size };
    });
    assert(pdfRes.head === '%PDF-', '合并 PDF 头为 %PDF-');
    assert(pdfRes.tail.includes('%%EOF'), '合并 PDF 以 %%EOF 结束');
    assert(pdfRes.size > 1000, '合并 PDF 包含 3 页图像数据（>1KB）');

    await page.selectOption('#bf-pdf-merge', 'single');
    await page.click('#bf-run');
    await page.waitForFunction(() => !document.getElementById('bf-run').disabled, { timeout: 30000 });
    await sleep(200);
    const pdfCnt = await page.evaluate(async () => {
      const out = await (await (await navigator.storage.getDirectory())
        .getDirectoryHandle('photo-tool-test')).getDirectoryHandle('转换输出');
      const names = [];
      for await (const it of out.values()) names.push(it.name);
      return names.filter(n => n.endsWith('.pdf')).length;
    });
    assert(pdfCnt === 4, '单页模式追加 3 个 PDF（累计 4 个 pdf 文件）');

    // ---------- 去除水印：选择图片 + 拖拽框选 ----------
    await page.click('#bf-back');
    await page.click('#batch-open-watermark');
    await page.waitForSelector('#batch-watermark:not([hidden])');
    await page.click('#bw-pick');
    await page.waitForFunction(() => !document.getElementById('wm-canvas').hidden, { timeout: 20000 });
    await sleep(300);
    const filesText = await page.$eval('#bw-files', el => el.textContent);
    assert(/已选择 3 张图片/.test(filesText), '选择图片后提示 3 张');

    // a.png 水印块在 (140,10)-(190,40)；拖拽 (0.68,0.05)-(0.97,0.28) 完整覆盖
    const cb = await page.$eval('#wm-canvas', c => {
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await page.mouse.move(cb.x + cb.w * 0.68, cb.y + cb.h * 0.05);
    await page.mouse.down();
    await page.mouse.move(cb.x + cb.w * 0.97, cb.y + cb.h * 0.28, { steps: 6 });
    await page.mouse.up();
    await sleep(200);
    const chips = await page.$$eval('#wm-chips .wm-chip', els => els.map(e => e.textContent));
    assert(chips.length === 1 && /区域 1/.test(chips[0]), '拖拽框选生成「区域 1」标签');

    // ---------- 纯色填充 + 另存副本（保存位置 stub 回同一 OPFS 文件夹） ----------
    await page.selectOption('#bw-mode', 'fill');
    await page.evaluate(() => { document.getElementById('bw-color').value = '#000000'; });
    await page.selectOption('#bw-out', 'suffix');
    await page.click('#bw-run');
    await page.waitForFunction(() => !document.getElementById('bw-run').disabled, { timeout: 30000 });
    await sleep(200);
    const wmRes = await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('photo-tool-test');
      const names = [];
      for await (const it of dir.values()) if (it.kind === 'file') names.push(it.name);
      async function px(name, x, y) {
        const fh = await dir.getFileHandle(name);
        const bmp = await createImageBitmap(await fh.getFile());
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        const d = ctx.getImageData(x, y, 1, 1).data;
        return [d[0], d[1], d[2]];
      }
      return {
        names,
        aMark: await px('a-无水印.png', 165, 25),
        aBody: await px('a-无水印.png', 100, 100),
        bMark: await px('b-无水印.jpg', 165, 25),
        bBody: await px('b-无水印.jpg', 100, 100)
      };
    });
    assert(wmRes.names.includes('a-无水印.png') && wmRes.names.includes('b-无水印.jpg'),
      '输出文件带「-无水印」后缀');
    assert(wmRes.names.includes('c-无水印.webp'), 'WebP 保持原格式输出');
    assert(wmRes.names.includes('a.png') && wmRes.names.includes('b.jpg'), '原文件未被改动');
    assert(wmRes.aMark[0] < 10 && wmRes.aMark[1] < 10 && wmRes.aMark[2] < 10, 'a 水印区域已填充为黑色');
    assert(wmRes.aBody[0] > 240 && wmRes.aBody[1] < 10 && wmRes.aBody[2] < 10, 'a 红色背景未受影响');
    assert(wmRes.bMark[0] < 20 && wmRes.bMark[2] < 20, 'b 同比例水印区域已填充（JPEG 容差内）');
    assert(wmRes.bBody[2] > 230 && wmRes.bBody[0] < 20, 'b 蓝色背景未受影响');

    // ---------- 手动涂抹蒙版 + 覆盖原文件 ----------
    await page.click('#bw-tool-brush');
    assert(await page.$eval('#bw-tool-brush', el => el.classList.contains('active')), '涂抹工具已激活');
    assert(await page.$eval('#bw-brush-row', el => !el.hidden), '涂抹模式显示笔刷大小');
    // 笔迹从 (0.70,0.08) 到 (0.95,0.25)，默认笔刷 40px，覆盖水印块主体
    await page.mouse.move(cb.x + cb.w * 0.70, cb.y + cb.h * 0.08);
    await page.mouse.down();
    await page.mouse.move(cb.x + cb.w * 0.95, cb.y + cb.h * 0.25, { steps: 6 });
    await page.mouse.up();
    await sleep(200);
    const brushChips = await page.$$eval('#wm-chips .wm-chip', els => els.map(e => e.textContent));
    assert(brushChips.some(t => /手动涂抹蒙版/.test(t)), '涂抹后生成「手动涂抹蒙版」标签');

    await page.selectOption('#bw-out', 'overwrite');
    await page.click('#bw-run');
    // 1.2.1 起：覆盖原文件先弹统一确认框，须应答后任务才真正开始
    await page.waitForFunction(() => !document.getElementById('confirm-dlg').hidden);
    assert(/不可撤销/.test(await page.$eval('#confirm-msg', el => el.textContent)),
      '覆盖原文件前弹出不可撤销确认');
    await page.click('#confirm-ok');
    await page.waitForFunction(() => !document.getElementById('bw-run').disabled, { timeout: 30000 });
    await sleep(200);
    const ovRes = await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('photo-tool-test');
      async function px(name, x, y) {
        const fh = await dir.getFileHandle(name);
        const bmp = await createImageBitmap(await fh.getFile());
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        return Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
      }
      return { aMark: await px('a.png', 165, 25), aBody: await px('a.png', 100, 100) };
    });
    assert(ovRes.aMark[0] < 10 && ovRes.aMark[1] < 10 && ovRes.aMark[2] < 10,
      '涂抹蒙版覆盖处已填充（覆盖原文件）');
    assert(ovRes.aBody[0] > 240 && ovRes.aBody[1] < 10 && ovRes.aBody[2] < 10,
      '蒙版外红色背景未受影响');

    // ---------- 撤销 / 清空 / 重置 ----------
    await page.click('#bw-undo'); // 撤销涂抹笔迹
    const afterUndoStroke = await page.$$eval('#wm-chips .wm-chip', els => els.length);
    assert(afterUndoStroke === 1, '撤销一步后仅剩框选区域');
    await page.click('#bw-undo'); // 撤销框选
    const afterUndo = await page.$$eval('#wm-chips .wm-chip', els => els.length);
    assert(afterUndo === 0, '再次撤销后选区清空');
    assert(await page.$eval('#bw-run', el => el.disabled), '无选区时执行按钮禁用');

    await page.click('#bw-clear-all');
    const afterReset = await page.evaluate(() => ({
      files: document.getElementById('bw-files').textContent,
      empty: !document.getElementById('wm-empty').hidden
    }));
    assert(/未选择图片/.test(afterReset.files) && afterReset.empty, '重置后回到初始状态');

    await browser.close();
  } finally {
    await browser.close().catch(() => {});
  }
  checker.finish();
}).catch(e => { console.error('脚本异常:', e && e.message || e); process.exit(2); });
