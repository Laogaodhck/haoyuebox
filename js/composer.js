/* ============================================================
 * composer.js — 换底合成引擎
 * 变换模型：work 坐标 → 输出坐标  x_out = x_work * scale + tx
 * 合成流程：底色 → 原图（按变换绘制）→ 用遮罩做 destination-in
 * 预览与导出共用同一管线，仅画布尺寸不同。
 * ============================================================ */
'use strict';

window.Composer = (function () {

  /* ================= 合成 ================= */
  /* 笔刷拖拽每帧合成的开销大头是 ①画布重分配 ②大图高质量缩放采样。
     这里把「工作图层」与「缩放蒙版」整幅缓存（变换/蒙版不变时直接命中），
     拖拽期间每帧只做小块 1:1 拷贝与脏区蒙版增量重绘，临时画布零重分配。 */

  var _ctxMap = new WeakMap();       // canvas → ctx（避免每帧重复 getContext）
  function ctxOf(c) {
    var x = _ctxMap.get(c);
    if (!x) { x = c.getContext('2d'); _ctxMap.set(c, x); }
    return x;
  }

  function ensureSize(c, w, h) {
    if (!c) c = document.createElement('canvas');
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return c;
  }

  /* 工作图层缓存：work 按 tf 绘制到 outW×outH（透明底，不含底色 → 换底色无需失效）。
     key 含变换与尺寸：换图 / 缩放 / 平移 / 目标尺寸变化自动重建。 */
  var _layerC = null, _layerWork = null, _layerKey = '';
  function workLayer(st, outW, outH, tf) {
    /* key 含 _workRev：皮肤美白等就地重写工作图后缓存自动重建 */
    var key = outW + 'x' + outH + '|' + tf.scale + '|' + tf.tx + '|' + tf.ty + '|w' + (st._workRev || 0);
    if (_layerC && _layerWork === st.workCanvas && _layerKey === key) return _layerC;
    var c = ensureSize(_layerC, outW, outH);
    _layerC = c; _layerWork = st.workCanvas; _layerKey = key;
    var x = ctxOf(c);
    x.clearRect(0, 0, outW, outH);
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(st.workCanvas, tf.tx, tf.ty,
      st.workCanvas.width * tf.scale, st.workCanvas.height * tf.scale);
    return c;
  }

  /* 缩放蒙版缓存：mask 按 tf 绘制到 outW×outH。
     脏区拖拽时只增量重绘对应小块（源侧外扩 2/scale+1px，覆盖缩放采样邻域与
     源矩形边缘滤波效应），替代每帧整幅高分辨率蒙版的缩放采样。
     key 含 _maskRev：undo / 重置蒙版等整幅重写后自动全量重建；
     整幅渲染（region=null）时也全量重绘，兜底保证缓存与蒙版一致。 */
  var _smC = null, _smMask = null, _smKey = '';
  function scaledMask(st, outW, outH, tf, region) {
    var key = outW + 'x' + outH + '|' + tf.scale + '|' + tf.tx + '|' + tf.ty
      + '|r' + (st._maskRev || 0);
    if (!(_smC && _smMask === st.maskCanvas && _smKey === key)) {
      var c0 = ensureSize(_smC, outW, outH);
      _smC = c0; _smMask = st.maskCanvas; _smKey = key;
      var x0 = ctxOf(c0);
      x0.clearRect(0, 0, outW, outH);
      x0.imageSmoothingEnabled = true;
      x0.imageSmoothingQuality = 'high';
      x0.drawImage(st.maskCanvas, tf.tx, tf.ty,
        st.maskCanvas.width * tf.scale, st.maskCanvas.height * tf.scale);
      return c0;
    }
    var x = ctxOf(_smC);
    if (region) {
      var pad = 2 / tf.scale + 1;
      var sx = (region.x - tf.tx) / tf.scale - pad;
      var sy = (region.y - tf.ty) / tf.scale - pad;
      var sw = region.w / tf.scale + 2 * pad;
      var sh = region.h / tf.scale + 2 * pad;
      x.clearRect(tf.tx + sx * tf.scale, tf.ty + sy * tf.scale, sw * tf.scale, sh * tf.scale);
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      x.drawImage(st.maskCanvas, sx, sy, sw, sh,
        tf.tx + sx * tf.scale, tf.ty + sy * tf.scale, sw * tf.scale, sh * tf.scale);
    } else {
      x.clearRect(0, 0, outW, outH);
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      x.drawImage(st.maskCanvas, tf.tx, tf.ty,
        st.maskCanvas.width * tf.scale, st.maskCanvas.height * tf.scale);
    }
    return _smC;
  }

  /* 前景临时画布（整幅尺寸，拖拽期间零重分配） */
  var _fgC = null;

  /* dirty：可选，输出坐标 {x,y,w,h}——只重绘该矩形（笔刷拖拽时局部合成，避免全画布开销） */
  function compositeInto(ctx, outW, outH, st, dirty) {
    var work = st.workCanvas;
    var mask = st.maskCanvas;
    var tf = st.transform;
    if (!work || !mask || !tf) return;

    var vx = dirty ? dirty.x : 0, vy = dirty ? dirty.y : 0;
    var cw = dirty ? dirty.w : outW, ch = dirty ? dirty.h : outH;

    /* 图层缓存（笔画期间变换不变 → 每帧仅小块拷贝） */
    var layer = workLayer(st, outW, outH, tf);
    var sm = scaledMask(st, outW, outH, tf, dirty);

    /* 前景 = 工作图层 ∧ 蒙版（仅脏区）。1:1 拷贝无插值，与按 tf 直绘逐像素一致 */
    var fg = ensureSize(_fgC, outW, outH);
    _fgC = fg;
    var fx = ctxOf(fg);
    fx.clearRect(vx, vy, cw, ch);
    fx.drawImage(layer, vx, vy, cw, ch, vx, vy, cw, ch);
    fx.globalCompositeOperation = 'destination-in';
    fx.drawImage(sm, vx, vy, cw, ch, vx, vy, cw, ch);
    fx.globalCompositeOperation = 'source-over';

    /* 目标画布 = 底色 + 前景 */
    ctx.save();
    ctx.clearRect(vx, vy, cw, ch);
    ctx.fillStyle = st.bg || '#FFFFFF';
    ctx.fillRect(vx, vy, cw, ch);
    ctx.drawImage(fg, vx, vy, cw, ch, vx, vy, cw, ch);
    ctx.restore();
  }

  /* ---------- 相纸排版引擎（支持多种相纸，供照片/排版两模块共用） ----------
   * 版面参数为实测标定方案（300DPI）：间距横纵固定 2.4mm(28px) · 左右安全边距 5mm(59px)
   * A4 一寸可排 7 列 × 7 行 = 49 张；水平按列宽居中，
   * 批量逐格版（layoutBatch）所有页首行统一锚定 MARGIN_Y(5mm)，余量留底部 */
  var MM = 300 / 25.4;
  var GAP_X = Math.round(2.4 * MM);    // 28px
  var GAP_Y = GAP_X;                   // 间距固定 2.4mm（横纵一致）
  var MARGIN_X = Math.round(5 * MM);   // 59px
  var MARGIN_Y = Math.round(5 * MM);   // 59px

  var PAPERS = {
    '6inch': { name: '六寸横版', w: 1800, h: 1200 },
    'a4':    { name: 'A4 竖版',  w: 2480, h: 3508 },
    'b5':    { name: 'B5 竖版',  w: 2149, h: 3035 },  /* 182×257mm */
    'a5':    { name: 'A5 竖版',  w: 1748, h: 2480 },  /* 148×210mm */
    'a3':    { name: 'A3 竖版',  w: 3508, h: 4961 }   /* 297×420mm */
  };

  /* opts: { gapX, gapY, marginX, marginY }（省略项用默认标定值） */
  function bestLayout(pw, ph, sheetW, sheetH, opts) {
    sheetW = sheetW || 1800; sheetH = sheetH || 1200;   // 缺省六寸
    opts = opts || {};
    var gapX = (typeof opts.gapX === 'number') ? opts.gapX : GAP_X;
    var gapY = (typeof opts.gapY === 'number') ? opts.gapY : GAP_Y;
    var mX = (typeof opts.marginX === 'number') ? opts.marginX : MARGIN_X;
    var mY = (typeof opts.marginY === 'number') ? opts.marginY : MARGIN_Y;
    var availW = sheetW - 2 * mX, availH = sheetH - 2 * mY;
    var best = null;
    for (var cols = 1; cols <= 24; cols++) {
      for (var rows = 1; rows <= 24; rows++) {
        var w = pw, h = ph; // 保持正立方向，不旋转
        var tw = cols * w + (cols - 1) * gapX;
        var th = rows * h + (rows - 1) * gapY;
        if (tw > availW || th > availH) continue;
        var n = cols * rows;
        var waste = availW * availH - tw * th;
        if (!best || n > best.n || (n === best.n && waste < best.waste)) {
          best = { cols: cols, rows: rows, w: w, h: h, n: n, waste: waste };
        }
      }
    }
    return best;
  }

  /* layoutGroups(cells, paperKey, opts)
   * cells : 单张成品 canvas 数组（N≥1）；N>1 时版面纵向均分 N 组，
   *         每组用一张不同照片独立排布（多人合照版）
   * 返回 { canvas, layout, n, groups, width, height, dpi, paper } */
  function layoutGroups(cells, paperKey, opts) {
    opts = opts || {};
    var paper = PAPERS[paperKey] || PAPERS['6inch'];
    /* opts.gap（UI 单滑块）同时作用横纵；gapX/gapY 可分别覆盖 */
    var gapX = (typeof opts.gapX === 'number') ? opts.gapX
             : (typeof opts.gap === 'number') ? opts.gap : GAP_X;
    var gapY = (typeof opts.gapY === 'number') ? opts.gapY
             : (typeof opts.gap === 'number') ? opts.gap : GAP_Y;
    var n = cells.length;
    if (!n) return null;

    var availH = paper.h - 2 * MARGIN_Y;
    var groupH = Math.floor((availH - (n - 1) * gapY) / n);
    if (groupH < 40) return null;

    var sheet = document.createElement('canvas');
    sheet.width = paper.w; sheet.height = paper.h;
    var ctx = sheet.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, paper.w, paper.h);

    var groups = [], total = 0, anyRotated = false;
    for (var i = 0; i < n; i++) {
      var cell = cells[i];
      // bestLayout 会从 sheetH 中再扣 2×marginY，故此处传入 groupH+2×marginY 抵消
      var layout = bestLayout(cell.width, cell.height, paper.w, groupH + 2 * MARGIN_Y,
        { gapX: gapX, gapY: gapY, marginY: MARGIN_Y });
      var rotated = false;
      if (!layout && cell.width !== cell.height) {
        // 组高放不下正立照片 → 旋转 90° 横向排布（裁切后转正）
        layout = bestLayout(cell.height, cell.width, paper.w, groupH + 2 * MARGIN_Y,
          { gapX: gapX, gapY: gapY, marginY: MARGIN_Y });
        rotated = !!layout;
      }
      if (!layout) return null;
      var drawCell = cell;
      if (rotated) {
        drawCell = document.createElement('canvas');
        drawCell.width = cell.height; drawCell.height = cell.width;
        var rc = drawCell.getContext('2d');
        rc.translate(drawCell.width / 2, drawCell.height / 2);
        rc.rotate(Math.PI / 2);
        rc.drawImage(cell, -cell.width / 2, -cell.height / 2);
      }
      anyRotated = anyRotated || rotated;
      var tw = layout.cols * layout.w + (layout.cols - 1) * gapX;
      var th = layout.rows * layout.h + (layout.rows - 1) * gapY;
      var availW = paper.w - 2 * MARGIN_X;
      var startX = MARGIN_X + Math.round((availW - tw) / 2);
      var startY = MARGIN_Y + Math.round(i * (groupH + gapY) + (groupH - th) / 2);

      for (var r = 0; r < layout.rows; r++) {
        for (var c = 0; c < layout.cols; c++) {
          ctx.drawImage(drawCell, startX + c * (layout.w + gapX), startY + r * (layout.h + gapY));
        }
      }

      if (opts.cutLines !== false) {
        ctx.save();
        ctx.strokeStyle = 'rgba(120,120,120,0.9)';
        ctx.lineWidth = 1;
        for (var c2 = 0; c2 <= layout.cols; c2++) {
          var lx = startX + c2 * (layout.w + gapX) - (c2 === layout.cols ? 0 : gapX / 2);
          ctx.beginPath(); ctx.moveTo(lx, startY); ctx.lineTo(lx, startY + th); ctx.stroke();
        }
        for (var r2 = 0; r2 <= layout.rows; r2++) {
          var ly = startY + r2 * (layout.h + gapY) - (r2 === layout.rows ? 0 : gapY / 2);
          ctx.beginPath(); ctx.moveTo(startX, ly); ctx.lineTo(startX + tw, ly); ctx.stroke();
        }
        ctx.restore();
      }

      groups.push({ layout: layout, rotated: rotated, top: startY, height: th });
      total += layout.n;
    }

    return { canvas: sheet, layout: groups[0].layout, n: total, groups: groups, rotated: anyRotated,
             width: paper.w, height: paper.h, dpi: 300, paper: paper };
  }

  /* sheetCapacity(cellW, cellH, paperKey, opts)
   * 计算单版可容纳的网格：{ cols, rows, capacity }（opts 同上，兼容旧数字 gap） */
  function sheetCapacity(cellW, cellH, paperKey, opts) {
    opts = (typeof opts === 'number') ? { gap: opts } : (opts || {});
    var paper = PAPERS[paperKey] || PAPERS['6inch'];
    var gapX = (typeof opts.gapX === 'number') ? opts.gapX
             : (typeof opts.gap === 'number') ? opts.gap : GAP_X;
    var gapY = (typeof opts.gapY === 'number') ? opts.gapY
             : (typeof opts.gap === 'number') ? opts.gap : GAP_Y;
    var availW = paper.w - 2 * MARGIN_X;
    var availH = paper.h - 2 * MARGIN_Y;
    var cols = Math.max(1, Math.floor((availW + gapX) / (cellW + gapX)));
    var rows = Math.max(1, Math.floor((availH + gapY) / (cellH + gapY)));
    return { cols: cols, rows: rows, capacity: cols * rows };
  }

  /* layoutBatch(cells, paperKey, opts)
   * 批量逐格排版：cells 为已统一尺寸的照片 canvas 列表，按顺序
   * 逐格填入网格；一版放不下自动分页。每张照片独立裁切框。
   * 返回 { pages:[{canvas, rowsUsed, count}], cols, capacity, total, width, height, dpi, paper } */
  function layoutBatch(cells, paperKey, opts) {
    opts = opts || {};
    var paper = PAPERS[paperKey] || PAPERS['6inch'];
    var gapX = (typeof opts.gapX === 'number') ? opts.gapX
             : (typeof opts.gap === 'number') ? opts.gap : GAP_X;
    var gapY = (typeof opts.gapY === 'number') ? opts.gapY
             : (typeof opts.gap === 'number') ? opts.gap : GAP_Y;
    if (!cells.length) return null;

    var cellW = cells[0].width, cellH = cells[0].height;
    var cap = sheetCapacity(cellW, cellH, paperKey, { gapX: gapX, gapY: gapY });
    var availW = paper.w - 2 * MARGIN_X;
    var availH = paper.h - 2 * MARGIN_Y;
    // 照片任意一边超过相纸可打印区：硬性放不下（放进去也必然越界裁切），
    // 返回 null 交由调用方提示，绝不静默裁切
    if (cellW > availW || cellH > availH) return null;
    var startX = MARGIN_X + Math.round((availW - (cap.cols * cellW + (cap.cols - 1) * gapX)) / 2);
    var pages = [];

    for (var p = 0; p * cap.capacity < cells.length; p++) {
      var chunk = cells.slice(p * cap.capacity, (p + 1) * cap.capacity);
      var rowsUsed = Math.ceil(chunk.length / cap.cols);

      var sheet = document.createElement('canvas');
      sheet.width = paper.w; sheet.height = paper.h;
      var ctx = sheet.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, paper.w, paper.h);

      // 纵向定位：所有页统一顶部锚定——首行精确落在 MARGIN_Y（5mm），
      // 不管本页多少张（含恰好排满），多余空间全部留在底部；多页叠放裁切时每页首行位置一致。
      // 锚点必须 ≤ MARGIN_Y：容量按 paper.h − 2×MARGIN_Y 计算行数，
      // 若锚点更高（如 7mm），满页时底边距会缩水到 3mm，有裁切风险
      var startY = MARGIN_Y;   // 59px = 5mm@300DPI

      for (var i = 0; i < chunk.length; i++) {
        var x = startX + (i % cap.cols) * (cellW + gapX);
        var y = startY + Math.floor(i / cap.cols) * (cellH + gapY);
        ctx.drawImage(chunk[i], x, y);
        if (opts.cutLines !== false) {
          ctx.save();
          ctx.strokeStyle = 'rgba(120,120,120,0.9)';
          ctx.lineWidth = 1;
          ctx.strokeRect(x - 0.5, y - 0.5, cellW + 1, cellH + 1);
          ctx.restore();
        }
      }
      pages.push({ canvas: sheet, rowsUsed: rowsUsed, count: chunk.length });
    }

    return { pages: pages, cols: cap.cols, capacity: cap.capacity, total: cells.length,
             width: paper.w, height: paper.h, dpi: 300, paper: paper };
  }

  /* layoutExact(cells, paperKey, opts)
   * 精确张数排版：整版只放置 cells.length 张（1–4 张，同一照片），
   * 自动选择行列组合，居中留白，每张照片单独描裁切框。
   * 返回 { canvas, layout, n, rotated, width, height, dpi, paper } */
  function layoutExact(cells, paperKey, opts) {
    opts = opts || {};
    var paper = PAPERS[paperKey] || PAPERS['6inch'];
    var gapX = (typeof opts.gapX === 'number') ? opts.gapX
             : (typeof opts.gap === 'number') ? opts.gap : GAP_X;
    var gapY = (typeof opts.gapY === 'number') ? opts.gapY
             : (typeof opts.gap === 'number') ? opts.gap : GAP_Y;
    var n = cells.length;
    if (!n) return null;

    var availW = paper.w - 2 * MARGIN_X;
    var availH = paper.h - 2 * MARGIN_Y;
    var first = cells[0];

    function tryOrient(w, h) { // 选最省纸的行列组合（cols×rows ≥ n 即可，多余格不用）
      var best = null;
      for (var cols = 1; cols <= n; cols++) {
        var rows = Math.ceil(n / cols);
        var tw = cols * w + (cols - 1) * gapX;
        var th = rows * h + (rows - 1) * gapY;
        if (tw > availW || th > availH) continue;
        var waste = availW * availH - tw * th;
        if (!best || waste < best.waste) best = { cols: cols, rows: rows, w: w, h: h, waste: waste };
      }
      return best;
    }

    var layout = tryOrient(first.width, first.height);
    var rotated = false;
    if (!layout && first.width !== first.height) {
      layout = tryOrient(first.height, first.width);
      rotated = !!layout;
    }
    if (!layout) return null;

    var drawCell = first;
    if (rotated) {
      drawCell = document.createElement('canvas');
      drawCell.width = first.height; drawCell.height = first.width;
      var rc = drawCell.getContext('2d');
      rc.translate(drawCell.width / 2, drawCell.height / 2);
      rc.rotate(Math.PI / 2);
      rc.drawImage(first, -first.width / 2, -first.height / 2);
    }

    var sheet = document.createElement('canvas');
    sheet.width = paper.w; sheet.height = paper.h;
    var ctx = sheet.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, paper.w, paper.h);

    var tw = layout.cols * layout.w + (layout.cols - 1) * gapX;
    var th = layout.rows * layout.h + (layout.rows - 1) * gapY;
    var startX = MARGIN_X + Math.round((availW - tw) / 2);
    var startY = MARGIN_Y + Math.round((availH - th) / 2);

    for (var i = 0; i < n; i++) {
      var col = i % layout.cols;
      var row = Math.floor(i / layout.cols);
      var x = startX + col * (layout.w + gapX);
      var y = startY + row * (layout.h + gapY);
      ctx.drawImage(drawCell, x, y);
      if (opts.cutLines !== false) {
        ctx.save();
        ctx.strokeStyle = 'rgba(120,120,120,0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 0.5, y - 0.5, layout.w + 1, layout.h + 1);
        ctx.restore();
      }
    }

    return { canvas: sheet, layout: { cols: layout.cols, rows: layout.rows, w: layout.w, h: layout.h, n: n },
             n: n, rotated: rotated, width: paper.w, height: paper.h, dpi: 300, paper: paper };
  }

  /* layoutSheet(cell, paperKey, opts) — 单张照片铺满整版 */
  function layoutSheet(cell, paperKey, opts) {
    return layoutGroups([cell], paperKey, opts);
  }

  /* 照片模块用：按 State 合成单张，再排版 */
  function buildSheet(st, spec, paperKey, opts) {
    var cell = document.createElement('canvas');
    cell.width = spec.pxW; cell.height = spec.pxH;
    compositeInto(cell.getContext('2d'), spec.pxW, spec.pxH, st);
    return layoutSheet(cell, paperKey, opts);
  }

  return { compositeInto: compositeInto, buildSheet: buildSheet, bestLayout: bestLayout, layoutSheet: layoutSheet, layoutGroups: layoutGroups, layoutExact: layoutExact, layoutBatch: layoutBatch, sheetCapacity: sheetCapacity, PAPERS: PAPERS };
})();
