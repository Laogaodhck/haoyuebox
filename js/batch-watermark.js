/* 批量工具子功能：去除水印
 * 纯本地实现：选择文件夹后在第一张图片上拖拽框选水印区域（比例坐标），
 * 选区按比例应用到文件夹内全部图片，支持模糊 / 像素化 / 纯色覆盖 / 周边取色填充，
 * 结果直接写回磁盘，不上传任何数据。
 */
(function () {
  'use strict';

  var IMG_EXTS = { jpg: 1, jpeg: 1, png: 1, webp: 1, bmp: 1, gif: 1 };
  var MODES = ['blur', 'block', 'fill', 'median'];

  var dirHandle = null;   // 当前文件夹句柄
  var items = [];         // [{name, handle, file, w, h, url}]
  var regions = [];       // 水印区域（比例坐标 0-1）[{x, y, w, h}]
  var previewBmp = null;  // 预览位图（第一张图片）
  var drag = null;        // 当前拖拽中的选区
  var running = false;

  function $(id) { return document.getElementById(id); }
  function toast(msg, isErr) { window.App.ui.toast(msg, isErr); }

  /* ================= 纯逻辑（可单测） ================= */

  function clamp01(v) { return Math.min(1, Math.max(0, +v || 0)); }

  // 强度钳制到 1–10
  function clampStrength(v) {
    v = Math.round(+v || 0);
    return Math.min(10, Math.max(1, v));
  }

  // 拖拽起止点（比例坐标）→ 归一化矩形（先钳制端点再取 min/abs，保证 x+w ≤ 1）
  function normalizeRect(x0, y0, x1, y1) {
    x0 = clamp01(x0); y0 = clamp01(y0);
    x1 = clamp01(x1); y1 = clamp01(y1);
    return {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      w: Math.abs(x1 - x0),
      h: Math.abs(y1 - y0)
    };
  }

  // 比例矩形 → 像素矩形（整数、钳制在画布内）
  function rectToPx(rect, W, H) {
    var x = Math.round(rect.x * W);
    var y = Math.round(rect.y * H);
    var w = Math.round(rect.w * W);
    var h = Math.round(rect.h * H);
    x = Math.max(0, Math.min(W - 1, x));
    y = Math.max(0, Math.min(H - 1, y));
    w = Math.max(0, Math.min(W - x, w));
    h = Math.max(0, Math.min(H - y, h));
    return { x: x, y: y, w: w, h: h };
  }

  // 每通道取中位数 → [r, g, b]
  function medianColor(colors) {
    if (!colors.length) return [255, 255, 255];
    return [0, 1, 2].map(function (k) {
      var arr = colors.map(function (c) { return c[k]; })
        .sort(function (a, b) { return a - b; });
      return arr[Math.floor(arr.length / 2)];
    });
  }

  // 采集矩形外围一圈（ring 像素宽）的像素颜色，用于「周边取色填充」
  function collectRingColors(data, W, H, rect, ring) {
    var colors = [];
    var step = Math.max(1, Math.round(Math.min(rect.w, rect.h) / 24)); // 步长控制采样数量
    function take(x, y) {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      var i = (y * W + x) * 4;
      colors.push([data[i], data[i + 1], data[i + 2]]);
    }
    var x0 = rect.x - ring, y0 = rect.y - ring;
    var x1 = rect.x + rect.w + ring, y1 = rect.y + rect.h + ring;
    var x, y;
    for (x = x0; x < x1; x += step) {
      for (y = y0; y < rect.y; y += step) take(x, y);            // 上
      for (y = rect.y + rect.h; y < y1; y += step) take(x, y);   // 下
    }
    for (y = y0; y < y1; y += step) {
      for (x = x0; x < rect.x; x += step) take(x, y);            // 左
      for (x = rect.x + rect.w; x < x1; x += step) take(x, y);   // 右
    }
    return colors;
  }

  // 输出文件名：suffix 模式加「-无水印」后缀；targetExt 用于 BMP/GIF 等无法原格式编码时替换扩展名
  function buildOutName(name, mode, targetExt) {
    var dot = name.lastIndexOf('.');
    var base = dot > 0 ? name.slice(0, dot) : name;
    var ext = targetExt || (dot > 0 ? name.slice(dot + 1) : 'png');
    return base + (mode === 'suffix' ? '-无水印' : '') + '.' + ext;
  }

  /* ================= 区域处理（canvas 绘制） ================= */

  // 模糊：clip 后带 filter 自绘两次，强度越大模糊半径越大
  function blurRegion(ctx, W, H, r, strength) {
    var radius = Math.max(2, Math.round(Math.min(r.w, r.h) * (strength / 10) * 0.5));
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.filter = 'blur(' + radius + 'px)';
    ctx.drawImage(ctx.canvas, 0, 0);
    ctx.drawImage(ctx.canvas, 0, 0);
    ctx.filter = 'none';
    ctx.restore();
  }

  // 像素化：区域缩小到像素块再无平滑放大（强度越大块越大）
  function blockRegion(ctx, W, H, r, strength) {
    var factor = Math.max(4, Math.round(40 - strength * 3.5)); // 缩小倍数：36(强度1) → 5(强度10)
    var sw = Math.max(1, Math.round(r.w / factor));
    var sh = Math.max(1, Math.round(r.h / factor));
    var off = document.createElement('canvas');
    off.width = sw;
    off.height = sh;
    var octx = off.getContext('2d');
    octx.drawImage(ctx.canvas, r.x, r.y, r.w, r.h, 0, 0, sw, sh);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, sw, sh, r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  // 对画布应用全部水印区域处理
  function processCanvas(canvas, rects, mode, strength, color) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    rects.forEach(function (r0) {
      var r = rectToPx(r0, W, H);
      if (r.w <= 0 || r.h <= 0) return;
      if (mode === 'blur') {
        blurRegion(ctx, W, H, r, strength);
      } else if (mode === 'block') {
        blockRegion(ctx, W, H, r, strength);
      } else if (mode === 'fill') {
        ctx.fillStyle = color;
        ctx.fillRect(r.x, r.y, r.w, r.h);
      } else { // median：取周边颜色中位数填充
        var img = ctx.getImageData(0, 0, W, H);
        var ring = Math.max(4, Math.round(Math.min(r.w, r.h) * 0.15));
        var c = medianColor(collectRingColors(img.data, W, H, r, ring));
        ctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
    });
  }

  /* ================= 文件扫描 ================= */

  function naturalCmp(x, y) {
    var i = 0, j = 0;
    var D = /\d/;
    while (i < x.length && j < y.length) {
      if (D.test(x[i]) && D.test(y[j])) {
        var s = i, t = j;
        while (i < x.length && D.test(x[i])) i++;
        while (j < y.length && D.test(y[j])) j++;
        var nx = x.slice(s, i), ny = y.slice(t, j);
        var c = (parseInt(nx, 10) || 0) - (parseInt(ny, 10) || 0) || (nx.length - ny.length);
        if (c) return c;
      } else {
        if (x[i] !== y[j]) return x[i] < y[j] ? -1 : 1;
        i++; j++;
      }
    }
    return x.length - y.length;
  }

  function extOf(name) {
    var dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  async function scanFolder() {
    var candidates = [];
    var total = 0;
    for await (var it of dirHandle.values()) { // eslint-disable-line no-await-in-loop
      if (it.kind !== 'file') continue;
      total++;
      if (!IMG_EXTS[extOf(it.name)]) continue;
      candidates.push({ name: it.name, handle: it });
    }
    candidates.sort(function (a, b) { return naturalCmp(a.name, b.name); });

    var list = [];
    var skipped = 0;
    for (var i = 0; i < candidates.length; i++) { // eslint-disable-line no-await-in-loop
      var c = candidates[i];
      try {
        var file = await c.handle.getFile();
        var bmp = await createImageBitmap(file);
        list.push({
          name: c.name, handle: c.handle, file: file,
          w: bmp.width, h: bmp.height,
          url: (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(file) : ''
        });
        if (bmp.close) bmp.close();
      } catch (e) {
        skipped++;
      }
    }
    return { list: list, skipped: skipped, total: total };
  }

  async function pickFolder() {
    if (typeof window.showDirectoryPicker !== 'function') {
      $('bw-unsupported').hidden = false;
      return;
    }
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      return; // 用户取消
    }
    window.App.ui.showLoading('正在扫描文件夹…');
    var res = { list: [], skipped: 0, total: 0 };
    try {
      res = await scanFolder();
    } catch (e) {
      toast('读取文件夹失败：' + e.message, true);
    }
    window.App.ui.hideLoading();
    releaseUrls();
    items = res.list;
    $('bw-folder').textContent = dirHandle.name + '（共 ' + res.total + ' 个文件）';
    var extra = res.skipped ? ' · 跳过 ' + res.skipped + ' 个（无法解码）' : '';
    if (!items.length) {
      toast('该文件夹中没有可处理的图片', true);
      resetPreview();
    } else {
      await loadPreview();
    }
    renderChips();
    updateRun();
  }

  function releaseUrls() {
    if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
      items.forEach(function (it) { try { URL.revokeObjectURL(it.url); } catch (e) { /* 忽略 */ } });
    }
  }

  /* ================= 预览与框选 ================= */

  function resetPreview() {
    previewBmp = null;
    drag = null;
    var canvas = $('wm-canvas');
    canvas.hidden = true;
    canvas.width = 0;
    canvas.height = 0;
    $('wm-empty').hidden = false;
    $('wm-info').textContent = '';
  }

  async function loadPreview() {
    resetPreview();
    if (!items.length) return;
    try {
      previewBmp = await createImageBitmap(items[0].file || await items[0].handle.getFile());
    } catch (e) {
      previewBmp = null;
    }
    if (!previewBmp) {
      toast('预览图解码失败', true);
      return;
    }
    var canvas = $('wm-canvas');
    canvas.width = previewBmp.width;
    canvas.height = previewBmp.height;
    canvas.hidden = false;
    $('wm-empty').hidden = true;
    $('wm-info').textContent = items[0].name + '（' + previewBmp.width + '×' + previewBmp.height +
      '）· 共 ' + items.length + ' 张图片将按此选区批量处理';
    drawPreview();
  }

  // 绘制预览：原图 + 已框选区域 + 拖拽中的区域
  function drawPreview(dragRect) {
    var canvas = $('wm-canvas');
    if (canvas.hidden || !canvas.width) return;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (previewBmp) ctx.drawImage(previewBmp, 0, 0);
    var lw = Math.max(2, Math.round(canvas.width / 300));
    ctx.lineWidth = lw;
    ctx.font = Math.max(12, Math.round(lw * 6)) + 'px sans-serif';
    regions.forEach(function (r, i) {
      strokeRegion(ctx, rectToPx(r, canvas.width, canvas.height), 'rgba(37, 99, 235, 0.35)', '#2563eb', String(i + 1));
    });
    if (dragRect) {
      var dr = normalizeRect(dragRect.x0 / canvas.width, dragRect.y0 / canvas.height,
        dragRect.x1 / canvas.width, dragRect.y1 / canvas.height);
      strokeRegion(ctx, rectToPx(dr, canvas.width, canvas.height), 'rgba(37, 99, 235, 0.2)', '#f59e0b', '');
    }
  }

  function strokeRegion(ctx, r, fill, stroke, label) {
    if (r.w <= 0 || r.h <= 0) return;
    ctx.fillStyle = fill;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = stroke;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    ctx.setLineDash([]);
    if (label) {
      ctx.fillStyle = stroke;
      ctx.fillText(label, r.x + 4, r.y + 16);
    }
  }

  function toCanvasXY(e) {
    var canvas = $('wm-canvas');
    var rect = canvas.getBoundingClientRect();
    var x = (e.clientX - rect.left) * canvas.width / rect.width;
    var y = (e.clientY - rect.top) * canvas.height / rect.height;
    return {
      x: Math.max(0, Math.min(canvas.width, x)),
      y: Math.max(0, Math.min(canvas.height, y))
    };
  }

  function renderChips() {
    var box = $('wm-chips');
    box.textContent = '';
    regions.forEach(function (r, i) {
      var chip = document.createElement('span');
      chip.className = 'wm-chip';
      chip.textContent = '区域 ' + (i + 1) + ' · ' + Math.round(r.w * 100) + '%×' + Math.round(r.h * 100) + '%';
      box.appendChild(chip);
    });
    updateRun();
  }

  function updateRun() {
    $('bw-run').disabled = running || !dirHandle || !items.length || !regions.length;
  }

  /* ================= 批量处理 ================= */

  // 按原扩展名选择编码参数；BMP/GIF 无法由 canvas 原格式编码，改存 PNG
  function encodeParams(name) {
    var ext = extOf(name);
    if (ext === 'png' || ext === 'gif') return { mime: 'image/png', ext: 'png', quality: false };
    if (ext === 'webp') return { mime: 'image/webp', ext: 'webp', quality: true };
    return { mime: 'image/jpeg', ext: 'jpg', quality: true }; // jpg / jpeg / bmp
  }

  async function writeFile(dir, name, data) {
    var fh = await dir.getFileHandle(name, { create: true });
    var w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }

  async function run() {
    if (!items.length || !regions.length || running) return;
    var mode = $('bw-mode').value;
    var strength = clampStrength($('bw-strength').value);
    var color = $('bw-color').value;
    var outMode = $('bw-out').value; // suffix | overwrite

    running = true;
    updateRun();
    var ok = 0;
    var failed = [];
    try {
      for (var i = 0; i < items.length; i++) { // eslint-disable-line no-await-in-loop
        var it = items[i];
        window.App.ui.showLoading('正在处理 ' + (i + 1) + '/' + items.length + ' …');
        try {
          var src = it.file || await it.handle.getFile();
          var bmp = await createImageBitmap(src); // GIF 自动取第一帧
          var canvas = document.createElement('canvas');
          canvas.width = bmp.width;
          canvas.height = bmp.height;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(bmp, 0, 0);
          if (bmp.close) bmp.close();
          processCanvas(canvas, regions, mode, strength, color);
          var enc = encodeParams(it.name);
          var blob = await new Promise(function (res, rej) {
            canvas.toBlob(function (b) { b ? res(b) : rej(new Error('编码失败')); },
              enc.mime, enc.quality ? 0.92 : undefined);
          });
          var data = new Uint8Array(await blob.arrayBuffer());
          await writeFile(dirHandle, buildOutName(it.name, outMode, enc.ext), data);
          ok++;
        } catch (e) {
          failed.push(it.name);
        }
      }
    } finally {
      window.App.ui.hideLoading();
      running = false;
      updateRun();
    }
    toast('处理完成：成功 ' + ok + ' 张' +
      (outMode === 'suffix' ? '（文件名带「-无水印」后缀）' : '（已覆盖原文件）') +
      (failed.length ? '；失败 ' + failed.length + ' 张（' + failed[0] + '）' : ''),
      failed.length > 0);
  }

  /* ================= 事件绑定 ================= */

  function bindCanvas() {
    var canvas = $('wm-canvas');
    canvas.addEventListener('pointerdown', function (e) {
      if (!previewBmp || running) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      var p = toCanvasXY(e);
      drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var p = toCanvasXY(e);
      drag.x1 = p.x;
      drag.y1 = p.y;
      drawPreview(drag);
    });
    function finish(commit) {
      if (!drag) return;
      var d = drag;
      drag = null;
      if (commit) {
        var r = normalizeRect(d.x0 / canvas.width, d.y0 / canvas.height,
          d.x1 / canvas.width, d.y1 / canvas.height);
        // 过滤误触：小于 8×8 像素的选区忽略
        if (r.w * canvas.width >= 8 && r.h * canvas.height >= 8) regions.push(r);
      }
      renderChips();
      drawPreview();
    }
    canvas.addEventListener('pointerup', function () { finish(true); });
    canvas.addEventListener('pointercancel', function () { finish(false); });
    canvas.addEventListener('pointerleave', function () { if (drag) finish(true); });
  }

  function init() {
    if (typeof window.showDirectoryPicker !== 'function') {
      $('bw-unsupported').hidden = false;
      $('bw-pick').disabled = true;
    }
    $('bw-pick').addEventListener('click', pickFolder);
    var empty = $('wm-empty');
    empty.addEventListener('click', pickFolder);
    empty.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pickFolder();
      }
    });
    bindCanvas();

    $('bw-undo').addEventListener('click', function () {
      regions.pop();
      renderChips();
      drawPreview();
    });
    $('bw-clear').addEventListener('click', function () {
      regions = [];
      renderChips();
      drawPreview();
    });
    $('bw-mode').addEventListener('change', function () {
      var fill = this.value === 'fill';
      var plain = fill || this.value === 'median';
      $('bw-strength-row').hidden = plain;
      $('bw-color-row').hidden = !fill;
    });
    $('bw-strength').addEventListener('input', function () {
      $('bw-strength-val').textContent = this.value;
    });
    $('bw-out').addEventListener('change', updateRun);
    $('bw-clear-all').addEventListener('click', function () {
      dirHandle = null;
      regions = [];
      releaseUrls();
      items = [];
      resetPreview();
      $('bw-folder').textContent = '未选择文件夹';
      renderChips();
    });
    $('bw-run').addEventListener('click', run);
    $('bw-back').addEventListener('click', function () { window.App.batch.showOnly(null); });
    updateRun();
  }

  window.App = window.App || {};
  window.App.batchWatermark = {
    init: init,
    enter: function () {
      window.App.batch.showOnly('batch-watermark');
      updateRun();
    },
    // 以下导出仅供测试
    _test: {
      MODES: MODES,
      IMG_EXTS: IMG_EXTS,
      clampStrength: clampStrength,
      normalizeRect: normalizeRect,
      rectToPx: rectToPx,
      medianColor: medianColor,
      collectRingColors: collectRingColors,
      buildOutName: buildOutName,
      processCanvas: processCanvas
    }
  };
})();
