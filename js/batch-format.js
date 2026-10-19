/* 批量工具子功能：格式转换（JPG / PNG / WebP / PDF）
 * 纯本地实现：通过 File System Access API 读取所选文件夹中的图片，
 * 批量转换后直接写回磁盘（子文件夹「转换输出」或覆盖原文件），不上传任何数据。
 * PDF 由内置纯 JS 生成器输出（DCTDecode 直接嵌入 JPEG 字节，无需任何依赖）。
 */
(function () {
  'use strict';

  var FMTS = {
    jpeg: { ext: 'jpg', mime: 'image/jpeg', fill: true, quality: true, pdf: false },
    png:  { ext: 'png', mime: 'image/png', fill: false, quality: false, pdf: false },
    webp: { ext: 'webp', mime: 'image/webp', fill: false, quality: true, pdf: false },
    pdf:  { ext: 'pdf', mime: 'application/pdf', fill: true, quality: true, pdf: true }
  };
  var IMG_EXTS = { jpg: 1, jpeg: 1, png: 1, webp: 1, bmp: 1, gif: 1 };
  var SUB_DIR = '转换输出';

  var dirHandle = null;  // 当前文件夹句柄
  var items = [];        // [{name, handle, file, w, h, url, outName}]
  var running = false;

  var $ = window.App.ui.$;
  function toast(msg, isErr) { window.App.ui.toast(msg, isErr); }

  /* ================= 纯逻辑（可单测） ================= */

  // 质量百分比钳制到 50–100（非法输入回退下限）
  function clampQuality(pct) {
    pct = Math.round(+pct || 0);
    return Math.min(100, Math.max(50, pct));
  }

  // 生成输出文件名：替换原扩展名为目标格式；与已用名冲突时追加 (2)、(3)…
  function buildOutputName(origName, fmt, used) {
    var base = (origName || '').replace(/\.[^.]+$/, '') || '图片';
    var ext = FMTS[fmt] ? FMTS[fmt].ext : 'png';
    var name = base + '.' + ext;
    var n = 2;
    while (used[name]) {
      name = base + '(' + n + ').' + ext;
      n++;
    }
    used[name] = true;
    return name;
  }

  /* ---------- 纯 JS PDF 生成器 ----------
   * 结构：obj1 Catalog / obj2 Pages / 每页 3 个对象
   *   3+3k Page（MediaBox 为图片像素尺寸，单位 pt）
   *   4+3k Image XObject（DCTDecode 直接嵌入 JPEG 字节）
   *   5+3k Contents（q W 0 0 H 0 0 cm /Im0 Do Q）
   * 最后写 xref 表（10 位偏移）+ trailer + startxref + %%EOF
   */

  // 页面内容流：把图片铺满整页
  function pdfPageContent(w, h) {
    return 'q ' + w + ' 0 0 ' + h + ' 0 0 cm /Im0 Do Q';
  }

  // pages: [{jpeg: Uint8Array, w, h}] → PDF 字节
  function buildPdf(pages) {
    var enc = new TextEncoder();
    var chunks = [];
    var offset = 0;
    var offsets = {};   // 对象号 → 字节偏移
    function push(data) {
      var bytes = typeof data === 'string' ? enc.encode(data) : data;
      chunks.push(bytes);
      offset += bytes.length;
    }
    function pushObj(num, dict, stream) {
      offsets[num] = offset;
      push(num + ' 0 obj\n' + dict);
      if (stream) {
        push('\nstream\n');
        push(stream);
        push('\nendstream');
      }
      push('\nendobj\n');
    }

    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])); // 二进制注释行（标记二进制安全）

    var n = pages.length;
    pushObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    var kids = [];
    for (var k = 0; k < n; k++) kids.push((3 + 3 * k) + ' 0 R');
    pushObj(2, '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >>');

    for (k = 0; k < n; k++) {
      var p = pages[k];
      var num = 3 + 3 * k;
      pushObj(num, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + p.w + ' ' + p.h + ']' +
        ' /Resources << /XObject << /Im0 ' + (num + 1) + ' 0 R >> >> /Contents ' + (num + 2) + ' 0 R >>');
      pushObj(num + 1, '<< /Type /XObject /Subtype /Image /Width ' + p.w + ' /Height ' + p.h +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.jpeg.length + ' >>',
        p.jpeg);
      var content = pdfPageContent(p.w, p.h);
      pushObj(num + 2, '<< /Length ' + content.length + ' >>', content);
    }

    var total = 3 + 3 * n; // 对象号总数（含 0 号空闲项）
    var xrefStart = offset;
    var xref = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (var i = 1; i < total; i++) {
      var o = String(offsets[i] || 0);
      while (o.length < 10) o = '0' + o;
      xref += o + ' 00000 n \n';
    }
    xref += 'trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF';
    push(xref);

    var out = new Uint8Array(offset);
    var pos = 0;
    chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
    return out;
  }

  /* ================= 文件扫描 ================= */

  // 自然排序：数字段按数值比较（a2 < a10）
  function naturalCmp(x, y) {
    var i = 0, j = 0;
    var D = /\d/;
    while (i < x.length && j < y.length) {
      if (D.test(x[i]) && D.test(y[j])) {
        var s = i, t = j;
        while (i < x.length && D.test(x[i])) i++;
        while (j < y.length && D.test(y[j])) j++;
        var nx = x.slice(s, i), ny = y.slice(t, j);
        var c = (parseInt(nx, 10) || 0) - (parseInt(ny, 10) || 0) || (nx.length - ny.length);
        if (c) return c;
      } else {
        if (x[i] !== y[j]) return x[i] < y[j] ? -1 : 1;
        i++; j++;
      }
    }
    return x.length - y.length;
  }

  function extOf(name) {
    var dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  // 扫描文件夹中可解码的图片；无法解码的（损坏 / HEIC 等）计入 skipped
  async function scanFolder() {
    var candidates = [];
    var total = 0;
    for await (var it of dirHandle.values()) {  
      if (it.kind !== 'file') continue;
      total++;
      if (!IMG_EXTS[extOf(it.name)]) continue;
      candidates.push({ name: it.name, handle: it });
    }
    candidates.sort(function (a, b) { return naturalCmp(a.name, b.name); });

    var list = [];
    var skipped = 0;
    for (var i = 0; i < candidates.length; i++) {  
      var c = candidates[i];
      try {
        var file = await c.handle.getFile();
        var bmp = await createImageBitmap(file);
        list.push({
          name: c.name, handle: c.handle, file: file,
          w: bmp.width, h: bmp.height,
          url: (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(file) : ''
        });
        if (bmp.close) bmp.close();
      } catch (e) {
        skipped++;
      }
    }
    return { list: list, skipped: skipped, total: total };
  }

  async function pickFolder() {
    if (typeof window.showDirectoryPicker !== 'function') {
      $('bf-unsupported').hidden = false;
      return;
    }
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      return; // 用户取消
    }
    window.App.ui.showLoading('正在扫描文件夹…');
    var res = { list: [], skipped: 0, total: 0 };
    try {
      res = await scanFolder();
    } catch (e) {
      toast('读取文件夹失败：' + e.message, true);
    }
    window.App.ui.hideLoading();
    setItems(res.list);
    $('bf-folder').textContent = dirHandle.name + '（共 ' + res.total + ' 个文件）';
    var extra = res.skipped ? ' · 跳过 ' + res.skipped + ' 个（无法解码）' : '';
    $('bf-summary').textContent = res.list.length
      ? '已识别 ' + res.list.length + ' 张图片' + extra
      : '该文件夹中没有可转换的图片' + extra;
    if (!res.list.length) toast('该文件夹中没有可转换的图片', true);
  }

  function setItems(list) {
    releaseUrls();
    items = list;
    renderAll();
  }

  function releaseUrls() {
    if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
      items.forEach(function (it) { try { URL.revokeObjectURL(it.url); } catch (e) { /* 忽略 */ } });
    }
  }

  function clearAll() {
    dirHandle = null;
    setItems([]);
    $('bf-folder').textContent = '未选择文件夹';
    $('bf-summary').textContent = '';
  }

  /* ================= 渲染 ================= */

  function renderAll() {
    var fmt = $('bf-fmt').value;
    var mergePdf = FMTS[fmt] && FMTS[fmt].pdf && $('bf-pdf-merge').value === 'merge';
    var mergedName = (dirHandle ? dirHandle.name : '图片') + '.pdf';
    var used = {};
    var tbody = $('bf-table').querySelector('tbody');
    tbody.textContent = '';
    items.forEach(function (it, i) {
      it.outName = mergePdf ? mergedName : buildOutputName(it.name, fmt, used);

      var tr = document.createElement('tr');

      var td1 = document.createElement('td');
      td1.textContent = String(i + 1);
      tr.appendChild(td1);

      var td2 = document.createElement('td');
      var img = document.createElement('img');
      img.className = 'batch-thumb';
      img.alt = '';
      if (it.url) img.src = it.url;
      td2.appendChild(img);
      tr.appendChild(td2);

      var td3 = document.createElement('td');
      td3.textContent = it.name;
      tr.appendChild(td3);

      var td4 = document.createElement('td');
      td4.textContent = it.w + '×' + it.h;
      tr.appendChild(td4);

      var td5 = document.createElement('td');
      td5.textContent = it.outName;
      tr.appendChild(td5);

      tbody.appendChild(tr);
    });
    $('bf-empty').hidden = items.length > 0;
    $('bf-list').hidden = items.length === 0;
    $('bf-run').disabled = items.length === 0 || running;
  }

  function updateNote() {
    var sub = $('bf-out').value === 'sub';
    $('bf-note').textContent = sub
      ? '在原文件夹中新建「' + SUB_DIR + '」保存结果，不动原文件'
      : '直接覆盖原文件夹中的同名文件，请确认已备份重要照片';
  }

  function updateRows() {
    var conf = FMTS[$('bf-fmt').value] || FMTS.jpeg;
    $('bf-quality-row').hidden = !conf.quality;
    $('bf-bg-row').hidden = !conf.fill;
    $('bf-pdf-row').hidden = !conf.pdf;
  }

  /* ================= 转换与写盘 ================= */

  async function writeFile(dir, name, data) {
    var fh = await dir.getFileHandle(name, { create: true });
    var w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }

  // 解码 → 铺底色 → 编码为目标格式字节
  async function encodeImage(it, conf, quality, bg) {
    var bmp = it.file || await it.handle.getFile();
    bmp = await createImageBitmap(bmp);
    var canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    var ctx = canvas.getContext('2d');
    if (conf.fill) { // JPG / PDF 不支持透明，先铺底色再绘制
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    var blob = await new Promise(function (res, rej) {
      canvas.toBlob(function (b) { b ? res(b) : rej(new Error('编码失败')); },
        conf.mime, conf.quality ? quality : undefined);
    });
    return new Uint8Array(await blob.arrayBuffer());
  }

  // 图片 → JPEG 页（供 PDF 嵌入）
  async function toJpegPage(it, quality, bg) {
    var conf = FMTS.pdf;
    var jpeg = await encodeImage(it, conf, quality, bg);
    return { jpeg: jpeg, w: it.w, h: it.h };
  }

  async function run() {
    if (!items.length || running) return;
    var fmt = $('bf-fmt').value;
    var conf = FMTS[fmt] || FMTS.jpeg;
    var quality = clampQuality($('bf-quality').value) / 100;
    var bg = $('bf-bg').value;
    var outMode = $('bf-out').value;      // sub | same
    var pdfMerge = $('bf-pdf-merge').value; // merge | single

    var outDir = dirHandle;
    if (outMode === 'sub') {
      try {
        outDir = await dirHandle.getDirectoryHandle(SUB_DIR, { create: true });
      } catch (e) {
        toast('无法创建输出文件夹：' + e.message, true);
        return;
      }
    }

    running = true;
    $('bf-run').disabled = true;
    var ok = 0;
    var failed = [];
    try {
      if (conf.pdf && pdfMerge === 'merge') {
        // 合并模式：逐张生成 JPEG 页，最后写单个 PDF
        var pages = [];
        for (var i = 0; i < items.length; i++) {  
          var it = items[i];
          window.App.ui.showLoading('正在转换 ' + (i + 1) + '/' + items.length + ' …');
          try {
            pages.push(await toJpegPage(it, quality, bg));
          } catch (e) {
            failed.push(it.name);
          }
        }
        if (pages.length) {
          window.App.ui.showLoading('正在生成 PDF…');
          await writeFile(outDir, (dirHandle.name || '图片') + '.pdf', buildPdf(pages));
          ok = pages.length;
        }
      } else {
        for (i = 0; i < items.length; i++) {  
          it = items[i];
          window.App.ui.showLoading('正在转换 ' + (i + 1) + '/' + items.length + ' …');
          try {
            var data;
            if (conf.pdf) {
              data = buildPdf([await toJpegPage(it, quality, bg)]);
            } else {
              data = await encodeImage(it, conf, quality, bg);
            }
            if (outMode === 'same' && it.outName === it.name) { ok++; continue; } // 同名同格式，无需覆盖
            await writeFile(outDir, it.outName, data);
            ok++;
          } catch (e) {
            failed.push(it.name);
          }
        }
      }
    } finally {
      window.App.ui.hideLoading();
      running = false;
      $('bf-run').disabled = items.length === 0;
    }

    if (!ok && !failed.length) {
      toast('没有可转换的图片', true);
    } else {
      var where = outMode === 'sub' ? '「' + SUB_DIR + '」文件夹' : '原文件夹';
      toast('转换完成：成功 ' + ok + ' 张，已保存到 ' + where +
        (failed.length ? '；失败 ' + failed.length + ' 张（' + failed[0] + '）' : ''),
        failed.length > 0);
    }
    renderAll();
  }

  /* ================= 事件绑定 ================= */

  // 空态占位框点击 / 回车直接打开文件夹选择
  function bindEmptyPick(emptyId) {
    var el = $(emptyId);
    el.addEventListener('click', pickFolder);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pickFolder();
      }
    });
  }

  function init() {
    if (typeof window.showDirectoryPicker !== 'function') {
      $('bf-unsupported').hidden = false;
      $('bf-pick').disabled = true;
    }
    $('bf-pick').addEventListener('click', pickFolder);
    bindEmptyPick('bf-empty');
    $('bf-fmt').addEventListener('change', function () {
      updateRows();
      renderAll(); // 目标格式变化会改变输出文件名
    });
    $('bf-quality').addEventListener('input', function () {
      $('bf-quality-val').textContent = this.value + '%';
    });
    $('bf-pdf-merge').addEventListener('change', renderAll);
    $('bf-out').addEventListener('change', updateNote);
    $('bf-clear').addEventListener('click', clearAll);
    $('bf-run').addEventListener('click', run);
    $('bf-back').addEventListener('click', function () { window.App.batch.showOnly(null); });
    updateRows();
    updateNote();
  }

  window.App = window.App || {};
  window.App.batchFormat = {
    init: init,
    enter: function () {
      window.App.batch.showOnly('batch-format');
      renderAll();
    },
    buildPdf: buildPdf, // 纯 JS PDF 生成器（DCTDecode 嵌 JPEG），供文档工具各面板复用
    // 以下导出仅供测试
    _test: {
      FMTS: FMTS,
      IMG_EXTS: IMG_EXTS,
      SUB_DIR: SUB_DIR,
      clampQuality: clampQuality,
      buildOutputName: buildOutputName,
      pdfPageContent: pdfPageContent,
      buildPdf: buildPdf
    }
  };
})();
