/* ============================================================
 * print.js — 直接打印（Electron IPC）：单张成品打印 + 排版整版打印
 * 多页合并为一个打印任务一次发送（避免驱动逐任务弹确认框）。
 * 浏览器模式下 window.zunhongPrint 不存在，相关面板自动隐藏并提示。
 * ============================================================ */
'use strict';

(function (App) {

  var $ = App.ui.$;
  var toast = App.ui.toast;

  var printApi = window.zunhongPrint || null;
  var refreshExportPrinters = null;  // 照片导出模块打印机列表刷新器

  /* 填充打印机下拉，返回可用台数；不可用（浏览器模式）时返回 -1 */
  async function fillPrinterSelect(sel, statusEl, btn, propsBtn) {
    var printers = await printApi.listPrinters();
    sel.innerHTML = '';
    printers.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.name;
      // 默认打印机标记用文字「（默认）」而非星形符号：<option> 内只能放文本，
      // 且与系统工具打印机列表（js/system.js）的标记方式保持一致
      opt.textContent = p.displayName + (p.isDefault ? '（默认）' : '');
      if (p.isDefault) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.disabled = printers.length === 0;
    if (statusEl) statusEl.textContent = printers.length ? '' : '未检测到打印机，请检查系统打印设备';
    if (btn) btn.disabled = printers.length === 0;
    if (propsBtn) propsBtn.disabled = printers.length === 0;
    return printers.length;
  }

  /* prefix: 'export'；getJobs 返回 dataURL 数组（每页一张图） */
  function setupPanel(prefix, getJobs) {
    var panel = $(prefix + '-panel');
    var unsup = $(prefix + '-unsupported');
    if (!printApi || !panel) {
      if (panel) panel.hidden = true;
      if (unsup) unsup.hidden = false;
      refreshExportPrinters = null;
      return null;
    }
    var sel = $(prefix + '-printer');

    async function refresh() {
      try {
        await fillPrinterSelect(sel, $(prefix + '-status'));
      } catch (e) {
        $(prefix + '-status').textContent = '读取打印机失败：' + e.message;
      }
    }
    refresh();
    refreshExportPrinters = refresh;

    $(prefix + '-copies').addEventListener('change', function () {
      this.value = clampCopies(this.value);
    });

    $(prefix + '-btn').addEventListener('click', async function () {
      var jobs;
      try { jobs = getJobs(); } catch (e) { jobs = []; }
      if (!jobs || !jobs.length) { toast('没有可打印的内容', true); return; }
      var btn = this;
      btn.disabled = true;
      var status = $(prefix + '-status');
      status.textContent = '正在发送打印任务…';
      var fail = null;
      try {
        /* 多张一次发送：单任务合并所有页，避免驱动逐任务弹确认框 */
        var res = await printApi.printImage({
          dataUrls: jobs,
          printerName: sel.value || undefined,
          copies: +($(prefix + '-copies').value) || 1
        });
        if (!res.ok) fail = res.error;
      } catch (e) {
        fail = e.message;
      }
      btn.disabled = false;
      if (fail) {
        status.textContent = '打印失败：' + fail;
        toast('打印失败：' + fail, true);
      } else {
        App.ui.statusText(status, '已发送打印任务（' + jobs.length + ' 页）', 'check');
        toast('已发送到打印机', false, 'check');
      }
    });

    return refresh;
  }

  /* 份数输入钳制到 1–99 */
  function clampCopies(raw) {
    var v = Math.floor(+raw);
    if (!v || v < 1) v = 1;
    if (v > 99) v = 99;
    return v;
  }

  /* 物理纸张（mm）；4x6 走 Electron 自定义尺寸（微米） */
  var PRINT_PAPERS = {
    'A4':     { w: 210,   h: 297,   electron: 'A4' },
    'B5':     { w: 182,   h: 257,   electron: { width: 182000, height: 257000 } },  /* 微米自定义尺寸 */
    'A5':     { w: 148,   h: 210,   electron: 'A5' },
    'A3':     { w: 297,   h: 420,   electron: 'A3' },
    'Letter': { w: 215.9, h: 279.4, electron: 'Letter' },
    '4x6':    { w: 101.6, h: 152.4, electron: { width: 101600, height: 152400 } }
  };

  /* 纸张模拟预览：白纸 + 按边距 contain 适配当前排版页 */
  function drawPreview() {
    var canvas = $('print-preview-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var sheetPages = App.sheet.getPages();
    if (!sheetPages) {
      App.sheet.render();
      sheetPages = App.sheet.getPages();
    }
    if (!sheetPages) {
      canvas.width = 600; canvas.height = 400;
      ctx.fillStyle = '#1a1d24'; ctx.fillRect(0, 0, 600, 400);
      return;
    }
    var pk = PRINT_PAPERS[$('print-paper').value] || PRINT_PAPERS.A4;
    var landscape = $('print-landscape').value === '1';
    var pw = landscape ? pk.h : pk.w;
    var ph = landscape ? pk.w : pk.h;
    var marginMm = $('print-margin').value === 'printableArea' ? 5 : 0;

    var k = Math.min(700 / pw, 760 / ph);
    canvas.width = Math.round(pw * k);
    canvas.height = Math.round(ph * k);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    var idx = App.sheet.getPageIndex();
    var page = sheetPages.pages[idx] ? sheetPages.pages[idx].canvas : sheetPages.pages[0].canvas;
    var m = marginMm * k;
    var fit = Math.min((canvas.width - 2 * m) / page.width, (canvas.height - 2 * m) / page.height);
    var dw = page.width * fit, dh = page.height * fit;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(page, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);

    if (m > 0) { // 可打印区域示意线
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(m, m, canvas.width - 2 * m, canvas.height - 2 * m);
      ctx.setLineDash([]);
    }
  }

  /* 排版打印面板：刷新打印机列表（桌面版） */
  async function refreshSheetList() {
    var sel = $('print-sheet-printer');
    var unsup = $('print-sheet-unsupported');
    var status = $('print-sheet-status');
    var btn = $('print-sheet-btn');
    var propsBtn = $('print-sheet-props');
    if (!printApi) {
      if (unsup) unsup.hidden = false;
      if (btn) btn.disabled = true;
      if (propsBtn) propsBtn.disabled = true;
      return;
    }
    if (unsup) unsup.hidden = true;
    try {
      await fillPrinterSelect(sel, status, btn, propsBtn);
    } catch (e) {
      status.textContent = '读取打印机失败：' + e.message;
    }
  }

  /* 打开所选打印机的系统属性对话框（桌面版） */
  async function openPrinterProps() {
    var status = $('print-sheet-status');
    if (!printApi || !printApi.showPrinterProperties) {
      toast('浏览器模式不支持打印机属性，请使用桌面版', true);
      return;
    }
    var name = $('print-sheet-printer').value;
    if (!name) { toast('请先选择打印机', true); return; }
    if (status) status.textContent = '正在打开打印机属性…';
    try {
      var res = await printApi.showPrinterProperties(name);
      if (status) status.textContent = res && res.ok ? '' : (res.error || '无法打开打印机属性');
      if (!res || !res.ok) toast(res.error || '无法打开打印机属性', true);
    } catch (e) {
      if (status) status.textContent = '打开打印机属性失败：' + e.message;
    }
  }

  /* 执行打印：全部页合并为一个任务发送，携带纸张/方向/边距/份数 */
  async function printSheets() {
    var sheetPages = App.sheet.getPages();
    if (!sheetPages) {
      App.sheet.render();
      sheetPages = App.sheet.getPages();
    }
    if (!sheetPages) { toast('没有可打印的排版，请先导入照片', true); return; }
    if (!printApi) { toast('浏览器模式不支持直接打印，请使用桌面版', true); return; }
    var btn = $('print-sheet-btn');
    var status = $('print-sheet-status');
    var pk = PRINT_PAPERS[$('print-paper').value] || PRINT_PAPERS.A4;
    var params = {
      printerName: $('print-sheet-printer').value || undefined,
      copies: +$('print-sheet-copies').value || 1,
      pageSize: pk.electron,
      landscape: $('print-landscape').value === '1',
      marginType: $('print-margin').value === 'printableArea' ? 'printableArea' : 'none'
    };
    btn.disabled = true;
    status.textContent = '正在发送打印任务…';
    var fail = null;
    try {
      /* 所有排版页合并为一个打印任务一次发送：
         逐页各发任务会触发打印机驱动弹出多个确认框 */
      var res = await printApi.printImage(Object.assign({
        dataUrls: sheetPages.pages.map(function (p) { return p.canvas.toDataURL('image/png'); })
      }, params));
      if (!res.ok) fail = res.error;
    } catch (e) {
      fail = e.message;
    }
    btn.disabled = false;
    if (fail) {
      status.textContent = '打印失败：' + fail;
      toast('打印失败：' + fail, true);
    } else {
      App.ui.statusText(status, '已发送打印任务（' + sheetPages.pages.length + ' 页 × ' + params.copies + ' 份）', 'check');
      toast('已发送到打印机', false, 'check');
    }
  }

  function init() {
    $('print-sheet-refresh').addEventListener('click', refreshSheetList);
    $('print-sheet-props').addEventListener('click', openPrinterProps);
    $('print-sheet-copies').addEventListener('change', function () {
      this.value = clampCopies(this.value);
    });
    ['print-paper', 'print-landscape', 'print-margin'].forEach(function (id) {
      $(id).addEventListener('change', drawPreview);
    });
    $('print-sheet-btn').addEventListener('click', printSheets);
  }

  App.print = {
    init: init,
    setupPanel: setupPanel,
    drawPreview: drawPreview,
    refreshSheetList: refreshSheetList,
    openPrinterProps: openPrinterProps,
    printSheets: printSheets,
    PAPERS: PRINT_PAPERS,      /* 批量打印复用同一张纸张表 */
    fillPrinterSelect: fillPrinterSelect,
    /* 照片导出步骤进入时刷新列表；浏览器模式下未注册则静默跳过 */
    refreshExportList: function () { if (refreshExportPrinters) refreshExportPrinters(); },
    isSupported: function () { return !!printApi; },
    _test: { clampCopiesRef: clampCopies }
  };
})(window.App);
