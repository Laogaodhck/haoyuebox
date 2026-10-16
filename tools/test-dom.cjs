/* ============================================================
 * test-dom.cjs — jsdom 冒烟测试
 * 起本地静态服务后加载 index.html 及全部外链脚本，捕获引导期错误。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createChecker, withServer } = require('./_lib.cjs');

const ROOT = path.join(__dirname, '..');
const PORT = 8439;
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  const msg = String(e.detail && e.detail.stack || e.message || e);
  errors.push(msg.split('\n')[0]);
});
vc.on('error', (m) => errors.push('console.error: ' + m));

const checker = createChecker();
const assert = checker.assert;

withServer(PORT, async () => {
  const dom = await JSDOM.fromURL('http://localhost:' + PORT + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    virtualConsole: vc,
    pretendToBeVisual: true
  });

  // jsdom 没有 canvas 2D 上下文，getContext 返回 null 时不要让引导期崩掉
  const win = dom.window;
  const origGetContext = win.HTMLCanvasElement.prototype.getContext;
  win.HTMLCanvasElement.prototype.getContext = function (type) {
    try {
      const ctx = origGetContext.call(this, type);
      if (ctx) return ctx;
    } catch (e) { /* ignore */ }
    return null;
  };

  await new Promise((r) => setTimeout(r, 1500)); // 等外链脚本执行完
  const doc = win.document;

  /* tasks-vision 1.x 的 IIFE 构建挂 window.Vision（旧版 0.10.x 为 __mpVision） */
  const mp = win.Vision || win.__mpVision;
  assert(!!mp, 'MediaPipe IIFE 已挂载 window.Vision');
  assert(mp && !!mp.FilesetResolver, 'FilesetResolver 已导出');
  assert(mp && !!mp.ImageSegmenter, 'ImageSegmenter 已导出');
  assert(Array.isArray(win.SPECS) && win.SPECS.length === 8, 'SPECS 8 个规格');
  assert(typeof win.DpiUtil.setPngDpi === 'function', 'DpiUtil 就绪');
  assert(typeof win.Matting.segment === 'function', 'Matting 就绪');
  assert(typeof win.Composer.compositeInto === 'function', 'Composer 就绪');
  assert(typeof win.Brush.attach === 'function', 'Brush 就绪');
  assert(typeof win.Brush.restoreMask === 'function', 'Brush.restoreMask 就绪（撤销用单通道快照）');
  assert(typeof win.MatteView.attach === 'function', 'MatteView 就绪');
  assert(typeof win.Cropper.attach === 'function', 'Cropper 就绪');
  assert(win.App && typeof win.App.showModule === 'function', 'App 核心状态就绪');
  ['ui', 'photo', 'sheet', 'print', 'settings', 'convert', 'compose', 'batchFormat', 'batchWatermark', 'archive', 'printBatch'].forEach(function (m) {
    assert(!!win.App && typeof win.App[m] === 'object', 'App.' + m + ' 命名空间已注册');
  });
  assert(typeof win.App.sheet.init === 'function' && typeof win.App.print.init === 'function',
    'App.sheet / App.print 引导函数就绪');
  assert(typeof win.App.settings.save === 'function' && typeof win.App.photo.makeSingleCanvas === 'function',
    'App.settings.save / App.photo.makeSingleCanvas 可用');
  assert(!!doc.getElementById('dropzone'), '上传区存在');
  assert(!!doc.getElementById('matte-view'), '抠图画布存在');
  assert(!!doc.getElementById('mv-zoom-in') && !!doc.getElementById('mv-zoom-out') && !!doc.getElementById('mv-zoom-fit'), '缩放工具栏存在');
  assert(!!doc.getElementById('mv-zoom-label'), '缩放百分比标签存在');
  assert(!!doc.getElementById('crop-view'), '裁剪画布存在');
  assert(doc.querySelectorAll('.spec-card').length === 8, '规格卡片已渲染 8 张');
  assert(doc.querySelectorAll('#steps-nav .step').length === 4, '照片模块步骤指示器 4 个');
  assert(!!doc.getElementById('photo-menu'), '照片工具子功能菜单存在');
  assert(!!doc.getElementById('photo-flow'), '证照生成流程容器存在');
  assert(doc.querySelectorAll('#photo-menu .home-card').length === 4, '子功能菜单 4 张卡片（3 可用 + 1 敬请期待）');
  assert(doc.getElementById('photo-open-idphoto') && doc.getElementById('photo-open-convert') && doc.getElementById('photo-open-compose'),
    '证照生成 / 图片转换 / 图片合成入口存在');
  assert(!!doc.getElementById('photo-convert') && !!doc.getElementById('photo-compose'), '图片转换 / 图片合成面板存在');
  assert(doc.querySelectorAll('#batch-menu .home-card').length === 4, '批量工具菜单 4 张卡片（3 可用 + 1 敬请期待）');
  assert(doc.getElementById('batch-open-rename') && doc.getElementById('batch-open-watermark') && doc.getElementById('batch-open-format'),
    '批量重命名 / 去除水印 / 格式转换入口存在');
  assert(!!doc.getElementById('batch-format') && !!doc.getElementById('batch-watermark'), '格式转换 / 去除水印面板存在');
  assert(doc.querySelectorAll('#batch-format select, #batch-watermark select').length === 5, '两个新面板下拉共 5 个');
  ['bf-pick', 'bf-run', 'bf-back', 'bf-quality', 'bf-bg', 'bf-pdf-merge', 'bf-out', 'bf-list', 'bf-empty',
   'bw-pick', 'bw-run', 'bw-back', 'bw-mode', 'bw-strength', 'bw-color', 'bw-out', 'bw-undo', 'bw-clear', 'bw-clear-all', 'wm-chips'
  ].forEach(function (id) {
    assert(!!doc.getElementById(id), '控件 #' + id + ' 存在');
  });
  assert(!!doc.getElementById('wm-canvas') && !!doc.getElementById('wm-empty'), '水印预览画布与空态存在');
  assert(doc.querySelectorAll('#archive-menu .home-card').length === 3, '压缩工具菜单 3 张卡片（2 可用 + 1 敬请期待）');
  assert(doc.getElementById('archive-open-compress') && doc.getElementById('archive-open-extract'),
    '压缩文件 / 解压文件入口存在');
  assert(!!doc.getElementById('archive-compress') && !!doc.getElementById('archive-extract'), '压缩 / 解压面板存在');
  ['ac-pick-files', 'ac-pick-dir', 'ac-count', 'ac-unsupported', 'ac-fmt', 'ac-level', 'ac-pass-btn', 'ac-encnames',
   'ac-encnames-row', 'ac-note', 'ac-clear', 'ac-run', 'ac-progress', 'ac-back', 'ac-list', 'ac-table', 'ac-empty',
   'ax-pick', 'ax-count', 'ax-unsupported', 'ax-out', 'ax-pass-btn', 'ax-clear', 'ax-run', 'ax-progress',
   'ax-back', 'ax-list', 'ax-table', 'ax-empty', 'ax-result',
   'pass-dlg', 'pass-dlg-input', 'pass-dlg-ok', 'pass-dlg-cancel', 'pass-dlg-clear'
  ].forEach(function (id) {
    assert(!!doc.getElementById(id), '压缩工具控件 #' + id + ' 存在');
  });
  assert(doc.querySelector('#ac-fmt option[value="7z"]') && doc.querySelector('#ac-fmt option[value="zip"]'),
    '输出格式下拉含 7z / ZIP');
  assert(doc.querySelector('#ac-level option[value="normal"]') && doc.querySelector('#ax-out option[value="sub"]'),
    '压缩等级 / 解压位置选项齐备');
  assert(doc.querySelectorAll('#print-menu .home-card').length === 3, '打印工具菜单 3 张卡片（1 可用 + 2 敬请期待）');
  assert(!!doc.getElementById('print-open-batch'), '批量打印入口存在');
  assert(!!doc.getElementById('print-batch') && !!doc.getElementById('pb-img') && !!doc.getElementById('pd-doc'),
    '批量打印面板与 图片/文档 两子面板存在');
  ['pb-tab-img', 'pb-tab-doc', 'pb-pick', 'pb-count', 'pb-unsupported', 'pb-printer', 'pb-paper', 'pb-orient',
   'pb-margin', 'pb-duplex', 'pb-copies', 'pb-clear', 'pb-run', 'pb-status', 'pb-back', 'pb-grid', 'pb-empty', 'pb-check-all',
   'pd-pick', 'pd-count', 'pd-unsupported', 'pd-mode', 'pd-printer', 'pd-duplex', 'pd-copies', 'pd-note',
   'pd-clear', 'pd-run', 'pd-status', 'pd-back', 'pd-list', 'pd-table', 'pd-empty', 'pd-check-all'
  ].forEach(function (id) {
    assert(!!doc.getElementById(id), '批量打印控件 #' + id + ' 存在');
  });
  assert(doc.querySelector('#pb-duplex option[value="simplex"]')
    && doc.querySelector('#pb-duplex option[value="longEdge"]')
    && doc.querySelector('#pb-duplex option[value="shortEdge"]'), '单双面三档选项齐备（图片面板）');
  assert(doc.querySelector('#pd-mode option[value="queue"]') && doc.querySelector('#pd-mode option[value="merge"]'),
    '文档打印两种模式选项齐备');
  assert(doc.querySelector('script[src="vendor/print/pdf-adapter.mjs"]')
    && doc.querySelector('script[src="vendor/print/mammoth.browser.min.js"]')
    && doc.querySelector('script[src="js/print-batch.js"]'), 'pdf.js / mammoth / print-batch 脚本已引入');
  assert(doc.querySelectorAll('#sheet-steps-nav .step').length === 4, '排版模块步骤指示器 4 个');
  assert(doc.getElementById('sheetstep-print'), '排版第 4 步打印面板存在');
  const paperSel = doc.getElementById('sheet-paper');
  assert(paperSel && paperSel.options.length === 5, '相纸下拉 5 种（A4/B5/A5/A3/六寸）');
  assert(paperSel && paperSel.value === 'a4', '相纸默认 A4');
  assert(doc.getElementById('print-paper') && doc.getElementById('print-paper').options.length === 6, '打印纸张下拉 6 种');
  assert(doc.getElementById('step-upload').classList.contains('active'), '默认显示上传步骤');

  // app.js 引导错误（排除 mediapipe 对 jsdom 缺失 API 的抱怨）
  const appErrors = errors.filter(e => !/OffscreenCanvas|Worker|WebGL|createImageBitmap|VideoFrame|ImageDecoder|MediaStream/i.test(e));
  assert(appErrors.length === 0, '无引导期脚本错误' + (appErrors.length ? '：' + appErrors.join(' | ') : ''));

  win.close();
}).then(checker.finish, e => { console.error('脚本异常:', e && e.message || e); process.exit(2); });
