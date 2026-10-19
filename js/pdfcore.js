/* ============================================================
 * pdfcore.js — 文档工具共享 PDF 核心（文档转换 / PDF 工具 / 文档加水印共用）
 * 纯本地：pdf.js 渲染、canvas 编码、FSA 目录写入、页码范围解析。
 * PDF 重建统一走 App.batchFormat.buildPdf（纯 JS 生成器，DCTDecode 嵌 JPEG）。
 * ============================================================ */
(function (App) {
  'use strict';

  /* ---------- 页码范围解析（纯逻辑，可单测） ----------
   * "1-3,5,8-" → [1,2,3,5,8..max]；1 基；支持中英文逗号/分号/空白/–/~；
   * 开口端补齐到 max；越界钳制；空/非法段忽略；去重升序。 */
  function parsePageRanges(str, max) {
    max = Math.max(0, Math.round(+max || 0));
    var out = [];
    String(str || '').split(/[，,;；\s]+/).forEach(function (seg) {
      if (!seg) return;
      if (/^\d+$/.test(seg)) { // 裸页码
        var v = parseInt(seg, 10);
        if (v >= 1 && v <= max) out.push(v);
        return;
      }
      var m = seg.match(/^(\d+)?\s*[-–~]\s*(\d+)?$/);
      if (!m) return;
      var a = m[1] ? parseInt(m[1], 10) : 1;
      var b = m[2] ? parseInt(m[2], 10) : max;
      if (!isFinite(a) || !isFinite(b)) return;
      if (a < 1) a = 1;
      if (b > max) b = max;
      if (a > b) return;
      for (var i = a; i <= b; i++) out.push(i);
    });
    return out.filter(function (v, i, arr) { return arr.indexOf(v) === i; })
      .sort(function (x, y) { return x - y; });
  }

  /* ---------- pdf.js 加载与渲染 ---------- */

  // 加载 PDF 文档（每次从 File 重新取 ArrayBuffer，避免 pdf.js 转移缓冲后失效）
  async function loadPdf(file) {
    var buf = await file.arrayBuffer();
    return window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  }

  // 渲染单页到新 canvas：scale 相对 72dpi 基准；fitLong（像素）可限制长边并作为上限
  async function renderPage(pdf, num, scale, fitLong) {
    var page = await pdf.getPage(num);
    var base = page.getViewport({ scale: 1 });
    var s = scale;
    if (fitLong) s = Math.min(s, fitLong / Math.max(base.width, base.height));
    s = Math.max(0.2, Math.min(4, s));
    var vp = page.getViewport({ scale: s });
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // PDF 透明底先铺白
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return canvas;
  }

  /* ---------- 编码与输出 ---------- */

  // canvas → Blob（type: image/jpeg | image/png；quality 仅对有损格式生效）
  function encodeCanvas(canvas, type, quality) {
    return new Promise(function (res) { canvas.toBlob(res, type, quality); });
  }

  // 在所选目录下获取（必要时创建）子目录
  async function ensureSubDir(dirHandle, name) {
    return dirHandle.getDirectoryHandle(name, { create: true });
  }

  // 写入单个文件（覆盖同名），data: Blob | Uint8Array
  async function writeBytes(dirHandle, name, data) {
    var fh = await dirHandle.getFileHandle(name, { create: true });
    var w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }

  /* 输出防静默覆盖：目标目录已存在同名文件时追加 _1…_99 后缀
   * （archive.js bumpOutName 的 FSA 版）。不同文件夹多选同名文件时，
   * 后写会静默覆盖先写——探测+序号让每个文件都落盘。批次内同样有效：
   * 写一个落一个盘，后续探测即可见。 */
  async function uniqueOutName(dirHandle, name) {
    var n = String(name || '');
    if (!n) return n;
    var exists = function (nm) {
      return dirHandle.getFileHandle(nm, { create: false }).then(function () { return true; }, function () { return false; });
    };
    if (!(await exists(n))) return n;
    var m = /^(.*)(\.[^.]*)$/.exec(n);
    var base = m ? m[1] : n, ext = m ? m[2] : '';
    for (var i = 1; i <= 99; i++) {
      var cand = base + '_' + i + ext;
      if (!(await exists(cand))) return cand;
    }
    return base + '_' + Date.now() + ext;
  }

  // 统一输出目录选择：环境不支持或用户取消 → null（调用方负责提示）
  async function pickOutputDir() {
    if (typeof window.showDirectoryPicker !== 'function') return null;
    try { return await window.showDirectoryPicker({ mode: 'readwrite' }); }
    catch (e) { return null; }
  }

  App.pdfcore = {
    parsePageRanges: parsePageRanges,
    loadPdf: loadPdf,
    renderPage: renderPage,
    encodeCanvas: encodeCanvas,
    ensureSubDir: ensureSubDir,
    writeBytes: writeBytes,
    uniqueOutName: uniqueOutName,
    pickOutputDir: pickOutputDir
  };
})(window.App);
