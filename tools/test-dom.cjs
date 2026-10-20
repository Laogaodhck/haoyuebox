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
  /* 设置版本化迁移框架（覆盖安装/版本更新的数据保留核心） */
  assert(win.App.settings.SCHEMA_VERSION === 2, 'App.settings.SCHEMA_VERSION === 2');
  assert(win.App.settings.versionOf({}) === 1, 'versionOf 无 v 标记视作 v1');
  assert(win.App.settings.versionOf({ v: 2 }) === 2 && win.App.settings.versionOf({ v: 'x' }) === 1,
    'versionOf 非法 v 兜底为 v1');
  (function () {
    const m = win.App.settings.migrate({ spec: 'id1', bg: '#FFFFFF', theme: 'blue', fmt: 'gif', quality: 9, whiten: 'x', startMode: 'other' });
    assert(m.v === 2, 'migrate v1 → v2 打版本标');
    assert(m.spec === 'id1' && m.bg === '#FFFFFF', 'migrate 合法字段保留');
    assert(!('theme' in m) && !('fmt' in m) && !('quality' in m) && !('whiten' in m) && !('startMode' in m),
      'migrate 非法字段清出（规范化）');
  })();
  (function () {
    const m = win.App.settings.migrate({ v: 2, spec: 'id1', extra: 'keep-out' });
    assert(m.v === 2 && m.spec === 'id1', 'migrate v2 数据原样通过');
    const hi = win.App.settings.migrate({ v: 9, spec: 'id1' });
    assert(hi.v === 9 && hi.spec === 'id1', 'migrate 未来版本不向下迁移');
  })();
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
  assert(doc.querySelectorAll('#print-menu .home-card').length === 6, '文档工具菜单 6 张卡片');
  assert(doc.querySelectorAll('#print-menu .hc-badge.soon').length === 0,
    '文档工具六张卡片全部可用（无敬请期待占位）');
  assert(doc.querySelector('#print-open-docs .hc-badge:not(.soon)')
    && doc.querySelector('#print-open-watermark .hc-badge:not(.soon)')
    && doc.querySelector('#print-open-convert .hc-badge:not(.soon)')
    && doc.querySelector('#print-open-pdf .hc-badge:not(.soon)')
    && doc.querySelector('#print-open-reader .hc-badge:not(.soon)')
    && doc.querySelector('#print-open-ocr .hc-badge:not(.soon)'), '文档打印/加水印/转换/PDF 工具/阅读器/OCR 卡片已标记为可用');
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
   'docs-reader', 'dr-pick', 'dr-file', 'dr-file-name', 'dr-prev', 'dr-page-ind', 'dr-next',
   'dr-jump', 'dr-go', 'dr-fit', 'dr-zoom-out', 'dr-zoom-val', 'dr-zoom-in', 'dr-status',
   'dr-back', 'dr-view', 'dr-canvas', 'dr-empty',
   'pd-pick', 'pd-count', 'pd-unsupported', 'pd-mode', 'pd-printer', 'pd-duplex', 'pd-copies', 'pd-note',
   'pd-clear', 'pd-run', 'pd-status', 'pd-back', 'pd-list', 'pd-table', 'pd-empty', 'pd-check-all'
  ].forEach(function (id) {
    assert(!!doc.getElementById(id), '批量打印/文档加水印控件 #' + id + ' 存在');
  });
  assert(win.App.docsWatermark && typeof win.App.docsWatermark.enter === 'function',
    'App.docsWatermark 模块已注册（文档加水印）');
  assert(win.App.docsConvert && typeof win.App.docsConvert.enter === 'function'
    && win.App.docsPdf && typeof win.App.docsPdf.enter === 'function'
    && win.App.docsReader && typeof win.App.docsReader.enter === 'function'
    && win.App.pdfcore && typeof win.App.pdfcore.parsePageRanges === 'function',
    'App.docsConvert / App.docsPdf / App.docsReader / App.pdfcore 模块已注册');
  assert(doc.querySelector('script[src="js/pdfcore.js"]')
    && doc.querySelector('script[src="js/docs-convert.js"]')
    && doc.querySelector('script[src="js/docs-pdf.js"]')
    && doc.querySelector('script[src="js/docs-reader.js"]'), 'pdfcore / docs-convert / docs-pdf / docs-reader 脚本已引入');
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
  // system.js esc()：系统返回字符串（网卡名/IP/MAC/打印机名）进入 innerHTML 前的唯一转义关口
  var escRef = win.App.system._test && win.App.system._test.escRef;
  assert(typeof escRef === 'function', 'system esc 钩子已导出');
  assert(escRef('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;', 'esc 转义 < >');
  assert(escRef('a&b"c\'d') === 'a&amp;b&quot;c&#39;d', 'esc 转义 & " \' 四字符');
  assert(escRef(null) === '' && escRef(undefined) === '' && escRef(42) === '42', 'esc 空值兜底/非字符串转串');
  // docs-pdf _test 钩子：列表排序与条目读取
  var dpTest = win.App.docsPdf._test;
  assert(dpTest && typeof dpTest.moveRef === 'function' && typeof dpTest.setItemsRef === 'function',
    'docsPdf _test 钩子已导出');
  dpTest.setItemsRef([{ file: { name: 'a.pdf' } }, { file: { name: 'b.pdf' } }]);
  assert(dpTest.listRef().length === 2, 'docsPdf listRef 返回 2 条');
  dpTest.moveRef(0, 1);
  assert(dpTest.listRef()[0].file.name === 'b.pdf' && dpTest.listRef()[1].file.name === 'a.pdf',
    'docsPdf moveRef 下移换序生效');
  dpTest.moveRef(1, -1);
  assert(dpTest.listRef()[0].file.name === 'a.pdf', 'docsPdf moveRef 上移复位生效');
  dpTest.setItemsRef([]);
  assert(dpTest.listRef().length === 0, 'docsPdf setItemsRef 清空生效');

  /* ================= 文档四件套行为测试（T1/T2：修复「只测存在性」缺口） =================
   * stub 策略：createImageBitmap / document.createElement('canvas') /
   * pdfcore IO 层 / batchFormat.buildPdf 全部替换为内存假件，
   * 只跑真实的控制流（per-file try/catch、状态行、结果列表、输出命名）。 */
  const preTestErrors = errors.length; // 记录引导期错误数：行为测试故意走失败路径（console.error）
  var $ = function (id) { return doc.getElementById(id); };
  var core = win.App.pdfcore;
  var origLoadPdf = core.loadPdf, origRenderPage = core.renderPage,
    origEncodeCanvas = core.encodeCanvas, origWriteBytes = core.writeBytes;
  var origBuildPdf = win.App.batchFormat.buildPdf;
  var origCreate = win.document.createElement.bind(win.document);
  /* jsdom 无 canvas 2D 实现（getContext 返回 null）：给假 canvas + 假 2D 上下文，
   * 让走 canvas 的真实代码路径（imageToPage 绘制）可执行而非抛 TypeError */
  var fakeCtx = {
    fillStyle: '', font: '', textBaseline: '', globalAlpha: 1,
    fillRect: function () { }, drawImage: function () { }, fillText: function () { },
    measureText: function () { return { width: 10 }; },
    save: function () { }, restore: function () { },
    translate: function () { }, rotate: function () { },
    strokeRect: function () { }, setLineDash: function () { },
    imageSmoothingEnabled: true, imageSmoothingQuality: 'high'
  };
  var fakeCanvas = function () {
    return {
      width: 0, height: 0,
      getContext: function () { return fakeCtx; },
      toBlob: function (cb) { cb({}); }
    };
  };
  win.document.createElement = function (tag) {
    if (String(tag).toLowerCase() === 'canvas') return fakeCanvas();
    return origCreate(tag);
  };
  core.encodeCanvas = async function () {
    return { arrayBuffer: async function () { return new ArrayBuffer(8); } };
  };
  win.App.batchFormat.buildPdf = function () { return new Uint8Array([1, 2, 3]); };
  win.createImageBitmap = async function (file) {
    if (file.bad) throw new Error('decode fail'); // 坏图（改扩展名的假 JPEG）
    return { width: 800, height: 600 };
  };
  /* FSA 目录句柄假件：getFileHandle(create:false) 探测存在性，语义与真实 FSA 一致 */
  function mkDir(existing) {
    return {
      name: 'stub',
      getFileHandle: function (n, opts) {
        if (existing[n]) return Promise.resolve({ name: n });
        if (opts && opts.create) { existing[n] = true; return Promise.resolve({ name: n }); }
        return Promise.reject(new Error('not found'));
      }
    };
  }

  /* ---- docs-convert 图片→PDF 合并：坏图只记失败，不葬送整批（P1-3 回归） ---- */
  var written = [];
  core.writeBytes = async function (d, n) { written.push(n); };
  var dcT = win.App.docsConvert._test;
  assert(dcT && typeof dcT.setItemsRef === 'function' && typeof dcT.runImagesToPdfRef === 'function',
    'docsConvert _test 钩子已导出（setItems/setMode/runImagesToPdf）');
  dcT.setModeRef('i2p');
  dcT.setDirRef({ name: 'stubdir' });
  dcT.setItemsRef([{ file: { name: 'ok.jpg' } }, { file: { name: 'bad.jpg', bad: true } }]);
  await dcT.runImagesToPdfRef(mkDir({}));
  assert(written.indexOf('图片合并.pdf') >= 0, 'docs-convert 合并：坏图跳过后仍生成合并 PDF');
  assert($('dc-list').querySelectorAll('.dw-list-row.bad').length === 1, 'docs-convert 合并：坏图在结果列表标记失败');
  assert($('dc-list').querySelectorAll('.dw-list-row.ok').length === 1, 'docs-convert 合并：合并 PDF 在结果列表标记成功');
  assert(/成功 1\/2/.test($('dc-status').textContent), 'docs-convert 合并：状态行如实报告 1/2（不卡死）');

  /* ---- docs-convert PDF→图片：逐页输出 + 坏文件不中断（T1 行为覆盖） ---- */
  var p2iCleanups = 0;
  core.loadPdf = async function (file) {
    if (file.name === 'broken.pdf') throw new Error('bad pdf');
    return { numPages: 2, cleanup: function () { p2iCleanups++; } };
  };
  core.renderPage = async function () { return { width: 10, height: 10 }; };
  $('dc-list').innerHTML = '';
  dcT.setModeRef('p2i');
  dcT.setItemsRef([{ file: { name: 'a.pdf' } }, { file: { name: 'broken.pdf' } }]);
  written.length = 0;
  await dcT.runPdfToImagesRef(mkDir({}));
  assert(written.indexOf('a-p1.jpg') >= 0 && written.indexOf('a-p2.jpg') >= 0,
    'docs-convert p2i：逐页输出 a-p1.jpg / a-p2.jpg');
  assert($('dc-list').querySelectorAll('.dw-list-row.bad').length === 1,
    'docs-convert p2i：坏 PDF 标记失败且不中断后续');
  assert(p2iCleanups === 1,
    'docs-convert p2i：每个成功解析的 PDF 均 cleanup（无文档句柄泄漏）');

  /* ---- docs-pdf 合并：坏 PDF 只记失败（P1-2 回归） ---- */
  var written2 = [];
  core.writeBytes = async function (d, n) { written2.push(n); };
  var mergeCleanups = 0;
  core.loadPdf = async function (file) {
    if (file.name === 'bad.pdf') throw new Error('bad pdf');
    return { numPages: 1, cleanup: function () { mergeCleanups++; } };
  };
  var dpT2 = win.App.docsPdf._test;
  assert(dpT2 && typeof dpT2.runMergeRef === 'function' && typeof dpT2.runSplitRef === 'function',
    'docsPdf _test 钩子已导出（runMerge/runSplit/setMode）');
  $('dp-results').innerHTML = '';
  dpT2.setModeRef('merge');
  dpT2.setDirRef({ name: 'stubdir' });
  dpT2.setItemsRef([{ file: { name: 'good.pdf' } }, { file: { name: 'bad.pdf' } }]);
  await dpT2.runMergeRef(mkDir({}));
  assert(written2.indexOf('合并.pdf') >= 0, 'docs-pdf 合并：坏 PDF 跳过后仍生成合并.pdf');
  assert($('dp-results').querySelectorAll('.dw-list-row.bad').length === 1, 'docs-pdf 合并：坏 PDF 标记失败');
  assert($('dp-results').querySelectorAll('.dw-list-row.ok').length === 1, 'docs-pdf 合并：合并结果标记成功');
  assert(mergeCleanups === 1,
    'docs-pdf 合并：每个成功解析的 PDF 均 cleanup（pdfToPages 无句柄泄漏）');

  /* ---- docs-pdf 拆分：页码范围提取（T2 行为覆盖） ---- */
  core.loadPdf = async function () { return { numPages: 5, cleanup: function () { } }; };
  $('dp-results').innerHTML = '';
  dpT2.setModeRef('split');
  dpT2.setItemsRef([{ file: { name: 'x.pdf' } }]);
  doc.getElementById('dp-split-range').value = '1-2';
  written2.length = 0;
  await dpT2.runSplitRef(mkDir({}));
  assert(written2.indexOf('x-提取.pdf') >= 0, 'docs-pdf 拆分：按页码范围提取生成 x-提取.pdf');
  assert($('dp-results').querySelectorAll('.dw-list-row.ok').length === 1, 'docs-pdf 拆分：结果标记成功');

  /* ---- docs-pdf 拆分：页码范围无效时不谎报「完成」 ---- */
  doc.getElementById('dp-split-range').value = 'abc';
  $('dp-results').innerHTML = '';
  written2.length = 0;
  var splitBad = await dpT2.runSplitRef(mkDir({}));
  assert(splitBad && splitBad.noSummary === true && written2.length === 0,
    'docs-pdf 拆分：页码范围无效返回 noSummary 且不产出文件（状态行不谎报完成）');

  /* ---- pdfcore.uniqueOutName：同名输出防静默覆盖（A6 回归） ---- */
  var existing = { 'a.pdf': true, 'a_1.pdf': true };
  assert(await win.App.pdfcore.uniqueOutName(mkDir(existing), 'b.pdf') === 'b.pdf',
    'uniqueOutName 无同名返回原名');
  assert(await win.App.pdfcore.uniqueOutName(mkDir(existing), 'a.pdf') === 'a_2.pdf',
    'uniqueOutName 原名与 _1 均被占用时跳到 _2');

  /* ---- print.clampCopies：份数钳制（QA-B6 行为覆盖） ---- */
  var clampCopies = win.App.print._test && win.App.print._test.clampCopiesRef;
  assert(typeof clampCopies === 'function', 'print clampCopies 钩子已导出');
  assert(clampCopies('0') === 1 && clampCopies('abc') === 1 && clampCopies('') === 1 && clampCopies('-3') === 1,
    'clampCopies 空/非法/负值 → 1');
  assert(clampCopies('5.7') === 5 && clampCopies('3') === 3, 'clampCopies 小数取整、正常值透传');
  assert(clampCopies('100') === 99 && clampCopies('999') === 99, 'clampCopies 超 99 钳到 99');

  /* ---- App.ui.icon + 排版符号退场（A7 回归：控件标识统一 SVG） ---- */
  var ic = win.App.ui.icon('x');
  assert(ic && ic.namespaceURI === 'http://www.w3.org/2000/svg'
    && ic.getAttribute('viewBox') === '0 0 24 24' && ic.getAttribute('class') === 'icon',
    'ui.icon 返回 24 视口、带 .icon 类的内联 SVG');
  assert(ic.querySelector('path') !== null, 'ui.icon 含 path 子元素');
  assert(win.App.ui.icon('up').querySelector('path').getAttribute('d')
    !== ic.querySelector('path').getAttribute('d'), 'ui.icon 不同 name 对应不同路径');
  assert(win.App.ui.icon('check').querySelector('path').getAttribute('d')
    !== ic.querySelector('path').getAttribute('d'), 'ui.icon check 为独立路径（对勾）');
  assert(win.App.ui.icon('alert').querySelectorAll('path').length === 3,
    'ui.icon alert 为多 path 三角警示图标（三角+竖线+点）');
  var warnN = 0;
  var origWarn = win.console.warn;
  win.console.warn = function () { warnN++; };
  try { win.App.ui.icon('no-such-icon'); } finally { win.console.warn = origWarn; }
  assert(warnN === 1, 'ui.icon 未知图标名时告警（不静默产出错图标）');

  /* ---- statusText：状态行文本 + SVG 标识（对勾/警示排版符号退场回归） ---- */
  var stEl = win.document.createElement('div');
  win.App.ui.statusText(stEl, '已导入 3 张', 'check');
  assert(stEl.textContent === '已导入 3 张', 'statusText 文本经 textContent 写入');
  assert(stEl.querySelector('svg.icon path') !== null
    && stEl.textContent.indexOf('\u2713') < 0, 'statusText 成功标识为 SVG 而非对勾字符');
  var stEl2 = win.document.createElement('div');
  win.App.ui.statusText(stEl2, '已导入 2 张 · 失败 1 张', 'alert');
  assert(stEl2.querySelectorAll('svg.icon path').length === 3
    && stEl2.textContent.indexOf('\u26a0') < 0, 'statusText 失败标识为三角 SVG 而非警示字符');

  /* 源码级扫描：UI 文本文件不得残留排版符号。
   * ① 控件标识符号（含导航左右箭头）：5 个 UI 模块 + 压缩/排版两个含结果行的模块；
   * ② 对勾/警示符号：全部 js + index.html（注释也算——宁可改注释表述，不留扫描盲区） */
  var SYM_UI = /\u2190\u2192\u2191\u2193\u2715\u2605\u2039\u203a\u00bb\u00ab/g;
  ['js/print.js', 'js/print-batch.js', 'js/compose.js', 'js/docs-pdf.js', 'index.html', 'js/archive.js', 'js/sheet.js']
    .forEach(function (rel) {
      var src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      var hit = src.match(SYM_UI);
      assert(!hit, rel + ' 控件标识无排版符号残留'
        + (hit ? '（剩 ' + hit.length + ' 处: ' + hit.join(' ') + '）' : ''));
    });
  var SYM_MARK = /\u2713\u26a0/g;
  fs.readdirSync(path.join(__dirname, '..', 'js'))
    .filter(function (f) { return /\.js$/.test(f); })
    .map(function (f) { return 'js/' + f; })
    .concat(['index.html'])
    .forEach(function (rel) {
      var src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      var hit = src.match(SYM_MARK);
      assert(!hit, rel + ' 状态标识无对勾/警示字符残留'
        + (hit ? '（剩 ' + hit.length + ' 处）' : ''));
    });

  /* ---- docsConvert.sanitizeRef：mammoth 输出清洗（A9 回归：XSS 纵深防御） ---- */
  var san = win.App.docsConvert._test && win.App.docsConvert._test.sanitizeRef;
  assert(typeof san === 'function', 'docsConvert sanitizeRef 钩子已导出');
  var sanHtml = san('<p onclick="alert(1)">正文</p>'
    + '<img src="data:image/png;base64,AAAA" alt="图">'
    + '<a href="javascript:alert(1)">坏链接</a><a href="https://ok.example.com">好链接</a>'
    + '<script>alert(2)</script><iframe src="https://evil.example.com"></iframe>'
    + '<div style="background:url(javascript:alert(3))">样式</div>');
  assert(sanHtml.indexOf('onclick') < 0, 'sanitize 剥离 on* 事件属性');
  assert(sanHtml.indexOf('javascript:') < 0, 'sanitize 剥离 javascript: 协议 URL');
  assert(sanHtml.indexOf('<script') < 0 && sanHtml.indexOf('<iframe') < 0, 'sanitize 移除 script/iframe 标签');
  assert(sanHtml.indexOf('url(') < 0, 'sanitize 剥离 style 内的危险表达式');
  assert(sanHtml.indexOf('正文') >= 0 && sanHtml.indexOf('样式') >= 0, 'sanitize 保留正常内容');
  assert(sanHtml.indexOf('data:image/png') >= 0, 'sanitize 放行 img 的 data:image 内嵌图');
  assert(sanHtml.indexOf('https://ok.example.com') >= 0, 'sanitize 保留 http(s) 外链文本');

  /* ---- Cropper 倾斜几何：tiltPoint / minScaleFor（覆盖表缺口收尾） ---- */
  var cropperT = win.Cropper && win.Cropper._test;
  assert(cropperT && typeof cropperT.tiltPointRef === 'function' && typeof cropperT.minScaleForRef === 'function',
    'Cropper _test 钩子已导出（tiltPoint/minScaleFor）');
  var sq = { workCanvas: { width: 200, height: 200 }, tilt: 0 };
  var p0 = cropperT.tiltPointRef(sq, 110, 90);
  assert(p0.x === 110 && p0.y === 90, 'tiltPoint 零倾斜时恒等映射');
  var sq90 = { workCanvas: { width: 200, height: 200 }, tilt: 90 };
  var p90 = cropperT.tiltPointRef(sq90, 110, 100); // 中心右侧 10px → 旋转 90° 后到中心下方 10px
  assert(Math.abs(p90.x - 100) < 1e-9 && Math.abs(p90.y - 110) < 1e-9, 'tiltPoint 90° 旋转绕工作图中心');
  var stA = { workCanvas: { width: 400, height: 300 }, tilt: 0, outW: 200, outH: 300 };
  assert(cropperT.minScaleForRef(stA) === Math.max(200 / 400, 300 / 300),
    'minScaleFor 零倾斜 = max(outW/w, outH/h)');
  var stB = { workCanvas: { width: 400, height: 300 }, tilt: 30, outW: 200, outH: 300 };
  assert(cropperT.minScaleForRef(stB) > cropperT.minScaleForRef(stA),
    'minScaleFor 倾斜后内接矩形收窄、最小缩放放大（防画框露楔形）');

  /* ---- settings：往返 / 钳制 / 旧键迁移 / 损坏容错（QA-B5 行为覆盖） ---- */
  var ls = win.localStorage;
  ls.removeItem('zunhong-toolbox-settings');
  ls.removeItem('haoyue-idphoto-settings');
  win.App.State.quality = 0.8;
  win.App.settings.save();
  win.App.State.quality = 0.3;
  win.App.settings.load();
  assert(win.App.State.quality === 0.8, 'settings save→load 往返恢复 quality');
  /* v1 旧数据（无版本标）走迁移：越界/非法字段被清出，State 保留原值不采纳 */
  win.App.State.quality = 0.8;
  win.App.State.whiten = 30;
  ls.setItem('zunhong-toolbox-settings', JSON.stringify({ quality: 2, whiten: -5, fmt: 'gif', theme: 'neon', startMode: 'nope' }));
  win.App.settings.load();
  assert(win.App.State.quality === 0.8 && win.App.State.whiten === 30,
    'settings 越界数值迁移时清出（State 保留原值）');
  assert(win.App.State.fmt !== 'gif' && win.App.State.theme !== 'neon' && win.App.State.startMode !== 'nope',
    'settings 非法枚举值不采纳（fmt/theme/startMode）');
  assert(win.App.settings.versionOf(JSON.parse(ls.getItem('zunhong-toolbox-settings'))) === 2,
    'v1 旧数据迁移后已写回 v2 结构');
  /* v2 直存路径：合法但越界的数值仍由 applyFields 钳制 */
  ls.setItem('zunhong-toolbox-settings', JSON.stringify({ v: 2, quality: 0.3, whiten: 250 }));
  win.App.settings.load();
  assert(win.App.State.quality === 0.5, 'settings quality 钳制下限 0.5');
  assert(win.App.State.whiten === 100, 'settings whiten 钳制上限 100');
  ls.removeItem('zunhong-toolbox-settings');
  ls.setItem('haoyue-idphoto-settings', JSON.stringify({ quality: 0.7 }));
  win.App.State.quality = 0.5;
  win.App.settings.load();
  assert(win.App.State.quality === 0.7, 'settings 旧品牌键（haoyue-idphoto-settings）迁移恢复');
  assert(ls.getItem('zunhong-toolbox-settings') !== null, 'settings 迁移后写入新存储键');
  ls.setItem('zunhong-toolbox-settings', '{oops');
  win.App.settings.load();
  assert(win.App.State.quality === 0.7, 'settings 损坏 JSON 容错不抛错且不改写当前值');

  /* 还原 stub，避免污染后续断言 */
  core.loadPdf = origLoadPdf; core.renderPage = origRenderPage;
  core.encodeCanvas = origEncodeCanvas; core.writeBytes = origWriteBytes;
  win.App.batchFormat.buildPdf = origBuildPdf;
  win.document.createElement = origCreate;
  delete win.createImageBitmap;
  const restoreMark = errors.length; // 行为测试窗口结束：此后的 [zunhong] 错误不再豁免
  assert(doc.querySelectorAll('#sheet-steps-nav .step').length === 4, '排版模块步骤指示器 4 个');
  assert(doc.getElementById('sheetstep-print'), '排版第 4 步打印面板存在');
  const paperSel = doc.getElementById('sheet-paper');
  assert(paperSel && paperSel.options.length === 5, '相纸下拉 5 种（A4/B5/A5/A3/六寸）');
  assert(paperSel && paperSel.value === 'a4', '相纸默认 A4');
  assert(doc.getElementById('print-paper') && doc.getElementById('print-paper').options.length === 6, '打印纸张下拉 6 种');
  assert(doc.getElementById('step-upload').classList.contains('active'), '默认显示上传步骤');

  // app.js 引导错误：一律豁免 mediapipe 对 jsdom 缺失 API 的抱怨；行为测试窗口内
  // 故意走失败路径产生的 [zunhong] console.error 由上方断言逐条验证，仅该窗口豁免；
  // 窗口之外（引导期 / stub 还原后）的 [zunhong] 错误一律计入——防止过滤器把
  // 真实诊断错误一起吞掉（QA 审查：原实现全局豁免 [zunhong]）
  const noise = /OffscreenCanvas|Worker|WebGL|createImageBitmap|VideoFrame|ImageDecoder|MediaStream/;
  const appErrors = errors.slice(0, preTestErrors).concat(errors.slice(restoreMark))
    .filter((e) => !noise.test(e));
  assert(appErrors.length === 0, '无引导期脚本错误' + (appErrors.length ? '：' + appErrors.join(' | ') : ''));

  win.close();
}).then(checker.finish, e => { console.error('脚本异常:', e && e.message || e); process.exit(2); });
