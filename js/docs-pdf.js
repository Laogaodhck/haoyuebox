/* ============================================================
 * docs-pdf.js — 文档工具子功能：PDF 工具
 * 三个能力（纯本地，栅格化路线）：
 *  - 合并：多个 PDF 按列表顺序逐页栅格化 → 重建为单个 PDF；
 *  - 拆分提取：按页码范围（如 1-3,5,8-）提取页面 → 新 PDF；
 *  - 体积压缩：中等分辨率 + 较低 JPEG 质量重编码（扫描件效果最佳），
 *    输出前显示原始/压缩后体积对比。
 * 输出写入所选文件夹的「转换输出」子目录，不动原文件。
 * 说明：处理后的 PDF 页面为图像（文字不可再选中），与加水印同一管线。
 * ============================================================ */
(function (App) {
  'use strict';

  var $ = App.ui.$;
  var core = App.pdfcore;
  var SUB_DIR = '转换输出';

  var items = [];        // 合并/压缩：[{file}]；拆分：单文件
  var dirHandle = null;
  var mode = 'merge';    // merge | split | shrink
  var running = false;
  var task = null;       // 本次处理的取消令牌（App.task）

  function toast(msg, isErr) { App.ui.toast(msg, isErr); }
  function setStatus(msg) { $('dp-status').textContent = msg || ''; }

  /* 运行期控件锁：文件/模式/参数/输出目录全部停用，只留取消按钮 */
  var CTRL_IDS = ['dp-pick', 'dp-file', 'dp-clear', 'dp-tab-merge', 'dp-tab-split', 'dp-tab-shrink',
    'dp-split-range', 'dp-shrink-quality', 'dp-shrink-scale', 'dp-dir', 'dp-run'];
  function setRunning(on) {
    running = on;
    CTRL_IDS.forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = on;
    });
    $('dp-cancel').hidden = !on;
    if (!on) renderList(); // 解锁后重建列表按钮（运行期创建的按钮为禁用态）
  }
  function fmtKB(bytes) { return bytes > 1024 * 1024 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB'; }

  function renderList() {
    var box = $('dp-list');
    box.innerHTML = '';
    var n = items.length;
    $('dp-count').textContent = n ? '已选 ' + n + ' 个文件' : '';
    $('dp-empty').hidden = n > 0;
    $('dp-clear').hidden = n === 0;
    items.forEach(function (it, i) {
      var row = document.createElement('div');
      row.className = 'dw-list-row';
      row.innerHTML = '<span>' + (i + 1) + '. ' +
        String(it.file.name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
        '</span><span class="dw-file-btns"></span>';
      var btns = row.querySelector('.dw-file-btns');
      if (mode === 'merge' && n > 1) {
        btns.appendChild(mkBtn('上移', function () { move(i, -1); }, 'up'));
        btns.appendChild(mkBtn('下移', function () { move(i, 1); }, 'down'));
      }
      btns.appendChild(mkBtn('移除', function () {
        if (running) return;
        items.splice(i, 1);
        renderList();
      }));
      box.appendChild(row);
    });
  }

  /* 小按钮：label 为文字；传 iconName 时用内联 SVG 图标（文字作 title/aria-label） */
  function mkBtn(label, fn, iconName) {
    var b = document.createElement('button');
    b.className = 'ghost';
    if (iconName) {
      b.title = label;
      b.setAttribute('aria-label', label);
      b.appendChild(App.ui.icon(iconName));
    } else {
      b.textContent = label;
    }
    b.disabled = running; // 运行期禁止调整列表顺序/移除
    b.addEventListener('click', fn);
    return b;
  }

  function move(i, d) {
    if (running) return;
    var j = i + d;
    if (j < 0 || j >= items.length) return;
    var t = items[i]; items[i] = items[j]; items[j] = t;
    renderList();
  }

  /* ---------- 渲染整本 → JPEG 页数组 ---------- */
  async function pdfToPages(file, scale, quality, onProgress) {
    /* getDocument 每次解析都会拉起 worker：渲染完必须 cleanup，
     * 否则合并/压缩整批文档时句柄与 worker 逐个泄漏（runSplit 早已如此，此处对齐） */
    var pdf = null;
    try {
      pdf = await core.loadPdf(file);
      var pages = [];
      for (var p = 1; p <= pdf.numPages; p++) {
        App.task.checkpoint(task);
        if (onProgress) onProgress(p, pdf.numPages);
        var canvas = await core.renderPage(pdf, p, scale);
        var blob = await core.encodeCanvas(canvas, 'image/jpeg', quality);
        pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height });
      }
      return pages;
    } finally {
      if (pdf) pdf.cleanup();
    }
  }

  async function runMerge(out) {
    var pages = [];
    var okN = 0;
    for (var i = 0; i < items.length; i++) {
      App.task.checkpoint(task);
      var it = items[i];
      setStatus('合并 ' + (i + 1) + '/' + items.length + '：' + it.file.name);
      try {
        // 逐文件 try/catch：单个 PDF 损坏/加密只记该文件失败，不葬送整批
        // （此前无 catch，rejection 直达全局兜底，状态行卡死、结果列表全空）
        var arr = await pdfToPages(it.file, 1.5, 0.85, function (p, total) {
          setStatus('合并 ' + (i + 1) + '/' + items.length + '：' + it.file.name + ' 第 ' + p + '/' + total + ' 页');
        });
        pages = pages.concat(arr);
        okN++;
      } catch (e) {
        if (App.task.isCancelled(e)) throw e;
        addResult(it.file.name, false);
        console.error('[haoyue] PDF 合并失败:', it.file.name, e);
      }
    }
    if (!pages.length) {
      setStatus('失败：所有文件均无法解析，未生成合并 PDF');
      return { okN: 0, noSummary: true };
    }
    var mergeName = await core.uniqueOutName(out, '合并.pdf');
    await core.writeBytes(out, mergeName, App.batchFormat.buildPdf(pages));
    addResult(mergeName, true, '，' + pages.length + ' 页');
    setStatus('完成：成功 ' + okN + '/' + items.length + ' 个文件，合并为 ' + pages.length +
      ' 页，已输出到「' + dirHandle.name + '/' + SUB_DIR + '」');
    return { okN: okN, noSummary: true };
  }

  async function runSplit(out) {
    var it = items[0];
    var pdf = null;
    try {
      pdf = await core.loadPdf(it.file);
      var idx = core.parsePageRanges($('dp-split-range').value, pdf.numPages);
      if (!idx.length) {
        toast('页码范围无效（示例：1-3,5,8-' + pdf.numPages + '）', true);
        setStatus('失败：页码范围无效，未生成 PDF');
        return { okN: 0, noSummary: true };
      }
      var pages = [];
      for (var k = 0; k < idx.length; k++) {
        App.task.checkpoint(task);
        setStatus('提取第 ' + idx[k] + ' / ' + pdf.numPages + ' 页');
        var canvas = await core.renderPage(pdf, idx[k], 2);
        var blob = await core.encodeCanvas(canvas, 'image/jpeg', 0.9);
        pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height });
      }
      var name = await core.uniqueOutName(out, it.file.name.replace(/\.pdf$/i, '') + '-提取.pdf');
      await core.writeBytes(out, name, App.batchFormat.buildPdf(pages));
      addResult(name, true, '，' + pages.length + ' 页');
      return { okN: 1 };
    } catch (e) {
      if (App.task.isCancelled(e)) throw e;
      // 单文件操作：整体失败时明确报出文件名与原因，而非仅靠全局兜底弹通用错误
      addResult(it.file.name, false);
      console.error('[haoyue] PDF 拆分失败:', it.file.name, e);
      setStatus('失败：' + it.file.name + ' 无法解析或提取（' + ((e && e.message) || e) + '）');
      return { okN: 0, noSummary: true };
    } finally {
      if (pdf) pdf.cleanup();
    }
  }

  async function runShrink(out) {
    var quality = +$('dp-shrink-quality').value;   // 0.8 | 0.65 | 0.5
    var scale = +$('dp-shrink-scale').value;       // 1.5 | 1.2 | 1
    var okN = 0, before = 0, after = 0;
    for (var i = 0; i < items.length; i++) {
      App.task.checkpoint(task);
      var it = items[i];
      before += it.file.size;
      setStatus('压缩 ' + (i + 1) + '/' + items.length + '：' + it.file.name);
      try {
        var pages = await pdfToPages(it.file, scale, quality, function (p, total) {
          setStatus('压缩 ' + (i + 1) + '/' + items.length + '：' + it.file.name + ' 第 ' + p + '/' + total + ' 页');
        });
        var bytes = App.batchFormat.buildPdf(pages);
        after += bytes.length;
        var name = await core.uniqueOutName(out, it.file.name.replace(/\.pdf$/i, '') + '-压缩.pdf');
        await core.writeBytes(out, name, bytes);
        okN++;
        addResult(name, true, '（' + fmtKB(it.file.size) + ' → ' + fmtKB(bytes.length) + '）');
      } catch (e) {
        if (App.task.isCancelled(e)) throw e;
        addResult(it.file.name, false);
        console.error('[haoyue] PDF 压缩失败:', it.file.name, e);
      }
    }
    if (before && after) setStatus('完成：成功 ' + okN + ' 个，体积 ' + fmtKB(before) + ' → ' + fmtKB(after) +
      '（' + Math.max(0, Math.round((1 - after / before) * 100)) + '% 缩减），已输出到「' + dirHandle.name + '/' + SUB_DIR + '」');
    return { okN: okN, noSummary: true };
  }

  function addResult(name, ok, extra) {
    var row = document.createElement('div');
    row.className = 'dw-list-row ' + (ok ? 'ok' : 'bad');
    row.innerHTML = '<span>' + String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
      '</span><span class="dw-res">' + (ok ? '完成' + (extra || '') : '失败') + '</span>';
    $('dp-results').appendChild(row);
  }

  /* ================= 主流程 ================= */

  async function run() {
    if (running) return;
    if (!items.length) { toast('请先选择 PDF 文件'); return; }
    // 拆分模式只保留首个文件（见 onFilesPicked），此处无需多文件检查
    if (!dirHandle) { toast('请先选择输出文件夹'); return; }
    task = App.task.create();
    setRunning(true);
    $('dp-results').innerHTML = '';
    var out = null;
    try { out = await core.ensureSubDir(dirHandle, SUB_DIR); }
    catch (e) {
      setRunning(false); task = null;
      return toast('无法创建输出文件夹：' + ((e && e.message) || e), true);
    }
    var cancelled = false;
    try {
      App.task.checkpoint(task);
      var res = mode === 'merge' ? await runMerge(out)
        : mode === 'split' ? await runSplit(out)
          : await runShrink(out);
      if (!res.noSummary) setStatus('完成：成功 ' + res.okN + ' 项，已输出到「' + dirHandle.name + '/' + SUB_DIR + '」，原文件未改动');
    } catch (e) {
      if (!App.task.isCancelled(e)) throw e;
      cancelled = true;
    } finally {
      setRunning(false);
      task = null;
    }
    if (cancelled) {
      setStatus(mode === 'shrink'
        ? '已取消：已输出的文件保留在「' + dirHandle.name + '/' + SUB_DIR + '」'
        : '已取消：未生成输出文件');
    }
  }

  function addFiles(files) {
    if (running) { toast('正在处理中，请先取消或等待完成'); return; }
    files = files.filter(function (f) { return /\.pdf$/i.test(f.name); });
    if (!files.length) { toast('请选择 PDF 文件', true); return; }
    // 拆分模式一次只处理一个文件：只保留首个（合并/压缩模式累加多选）
    items = mode === 'split' ? [{ file: files[0] }] : items.concat(files.map(function (f) { return { file: f }; }));
    renderList();
  }

  function onFilesPicked() {
    addFiles(Array.prototype.slice.call($('dp-file').files || []));
  }

  function setMode(next) {
    mode = next;
    items = [];
    renderList();
    $('dp-results').innerHTML = '';
    ['merge', 'split', 'shrink'].forEach(function (m) {
      $('dp-tab-' + m).classList.toggle('active', mode === m);
      $('dp-' + m).hidden = m !== mode;
    });
    $('dp-run').textContent = mode === 'merge' ? '开始合并' : mode === 'split' ? '开始提取' : '开始压缩';
  }

  function enter() {
    $('dp-results').innerHTML = '';
    setStatus('');
    renderList();
  }

  App.docsPdf = {
    enter: enter,
    _test: {
      moveRef: move,
      listRef: function () { return items; },
      setItemsRef: function (arr) { items = arr || []; },
      setModeRef: function (m) { mode = m; },
      setDirRef: function (d) { dirHandle = d; },
      runMergeRef: runMerge,
      runSplitRef: runSplit,
      runShrinkRef: runShrink
    }
  };

  App.docsPdf.init = function () {
    $('dp-pick').addEventListener('click', function () { $('dp-file').value = ''; $('dp-file').click(); });
    $('dp-file').addEventListener('change', onFilesPicked);
    $('dp-clear').addEventListener('click', function () { items = []; renderList(); });
    $('dp-tab-merge').addEventListener('click', function () { setMode('merge'); });
    $('dp-tab-split').addEventListener('click', function () { setMode('split'); });
    $('dp-tab-shrink').addEventListener('click', function () { setMode('shrink'); });
    $('dp-dir').addEventListener('click', async function () {
      var d = await core.pickOutputDir();
      if (d) { dirHandle = d; $('dp-dir-name').textContent = d.name; }
      else if (typeof window.showDirectoryPicker !== 'function') {
        toast('当前环境不支持选择文件夹，请使用桌面版或 Chrome / Edge 浏览器', true);
      }
    });
    $('dp-run').addEventListener('click', run);
    $('dp-cancel').addEventListener('click', function () {
      if (!task) return;
      task.cancel();
      setStatus('正在取消处理…');
    });
    App.ui.bindFileDrop('docs-pdf', {
      target: 'dp-stage',
      accept: /\.pdf$/i,
      rejectMsg: '请拖入 PDF 文件',
      onFiles: addFiles
    });
    setMode('merge');
  };
})(window.App);
