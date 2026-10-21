/* ============================================================
 * docs-ocr.js — 文档工具子功能：OCR 文字识别
 * 纯本地实现：内置 Tesseract LSTM 引擎（vendor/ocr，Apache-2.0），
 *  - 图片（JPG / PNG / WebP / BMP）与扫描 PDF 逐页识别，简体中文 + 英文；
 *  - 图像增强（App.ocrEnhance，js/ocr-enhance.js）：自动纠偏、低光照
 *    对比度拉伸、模糊锐化、Sauvola 自适应二值化压复杂背景、孤点去噪，
 *    可在面板关闭；
 *  - 小图自动放大、超大图限长边 2600px，兼顾准确率与速度/内存；
 *  - 识别结果支持两种模式：智能排版（词级 bbox 段落重建 + 表格网格
 *    还原 + 结构化字段提取）与纯文本（归一 + 数字上下文纠错）；
 *  - 引擎懒加载：首次识别才初始化 Worker，语言包切换时 reinitialize 复用内核；
 *  - 识别结果集中在文本框中可编辑，支持复制 / 导出 TXT / 导出 DOCX；
 *  - DOCX 为最小 OOXML 包（[Content_Types].xml + _rels/.rels + word/document.xml），
 *    经 window.ZipUtil.store 打包，零额外依赖；
 *  - 全程离线，不发送任何数据。
 * 依赖：window.Tesseract（vendor/ocr/tesseract.min.js）、App.ocrEnhance、
 *       App.pdfcore（PDF 渲染）、window.ZipUtil（ZIP 打包）、App.ui.download。
 * ============================================================ */
(function (App) {
  'use strict';

  var $ = App.ui.$;
  var core = App.pdfcore;
  var PDF_RE = /\.pdf$/i;
  var IMG_RE = /\.(jpe?g|png|webp|bmp)$/i;
  var LANGS = { both: ['chi_sim', 'eng'], zh: ['chi_sim'], en: ['eng'] };
  // recognize 输出声明：text + blocks（blocks 携带词级 bbox / 置信度，供版面还原）
  var OUT_OPTS = { text: true, blocks: true };
  var SCALE_MAX = 2600;    // 长边上限：更大的图对准确率无益且耗时耗内存
  var SCALE_UP_MIN = 1000; // 长边低于此值视为小图，放大提升识别率

  var items = [];        // [{file, isPdf}]
  var worker = null;     // Tesseract Worker（懒加载）
  var workerLang = '';   // 当前 worker 已加载的语言包
  var curLabel = '';     // 当前识别项标签（进度显示用）
  var running = false;
  var lastUnits = null;    // 最近一次识别的单元（含结构化 doc，供 DOCX 导出）
  var lastFullText = null; // 最近一次识别写入文本框的原文（判断是否被用户编辑）

  function toast(msg, isErr) { App.ui.toast(msg, isErr); }

  /* ================= 图像预处理（缩放 + 增强） ================= */

  // 计算绘制缩放：小图放大（≥2 倍）、超大图压缩到长边上限
  function calcScale(w, h) {
    var long = Math.max(w, h);
    if (long < SCALE_UP_MIN) return Math.min(3, Math.max(2, SCALE_UP_MIN / long));
    if (long > SCALE_MAX) return SCALE_MAX / long;
    return 1;
  }

  // 文件 → 缩放后的 canvas（createImageBitmap 解码，用完即关）
  async function fileToCanvas(file) {
    var bmp = await createImageBitmap(file);
    try {
      var s = calcScale(bmp.width, bmp.height);
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * s));
      c.height = Math.max(1, Math.round(bmp.height * s));
      var ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      return c;
    } finally {
      if (typeof bmp.close === 'function') bmp.close();
    }
  }

  // 就地增强 canvas 像素（纠偏 / 拉伸 / 锐化 / 二值化 / 去噪），返回 info
  function enhanceCanvas(c) {
    var ctx = c.getContext('2d');
    var img = ctx.getImageData(0, 0, c.width, c.height);
    var r = App.ocrEnhance.enhance(img);
    ctx.putImageData(r.px, 0, 0);
    return r.info;
  }

  // 从识别结果构建输出文本：智能排版（blocks → 结构化文档模型）或纯文本
  function buildResult(res, mode) {
    var data = (res && res.data) || {};
    var conf = (typeof data.confidence === 'number') ? data.confidence : null;
    var enh = App.ocrEnhance;
    if (mode !== 'plain' && enh && data.blocks && data.blocks.length) {
      try {
        var b = enh.buildFromBlocks(data);
        if (b && b.text) {
          return {
            text: b.text,
            conf: (typeof b.conf === 'number') ? b.conf : conf,
            hasTable: !!b.hasTable,
            doc: b.doc || null
          };
        }
      } catch (e) {
        console.warn('[zunhong] 版面还原失败，回退纯文本:', e);
      }
    }
    return {
      text: enh ? enh.polishText(data.text || '') : cleanText(data.text || ''),
      conf: conf,
      hasTable: false,
      doc: null
    };
  }

  // 结构化字段摘要（证件号 / 手机号 / 日期），附加到 meta 行
  function fieldsSummary(text) {
    if (!App.ocrEnhance || !text) return '';
    var f;
    try { f = App.ocrEnhance.extractFields(text); } catch (e) { return ''; }
    var parts = [];
    if (f.idCards.length) {
      var fixed = f.idCards.filter(function (x) { return x.fixed; }).length;
      parts.push('证件号 ' + f.idCards.length + (fixed ? '（校验位纠错 ' + fixed + ' 个）' : ''));
    }
    if (f.phones.length) parts.push('手机号 ' + f.phones.length);
    if (f.dates.length) parts.push('日期 ' + f.dates.length);
    return parts.length ? '检测到：' + parts.join('、') : '';
  }

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

  // word/document.xml：逐行成段（A4 纵向），空行输出空段落保留排版（纯文本路径）
  function buildDocxXml(text) {
    return buildDocxXmlFromUnits([{ label: '', text: String(text || '') }]);
  }

  // 段落 XML：indent=1 输出首行缩进（2 字符 ≈ 480 twips），jc 非左对齐时输出对齐
  function paraXml(text, indent, jc) {
    var pPr = '';
    if (indent) pPr += '<w:ind w:firstLine="480"/>';
    if (jc && jc !== 'left') pPr += '<w:jc w:val="' + jc + '"/>';
    return '<w:p>' + (pPr ? '<w:pPr>' + pPr + '</w:pPr>' : '') +
      '<w:r><w:t xml:space="preserve">' + escXml(text) + '</w:t></w:r></w:p>';
  }

  // 表格 XML：真 w:tbl（tblGrid 列宽按相对宽度比例分配、单元格按列对齐、全边框）。
  // totalDxa 为版心总宽（A4 11906 − 左右页边距 2×1440 = 9026 twips）
  function tableXml(tb, totalDxa) {
    var cols = (tb.rows && tb.rows[0] && tb.rows[0].length) || 0;
    if (!cols) return paraXml('');
    var rel = (tb.widths && tb.widths.length === cols) ? tb.widths : tb.rows[0].map(function () { return 1; });
    var sum = rel.reduce(function (a, b) { return a + b; }, 0) || 1;
    var dxa = rel.map(function (w) { return Math.max(400, Math.round(w / sum * totalDxa)); });
    var grid = '<w:tblGrid>' + dxa.map(function (w) {
      return '<w:gridCol w:w="' + w + '"/>';
    }).join('') + '</w:tblGrid>';
    var borders = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (s) {
      return '<w:' + s + ' w:val="single" w:sz="4" w:space="0" w:color="auto"/>';
    }).join('') + '</w:tblBorders>';
    var trs = tb.rows.map(function (row) {
      return '<w:tr>' + row.map(function (cell, ci) {
        return '<w:tc><w:tcPr><w:tcW w:w="' + dxa[ci] + '" w:type="dxa"/></w:tcPr>' +
          paraXml(String(cell == null ? '' : cell), 0, (tb.aligns || [])[ci]) + '</w:tc>';
      }).join('') + '</w:tr>';
    }).join('');
    return '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>' + borders + '</w:tblPr>' +
      grid + trs + '</w:tbl>';
  }

  // 识别单元 → document.xml 正文：结构化块（段落缩进 + 真表格）优先，
  // 无结构时逐行成段（与旧行为一致）
  function buildDocxXmlFromUnits(units) {
    var list = units || [];
    var multi = list.length > 1;
    var body = '';
    list.forEach(function (u, idx) {
      if (idx > 0) body += paraXml('');
      if (multi) body += paraXml('===== ' + (u.label || '') + ' =====');
      var doc = u.doc;
      if (doc && doc.blocks && doc.blocks.length) {
        doc.blocks.forEach(function (b) {
          if (b.type === 'table') body += tableXml(b, 9026);
          else body += paraXml(b.text, b.indent);
        });
      } else {
        String(u.text || '').split('\n').forEach(function (l) { body += paraXml(l); });
      }
    });
    // OOXML 要求表格为 body 最后一个块级元素时其后必须有段落
    if (/<\/w:tbl>$/.test(body)) body += paraXml('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' + body +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>' +
      '</w:body></w:document>';
  }

  // 最小 OOXML 三件套 → ZipUtil.store 入参（name + Uint8Array）。
  // 入参为字符串时走纯文本路径；为数组时走结构化路径（[{label, text, doc}]）
  function buildDocxFiles(input) {
    var enc = new TextEncoder();
    var xml = (typeof input === 'string')
      ? buildDocxXml(input)
      : buildDocxXmlFromUnits(input);
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
      { name: 'word/document.xml', data: enc.encode(xml) }
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
    var base = '';
    if (text) {
      base = text.length + ' 字符 · ' + text.split('\n').length + ' 行（可编辑）';
      var fs = fieldsSummary(text);
      if (fs) base += ' · ' + fs;
    }
    $('do-meta').textContent = base;
    $('do-empty-hint').hidden = !!text;
  }

  // Excel 导出仅在本次识别到结构化表格时可用（hasTable）
  function exportsEnable(on, hasTable) {
    ['do-copy', 'do-txt', 'do-docx'].forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = !on;
    });
    var xl = $('do-xlsx');
    if (xl) xl.disabled = !(on && hasTable);
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
    var mode = $('do-mode') ? $('do-mode').value : 'auto';
    var enhanceOn = !$('do-enhance') || $('do-enhance').checked;
    var canEnhance = enhanceOn && App.ocrEnhance && typeof App.ocrEnhance.enhance === 'function';
    var units = [];
    var okN = 0, errN = 0;
    var enhFlags = { deskew: false, lowLight: false, sharpen: false };
    try {
      if (!worker) setStatus('正在加载识别内核（约 12 MB，仅首次较慢，全程本机）…');
      var wk = await ensureWorker(langKey);
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        try {
          if (it.isPdf) {
            var pdf = await core.loadPdf(it.file);
            try {
              for (var p = 1; p <= pdf.numPages; p++) {
                curLabel = '识别 ' + it.file.name + ' 第 ' + p + '/' + pdf.numPages + ' 页：';
                setStatus(curLabel + '0%');
                var canvas = await core.renderPage(pdf, p, 2, 2000);
                if (canEnhance) noteEnh(enhFlags, tryEnhance(canvas));
                var res = await wk.recognize(canvas, {}, OUT_OPTS);
                pushUnit(units, buildResult(res, mode), it.file.name + ' 第' + p + '页');
                okN++;
              }
            } finally {
              if (pdf) pdf.cleanup();
            }
          } else {
            curLabel = '识别 ' + it.file.name + '：';
            setStatus(curLabel + '0%');
            var imgCanvas = await fileToCanvas(it.file);
            if (canEnhance) noteEnh(enhFlags, tryEnhance(imgCanvas));
            var res2 = await wk.recognize(imgCanvas, {}, OUT_OPTS);
            pushUnit(units, buildResult(res2, mode), it.file.name);
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
    /* 收尾全部包在 try 内、finally 复位：此前 joinUnits/updateMeta/exportsEnable
     * 若抛错会跳过 disabled=false 复位，按钮永久锁死、running 永 true */
    try {
      curLabel = '';
      if (units.length) {
        lastUnits = units;
        lastFullText = joinUnits(units);
        $('do-text').value = lastFullText;
        updateMeta();
        exportsEnable(true, anyTableFlag(units));
        setStatus('识别完成：成功 ' + okN + ' 项' + (errN ? '，失败 ' + errN + ' 项' : '') +
          (anyTableFlag(units) ? '，含表格还原' : '') + enhNoteText(enhFlags) +
          '，结果可在右侧编辑后复制或导出。');
      } else {
        setStatus('');
      }
    } finally {
      $('do-run').disabled = false;
      running = false;
    }
  }

  // 逐项识别结果登记：保留表格标记与结构化文档模型，文本缺省给空串
  function pushUnit(units, built, label) {
    units.push({ label: label, text: built.text || '', hasTable: !!built.hasTable, doc: built.doc || null });
  }

  // 增强失败不阻断识别：回退原图
  function tryEnhance(canvas) {
    try { return enhanceCanvas(canvas); } catch (e) {
      console.warn('[zunhong] 图像增强失败，使用原图识别:', e);
      return null;
    }
  }

  function noteEnh(flags, info) {
    if (!info) return;
    if (info.deskewed) flags.deskew = true;
    if (info.lowLight) flags.lowLight = true;
    if (info.sharpened) flags.sharpen = true;
  }

  function enhNoteText(flags) {
    var notes = [];
    if (flags.deskew) notes.push('纠偏');
    if (flags.lowLight) notes.push('低光照优化');
    if (flags.sharpen) notes.push('锐化');
    return notes.length ? '（图像增强：' + notes.join(' / ') + '）' : '';
  }

  function anyTableFlag(units) {
    return units.some(function (u) { return u.hasTable; });
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
      // 结构化导出条件：本次识别产出过结构化模型且文本框未被编辑
      // （编辑后导出以用户文本为准，回退纯文本段落）
      var structured = lastUnits && lastFullText != null && text === lastFullText &&
        lastUnits.some(function (u) { return u.doc && u.doc.blocks && u.doc.blocks.length; });
      var blob = window.ZipUtil.store(buildDocxFiles(structured ? lastUnits : text));
      App.ui.download(blob, exportBaseName(itemNames()) + '.docx');
    } catch (e) {
      toast('导出 DOCX 失败：' + ((e && e.message) || e), true);
    }
  }

  // 表格结构化导出为 Excel：每张识别到的表格一个工作表（保留行列、数值类型与列对齐）
  function exportXlsx() {
    if (!lastUnits) { toast('请先识别含表格的图片或 PDF'); return; }
    var xl = App.xlsxLite;
    if (!xl || typeof xl.buildXlsxFromUnits !== 'function') {
      toast('Excel 导出组件未加载，请刷新页面后重试', true);
      return;
    }
    if (!window.ZipUtil || typeof window.ZipUtil.store !== 'function') {
      toast('ZIP 打包组件未就绪，无法导出 Excel', true);
      return;
    }
    try {
      var built = xl.buildXlsxFromUnits(lastUnits);
      if (!built || !built.files) {
        toast('本次识别未检测到表格，无法导出 Excel（可导出 TXT / DOCX）', true);
        return;
      }
      var blob = window.ZipUtil.store(built.files);
      App.ui.download(blob, exportBaseName(itemNames()) + '.xlsx');
      var edited = lastFullText != null && $('do-text').value !== lastFullText;
      toast('已导出 ' + built.stats.sheets + ' 个工作表（' + built.stats.rows + ' 行 / ' +
        built.stats.cells + ' 个单元格）' + (edited ? '，按识别到的原始表格结构导出' : ''));
    } catch (e) {
      toast('导出 Excel 失败：' + ((e && e.message) || e), true);
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
      buildDocxFiles: buildDocxFiles,
      paraXml: paraXml,
      tableXml: tableXml,
      buildDocxXmlFromUnits: buildDocxXmlFromUnits,
      /* 主链路冒烟钩子（verify-ocr.cjs 用）：真实创建/复用 worker、识别、清理文本。
       * 纯函数断言覆盖不到「worker 初始化 → 语言包加载 → recognize → 回调」链路，
       * 该钩子让整条链可在真实浏览器里跑断言。
       * opts.enhance = true 时走图像增强管线（缩放 → 纠偏/二值化）。 */
      ocrRef: async function (file, langKey, opts) {
        var wk = await ensureWorker(langKey || 'en');
        var input = file;
        if (opts && opts.enhance && App.ocrEnhance) {
          var canvas = await fileToCanvas(file);
          try { enhanceCanvas(canvas); } catch (e) { /* 增强失败用原图 */ }
          input = canvas;
        }
        var res = await wk.recognize(input, {}, OUT_OPTS);
        return {
          text: cleanText(res && res.data && res.data.text),
          conf: (res && res.data && typeof res.data.confidence === 'number') ? res.data.confidence : 0
        };
      }
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
    if ($('do-xlsx')) $('do-xlsx').addEventListener('click', exportXlsx);
    $('do-text').addEventListener('input', updateMeta);
  };
})(window.App);
