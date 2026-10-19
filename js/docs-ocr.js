/* ============================================================
 * docs-ocr.js — 文档工具子功能：OCR 文字识别
 * 纯本地实现：内置 Tesseract LSTM 引擎（vendor/ocr，Apache-2.0），
 *  - 图片（JPG / PNG / WebP / BMP）与扫描 PDF 逐页识别，简体中文 + 英文；
 *  - 引擎懒加载：首次识别才初始化 Worker，语言包切换时 reinitialize 复用内核；
 *  - 识别结果集中在文本框中可编辑，支持复制 / 导出 TXT / 导出 DOCX；
 *  - DOCX 为最小 OOXML 包（[Content_Types].xml + _rels/.rels + word/document.xml），
 *    经 window.ZipUtil.store 打包，零额外依赖；
 *  - 全程离线，不发送任何数据。
 * 依赖：window.Tesseract（vendor/ocr/tesseract.min.js）、App.pdfcore（PDF 渲染）、
 *       window.ZipUtil（ZIP 打包）、App.ui.download。
 * ============================================================ */
(function (App) {
  'use strict';

  var $ = App.ui.$;
  var core = App.pdfcore;
  var PDF_RE = /\.pdf$/i;
  var IMG_RE = /\.(jpe?g|png|webp|bmp)$/i;
  var LANGS = { both: ['chi_sim', 'eng'], zh: ['chi_sim'], en: ['eng'] };

  var items = [];        // [{file, isPdf}]
  var worker = null;     // Tesseract Worker（懒加载）
  var workerLang = '';   // 当前 worker 已加载的语言包
  var curLabel = '';     // 当前识别项标签（进度显示用）
  var running = false;

  function toast(msg, isErr) { App.ui.toast(msg, isErr); }

  /* ================= 纯逻辑（可单测） ================= */

  // 识别文本清理：统一换行、去行尾空白、压缩连续空行、整体验trim
  function cleanText(raw) {
    return String(raw || '')
      .replace(/\r\n?/g, '\n')
      .split('\n').map(function (l) { return l.replace(/[ \t\u00a0]+$/g, ''); }).join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // 多项结果拼接：单项直接输出；多项加「===== 名称 =====」分隔头；空结果给占位说明
  function joinUnits(units) {
    var list = (units || []).map(function (u) {
      return { label: String(u.label || ''), text: cleanText(u.text) };
    });
    var multi = list.length > 1;
    return list.map(function (u) {
      var t = u.text || '（未识别到文字）';
      return multi ? '===== ' + u.label + ' =====\n' + t : t;
    }).join('\n\n');
  }

  // 导出文件基础名：单文件 → 「原名-识别」，多文件 / 无文件 → 「识别结果」
  function exportBaseName(files) {
    var names = (files || []).map(function (f) { return String(f && f.name) || ''; })
      .filter(function (s) { return s; });
    if (names.length === 1) return names[0].replace(/\.[^.]+$/, '') + '-识别';
    return '识别结果';
  }

  // XML 文本转义（DOCX 段落内容用）
  function escXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // word/document.xml：逐行成段（A4 纵向），空行输出空段落保留排版
  function buildDocxXml(text) {
    var paras = String(text || '').split('\n').map(function (l) {
      return '<w:p><w:r><w:t xml:space="preserve">' + escXml(l) + '</w:t></w:r></w:p>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' + paras +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>' +
      '</w:body></w:document>';
  }

  // 最小 OOXML 三件套 → ZipUtil.store 入参（name + Uint8Array）
  function buildDocxFiles(text) {
    var enc = new TextEncoder();
    return [
      { name: '[Content_Types].xml', data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>') },
      { name: '_rels/.rels', data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>') },
      { name: 'word/document.xml', data: enc.encode(buildDocxXml(text)) }
    ];
  }

  /* ================= 引擎管理（懒加载） ================= */

  // tesseract.js 在 blob: Worker 内 importScripts / fetch，相对路径无法解析，须转为绝对 URL
  function absUrl(p) {
    try { return new URL(p, window.location.href).href; }
    catch (e) { return p; }
  }

  // Worker 进度回调：仅识别阶段按百分比刷新状态行（其余加载态保持中文提示）
  function onLog(m) {
    if (m && m.status === 'recognizing text' && typeof m.progress === 'number') {
      $('do-status').textContent = curLabel + Math.round(m.progress * 100) + '%';
    }
  }

  // 获取（或切换语言后重建）Worker；内核仅首次加载，切语言走 reinitialize
  async function ensureWorker(langKey) {
    if (worker && workerLang === langKey) return worker;
    if (!worker) {
      worker = await window.Tesseract.createWorker(LANGS[langKey], 1, {
        workerPath: absUrl('vendor/ocr/worker.min.js'),
        corePath: absUrl('vendor/ocr') + '/',
        langPath: absUrl('vendor/ocr/lang') + '/',
        logger: onLog
      });
    } else {
      try {
        await worker.reinitialize(LANGS[langKey]);
      } catch (e) {
        await worker.terminate().catch(function () { /* 忽略 */ });
        worker = null;
        return ensureWorker(langKey);
      }
    }
    workerLang = langKey;
    return worker;
  }

  /* ================= UI 状态 ================= */

  function setStatus(msg) { $('do-status').textContent = msg || ''; }

  function itemNames() {
    return items.map(function (it) { return it.file.name; });
  }

  function renderCount() {
    var n = items.length;
    var pdfN = items.filter(function (it) { return it.isPdf; }).length;
    $('do-count').textContent = n ? '已选 ' + n + ' 个文件' + (pdfN ? '（含 PDF ' + pdfN + '）' : '') : '';
    $('do-empty').hidden = n > 0;
    $('do-clear').hidden = n === 0;
  }

  function updateMeta() {
    var text = $('do-text').value;
    $('do-meta').textContent = text
      ? text.length + ' 字符 · ' + text.split('\n').length + ' 行（可编辑）'
      : '';
    $('do-empty-hint').hidden = !!text;
  }

  function exportsEnable(on) {
    ['do-copy', 'do-txt', 'do-docx'].forEach(function (id) { $(id).disabled = !on; });
  }

  /* ================= 主流程 ================= */

  function pickFiles() {
    var input = $('do-file');
    input.value = '';
    input.click();
  }

  function onFilesPicked() {
    var files = Array.prototype.slice.call($('do-file').files || []);
    if (!files.length) return;
    var skipped = 0;
    files.forEach(function (f) {
      if (PDF_RE.test(f.name)) items.push({ file: f, isPdf: true });
      else if (IMG_RE.test(f.name)) items.push({ file: f, isPdf: false });
      else skipped++;
    });
    if (skipped) toast('已跳过 ' + skipped + ' 个不支持的文件（仅支持 JPG / PNG / WebP / BMP / PDF）');
    renderCount();
  }

  function clearFiles() {
    items = [];
    renderCount();
    setStatus('');
  }

  async function run() {
    if (running) return;
    if (!items.length) { toast('请先选择要识别的图片或 PDF'); return; }
    if (!window.Tesseract || typeof window.Tesseract.createWorker !== 'function') {
      toast('OCR 引擎未加载，请刷新页面后重试', true);
      return;
    }
    running = true;
    $('do-run').disabled = true;
    var langKey = $('do-lang').value;
    var units = [];
    var okN = 0, errN = 0;
    try {
      if (!worker) setStatus('正在加载识别内核（约 12 MB，仅首次较慢，全程本机）…');
      var wk = await ensureWorker(langKey);
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        try {
          if (it.isPdf) {
            var pdf = await core.loadPdf(it.file);
            for (var p = 1; p <= pdf.numPages; p++) {
              curLabel = '识别 ' + it.file.name + ' 第 ' + p + '/' + pdf.numPages + ' 页：';
              setStatus(curLabel + '0%');
              var canvas = await core.renderPage(pdf, p, 2, 2000);
              var res = await wk.recognize(canvas);
              units.push({ label: it.file.name + ' 第' + p + '页', text: res && res.data && res.data.text });
              okN++;
            }
          } else {
            curLabel = '识别 ' + it.file.name + '：';
            setStatus(curLabel + '0%');
            var res2 = await wk.recognize(it.file);
            units.push({ label: it.file.name, text: res2 && res2.data && res2.data.text });
            okN++;
          }
        } catch (e) {
          errN++;
          console.error('[zunhong] OCR 识别失败:', it.file.name, e);
          toast('识别 ' + it.file.name + ' 失败：' + ((e && e.message) || e), true);
        }
      }
    } catch (e) {
      errN++;
      console.error('[zunhong] OCR 引擎初始化失败:', e);
      toast('识别引擎初始化失败：' + ((e && e.message) || e), true);
    }
    curLabel = '';
    if (units.length) {
      $('do-text').value = joinUnits(units);
      updateMeta();
      exportsEnable(true);
      setStatus('识别完成：成功 ' + okN + ' 项' + (errN ? '，失败 ' + errN + ' 项' : '') +
        '，结果可在右侧编辑后复制或导出。');
    } else {
      setStatus('');
    }
    $('do-run').disabled = false;
    running = false;
  }

  async function copyText() {
    var text = $('do-text').value;
    if (!text.trim()) { toast('暂无可复制的识别文本'); return; }
    var ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      try {
        var ta = $('do-text');
        ta.focus();
        ta.select();
        ok = document.execCommand('copy');
      } catch (e2) { ok = false; }
    }
    toast(ok ? '已复制到剪贴板' : '复制失败，请手动选中文本后 Ctrl+C', !ok);
  }

  function exportTxt() {
    var text = $('do-text').value;
    if (!text.trim()) { toast('暂无可导出的识别文本'); return; }
    App.ui.download(new Blob([text], { type: 'text/plain;charset=utf-8' }),
      exportBaseName(itemNames()) + '.txt');
  }

  function exportDocx() {
    var text = $('do-text').value;
    if (!text.trim()) { toast('暂无可导出的识别文本'); return; }
    if (!window.ZipUtil || typeof window.ZipUtil.store !== 'function') {
      toast('ZIP 打包组件未就绪，无法导出 DOCX', true);
      return;
    }
    try {
      var blob = window.ZipUtil.store(buildDocxFiles(text));
      App.ui.download(blob, exportBaseName(itemNames()) + '.docx');
    } catch (e) {
      toast('导出 DOCX 失败：' + ((e && e.message) || e), true);
    }
  }

  /* 每次进入面板：只复位状态行与计数，保留已选文件与识别结果 */
  function enter() {
    setStatus('');
    renderCount();
    updateMeta();
  }

  App.docsOcr = {
    enter: enter,
    _test: {
      cleanText: cleanText,
      joinUnits: joinUnits,
      exportBaseName: exportBaseName,
      escXml: escXml,
      buildDocxXml: buildDocxXml,
      buildDocxFiles: buildDocxFiles
    }
  };

  App.docsOcr.init = function () {
    $('do-pick').addEventListener('click', pickFiles);
    $('do-file').addEventListener('change', onFilesPicked);
    $('do-clear').addEventListener('click', clearFiles);
    $('do-run').addEventListener('click', run);
    $('do-copy').addEventListener('click', copyText);
    $('do-txt').addEventListener('click', exportTxt);
    $('do-docx').addEventListener('click', exportDocx);
    $('do-text').addEventListener('input', updateMeta);
  };
})(window.App);
