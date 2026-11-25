/* ============================================================
 * cert-print.js — 结业证打印（批量工具子功能，纯本地离线）
 * 流程：导出 Excel 信息模板 → 用户填写 → 导入 → 可视化预览 → 批量打印。
 *
 * 版式依据 E:\electron-dist\moban 下的两个 A5 横向 docx（210×148mm）：
 *   第1页（右半版）：身份证号、发证日期（年/月/日）
 *   第2页（左半版）：姓名、性别、年龄、省份、市/县、街道/乡镇、
 *                    起止日期（年/月/日 ×2）、培训学校、项目、发证日期
 *   第3页（右半版）：科目1/成绩1、科目2/成绩2
 * 每名学员打印 2 张 A5 横向：第 1 张 = 封面 + 第1页，第 2 张 = 第2、3页。
 * 结业证为预印本，只把变量值按模板坐标打印到留白处。
 *
 * 坐标单位 mm，取自 Word 版面中文本框的实际渲染位置（Left/Top + 文本框内边距）。
 * Excel 读取：自带 ZIP（store/deflate-raw）+ SpreadsheetML 解析，无第三方依赖。
 * ============================================================ */
'use strict';

window.App = window.App || {};
window.App.certPrint = (function () {

  var $ = window.App.ui.$;
  var toast = window.App.ui.toast;
  var printApi = window.haoyuePrint || null;

  /* A5 横向版面与渲染密度（12px/mm ≈ 305dpi） */
  var PAGE_MM = { w: 210, h: 148 };
  var PX_PER_MM = 12;
  var THUMB_PX_PER_MM = 4;
  var FONT_FAMILY = '"SimSun","宋体","Microsoft YaHei",serif';
  var ID_FONT_FAMILY = '"Calibri","Arial","Microsoft YaHei",sans-serif';

  /* 模板列（导出 / 导入按表头名匹配，列顺序可调整） */
  var HEADERS = [
    '身份证号', '姓名', '性别', '年龄', '省份', '市/县', '街道/乡镇',
    '起始日期', '结束日期', '培训学校', '项目', '发证日期',
    '科目1', '成绩1', '科目2', '成绩2'
  ];
  var HEADER_WIDTHS = [150, 80, 50, 50, 80, 90, 90, 110, 110, 120, 130, 110, 90, 70, 90, 70];
  var EXAMPLE_ROW = [
    '422126198611010028', '段望弟', '女', '39', '湖北', '浠水', '绿杨乡',
    '2026-02-10', '2026-10-14', '尊泓职校', '保健艾灸师', '2026-10-14',
    '实操', '合格', '理论', '72'
  ];

  /* 表头别名（去空白后匹配，兼容用户自行改列名） */
  var HEADER_ALIASES = {
    '身份证号码': '身份证号', '证件号': '身份证号', '身份证': '身份证号',
    '学员姓名': '姓名', '学员': '姓名',
    '省': '省份', '省市自治区': '省份',
    '市县': '市/县', '市（县）': '市/县', '市(县)': '市/县',
    '街道乡镇': '街道/乡镇', '街道（乡镇）': '街道/乡镇', '街道(乡镇)': '街道/乡镇', '乡镇': '街道/乡镇',
    '入学日期': '起始日期', '开始日期': '起始日期', '起始时间': '起始日期',
    '结业日期': '结束日期', '截止日期': '结束日期', '结束时间': '结束日期',
    '培训机构': '培训学校', '学校': '培训学校', '培训单位': '培训学校',
    '专业': '项目', '工种': '项目', '培训项目': '项目',
    '发证时间': '发证日期',
    '科目一': '科目1', '成绩一': '成绩1', '科目二': '科目2', '成绩二': '成绩2'
  };

  /* ================= 版式坐标（mm，文字左上角；pt 为字号） =================
   * 以 moban 照片透视校正到 210×148mm 后量取实物证书留白位置；
   * docx 仅用于确认字段与示例值（其文本框位置与实物有偏差，不直接采用）。 */
  /* 第1页：封面右侧（x > 105mm） */
  var FIELDS_A = [
    { key: 'idNo', x: 148.0, y: 117.4, pt: 11, maxW: 52, latin: true },
    { key: 'issueY', x: 149.0, y: 131.9, pt: 12, maxW: 22 },
    { key: 'issueM', x: 177.5, y: 131.9, pt: 12, maxW: 6 },
    { key: 'issueD', x: 189.0, y: 131.9, pt: 12, maxW: 6 }
  ];
  /* 第2页（左半版）与第3页（右半版），同在一张 A5 横向纸上
   * 地址按实物第2页第一处「____ 市 ____ 街道」填写（市/县、街道/乡镇） */
  var FIELDS_B = [
    { key: 'name', x: 34.0, y: 21.8, pt: 12, maxW: 28 },
    { key: 'gender', x: 78.5, y: 22.0, pt: 12, maxW: 10 },
    { key: 'age', x: 14.5, y: 32.4, pt: 12, maxW: 6 },
    { key: 'province', x: 38.5, y: 32.4, pt: 12, maxW: 12 },
    { key: 'cityCounty', x: 10.0, y: 39.6, pt: 12, maxW: 20 },
    { key: 'streetTown', x: 38.0, y: 39.6, pt: 12, maxW: 13 },
    { key: 'startY', x: 76.0, y: 46.2, pt: 12, maxW: 13 },
    { key: 'startM', x: 9.0, y: 54.8, pt: 12, maxW: 7 },
    { key: 'startD', x: 20.5, y: 54.8, pt: 12, maxW: 9 },
    { key: 'endY', x: 42.0, y: 54.8, pt: 12, maxW: 9 },
    { key: 'endM', x: 58.5, y: 54.8, pt: 12, maxW: 5 },
    { key: 'endD', x: 69.0, y: 54.8, pt: 12, maxW: 6 },
    { key: 'school', x: 10.0, y: 65.7, pt: 12, maxW: 32 },
    { key: 'project', x: 56.0, y: 65.7, pt: 12, maxW: 46 },
    { key: 'issueY', x: 40.0, y: 133.0, pt: 12, maxW: 20 },
    { key: 'issueM', x: 68.0, y: 133.0, pt: 12, maxW: 12 },
    { key: 'issueD', x: 86.0, y: 133.0, pt: 12, maxW: 6 },
    { key: 'subj1', x: 120.5, y: 30.8, pt: 12, maxW: 45 },
    { key: 'score1', x: 172.0, y: 30.8, pt: 12, maxW: 24 },
    { key: 'subj2', x: 120.5, y: 39.8, pt: 12, maxW: 45 },
    { key: 'score2', x: 172.0, y: 39.8, pt: 12, maxW: 24 }
  ];
  var FACES = { a: FIELDS_A, b: FIELDS_B };

  var records = [];      // 已导入学员 [{name,idNo,...,start:{y,m,d},end,issue, errors, row}]
  var thumbUrls = [];    // 预览图 objectURL（重渲染前释放）
  var printing = false;

  /* ================= 纯逻辑（可单测） ================= */

  function clean(v) {
    return v == null ? '' : String(v).replace(/^\s+|\s+$/g, '');
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function mkDate(y, m, d) {
    if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    return { y: y, m: m, d: d };
  }

  /* Excel 日期序列号（1900 日期系统，兼容 >60 的现代日期） */
  function serialToDate(n) {
    if (!(n > 0 && n < 80000)) return null;
    var ms = Math.round((n - 25569) * 86400000);
    var dt = new Date(ms);
    return mkDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }

  /* 日期解析：Excel 序列号 / 2026-10-14 / 2026/10/14 / 2026年10月14日 / 20261014 */
  function parseDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && isFinite(v)) return serialToDate(v);
    var s = clean(v);
    if (/^\d{5}(\.\d+)?$/.test(s)) return serialToDate(parseFloat(s));
    var m = s.match(/^(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
    if (m) return mkDate(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return mkDate(+m[1], +m[2], +m[3]);
    return null;
  }

  function normHeader(h) {
    var s = clean(h).replace(/[\s\u3000]+/g, '');
    return HEADER_ALIASES[s] || s;
  }

  function yearOf(dt) { return dt ? String(dt.y) : ''; }
  function monthOf(dt) { return dt ? pad2(dt.m) : ''; }
  function dayOf(dt) { return dt ? pad2(dt.d) : ''; }

  /* 原始行对象 → 规范化学员记录（含校验信息） */
  function normalizeRecord(raw) {
    raw = raw || {};
    var rec = {
      row: raw.__row || 0,
      idNo: clean(raw['身份证号']),
      name: clean(raw['姓名']),
      gender: clean(raw['性别']),
      age: clean(raw['年龄']),
      province: clean(raw['省份']),
      cityCounty: clean(raw['市/县']),
      streetTown: clean(raw['街道/乡镇']),
      start: parseDate(raw['起始日期']),
      end: parseDate(raw['结束日期']),
      school: clean(raw['培训学校']),
      project: clean(raw['项目']),
      issue: parseDate(raw['发证日期']),
      subj1: clean(raw['科目1']),
      score1: clean(raw['成绩1']),
      subj2: clean(raw['科目2']),
      score2: clean(raw['成绩2']),
      errors: []
    };
    if (!rec.name) rec.errors.push('姓名为空');
    if (!rec.issue) rec.errors.push('发证日期缺失或格式不正确');
    return rec;
  }

  /* 二维表（首行表头）→ 学员记录数组；全空行自动跳过 */
  function recordsFromRows(rows) {
    if (!rows || rows.length < 1) return [];
    var headers = (rows[0] || []).map(normHeader);
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i] || [];
      var hasValue = row.some(function (v) { return clean(v) !== ''; });
      if (!hasValue) continue;
      var raw = { __row: i + 1 };
      headers.forEach(function (h, j) {
        if (h) raw[h] = row[j] == null ? '' : row[j];
      });
      var rec = normalizeRecord(raw);
      if (!rec.name && !rec.idNo) continue;
      out.push(rec);
    }
    return out;
  }

  /* 导出模板：学员信息（表头 + 示例行）+ 填写说明 */
  function buildTemplateSheets() {
    var table1 = { rows: [HEADERS.slice()].concat([EXAMPLE_ROW.slice()]), aligns: [], widths: HEADER_WIDTHS };
    var noteRows = [
      ['字段', '填写说明'],
      ['日期格式', '推荐 2026-10-14；也支持 2026/10/14、2026年10月14日、20261014'],
      ['身份证号', '请先把该列设为「文本」再粘贴，避免长数字被 Excel 转成科学计数法'],
      ['年龄', '填数字，例如 39'],
      ['省市县', '省份 = 省（市、自治区）；市/县 = 市县名；街道/乡镇 = 街道或乡镇名'],
      ['培训学校', '证书中「在 ____ 参加」处的学校 / 培训机构名称'],
      ['项目', '证书中「参加 ____ 工种（专业）培训」处的项目名称'],
      ['科目/成绩', '固定两组：科目1 / 成绩1、科目2 / 成绩2'],
      ['打印', '每名学员 2 张 A5 横向：第 1 张为封面 + 第1页，第 2 张为第2、3页；请使用预印证书纸']
    ];
    var table2 = { rows: noteRows, aligns: [], widths: [100, 420] };
    return [
      { name: '学员信息', table: table1 },
      { name: '填写说明', table: table2 }
    ];
  }

  /* ================= XLSX 读取（ZIP store / deflate-raw + SpreadsheetML） ================= */

  function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') {
      return Promise.reject(new Error('当前环境不支持解压（请使用桌面版或新版 Chrome / Edge）'));
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  /* ZIP → { 文件名: Uint8Array }；仅支持 store(0) / deflate(8) */
  function unzipXlsx(buffer) {
    var u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var eocd = -1;
    var min = Math.max(0, u8.length - 65557);
    for (var i = u8.length - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return Promise.reject(new Error('不是有效的 xlsx 文件（缺少 ZIP 结束记录）'));
    var count = dv.getUint16(eocd + 10, true);
    var off = dv.getUint32(eocd + 16, true);
    var jobs = [];
    var names = [];
    for (var n = 0; n < count; n++) {
      if (off + 46 > u8.length || dv.getUint32(off, true) !== 0x02014b50) {
        return Promise.reject(new Error('xlsx 目录结构损坏'));
      }
      var method = dv.getUint16(off + 10, true);
      var compSize = dv.getUint32(off + 20, true);
      var nameLen = dv.getUint16(off + 28, true);
      var extraLen = dv.getUint16(off + 30, true);
      var commentLen = dv.getUint16(off + 32, true);
      var localOff = dv.getUint32(off + 42, true);
      var name = new TextDecoder('utf-8').decode(u8.subarray(off + 46, off + 46 + nameLen));
      if (localOff + 30 > u8.length) return Promise.reject(new Error('xlsx 文件条目损坏'));
      var lNameLen = dv.getUint16(localOff + 26, true);
      var lExtraLen = dv.getUint16(localOff + 28, true);
      var start = localOff + 30 + lNameLen + lExtraLen;
      var data = u8.subarray(start, start + compSize);
      names.push(name);
      if (method === 0) jobs.push(Promise.resolve(data));
      else if (method === 8) jobs.push(inflateRaw(data));
      else jobs.push(Promise.reject(new Error('不支持的压缩方式：' + method)));
      off += 46 + nameLen + extraLen + commentLen;
    }
    return Promise.all(jobs).then(function (list) {
      var files = {};
      names.forEach(function (nm, idx) { files[nm] = list[idx]; });
      return files;
    });
  }

  function decodeXml(s) {
    return String(s)
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); })
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /* 提取 <t> 文本（共享字符串富文本会拆成多个 run） */
  function textOf(xml) {
    var out = '';
    var re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    var m;
    while ((m = re.exec(xml))) out += decodeXml(m[1]);
    return out;
  }

  function colIndex(ref) {
    var m = String(ref || '').match(/^([A-Z]+)/i);
    if (!m) return -1;
    var s = m[1].toUpperCase();
    var n = 0;
    for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }

  function parseSharedStrings(files) {
    var bytes = files['xl/sharedStrings.xml'];
    if (!bytes) return [];
    var xml = new TextDecoder('utf-8').decode(bytes);
    var out = [];
    var re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    var m;
    while ((m = re.exec(xml))) out.push(textOf(m[1]));
    return out;
  }

  /* 工作表 XML → 二维数组（行/列按 r 属性定位，空单元格保留空位） */
  function parseSheetRows(xml, shared) {
    var rows = [];
    var rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    var rm;
    while ((rm = rowRe.exec(xml))) {
      var row = [];
      var cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      var cm;
      var auto = 0;
      while ((cm = cellRe.exec(rm[1]))) {
        var attrs = cm[1] || '';
        var inner = cm[2] || '';
        var refM = attrs.match(/\br="([A-Z]+\d+)"/i);
        var idx = refM ? colIndex(refM[1]) : auto;
        auto = idx + 1;
        var type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || '';
        var val = '';
        if (type === 's') {
          var vm = inner.match(/<v>([\s\S]*?)<\/v>/);
          var si = vm ? parseInt(decodeXml(vm[1]), 10) : -1;
          val = si >= 0 && shared[si] != null ? shared[si] : '';
        } else if (type === 'inlineStr') {
          val = textOf(inner);
        } else if (type === 'str') {
          var sm = inner.match(/<v>([\s\S]*?)<\/v>/);
          val = sm ? decodeXml(sm[1]) : '';
        } else {
          var nm = inner.match(/<v>([\s\S]*?)<\/v>/);
          if (nm) {
            var raw = decodeXml(nm[1]);
            var num = parseFloat(raw);
            // 数值保留原始文本（避免长编号被截断），日期列后续按序列号解析
            val = isFinite(num) && String(num) === raw ? num : raw;
          }
        }
        if (idx >= 0) row[idx] = val;
      }
      rows.push(row);
    }
    return rows;
  }

  /* ArrayBuffer / Uint8Array → 学员记录数组（取第一个工作表） */
  function parseXlsxBuffer(buffer) {
    return unzipXlsx(buffer).then(function (files) {
      var shared = parseSharedStrings(files);
      var sheet = files['xl/worksheets/sheet1.xml'];
      if (!sheet) return [];
      var xml = new TextDecoder('utf-8').decode(sheet);
      return recordsFromRows(parseSheetRows(xml, shared));
    });
  }

  /* ================= 画布渲染 ================= */

  function textFor(rec, key) {
    switch (key) {
      case 'issueY': return yearOf(rec.issue);
      case 'issueM': return monthOf(rec.issue);
      case 'issueD': return dayOf(rec.issue);
      case 'startY': return yearOf(rec.start);
      case 'startM': return monthOf(rec.start);
      case 'startD': return dayOf(rec.start);
      case 'endY': return yearOf(rec.end);
      case 'endM': return monthOf(rec.end);
      case 'endD': return dayOf(rec.end);
      default: return clean(rec[key]);
    }
  }

  function drawField(ctx, f, text, pxPerMm) {
    text = clean(text);
    if (!text) return;
    var ptPx = 0.352778 * pxPerMm;
    var size = f.pt * ptPx;
    var minSize = size * 0.7;
    var family = f.latin ? ID_FONT_FAMILY : FONT_FAMILY;
    var maxW = f.maxW * pxPerMm;
    ctx.font = size.toFixed(1) + 'px ' + family;
    while (size > minSize && ctx.measureText(text).width > maxW) {
      size *= 0.94;
      ctx.font = size.toFixed(1) + 'px ' + family;
    }
    // Word 中文字顶端对齐；canvas 用 alphabetic 基线，按 ascent 下移
    var baseline = f.y * pxPerMm + f.pt * ptPx * 0.86;
    ctx.fillText(text, f.x * pxPerMm, baseline);
  }

  /* 生成单页画布（face: 'a' | 'b'） */
  function makePageCanvas(face, rec, pxPerMm) {
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(PAGE_MM.w * pxPerMm);
    canvas.height = Math.round(PAGE_MM.h * pxPerMm);
    var ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    ctx.textBaseline = 'alphabetic';
    (FACES[face] || []).forEach(function (f) {
      drawField(ctx, f, textFor(rec, f.key), pxPerMm);
    });
    return canvas;
  }

  function releaseThumbs() {
    thumbUrls.forEach(function (u) {
      try { URL.revokeObjectURL(u); } catch (e) { /* 忽略 */ }
    });
    thumbUrls = [];
  }

  function thumbUrl(face, rec) {
    var canvas = makePageCanvas(face, rec, THUMB_PX_PER_MM);
    var url = '';
    try { url = canvas.toDataURL('image/jpeg', 0.9); } catch (e) { url = ''; }
    canvas.width = 0;
    canvas.height = 0;
    return url;
  }

  function pageDataUrl(face, rec) {
    var canvas = makePageCanvas(face, rec, PX_PER_MM);
    var url = canvas.toDataURL('image/png');
    canvas.width = 0;
    canvas.height = 0;
    return url;
  }

  /* ================= UI ================= */

  function validRecords() {
    return records.filter(function (r) { return r.errors.length === 0; });
  }

  function updateCount() {
    var ok = validRecords().length;
    var bad = records.length - ok;
    var txt = records.length
      ? '已导入 ' + records.length + ' 名学员，可打印 ' + ok + ' 名' + (bad ? '，' + bad + ' 行信息不完整（不参与打印）' : '')
      : '未导入学员信息';
    $('cert-count').textContent = txt;
    $('cert-print-btn').disabled = printing || ok === 0 || !bridgeOk();
  }

  function renderPreview() {
    releaseThumbs();
    var grid = $('cert-grid');
    grid.textContent = '';
    if (!records.length) {
      grid.hidden = true;
      $('cert-empty').hidden = false;
      $('cert-empty').textContent = '先导出模板并填写学员信息，再导入打印';
      return;
    }
    grid.hidden = false;
    $('cert-empty').hidden = true;
    var ok = validRecords();
    if (!ok.length) {
      grid.hidden = true;
      $('cert-empty').hidden = false;
      $('cert-empty').textContent = '导入的学员信息不完整（至少需要姓名和正确的发证日期）';
      return;
    }
    ok.forEach(function (rec, i) {
      var card = document.createElement('div');
      card.className = 'cert-card';

      var head = document.createElement('div');
      head.className = 'cert-card-head';
      var idx = document.createElement('span');
      idx.className = 'cert-idx';
      idx.textContent = String(i + 1);
      var name = document.createElement('span');
      name.className = 'cert-name';
      name.textContent = rec.name || '未命名';
      var meta = document.createElement('span');
      meta.className = 'cert-meta';
      meta.textContent = (rec.idNo || '无身份证号') + ' · 发证 ' + (rec.issue ? rec.issue.y + '-' + pad2(rec.issue.m) + '-' + pad2(rec.issue.d) : '—');
      head.appendChild(idx);
      head.appendChild(name);
      head.appendChild(meta);
      card.appendChild(head);

      var pages = document.createElement('div');
      pages.className = 'cert-pages';
      [['a', '第1张：封面 + 第1页'], ['b', '第2张：第2、3页']].forEach(function (pair) {
        var fig = document.createElement('figure');
        var img = document.createElement('img');
        img.alt = rec.name + ' ' + pair[1];
        var url = thumbUrl(pair[0], rec);
        if (url) { img.src = url; thumbUrls.push(url); }
        var cap = document.createElement('figcaption');
        cap.textContent = pair[1];
        fig.appendChild(img);
        fig.appendChild(cap);
        pages.appendChild(fig);
      });
      card.appendChild(pages);
      grid.appendChild(card);
    });
  }

  function setRecords(list, sourceName) {
    records = list || [];
    renderPreview();
    updateCount();
    var ok = validRecords().length;
    $('cert-status').textContent = records.length
      ? '已读取「' + sourceName + '」：可打印 ' + ok + ' 名' + (records.length > ok ? '，' + (records.length - ok) + ' 行缺少姓名或发证日期' : '')
      : '';
    if (!records.length) toast('模板中没有读到学员数据（请保留首行表头并填写数据行）', true);
    else if (!ok) toast('学员信息不完整：请检查姓名与发证日期', true);
    else toast('已导入 ' + ok + ' 名学员');
  }

  function exportTemplate() {
    var xl = window.App.xlsxLite;
    if (!xl || typeof xl.buildXlsxFiles !== 'function') { toast('Excel 组件未加载，请刷新后重试', true); return; }
    if (!window.ZipUtil || typeof window.ZipUtil.store !== 'function') { toast('ZIP 组件未就绪，无法导出模板', true); return; }
    try {
      var built = xl.buildXlsxFiles(buildTemplateSheets());
      if (!built) { toast('生成模板失败', true); return; }
      var blob = window.ZipUtil.store(built);
      window.App.ui.download(blob, '结业证打印信息模板.xlsx');
      toast('已导出模板：填写「学员信息」工作表后导入');
    } catch (e) {
      toast('导出模板失败：' + ((e && e.message) || e), true);
    }
  }

  function importFile(file) {
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) { toast('请选择 .xlsx 格式的模板文件', true); return; }
    $('cert-status').textContent = '正在读取模板…';
    var reader = new FileReader();
    reader.onload = function () {
      parseXlsxBuffer(reader.result).then(function (list) {
        setRecords(list, file.name);
      }).catch(function (e) {
        $('cert-status').textContent = '读取失败：' + ((e && e.message) || e);
        toast('读取模板失败：' + ((e && e.message) || e), true);
      });
    };
    reader.onerror = function () { toast('读取文件失败', true); };
    reader.readAsArrayBuffer(file);
  }

  function bridgeOk() {
    return !!(printApi && printApi.printImage && printApi.listPrinters);
  }

  async function refreshPrinters() {
    var ok = bridgeOk();
    $('cert-unsupported').hidden = ok;
    if (!ok) {
      $('cert-printer').disabled = true;
      updateCount();
      return;
    }
    try {
      await window.App.print.fillPrinterSelect($('cert-printer'), $('cert-status'), null);
    } catch (e) {
      $('cert-status').textContent = '读取打印机失败：' + ((e && e.message) || e);
    }
    updateCount();
  }

  async function runPrint() {
    if (printing) return;
    var ok = validRecords();
    if (!ok.length) { toast('没有可打印的学员信息', true); return; }
    if (!bridgeOk()) { toast('请使用桌面版打印', true); return; }
    var printer = $('cert-printer').value;
    if (!printer) { toast('请选择打印机', true); return; }
    var pages = ok.length * 2;
    var yes = await window.App.ui.confirm('将打印 ' + ok.length + ' 名学员，共 ' + pages + ' 张 A5 横向纸（每人 2 张），确定吗？');
    if (!yes) return;

    printing = true;
    updateCount();
    var status = $('cert-status');
    status.textContent = '正在生成页面…';
    var urls = [];
    try {
      ok.forEach(function (rec, i) {
        urls.push(pageDataUrl('a', rec));
        urls.push(pageDataUrl('b', rec));
        if (i % 5 === 0) status.textContent = '正在生成页面…（' + (i + 1) + '/' + ok.length + '）';
      });
      status.textContent = '正在发送打印任务…（' + pages + ' 页）';
      var res = await printApi.printImage({
        dataUrls: urls,
        printerName: printer,
        pageSize: 'A5',
        landscape: true,
        marginType: 'none',
        copies: 1
      });
      if (res && res.ok) {
        status.textContent = '已发送打印任务（' + ok.length + ' 名学员 / ' + pages + ' 页）';
        toast('已发送到打印机');
      } else {
        status.textContent = '打印失败：' + ((res && res.error) || '未知错误');
        toast('打印失败：' + ((res && res.error) || '未知错误'), true);
      }
    } catch (e) {
      status.textContent = '打印失败：' + ((e && e.message) || e);
      toast('打印失败：' + ((e && e.message) || e), true);
    } finally {
      printing = false;
      updateCount();
    }
  }

  function clearAll() {
    records = [];
    releaseThumbs();
    $('cert-grid').textContent = '';
    $('cert-file').value = '';
    $('cert-status').textContent = '';
    renderPreview();
    updateCount();
  }

  function enter() {
    refreshPrinters();
  }

  function init() {
    $('cert-export').addEventListener('click', exportTemplate);
    $('cert-import').addEventListener('click', function () { $('cert-file').click(); });
    $('cert-file').addEventListener('change', function () {
      var f = this.files && this.files[0];
      importFile(f);
      this.value = '';
    });
    $('cert-clear').addEventListener('click', clearAll);
    $('cert-print-btn').addEventListener('click', runPrint);
    $('cert-back').addEventListener('click', function () { window.App.batch.showOnly(null); });
    $('cert-unsupported').hidden = bridgeOk();
    if (!bridgeOk()) $('cert-printer').disabled = true;
  }

  return {
    init: init,
    enter: enter,
    _test: {
      HEADERS: HEADERS,
      EXAMPLE_ROW: EXAMPLE_ROW,
      PAGE_MM: PAGE_MM,
      PX_PER_MM: PX_PER_MM,
      FACES: FACES,
      clean: clean,
      pad2: pad2,
      parseDate: parseDate,
      normHeader: normHeader,
      normalizeRecord: normalizeRecord,
      recordsFromRows: recordsFromRows,
      buildTemplateSheets: buildTemplateSheets,
      inflateRaw: inflateRaw,
      unzipXlsx: unzipXlsx,
      parseSharedStrings: parseSharedStrings,
      parseSheetRows: parseSheetRows,
      parseXlsxBuffer: parseXlsxBuffer,
      textFor: textFor
    }
  };
})();
