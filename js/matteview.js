/* ============================================================
 * matteview.js — 抠图换底画布自由缩放/平移控制器
 * 滚轮 / 双指捏合 / 工具栏按钮：以光标为锚点缩放（1×–8×）
 * 空格按住拖动 / 鼠标中键拖动：平移画面
 * 视图状态存于 st.matteView = { zoom, panX, panY }（zoom 为相对适配比例），
 * 合成时换算为 work→画布 变换（st.viewTf）供笔刷坐标映射使用。
 * ============================================================ */
'use strict';

window.MatteView = (function () {

  var ZOOM_MIN = 1, ZOOM_MAX = 8;
  var attached = new WeakMap();  // canvas → 已挂载的控制器（防重复 attach 造成监听器叠加）

  function attach(canvas, st, hooks) {
    if (attached.has(canvas)) return attached.get(canvas);
    hooks = hooks || {};
    var pointers = new Map();   // pointerId → canvas 坐标
    var pinch = null;           // { d, cx, cy }
    var panning = false;        // 中键/空格拖动中
    var panLast = null;
    var spaceHeld = false;

    function v() {
      if (!st.matteView) st.matteView = { zoom: 1, panX: 0, panY: 0 };
      return st.matteView;
    }

    function canvasPt(e) {
      var r = canvas.getBoundingClientRect();
      var k = canvas.width / (r.width || 1); // CSS px → 画布 px
      return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
    }

    function clampPan() {
      var m = v();
      var work = st.workCanvas;
      if (!work || !canvas.width) return;
      var k = canvas.width / work.width;
      var dw, dh;
      var rot = Math.abs((st.tilt || 0) * Math.PI / 180);
      if (rot) {
        /* 倾斜后内容包围盒外扩（对角投影），按外扩范围限制平移；
           边角露底色属于倾斜的正常表现，不做覆盖性钳制 */
        var cos = Math.cos(rot), sin = Math.sin(rot);
        dw = (work.width * cos + work.height * sin) * k * m.zoom;
        dh = (work.width * sin + work.height * cos) * k * m.zoom;
      } else {
        dw = work.width * k * m.zoom;
        dh = work.height * k * m.zoom;
      }
      var W = canvas.width, H = canvas.height;
      m.panX = Math.min(Math.max(m.panX, Math.min(0, W - dw)), Math.max(0, W - dw));
      m.panY = Math.min(Math.max(m.panY, Math.min(0, H - dh)), Math.max(0, H - dh));
    }

    function emit() {
      clampPan();
      if (hooks.onZoom) hooks.onZoom(Math.round(v().zoom * 100));
      if (hooks.onChange) hooks.onChange();
    }

    /* 以画布坐标 (px,py) 为锚点缩放 f 倍 */
    function zoomAt(px, py, f) {
      var m = v();
      var nz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, m.zoom * f));
      f = nz / m.zoom;
      if (f === 1) { emit(); return; }
      m.panX = px - f * (px - m.panX);
      m.panY = py - f * (py - m.panY);
      m.zoom = nz;
      emit();
    }

    function fit() {
      var m = v();
      m.zoom = 1; m.panX = 0; m.panY = 0;
      emit();
    }

    function pinchState() {
      var pts = [];
      pointers.forEach(function (p) { pts.push(p); });
      return {
        d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        cx: (pts[0].x + pts[1].x) / 2,
        cy: (pts[0].y + pts[1].y) / 2
      };
    }

    function setPanMode(on) {
      st.mattePanActive = on;
      canvas.classList.toggle('panning', on);
      if (hooks.onPanMode) hooks.onPanMode(on);
    }

    /* ---------- 指针：双指捏合 + 中键/空格平移 ---------- */
    canvas.addEventListener('pointerdown', function (e) {
      if (e.button === 1 || spaceHeld) { // 中键或空格：平移，不落笔
        panning = true;
        panLast = canvasPt(e);
        setPanMode(true);
        if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 指针已释放等场景捕获失败，可忽略 */ } }
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      pointers.set(e.pointerId, canvasPt(e));
      if (pointers.size === 2) { // 进入捏合
        pinch = pinchState();
        setPanMode(true);
      }
    });

    canvas.addEventListener('pointermove', function (e) {
      if (panning) {
        var p = canvasPt(e);
        var m = v();
        m.panX += p.x - panLast.x;
        m.panY += p.y - panLast.y;
        panLast = p;
        emit();
        e.preventDefault();
        return;
      }
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, canvasPt(e));
      if (pointers.size === 2 && pinch) { // 双指：锚点缩放 + 中点平移
        var s2 = pinchState();
        zoomAt(s2.cx, s2.cy, s2.d / (pinch.d || 1));
        var m2 = v();
        m2.panX += s2.cx - pinch.cx;
        m2.panY += s2.cy - pinch.cy;
        pinch = s2;
        emit();
      }
    });

    function stop(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0 && !panning) setPanMode(false);
      if (panning && (e.button === 1 || e.type === 'pointercancel' || !pointers.size)) {
        panning = false; panLast = null;
        if (!spaceHeld) setPanMode(false);
      }
    }
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);

    /* ---------- 滚轮缩放（落笔/捏合期间忽略） ---------- */
    canvas.addEventListener('wheel', function (e) {
      if (pointers.size > 0 || panning) return;
      e.preventDefault();
      var p = canvasPt(e);
      zoomAt(p.x, p.y, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    /* ---------- 空格按住 = 平移模式 ---------- */
    window.addEventListener('keydown', function (e) {
      if (e.code !== 'Space' || spaceHeld) return;
      if (hooks.isActive && !hooks.isActive()) return;
      var t = e.target;
      // 输入控件（单行/多行/下拉/可编辑区）里空格是正常输入，不劫持
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      // preventDefault 同时阻止浏览器对聚焦按钮的「空格激活」（避免平移时误触工具栏按钮）
      spaceHeld = true;
      setPanMode(true);
      e.preventDefault();
    });
    window.addEventListener('keyup', function (e) {
      if (e.code !== 'Space' || !spaceHeld) return;
      spaceHeld = false;
      if (!panning && pointers.size < 2) setPanMode(false);
    });

    var ctrl = {
      zoomAt: zoomAt,
      zoomStep: function (f) { zoomAt(canvas.width / 2, canvas.height / 2, f); },
      fit: fit,
      get zoom() { return v().zoom; }
    };
    attached.set(canvas, ctrl);
    return ctrl;
  }

  return { attach: attach };
})();
