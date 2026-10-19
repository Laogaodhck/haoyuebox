/* ============================================================
 * cropper.js — 裁剪交互（拖动平移 / 滚轮·双指缩放）
 * 输出画框固定为规格像素尺寸，人在框内拖动缩放，
 * 保证图片始终覆盖整个画框（不留白边）。
 * ============================================================ */
'use strict';

window.Cropper = (function () {

  /* 倾斜校正坐标映射：work 坐标 → 倾斜后坐标（绕工作图中心旋转 θ）。
     transform（缩放/平移）作用在倾斜后的内容上，
     自动对齐测得的特征点须先过此映射再求位移。 */
  function tiltPoint(st, x, y) {
    var t = (st.tilt || 0) * Math.PI / 180;
    if (!t) return { x: x, y: y };
    var cx = st.workCanvas.width / 2, cy = st.workCanvas.height / 2;
    var cos = Math.cos(t), sin = Math.sin(t);
    var dx = x - cx, dy = y - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  }

  /* 最小缩放：倾斜后能水平/垂直铺满画框的内容宽度收窄（内接矩形），
     minScale 相应放大，保证任意平移位置画框都不会露出底色楔形 */
  function minScaleFor(st) {
    var work = st.workCanvas;
    var w = work.width, h = work.height;
    var rot = Math.abs((st.tilt || 0) * Math.PI / 180);
    if (rot) {
      var cos = Math.cos(rot), sin = Math.sin(rot);
      w = Math.max(1, w * cos - h * sin);
      h = Math.max(1, h * cos - w * sin);
    }
    return Math.max(st.outW / w, st.outH / h);
  }

  function clampTransform(st) {
    var tf = st.transform;
    var work = st.workCanvas;
    var outW = st.outW, outH = st.outH;
    var minScale = minScaleFor(st);
    tf.scale = Math.max(minScale, Math.min(minScale * 6, tf.scale));
    var dw = work.width * tf.scale;
    var dh = work.height * tf.scale;
    tf.tx = Math.min(0, Math.max(outW - dw, tf.tx));
    tf.ty = Math.min(0, Math.max(outH - dh, tf.ty));
  }

  function fitCenter(st) {
    var work = st.workCanvas;
    var scale = Math.max(st.outW / work.width, st.outH / work.height) * 1.08;
    if (st.tilt) scale = Math.max(scale, minScaleFor(st) * 1.08);
    st.transform = {
      scale: scale,
      tx: 0, ty: 0
    };
    clampTransform(st);
    st.transform.tx = (st.outW - work.width * st.transform.scale) / 2;
    st.transform.ty = (st.outH - work.height * st.transform.scale) / 2;
    clampTransform(st);
  }

  /* ---------- 智能自动对齐 ----------
   * 分析蒙版得到头顶位置、头宽与水平中心，
   * 按所选规格的头顶/下巴参考线自动计算缩放与位移，
   * 使头部占比一次到位，用户只需微调。 */
  function analyzeMask(st) {
    var mask = st.maskCanvas;
    if (!mask) return null;
    var W = 200; // 降采样分析，加速
    var H = Math.max(1, Math.round(mask.height * (W / mask.width)));
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');
    ctx.drawImage(mask, 0, 0, W, H);
    var d = ctx.getImageData(0, 0, W, H).data;

    function fgRow(y) { // 返回该行前景 [count, minx, maxx, sumX]
      var cnt = 0, minx = -1, maxx = -1, sumX = 0;
      var base = y * W * 4;
      for (var x = 0; x < W; x++) {
        if (d[base + x * 4 + 3] >= 128) {
          cnt++; sumX += x;
          if (minx < 0) minx = x;
          maxx = x;
        }
      }
      return [cnt, minx, maxx, sumX];
    }

    var top = -1, bottom = -1, rows = [];
    for (var y = 0; y < H; y++) {
      rows.push(fgRow(y));
      if (top < 0 && rows[y][0] > W * 0.02) top = y;
    }
    for (y = H - 1; y >= 0; y--) {
      if (rows[y][0] > W * 0.02) { bottom = y; break; }
    }
    if (top < 0 || bottom <= top) return null;

    // 头宽：头顶往下 25% 区域内行宽的 40 分位数（抵抗蓬松头发干扰）
    var widths = [];
    var headEnd = Math.min(bottom, top + Math.round((bottom - top) * 0.25));
    for (y = top; y <= headEnd; y++) {
      if (rows[y][0] > W * 0.02) widths.push(rows[y][2] - rows[y][1] + 1);
    }
    if (!widths.length) return null;
    widths.sort(function (a, b) { return a - b; });
    var headW = widths[Math.floor(widths.length * 0.4)];

    // 水平中心：整体前景质心（身体居中比头部质心更稳）
    var tot = 0, sx = 0;
    for (y = 0; y < H; y++) { tot += rows[y][0]; sx += rows[y][3]; }
    var cx = tot > 0 ? sx / tot : W / 2;

    var k = mask.width / W; // 分析坐标 → work 坐标
    return { top: top * k, headW: headW * k, centerX: cx * k };
  }

  function autoAlign(st) {
    var a = null;
    try { a = analyzeMask(st); } catch (e) { a = null; }
    if (!a || a.headW < 4) { fitCenter(st); return; }
    var sp = st.spec;
    var targetTop = sp.head.top * st.outH;
    var targetChin = sp.head.chin * st.outH;
    // 头高 ≈ 头宽 × 1.45（含发型的统计平均）
    var headPx = a.headW * 1.45;
    var scale = (targetChin - targetTop) / headPx;
    var minScale = minScaleFor(st);
    scale = Math.max(minScale, Math.min(minScale * 6, scale));
    /* 倾斜校正下特征点先映射到倾斜后坐标（transform 作用在倾斜内容上） */
    var head = tiltPoint(st, a.centerX, a.top);
    st.transform = {
      scale: scale,
      tx: st.outW / 2 - head.x * scale,
      ty: targetTop - head.y * scale
    };
    clampTransform(st);
  }

  function attach(canvas, st, hooks) {
    var dragging = false;
    var lastPt = null;
    var pinch = null; // { dist, scale }
    var activePointers = new Map();

    function pointers() {
      var ids = [];
      activePointers.forEach(function (v, id) { ids.push(v); });
      return ids;
    }

    function pt(e) {
      var rect = canvas.getBoundingClientRect();
      var k = canvas.width / rect.width; // 显示坐标 → 画框(输出)坐标
      return { x: (e.clientX - rect.left) * k, y: (e.clientY - rect.top) * k };
    }

    canvas.addEventListener('pointerdown', function (e) {
      activePointers.set(e.pointerId, pt(e));
      // 指针可能已失效（快速连点/触摸边缘场景），捕获失败不中断拖拽初始化
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ } }
      if (activePointers.size === 2) {
        var a = pointers()[0], b = pointers()[1];
        pinch = { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), scale: st.transform.scale };
      }
      dragging = true;
      lastPt = pt(e);
      e.preventDefault();
    });

    canvas.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, pt(e));
      if (activePointers.size === 2 && pinch) {
        var ps = pointers();
        var d = Math.max(1, Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y)); // 双指重合时按 1 处理，防除零放大 Infinity
        var f = d / pinch.dist;
        var cx = (ps[0].x + ps[1].x) / 2, cy = (ps[0].y + ps[1].y) / 2;
        zoomAt(cx, cy, (pinch.scale * f) / st.transform.scale);
      } else {
        var p = pt(e);
        st.transform.tx += p.x - lastPt.x;
        st.transform.ty += p.y - lastPt.y;
        lastPt = p;
        clampTransform(st);
      }
      if (hooks && hooks.onChange) hooks.onChange();
      e.preventDefault();
    });

    function stop(e) {
      activePointers.delete(e.pointerId);
      if (activePointers.size < 2) pinch = null;
      if (activePointers.size === 0) dragging = false;
    }
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = pt(e);
      var f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAt(p.x, p.y, f);
      if (hooks && hooks.onChange) hooks.onChange();
    }, { passive: false });

    function zoomAt(px, py, factor) {
      var tf = st.transform;
      var ns = tf.scale * factor;
      // 以 (px,py) 为锚点缩放
      tf.tx = px - factor * (px - tf.tx);
      tf.ty = py - factor * (py - tf.ty);
      tf.scale = ns;
      clampTransform(st);
    }

    return { zoomAt: zoomAt, clamp: clampTransform };
  }

  return {
    attach: attach, fitCenter: fitCenter, autoAlign: autoAlign, clampTransform: clampTransform,
    /* 以下仅供单测（倾斜坐标映射与最小缩放是「画框不留白边」的核心几何） */
    _test: { tiltPointRef: tiltPoint, minScaleForRef: minScaleFor }
  };
})();
