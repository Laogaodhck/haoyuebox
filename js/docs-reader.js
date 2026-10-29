/* ============================================================
 * docs-reader.js — 文档工具子功能：PDF 阅读器
 * 打开本机 PDF 逐页浏览（纯本地，pdf.js 渲染，复用 pdfcore.loadPdf）：
 *  - 打开：选择文件或拖拽 PDF 到阅读页；
 *  - 翻页：上一页/下一页按钮 + 键盘（←/→/PgUp/PgDn/空格）；
 *  - 缩放：适应宽度 / 适应页面 / 自定义档位（Ctrl+滚轮或 ± 按钮）；
 *  - 跳转：输入页码直达任意页；
 *  - 清空：一键关闭当前 PDF 回到空态；
 *  - 打印：桌面版整本渲染后经 IPC 一次发送，支持单面/双面。
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

  /* 打印（桌面版）：与 print-batch.js 文档打印同一渲染参数（≈180dpi、宽上限 2400px） */
  var printApi = window.haoyuePrint || null;
  var printerN = 0;          // 可用打印机台数（浏览器模式恒 0）
  var printing = false;

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
    $('dr-clear').disabled = !pdf;
    if (printApi) $('dr-print').disabled = !pdf || printerN === 0;
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

  /* ---------- 清空 / 打印 ---------- */

  /* 清空：关闭当前 PDF 回到空态（缩放模式一并复位） */
  function clearDoc() {
    if (!pdf) return;
    try { pdf.cleanup(); } catch (e) { /* 句柄释放失败不阻断界面复位 */ }
    pdf = null;
    numPages = 0;
    cur = 0;
    mode = 'width';
    zoom = 100;
    renderSeq++;                     // 作废可能还在路上的渲染帧
    $('dr-fit').value = 'width';
    var canvas = $('dr-canvas');
    canvas.hidden = true;
    canvas.style.width = '';
    $('dr-empty').hidden = false;
    $('dr-file-name').textContent = '未打开文件';
    $('dr-jump').value = '';
    setStatus('');
    syncUi();
    toast('已清空当前 PDF', false, 'check');
  }

  /* 桌面版：刷新打印机列表（进入子页时调用，与文档打印面板一致） */
  async function refreshPrinters() {
    if (!printApi) return;
    try {
      printerN = await App.print.fillPrinterSelect($('dr-printer'), $('dr-print-status'), $('dr-print'));
    } catch (e) {
      printerN = 0;
      $('dr-print-status').textContent = '读取打印机失败：' + ((e && e.message) || e);
    }
    syncUi();
  }

  /* 整本渲染 → dataURLs（参数对齐 print-batch.js 文档打印：2.5x ≈180dpi、宽上限 2400px） */
  var PRINT_SCALE = 2.5;
  var PRINT_MAX_W = 2400;

  async function renderAllForPrint() {
    var urls = [];
    for (var i = 1; i <= numPages; i++) {
      $('dr-print-status').textContent = '正在渲染 ' + i + ' / ' + numPages + ' 页…';
      var page = await pdf.getPage(i);
      var v1 = page.getViewport({ scale: 1 });
      var vp = page.getViewport({ scale: Math.min(PRINT_SCALE, PRINT_MAX_W / v1.width) });
      var c = document.createElement('canvas');
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      urls.push(c.toDataURL('image/jpeg', 0.92));
    }
    return urls;
  }

  async function runPrint() {
    if (printing) return;
    if (!pdf) { toast('请先打开 PDF 文件', true); return; }
    if (!printApi) { toast('浏览器模式不支持直接打印，请使用桌面版', true); return; }
    printing = true;
    $('dr-print').disabled = true;
    var status = $('dr-print-status');
    var fail = null;
    try {
      var urls = await renderAllForPrint();
      status.textContent = '正在发送打印任务…';
      var dup = $('dr-duplex').value;
      var res = await printApi.printImage({
        dataUrls: urls,
        printerName: $('dr-printer').value || undefined,
        /* 主进程仅识别 longEdge/shortEdge，单面传 simplex 走默认 */
        duplex: dup === 'longEdge' || dup === 'shortEdge' ? dup : 'simplex'
      });
      if (!res || !res.ok) fail = (res && res.error) || '未知错误';
    } catch (e) {
      fail = (e && e.message) || String(e);
    }
    printing = false;
    syncUi();
    if (fail) {
      setStatus('打印失败：' + fail);
      toast('打印失败：' + fail, true);
    } else {
      App.ui.statusText(status, '已发送打印任务（' + numPages + ' 页，' +
        ($('dr-duplex').value === 'simplex' ? '单面' : '双面') + '）', 'check');
      toast('已发送到打印机', false, 'check');
    }
  }

  /* ---------- 拖拽打开（拖到阅读子页任意位置均可） ---------- */
  function bindDragDrop() {
    var sec = $('docs-reader');
    var view = $('dr-view');
    var depth = 0;   // dragenter/leave 计数：穿过子元素时不闪烁
    sec.addEventListener('dragenter', function (e) {
      e.preventDefault();
      depth++;
      view.classList.add('dr-over');
    });
    sec.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    sec.addEventListener('dragleave', function () {
      depth = Math.max(0, depth - 1);
      if (!depth) view.classList.remove('dr-over');
    });
    sec.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      view.classList.remove('dr-over');
      var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
      var pdfs = files.filter(function (f) { return /\.pdf$/i.test(f.name); });
      if (!pdfs.length) { toast('请拖入 PDF 文件', true); return; }
      loadFile(pdfs[0]);
    });
  }

  function enter() {
    setStatus('');
    syncUi();
    if (printApi) refreshPrinters();  // 打印机可能插拔，进入时重查
  }

  App.docsReader = {
    enter: enter,
    _test: {
      gotoRef: gotoPage,
      stepZoomRef: stepZoom,
      clearRef: clearDoc,
      stateRef: function () { return { cur: cur, numPages: numPages, mode: mode, zoom: zoom }; },
      setDocRef: function (doc) { pdf = doc; if (doc) { numPages = doc.numPages; cur = 1; } syncUi(); },
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
    $('dr-clear').addEventListener('click', clearDoc);
    $('dr-print').addEventListener('click', runPrint);
    bindDragDrop();
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
    /* 浏览器模式：无打印桥，隐藏打印控件显示提示（与 print.js 面板行为一致） */
    if (!printApi) {
      $('dr-print-box').hidden = true;
      $('dr-print-unsup').hidden = false;
    }
    syncUi();
  };
})(window.App);
