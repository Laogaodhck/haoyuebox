/* ============================================================
 * verify-hair.cjs — 头发/白衣服增强 真机验证
 * 真实照片走完整本地 AI 流程，切红底后统计：
 *   1. 四角为背景（不外溢）
 *   2. 整体前景占比合理
 *   3. 头发带（0.12–0.32H）前景占比达标（增强后不被切掉）
 *   4. 衣服带（0.55–0.95H）前景占比达标（白衣服不被裁）
 *   5. 发丝混色净化只作用于半透明轮廓像素、且不向原背景色靠拢
 *   6. 管线无脚本错误
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { createChecker, sleep, resolvePhoto, launchBrowser, withServer } = require('./_lib.cjs');

const PORT = 8433;
const PHOTO = resolvePhoto();
const checker = createChecker();
const assert = checker.assert;

withServer(PORT, async (port) => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));

    const t0 = Date.now();
    await page.goto('http://localhost:' + port + '/');
    await page.click('#home-photo');
    await page.click('#photo-open-idphoto'); // 进入「证照生成」子功能
    await page.setInputFiles('#file-input', PHOTO);
    await page.waitForSelector('#step-matte.active', { timeout: 90000 });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('  (管线耗时 ' + elapsed + 's)');

    // 切红底：前景=非纯红像素，背景=纯红
    await page.click('.swatch[data-color="#FF0000"]');
    await sleep(300);

    const stats = await page.evaluate(() => {
      const c = document.getElementById('matte-view');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const W = c.width, H = c.height;
      const isRed = (i) => d[i * 4] === 255 && d[i * 4 + 1] === 0 && d[i * 4 + 2] === 0;
      function bandRatio(y0f, y1f, x0f, x1f) {
        let fg = 0, n = 0;
        const y0 = Math.round(H * y0f), y1 = Math.round(H * y1f);
        const x0 = Math.round(W * x0f), x1 = Math.round(W * x1f);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          n++; if (!isRed(y * W + x)) fg++;
        }
        return n ? fg / n : 0;
      }
      return {
        corner: [isRed(0), isRed(W - 1), isRed((H - 1) * W), isRed(H * W - 1)],
        total: bandRatio(0, 1, 0, 1),
        hairBand: bandRatio(0.12, 0.32, 0.25, 0.75),
        clothesBand: bandRatio(0.55, 0.95, 0.15, 0.85),
        topEdge: bandRatio(0, 0.04, 0, 1)   // 顶边应基本是背景
      };
    });
    console.log('  统计:', JSON.stringify(stats));

    assert(stats.corner.every(v => v), '四角均为背景（红色）');
    assert(stats.total > 0.08 && stats.total < 0.85, '整体前景占比合理（' + (stats.total * 100).toFixed(1) + '%）');
    assert(stats.hairBand > 0.15, '头发带前景占比 ' + (stats.hairBand * 100).toFixed(1) + '% ≥ 15%（发丝保留）');
    assert(stats.clothesBand > 0.25, '衣服带前景占比 ' + (stats.clothesBand * 100).toFixed(1) + '% ≥ 25%（衣服完整）');
    assert(stats.topEdge < 0.5, '顶边背景不被误吞（' + (stats.topEdge * 100).toFixed(1) + '%）');
    const detail = await page.evaluate(() => {
      const s = App.State, w = s.maskCanvas.width, h = s.maskCanvas.height;
      const snap = Brush.snapMask(s);
      const scratch = document.createElement('canvas');
      scratch.width = w; scratch.height = h;
      Brush.restoreMask({ maskCanvas: scratch }, snap);
      const restored = Brush.snapMask({ maskCanvas: scratch });
      let soft = 0, facePixels = 0, faceOpaque = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const a = snap.alpha[y * w + x];
        if (a > 0 && a < 255) soft++;
        if (x > w * 0.43 && x < w * 0.57 && y > h * 0.40 && y < h * 0.53) {
          facePixels++;
          if (a === 255) faceOpaque++;
        }
      }
      scratch.getContext('2d').drawImage(s.originalImg, 0, 0, w, h);
      const original = scratch.getContext('2d').getImageData(0, 0, w, h).data;
      const work = s.workCanvas.getContext('2d').getImageData(0, 0, w, h).data;
      const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + w - 1) * 4];
      const ref = [0, 1, 2].map(ch => corners.reduce((sum, o) => sum + original[o + ch], 0) / 4);
      let changed = 0, opaqueChange = 0, towardBg = 0, shiftSum = 0;
      let towardLocal = 0, localSum = 0, localSamples = 0;
      const d = (data, p, r) => Math.abs(data[p] - r[0]) + Math.abs(data[p + 1] - r[1]) + Math.abs(data[p + 2] - r[2]);
      const localBg = (x, y) => {
        let sum = [0, 0, 0], n = 0;
        for (let yy = Math.max(0, y - 8); yy <= Math.min(h - 1, y + 8); yy++) {
          for (let xx = Math.max(0, x - 8); xx <= Math.min(w - 1, x + 8); xx++) {
            const idx = yy * w + xx;
            if (snap.alpha[idx] !== 0) continue;
            const p = idx * 4;
            sum[0] += original[p]; sum[1] += original[p + 1]; sum[2] += original[p + 2]; n++;
          }
        }
        return n >= 20 ? sum.map(v => v / n) : null;
      };
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, o = i * 4;
        if (original[o] === work[o] && original[o + 1] === work[o + 1] && original[o + 2] === work[o + 2]) continue;
        changed++;
        if (snap.alpha[i] === 255) opaqueChange++;
        const delta = d(work, o, ref) - d(original, o, ref);
        shiftSum += delta;
        if (delta < 0) towardBg++;
        const lb = localBg(x, y);
        if (lb) {
          localSamples++;
          const dl = d(work, o, lb) - d(original, o, lb);
          localSum += dl;
          if (dl < 0) towardLocal++;
        }
      }
      return {
        soft, total: w * h, faceOpaque: faceOpaque / facePixels,
        exactRestore: restored.alpha.every((a, i) => a === snap.alpha[i]),
        compact: snap.alpha instanceof Uint8Array && snap.alpha.byteLength === w * h,
        changed, opaqueChange, towardBg, towardLocal, localSamples,
        shiftAvg: shiftSum / Math.max(1, changed),
        localAvg: localSum / Math.max(1, localSamples)
      };
    });
    console.log('  发丝净化:', JSON.stringify(detail));
    assert(detail.soft > 0 && detail.soft / detail.total < 0.05, '只有少量轮廓像素为连续 alpha（' + detail.soft + ' 像素）');
    assert(detail.faceOpaque > 0.99, '正面样片脸部核心保持不透明');
    assert(detail.exactRestore && detail.compact, '单通道快照逐字节还原含半透明发丝的蒙版');
    assert(detail.changed > 0, '发丝边缘混色已净化（' + detail.changed + ' 像素）');
    assert(detail.opaqueChange === 0, '颜色净化只作用于半透明轮廓像素，不动主体与原背景');
    assert(detail.localAvg > 100 && detail.towardLocal < detail.localSamples * 0.005,
      '净化后的发丝像素远离其局部背景色（均值 +' + detail.localAvg.toFixed(0) + '，例外 ' +
      detail.towardLocal + '/' + detail.localSamples + '）');
    assert(detail.localAvg > 100, '发丝像素平均远离局部背景 ' + detail.localAvg.toFixed(0) + '（L1）');
    assert(detail.changed / detail.total < 0.03, '改动仍限于发丝窄带（占比 ' + (detail.changed / detail.total * 100).toFixed(2) + '%）');

    for (const [color, rgb] of [['#FFFFFF', [255, 255, 255]], ['#FF0000', [255, 0, 0]], ['#438EDB', [67, 142, 219]]]) {
      await page.click('.swatch[data-color="' + color + '"]');
      const corner = await page.$eval('#matte-view', c => Array.from(c.getContext('2d').getImageData(0, 0, 1, 1).data));
      assert(rgb.every((v, i) => v === corner[i]), color + ' 换底正常且不残留原背景');
    }
    const comparison = await page.evaluate(() => {
      const s = App.State, w = s.workCanvas.width, h = s.workCanvas.height;
      const c = document.createElement('canvas');
      c.width = w * 4; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(s.workCanvas, 0, 0);
      ['#FFFFFF', '#FF0000', '#438EDB'].forEach((bg, i) => {
        ctx.save(); ctx.translate((i + 1) * w, 0);
        Composer.compositeInto(ctx, w, h, Object.assign({}, s, { bg, transform: { scale: 1, tx: 0, ty: 0 } }));
        ctx.restore();
      });
      return c.toDataURL();
    });
    fs.writeFileSync(path.join(__dirname, '_verify-precision.png'), Buffer.from(comparison.split(',')[1], 'base64'));
    await page.click('#btn-to-spec');
    await page.click('#btn-to-export');
    const consistent = await page.evaluate(() => App.photo.makeSingleCanvas().toDataURL() === document.getElementById('export-preview').toDataURL());
    assert(consistent, '成品预览与导出使用一致的半透明蒙版');
    const downloadPromise = page.waitForEvent('download');
    await page.click('#btn-download-single');
    const download = await downloadPromise;
    const exported = path.join(__dirname, '_verify-precision-single.png');
    await download.saveAs(exported);
    const png = fs.readFileSync(exported);
    let dpiOk = false;
    for (let offset = 8; offset + 12 <= png.length;) {
      const length = png.readUInt32BE(offset);
      if (png.toString('ascii', offset + 4, offset + 8) === 'pHYs') {
        dpiOk = png.readUInt32BE(offset + 8) === 11811 && png.readUInt32BE(offset + 12) === 11811 && png[offset + 16] === 1;
      }
      offset += length + 12;
    }
    assert(dpiOk, '改进后的成品可下载且保留 300DPI');
    assert(pageErrors.length === 0, '无页面脚本错误' + (pageErrors.length ? '：' + pageErrors.join(' | ') : ''));
  } finally {
    await browser.close();
  }
}).then(checker.finish, e => { console.error('脚本异常:', e && e.message || e); process.exit(2); });

