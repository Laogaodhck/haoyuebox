/* verify-sheet-save.cjs — 排版保存真机验证：
   多页排版只产生一次下载（单 ZIP 压缩包），单页仍为单个 PNG */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChecker, sleep, resolvePhoto, launchBrowser, withServer } = require('./_lib.cjs');

const PORT = 8437;
const PHOTO = resolvePhoto();
const checker = createChecker();
const assert = checker.assert;

withServer(PORT, async (port) => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const downloads = [];
    page.on('download', d => downloads.push(d));

    await page.goto('http://localhost:' + port + '/');
    await page.click('#home-sheet');                 // 进入排版模块
    await page.setInputFiles('#sheet-file-input', PHOTO);
    await sleep(1500);
    await page.click('#btn-sheet-to-import');
    await page.click('#btn-sheet-to-preview');
    await sleep(400);

    /* ---------- 场景 A：单页（1 张照片 × 1 份，A4 容量 49 格） → 仍为单个 PNG ---------- */
    const clickAndSave = async () => {
      downloads.length = 0;
      await page.click('#btn-download-laysheet');
      await sleep(900);                              // 等待编码/打包与下载事件
      return downloads;
    };

    let dl = await clickAndSave();
    assert(dl.length === 1, '单页排版：仅弹出 1 次下载（实际 ' + dl.length + ' 次）');
    const singleName = dl.length ? dl[0].suggestedFilename() : '';
    assert(/\.png$/.test(singleName) && singleName.includes('排版'), '单页文件名为 PNG：' + singleName);

    /* ---------- 场景 B：多页（六寸 10 格/版 × 导入 6 张 × 每张 4 份 = 24 格） → 单 ZIP ---------- */
    await page.click('#btn-sheet-back-import');      // 预览 → 导入步
    await page.setInputFiles('#sheet-file-input', [PHOTO, PHOTO, PHOTO, PHOTO, PHOTO]);  // 累加导入 5 张
    await sleep(2500);
    await page.$eval('#sheet-paper', (el, v) => { el.value = v; el.dispatchEvent(new Event('change')); }, '6inch');
    await page.$eval('#sheet-count', (el, v) => { el.value = v; el.dispatchEvent(new Event('change')); }, '4');
    await page.click('#btn-sheet-to-preview');
    await sleep(600);
    const info = await page.$eval('#sheet-info', el => el.textContent);
    const pages = (info.match(/分 (\d+) 页/) || [])[1];
    assert(pages && +pages >= 2, '多页排版已生效（' + info.slice(info.indexOf('· 分')) + '）');

    dl = await clickAndSave();
    assert(dl.length === 1, '多页排版：仅弹出 1 次下载（修复前每页各弹 1 次，共 ' + pages + ' 次）');
    const zipName = dl.length ? dl[0].suggestedFilename() : '';
    assert(/\.zip$/.test(zipName) && zipName.includes('排版') && zipName.includes(pages + '页'),
      '多页文件名为 ZIP 且含页数：' + zipName);

    const tmp = path.join(os.tmpdir(), 'zunhong-sheet-save.zip');
    if (dl.length) {
      await dl[0].saveAs(tmp);
      const head = fs.readFileSync(tmp).subarray(0, 4).toString('latin1');
      assert(head === 'PK\x03\x04', 'ZIP 文件魔数正确（PK\x03\x04）');
      fs.rmSync(tmp, { force: true });
    }

    assert(pageErrors.length === 0, '无页面脚本错误' + (pageErrors.length ? '：' + pageErrors.join(' | ') : ''));
  } finally {
    await browser.close();
  }
}).then(checker.finish, e => { console.error('脚本异常:', e && e.message || e); process.exit(2); });
