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
  var task = null;       // 本次识别的取消令牌（App.task）
  var lastUnits = null;    // 最近一次识别的单元（含结构化 doc，供 DOCX 导出）
  var lastFullText = null; // 最近一次识别写入文本框的原文（判断是否被用户编辑）
  var orient = 'p';        // 结果区页面方向：p 竖向 / l 横向（同时决定 DOCX 页面方向）

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

  // 就地增强 canvas 像素（增强档位见 App.ocrEnhance.enhance 的 mode），返回 info
  function enhanceCanvas(c, mode) {
    var ctx = c.getContext('2d');
    var img = ctx.getImageData(0, 0, c.width, c.height);
    var r = App.ocrEnhance.enhance(img, { mode: mode || 'full' });
    // 纠偏会改变高度：尺寸变化时必须同步调整画布，否则底部内容被裁掉
    if (c.width !== r.px.width || c.height !== r.px.height) {
      c.width = r.px.width;
      c.height = r.px.height;
      ctx = c.getContext('2d');
    }
    // 必须包装为 ImageData：putImageData 拒绝普通 {data,width,height} 对象
    // （此前直接传对象会抛 TypeError，被上层 catch 静默回退原图，导致增强从未生效）
    ctx.putImageData(new ImageData(r.px.data, r.px.width, r.px.height), 0, 0);
    return r.info;
  }

  /* ================= 多通道识别（精度优先，带预算上限） ================= */

  var MULTI = {
    lowConf: 60,     // 行均置信度低于此值（严重劣化）→ 换版式通道重识别
    pixelConf: 55,   // 低于此值才无条件启用灰度变体（避免清晰件白跑一遍）
    minLinePx: 22,   // 行高中位数低于此值视为低分辨率 → 放大 2x 重识别
    cellConf: 70,    // 单元格置信度低于此值 → 单元格裁剪重识别
    maxCells: 60,    // 单元格重识别次数上限（耗时保护）
    // 基座通道：tesseract.js worker 的默认 tessedit_pageseg_mode 是 SINGLE_BLOCK(6)，
    // 显式写 6 才能既复现 v1.4.1 行为、又不受上一次调用残留参数影响
    psmBase: 6,
    psmAuto: 3,      // AUTO：多栏 / 版式复杂、基座漏行时尝试
    psmSparse: 11,   // 稀疏文字（海报 / 截图标注）
    gain: 1.05       // 备选通道需超过当前评分 5% 才采纳（避免抖动式换通道）
  };

  // 识别参数：仅指定分页模式。
  // 注意：不要开启 preserve_interword_spaces——它改变分词粒度（把列间空格并入词），
  // 会破坏基于词级 bbox 的列聚类，实测导致表格列丢失（见 docs/ocr-accuracy-optimization.md）。
  function psmParams(psm) {
    return { tessedit_pageseg_mode: String(psm) };
  }

  function scaleCanvas(src, factor) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * factor));
    c.height = Math.max(1, Math.round(src.height * factor));
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  // 复制画布（增强会就地改写像素，变体必须各自持有副本）
  function cloneCanvas(src) {
    var c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  // 平均亮度（降采样估算，判暗底/反色底）
  function meanBrightness(canvas) {
    var s = Math.max(1, Math.round(160 / Math.max(canvas.width, canvas.height) * 100) / 100);
    var small = scaleCanvas(canvas, Math.min(1, s));
    var d = small.getContext('2d').getImageData(0, 0, small.width, small.height).data;
    var sum = 0, n = 0;
    for (var i = 0; i < d.length; i += 4) { sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; n++; }
    return n ? sum / n : 255;
  }

  // 页面统计：字符数、行数、字符加权平均置信度、行高中位数
  function pageStats(data) {
    var lines = [];
    ((data && data.blocks) || []).forEach(function (b) {
      (b.paragraphs || []).forEach(function (p) {
        (p.lines || []).forEach(function (l) {
          if (!l) return;
          var txt = typeof l.text === 'string' ? l.text.trim() : '';
          var conf = (typeof l.confidence === 'number') ? l.confidence : 0;
          var h = (l.bbox && l.bbox.y1 != null) ? (l.bbox.y1 - l.bbox.y0) : 0;
          lines.push({ len: txt.length, conf: conf, h: h });
        });
      });
    });
    var chars = 0, wsum = 0, hs = [];
    lines.forEach(function (l) {
      chars += l.len;
      wsum += l.len * l.conf;
      if (l.h > 0) hs.push(l.h);
    });
    hs.sort(function (a, b) { return a - b; });
    return {
      chars: chars,
      lines: lines.length,
      meanConf: chars ? wsum / chars : 0,
      medLineH: hs.length ? hs[(hs.length / 2) | 0] : 0
    };
  }

  // 通道评分：字符量 × 置信度平方/1e4（置信度优先，避免"多识别多错"的通道胜出）
  function passScore(data) {
    var st = pageStats(data);
    return st.chars * Math.pow(st.meanConf / 100, 2);
  }

  // 质量门控多通道识别。实测结论（docs/ocr-accuracy-optimization.md）：
  //  原图直识在多数场景最优，无条件二值化反而损害清晰件与纹理背景；
  //  因此先跑原图，仅在质量信号差时才启用对应像素变体，且变体需超过当前评分 5% 才采纳。
  //  通道 1 原图（基座 PSM）→ 通道 2 低分辨率 2x / 1.5x 放大 + 灰度增强 →
  //  通道 3 暗底/反色二值化（含极性归一）→ 通道 4 AUTO / 稀疏 PSM。
  //  strategy='legacy' 复现 v1.4.1 行为（单遍原图），供评测对比。
  async function recognizeSmart(wk, sourceCanvas, opts) {
    var o = opts || {};
    var psmBase = o.psm || MULTI.psmBase;
    // 显式指定 PSM：worker 的分页参数有状态，若沿用上次调用（单元格 PSM 7 / 稀疏 PSM 11）
    // 会污染后续识别，出现"同图不同结果"。
    var base = await wk.recognize(sourceCanvas, psmParams(psmBase), OUT_OPTS);
    if (o.strategy === 'legacy') {
      return {
        res: base, passes: 1, psm: psmBase, scale: 1, enh: 'off',
        canvas: sourceCanvas, enhInfo: null, stats: pageStats(base && base.data)
      };
    }
    var best = { res: base, enh: 'off', scale: 1, psm: psmBase, canvas: sourceCanvas, enhInfo: null };
    var bestScore = passScore(base.data);
    var passes = 1;
    var st = pageStats(base.data);
    var variants = [];
    if (o.enhance !== false) {
      var bright = meanBrightness(sourceCanvas);
      var longEdge = Math.max(sourceCanvas.width, sourceCanvas.height);
      // 小字判定：行高 <18px，或行高 <24px 且画布本身很小（截图/缩略图）；
      // 大画布上的 20px 文字无需放大（放大只增耗时）
      var tinyText = st.medLineH > 0 && (st.medLineH < 18 || (st.medLineH < 24 && longEdge < 1200));
      if (tinyText) {
        variants.push({ prep: null, scale: 2 });        // 纯放大：小字场景
        variants.push({ prep: 'gray', scale: 1.5 });    // 放大 + 灰度增强
      } else if (st.meanConf < MULTI.pixelConf || bright < 200) {
        // 低置信或整体偏暗（扫描件/照片）才做灰度增强；清晰件不白跑
        variants.push({ prep: 'gray', scale: 1 });
      }
      if (bright < 110) {
        variants.push({ prep: 'full', scale: 1 });      // 暗底 / 反色底：二值化 + 极性归一
      }
    }
    for (var i = 0; i < variants.length; i++) {
      var v = variants[i];
      var c = v.scale === 1 ? cloneCanvas(sourceCanvas) : scaleCanvas(sourceCanvas, v.scale);
      var info = null;
      if (v.prep) {
        try { info = enhanceCanvas(c, v.prep); } catch (e) { continue; }
      }
      var r = await wk.recognize(c, psmParams(psmBase), OUT_OPTS);
      passes++;
      var sc = passScore(r.data);
      if (sc > bestScore * MULTI.gain) {
        best = { res: r, enh: v.prep || 'off', scale: v.scale, psm: psmBase, canvas: c, enhInfo: info };
        bestScore = sc;
      }
    }
    var stB = pageStats(best.res.data);
    if (stB.meanConf < MULTI.lowConf || stB.lines <= 2) {
      var altPsm = stB.lines <= 2 ? MULTI.psmSparse : MULTI.psmAuto;
      var altSrc = best.scale === 1 ? sourceCanvas : scaleCanvas(sourceCanvas, best.scale);
      if (best.enh !== 'off') altSrc = best.canvas;
      var r4 = await wk.recognize(altSrc, psmParams(altPsm), OUT_OPTS);
      passes++;
      if (passScore(r4.data) > bestScore * MULTI.gain) {
        best = { res: r4, enh: best.enh, scale: best.scale, psm: altPsm, canvas: altSrc, enhInfo: best.enhInfo };
      }
    }
    return {
      res: best.res, passes: passes, psm: best.psm, scale: best.scale,
      enh: best.enh, canvas: best.canvas, enhInfo: best.enhInfo,
      stats: pageStats(best.res && best.res.data)
    };
  }

  // 恢复默认识别参数（单元格重识别后调用，避免污染后续页面/文件）
  async function resetParams(wk) {
    try { await wk.setParameters(psmParams(MULTI.psmBase)); } catch (e) { /* 引擎未就绪时忽略 */ }
  }

  // 裁剪单元格（外扩 3px 容差）
  function cropCanvas(canvas, box) {
    var x0 = Math.max(0, Math.floor(box.x0) - 3);
    var y0 = Math.max(0, Math.floor(box.y0) - 3);
    var x1 = Math.min(canvas.width, Math.ceil(box.x1) + 3);
    var y1 = Math.min(canvas.height, Math.ceil(box.y1) + 3);
    var w = x1 - x0, h = y1 - y0;
    if (w < 4 || h < 4) return null;
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
    return c;
  }

  // 低置信单元格重识别：整页识别对单元格串列/串行敏感，裁剪为单行（PSM 7）后
  // 重新识别，仅在置信度明显更高（+3）时替换。次数受 maxCells 预算约束。
  async function refineTableCells(wk, canvas, doc) {
    if (!doc || !doc.blocks || !canvas) return 0;
    var refined = 0, budget = MULTI.maxCells;
    for (var i = 0; i < doc.blocks.length && budget > 0; i++) {
      var b = doc.blocks[i];
      if (!b || b.type !== 'table' || !b.boxes || !b.confs) continue;
      for (var ri = 0; ri < b.rows.length && budget > 0; ri++) {
        for (var ci = 0; ci < b.rows[ri].length && budget > 0; ci++) {
          var conf = b.confs[ri][ci];
          var box = b.boxes[ri][ci];
          var cur = String(b.rows[ri][ci] || '');
          if (!box || conf == null || !cur || conf >= MULTI.cellConf) continue;
          // 仅对「数字型单元格」重识别：实测中文短格裁剪后易把 摊→难（置信更高但更错），
          // 而数字格（金额/数量）在单行 PSM 下收益稳定且可校验
          if (!/^[\d.,¥$%+\-/\s]+$/.test(cur)) continue;
          budget--;
          var crop = cropCanvas(canvas, box);
          if (!crop) continue;
          var r = await wk.recognize(crop, psmParams(7), OUT_OPTS);
          var text = String((r.data && r.data.text) || '').replace(/\s+/g, ' ').trim();
          var conf2 = (r.data && typeof r.data.confidence === 'number') ? r.data.confidence : 0;
          // 采纳条件（防"裁剪碎片当作更优结果"）：置信度至少 +10 且达 75，
          // 且字数与原文接近（0.8–1.25 倍）——中文单字替换比多字更危险，必须严格
          var ratio = text ? text.replace(/\s+/g, '').length / Math.max(1, cur.replace(/\s+/g, '').length) : 0;
          if (text && conf2 >= conf + 10 && conf2 >= 75 && ratio >= 0.8 && ratio <= 1.25) {
            b.rows[ri][ci] = text;
            b.confs[ri][ci] = Math.round(conf2);
            refined++;
          }
        }
      }
    }
    if (refined) await resetParams(wk);
    return refined;
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
        console.warn('[haoyue] 版面还原失败，回退纯文本:', e);
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

  // word/document.xml：逐行成段（A4，方向随 opts.landscape），空行输出空段落保留排版
  function buildDocxXml(text, opts) {
    return buildDocxXmlFromUnits([{ label: '', text: String(text || '') }], opts);
  }

  // 页面尺寸：A4 竖向 11906×16838 twips，横向转置并标 orient
  function pageSizeXml(landscape) {
    return landscape
      ? '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>'
      : '<w:pgSz w:w="11906" w:h="16838"/>';
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
  // 无结构时逐行成段（与旧行为一致）；opts.landscape 控制 A4 页面方向
  function buildDocxXmlFromUnits(units, opts) {
    var list = units || [];
    var landscape = !!(opts && opts.landscape);
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
      '<w:sectPr>' + pageSizeXml(landscape) + '</w:sectPr>' +
      '</w:body></w:document>';
  }

  // 最小 OOXML 三件套 → ZipUtil.store 入参（name + Uint8Array）。
  // 入参为字符串时走纯文本路径；为数组时走结构化路径（[{label, text, doc}]）
  function buildDocxFiles(input, opts) {
    var enc = new TextEncoder();
    var xml = (typeof input === 'string')
      ? buildDocxXml(input, opts)
      : buildDocxXmlFromUnits(input, opts);
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

  // 结果区方向：切换版心比例、标签与按钮选中态（导出沿用同一方向）
  function setOrient(o) {
    orient = o === 'l' ? 'l' : 'p';
    var page = $('do-page');
    if (page) page.classList.toggle('landscape', orient === 'l');
    var pBtn = $('do-page-p'), lBtn = $('do-page-l');
    if (pBtn && lBtn) {
      pBtn.classList.toggle('active', orient === 'p');
      lBtn.classList.toggle('active', orient === 'l');
    }
    var label = $('do-page-label');
    if (label) {
      label.textContent = orient === 'l' ? 'A4 横向（297 × 210 mm）' : 'A4 竖向（210 × 297 mm）';
    }
  }

  function setStatus(msg) { $('do-status').textContent = msg || ''; }

  /* 运行期控件锁：选择/语言/选项/清空一律停用，只留取消按钮可点，
   * 避免识别过程中文件列表或参数被改动导致结果与设置不一致 */
  var CTRL_IDS = ['do-pick', 'do-file', 'do-clear', 'do-lang', 'do-enhance', 'do-mode', 'do-run'];
  function setRunning(on) {
    running = on;
    CTRL_IDS.forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = on;
    });
    $('do-cancel').hidden = !on;
  }

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

  function addFiles(files) {
    if (running) { toast('正在识别中，请先取消或等待完成'); return; }
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

  function onFilesPicked() {
    addFiles(Array.prototype.slice.call($('do-file').files || []));
  }

  // 清空：文件列表与识别结果区一并复位（结果文本、统计、导出按钮、结构化缓存、状态行）
  function clearFiles() {
    items = [];
    lastUnits = null;
    lastFullText = null;
    $('do-text').value = '';
    var input = $('do-file');
    if (input) input.value = '';
    renderCount();
    updateMeta();
    exportsEnable(false, false);
    setStatus('');
  }

  // 单页处理：质量门控多通道识别 → 版面构建 → 低置信表格单元格重识别（预算内）
  async function recognizePage(wk, canvas, mode, acc, canEnhance) {
    var smart = await recognizeSmart(wk, canvas, { enhance: canEnhance !== false });
    acc.passes += smart.passes;
    if (smart.psm !== MULTI.psmBase) acc.psmAlt++;
    if (smart.scale > 1) acc.rescaled++;
    if (smart.enh !== 'off') acc.enhanced++;
    if (smart.enhInfo) noteEnh(acc.enhFlags, smart.enhInfo);
    var built = buildResult(smart.res, mode);
    if (built && built.doc && built.hasTable) {
      // 单元格裁剪必须用「实际参与识别的那张画布」（可能是放大/增强后的变体）
      var fixed = await refineTableCells(wk, smart.canvas, built.doc);
      if (fixed) {
        acc.cells += fixed;
        built.text = App.ocrEnhance ? App.ocrEnhance.renderDocText(built.doc.blocks) : built.text;
      }
    }
    return built;
  }

  async function run() {
    if (running) return;
    if (!items.length) { toast('请先选择要识别的图片或 PDF'); return; }
    if (!window.Tesseract || typeof window.Tesseract.createWorker !== 'function') {
      toast('OCR 引擎未加载，请刷新页面后重试', true);
      return;
    }
    task = App.task.create();
    setRunning(true);
    var langKey = $('do-lang').value;
    var mode = $('do-mode') ? $('do-mode').value : 'auto';
    var enhanceOn = !$('do-enhance') || $('do-enhance').checked;
    var canEnhance = enhanceOn && App.ocrEnhance && typeof App.ocrEnhance.enhance === 'function';
    var units = [];
    var okN = 0, errN = 0;
    var cancelled = false;
    var smartAcc = {
      passes: 0, psmAlt: 0, rescaled: 0, cells: 0, enhanced: 0,
      enhFlags: { deskew: false, lowLight: false, sharpen: false, inverted: false }
    };
    try {
      if (!worker) setStatus('正在加载识别内核（约 12 MB，仅首次较慢，全程本机）…');
      var wk = await ensureWorker(langKey);
      App.task.checkpoint(task);
      for (var i = 0; i < items.length; i++) {
        App.task.checkpoint(task);
        var it = items[i];
        try {
          if (it.isPdf) {
            var pdf = await core.loadPdf(it.file);
            try {
              for (var p = 1; p <= pdf.numPages; p++) {
                App.task.checkpoint(task);
                curLabel = '识别 ' + it.file.name + ' 第 ' + p + '/' + pdf.numPages + ' 页：';
                setStatus(curLabel + '0%');
                var canvas = await core.renderPage(pdf, p, 2, 2000);
                pushUnit(units, await recognizePage(wk, canvas, mode, smartAcc, canEnhance), it.file.name + ' 第' + p + '页');
                okN++;
              }
            } finally {
              if (pdf) pdf.cleanup();
            }
          } else {
            App.task.checkpoint(task);
            curLabel = '识别 ' + it.file.name + '：';
            setStatus(curLabel + '0%');
            var imgCanvas = await fileToCanvas(it.file);
            pushUnit(units, await recognizePage(wk, imgCanvas, mode, smartAcc, canEnhance), it.file.name);
            okN++;
          }
        } catch (e) {
          if (App.task.isCancelled(e)) throw e;
          errN++;
          console.error('[haoyue] OCR 识别失败:', it.file.name, e);
          toast('识别 ' + it.file.name + ' 失败：' + ((e && e.message) || e), true);
        }
      }
    } catch (e) {
      if (App.task.isCancelled(e)) {
        cancelled = true;
      } else {
        errN++;
        console.error('[haoyue] OCR 引擎初始化失败:', e);
        toast('识别引擎初始化失败：' + ((e && e.message) || e), true);
      }
    }
    /* 收尾全部包在 try 内、finally 复位：此前 joinUnits/updateMeta/exportsEnable
     * 若抛错会跳过 disabled=false 复位，按钮永久锁死、running 永 true */
    try {
      curLabel = '';
      if (units.length) {
        lastUnits = units;
        lastFullText = joinUnits(units);
        $('do-text').value = lastFullText;
        setOrient(detectOrient(units));
        updateMeta();
        exportsEnable(true, anyTableFlag(units));
        setStatus(cancelled
          ? '已取消：已完成 ' + okN + ' 项' + (errN ? '，失败 ' + errN + ' 项' : '') +
            '，已识别结果保留在右侧，可编辑后复制或导出。'
          : '识别完成：成功 ' + okN + ' 项' + (errN ? '，失败 ' + errN + ' 项' : '') +
            (anyTableFlag(units) ? '，含表格还原' : '') + enhNoteText(smartAcc.enhFlags) + smartNoteText(smartAcc) +
            '，结果可在右侧编辑后复制或导出。');
      } else {
        setStatus(cancelled ? '已取消：未产生识别结果' : '');
      }
    } finally {
      setRunning(false);
      task = null;
    }
  }

  // 按本次识别结果推断结果区方向（横向页占多数则用横向；无结构信息保持竖向）。
  // 优先用 ocrEnhance.pageOrientation（单一判定口径），模块缺失时按宽高比本地回退。
  function detectOrient(units) {
    var l = 0, p = 0;
    (units || []).forEach(function (u) {
      var page = u.doc && u.doc.page;
      if (!page || !page.w || !page.h) return;
      var isL = (App.ocrEnhance && typeof App.ocrEnhance.pageOrientation === 'function')
        ? App.ocrEnhance.pageOrientation(u.doc) === 'l'
        : (page.w / page.h) > 1.2;
      if (isL) l++; else p++;
    });
    return l > p ? 'l' : 'p';
  }

  // 逐项识别结果登记：保留表格标记与结构化文档模型，文本缺省给空串
  function pushUnit(units, built, label) {
    units.push({ label: label, text: built.text || '', hasTable: !!built.hasTable, doc: built.doc || null });
  }

  function noteEnh(flags, info) {
    if (!info) return;
    if (info.deskewed) flags.deskew = true;
    if (info.lowLight) flags.lowLight = true;
    if (info.sharpened) flags.sharpen = true;
    if (info.inverted) flags.inverted = true;
  }

  // 多通道统计摘要（让用户知道多花的算力用在哪）
  function smartNoteText(acc) {
    var parts = [];
    if (acc.passes > 1) parts.push('多通道 ' + acc.passes + ' 遍');
    if (acc.enhanced) parts.push('增强通道 ' + acc.enhanced + ' 次');
    if (acc.psmAlt) parts.push('换版式 ' + acc.psmAlt + ' 次');
    if (acc.rescaled) parts.push('放大重识别 ' + acc.rescaled + ' 次');
    if (acc.cells) parts.push('单元格校正 ' + acc.cells + ' 格');
    return parts.length ? '（' + parts.join('、') + '）' : '';
  }

  function enhNoteText(flags) {
    var notes = [];
    if (flags.deskew) notes.push('纠偏');
    if (flags.lowLight) notes.push('低光照优化');
    if (flags.sharpen) notes.push('锐化');
    if (flags.inverted) notes.push('反色归一');
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
      var blob = window.ZipUtil.store(buildDocxFiles(structured ? lastUnits : text,
        { landscape: orient === 'l' }));
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

  /* 每次进入面板：只复位状态行与计数，保留已选文件、识别结果与页面方向 */
  function enter() {
    setStatus('');
    renderCount();
    updateMeta();
    setOrient(orient);
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
      pageSizeXml: pageSizeXml,
      buildDocxXmlFromUnits: buildDocxXmlFromUnits,
      detectOrient: detectOrient,
      recognizeSmart: recognizeSmart,
      refineTableCells: refineTableCells,
      pageStats: pageStats,
      passScore: passScore,
      MULTI: MULTI,
      /* 原始识别（不增强、不版面）：供评测工具比较不同参数形态与通道 */
      rawRecognize: async function (canvas, options, lang) {
        var wk = await ensureWorker(lang || 'both');
        var res = await wk.recognize(canvas, options || undefined, OUT_OPTS);
        return {
          text: (res.data && res.data.text) || '',
          conf: (res.data && typeof res.data.confidence === 'number') ? res.data.confidence : 0,
          stats: pageStats(res.data)
        };
      },
      /* 评测钩子（tools/eval-ocr.cjs 用）：整条管线（增强 → 多通道识别 → 版面 → 单元格校正），
       * strategy='legacy' 复现 v1.4.1 旧行为，用于优化前后对比。 */
      pipelineEval: async function (canvas, opts) {
        var o = opts || {};
        var wk = await ensureWorker(o.lang || 'both');
        var strategy = o.strategy || 'auto';
        // 增强由 recognizeSmart 内部按质量门控决定；此处仅传开关（false/'off' 关闭像素变体）
        var smart = await recognizeSmart(wk, canvas, {
          strategy: strategy,
          enhance: o.enhance !== false && o.enhance !== 'off'
        });
        var built = buildResult(smart.res, o.mode || 'auto');
        var refined = 0;
        if (built && built.doc && built.hasTable && o.cellRefine !== false && strategy !== 'legacy') {
          refined = await refineTableCells(wk, smart.canvas, built.doc);
          if (refined) built.text = App.ocrEnhance.renderDocText(built.doc.blocks);
        }
        return {
          text: built.text,
          hasTable: !!built.hasTable,
          doc: built.doc,
          conf: built.conf,
          stats: smart.stats,
          passes: smart.passes,
          psm: smart.psm,
          scale: smart.scale,
          enhMode: smart.enh,
          enh: smart.enhInfo,
          refinedCells: refined
        };
      },
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
    $('do-cancel').addEventListener('click', function () {
      if (!task) return;
      task.cancel();
      setStatus('正在取消识别…');
    });
    App.ui.bindFileDrop('docs-ocr', {
      target: 'do-stage',
      accept: /\.(pdf|jpe?g|png|webp|bmp)$/i,
      rejectMsg: '请拖入图片（JPG / PNG / WebP / BMP）或 PDF',
      onFiles: addFiles
    });
    $('do-copy').addEventListener('click', copyText);
    $('do-txt').addEventListener('click', exportTxt);
    $('do-docx').addEventListener('click', exportDocx);
    if ($('do-xlsx')) $('do-xlsx').addEventListener('click', exportXlsx);
    if ($('do-page-p')) $('do-page-p').addEventListener('click', function () { setOrient('p'); });
    if ($('do-page-l')) $('do-page-l').addEventListener('click', function () { setOrient('l'); });
    $('do-text').addEventListener('input', updateMeta);
    setOrient(orient);
  };
})(window.App);
