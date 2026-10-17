/* ============================================================
 * sheet.js — 排版流程：选择模板 → 批量导入 → 预览导出 → 打印
 * 相纸与排版算法在 composer.js，打印参数与执行在 print.js。
 * ============================================================ */
'use strict';

(function (App) {

  var $ = App.ui.$;
  var toast = App.ui.toast;
  var download = App.ui.download;
  var State = App.State;

  var sheetFiles = [];       // 批量导入的照片 [{canvas, name}]
  var sheetPages = null;     // 最近一次排版结果 { pages, ... }
  var sheetPageIdx = 0;

  /* 排版模块分步：tpl → import → preview → print */
  var SHEET_STEPS = ['tpl', 'import', 'preview', 'print'];

  function showStep(name) {
    SHEET_STEPS.forEach(function (s, idx) {
      var panel = $('sheetstep-' + s);
      if (panel) panel.classList.toggle('active', s === name);
      var chip = document.querySelector('.step[data-sstep="' + s + '"]');
      if (chip) {
        chip.classList.toggle('active', s === name);
        chip.classList.toggle('done', idx < SHEET_STEPS.indexOf(name));
      }
    });
    if (name === 'preview') renderLaySheet();
    if (name === 'print') { App.print.drawPreview(); App.print.refreshSheetList(); refreshPagers(); }
  }

  /* 源图 cover 绘制到所选规格尺寸 */
  function coverToSpec(src, sp) {
    var cell = document.createElement('canvas');
    cell.width = sp.pxW; cell.height = sp.pxH;
    var ctx = cell.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, cell.width, cell.height);
    var k = Math.max(cell.width / src.width, cell.height / src.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (cell.width - src.width * k) / 2, (cell.height - src.height * k) / 2, src.width * k, src.height * k);
    return cell;
  }

  /* 组装逐格照片列表：每张导入照片 × 所选份数，统一尺寸 */
  function collectCells() {
    var tip = $('sheet-empty-tip');
    var sp = window.SpecUtil.byId($('sheet-spec').value);
    if (!sheetFiles.length) {
      tip.hidden = false;
      tip.textContent = '请先批量导入照片（可多选），或点击「使用照片模块的成品」';
      return null;
    }
    tip.hidden = true;
    // 份数钳制：非法输入（NaN/0/负数/超大）按 1 份处理，避免空 cells 误报「无法排入」
    var copies = Math.round(+$('sheet-count').value);
    if (!(copies >= 1 && copies <= 99)) copies = 1;
    var cells = [];
    sheetFiles.forEach(function (f) {
      var cell = coverToSpec(f.canvas, sp);
      for (var i = 0; i < copies; i++) cells.push(cell);
    });
    return { cells: cells, sp: sp };
  }

  /* ---------- 页码按钮列表（排版预览 / 打印预览共用） ---------- */

  /* 计算要展示的页码序列：始终显示首页、末页、当前页±1，
     断档处（间隔 > 1）以省略号代替，避免页码过多时按钮溢出换行错乱 */
  function pageItems(total, cur) {
    var want = {};
    [1, total, cur - 1, cur, cur + 1].forEach(function (p) {
      if (p >= 1 && p <= total) want[p] = true;
    });
    var nums = Object.keys(want).map(Number).sort(function (a, b) { return a - b; });
    var items = [];
    nums.forEach(function (p, i) {
      if (i > 0 && p - nums[i - 1] > 1) items.push('…');
      items.push(p);
    });
    return items;
  }

  /* 渲染一个页码按钮容器；total<=1 时隐藏。cur 为 0 基页索引 */
  function renderPager(nav, total, cur, onGo) {
    nav.innerHTML = '';
    if (!total || total <= 1) { nav.hidden = true; return; }
    nav.hidden = false;
    var curPage = cur + 1;  // 1 基页码
    pageItems(total, curPage).forEach(function (p) {
      if (p === '…') {
        var gap = document.createElement('span');
        gap.className = 'pager-gap';
        gap.textContent = '…';
        nav.appendChild(gap);
        return;
      }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pager-btn' + (p === curPage ? ' active' : '');
      btn.textContent = p;
      btn.setAttribute('aria-label', '第 ' + p + ' 页，共 ' + total + ' 页');
      if (p === curPage) btn.setAttribute('aria-current', 'page');
      btn.addEventListener('click', function () { onGo(p - 1); });
      nav.appendChild(btn);
    });
  }

  /* 切页：同步排版预览、打印预览与两处页码按钮的高亮状态 */
  function goToPage(i) {
    if (!sheetPages) return;
    var n = sheetPages.pages.length;
    sheetPageIdx = Math.max(0, Math.min(i, n - 1));
    drawPage();
    App.print.drawPreview();  // 打印预览画布同步（非打印步骤时静默刷新）
    refreshPagers();
  }

  /* 刷新两处页码按钮列表（单页时自动隐藏） */
  function refreshPagers() {
    var total = sheetPages ? sheetPages.pages.length : 0;
    renderPager($('sheet-pager'), total, sheetPageIdx, goToPage);
    renderPager($('print-pager'), total, sheetPageIdx, goToPage);
  }

  function renderLaySheet() {
    var canvas = $('laysheet-preview');
    var info = $('sheet-info');

    var input = collectCells();
    if (!input) {
      sheetPages = null;
      canvas.width = 600; canvas.height = 400;
      var blank = canvas.getContext('2d');
      blank.fillStyle = '#1a1d24';
      blank.fillRect(0, 0, 600, 400);
      info.textContent = '';
      refreshPagers();
      return;
    }

    /* 间距固定 2.4mm（引擎默认 GAP_X/GAP_Y），不再提供滑块调整 */
    var result = window.Composer.layoutBatch(input.cells, $('sheet-paper').value, {
      cutLines: $('sheet-cutlines').checked
    });
    if (!result) { info.textContent = '该尺寸无法排入所选相纸（照片可能大于相纸可打印区，请缩小照片或换更大相纸）'; sheetPages = null; refreshPagers(); return; }
    sheetPages = result;
    if (sheetPageIdx >= result.pages.length) sheetPageIdx = 0;

    drawPage();
    refreshPagers();
    var copies = +$('sheet-count').value;
    info.textContent = result.paper.name + ' · ' + result.width + '×' + result.height + 'px · 300DPI · 共 '
      + sheetFiles.length + ' 张照片 × ' + copies + ' 份 = ' + result.total + ' 格 · 版面 ' + result.cols + ' 列×'
      + Math.min(result.pages[0].rowsUsed, Math.round(result.capacity / result.cols)) + ' 行'
      + (result.pages.length > 1 ? ' · 分 ' + result.pages.length + ' 页' : '');
  }

  function drawPage() {
    if (!sheetPages) return;
    var canvas = $('laysheet-preview');
    var page = sheetPages.pages[sheetPageIdx];
    var k2 = Math.min(1, 900 / sheetPages.width);
    canvas.width = Math.round(sheetPages.width * k2);
    canvas.height = Math.round(sheetPages.height * k2);
    canvas.getContext('2d').drawImage(page.canvas, 0, 0, canvas.width, canvas.height);
  }

  async function downloadSheet() {
    if (!sheetPages) {
      // 尚未预览过则现算
      renderLaySheet();
      if (!sheetPages) { toast('请先批量导入照片', true); return; }
    }
    var name = sheetFiles.length ? (sheetFiles[0].name || '照片') : (State.sourceName || '照片');
    var pages = sheetPages.pages;
    var multi = pages.length > 1;
    try {
      // 每页编码为 300DPI PNG；多页时打包为单个 ZIP 只弹一次保存对话框，
      // 避免逐页下载在 Electron 里连续弹出多个保存窗口
      var zipFiles = [];
      for (var i = 0; i < pages.length; i++) {
        var blob = await new Promise(function (r, rej) {
          pages[i].canvas.toBlob(function (b) { b ? r(b) : rej(new Error('画布编码失败（可能超出浏览器画布尺寸上限）')); }, 'image/png');
        });
        var buf = window.DpiUtil.setPngDpi(await blob.arrayBuffer(), 300);
        var fname = name + '_排版_' + sheetPages.paper.name
          + (multi ? '_第' + (i + 1) + '页共' + pages.length + '页' : '_' + pages[i].count + '张')
          + '.png';
        if (multi) {
          zipFiles.push({ name: fname, data: new Uint8Array(buf) });
        } else {
          download(new Blob([buf], { type: 'image/png' }), fname);
        }
      }
      if (multi) {
        var zip = await window.ZipUtil.store(zipFiles);
        download(zip, name + '_排版_' + sheetPages.paper.name + '_' + pages.length + '页.zip');
      }
      toast('排版图已保存（' + sheetPages.total + ' 张 · ' + pages.length + ' 版 · 300DPI'
        + (multi ? ' · ZIP 压缩包' : '') + '）');
    } catch (e) {
      console.error(e);
      toast('导出失败：' + e.message, true);
    }
  }

  var hideTimer = null;      // 进度条收起定时器（连续导入时防误收）

  /* 批量导入：进度条实时显示「正在导入 x / N」，完成后只报总数，
     不再罗列文件名（几十张时把状态区撑满整屏） */
  function loadFiles(files) {
    var total = files.length;
    var done = 0;
    var failed = 0;
    var failedName = '';
    var loaded = [];
    var bar = $('sheet-import-bar');
    var text = $('sheet-import-text');
    var box = $('sheet-import-progress');
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    box.hidden = false;
    bar.style.width = '0%';
    text.textContent = '正在导入 0 / ' + total + '…';

    var finish = function () {
      if (!loaded.length) {
        // 全部失败：明确报错，不留静默
        box.hidden = true;
        toast('导入失败：' + failed + ' 个文件无法识别（' + (failedName || '未知文件') + '）', true);
        return;
      }
      sheetFiles = sheetFiles.concat(loaded); // 累加导入
      bar.style.width = '100%';
      // 成功数用实际载入数，失败一并提示（不虚报）
      text.textContent = '已导入 ' + loaded.length + ' 张' + (failed ? ' · 失败 ' + failed + ' 张' : '') + (failed ? ' ⚠' : ' ✓');
      if (failed) toast('导入完成：成功 ' + loaded.length + ' 张，失败 ' + failed + ' 张（' + failedName + '）', true);
      $('sheet-file-name').textContent = '已导入 ' + sheetFiles.length + ' 张';
      renderLaySheet();
      hideTimer = setTimeout(function () { box.hidden = true; hideTimer = null; }, 1200); // 满格停留后收起
    };

    // 单个文件结束时统一计数（成功 / 失败都推进进度条）
    var settle = function (ok, name) {
      done++;
      if (!ok) { failed++; if (!failedName) failedName = name || '未知文件'; }
      bar.style.width = Math.round(done / total * 100) + '%';
      text.textContent = '正在导入 ' + done + ' / ' + total + '…';
      if (done === total) finish();
    };

    files.forEach(function (file) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          loaded.push({ canvas: c, name: (file.name || '').replace(/\.[^.]+$/, '') || '照片' });
          settle(true);
        };
        img.onerror = function () { settle(false, file.name); };
        img.src = reader.result;
      };
      reader.onerror = function () { settle(false, file.name); };
      reader.readAsDataURL(file);
    });
  }

  function init() {
    // 单张尺寸下拉
    var sel = $('sheet-spec');
    window.SPECS.forEach(function (sp) {
      var opt = document.createElement('option');
      opt.value = sp.id;
      opt.textContent = sp.name + ' · ' + sp.desc + ' · ' + sp.pxW + '×' + sp.pxH;
      if (sp.id === State.spec.id) opt.selected = true;
      sel.appendChild(opt);
    });

    $('btn-sheet-file').addEventListener('click', function () { $('sheet-file-input').click(); });
    $('sheet-file-input').addEventListener('change', function () {
      var files = Array.prototype.slice.call(this.files || []).filter(function (f) { return /^image\//.test(f.type); });
      this.value = '';
      if (!files.length) return;
      loadFiles(files);
    });

    // 使用照片模块成品（追加为一张导入照片）
    $('btn-use-photo-result').addEventListener('click', function () {
      if (!State.workCanvas || !State.transform) { toast('请先在「照片」模块完成一张成品', true); return; }
      var c = App.photo.makeSingleCanvas();
      sheetFiles.push({ canvas: c, name: State.sourceName || '照片成品' });
      $('sheet-file-name').textContent = '已导入 ' + sheetFiles.length + ' 张（含照片模块成品 1 张）';
      renderLaySheet();
    });

    $('sheet-spec').addEventListener('change', renderLaySheet);
    $('sheet-count').addEventListener('change', renderLaySheet);
    $('sheet-paper').addEventListener('change', renderLaySheet);
    $('sheet-cutlines').addEventListener('change', renderLaySheet);
    $('btn-download-laysheet').addEventListener('click', downloadSheet);

    // 排版分步导航
    $('btn-sheet-to-import').addEventListener('click', function () { showStep('import'); });
    $('btn-sheet-back-tpl').addEventListener('click', function () { showStep('tpl'); });
    $('btn-sheet-to-preview').addEventListener('click', function () {
      if (!sheetFiles.length) { toast('请先导入照片', true); return; }
      showStep('preview');
    });
    $('btn-sheet-back-import').addEventListener('click', function () { showStep('import'); });
    $('btn-sheet-clear').addEventListener('click', function () {
      if (!sheetFiles.length) { toast('当前没有已导入的照片'); return; }
      sheetFiles = [];
      $('sheet-file-name').textContent = '已清空';
      $('sheet-import-progress').hidden = true;
      renderLaySheet();   // 同步重置预览画布与页码，避免停留在旧排版
      toast('已清空导入的照片');
    });

    // 第 4 步：打印预览（选打印机 → 设参数 → 打印）
    $('btn-sheet-goto-print').addEventListener('click', function () {
      if (!sheetPages) renderLaySheet();
      if (!sheetPages) { toast('请先在第二步导入照片', true); return; }
      showStep('print');
    });
    $('btn-sheet-back-preview').addEventListener('click', function () { showStep('preview'); });
  }

  App.sheet = {
    init: init,
    showStep: showStep,
    render: renderLaySheet,
    getPages: function () { return sheetPages; },
    getPageIndex: function () { return sheetPageIdx; }
  };
})(window.App);
