/* 照片工具子功能：图片合成（横向 / 纵向拼接 · 网格拼图）
 * 纯本地实现：布局计算与绘制全部在本机完成，不上传任何数据。
 * 结果以 PNG 无损保存。
 */
(function () {
  'use strict';

  var MODES = ['horizontal', 'vertical', 'grid'];
  var MAX_EDGE = 12000; // 输出画布最长边保护，超出直接报错提示

  var items = [];        // [{file, name, w, h, url, bmp}]
  var mode = 'horizontal';
  var renderTimer = null;
  var composing = false;

  var $ = window.App.ui.$;
  function toast(msg, isErr) { window.App.ui.toast(msg, isErr); }

  /* ================= 纯逻辑（可单测） ================= */

  // 计算合成布局。dims: [{w,h}]；m: horizontal/vertical/grid；cols: 网格列数；gap: 间距 px
  // 返回 {W, H, boxes:[{x,y,w,h,scale}]}，box 为每张图的实际绘制区域
  // 拼接模式 1:1 原尺寸、沿主轴累加、垂直主轴方向居中；
  // 网格模式每格取最大宽高，其余等比缩放（contain）并在格内居中。
  function computeLayout(dims, m, cols, gap) {
    if (!dims || !dims.length) return null;
    gap = Math.max(0, +gap || 0);
    var n = dims.length;

    if (m === 'horizontal' || m === 'vertical') {
      var horiz = m === 'horizontal';
      var cross = 0;
      var offset = 0;
      var boxes = dims.map(function (d) {
        var box = horiz
          ? { x: offset, y: 0, w: d.w, h: d.h, scale: 1 }
          : { x: 0, y: offset, w: d.w, h: d.h, scale: 1 };
        offset += (horiz ? d.w : d.h) + gap;
        cross = Math.max(cross, horiz ? d.h : d.w);
        return box;
      });
      var total = offset - (n ? gap : 0);
      boxes.forEach(function (b) {
        if (horiz) b.y = Math.round((cross - b.h) / 2);
        else b.x = Math.round((cross - b.w) / 2);
      });
      return horiz ? { W: total, H: cross, boxes: boxes } : { W: cross, H: total, boxes: boxes };
    }

    // 网格
    cols = Math.max(1, Math.min(n, Math.round(+cols) || 1));
    var cellW = 0, cellH = 0;
    dims.forEach(function (d) { cellW = Math.max(cellW, d.w); cellH = Math.max(cellH, d.h); });
    var rows = Math.ceil(n / cols);
    var gboxes = dims.map(function (d, i) {
      var scale = Math.min(cellW / d.w, cellH / d.h);
      var bw = Math.round(d.w * scale), bh = Math.round(d.h * scale);
      var cx = (i % cols) * (cellW + gap);
      var cy = Math.floor(i / cols) * (cellH + gap);
      return {
        x: cx + Math.round((cellW - bw) / 2),
        y: cy + Math.round((cellH - bh) / 2),
        w: bw, h: bh, scale: scale
      };
    });
    return {
      W: cols * cellW + (cols - 1) * gap,
      H: rows * cellH + (rows - 1) * gap,
      boxes: gboxes
    };
  }

  /* ================= 列表管理 ================= */

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) {
      return f && /^image\//.test(f.type);
    });
    if (!files.length) { toast('请选择图片文件（JPG/PNG/WebP 等）', true); return; }
    var chain = Promise.resolve();
    var failed = 0;
    files.forEach(function (file) {
      chain = chain.then(function () {
        return createImageBitmap(file).catch(function () { return null; });
      }).then(function (bmp) {
        if (!bmp) { failed++; return; }
        items.push({
          file: file,
          name: file.name || '图片',
          w: bmp.width,
          h: bmp.height,
          url: (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(file) : '',
          bmp: bmp // 缓存解码结果，预览/合成复用；移除与清空时 close 释放
        });
      });
    });
    chain.then(function () {
      if (failed) toast(failed + ' 个文件无法识别，已跳过', true);
      renderThumbs();
      scheduleRender();
    });
  }

  function removeItem(i) {
    var it = items[i];
    if (!it) return;
    if (it.bmp && it.bmp.close) it.bmp.close();
    if (typeof URL !== 'undefined' && URL.revokeObjectURL && it.url) {
      try { URL.revokeObjectURL(it.url); } catch (e) { /* 忽略 */ }
    }
    items.splice(i, 1);
    renderThumbs();
    scheduleRender();
  }

  function moveItem(i, dir) {
    var j = i + dir;
    if (j < 0 || j >= items.length) return;
    var tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
    renderThumbs();
    scheduleRender();
  }

  function clearAll() {
    items.forEach(function (it) {
      if (it.bmp && it.bmp.close) it.bmp.close();
      if (typeof URL !== 'undefined' && URL.revokeObjectURL && it.url) {
        try { URL.revokeObjectURL(it.url); } catch (e) { /* 忽略 */ }
      }
    });
    items = [];
    renderThumbs();
    scheduleRender();
  }

  /* ================= 渲染 ================= */

  function renderThumbs() {
    var wrap = $('cmp-thumbs');
    wrap.textContent = '';
    items.forEach(function (it, i) {
      var box = document.createElement('div');
      box.className = 'cmp-thumb';

      var img = document.createElement('img');
      if (it.url) img.src = it.url;
      img.alt = '';
      box.appendChild(img);

      var ops = document.createElement('div');
      ops.className = 'ops';
      [['‹', '前移一位'], ['›', '后移一位'], ['✕', '移除']].forEach(function (pair) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = pair[0];
        b.title = pair[1];
        b.setAttribute('aria-label', pair[1]);
        b.addEventListener('click', function () {
          if (pair[0] === '✕') removeItem(i);
          else moveItem(i, pair[0] === '‹' ? -1 : 1);
        });
        ops.appendChild(b);
      });
      box.appendChild(ops);
      wrap.appendChild(box);
    });
    $('cmp-count').textContent = items.length
      ? '已选择 ' + items.length + ' 张图片（按预览下方顺序拼合）'
      : '未选择图片';
    $('cmp-run').disabled = items.length === 0 || composing;
    $('cmp-empty').hidden = items.length > 0;
    $('cmp-preview').hidden = items.length === 0;
  }

  // 按当前布局把所有图绘制到 canvas（预览与成品共用）
  async function renderTo(canvas) {
    var dims = items.map(function (it) { return { w: it.w, h: it.h }; });
    var gap = +$('cmp-gap').value || 0;
    var cols = +$('cmp-cols').value || 3;
    var layout = computeLayout(dims, mode, cols, gap);
    if (!layout) return null;
    if (layout.W > MAX_EDGE || layout.H > MAX_EDGE) {
      throw new Error('合成尺寸过大（' + layout.W + '×' + layout.H + '），请减少图片数量或缩小间距');
    }
    canvas.width = layout.W;
    canvas.height = layout.H;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = $('cmp-bg').value;
    ctx.fillRect(0, 0, layout.W, layout.H);
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it.bmp) it.bmp = await createImageBitmap(it.file);
      var b = layout.boxes[i];
      ctx.drawImage(it.bmp, b.x, b.y, b.w, b.h);
    }
    return layout;
  }

  function updateInfo(layout) {
    var names = { horizontal: '横向拼接', vertical: '纵向拼接', grid: '网格拼图' };
    $('cmp-info').textContent = layout
      ? names[mode] + ' · ' + layout.W + '×' + layout.H + ' px · ' + items.length + ' 张'
      : '';
  }

  async function renderPreview() {
    var canvas = $('cmp-preview');
    if (!items.length) {
      canvas.width = 0;
      canvas.height = 0;
      updateInfo(null);
      return;
    }
    try {
      var layout = await renderTo(canvas);
      updateInfo(layout);
    } catch (e) {
      updateInfo(null);
      toast(e.message, true);
    }
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderPreview, 120);
  }

  /* ================= 生成与保存 ================= */

  async function run() {
    if (!items.length || composing) return;
    composing = true;
    $('cmp-run').disabled = true;
    window.App.ui.showLoading('正在合成…');
    try {
      var off = document.createElement('canvas');
      var layout = await renderTo(off); // 离屏重绘，确保与当前参数一致
      var blob = await new Promise(function (res, rej) {
        off.toBlob(function (b) { b ? res(b) : rej(new Error('编码失败')); }, 'image/png');
      });
      window.App.ui.download(blob, '图片合成_' + layout.W + 'x' + layout.H + '.png');
      toast('合成图已保存（' + layout.W + '×' + layout.H + 'px，PNG 无损）');
    } catch (e) {
      toast('合成失败：' + e.message, true);
    }
    window.App.ui.hideLoading();
    composing = false;
    $('cmp-run').disabled = items.length === 0;
  }

  /* ================= 事件绑定 ================= */

  // 整个子页支持拖入图片；拖拽悬停时占位框高亮
  function bindDrop(sectionId) {
    var sec = $(sectionId);
    var es = sec.querySelector('.empty-state');
    ['dragover', 'dragenter'].forEach(function (ev) {
      sec.addEventListener(ev, function (e) {
        e.preventDefault();
        if (es) es.classList.add('drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      sec.addEventListener(ev, function () { if (es) es.classList.remove('drag'); });
    });
    sec.addEventListener('drop', function (e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        addFiles(e.dataTransfer.files);
      }
    });
  }

  // 空态占位框点击 / 回车直接打开选图
  function bindEmptyPick(emptyId, inputId) {
    var el = $(emptyId);
    el.addEventListener('click', function () { $(inputId).click(); });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        $(inputId).click();
      }
    });
  }

  function init() {
    $('cmp-pick').addEventListener('click', function () { $('cmp-file').click(); });
    $('cmp-file').addEventListener('change', function () {
      if (this.files && this.files.length) addFiles(this.files);
      this.value = '';
    });
    bindEmptyPick('cmp-empty', 'cmp-file');

    var modeBtns = $('cmp-mode').querySelectorAll('button');
    modeBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        mode = b.dataset.mode;
        modeBtns.forEach(function (x) { x.classList.toggle('active', x === b); });
        $('cmp-cols-row').hidden = mode !== 'grid';
        scheduleRender();
      });
    });

    $('cmp-cols').addEventListener('change', scheduleRender);
    $('cmp-gap').addEventListener('input', function () {
      $('cmp-gap-val').textContent = this.value + 'px';
      scheduleRender();
    });
    $('cmp-bg').addEventListener('input', scheduleRender);

    $('cmp-clear').addEventListener('click', clearAll);
    $('cmp-run').addEventListener('click', run);
    $('cmp-back').addEventListener('click', function () { window.App.photo.showPhotoSub('menu'); });
    bindDrop('photo-compose');
  }

  window.App = window.App || {};
  window.App.compose = {
    init: init,
    enter: function () { renderThumbs(); scheduleRender(); },
    // 以下导出仅供测试
    _test: {
      MODES: MODES,
      computeLayout: computeLayout
    }
  };
})();
