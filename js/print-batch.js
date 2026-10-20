/* ============================================================
 * print-batch.js — 批量打印（图片，批量工具内） + 文档打印（文档工具内）
 * 图片：多选 → 单张旋转（0/90/180/270）→ 按纸张适配统一打印；
 * 文档：多选 PDF / TXT / DOCX → 列队顺序打印（每文档一个任务）
 *       或合并打印（全部页合并为一个任务），支持单双面。
 * 面板归属：print-batch 在批量工具视图内（返回交批量工具菜单），
 *           print-docs / docs-convert / docs-pdf / docs-watermark / docs-ocr 在文档工具视图内。
 * PDF 渲染用 pdf.js（vendor/print），DOCX 用 mammoth 提取文本简化排版，
 * TXT 原生排版分页；全部离线本地执行。
 * 浏览器模式下 window.zunhongPrint 不存在，面板提示并禁用。
 * ============================================================ */
'use strict';

window.App = window.App || {};
window.App.printBatch = (function () {

  var $ = window.App.ui.$;
  var toast = window.App.ui ? window.App.ui.toast : function () {};
  var printApi = window.zunhongPrint || null;

  var IMG_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'];
  var DOC_EXTS = ['pdf', 'txt', 'docx', 'doc'];

  /* 画布像素密度：A4 210mm → 1680px（约 203dpi），清晰度与内存平衡 */
  var PX_PER_MM = 8;
  /* 文档统一按 A4 竖向排版（PDF 页内自带尺寸，打印时 contain 适配） */
  var DOC_MARGIN_MM = 15;
  var DOC_FONT_SIZE = 15;          // px，正文
  var DOC_LINE_HEIGHT = 24;        // px，行高（1.6）
  var PDF_SCALE = 2.5;             // pdf.js 默认渲染倍率（≈180dpi）
  var PDF_MAX_W = 2400;            // pdf.js 渲染像素宽上限（防超大页吃内存）

  /* 图片列表项：{ path, name, size, url, img, w, h, rot, checked, status }（status: loading/ready/error）
     文档列表项：{ path, name, size, type, pages, checked, status, error }（status: pending/ready/error） */
  var imgs = [];
  var docs = [];
  var printing = false;

  /* ================= 纯函数（供单测） ================= */

  function extOf(name) {
    var m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  /* 旋转角归一到 0/90/180/270 */
  function normalizeRot(deg) {
    var v = Math.round((+deg || 0) / 90) * 90;
    return ((v % 360) + 360) % 360;
  }

  function nextRot(deg) { return (normalizeRot(deg) + 90) % 360; }

  /* 旋转后的外接尺寸（仅直角旋转） */
  function rotatedSize(w, h, deg) {
    var r = normalizeRot(deg);
    return (r === 90 || r === 270) ? { w: h, h: w } : { w: w, h: h };
  }

  /* contain 适配：返回缩放后的绘制尺寸（不放大，只缩小） */
  function fitContain(w, h, boxW, boxH) {
    if (!w || !h || !boxW || !boxH) return { w: 0, h: 0 };
    var k = Math.min(boxW / w, boxH / h, 1);
    return { w: w * k, h: h * k };
  }

  /* 旋转绘制参数：k 为旋转后外接盒适配比例，dw/dh 为旋转坐标系内的绘制尺寸 */
  function drawParams(w, h, deg, boxW, boxH) {
    var rs = rotatedSize(w, h, deg);
    var fit = fitContain(rs.w, rs.h, boxW, boxH);
    var k = rs.w ? fit.w / rs.w : 0;
    return { k: k, dw: w * k, dh: h * k };
  }

  function docTypeOf(name) {
    var e = extOf(name);
    return DOC_EXTS.indexOf(e) >= 0 ? e : '';
  }

  function clampCopies(raw) {
    var v = Math.floor(+raw);
    if (!v || v < 1) v = 1;
    if (v > 99) v = 99;
    return v;
  }

  /* 文本排版折行：超宽按字符折行（CJK 无空格可断），返回行数组。
     ctx 只需提供 measureText（node 单测用 mock 即可） */
  function splitTextLines(ctx, text, maxW) {
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (para) {
      if (!para) { out.push(''); return; }
      if (ctx.measureText(para).width <= maxW) { out.push(para); return; }
      var line = '';
      for (var i = 0; i < para.length; i++) {
        var test = line + para.charAt(i);
        if (line && ctx.measureText(test).width > maxW) {
          out.push(line);
          line = para.charAt(i);
        } else {
          line = test;
        }
      }
      if (line) out.push(line);
    });
    return out;
  }

  /* 行分页：每页 linesPerPage 行；空输入返回一页空行 */
  function paginateRows(rows, linesPerPage) {
    var n = Math.max(1, linesPerPage | 0);
    var pages = [];
    var src = rows && rows.length ? rows : [''];
    for (var i = 0; i < src.length; i += n) pages.push(src.slice(i, i + n));
    return pages;
  }

  /* 文档页数估算：文本按 A4 版面行数折算 */
  function docLinesPerPage(pageMm) {
    var pxH = Math.round(pageMm.h * PX_PER_MM);
    var m = Math.round(DOC_MARGIN_MM * PX_PER_MM);
    return Math.max(1, Math.floor((pxH - 2 * m) / DOC_LINE_HEIGHT));
  }

  /* 大小展示 */
  function fmtSize(n) {
    if (typeof n !== 'number' || n < 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  /* 勾选过滤：未勾选的项不参与打印（checked 为 true/undefined 均视为勾选） */
  function isChecked(it) { return it.checked !== false; }
  function checkedOf(items) { return (items || []).filter(isChecked); }

  /* ================= 通用 ================= */

  function bridgeOk() {
    return !!(printApi && printApi.pickPaths && printApi.readFile && printApi.printImage);
  }

  function setPrinting(on, panel) {
    printing = on;
    if (panel === 'img') {
      $('pb-run').disabled = on || !checkedOf(imgs).some(function (it) { return it.status === 'ready'; }) || !bridgeOk();
    } else {
      $('pd-run').disabled = on || !checkedOf(docs).some(function (d) { return d.status === 'ready'; }) || !bridgeOk();
    }
  }

  /* 组装 printImage 公共参数 */
  function printParams(printerSel, copiesSel, duplexSel) {
    return {
      printerName: $(printerSel).value || undefined,
      copies: clampCopies($(copiesSel).value),
      duplex: $(duplexSel).value === 'longEdge' || $(duplexSel).value === 'shortEdge'
        ? $(duplexSel).value : 'simplex'
    };
  }

  async function sendPrint(payload, statusEl, desc) {
    var res = null;
    try {
      res = await printApi.printImage(payload);
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    return res;
  }

  /* ================= 图片面板 ================= */

  async function pickImages() {
    if (!bridgeOk()) { toast('打印功能需要在桌面版中使用', true); return; }
    var list = [];
    try { list = await printApi.pickPaths('image'); } catch (e) { list = []; }
    addImages(list || []);
  }

  function addImages(list) {
    var seen = {};
    imgs.forEach(function (it) { seen[it.path] = 1; });
    list.forEach(function (m) {
      if (!m || !m.path || seen[m.path]) return;
      if (IMG_EXTS.indexOf(extOf(m.name)) < 0) return;
      seen[m.path] = 1;
      var item = { path: m.path, name: m.name, size: m.size, url: '', img: null, w: 0, h: 0, rot: 0, checked: true, status: 'loading' };
      imgs.push(item);
      loadImage(item);
    });
    renderImgGrid();
  }

  async function loadImage(item) {
    var url = '';
    try {
      var res = await printApi.readFile(item.path);
      if (!res || !res.ok) throw new Error((res && res.error) || '读取失败');
      var blob = new Blob([res.data]);
      url = URL.createObjectURL(blob);
      var img = new Image();
      await new Promise(function (resolve, reject) {
        img.onload = function () { resolve(); };
        img.onerror = function () { reject(new Error('图片解码失败')); };
        img.src = url;
      });
      item.url = url;
      item.img = img;
      item.w = img.naturalWidth || img.width;
      item.h = img.naturalHeight || img.height;
      item.status = 'ready';
    } catch (e) {
      /* 解码失败等异常路径：释放已创建的 blob URL，避免泄漏 */
      if (url) { try { URL.revokeObjectURL(url); } catch (e2) { /* 忽略 */ } }
      item.status = 'error';
      item.error = e.message;
    }
    renderImgGrid();
  }

  function rotateImg(i) {
    var it = imgs[i];
    if (!it) return;
    it.rot = nextRot(it.rot);
    renderImgGrid();
  }

  function toggleImg(i, on) {
    var it = imgs[i];
    if (!it) return;
    it.checked = !!on;
    renderImgGrid();
  }

  /* 同步全选框三态：全勾 / 半选 / 全不勾 */
  function syncCheckAll(allSel, items) {
    var box = $(allSel);
    var n = checkedOf(items).length;
    box.checked = items.length > 0 && n === items.length;
    box.indeterminate = n > 0 && n < items.length;
  }

  function toggleAllImgs(on) {
    imgs.forEach(function (it) { it.checked = !!on; });
    renderImgGrid();
  }

  function removeImg(i) {
    var it = imgs[i];
    if (!it) return;
    if (it.url) { try { URL.revokeObjectURL(it.url); } catch (e) { /* 忽略 */ } }
    imgs.splice(i, 1);
    renderImgGrid();
  }

  function imgCountText() {
    if (!imgs.length) return '未选择';
    var ok = imgs.filter(function (it) { return it.status === 'ready'; }).length;
    var ck = checkedOf(imgs).length;
    var txt = '已选 ' + imgs.length + ' 张 · 就绪 ' + ok + ' 张';
    if (ck < imgs.length) txt += ' · 已勾选 ' + ck + ' 张';
    return txt;
  }

  function renderImgGrid() {
    var grid = $('pb-grid');
    grid.textContent = '';
    grid.hidden = !imgs.length;
    $('pb-empty').hidden = !!imgs.length;
    imgs.forEach(function (it, i) {
      var card = document.createElement('div');
      card.className = 'pb-card' + (it.status === 'error' ? ' pb-card-err' : '')
        + (it.checked === false ? ' pb-card-off' : '');

      var pick = document.createElement('label');
      pick.className = 'pb-pick';
      var pickBox = document.createElement('input');
      pickBox.type = 'checkbox';
      pickBox.checked = it.checked !== false;
      pickBox.title = '勾选后参与打印';
      pickBox.addEventListener('change', function () { toggleImg(i, pickBox.checked); });
      pick.appendChild(pickBox);
      pick.appendChild(document.createTextNode('打印'));
      card.appendChild(pick);

      var thumbBox = document.createElement('div');
      thumbBox.className = 'pb-thumb';
      if (it.status === 'ready') {
        var im = document.createElement('img');
        im.src = it.url;
        im.alt = it.name;
        if (it.rot) im.style.transform = 'rotate(' + it.rot + 'deg)';
        thumbBox.appendChild(im);
        var deg = document.createElement('span');
        deg.className = 'pb-deg';
        deg.textContent = it.rot ? it.rot + '°' : '0°';
        thumbBox.appendChild(deg);
      } else {
        var tip = document.createElement('span');
        tip.className = 'pb-thumb-tip';
        tip.textContent = it.status === 'loading' ? '加载中…' : '加载失败';
        thumbBox.appendChild(tip);
      }

      var name = document.createElement('div');
      name.className = 'pb-name';
      name.textContent = it.name;
      name.title = it.path;

      var meta = document.createElement('div');
      meta.className = 'pb-meta';
      meta.textContent = it.status === 'ready'
        ? it.w + '×' + it.h + ' · ' + fmtSize(it.size)
        : fmtSize(it.size);

      var ops = document.createElement('div');
      ops.className = 'pb-ops';
      var rotBtn = document.createElement('button');
      rotBtn.className = 'ghost pb-op';
      rotBtn.textContent = '旋转 90°';
      rotBtn.disabled = it.status !== 'ready';
      rotBtn.addEventListener('click', function () { rotateImg(i); });
      var delBtn = document.createElement('button');
      delBtn.className = 'ghost pb-op pb-op-del';
      delBtn.textContent = '移除';
      delBtn.addEventListener('click', function () { removeImg(i); });
      ops.appendChild(rotBtn);
      ops.appendChild(delBtn);

      card.appendChild(thumbBox);
      card.appendChild(name);
      card.appendChild(meta);
      card.appendChild(ops);
      grid.appendChild(card);
    });
    $('pb-count').textContent = imgCountText();
    syncCheckAll('pb-check-all', imgs);
    $('pb-run').disabled = printing || !bridgeOk()
      || !checkedOf(imgs).some(function (it) { return it.status === 'ready'; });
  }

  /* 统一打印：勾选的图片按纸张 contain 适配成页（应用旋转），合并一个任务发送 */
  async function runImages() {
    if (printing) return;
    if (!bridgeOk()) { toast('打印功能需要在桌面版中使用', true); return; }
    var ready = checkedOf(imgs).filter(function (it) { return it.status === 'ready'; });
    if (!ready.length) { toast('还没有勾选就绪的图片', true); return; }

    var paper = window.App.print.PAPERS[$('pb-paper').value] || window.App.print.PAPERS.A4;
    var landscape = $('pb-orient').value === '1';
    var mm = landscape ? { w: paper.h, h: paper.w } : { w: paper.w, h: paper.h };
    /* 边距完全交给打印驱动（marginType:printableArea），画布整页铺满——
       画布再烤 5mm 白边会与驱动可打印边距叠加成约 10mm 双重边距 */
    var W = Math.round(mm.w * PX_PER_MM);
    var H = Math.round(mm.h * PX_PER_MM);

    var btn = $('pb-run');
    var status = $('pb-status');
    btn.disabled = true;
    setPrinting(true, 'img');
    status.textContent = '正在生成打印页面…';
    try {
      var urls = ready.map(function (it) {
        var c = document.createElement('canvas');
        c.width = W; c.height = H;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, W, H);
        var dp = drawParams(it.w, it.h, it.rot, W, H);
        if (dp.k > 0) {
          ctx.save();
          ctx.translate(W / 2, H / 2);
          ctx.rotate(it.rot * Math.PI / 180);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(it.img, -dp.dw / 2, -dp.dh / 2, dp.dw, dp.dh);
          ctx.restore();
        }
        return c.toDataURL('image/jpeg', 0.92);
      });

      status.textContent = '正在发送打印任务…';
      var params = printParams('pb-printer', 'pb-copies', 'pb-duplex');
      var res = await sendPrint(Object.assign({
        dataUrls: urls,
        pageSize: paper.electron,
        landscape: landscape,
        marginType: $('pb-margin').value === 'printableArea' ? 'printableArea' : 'none'
      }, params));
      if (res && res.ok) {
        window.App.ui.statusText(status, '已发送打印任务（' + urls.length + ' 页 × ' + params.copies + ' 份）', 'check');
        toast('已发送到打印机', false, 'check');
      } else {
        status.textContent = '打印失败：' + ((res && res.error) || '未知错误');
        toast('打印失败：' + ((res && res.error) || '未知错误'), true);
      }
    } catch (e) {
      /* 画布生成/编码抛错（坏图、内存不足等）：与 runDocs 一致兜底，
         不能让 printing 卡死锁住执行按钮 */
      status.textContent = '打印失败：' + ((e && e.message) || '未知错误');
      toast('打印失败：' + ((e && e.message) || '未知错误'), true);
    } finally {
      setPrinting(false, 'img');
    }
  }

  function clearImages() {
    imgs.forEach(function (it) {
      if (it.url) { try { URL.revokeObjectURL(it.url); } catch (e) { /* 忽略 */ } }
    });
    imgs = [];
    renderImgGrid();
    $('pb-status').textContent = '';
  }

  /* ================= 文档面板 ================= */

  /* 读文件字节（主进程 print:readFile） */
  async function readDocBytes(path) {
    var res = await printApi.readFile(path);
    if (!res || !res.ok) throw new Error((res && res.error) || '读取失败');
    return res.data;
  }

  /* 文本解码：UTF-8 优先，失败回退 GBK（中文 txt 常见编码） */
  function decodeText(buf) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (e) {
      try { return new TextDecoder('gbk').decode(buf); }
      catch (e2) { return new TextDecoder('utf-8').decode(buf); }
    }
  }

  /* mammoth 转 HTML → 提取纯文本（段间换行），简化排版 */
  function htmlToText(html) {
    return String(html || '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br[^>]*>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
      .replace(/<(p|div|h[1-6]|li|tr|blockquote)(\s[^>]*)?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* 排版 ctx（折行测量用） */
  var measureCtx = null;
  function getMeasureCtx() {
    if (!measureCtx) {
      var c = document.createElement('canvas');
      measureCtx = c.getContext('2d');
      measureCtx.font = DOC_FONT_SIZE + 'px "Microsoft YaHei", "PingFang SC", sans-serif';
    }
    return measureCtx;
  }

  function docPageMm() {
    return { w: 210, h: 297 };  /* 文档固定 A4 竖向 */
  }

  function docTextMaxW() {
    var m = Math.round(DOC_MARGIN_MM * PX_PER_MM);
    return Math.round(docPageMm().w * PX_PER_MM) - 2 * m;
  }

  /* pdf.js 6.x 的 getDocument 只接受 TypedArray（内部直接转移 buffer 给 worker），
     而 IPC/读文件路径拿到的是 ArrayBuffer，统一归一化（3.x 两者皆收，6.x 不收 ArrayBuffer） */
  function toPdfData(buf) {
    return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  }

  /* PDF → dataUrls（pdf.js 每页渲染） */
  async function renderPdf(data, onPage) {
    var pdfjs = window.pdfjsLib;
    if (!pdfjs) throw new Error('PDF 渲染库未加载');
    /* worker 指向本地（CSP 同源）；适配器已配置，此处兜底防呆 */
    if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/print/pdf.worker.min.mjs';
    }
    var pdf = await pdfjs.getDocument({ data: toPdfData(data) }).promise;
    var urls = [];
    for (var i = 1; i <= pdf.numPages; i++) {   
      var page = await pdf.getPage(i);           
      var v1 = page.getViewport({ scale: 1 });
      var scale = Math.min(PDF_SCALE, PDF_MAX_W / v1.width);
      var vp = page.getViewport({ scale: scale });
      var c = document.createElement('canvas');
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;   
      var url = c.toDataURL('image/jpeg', 0.92);
      urls.push(url);
      if (onPage) onPage(i, pdf.numPages);
    }
    pdf.cleanup();   /* pdf.js 6.x：PDFDocumentProxy.destroy 已移除，改用 cleanup */
    return { pages: urls.length, dataUrls: urls };
  }

  /* TXT / DOCX → 文本 → 按 A4 版面排版分页 → dataUrls */
  function renderTextPages(text, onPage) {
    var mm = docPageMm();
    var W = Math.round(mm.w * PX_PER_MM);
    var H = Math.round(mm.h * PX_PER_MM);
    var m = Math.round(DOC_MARGIN_MM * PX_PER_MM);
    var lines = splitTextLines(getMeasureCtx(), text, W - 2 * m);
    var perPage = docLinesPerPage(mm);
    var pages = paginateRows(lines, perPage);
    var urls = pages.map(function (rows, pi) {
      var c = document.createElement('canvas');
      c.width = W; c.height = H;
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#111111';
      ctx.font = getMeasureCtx().font;
      ctx.textBaseline = 'top';
      rows.forEach(function (row, ri) {
        if (row) ctx.fillText(row, m, m + ri * DOC_LINE_HEIGHT);
      });
      if (onPage) onPage(pi + 1, pages.length);
      return c.toDataURL('image/jpeg', 0.92);
    });
    return { pages: urls.length, dataUrls: urls };
  }

  async function renderDoc(d, onPage) {
    if (d.type === 'pdf') {
      var data = await readDocBytes(d.path);
      return renderPdf(data, onPage);
    }
    var buf = await readDocBytes(d.path);
    var text = '';
    if (d.type === 'txt') {
      text = decodeText(buf);
    } else {  /* doc / docx：mammoth 提取（doc 为旧格式，mammoth 可能失败 → 提示转 PDF） */
      if (!window.mammoth) throw new Error('DOCX 解析库未加载');
      try {
        var r = await window.mammoth.convertToHtml({ arrayBuffer: buf });
        text = htmlToText(r.value);
      } catch (e) {
        throw new Error('解析失败（旧版 .doc 请先转为 PDF 或 DOCX）');
      }
    }
    if (!text) text = '（空文档）';
    return renderTextPages(text, onPage);
  }

  async function pickDocs() {
    if (!bridgeOk()) { toast('打印功能需要在桌面版中使用', true); return; }
    var list = [];
    try { list = await printApi.pickPaths('doc'); } catch (e) { list = []; }
    addDocs(list || []);
  }

  function addDocs(list) {
    var seen = {};
    docs.forEach(function (d) { seen[d.path] = 1; });
    list.forEach(function (m) {
      if (!m || !m.path || seen[m.path]) return;
      var type = docTypeOf(m.name);
      if (!type) return;   /* 非文档扩展名自动过滤 */
      seen[m.path] = 1;
      docs.push({ path: m.path, name: m.name, size: m.size, type: type, pages: null, checked: true, status: 'pending', error: '' });
    });
    renderDocList();
    /* 逐个预解析页数（异步，不阻塞选择）；parsing 标记防同批/跨批重复解析 */
    docs.forEach(function (d) {
      if (d.status === 'pending' && !d.parsing) preparseDoc(d);
    });
  }

  async function preparseDoc(d) {
    if (d.parsing) return;
    d.parsing = true;
    try {
      if (d.type === 'pdf') {
        var pdfjs = window.pdfjsLib;
        if (!pdfjs) throw new Error('PDF 渲染库未加载');
        var data = await readDocBytes(d.path);
        var pdf = await pdfjs.getDocument({ data: toPdfData(data) }).promise;
        d.pages = pdf.numPages;
        pdf.cleanup();   /* pdf.js 6.x：destroy 已移除，改用 cleanup */
      } else {
        var buf = await readDocBytes(d.path);
        var text = '';
        if (d.type === 'txt') {
          text = decodeText(buf);
        } else {
          if (!window.mammoth) throw new Error('DOCX 解析库未加载');
          try {
            var r = await window.mammoth.convertToHtml({ arrayBuffer: buf });
            text = htmlToText(r.value);
          } catch (e) {
            throw new Error('旧版 .doc 需先转 PDF / DOCX');
          }
        }
        var lines = splitTextLines(getMeasureCtx(), text, docTextMaxW());
        d.pages = paginateRows(lines, docLinesPerPage(docPageMm())).length;
      }
      d.status = 'ready';
    } catch (e) {
      d.status = 'error';
      d.error = e.message;
    } finally {
      d.parsing = false;
    }
    renderDocList();
  }

  function moveDoc(i, dir) {
    var j = i + dir;
    if (j < 0 || j >= docs.length) return;
    var t = docs[i];
    docs[i] = docs[j];
    docs[j] = t;
    renderDocList();
  }

  function toggleDoc(i, on) {
    var d = docs[i];
    if (!d) return;
    d.checked = !!on;
    renderDocList();
  }

  function toggleAllDocs(on) {
    docs.forEach(function (d) { d.checked = !!on; });
    renderDocList();
  }

  function removeDoc(i) {
    docs.splice(i, 1);
    renderDocList();
  }

  function docCountText() {
    if (!docs.length) return '未选择';
    var ready = checkedOf(docs).filter(function (d) { return d.status === 'ready'; });
    var total = 0;
    ready.forEach(function (d) { total += d.pages || 0; });
    var txt = '已选 ' + docs.length + ' 个';
    if (ready.length) txt += ' · 就绪 ' + ready.length + ' 个 · 共 ' + total + ' 页';
    else txt += ' · 已勾选 0 个（不打印）';
    return txt;
  }

  function renderDocList() {
    var tbody = $('pd-table').querySelector('tbody');
    tbody.textContent = '';
    $('pd-list').hidden = !docs.length;
    $('pd-empty').hidden = !!docs.length;
    docs.forEach(function (d, i) {
      var tr = document.createElement('tr');
      if (d.checked === false) tr.className = 'row-unchecked';

      var tdC = document.createElement('td');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = d.checked !== false;
      box.title = '勾选后参与打印';
      box.addEventListener('change', function () { toggleDoc(i, box.checked); });
      tdC.appendChild(box);

      var td0 = document.createElement('td');
      td0.textContent = String(i + 1);

      var td1 = document.createElement('td');
      td1.textContent = d.name;
      td1.title = d.path;

      var td2 = document.createElement('td');
      td2.className = 'st-dim';
      td2.textContent = d.type.toUpperCase();

      var td3 = document.createElement('td');
      td3.className = 'st-dim';
      if (d.status === 'ready') td3.textContent = d.pages + ' 页';
      else if (d.status === 'pending') td3.textContent = '解析中…';
      else {
        td3.textContent = '失败';
        td3.title = d.error || '';
        td3.classList.add('st-bad');
      }

      var td4 = document.createElement('td');
      td4.className = 'pd-ops';
      // 控件标识用内联 SVG 图标（App.ui.icon），不用排版符号文本
      var up = document.createElement('button');
      up.className = 'ghost pd-op';
      up.title = '上移';
      up.setAttribute('aria-label', '上移');
      up.appendChild(window.App.ui.icon('up'));
      up.disabled = i === 0;
      up.addEventListener('click', function () { moveDoc(i, -1); });
      var down = document.createElement('button');
      down.className = 'ghost pd-op';
      down.title = '下移';
      down.setAttribute('aria-label', '下移');
      down.appendChild(window.App.ui.icon('down'));
      down.disabled = i === docs.length - 1;
      down.addEventListener('click', function () { moveDoc(i, 1); });
      var del = document.createElement('button');
      del.className = 'ghost pd-op pd-op-del';
      del.title = '移除';
      del.setAttribute('aria-label', '移除');
      del.appendChild(window.App.ui.icon('x'));
      del.addEventListener('click', function () { removeDoc(i); });
      td4.appendChild(up);
      td4.appendChild(down);
      td4.appendChild(del);

      tr.appendChild(tdC); tr.appendChild(td0); tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tr.appendChild(td4);
      tbody.appendChild(tr);
    });
    $('pd-count').textContent = docCountText();
    syncCheckAll('pd-check-all', docs);
    $('pd-run').disabled = !checkedOf(docs).some(function (d) { return d.status === 'ready'; })
      || printing || !bridgeOk();
  }

  /* 执行文档打印：queue=列队（每文档一个任务按序发送）/ merge=合并（全部页一个任务）。
     仅包含勾选的文档——列队打印时可单独取消其中的文档 */
  async function runDocs() {
    if (printing) return;
    if (!bridgeOk()) { toast('打印功能需要在桌面版中使用', true); return; }
    var ready = checkedOf(docs).filter(function (d) { return d.status === 'ready'; });
    if (!ready.length) { toast('还没有勾选就绪的文档', true); return; }

    var mode = $('pd-mode').value === 'merge' ? 'merge' : 'queue';
    var btn = $('pd-run');
    var status = $('pd-status');
    btn.disabled = true;
    setPrinting(true, 'doc');

    var params = printParams('pd-printer', 'pd-copies', 'pd-duplex');
    /* 文档打印固定 A4 竖向、无边距（PDF 版式完整保留在页内） */
    var base = Object.assign({ pageSize: 'A4', marginType: 'none' }, params);

    var sentPages = 0;
    var failMsg = '';
    var okTasks = 0;
    var totalTasks = mode === 'queue' ? ready.length : 1;

    try {
      if (mode === 'queue') {
        for (var i = 0; i < ready.length; i++) {   
          var d = ready[i];
          status.textContent = '正在打印（' + (i + 1) + '/' + ready.length + '）：' + d.name;
          var r = await renderDoc(d, function (pi, total) {    
            status.textContent = '正在渲染（' + (i + 1) + '/' + ready.length + '）：' + d.name + ' — ' + pi + '/' + total;
          });
          var res = await sendPrint(Object.assign({ dataUrls: r.dataUrls }, base));   
          if (res && res.ok) { okTasks++; sentPages += r.pages; }
          else if (!failMsg) failMsg = (res && res.error) || '未知错误';
        }
      } else {
        status.textContent = '正在渲染全部文档…';
        var all = [];
        for (var k = 0; k < ready.length; k++) {   
          var dd = ready[k];
          status.textContent = '正在渲染（' + (k + 1) + '/' + ready.length + '）：' + dd.name;
          var rr = await renderDoc(dd, function (pi, total) {   
            status.textContent = '正在渲染（' + (k + 1) + '/' + ready.length + '）：' + dd.name + ' — ' + pi + '/' + total;
          });
          all = all.concat(rr.dataUrls);
          sentPages += rr.pages;
        }
        status.textContent = '正在发送打印任务…（' + all.length + ' 页）';
        var res2 = await sendPrint(Object.assign({ dataUrls: all }, base));
        if (res2 && res2.ok) okTasks = 1;
        else failMsg = (res2 && res2.error) || '未知错误';
      }
    } catch (e) {
      failMsg = e.message;
    }

    setPrinting(false, 'doc');
    if (okTasks >= totalTasks && !failMsg) {
      window.App.ui.statusText(status, '已发送打印任务（' + sentPages + ' 页 × ' + params.copies + ' 份'
        + (mode === 'queue' ? ' · ' + totalTasks + ' 个任务）' : '）'), 'check');
      toast('已发送到打印机', false, 'check');
    } else if (okTasks > 0) {
      status.textContent = '部分完成：成功 ' + okTasks + '/' + totalTasks + ' 个任务；失败原因：' + failMsg;
      toast('部分文档打印失败', true);
    } else {
      status.textContent = '打印失败：' + (failMsg || '未知错误');
      toast('打印失败：' + (failMsg || '未知错误'), true);
    }
  }

  function clearDocs() {
    docs = [];
    renderDocList();
    $('pd-status').textContent = '';
  }

  /* ================= 面板与模式切换 ================= */

  /* showOnly 模式：仅显示指定面板（与批量/压缩工具一致）。
     面板归属：print-batch（批量工具·图片批量打印）| print-docs（文档打印）
     | docs-convert（文档转换）| docs-pdf（PDF 工具）| docs-watermark（文档加水印）
     | docs-ocr（OCR 文字识别）| null = 回各自子功能菜单 */
  function showOnly(panelId) {
    $('batch-menu').hidden = panelId === 'print-batch';
    $('print-menu').hidden = panelId === 'print-docs' || panelId === 'docs-convert' ||
      panelId === 'docs-pdf' || panelId === 'docs-watermark' || panelId === 'docs-ocr' ||
      panelId === 'docs-reader';
    $('print-batch').hidden = panelId !== 'print-batch';
    $('print-docs').hidden = panelId !== 'print-docs';
    $('pd-doc').hidden = panelId !== 'print-docs';
    $('docs-convert').hidden = panelId !== 'docs-convert';
    $('docs-pdf').hidden = panelId !== 'docs-pdf';
    $('docs-watermark').hidden = panelId !== 'docs-watermark';
    $('docs-ocr').hidden = panelId !== 'docs-ocr';
    $('docs-reader').hidden = panelId !== 'docs-reader';
  }

  function enter() { showOnly(null); }

  /* 打印机下拉填充（桌面版）；浏览器模式隐藏面板显示提示 */
  async function refreshPrinters() {
    var ok = bridgeOk();
    $('pb-unsupported').hidden = ok;
    $('pd-unsupported').hidden = ok;
    $('pb-pick').disabled = !ok;
    $('pd-pick').disabled = !ok;
    if (!ok) return;
    try {
      await window.App.print.fillPrinterSelect($('pb-printer'), $('pb-status'), $('pb-run'));
      await window.App.print.fillPrinterSelect($('pd-printer'), $('pd-status'), $('pd-run'));
    } catch (e) {
      $('pb-status').textContent = '读取打印机失败：' + e.message;
    }
  }

  function init() {
    $('pb-pick').addEventListener('click', pickImages);
    $('pb-clear').addEventListener('click', clearImages);
    $('pb-run').addEventListener('click', runImages);
    $('pb-copies').addEventListener('change', function () { this.value = clampCopies(this.value); });
    $('pd-pick').addEventListener('click', pickDocs);
    $('pd-clear').addEventListener('click', clearDocs);
    $('pd-run').addEventListener('click', runDocs);
    $('pd-copies').addEventListener('change', function () { this.value = clampCopies(this.value); });

    $('pb-check-all').addEventListener('change', function () { toggleAllImgs(this.checked); });
    $('pd-check-all').addEventListener('change', function () { toggleAllDocs(this.checked); });

    /* 批量打印面板在批量工具内：返回交给批量工具的菜单管理 */
    $('pb-back').addEventListener('click', function () { window.App.batch.showOnly(null); });
    $('pd-back').addEventListener('click', function () { showOnly(null); });
  }

  return {
    init: init,
    enter: enter,
    showOnly: showOnly,
    refreshPrinters: refreshPrinters,
    _test: {
      IMG_EXTS: IMG_EXTS,
      DOC_EXTS: DOC_EXTS,
      extOf: extOf,
      normalizeRot: normalizeRot,
      nextRot: nextRot,
      rotatedSize: rotatedSize,
      fitContain: fitContain,
      drawParams: drawParams,
      docTypeOf: docTypeOf,
      clampCopies: clampCopies,
      splitTextLines: splitTextLines,
      paginateRows: paginateRows,
      docLinesPerPage: docLinesPerPage,
      fmtSize: fmtSize,
      isChecked: isChecked,
      checkedOf: checkedOf,
      decodeText: decodeText,
      htmlToText: htmlToText
    }
  };
})();
