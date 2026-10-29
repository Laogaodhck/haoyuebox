/* ============================================================
 * docs-watermark.js — 文档工具子功能：文档加水印
 * 纯本地实现：选择 PDF / 图片（JPG·PNG·WebP）后叠加文字或图片水印，
 *  - 文字水印：内容 / 字号 / 颜色 / 透明度 / 旋转角 / 九宫格定位或平铺；
 *  - 图片水印：水印图（PNG 透明最佳）/ 缩放 / 透明度 / 旋转角 / 定位或平铺；
 *  - PDF 逐页栅格化（页面转为图像）后经纯 JS 生成器重建，水印不可被单独剥离；
 *  - 图片保持原格式输出（PNG 保留透明通道）；
 *  - 输出到所选文件夹的「加水印输出」子文件夹，不动原文件，不上传任何数据。
 * 依赖：App.pdfcore（pdf.js 加载渲染，6.x 只收 TypedArray）、App.batchFormat.buildPdf（纯 JS PDF 生成器）。
 * ============================================================ */
(function (App) {
  'use strict';

  var $ = App.ui.$;
  var core = App.pdfcore;
  var SUB_DIR = '加水印输出';
  var PDF_RE = /\.pdf$/i;
  var IMG_RE = /\.(jpe?g|png|webp)$/i;
  var COLORS = { black: '#111111', white: '#ffffff', gray: '#8a8f98', red: '#d33a3a', blue: '#2563eb' };

  var items = [];        // [{file, isPdf}]
  var dirHandle = null;  // FSA 输出目录句柄
  var wmImg = null;      // 水印图 ImageBitmap
  var mode = 'text';     // text | image
  var running = false;
  var task = null;       // 本次处理的取消令牌（App.task）
  var previewTimer = null;
  var previewGen = 0;    // 预览代数：拖滑块/切文件会快速连发，过期回调必须丢弃
  var pdfCache = { file: null, pdf: null }; // 已解析 PDF 缓存（同文件反复预览不重复读盘）

  function toast(msg, isErr) { App.ui.toast(msg, isErr); }

  /* ================= 纯逻辑（可单测） ================= */

  // 透明度钳制：滑杆按百分比（5–100）输入，>1 视为百分数换算；结果钳到 0.05–1
  function clampOpacity(v) {
    v = +v;
    if (!isFinite(v)) return 0.25;
    if (v > 1) v = v / 100;
    return Math.min(1, Math.max(0.05, v));
  }

  // 字号钳制 12–120
  function clampSize(v) {
    v = Math.round(+v || 0);
    return Math.min(120, Math.max(12, v));
  }

  // 水印图缩放钳制 10–60（占短边百分比）→ 系数
  function clampScale(v) {
    v = Math.round(+v || 0);
    v = Math.min(60, Math.max(10, v));
    return v / 100;
  }

  // 平铺密度钳制 1–8 列（非法输入回退默认 4）
  function clampCols(v) {
    v = Math.round(+v);
    if (!isFinite(v)) return 4;
    return Math.min(8, Math.max(1, v));
  }

  // 九宫格定位 → 水印块左上角像素（边距为短边 4%）
  function posToXY(pos, W, H, w, h) {
    var m = Math.round(Math.min(W, H) * 0.04);
    var cx = Math.round((W - w) / 2);
    var cy = Math.round((H - h) / 2);
    var map = {
      tl: { x: m, y: m }, tc: { x: cx, y: m }, tr: { x: W - w - m, y: m },
      ml: { x: m, y: cy }, center: { x: cx, y: cy }, mr: { x: W - w - m, y: cy },
      bl: { x: m, y: H - h - m }, bc: { x: cx, y: H - h - m }, br: { x: W - w - m, y: H - h - m }
    };
    return map[pos] || map.center; // 未知定位兜底居中
  }

  // 平铺坐标：cols 列、行距取 max(列距×0.6, 块高×1.25)，奇数行横向错位半步
  function tilePoints(W, H, w, h, cols) {
    cols = clampCols(cols);
    var stepX = W / cols;
    var stepY = Math.max(stepX * 0.6, h * 1.25);
    var pts = [];
    for (var row = 0, y = stepY / 2; y < H + h / 2; row++, y += stepY) {
      var off = (row % 2) * (stepX / 2);
      for (var x = stepX / 2 + off; x < W + w / 2; x += stepX) {
        pts.push({ x: Math.round(x - w / 2), y: Math.round(y - h / 2) });
      }
    }
    return pts;
  }

  // 在 ctx 上按坐标逐块绘制（rotate 绕块中心，单位度）
  function drawMarks(ctx, pts, w, h, rotate, drawOne) {
    var rad = (rotate || 0) * Math.PI / 180;
    pts.forEach(function (p) {
      ctx.save();
      ctx.translate(p.x + w / 2, p.y + h / 2);
      if (rad) ctx.rotate(rad);
      drawOne(-w / 2, -h / 2);
      ctx.restore();
    });
  }

  // 核心绘制：把水印画到已含内容的画布上（不修改底图其余像素）
  function paintWatermark(ctx, W, H, opts) {
    var w, h, drawOne;
    ctx.save();
    ctx.textBaseline = 'top';
    if (opts.mode === 'image' && opts.img) {
      var target = Math.round(Math.min(W, H) * clampScale(opts.scale));
      h = target;
      w = Math.max(1, Math.round(opts.img.width * target / opts.img.height));
      drawOne = function (x, y) { ctx.drawImage(opts.img, x, y, w, h); };
    } else {
      var fontPx = clampSize(opts.size);
      ctx.font = fontPx + 'px sans-serif';
      var m = ctx.measureText(opts.text || '');
      w = Math.max(1, Math.ceil(m.width));
      h = Math.ceil(fontPx * 1.25);
      drawOne = function (x, y) {
        ctx.fillStyle = COLORS[opts.color] || opts.color || '#111111';
        ctx.fillText(opts.text || '', x, y);
      };
    }
    ctx.globalAlpha = clampOpacity(opts.opacity);
    var pts = (opts.pos === 'tile')
      ? tilePoints(W, H, w, h, opts.cols)
      : [posToXY(opts.pos, W, H, w, h)];
    drawMarks(ctx, pts, w, h, opts.rotate, drawOne);
    ctx.restore();
  }

  /* ================= 文件处理 ================= */

  function blobBytes(blob) {
    return blob.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  // PDF：逐页栅格化（长边 ≤2000px）→ 加水印 → JPEG → 纯 JS 生成器重建
  async function processPdf(file, opts) {
    var pdf = await core.loadPdf(file);
    try {
      var pages = [];
      for (var i = 1; i <= pdf.numPages; i++) {
        App.task.checkpoint(task);
        var canvas = await core.renderPage(pdf, i, 2, 2000);
        paintWatermark(canvas.getContext('2d'), canvas.width, canvas.height, opts);
        var blob = await new Promise(function (res) { canvas.toBlob(res, 'image/jpeg', 0.92); });
        pages.push({ jpeg: await blobBytes(blob), w: canvas.width, h: canvas.height });
      }
      return App.batchFormat.buildPdf(pages);
    } finally {
      pdf.cleanup();
    }
  }

  // 图片：绘制到画布 → 加水印 → 按原格式编码（PNG 保留透明，JPEG/WebP 质量 0.92）
  async function processImage(file, opts) {
    var bmp = await createImageBitmap(file);
    var canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    paintWatermark(ctx, canvas.width, canvas.height, opts);
    var type = /^image\/(png|jpeg|webp)$/.test(file.type) ? file.type : 'image/png';
    var quality = type === 'image/png' ? undefined : 0.92;
    return new Promise(function (res) { canvas.toBlob(res, type, quality); });
  }

  /* ================= UI 状态 ================= */

  function setStatus(msg) { $('dw-status').textContent = msg || ''; }

  /* 运行期控件锁：文件/样式参数/输出目录全部停用，只留取消按钮 */
  var CTRL_IDS = ['dw-pick', 'dw-file', 'dw-clear', 'dw-tab-text', 'dw-tab-image',
    'dw-img-pick', 'dw-img-file', 'dw-text', 'dw-size', 'dw-color', 'dw-opacity',
    'dw-rotate', 'dw-pos', 'dw-cols', 'dw-img-scale', 'dw-dir', 'dw-run'];
  function setRunning(on) {
    running = on;
    CTRL_IDS.forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = on;
    });
    $('dw-cancel').hidden = !on;
    if (!on) renderCount();
  }

  function renderCount() {
    var n = items.length;
    var pdfN = items.filter(function (it) { return it.isPdf; }).length;
    // 只报文件数与 PDF 数：it.pages 未在选文件时读取，累加它等于把图片也按 1 页计入，
    // 显示「共 N 页」是假数据；真实页数需要逐个解析 PDF，成本过高，按文件计更诚实
    $('dw-count').textContent = n
      ? '已选 ' + n + ' 个文件' + (pdfN ? '（含 PDF ' + pdfN + ' 个）' : '')
      : '';
    $('dw-empty').hidden = n > 0;
    $('dw-clear').hidden = n === 0;
  }

  function addResult(name, ok) {
    var row = document.createElement('div');
    row.className = 'dw-list-row ' + (ok ? 'ok' : 'bad');
    row.innerHTML = '<span>' + String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
      '</span><span class="dw-res">' + (ok ? '完成' : '失败') + '</span>';
    $('dw-list').appendChild(row);
  }

  function readOpts() {
    return {
      mode: mode,
      text: $('dw-text').value.trim(),
      size: +$('dw-size').value,
      color: $('dw-color').value,
      opacity: +$('dw-opacity').value,
      rotate: +$('dw-rotate').value,
      pos: $('dw-pos').value,
      cols: +$('dw-cols').value,
      img: wmImg,
      scale: +$('dw-img-scale').value
    };
  }

  function setMode(next) {
    mode = next;
    $('dw-tab-text').classList.toggle('active', mode === 'text');
    $('dw-tab-image').classList.toggle('active', mode === 'image');
    $('dw-text-rows').hidden = mode !== 'text';
    $('dw-img-rows').hidden = mode !== 'image';
    schedulePreview();
  }

  /* ================= 预览 ================= */

  function releasePdfCache() {
    if (pdfCache.pdf) { try { pdfCache.pdf.cleanup(); } catch (e) { /* 已销毁 */ } }
    pdfCache = { file: null, pdf: null };
  }

  async function renderPreview() {
    var canvas = $('dw-canvas');
    var hint = $('dw-preview-hint');
    if (!items.length) {
      canvas.hidden = true;
      hint.hidden = false;
      return;
    }
    var opts = readOpts();
    if (opts.mode === 'image' && !wmImg) {
      canvas.hidden = true;
      hint.hidden = false;
      hint.textContent = '请先选择水印图片';
      return;
    }
    hint.hidden = true;
    canvas.hidden = false;
    var it = items[0];
    // 每次预览代数+1：异步渲染期间若又触发新预览（拖滑块/切文件），
    // 旧回调完成后发现代数过期即丢弃，防止后完成的慢渲染覆盖新预览
    var myGen = ++previewGen;
    try {
      if (it.isPdf) {
        // 同文件走缓存：pdf.js parse 大文件（百 MB 扫描件）成本高，
        // 反复拖滑块只应读一次盘；切换文件时释放上一个文档句柄
        if (pdfCache.file !== it.file) {
          releasePdfCache();
          var loaded = await core.loadPdf(it.file);
          /* 加载期间若又触发新预览（切文件/拖滑块），本回调已过期：
           * 过期者不占缓存（占了也会被更新者覆写，两份句柄一起漏），直接释放 */
          if (myGen !== previewGen) {
            try { loaded.cleanup(); } catch (e2) { /* 已销毁 */ }
            return;
          }
          pdfCache = { file: it.file, pdf: loaded };
        }
        var pdf = pdfCache.pdf;
        if (myGen !== previewGen) return; // 已过期：丢弃（缓存供下次复用）
        var page = await pdf.getPage(1);
        var base = page.getViewport({ scale: 1 });
        var scale = Math.min(2, Math.max(0.5, 860 / base.width));
        var vp = page.getViewport({ scale: scale });
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        if (myGen !== previewGen) return; // 渲染期间又发了新预览：丢弃结果
        paintWatermark(ctx, canvas.width, canvas.height, opts);
      } else {
        var bmp = await createImageBitmap(it.file);
        if (myGen !== previewGen) return;
        var fit = Math.min(1, 860 / bmp.width);
        canvas.width = Math.round(bmp.width * fit);
        canvas.height = Math.round(bmp.height * fit);
        var c2 = canvas.getContext('2d');
        c2.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        paintWatermark(c2, canvas.width, canvas.height, opts);
      }
    } catch (e) {
      if (myGen !== previewGen) return; // 过期回调的错误不覆盖新预览的提示
      canvas.hidden = true;
      hint.hidden = false;
      hint.textContent = '预览失败：' + ((e && e.message) || e);
    }
  }

  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 250);
  }

  /* ================= 主流程 ================= */

  async function pickFiles() {
    var input = $('dw-file');
    input.value = '';
    input.click();
  }

  function addFiles(files) {
    if (running) { toast('正在处理中，请先取消或等待完成'); return; }
    if (!files.length) return;
    var skipped = 0;
    files.forEach(function (f) {
      if (PDF_RE.test(f.name)) items.push({ file: f, isPdf: true });
      else if (IMG_RE.test(f.name)) items.push({ file: f, isPdf: false });
      else skipped++;
    });
    if (skipped) toast('已跳过 ' + skipped + ' 个不支持的文件（仅支持 PDF / JPG / PNG / WebP）');
    renderCount();
    schedulePreview();
  }

  function onFilesPicked() {
    addFiles(Array.prototype.slice.call($('dw-file').files || []));
  }

  function clearFiles() {
    if (running) return;
    items = [];
    releasePdfCache();
    renderCount();
    schedulePreview();
    setStatus('');
    $('dw-list').innerHTML = '';
  }

  async function pickDir() {
    if (typeof window.showDirectoryPicker !== 'function') {
      toast('当前环境不支持选择文件夹，请使用桌面版或 Chrome / Edge 浏览器', true);
      return;
    }
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      $('dw-dir-name').textContent = dirHandle.name;
    } catch (e) { /* 用户取消 */ }
  }

  function pickWmImage() { $('dw-img-file').click(); }

  async function onWmImagePicked() {
    var input = $('dw-img-file');
    var f = (input.files || [])[0];
    if (!f) return;
    try {
      wmImg = await createImageBitmap(f);
      $('dw-img-name').textContent = f.name;
      schedulePreview();
    } catch (e) {
      toast('水印图片读取失败：' + ((e && e.message) || e), true);
    }
  }

  async function run() {
    if (running) return;
    if (!items.length) { toast('请先选择要加水印的文件'); return; }
    if (!dirHandle) { toast('请先选择输出文件夹'); return; }
    var opts = readOpts();
    if (opts.mode === 'text' && !opts.text) { toast('请输入水印文字'); return; }
    if (opts.mode === 'image' && !wmImg) { toast('请先选择水印图片'); return; }
    if (!window.showDirectoryPicker) {
      toast('当前环境不支持文件夹写入，请使用桌面版或 Chrome / Edge 浏览器', true);
      return;
    }
    task = App.task.create();
    setRunning(true);
    $('dw-list').innerHTML = '';
    var out = null;
    try {
      out = await dirHandle.getDirectoryHandle(SUB_DIR, { create: true });
    } catch (e) {
      setStatus('');
      setRunning(false);
      task = null;
      return toast('无法创建输出文件夹：' + ((e && e.message) || e), true);
    }
    var okN = 0, errN = 0, cancelled = false;
    try {
      for (var i = 0; i < items.length; i++) {
        App.task.checkpoint(task);
        var it = items[i];
        setStatus('处理 ' + (i + 1) + '/' + items.length + '：' + it.file.name);
        try {
          if (it.isPdf) {
            var bytes = await processPdf(it.file, opts);
            // 同名文件（不同文件夹多选）防静默覆盖：探测已有则追加 _N 后缀
            var outName = await core.uniqueOutName(out, it.file.name);
            var fh = await out.getFileHandle(outName, { create: true });
            var w = await fh.createWritable();
            await w.write(bytes);
            await w.close();
          } else {
            var blob = await processImage(it.file, opts);
            var outName2 = await core.uniqueOutName(out, it.file.name);
            var fh2 = await out.getFileHandle(outName2, { create: true });
            var w2 = await fh2.createWritable();
            await w2.write(blob);
            await w2.close();
          }
          okN++;
          addResult(it.file.name, true);
        } catch (e) {
          if (App.task.isCancelled(e)) throw e;
          errN++;
          addResult(it.file.name, false);
          console.error('[haoyue] 加水印失败:', it.file.name, e);
        }
      }
    } catch (e) {
      if (!App.task.isCancelled(e)) throw e;
      cancelled = true;
    } finally {
      setRunning(false);
      task = null;
    }
    setStatus(cancelled
      ? '已取消：已完成 ' + okN + ' 个' + (errN ? '，失败 ' + errN + ' 个' : '') +
        '，已输出的文件保留在「' + dirHandle.name + '/' + SUB_DIR + '」'
      : '完成：成功 ' + okN + ' 个' + (errN ? '，失败 ' + errN + ' 个' : '') +
        '，已输出到「' + dirHandle.name + '/' + SUB_DIR + '」，原文件未改动');
  }

  /* 每次进入面板：清结果与状态，释放预览文档句柄，刷新计数与预览 */
  function enter() {
    releasePdfCache();
    $('dw-list').innerHTML = '';
    setStatus('');
    renderCount();
    schedulePreview();
  }

  App.docsWatermark = {
    enter: enter,
    _test: {
      clampOpacity: clampOpacity,
      clampSize: clampSize,
      clampScale: clampScale,
      clampCols: clampCols,
      posToXY: posToXY,
      tilePoints: tilePoints,
      paintWatermark: paintWatermark
    }
  };

  App.docsWatermark.init = function () {
    $('dw-pick').addEventListener('click', pickFiles);
    $('dw-file').addEventListener('change', onFilesPicked);
    $('dw-clear').addEventListener('click', clearFiles);
    $('dw-tab-text').addEventListener('click', function () { setMode('text'); });
    $('dw-tab-image').addEventListener('click', function () { setMode('image'); });
    ['dw-text', 'dw-size', 'dw-color', 'dw-opacity', 'dw-rotate', 'dw-pos', 'dw-cols', 'dw-img-scale']
      .forEach(function (id) { $(id).addEventListener('input', function () {
        $('dw-size-v').textContent = $('dw-size').value;
        $('dw-opacity-v').textContent = $('dw-opacity').value + '%';
        $('dw-rotate-v').textContent = $('dw-rotate').value + '°';
        $('dw-img-scale-v').textContent = $('dw-img-scale').value + '%';
        schedulePreview();
      }); });
    $('dw-dir').addEventListener('click', pickDir);
    $('dw-img-pick').addEventListener('click', pickWmImage);
    $('dw-img-file').addEventListener('change', onWmImagePicked);
    $('dw-run').addEventListener('click', run);
    $('dw-cancel').addEventListener('click', function () {
      if (!task) return;
      task.cancel();
      setStatus('正在取消处理…');
    });
    App.ui.bindFileDrop('docs-watermark', {
      target: 'dw-stage',
      accept: /\.(pdf|jpe?g|png|webp)$/i,
      rejectMsg: '请拖入 PDF 或图片（JPG / PNG / WebP）',
      onFiles: addFiles
    });
    setMode('text');
  };
})(window.App);
