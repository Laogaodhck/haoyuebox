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
  ['ui', 'photo', 'sheet', 'print', 'settings', 'convert', 'compose', 'batchFormat', 'batchWatermark', 'archive', 'printBatch', 'docsOcr'].forEach(function (m) {
    assert(!!win.App && typeof win.App[m] === 'object', 'App.' + m + ' 命名空间已注册');
  });
  assert(win.Tesseract && typeof win.Tesseract.createWorker === 'function', 'Tesseract OCR 引擎脚本已加载');
  assert(typeof win.App.sheet.init === 'function' && typeof win.App.print.init === 'function',
    'App.sheet / App.print 引导函数就绪');
  assert(typeof win.App.settings.save === 'function' && typeof win.App.photo.makeSingleCanvas === 'function',
    'App.settings.save / App.photo.makeSingleCanvas 可用');
  assert(!!doc.getElementById('dropzone'), '上传区存在');
  assert(!!doc.getElementById('matte-view'), '抠图画布存在');
  assert(!!doc.getElementById('whiten-range') && !!doc.getElementById('whiten-val') && !!doc.getElementById('whiten-field'),
    '皮肤美白滑块与数值标签存在');
  assert(!!doc.getElementById('tilt-range') && !!doc.getElementById('tilt-val') && !!doc.getElementById('tilt-field'),
    '人像倾斜校正滑块与数值标签存在');
  assert(!!doc.getElementById('btn-tilt-reset'), '倾斜回正按钮存在');
  assert(!!doc.getElementById('mv-zoom-in') && !!doc.getElementById('mv-zoom-out') && !!doc.getElementById('mv-zoom-fit'), '缩放工具栏存在');
  assert(!!doc.getElementById('mv-zoom-label'), '缩放百分比标签存在');
  assert(!!doc.getElementById('crop-view'), '裁剪画布存在');
  assert(doc.querySelectorAll('.spec-card').length === 8, '规格卡片已渲染 8 张');
  assert(doc.querySelectorAll('#steps-nav .step').length === 4, '照片模块步骤指示器 4 个');
  assert(!!doc.getElementById('photo-menu'), '照片工具子功能菜单存在');
  assert(!!doc.getElementById('photo-flow'), '证照生成流程容器存在');
  assert(doc.querySelectorAll('#photo-menu .home-card').length === 6, '照片工具菜单 6 张卡片（4 可用 + 2 敬请期待，含证照打印）');
  assert(doc.getElementById('photo-open-idphoto') && doc.getElementById('photo-open-convert') && doc.getElementById('photo-open-compose'),
    '证照生成 / 图片转换 / 图片合成入口存在');
  assert(!!doc.getElementById('photo-convert') && !!doc.getElementById('photo-compose'), '图片转换 / 图片合成面板存在');
  assert(doc.querySelectorAll('#batch-menu .home-card').length === 6, '批量工具菜单 6 张卡片（5 可用 + 1 敬请期待，含批量打印）');
  assert(doc.getElementById('batch-open-rename') && doc.getElementById('batch-open-watermark') && doc.getElementById('batch-open-format'),
    '批量重命名 / 去除水印 / 格式转换入口存在');
  assert(!!doc.getElementById('batch-format') && !!doc.getElementById('batch-watermark'), '格式转换 / 去除水印面板存在');
  assert(doc.querySelectorAll('#batch-format select, #batch-watermark select').length === 5, '两个新面板下拉共 5 个');
  ['bf-pick', 'bf-run', 'bf-back', 'bf-quality', 'bf-bg', 'bf-pdf-merge', 'bf-out', 'bf-list', 'bf-empty',
   'bw-pick', 'bw-run', 'bw-back', 'bw-mode', 'bw-strength', 'bw-color', 'bw-out', 'bw-undo', 'bw-clear', 'bw-clear-all', 'wm-chips',
   'bw-files', 'bw-tools', 'bw-tool-rect', 'bw-tool-brush', 'bw-tool-erase', 'bw-brush-row', 'bw-brush-size',
   'photo-open-restore', 'soon-photo-back', 'photo-open-idphotoprint', 'soon-print-back',
   'batch-open-printbatch', 'batch-open-addwm', 'soon-batch-back',
   'print-open-docs', 'print-open-convert', 'print-open-pdf', 'print-open-ocr', 'print-open-watermark',
   'do-pick', 'do-file', 'do-count', 'do-empty', 'do-clear', 'do-lang', 'do-run', 'do-status',
   'do-back', 'do-text', 'do-meta', 'do-copy', 'do-txt', 'do-docx', 'do-empty-hint'
  ].forEach(function (id) {
    assert(!!doc.getElementById(id), '控件 #' + id + ' 存在');
  });
  assert(!!doc.getElementById('wm-canvas') && !!doc.getElementById('wm-empty'), '水印预览画布与空态存在');
  ['photo-soon', 'print-soon', 'batch-soon', 'system-soon'].forEach(function (id) {
    var el = doc.getElementById(id);
    assert(!!el && el.hidden, '占位页 #' + id + ' 存在且默认隐藏');
  });
  assert(doc.getElementById('ac-drop').classList.contains('drop-zone')
    && doc.getElementById('ax-drop').classList.contains('drop-zone'),
    '压缩/解压面板顶部为实体拖拽框');
  assert(doc.getElementById('ac-drop').previousElementSibling === null
    && /待压缩内容/.test(doc.getElementById('ac-drop').nextElementSibling.textContent)
    && /待解压文件/.test(doc.getElementById('ax-drop').nextElementSibling.textContent),
    '拖拽框位于内容区列表上方');
  assert(doc.querySelector('#bw-tool-rect.active') && !doc.querySelector('#bw-tool-brush.active'),
    '水印工具默认选中「框选」');
  assert(doc.querySelectorAll('#archive-menu .home-card').length === 4, '压缩工具菜单 4 张卡片（3 可用 + 1 敬请期待）');
  assert(!!doc.getElementById('ai-card') && !!doc.getElementById('ai-badge') && !!doc.getElementById('ai-apply') && !!doc.getElementById('ai-restore'),
    '压缩包图标卡片与按钮存在');
  assert(doc.getElementById('archive-open-compress') && doc.getElementById('archive-open-extract'),
    '压缩文件 / 解压文件入口存在');
  assert(!!doc.getElementById('archive-compress') && !!doc.getElementById('archive-extract'), '压缩 / 解压面板存在');
  ['ac-pick-files', 'ac-pick-dir', 'ac-count', 'ac-unsupported', 'ac-fmt', 'ac-level', 'ac-pass-btn', 'ac-encnames',
   'ac-encnames-row', 'ac-note', 'ac-clear', 'ac-run', 'ac-progress', 'ac-back', 'ac-list', 'ac-table', 'ac-empty', 'ac-drop',
   'ax-pick', 'ax-count', 'ax-unsupported', 'ax-out', 'ax-pass-btn', 'ax-clear', 'ax-run', 'ax-progress',
   'ax-back', 'ax-list', 'ax-table', 'ax-empty', 'ax-result', 'ax-drop',
   'pass-dlg', 'pass-dlg-input', 'pass-dlg-ok', 'pass-dlg-cancel', 'pass-dlg-clear'
  ].forEach(function (id) {
    assert(!!doc.getElementById(id), '压缩工具控件 #' + id + ' 存在');
  });
  assert(doc.querySelector('#ac-fmt option[value="7z"]') && doc.querySelector('#ac-fmt option[value="zip"]'),
    '输出格式下拉含 7z / ZIP');
  assert(doc.querySelector('#ac-level option[value="normal"]') && doc.querySelector('#ax-out option[value="sub"]'),
    '压缩等级 / 解压位置选项齐备');
  assert(doc.querySelectorAll('#print-menu .home-card').length === 5, '文档工具菜单 5 张卡片');
  assert(doc.querySelectorAll('#print-menu .hc-badge.soon').length === 0,
    '文档工具五张卡片全部可用（无敬请期待占位）');
  assert(doc.querySelector('#print-open-docs .hc-badge:not(.soon)')
    && doc.querySelector('#print-open-watermark .hc-badge:not(.soon)')
    && doc.querySelector('#print-open-convert .hc-badge:not(.soon)')
    && doc.querySelector('#print-open-pdf .hc-badge:not(.soon)')
    && doc.querySelector('#print-open-ocr .hc-badge:not(.soon)'), '文档打印/加水印/转换/PDF 工具/OCR 卡片已标记为可用');
  assert(!!doc.getElementById('print-open-docs') && !!doc.getElementById('batch-open-printbatch'),
    '文档打印入口与批量打印（批量工具）入口存在');
  assert(!!doc.getElementById('print-batch') && !!doc.getElementById('pb-img') && !!doc.getElementById('pd-doc'),
    '批量打印面板与 图片/文档 两子面板存在');
  ['pb-pick', 'pb-count', 'pb-unsupported', 'pb-printer', 'pb-paper', 'pb-orient',
   'pb-margin', 'pb-duplex', 'pb-copies', 'pb-clear', 'pb-run', 'pb-status', 'pb-back', 'pb-grid', 'pb-empty', 'pb-check-all',
   'dw-pick', 'dw-file', 'dw-count', 'dw-empty', 'dw-clear', 'dw-tab-text', 'dw-tab-image',
   'dw-text-rows', 'dw-text', 'dw-size', 'dw-size-v', 'dw-color', 'dw-img-rows', 'dw-img-pick',
   'dw-img-file', 'dw-img-name', 'dw-img-scale', 'dw-img-scale-v', 'dw-opacity', 'dw-opacity-v',
   'dw-rotate', 'dw-rotate-v', 'dw-pos', 'dw-cols', 'dw-dir', 'dw-dir-name', 'dw-run', 'dw-status',
   'dw-back', 'dw-canvas', 'dw-preview-hint', 'dw-list',
   'dc-pick', 'dc-file', 'dc-count', 'dc-empty', 'dc-clear', 'dc-tab-p2i', 'dc-tab-i2p', 'dc-tab-w2p',
   'dc-p2i', 'dc-p2i-fmt', 'dc-p2i-scale', 'dc-i2p', 'dc-i2p-paper', 'dc-i2p-merge', 'dc-w2p',
   'dc-dir', 'dc-dir-name', 'dc-run', 'dc-status', 'dc-back', 'dc-list',
   'dp-pick', 'dp-file', 'dp-count', 'dp-empty', 'dp-clear', 'dp-list', 'dp-tab-merge', 'dp-tab-split',
   'dp-tab-shrink', 'dp-merge', 'dp-split', 'dp-split-range', 'dp-shrink', 'dp-shrink-quality',
   'dp-shrink-scale', 'dp-dir', 'dp-dir-name', 'dp-run', 'dp-status', 'dp-back', 'dp-results',
   'pd-pick', 'pd-count', 'pd-unsupported', 'pd-mode', 'pd-printer', 'pd-duplex', 'pd-copies', 'pd-note',
   'pd-clear', 'pd-run', 'pd-status', 'pd-back', 'pd-list', 'pd-table', 'pd-empty', 'pd-check-all'
  ].forEach(function (id) {
    assert(!!doc.getElementById(id), '批量打印/文档加水印控件 #' + id + ' 存在');
  });
  assert(win.App.docsWatermark && typeof win.App.docsWatermark.enter === 'function',
    'App.docsWatermark 模块已注册（文档加水印）');
  assert(win.App.docsConvert && typeof win.App.docsConvert.enter === 'function'
    && win.App.docsPdf && typeof win.App.docsPdf.enter === 'function'
    && win.App.pdfcore && typeof win.App.pdfcore.parsePageRanges === 'function',
    'App.docsConvert / App.docsPdf / App.pdfcore 模块已注册');
  assert(doc.querySelector('script[src="js/pdfcore.js"]')
    && doc.querySelector('script[src="js/docs-convert.js"]')
    && doc.querySelector('script[src="js/docs-pdf.js"]'), 'pdfcore / docs-convert / docs-pdf 脚本已引入');
  assert(doc.querySelector('#pb-duplex option[value="simplex"]')
    && doc.querySelector('#pb-duplex option[value="longEdge"]')
    && doc.querySelector('#pb-duplex option[value="shortEdge"]'), '单双面三档选项齐备（图片面板）');
  assert(doc.querySelector('#pd-mode option[value="queue"]') && doc.querySelector('#pd-mode option[value="merge"]'),
    '文档打印两种模式选项齐备');
  assert(doc.querySelector('script[src="vendor/print/pdf-adapter.mjs"]')
    && doc.querySelector('script[src="vendor/print/mammoth.browser.min.js"]')
    && doc.querySelector('script[src="js/print-batch.js"]'), 'pdf.js / mammoth / print-batch 脚本已引入');
  assert(doc.querySelector('.module-tab[data-module="system"]') && !!doc.getElementById('home-system'),
    '系统工具模块标签与首页卡片存在');
  assert(doc.querySelectorAll('#system-menu .home-card').length === 5, '系统工具菜单 5 张卡片（2 敬请期待 + 3 可用）');
  assert(doc.querySelector('#system-open-network .hc-badge:not(.soon)')
    && doc.querySelector('#system-open-printer .hc-badge:not(.soon)')
    && doc.querySelector('#system-open-settings .hc-badge:not(.soon)'), '网络检测/添加打印机/设置卡片已标记为可用');
  ['system-open-uninstall', 'system-open-cleanup', 'system-open-network', 'system-open-printer',
   'system-open-settings', 'soon-system-back', 'set-back',
   'system-settings', 'set-theme', 'set-start', 'set-reset', 'set-storage', 'set-ver', 'set-mode',
   'system-net', 'net-ifaces', 'net-probe-btn', 'net-results', 'net-summary', 'net-browser-hint',
   'system-printer', 'printer-list', 'printer-test-select', 'printer-wizard-btn',
   'printer-settings-btn', 'printer-refresh-btn', 'printer-test-btn', 'printer-browser-hint',
   'back-system-net', 'back-system-printer'
  ].forEach(function (id) {
    assert(!!doc.getElementById(id), '系统工具入口/控件 #' + id + ' 存在');
  });
  assert(doc.querySelector('#set-theme option[value="light"]') && doc.querySelector('#set-start option[value="last"]'),
    '设置面板主题/启动模块选项齐备');
  assert(win.App.system && typeof win.App.system.enterNet === 'function'
    && typeof win.App.system.enterPrinter === 'function', 'App.system 模块已注册（网络检测/添加打印机）');
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
