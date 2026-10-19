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

  function toast(msg, isErr) { App.ui.toast(msg, isErr); }
  function setStatus(msg) { $('dp-status').textContent = msg || ''; }
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
        btns.appendChild(mkBtn('↑', function () { move(i, -1); }));
        btns.appendChild(mkBtn('↓', function () { move(i, 1); }));
      }
      btns.appendChild(mkBtn('移除', function () { items.splice(i, 1); renderList(); }));
      box.appendChild(row);
    });
  }

  function mkBtn(text, fn) {
    var b = document.createElement('button');
    b.className = 'ghost';
    b.textContent = text;
    b.addEventListener('click', fn);
    return b;
  }

  function move(i, d) {
    var j = i + d;
    if (j < 0 || j >= items.length) return;
    var t = items[i]; items[i] = items[j]; items[j] = t;
    renderList();
  }

  /* ---------- 渲染整本 → JPEG 页数组 ---------- */
  async function pdfToPages(file, scale, quality, onProgress) {
    var pdf = await core.loadPdf(file);
    var pages = [];
    for (var p = 1; p <= pdf.numPages; p++) {
      if (onProgress) onProgress(p, pdf.numPages);
      var canvas = await core.renderPage(pdf, p, scale);
      var blob = await core.encodeCanvas(canvas, 'image/jpeg', quality);
      pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height });
    }
    return pages;
  }

  async function runMerge(out) {
    var pages = [];
    for (var i = 0; i < items.length; i++) {
      await pdfToPages(items[i].file, 1.5, 0.85, function (p, total) {
        setStatus('合并 ' + (i + 1) + '/' + items.length + '：' + items[i].file.name + ' 第 ' + p + '/' + total + ' 页');
      }).then(function (arr) { pages = pages.concat(arr); });
    }
    await core.writeBytes(out, '合并.pdf', App.batchFormat.buildPdf(pages));
    addResult('合并.pdf', true, '，' + pages.length + ' 页');
    return { okN: 1 };
  }

  async function runSplit(out) {
    var it = items[0];
    var pdf = await core.loadPdf(it.file);
    var idx = core.parsePageRanges($('dp-split-range').value, pdf.numPages);
    if (!idx.length) { toast('页码范围无效（示例：1-3,5,8-' + pdf.numPages + '）', true); return { okN: 0 }; }
    var pages = [];
    for (var k = 0; k < idx.length; k++) {
      setStatus('提取第 ' + idx[k] + ' / ' + pdf.numPages + ' 页');
      var canvas = await core.renderPage(pdf, idx[k], 2);
      var blob = await core.encodeCanvas(canvas, 'image/jpeg', 0.9);
      pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height });
    }
    var name = it.file.name.replace(/\.pdf$/i, '') + '-提取.pdf';
    await core.writeBytes(out, name, App.batchFormat.buildPdf(pages));
    addResult(name, true, '，' + pages.length + ' 页');
    return { okN: 1 };
  }

  async function runShrink(out) {
    var quality = +$('dp-shrink-quality').value;   // 0.8 | 0.65 | 0.5
    var scale = +$('dp-shrink-scale').value;       // 1.5 | 1.2 | 1
    var okN = 0, before = 0, after = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      before += it.file.size;
      setStatus('压缩 ' + (i + 1) + '/' + items.length + '：' + it.file.name);
      try {
        var pages = await pdfToPages(it.file, scale, quality, function (p, total) {
          setStatus('压缩 ' + (i + 1) + '/' + items.length + '：' + it.file.name + ' 第 ' + p + '/' + total + ' 页');
        });
        var bytes = App.batchFormat.buildPdf(pages);
        after += bytes.length;
        var name = it.file.name.replace(/\.pdf$/i, '') + '-压缩.pdf';
        await core.writeBytes(out, name, bytes);
        okN++;
        addResult(name, true, '（' + fmtKB(it.file.size) + ' → ' + fmtKB(bytes.length) + '）');
      } catch (e) {
        addResult(it.file.name, false);
        console.error('[zunhong] PDF 压缩失败:', it.file.name, e);
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
    if (mode === 'split' && items.length > 1) { toast('拆分提取一次只处理一个文件'); return; }
    if (!dirHandle) { toast('请先选择输出文件夹'); return; }
    running = true;
    $('dp-run').disabled = true;
    $('dp-results').innerHTML = '';
    var out = null;
    try { out = await core.ensureSubDir(dirHandle, SUB_DIR); }
    catch (e) {
      $('dp-run').disabled = false; running = false;
      return toast('无法创建输出文件夹：' + ((e && e.message) || e), true);
    }
    try {
      var res = mode === 'merge' ? await runMerge(out)
        : mode === 'split' ? await runSplit(out)
          : await runShrink(out);
      if (!res.noSummary) setStatus('完成：成功 ' + res.okN + ' 项，已输出到「' + dirHandle.name + '/' + SUB_DIR + '」，原文件未改动');
    } finally {
      $('dp-run').disabled = false;
      running = false;
    }
  }

  function onFilesPicked() {
    var input = $('dp-file');
    var files = Array.prototype.slice.call(input.files || []).filter(function (f) { return /\.pdf$/i.test(f.name); });
    if (!files.length) { toast('请选择 PDF 文件'); return; }
    items = mode === 'split' ? [{ file: files[0] }] : items.concat(files.map(function (f) { return { file: f }; }));
    renderList();
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
    _test: { moveRef: move, listRef: function () { return items; } }
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
    setMode('merge');
  };
})(window.App);
