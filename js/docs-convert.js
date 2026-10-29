/* ============================================================
 * docs-convert.js — 文档工具子功能：文档转换
 * 三个方向（纯本地）：
 *  - PDF → 图片：pdf.js 逐页渲染，导出 JPG / PNG（1x / 1.5x / 2x），逐页单图；
 *  - 图片 → PDF：JPG / PNG / WebP 合并为单个 PDF 或逐图单页，可选 A4 适印；
 *  - Word → PDF：mammoth 转 HTML → foreignObject 栅格化 → 按 A4 分页重建
 *    （简化版式：正文/标题/列表/表格/图片，复杂排版建议用 Word 另存 PDF）。
 * 输出统一写入所选文件夹的「转换输出」子目录，不动原文件。
 * 依赖：pdfcore（渲染/写入）、App.batchFormat.buildPdf（PDF 重建）、mammoth。
 * ============================================================ */
(function (App) {
  'use strict';

  var $ = App.ui.$;
  var core = App.pdfcore;
  var SUB_DIR = '转换输出';
  var A4_W = 595, A4_H = 842;        // A4 纵向（pt，72dpi）
  var A4_PX = 794, A4_PAGE_PX = 1123; // A4 @96dpi 渲染像素：页宽 / 每页高
  var PDF_RE = /\.pdf$/i;
  var IMG_RE = /\.(jpe?g|png|webp)$/i;
  var DOCX_RE = /\.(docx)$/i;

  var items = [];
  var dirHandle = null;
  var mode = 'p2i'; // p2i | i2p | w2p
  var running = false;

  function toast(msg, isErr) { App.ui.toast(msg, isErr); }
  function setStatus(msg) { $('dc-status').textContent = msg || ''; }

  function renderCount() {
    var n = items.length;
    $('dc-count').textContent = n ? '已选 ' + n + ' 个文件' : '';
    $('dc-empty').hidden = n > 0;
    $('dc-clear').hidden = n === 0;
  }

  function addResult(name, ok, extra) {
    var row = document.createElement('div');
    row.className = 'dw-list-row ' + (ok ? 'ok' : 'bad');
    row.innerHTML = '<span>' + String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
      '</span><span class="dw-res">' + (ok ? '完成' + (extra || '') : '失败') + '</span>';
    $('dc-list').appendChild(row);
  }

  function baseName(name) { return name.replace(/\.[^.]+$/, ''); }

  /* ================= PDF → 图片 ================= */

  async function runPdfToImages(out) {
    var fmt = $('dc-p2i-fmt').value;                 // jpeg | png
    var scale = +$('dc-p2i-scale').value;            // 1 | 1.5 | 2
    var type = fmt === 'png' ? 'image/png' : 'image/jpeg';
    var ext = fmt === 'png' ? '.png' : '.jpg';
    var okN = 0, pageN = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var pdf = null;
      setStatus('转换 ' + (i + 1) + '/' + items.length + '：' + it.file.name);
      try {
        pdf = await core.loadPdf(it.file);
        for (var p = 1; p <= pdf.numPages; p++) {
          var canvas = await core.renderPage(pdf, p, scale);
          var blob = await core.encodeCanvas(canvas, type, fmt === 'png' ? undefined : 0.92);
          // 同名文件（不同文件夹多选）防静默覆盖：探测目录已有则追加 _N 后缀
          var outName = await core.uniqueOutName(out, baseName(it.file.name) + '-p' + p + ext);
          await core.writeBytes(out, outName, blob);
          pageN++;
        }
        okN++;
        addResult(it.file.name, true, '，' + pdf.numPages + ' 页');
      } catch (e) {
        addResult(it.file.name, false);
        console.error('[haoyue] PDF 转图片失败:', it.file.name, e);
      } finally {
        if (pdf) pdf.cleanup();
      }
    }
    return { okN: okN, pageN: pageN };
  }

  /* ================= 图片 → PDF ================= */

  // 单图 → { jpeg, w, h }：original 按图像尺寸作页；a4 居中适印（2x 渲染保清晰）
  async function imageToPage(file, paper) {
    var bmp = await createImageBitmap(file);
    if (paper === 'a4') {
      var canvas = document.createElement('canvas');
      canvas.width = A4_W * 2; canvas.height = A4_H * 2;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      var r = Math.min((A4_W * 2 * 0.92) / bmp.width, (A4_H * 2 * 0.92) / bmp.height);
      var w = bmp.width * r, h = bmp.height * r;
      ctx.drawImage(bmp, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      var blob = await core.encodeCanvas(canvas, 'image/jpeg', 0.92);
      return { jpeg: new Uint8Array(await blob.arrayBuffer()), w: A4_W, h: A4_H };
    }
    // 原始尺寸：长边超 2000px 时等比缩到 2000（页尺寸随比例，避免超大页）
    var W = bmp.width, H = bmp.height;
    var k = Math.min(1, 2000 / Math.max(W, H));
    var c2 = document.createElement('canvas');
    c2.width = Math.round(W * k); c2.height = Math.round(H * k);
    c2.getContext('2d').drawImage(bmp, 0, 0, c2.width, c2.height);
    var b2 = await core.encodeCanvas(c2, 'image/jpeg', 0.92);
    return { jpeg: new Uint8Array(await b2.arrayBuffer()), w: Math.round(W * k), h: Math.round(H * k) };
  }

  async function runImagesToPdf(out) {
    var paper = $('dc-i2p-paper').value;   // original | a4
    var merge = $('dc-i2p-merge').value === 'merge';
    var okN = 0;
    if (merge) {
      setStatus('合并 ' + items.length + ' 张图片为 PDF…');
      var pages = [];
      for (var i = 0; i < items.length; i++) {
        setStatus('处理图片 ' + (i + 1) + '/' + items.length + '：' + items[i].file.name);
        try {
          // 逐张 try/catch：单张坏图（改扩展名的假 JPEG、0 字节文件）只记失败，
          // 不葬送整批（此前无 catch，rejection 直达全局兜底、状态行卡死）
          pages.push(await imageToPage(items[i].file, paper));
          okN++;
        } catch (e) {
          addResult(items[i].file.name, false);
          console.error('[haoyue] 图片合并失败:', items[i].file.name, e);
        }
      }
      if (!pages.length) {
        setStatus('失败：所有图片均无法解码，未生成 PDF');
        return { okN: 0, pageN: 0, noSummary: true };
      }
      var bytes = App.batchFormat.buildPdf(pages);
      var mergeName = await core.uniqueOutName(out, '图片合并.pdf');
      await core.writeBytes(out, mergeName, bytes);
      addResult(mergeName, true, '，' + pages.length + ' 页');
      setStatus('完成：成功 ' + okN + '/' + items.length + ' 张图片，合并为 ' + pages.length +
        ' 页，已输出到「' + dirHandle.name + '/' + SUB_DIR + '」');
      return { okN: okN, pageN: 0, noSummary: true };
    } else {
      for (var j = 0; j < items.length; j++) {
        setStatus('转换 ' + (j + 1) + '/' + items.length + '：' + items[j].file.name);
        try {
          var page = await imageToPage(items[j].file, paper);
          var singleName = await core.uniqueOutName(out, baseName(items[j].file.name) + '.pdf');
          await core.writeBytes(out, singleName, App.batchFormat.buildPdf([page]));
          okN++;
          addResult(singleName, true);
        } catch (e) {
          addResult(items[j].file.name, false);
          console.error('[haoyue] 图片转 PDF 失败:', items[j].file.name, e);
        }
      }
    }
    return { okN: okN, pageN: 0 };
  }

  /* ================= Word → PDF ================= */

  /* mammoth 输出来自用户 DOCX：虽由 mammoth 白名单生成，仍按纵深防御原则清洗——
   * holder 会先挂进 document.body 再序列化，挂载阶段 img onerror 等事件属性
   * 在主流文档上下文即可执行。剥离：on* 事件属性、危险协议 URL
   * （javascript:/vbscript: 等，仅放行相对地址与 img 的 data:image 内嵌图）、
   * 危险 style 表达式、可执行/外联标签。 */
  function sanitizeDocxHtml(html) {
    var doc = new DOMParser().parseFromString('<div id="__sx">' + String(html || '') + '</div>', 'text/html');
    var root = doc.getElementById('__sx');
    if (!root) return '';
    root.querySelectorAll('*').forEach(function (el) {
      Array.prototype.slice.call(el.attributes || []).forEach(function (attr) {
        var n = String(attr.name || '').toLowerCase();
        var v = String(attr.value == null ? '' : attr.value).replace(/\s+/g, '').toLowerCase();
        if (n.indexOf('on') === 0) { el.removeAttribute(attr.name); return; }
        if (n === 'style' && /expression|javascript:|behavior|-moz-binding/.test(v)) {
          el.removeAttribute(attr.name); return;
        }
        if (n === 'href' || n === 'src' || n === 'xlink:href') {
          // 危险协议黑名单剥除；http(s) / 相对地址 / mailto 等保留，
          // img 的 data:image 内嵌图放行（mammoth 图片内联形态）
          var imgData = el.tagName === 'IMG' && /^data:image\//.test(v);
          if (/^(?:javascript|vbscript|livescript|mocha|data|file):/.test(v) && !imgData) {
            el.removeAttribute(attr.name);
          }
        }
      });
    });
    ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'svg', 'math']
      .forEach(function (tag) {
        root.querySelectorAll(tag).forEach(function (el) {
          if (el.parentNode) el.parentNode.removeChild(el);
        });
      });
    return root.innerHTML;
  }

  // mammoth HTML → 隐藏容器排版 → foreignObject 栅格化 → 按 A4 高度切片分页
  async function docxToPdf(file) {
    if (!window.mammoth) throw new Error('DOCX 解析库未加载');
    var buf = await file.arrayBuffer();
    var r = await window.mammoth.convertToHtml({ arrayBuffer: buf });
    var holder = document.createElement('div');
    holder.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    holder.style.cssText = 'position:absolute;left:-99999px;top:0;width:' + A4_PX + 'px;' +
      'background:#fff;font:15px/1.75 "Microsoft YaHei",sans-serif;color:#111;padding:48px 56px;box-sizing:border-box;';
    holder.innerHTML =
      '<style>' +
      'h1{font-size:26px;margin:18px 0 12px}h2{font-size:21px;margin:16px 0 10px}h3{font-size:17px;margin:14px 0 8px}' +
      'p{margin:0 0 10px}ul,ol{margin:0 0 10px;padding-left:26px}table{border-collapse:collapse;width:100%;margin:10px 0}' +
      'td,th{border:1px solid #999;padding:5px 8px;font-size:13px}img{max-width:100%}' +
      '</style>' + sanitizeDocxHtml(r.value);
    document.body.appendChild(holder);
    var height = Math.max(holder.scrollHeight, A4_PAGE_PX);
    var xml = new XMLSerializer().serializeToString(holder);
    document.body.removeChild(holder);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + A4_PX + '" height="' + height + '">' +
      '<foreignObject width="100%" height="100%">' + xml + '</foreignObject></svg>';
    var img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    var tall = document.createElement('canvas');
    tall.width = A4_PX; tall.height = height;
    var tctx = tall.getContext('2d');
    tctx.fillStyle = '#ffffff';
    tctx.fillRect(0, 0, tall.width, tall.height);
    tctx.drawImage(img, 0, 0);
    // 切片：每页 A4_PAGE_PX 像素高 → 缩放 2x 页密度转为 pt 页
    var pageCount = Math.ceil(height / A4_PAGE_PX);
    var pages = [];
    for (var i = 0; i < pageCount; i++) {
      var slice = document.createElement('canvas');
      slice.width = A4_W * 2; slice.height = A4_H * 2;
      var sctx = slice.getContext('2d');
      sctx.fillStyle = '#ffffff';
      sctx.fillRect(0, 0, slice.width, slice.height);
      /* 末页源高不足一页时按源高度等比缩放到目标高度（此前直接拉满整页，
       * 561px 源 → 1684px 目标约 3 倍垂直拉伸，末页文字变扁长） */
      var srcH = Math.min(A4_PAGE_PX, height - i * A4_PAGE_PX);
      var dstH = Math.max(1, Math.round(slice.height * srcH / A4_PAGE_PX));
      sctx.drawImage(tall, 0, i * A4_PAGE_PX, A4_PX, srcH, 0, 0, slice.width, dstH);
      var pb = await core.encodeCanvas(slice, 'image/jpeg', 0.9);
      pages.push({ jpeg: new Uint8Array(await pb.arrayBuffer()), w: A4_W, h: A4_H });
    }
    return App.batchFormat.buildPdf(pages);
  }

  async function runWordToPdf(out) {
    var okN = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      setStatus('转换 ' + (i + 1) + '/' + items.length + '：' + it.file.name);
      try {
        var bytes = await docxToPdf(it.file);
        var wName = await core.uniqueOutName(out, baseName(it.file.name) + '.pdf');
        await core.writeBytes(out, wName, bytes);
        okN++;
        addResult(wName, true);
      } catch (e) {
        addResult(it.file.name, false);
        console.error('[haoyue] Word 转 PDF 失败:', it.file.name, e);
      }
    }
    return { okN: okN, pageN: 0 };
  }

  /* ================= 主流程 ================= */

  async function run() {
    if (running) return;
    if (!items.length) { toast('请先选择要转换的文件'); return; }
    if (!dirHandle) { toast('请先选择输出文件夹'); return; }
    running = true;
    $('dc-run').disabled = true;
    $('dc-list').innerHTML = '';
    var out = null;
    try { out = await core.ensureSubDir(dirHandle, SUB_DIR); }
    catch (e) {
      $('dc-run').disabled = false; running = false;
      return toast('无法创建输出文件夹：' + ((e && e.message) || e), true);
    }
    var res;
    try {
      if (mode === 'p2i') res = await runPdfToImages(out);
      else if (mode === 'i2p') res = await runImagesToPdf(out);
      else res = await runWordToPdf(out);
      // noSummary：子流程已设置更精确的完成/失败状态行（含部分失败计数），不套通用模板
      if (!res.noSummary) setStatus('完成：成功 ' + res.okN + ' 项' + (res.pageN ? '，共输出 ' + res.pageN + ' 张图片' : '') +
        '，已输出到「' + dirHandle.name + '/' + SUB_DIR + '」，原文件未改动');
    } finally {
      $('dc-run').disabled = false;
      running = false;
    }
  }

  function onFilesPicked() {
    var input = $('dc-file');
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) return;
    var ok = [], skipped = 0;
    files.forEach(function (f) {
      if (mode === 'p2i' && PDF_RE.test(f.name)) ok.push({ file: f, isPdf: true });
      else if (mode === 'i2p' && IMG_RE.test(f.name)) ok.push({ file: f, isPdf: false });
      else if (mode === 'w2p' && DOCX_RE.test(f.name)) ok.push({ file: f, isPdf: false });
      else skipped++;
    });
    if (skipped) toast('已跳过 ' + skipped + ' 个与当前方向不符的文件');
    items = ok;
    renderCount();
  }

  function setMode(next) {
    mode = next;
    items = [];
    renderCount();
    ['dc-p2i', 'dc-i2p', 'dc-w2p'].forEach(function (id) { $(id).hidden = id !== 'dc-' + mode; });
    ['p2i', 'i2p', 'w2p'].forEach(function (m) {
      $('dc-tab-' + m).classList.toggle('active', mode === m);
    });
    var acc = { p2i: '.pdf（可多选）', i2p: 'JPG / PNG / WebP（可多选）', w2p: '.docx（可多选）' }[mode];
    $('dc-file').setAttribute('accept', mode === 'p2i' ? '.pdf' : mode === 'i2p' ? '.jpg,.jpeg,.png,.webp' : '.docx');
    $('dc-pick').textContent = '选择' + acc;
  }

  function enter() {
    $('dc-list').innerHTML = '';
    setStatus('');
    renderCount();
  }

  App.docsConvert = {
    enter: enter,
    _test: {
      parseRangesRef: function (s, m) { return core.parsePageRanges(s, m); },
      setItemsRef: function (arr) { items = arr || []; },
      setModeRef: function (m) { setMode(m); },
      setDirRef: function (d) { dirHandle = d; },
      runPdfToImagesRef: runPdfToImages,
      runImagesToPdfRef: runImagesToPdf,
      imageToPageRef: imageToPage,
      sanitizeRef: sanitizeDocxHtml
    }
  };

  App.docsConvert.init = function () {
    $('dc-pick').addEventListener('click', function () { $('dc-file').value = ''; $('dc-file').click(); });
    $('dc-file').addEventListener('change', onFilesPicked);
    $('dc-clear').addEventListener('click', function () { items = []; renderCount(); });
    $('dc-tab-p2i').addEventListener('click', function () { setMode('p2i'); });
    $('dc-tab-i2p').addEventListener('click', function () { setMode('i2p'); });
    $('dc-tab-w2p').addEventListener('click', function () { setMode('w2p'); });
    $('dc-dir').addEventListener('click', async function () {
      var d = await core.pickOutputDir();
      if (d) { dirHandle = d; $('dc-dir-name').textContent = d.name; }
      else if (typeof window.showDirectoryPicker !== 'function') {
        toast('当前环境不支持选择文件夹，请使用桌面版或 Chrome / Edge 浏览器', true);
      }
    });
    $('dc-run').addEventListener('click', run);
    setMode('p2i');
  };
})(window.App);
