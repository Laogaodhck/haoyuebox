/* 批量工具子功能：去除水印
 * 纯本地实现：选择图片后框选或涂抹水印区域，
 *  - 框选：拖拽矩形（比例坐标），可叠加多处；
 *  - 涂抹：笔刷手动刷出蒙版，可擦除修正，笔刷大小可调；
 * 选区 / 蒙版按比例应用到全部已选图片，支持模糊 / 像素化 / 纯色覆盖 / 周边取色填充，
 * 结果写回原文件或另存副本，不上传任何数据。
 */
(function () {
  'use strict';

  var IMG_EXTS = { jpg: 1, jpeg: 1, png: 1, webp: 1, bmp: 1, gif: 1 };
  var MODES = ['blur', 'block', 'fill', 'median'];
  var MASK_COLOR = '#2563eb';       // 蒙版画布填充色（仅用于显示，处理只取 alpha）
  var MASK_ALPHA = 0.45;            // 预览时蒙版叠加透明度
  var HISTORY_MAX = 80;             // 动作历史上限（超出丢弃最旧并重建蒙版）

  var items = [];         // [{name, handle}] 当前选择的图片句柄
  var actions = [];       // 操作历史：{type:'rect', rect} | {type:'stroke', erase, size, points}
  var tool = 'rect';      // rect | brush | erase
  var maskCanvas = null;  // 蒙版离屏画布（与预览图同尺寸）
  var maskInk = false;    // 蒙版上是否有效果（涂抹过）
  var previewBmp = null;  // 预览位图（第一张图片）
  var drag = null;        // 框选拖拽中 {x0,y0,x1,y1}
  var stroking = null;    // 涂抹中 {erase, size, points}
  var hoverPt = null;     // 笔刷悬停位置（画布坐标）
  var saveDir = null;     // 另存副本时的保存文件夹句柄
  var running = false;

  var $ = window.App.ui.$;
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

  // 采集蒙版边缘一圈的像素颜色（涂抹蒙版的「周边取色填充」）：
  // maskA 为 W*H 的 alpha 数组（>128 视为蒙版内）；从蒙版内采样点向 8 方向探测，
  // 取第一个蒙版外像素的颜色，保证采样全部来自未涂抹区域。
  function collectMaskRingColors(data, W, H, maskA, ring) {
    var colors = [];
    if (!data || !maskA || W < 1 || H < 1 || ring < 1) return colors;
    // 先按粗步长统计蒙版量，再定采样步长，控制总采样数
    var count = 0, sx0 = 3, sy0 = 3, x, y;
    for (y = 0; y < H; y += sy0) {
      for (x = 0; x < W; x += sx0) {
        if (maskA[y * W + x] > 128) count++;
      }
    }
    var stride = Math.max(3, Math.round(Math.sqrt(count / 1500)) * 3);
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (y = 0; y < H; y += stride) {
      for (x = 0; x < W; x += stride) {
        if (maskA[y * W + x] <= 128) continue;
        for (var d = 0; d < dirs.length; d++) {
          var px = x + dirs[d][0] * ring, py = y + dirs[d][1] * ring;
          if (px < 0 || py < 0 || px >= W || py >= H) continue;
          if (maskA[py * W + px] > 128) continue;
          var i = (py * W + px) * 4;
          colors.push([data[i], data[i + 1], data[i + 2]]);
          break;
        }
      }
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

  // 模糊：clip 后带 filter 自绘两次，强度越大模糊半径越大（仅框选路径）
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

  // 对画布应用全部矩形水印区域处理（无涂抹蒙版时的纯框选路径）
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

  // 蒙版路径：把蒙版（含框选+涂抹）羽化后拉伸到当前图片尺寸，
  // 生成整图处理层（模糊 / 像素化 / 纯色 / 取色填充），再用蒙版 alpha 裁切贴回。
  function applyMasked(canvas, mode, strength, color) {
    var W = canvas.width, H = canvas.height;
    var ctx = canvas.getContext('2d');

    // 1) 蒙版：拉伸适配 + 轻微羽化，边界过渡更自然
    var mask = document.createElement('canvas');
    mask.width = W; mask.height = H;
    var mctx = mask.getContext('2d');
    mctx.filter = 'blur(' + Math.max(1, Math.round(Math.min(W, H) / 300)) + 'px)';
    mctx.drawImage(maskCanvas, 0, 0, W, H);
    mctx.filter = 'none';

    // 2) 整图处理层
    var layer = document.createElement('canvas');
    layer.width = W; layer.height = H;
    var lctx = layer.getContext('2d');
    if (mode === 'fill') {
      lctx.fillStyle = color;
      lctx.fillRect(0, 0, W, H);
    } else if (mode === 'median') {
      var img = ctx.getImageData(0, 0, W, H);
      var ma = mctx.getImageData(0, 0, W, H).data;
      var alpha = new Uint8Array(W * H);
      for (var i = 0, p = 3; i < alpha.length; i++, p += 4) alpha[i] = ma[p];
      var ring = Math.max(4, Math.round(Math.min(W, H) * 0.02));
      var c = medianColor(collectMaskRingColors(img.data, W, H, alpha, ring));
      lctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
      lctx.fillRect(0, 0, W, H);
    } else if (mode === 'blur') {
      var radius = Math.max(2, Math.round(Math.min(W, H) * (strength / 10) * 0.12));
      lctx.filter = 'blur(' + radius + 'px)';
      lctx.drawImage(canvas, 0, 0);
      lctx.drawImage(canvas, 0, 0);
      lctx.filter = 'none';
    } else { // block
      var factor = Math.max(4, Math.round(40 - strength * 3.5));
      var sw = Math.max(1, Math.round(W / factor));
      var sh = Math.max(1, Math.round(H / factor));
      var small = document.createElement('canvas');
      small.width = sw; small.height = sh;
      small.getContext('2d').drawImage(canvas, 0, 0, W, H, 0, 0, sw, sh);
      lctx.imageSmoothingEnabled = false;
      lctx.drawImage(small, 0, 0, sw, sh, 0, 0, W, H);
    }

    // 3) 蒙版裁切处理层，再贴回原图
    lctx.globalCompositeOperation = 'destination-in';
    lctx.drawImage(mask, 0, 0);
    lctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(layer, 0, 0);
  }

  /* ================= 文件选择 ================= */

  function extOf(name) {
    var dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  function pickOptions() {
    return {
      multiple: true,
      types: [{
        description: '图片',
        accept: { 'image/*': ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'] }
      }]
    };
  }

  async function pickImages() {
    if (typeof window.showOpenFilePicker !== 'function') {
      $('bw-unsupported').hidden = false;
      return;
    }
    var handles;
    try {
      handles = await window.showOpenFilePicker(Object.assign({ mode: 'readwrite' }, pickOptions()));
    } catch (e) {
      if (e && e.name === 'TypeError') { // 旧实现不支持 mode 选项，退化为只读选择
        try {
          handles = await window.showOpenFilePicker(pickOptions());
        } catch (e2) { return; }
      } else {
        return; // 用户取消
      }
    }
    var list = [];
    var skipped = 0;
    for (var i = 0; i < handles.length; i++) {
      if (!IMG_EXTS[extOf(handles[i].name)]) { skipped++; continue; }
      list.push({ name: handles[i].name, handle: handles[i] });
    }
    resetActions();
    items = list;
    $('bw-files').textContent = '已选择 ' + items.length + ' 张图片' +
      (skipped ? ' · 跳过 ' + skipped + ' 个非图片文件' : '');
    if (!items.length) {
      toast('未选择可处理的图片', true);
      resetPreview();
    } else {
      await loadPreview();
    }
    renderChips();
    updateRun();
  }

  /* ================= 预览与蒙版 ================= */

  function resetPreview() {
    previewBmp = null;
    drag = null;
    stroking = null;
    hoverPt = null;
    var canvas = $('wm-canvas');
    canvas.hidden = true;
    canvas.width = 0;
    canvas.height = 0;
    $('wm-empty').hidden = false;
    $('wm-info').textContent = '';
  }

  function resetActions() {
    actions = [];
    maskInk = false;
    if (maskCanvas && maskCanvas.getContext) {
      maskCanvas.width = 1;
      maskCanvas.height = 1;
    }
  }

  async function loadPreview() {
    resetPreview();
    resetActions();
    if (!items.length) return;
    try {
      previewBmp = await createImageBitmap(await items[0].handle.getFile());
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
      '）· 共 ' + items.length + ' 张图片将按此选区 / 蒙版批量处理';
    drawPreview();
  }

  // 把笔迹（涂抹 / 擦除）重放到指定 2D 上下文
  function replayStrokes(ctx, W, H) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    actions.forEach(function (a) {
      if (a.type !== 'stroke') return;
      ctx.globalCompositeOperation = a.erase ? 'destination-out' : 'source-over';
      ctx.strokeStyle = MASK_COLOR;
      ctx.lineWidth = a.size;
      ctx.beginPath();
      var pts = a.points;
      ctx.moveTo(pts[0][0], pts[0][1]);
      if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]); // 单点成圆点
      else for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    });
  }

  // 蒙版上是否有效果（矩形实心填充 + 笔刷描边 / 擦除）
  function buildMask() {
    var canvas = $('wm-canvas');
    if (!canvas.width) return;
    if (!maskCanvas) maskCanvas = document.createElement('canvas');
    maskCanvas.width = canvas.width;
    maskCanvas.height = canvas.height;
    var ctx = maskCanvas.getContext('2d');
    ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    actions.forEach(function (a) {
      if (a.type === 'rect') {
        var r = rectToPx(a.rect, maskCanvas.width, maskCanvas.height);
        ctx.fillStyle = MASK_COLOR;
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
    });
    replayStrokes(ctx, maskCanvas.width, maskCanvas.height);
  }

  // 检查画布 alpha 是否有内容（64×64 降采样读，避免大图全量读取）
  function canvasHasInk(canvas) {
    if (!canvas || !canvas.width) return false;
    var t = document.createElement('canvas');
    t.width = 64; t.height = 64;
    var ctx = t.getContext('2d');
    ctx.drawImage(canvas, 0, 0, 64, 64);
    var d = ctx.getImageData(0, 0, 64, 64).data;
    for (var i = 3; i < d.length; i += 4) {
      if (d[i] > 10) return true;
    }
    return false;
  }

  // 笔迹是否留有墨量（只看 stroke 动作，与框选矩形无关；
  // 决定处理路径与「手动涂抹蒙版」标签）
  function strokesHaveInk() {
    var hasStroke = false;
    for (var i = 0; i < actions.length; i++) {
      if (actions[i].type === 'stroke') { hasStroke = true; break; }
    }
    if (!hasStroke) return false;
    var canvas = $('wm-canvas');
    if (!canvas.width) return false;
    var t = document.createElement('canvas');
    t.width = canvas.width;
    t.height = canvas.height;
    replayStrokes(t.getContext('2d'), t.width, t.height);
    return canvasHasInk(t);
  }

  function brushSize() {
    return Math.round(+$('bw-brush-size').value || 40);
  }

  // 绘制预览：原图 + 蒙版叠加 + 已框选区域 + 拖拽中区域 + 笔刷光标
  function drawPreview(dragRect) {
    var canvas = $('wm-canvas');
    if (canvas.hidden || !canvas.width) return;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (previewBmp) ctx.drawImage(previewBmp, 0, 0);
    if (maskInk && maskCanvas) {
      ctx.save();
      ctx.globalAlpha = MASK_ALPHA;
      ctx.drawImage(maskCanvas, 0, 0);
      ctx.restore();
    }
    var lw = Math.max(2, Math.round(canvas.width / 300));
    ctx.lineWidth = lw;
    ctx.font = Math.max(12, Math.round(lw * 6)) + 'px sans-serif';
    var rectIdx = 0;
    actions.forEach(function (a) {
      if (a.type !== 'rect') return;
      rectIdx++;
      strokeRegion(ctx, rectToPx(a.rect, canvas.width, canvas.height),
        'rgba(37, 99, 235, 0.35)', '#2563eb', String(rectIdx));
    });
    if (dragRect) {
      var dr = normalizeRect(dragRect.x0 / canvas.width, dragRect.y0 / canvas.height,
        dragRect.x1 / canvas.width, dragRect.y1 / canvas.height);
      strokeRegion(ctx, rectToPx(dr, canvas.width, canvas.height), 'rgba(37, 99, 235, 0.2)', '#f59e0b', '');
    }
    if ((tool === 'brush' || tool === 'erase') && hoverPt && !drag) {
      ctx.beginPath();
      ctx.arc(hoverPt.x, hoverPt.y, brushSize() / 2, 0, Math.PI * 2);
      ctx.strokeStyle = tool === 'erase' ? '#ef4444' : '#f59e0b';
      ctx.lineWidth = Math.max(1, Math.round(canvas.width / 400));
      ctx.stroke();
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
    function chip(text) {
      var el = document.createElement('span');
      el.className = 'wm-chip';
      el.textContent = text;
      box.appendChild(el);
    }
    var rectIdx = 0;
    actions.forEach(function (a) {
      if (a.type !== 'rect') return;
      rectIdx++;
      chip('区域 ' + rectIdx + ' · ' + Math.round(a.rect.w * 100) + '%×' + Math.round(a.rect.h * 100) + '%');
    });
    if (maskInk) chip('手动涂抹蒙版');
    updateRun();
  }

  function updateRun() {
    $('bw-run').disabled = running || !items.length || !actions.length;
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
    if (!items.length || !actions.length || running) return;
    var mode = $('bw-mode').value;
    var strength = clampStrength($('bw-strength').value);
    var color = $('bw-color').value;
    var outMode = $('bw-out').value; // suffix | overwrite

    // 涂抹蒙版路径：先重建蒙版；纯框选走矩形路径
    if (maskInk) buildMask();
    var rectRegions = [];
    actions.forEach(function (a) {
      if (a.type === 'rect') rectRegions.push(a.rect);
    });

    // 另存副本需要保存位置（选一次，本会话内复用）
    var outDir = null;
    if (outMode === 'suffix') {
      if (typeof window.showDirectoryPicker !== 'function') {
        toast('当前环境不支持选择保存位置，请改用「覆盖原文件」', true);
        return;
      }
      if (!saveDir) {
        try {
          saveDir = await window.showDirectoryPicker({ mode: 'readwrite' });
        } catch (e) {
          return; // 用户取消
        }
      }
      outDir = saveDir;
    }

    running = true;
    updateRun();
    var ok = 0;
    var failed = [];
    try {
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        window.App.ui.showLoading('正在处理 ' + (i + 1) + '/' + items.length + ' …');
        try {
          var bmp = await createImageBitmap(await it.handle.getFile()); // GIF 自动取第一帧
          var canvas = document.createElement('canvas');
          canvas.width = bmp.width;
          canvas.height = bmp.height;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(bmp, 0, 0);
          if (bmp.close) bmp.close();
          if (maskInk) {
            applyMasked(canvas, mode, strength, color);
          } else {
            processCanvas(canvas, rectRegions, mode, strength, color);
          }
          var enc = encodeParams(it.name);
          var blob = await new Promise(function (res, rej) {
            canvas.toBlob(function (b) { b ? res(b) : rej(new Error('编码失败')); },
              enc.mime, enc.quality ? 0.92 : undefined);
          });
          var data = new Uint8Array(await blob.arrayBuffer());
          if (outMode === 'overwrite') {
            var w = await it.handle.createWritable();
            await w.write(data);
            await w.close();
          } else {
            await writeFile(outDir, buildOutName(it.name, 'suffix', enc.ext), data);
          }
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
      (outMode === 'suffix' ? '（副本文件名带「-无水印」后缀）' : '（已覆盖原文件）') +
      (failed.length ? '；失败 ' + failed.length + ' 张（' + failed[0] + '）' : ''),
      failed.length > 0);
  }

  /* ================= 事件绑定 ================= */

  function setTool(t) {
    tool = t;
    ['rect', 'brush', 'erase'].forEach(function (k) {
      var btn = $('bw-tool-' + k);
      if (btn) btn.classList.toggle('active', k === tool);
    });
    $('bw-brush-row').hidden = tool === 'rect';
    hoverPt = null;
    drawPreview();
  }

  function bindCanvas() {
    var canvas = $('wm-canvas');
    canvas.addEventListener('pointerdown', function (e) {
      if (!previewBmp || running) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      var p = toCanvasXY(e);
      if (tool === 'rect') {
        drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      } else {
        stroking = { erase: tool === 'erase', size: brushSize(), points: [[p.x, p.y]] };
      }
    });
    canvas.addEventListener('pointermove', function (e) {
      var p = toCanvasXY(e);
      if (stroking) {
        stroking.points.push([p.x, p.y]);
        // 实时反馈：把当前笔迹画进蒙版再整帧重绘
        actions.push({ type: 'stroke', erase: stroking.erase, size: stroking.size, points: stroking.points });
        buildMask();
        actions.pop();
        drawPreview();
        return;
      }
      if (drag) {
        drag.x1 = p.x;
        drag.y1 = p.y;
        drawPreview(drag);
        return;
      }
      if (tool === 'brush' || tool === 'erase') {
        hoverPt = p;
        drawPreview();
      }
    });
    function finish(commit) {
      if (drag) {
        var d = drag;
        drag = null;
        if (commit) {
          var r = normalizeRect(d.x0 / canvas.width, d.y0 / canvas.height,
            d.x1 / canvas.width, d.y1 / canvas.height);
          // 过滤误触：小于 8×8 像素的选区忽略
          if (r.w * canvas.width >= 8 && r.h * canvas.height >= 8) {
            actions.push({ type: 'rect', rect: r });
            if (actions.length > HISTORY_MAX) { actions.shift(); }
          }
        }
      }
      if (stroking) {
        var s = stroking;
        stroking = null;
        if (commit) {
          actions.push({ type: 'stroke', erase: s.erase, size: s.size, points: s.points });
          if (actions.length > HISTORY_MAX) { actions.shift(); buildMask(); }
          buildMask();
          maskInk = strokesHaveInk();
        }
      }
      renderChips();
      drawPreview();
    }
    canvas.addEventListener('pointerup', function () { finish(true); });
    canvas.addEventListener('pointercancel', function () { finish(false); });
    canvas.addEventListener('pointerleave', function () {
      hoverPt = null;
      if (drag || stroking) finish(true);
      else drawPreview();
    });
  }

  function init() {
    if (typeof window.showOpenFilePicker !== 'function') {
      $('bw-unsupported').hidden = false;
      $('bw-pick').disabled = true;
    }
    $('bw-pick').addEventListener('click', pickImages);
    var empty = $('wm-empty');
    empty.addEventListener('click', pickImages);
    empty.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pickImages();
      }
    });
    bindCanvas();

    $('bw-tool-rect').addEventListener('click', function () { setTool('rect'); });
    $('bw-tool-brush').addEventListener('click', function () { setTool('brush'); });
    $('bw-tool-erase').addEventListener('click', function () { setTool('erase'); });
    $('bw-undo').addEventListener('click', function () {
      var a = actions.pop();
      if (a && a.type === 'stroke') {
        buildMask();
        maskInk = strokesHaveInk();
      }
      renderChips();
      drawPreview();
    });
    $('bw-clear').addEventListener('click', function () {
      resetActions();
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
    $('bw-brush-size').addEventListener('input', function () {
      $('bw-brush-val').textContent = this.value;
      if (tool !== 'rect') drawPreview();
    });
    $('bw-out').addEventListener('change', function () {
      if (this.value === 'overwrite') saveDir = null; // 覆盖模式不需要保存位置
      updateRun();
    });
    $('bw-clear-all').addEventListener('click', function () {
      items = [];
      saveDir = null;
      resetActions();
      resetPreview();
      $('bw-files').textContent = '未选择图片';
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
      collectMaskRingColors: collectMaskRingColors,
      buildOutName: buildOutName,
      processCanvas: processCanvas
    }
  };
})();
