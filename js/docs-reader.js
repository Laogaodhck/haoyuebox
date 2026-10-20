/* ============================================================
 * docs-reader.js — 文档工具子功能：PDF 阅读器
 * 打开本机 PDF 逐页浏览（纯本地，pdf.js 渲染，复用 pdfcore.loadPdf）：
 *  - 翻页：上一页/下一页按钮 + 键盘（←/→/PgUp/PgDn/空格）；
 *  - 缩放：适应宽度 / 适应页面 / 自定义档位（Ctrl+滚轮或 ± 按钮）；
 *  - 跳转：输入页码直达任意页。
 * 仅渲染当前页；翻页/缩放竞态用渲染序号丢弃过期帧。
 * 渲染尺寸按 devicePixelRatio 放大保证高分屏清晰，超大面积自动降采样。
 * ============================================================ */
(function (App) {
  'use strict';

  var $ = App.ui.$;

  var pdf = null;            // pdf.js 文档句柄（换文件/失败时 cleanup）
  var numPages = 0;
  var cur = 0;               // 当前页（1 基）
  var mode = 'width';        // width | page | free
  var zoom = 100;            // free 模式缩放百分比（相对 72dpi 基准）
  var renderSeq = 0;         // 渲染序号：序号过期即丢弃，防快速翻页帧错乱
  var baseW = 1, baseH = 1;  // 当前页 72dpi 基准尺寸（pt）
  var resizeTimer = null;

  var ZOOMS = [25, 33, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400];
  var MAX_RENDER_PX = 30 * 1000 * 1000;  // 单页渲染像素上限（防超大页面爆内存）

  function toast(msg, isErr) { App.ui.toast(msg, isErr); }
  function setStatus(msg) { $('dr-status').textContent = msg || ''; }

  /* ---------- 缩放计算 ---------- */

  /* 视口内边距：与 #dr-view 的 padding 保持一致 */
  var VIEW_PAD = 32;

  function displayScale() {
    var el = $('dr-view');
    var vw = Math.max(40, el.clientWidth - VIEW_PAD);
    var vh = Math.max(40, el.clientHeight - VIEW_PAD);
    if (mode === 'width') return vw / baseW;
    if (mode === 'page') return Math.min(vw / baseW, vh / baseH);
    return zoom / 100;
  }

  function effectivePct() { return Math.round(displayScale() * 100); }

  function syncUi() {
    $('dr-page-ind').textContent = numPages ? (cur + ' / ' + numPages) : '– / –';
    $('dr-prev').disabled = !numPages || cur <= 1;
    $('dr-next').disabled = !numPages || cur >= numPages;
    $('dr-zoom-val').textContent = effectivePct() + '%';
  }

  /* ---------- 渲染当前页 ---------- */
  async function render() {
    if (!pdf || !cur) return;
    var seq = ++renderSeq;
    var page = await pdf.getPage(cur);
    var base = page.getViewport({ scale: 1 });
    baseW = base.width; baseH = base.height;
    var ds = displayScale();
    var dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    var rs = Math.min(4, ds * dpr);
    var vp = page.getViewport({ scale: rs });
    if (vp.width * vp.height > MAX_RENDER_PX) {
      rs *= Math.sqrt(MAX_RENDER_PX / (vp.width * vp.height));
      vp = page.getViewport({ scale: rs });
    }
    var canvas = $('dr-canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // PDF 透明底先铺白（与 pdfcore.renderPage 一致）
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    if (seq !== renderSeq) return;   // 过期帧：期间已有新的翻页/缩放请求
    canvas.style.width = Math.round(baseW * ds) + 'px';
    canvas.hidden = false;
    $('dr-empty').hidden = true;
    syncUi();
  }

  function scheduleRender() {
    if (!pdf) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { render(); }, 80);
  }

  /* ---------- 页面导航 ---------- */
  async function gotoPage(n) {
    if (!pdf) return;
    n = Math.round(+n || 0);
    if (n < 1) n = 1;
    if (n > numPages) n = numPages;
    if (n === cur) { syncUi(); return; }
    cur = n;
    setStatus('');
    await render();
  }

  function stepZoom(dir) {
    if (!pdf) return;
    var now = effectivePct();
    var target = null;
    var i;
    if (dir > 0) {
      for (i = 0; i < ZOOMS.length; i++) {
        if (ZOOMS[i] > now + 1) { target = ZOOMS[i]; break; }
      }
      if (target === null) target = ZOOMS[ZOOMS.length - 1];
    } else {
      for (i = ZOOMS.length - 1; i >= 0; i--) {
        if (ZOOMS[i] < now - 1) { target = ZOOMS[i]; break; }
      }
      if (target === null) target = ZOOMS[0];
    }
    mode = 'free';
    zoom = target;
    $('dr-fit').value = 'free';
    render();
  }

  /* ---------- 打开文件 ---------- */
  async function loadFile(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) { toast('请选择 PDF 文件', true); return; }
    setStatus('正在打开：' + file.name);
    try {
      var next = await App.pdfcore.loadPdf(file);
      if (!next || !next.numPages) throw new Error('文档页数为 0');
      if (pdf) { try { pdf.cleanup(); } catch (e) { /* 旧句柄释放失败不影响新文档 */ } }
      pdf = next;
      numPages = pdf.numPages;
      cur = 0;
      $('dr-file-name').textContent = file.name + '（' + numPages + ' 页）';
      await gotoPage(1);
      setStatus('');
    } catch (e) {
      setStatus('打开失败：' + ((e && e.message) || e));
      toast('无法解析该 PDF 文件', true);
    }
  }

  function enter() {
    setStatus('');
    syncUi();
  }

  App.docsReader = {
    enter: enter,
    _test: {
      gotoRef: gotoPage,
      stepZoomRef: stepZoom,
      stateRef: function () { return { cur: cur, numPages: numPages, mode: mode, zoom: zoom }; },
      setDocRef: function (doc) { pdf = doc; if (doc) { numPages = doc.numPages; cur = 1; } },
      clearDocRef: function () {
        if (pdf) { try { pdf.cleanup(); } catch (e) { /* 忽略 */ } }
        pdf = null; numPages = 0; cur = 0;
      }
    }
  };

  App.docsReader.init = function () {
    $('dr-pick').addEventListener('click', function () { $('dr-file').value = ''; $('dr-file').click(); });
    $('dr-file').addEventListener('change', function () {
      loadFile((this.files || [])[0]);
    });
    $('dr-prev').addEventListener('click', function () { gotoPage(cur - 1); });
    $('dr-next').addEventListener('click', function () { gotoPage(cur + 1); });
    $('dr-go').addEventListener('click', function () {
      gotoPage($('dr-jump').value);
    });
    $('dr-jump').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); gotoPage(this.value); }
    });
    $('dr-fit').addEventListener('change', function () {
      mode = this.value === 'page' ? 'page' : this.value === 'free' ? 'free' : 'width';
      render();
    });
    $('dr-zoom-in').addEventListener('click', function () { stepZoom(1); });
    $('dr-zoom-out').addEventListener('click', function () { stepZoom(-1); });
    /* Ctrl+滚轮缩放（passive:false 才能 preventDefault 阻止浏览器整页缩放） */
    $('dr-view').addEventListener('wheel', function (e) {
      if (!e.ctrlKey || !pdf) return;
      e.preventDefault();
      stepZoom(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    /* 键盘翻页：仅阅读面板可见且焦点不在输入控件时生效 */
    document.addEventListener('keydown', function (e) {
      if (!pdf || $('docs-reader').hidden) return;
      var tag = (e.target && e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); gotoPage(cur - 1); }
      else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault(); gotoPage(cur + 1);
      }
    });
    /* 窗口缩放时适应宽度/适应页面需重算 */
    window.addEventListener('resize', scheduleRender);
    syncUi();
  };
})(window.App);
