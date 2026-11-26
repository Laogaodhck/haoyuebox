/* ============================================================
 * cert-print.js — 结业证打印（批量工具子功能，纯本地离线）
 * 流程：导出 Excel 信息模板 → 用户填写 → 导入 → 可视化预览 → 批量打印。
 *
 * 版式依据 E:\electron-dist\moban 下的 docx 与带尺照片：
 *   实物为 16K 纸对折（展开约 185×130mm），docx 页面 210×148mm 仅作字段参考，
 *   尺寸与留白位置以带尺照片实测为准。
 *   第1页（右半版）：身份证号、发证日期（年/月/日）
 *   第2页（左半版）：姓名、性别、年龄、省份、市/县、街道/乡镇、
 *                    起止日期（年/月/日 ×2）、培训学校、项目、发证日期
 *   第3页（右半版）：科目1/成绩1、科目2/成绩2
 * 每名学员打印 2 张 185×130mm 横向：第 1 张 = 封面 + 第1页，第 2 张 = 第2、3页。
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

  /* 16K 对折横向版面与渲染密度（8px/mm ≈ 203dpi）
   * 实物展开约 185×130mm（带尺照片实测），不是 A5 210×148mm。
   * 不用 12px/mm：部分针式 / 标签打印机驱动的光栅行宽上限约 2048px，
   * 305dpi 的 2520px 整页会被驱动换行，导致右侧字段被拆到纸张左缘。 */
  var PAGE_MM = { w: 185, h: 130 };
  var PX_PER_MM = 8;
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
    '11010519491231002X', '张三', '男', '30', '示例省', '示例市', '示例乡镇',
    '2026-01-01', '2026-06-30', '示例培训学校', '示例项目', '2026-07-01',
    '科目一', '合格', '科目二', '80'
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
   * 以 moban 带尺照片实测 185×130mm 后量取实物证书留白位置；
   * docx 仅用于确认字段与示例值（其文本框位置与实物有偏差，不直接采用）。 */
  /* 第1页：封面右侧（x > 105mm） */
  var FIELDS_A = [
    { key: 'idNo', x: 130.4, y: 102.3, pt: 12, maxW: 45.8, latin: true },
    { key: 'issueY', x: 131.3, y: 115.3, pt: 12, maxW: 19.4 },
    { key: 'issueM', x: 156.4, y: 115.3, pt: 12, maxW: 5.3 },
    { key: 'issueD', x: 166.5, y: 115.3, pt: 12, maxW: 5.3 }
  ];
  /* 第2页（左半版）与第3页（右半版），同在一张 185×130mm 横向纸上
   * 地址按实物第2页第一处「____ 市 ____ 街道」填写（市/县、街道/乡镇） */
  var FIELDS_B = [
    { key: 'name', x: 35.0, y: 19.1, pt: 12, maxW: 18.0 },
    { key: 'gender', x: 67.5, y: 19.3, pt: 12, maxW: 8.0 },
    { key: 'age', x: 16.0, y: 28.5, pt: 12, maxW: 8.0 },
    { key: 'province', x: 32.0, y: 28.5, pt: 12, maxW: 12.0 },
    { key: 'cityCounty', x: 5.0, y: 34.8, pt: 12, maxW: 14.0 },
    { key: 'streetTown', x: 34.0, y: 34.8, pt: 12, maxW: 12.0 },
    { key: 'startY', x: 80.0, y: 38.5, pt: 12, maxW: 10.0 },
    { key: 'startM', x: 6.0, y: 48.1, pt: 12, maxW: 8.0 },
    { key: 'startD', x: 20.0, y: 48.1, pt: 12, maxW: 8.0 },
    { key: 'endY', x: 40.0, y: 48.1, pt: 12, maxW: 10.0 },
    { key: 'endM', x: 56.0, y: 48.1, pt: 12, maxW: 6.0 },
    { key: 'endD', x: 63.0, y: 48.1, pt: 12, maxW: 7.0 },
    { key: 'school', x: 5.0, y: 57.7, pt: 12, maxW: 33.0 },
    { key: 'project', x: 52.0, y: 57.7, pt: 12, maxW: 40.0 },
    { key: 'issueY', x: 33.0, y: 116.3, pt: 12, maxW: 12.0 },
    { key: 'issueM', x: 48.0, y: 116.3, pt: 12, maxW: 9.0 },
    { key: 'issueD', x: 60.0, y: 116.3, pt: 12, maxW: 8.0 },
    { key: 'subj1', x: 110.0, y: 27.1, pt: 12, maxW: 32 },
    { key: 'score1', x: 153.0, y: 27.1, pt: 12, maxW: 30 },
    { key: 'subj2', x: 110.0, y: 35.0, pt: 12, maxW: 32 },
    { key: 'score2', x: 153.0, y: 35.0, pt: 12, maxW: 30 }
  ];
  var FACES = { a: FIELDS_A, b: FIELDS_B };

  /* 预览底图（仅预览用，不参与打印）：1260×888 的实物证书扫描件，绘制到 185×130mm */
  var PREVIEW_PX_PER_MM = 6;
  var BG_SRC = { a: 'assets/cert/page-a.jpg', b: 'assets/cert/page-b.jpg' };
  var bgImages = { a: null, b: null };
  var bgPromise = null;

  /* 套位偏移：mm，叠加到全部字段坐标；按打印机分别记忆 */
  var OFFSET_LIMIT = 10;
  var OFFSET_KEY_PREFIX = 'haoyue.cert.offset.';

  var records = [];      // 已导入学员 [{name,idNo,...,start:{y,m,d},end,issue, errors, row}]
  var thumbUrls = [];    // 预览图 objectURL（重渲染前释放）
  var offset = { x: 0, y: 0 };
  var previewIndex = 0;
  var previewShowBg = true;
  var printing = false;
  var printJob = null;   // 逐张打印进度 { key, index, total, records }

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

  /* 身份证 18 位校验位（ISO 7064 MOD 11-2） */
  function idCheckChar(id) {
    var w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    var codes = '10X98765432';
    var sum = 0;
    for (var i = 0; i < 17; i++) sum += (id.charCodeAt(i) - 48) * w[i];
    return codes.charAt(sum % 11);
  }

  function isValidIdNo(id) {
    var s = clean(id).toUpperCase();
    if (!/^\d{17}[\dX]$/.test(s)) return false;
    return idCheckChar(s) === s.charAt(17);
  }

  /* 日期先后比较：统一转为 YYYYMMDD 整数 */
  function dateKey(dt) { return dt ? dt.y * 10000 + dt.m * 100 + dt.d : 0; }

  /* 偏移量收敛到 ±10mm、0.1mm 步进 */
  function clampOffset(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    n = Math.round(n * 10) / 10;
    return Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, n));
  }

  function offsetKey(printer) {
    return OFFSET_KEY_PREFIX + (printer || '__default');
  }

  function readOffset(printer) {
    try {
      var raw = window.localStorage && window.localStorage.getItem(offsetKey(printer));
      if (!raw) return { x: 0, y: 0 };
      var o = JSON.parse(raw) || {};
      return { x: clampOffset(o.x), y: clampOffset(o.y) };
    } catch (e) {
      return { x: 0, y: 0 };
    }
  }

  function saveOffset(printer, off) {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(offsetKey(printer),
          JSON.stringify({ x: clampOffset(off && off.x), y: clampOffset(off && off.y) }));
      }
    } catch (e) {
      /* 隐私模式 / 存储不可写：偏移仍在本会话生效 */
    }
  }

  /* 字段最终绘制坐标（版面坐标 + 套位偏移，单位 mm） */
  function fieldDrawPos(f, off) {
    off = off || {};
    return { x: f.x + clampOffset(off.x || 0), y: f.y + clampOffset(off.y || 0) };
  }

  /* 错误行汇总（供预览红字清单与测试复用） */
  function errorLines(list) {
    return (list || []).filter(function (r) { return r.errors && r.errors.length; })
      .map(function (r) { return { row: r.row, name: r.name, reasons: r.errors.slice() }; });
  }

  /* 原始行对象 → 规范化学员记录（含校验信息） */
  function normalizeRecord(raw) {
    raw = raw || {};
    var startText = clean(raw['起始日期']);
    var endText = clean(raw['结束日期']);
    var rec = {
      row: raw.__row || 0,
      idNo: clean(raw['身份证号']).toUpperCase(),
      name: clean(raw['姓名']),
      gender: clean(raw['性别']),
      age: clean(raw['年龄']),
      province: clean(raw['省份']),
      cityCounty: clean(raw['市/县']),
      streetTown: clean(raw['街道/乡镇']),
      start: parseDate(startText),
      end: parseDate(endText),
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
    if (rec.idNo) {
      if (!/^\d{17}[\dX]$/.test(rec.idNo)) rec.errors.push('身份证号需为 18 位');
      else if (!isValidIdNo(rec.idNo)) rec.errors.push('身份证号校验位不正确');
    }
    if (startText && !rec.start) rec.errors.push('起始日期格式不正确');
    if (endText && !rec.end) rec.errors.push('结束日期格式不正确');
    if (rec.start && rec.end && dateKey(rec.start) > dateKey(rec.end)) {
      rec.errors.push('起始日期晚于结束日期');
    }
    if (rec.age && (!/^\d+$/.test(rec.age) || +rec.age < 1 || +rec.age > 120)) {
      rec.errors.push('年龄需为 1-120 的整数');
    }
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
      ['身份证号', '请先把该列设为「文本」再粘贴，避免长数字被 Excel 转成科学计数法；填写时须为 18 位且校验位正确'],
      ['年龄', '填数字，例如 30（1-120 的整数）'],
      ['日期校验', '起始日期不能晚于结束日期；起始 / 结束日期可留空，发证日期必填'],
      ['打印校验', '导入后如有不合规行，会在预览区上方按行号列出原因，该行不参与打印'],
      ['省市县', '省份 = 省（市、自治区）；市/县 = 市县名；街道/乡镇 = 街道或乡镇名'],
      ['培训学校', '证书中「在 ____ 参加」处的学校 / 培训机构名称'],
      ['项目', '证书中「参加 ____ 工种（专业）培训」处的项目名称'],
      ['科目/成绩', '固定两组：科目1 / 成绩1、科目2 / 成绩2'],
      ['打印', '每名学员 2 张 185×130mm 横向（16K 对折）：第 1 张为封面 + 第1页，第 2 张为第2、3页；请使用预印证书纸']
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

  function drawField(ctx, f, text, pxPerMm, off) {
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
    var pos = fieldDrawPos(f, off);
    // Word 中文字顶端对齐；canvas 用 alphabetic 基线，按 ascent 下移
    var baseline = pos.y * pxPerMm + f.pt * ptPx * 0.86;
    ctx.fillText(text, pos.x * pxPerMm, baseline);
  }

  /* 生成单页画布（face: 'a' | 'b'）；withBg 为 false 时输出纯白打印页 */
  function makePageCanvas(face, rec, pxPerMm, off, withBg) {
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(PAGE_MM.w * pxPerMm);
    canvas.height = Math.round(PAGE_MM.h * pxPerMm);
    var ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (withBg !== false && bgImages[face]) {
      try { ctx.drawImage(bgImages[face], 0, 0, canvas.width, canvas.height); } catch (e) { /* 底图缺失时退回白底 */ }
    }
    ctx.fillStyle = '#000000';
    ctx.textBaseline = 'alphabetic';
    (FACES[face] || []).forEach(function (f) {
      drawField(ctx, f, textFor(rec, f.key), pxPerMm, off);
    });
    return canvas;
  }

  /* 校准页：185×130mm 10mm 网格（50mm 加粗）+ 中心十字 + 当前偏移，用于目测套位 */
  function buildCalibrationCanvas(pxPerMm, off) {
    off = off || { x: 0, y: 0 };
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(PAGE_MM.w * pxPerMm);
    canvas.height = Math.round(PAGE_MM.h * pxPerMm);
    var ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    var x, y;
    for (x = 0; x <= PAGE_MM.w + 0.01; x += 10) {
      ctx.strokeStyle = x % 50 === 0 ? '#8a93a6' : '#d5dae3';
      ctx.lineWidth = Math.max(1, pxPerMm * (x % 50 === 0 ? 0.12 : 0.06));
      ctx.beginPath();
      ctx.moveTo(x * pxPerMm, 0);
      ctx.lineTo(x * pxPerMm, canvas.height);
      ctx.stroke();
    }
    for (y = 0; y <= PAGE_MM.h + 0.01; y += 10) {
      ctx.strokeStyle = y % 50 === 0 ? '#8a93a6' : '#d5dae3';
      ctx.lineWidth = Math.max(1, pxPerMm * (y % 50 === 0 ? 0.12 : 0.06));
      ctx.beginPath();
      ctx.moveTo(0, y * pxPerMm);
      ctx.lineTo(canvas.width, y * pxPerMm);
      ctx.stroke();
    }

    var cx = canvas.width / 2;
    var cy = canvas.height / 2;
    ctx.strokeStyle = '#ff5a5a';
    ctx.lineWidth = Math.max(2, pxPerMm * 0.2);
    ctx.beginPath();
    ctx.moveTo(cx - pxPerMm * 6, cy);
    ctx.lineTo(cx + pxPerMm * 6, cy);
    ctx.moveTo(cx, cy - pxPerMm * 6);
    ctx.lineTo(cx, cy + pxPerMm * 6);
    ctx.stroke();

    function mm(v) {
      var n = clampOffset(v);
      return (n >= 0 ? '+' : '') + n.toFixed(1);
    }
    ctx.fillStyle = '#111111';
    ctx.textBaseline = 'top';
    ctx.font = pxPerMm * 2.6 + 'px ' + FONT_FAMILY;
    ctx.fillText('套位校准页 · 185×130mm 横向（16K 对折）', 8 * pxPerMm, 6 * pxPerMm);
    ctx.font = pxPerMm * 2.2 + 'px ' + FONT_FAMILY;
    ctx.fillText('当前偏移：X ' + mm(off.x) + 'mm / Y ' + mm(off.y) + 'mm', 8 * pxPerMm, 11 * pxPerMm);
    ctx.fillText('网格每格 10mm（50mm 加粗）；与预印纸留白比对后调整偏移再正式打印', 8 * pxPerMm, 16 * pxPerMm);
    return canvas;
  }

  function releaseThumbs() {
    thumbUrls.forEach(function (u) {
      try { URL.revokeObjectURL(u); } catch (e) { /* 忽略 */ }
    });
    thumbUrls = [];
  }

  function thumbUrl(face, rec) {
    var canvas = makePageCanvas(face, rec, THUMB_PX_PER_MM, offset, true);
    var url = '';
    try { url = canvas.toDataURL('image/jpeg', 0.9); } catch (e) { url = ''; }
    canvas.width = 0;
    canvas.height = 0;
    return url;
  }

  function pageDataUrl(face, rec) {
    var canvas = makePageCanvas(face, rec, PX_PER_MM, offset, false);
    var url = canvas.toDataURL('image/png');
    canvas.width = 0;
    canvas.height = 0;
    return url;
  }

  /* 证书底图只加载一次；加载完成后重绘预览，避免先出现白底 */
  function loadBackgrounds() {
    if (bgPromise) return bgPromise;
    bgPromise = Promise.all(['a', 'b'].map(function (face) {
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () { bgImages[face] = img; resolve(); };
        img.onerror = function () { bgImages[face] = null; resolve(); };
        img.src = BG_SRC[face];
      });
    })).then(function () {
      if (records.length) renderPreview();
    });
    return bgPromise;
  }

  /* ---------- 大图预览（叠加底图 + 当前偏移） ---------- */

  function drawLargePage(face, rec) {
    var target = $('cert-preview-' + face);
    if (!target) return;
    var source = makePageCanvas(face, rec, PREVIEW_PX_PER_MM, offset, previewShowBg);
    target.width = source.width;
    target.height = source.height;
    var ctx = target.getContext('2d');
    if (ctx) ctx.drawImage(source, 0, 0);
    source.width = 0;
    source.height = 0;
  }

  function renderPreviewModal() {
    var box = $('cert-preview');
    if (!box || box.hidden) return;
    var ok = validRecords();
    if (!ok.length) { closePreview(); return; }
    previewIndex = Math.max(0, Math.min(ok.length - 1, previewIndex));
    var rec = ok[previewIndex];
    $('cert-preview-name').textContent = rec.name || '未命名';
    $('cert-preview-meta').textContent = '第 ' + (previewIndex + 1) + ' / ' + ok.length +
      ' 位 · 表格第 ' + rec.row + ' 行 · 身份证 ' + (rec.idNo || '—');
    drawLargePage('a', rec);
    drawLargePage('b', rec);
    $('cert-preview-prev').disabled = previewIndex <= 0;
    $('cert-preview-next').disabled = previewIndex >= ok.length - 1;
  }

  function openPreview(index) {
    var ok = validRecords();
    if (!ok.length) return;
    previewIndex = Math.max(0, Math.min(ok.length - 1, index));
    $('cert-preview').hidden = false;
    document.body.classList.add('cert-preview-open');
    renderPreviewModal();
    $('cert-preview-close').focus();
  }

  function closePreview() {
    var box = $('cert-preview');
    if (box) box.hidden = true;
    document.body.classList.remove('cert-preview-open');
  }

  function stepPreview(delta) {
    if ($('cert-preview').hidden) return;
    previewIndex += delta;
    renderPreviewModal();
  }

  /* ================= UI ================= */

  function validRecords() {
    return records.filter(function (r) { return r.errors.length === 0; });
  }

  function updateCount() {
    var ok = validRecords().length;
    var bad = records.length - ok;
    var txt = records.length
      ? '已导入 ' + records.length + ' 名学员，可打印 ' + ok + ' 名' + (bad ? '，' + bad + ' 行信息有误（不参与打印）' : '')
      : '未导入学员信息';
    $('cert-count').textContent = txt;
    syncPrintButton();
  }

  function nextPrintButtonText() {
    if (!printJob) return '打印';
    return '打印第 ' + (printJob.index + 1) + ' 张 / 共 ' + printJob.total + ' 张';
  }

  function printButtonText() {
    if (printing) return '正在打印…';
    return nextPrintButtonText();
  }

  function syncPrintButton() {
    var btn = $('cert-print-btn');
    if (!btn) return;
    btn.textContent = printButtonText();
    btn.disabled = printing || validRecords().length === 0 || !bridgeOk();
  }

  /* 记录 / 打印机 / 偏移变化后，重新从头开始逐张打印 */
  function resetPrintJob() {
    if (printing) return;
    var had = !!printJob;
    printJob = null;
    syncPrintButton();
    if (had) {
      var status = $('cert-status');
      if (status) status.textContent = '打印设置或学员信息已变更，下一次点击「打印」将从第 1 张重新开始';
    }
  }

  function printJobKey(ok, printer) {
    return printer + '|' + offset.x + '|' + offset.y + '|' + ok.map(function (r) {
      return r.row + ':' + (r.name || '') + ':' + (r.idNo || '') + ':' +
        (r.issue ? r.issue.y + '-' + r.issue.m + '-' + r.issue.d : '');
    }).join(';');
  }

  /* 预览区上方的红色错误清单：按 Excel 行号列出原因 */
  function renderErrors() {
    var box = $('cert-errors');
    if (!box) return;
    box.textContent = '';
    var bad = errorLines(records);
    if (!bad.length) { box.hidden = true; return; }
    box.hidden = false;
    var title = document.createElement('div');
    title.className = 'cert-errors-title';
    title.textContent = '以下 ' + bad.length + ' 行信息有误，不参与打印（请修正后重新导入）：';
    box.appendChild(title);
    bad.forEach(function (e) {
      var line = document.createElement('div');
      line.textContent = '第 ' + e.row + ' 行' + (e.name ? '（' + e.name + '）' : '') + '：' + e.reasons.join('；');
      box.appendChild(line);
    });
  }

  function renderPreview() {
    releaseThumbs();
    renderErrors();
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
      $('cert-empty').textContent = '没有可打印的学员：请按上方红字列出的行号修正信息后重新导入';
      return;
    }
    ok.forEach(function (rec, i) {
      var card = document.createElement('div');
      card.className = 'cert-card';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', '查看 ' + (rec.name || '未命名') + ' 的证书大图预览');
      card.title = '点击查看大图预览';
      card.addEventListener('click', function () { openPreview(i); });
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPreview(i); }
      });

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

      var hint = document.createElement('div');
      hint.className = 'cert-card-hint';
      hint.textContent = '点击查看大图预览';
      card.appendChild(hint);
      grid.appendChild(card);
    });
    renderPreviewModal();
  }

  function setRecords(list, sourceName) {
    records = list || [];
    resetPrintJob();
    renderPreview();
    updateCount();
    var ok = validRecords().length;
    var bad = records.length - ok;
    $('cert-status').textContent = records.length
      ? '已读取「' + sourceName + '」：可打印 ' + ok + ' 名' + (bad ? '，' + bad + ' 行信息有误，详见预览区上方红字' : '')
      : '';
    if (!records.length) toast('模板中没有读到学员数据（请保留首行表头并填写数据行）', true);
    else if (!ok) toast('没有可打印的学员：请按预览区列出的行号修正后重新导入', true);
    else if (bad) toast('可打印 ' + ok + ' 名，另有 ' + bad + ' 行信息有误（已按行号列出原因）', true);
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

  /* ---------- 套位偏移 UI ---------- */

  function syncOffsetInputs() {
    var xEl = $('cert-offset-x');
    var yEl = $('cert-offset-y');
    if (xEl) xEl.value = clampOffset(offset.x).toFixed(1);
    if (yEl) yEl.value = clampOffset(offset.y).toFixed(1);
  }

  /* 切换打印机时加载该打印机记忆的偏移 */
  function loadOffsetForPrinter() {
    var sel = $('cert-printer');
    offset = readOffset(sel ? sel.value : '');
    syncOffsetInputs();
    resetPrintJob();
  }

  function applyOffsetFromInputs() {
    offset = {
      x: clampOffset($('cert-offset-x').value),
      y: clampOffset($('cert-offset-y').value)
    };
    syncOffsetInputs();
    var sel = $('cert-printer');
    if (sel) saveOffset(sel.value, offset);
    resetPrintJob();
    if (records.length) renderPreview();
  }

  function resetOffset() {
    offset = { x: 0, y: 0 };
    syncOffsetInputs();
    var sel = $('cert-printer');
    if (sel) saveOffset(sel.value, offset);
    resetPrintJob();
    if (records.length) renderPreview();
    toast('已重置当前打印机的套位偏移');
  }

  async function printCalibration() {
    if (!bridgeOk()) { toast('请使用桌面版打印', true); return; }
    resetPrintJob();
    var sel = $('cert-printer');
    var printer = sel ? sel.value : '';
    if (!printer) { toast('请选择打印机', true); return; }
    var status = $('cert-status');
    status.textContent = '正在生成校准页…';
    try {
      var canvas = buildCalibrationCanvas(PX_PER_MM, offset);
      var url = canvas.toDataURL('image/png');
      canvas.width = 0;
      canvas.height = 0;
      var res = await printApi.printImage({
        dataUrls: [url],
        printerName: printer,
        pageSize: { width: 185000, height: 130000 },
        marginType: 'none',
        copies: 1
      });
      if (res && res.ok) {
        status.textContent = '已发送校准页（1 张），请与预印纸留白比对';
        toast('已发送校准页');
      } else {
        status.textContent = '校准页打印失败：' + ((res && res.error) || '未知错误');
        toast('校准页打印失败：' + ((res && res.error) || '未知错误'), true);
      }
    } catch (e) {
      status.textContent = '校准页打印失败：' + ((e && e.message) || e);
      toast('校准页打印失败：' + ((e && e.message) || e), true);
    }
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
    loadOffsetForPrinter();
    if (records.length) renderPreview();
    updateCount();
  }

  async function runPrint() {
    if (printing) return;
    var ok = validRecords();
    if (!ok.length) { toast('没有可打印的学员信息', true); return; }
    if (!bridgeOk()) { toast('请使用桌面版打印', true); return; }
    var printer = $('cert-printer').value;
    if (!printer) { toast('请选择打印机', true); return; }

    var key = printJobKey(ok, printer);
    if (!printJob || printJob.key !== key) {
      var pages = ok.length * 2;
      var bad = records.length - ok.length;
      var yes = await window.App.ui.confirm('将按顺序逐张打印 ' + ok.length + ' 名学员，共 ' + pages +
        ' 张 185×130mm 横向纸（16K 对折，每人 2 张）。每发送一张后需再点击「打印第 N 张」继续，便于更换纸张。' +
        (bad ? '另有 ' + bad + ' 行信息有误不参与打印。' : '') + '确定开始吗？');
      if (!yes) return;
      printJob = { key: key, index: 0, total: pages, records: ok };
    }

    var job = printJob;
    var idx = job.index;
    var rec = job.records[Math.floor(idx / 2)];
    var face = idx % 2 === 0 ? 'a' : 'b';
    var faceLabel = face === 'a' ? '封面 + 第1页' : '第2、3页';
    var status = $('cert-status');

    printing = true;
    updateCount();
    status.textContent = '正在生成第 ' + (idx + 1) + ' 张（' + (rec.name || '未命名') + ' · ' + faceLabel + '）…';
    try {
      var url = pageDataUrl(face, rec);
      status.textContent = '正在发送第 ' + (idx + 1) + ' 张…';
      var res = await printApi.printImage({
        dataUrls: [url],
        printerName: printer,
        pageSize: { width: 185000, height: 130000 },
        marginType: 'none',
        copies: 1
      });
      if (res && res.ok) {
        if (printJob !== job) return;   // 打印期间被清空/重置
        job.index++;
        if (job.index >= job.total) {
          status.textContent = '已全部发送 ' + job.total + ' 张（' + ok.length + ' 名学员），本次打印结束';
          toast('全部 ' + job.total + ' 张已发送打印');
          printJob = null;
        } else {
          status.textContent = '第 ' + (idx + 1) + ' 张已发送（' + (rec.name || '未命名') + ' · ' + faceLabel +
            '）；放好下一张纸后点击「' + nextPrintButtonText() + '」继续';
          toast('第 ' + (idx + 1) + '/' + job.total + ' 张已发送');
        }
      } else {
        status.textContent = '第 ' + (idx + 1) + ' 张打印失败：' + ((res && res.error) || '未知错误') + '，可再次点击「打印」重试';
        toast('打印失败：' + ((res && res.error) || '未知错误'), true);
      }
    } catch (e) {
      status.textContent = '第 ' + (idx + 1) + ' 张打印失败：' + ((e && e.message) || e) + '，可再次点击「打印」重试';
      toast('打印失败：' + ((e && e.message) || e), true);
    } finally {
      printing = false;
      updateCount();
    }
  }

  function clearAll() {
    records = [];
    printJob = null;
    closePreview();
    releaseThumbs();
    $('cert-grid').textContent = '';
    $('cert-file').value = '';
    $('cert-status').textContent = '';
    renderPreview();
    updateCount();
  }

  function enter() {
    refreshPrinters();
    loadBackgrounds();
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
    $('cert-offset-x').addEventListener('change', applyOffsetFromInputs);
    $('cert-offset-y').addEventListener('change', applyOffsetFromInputs);
    $('cert-offset-reset').addEventListener('click', resetOffset);
    $('cert-calibrate').addEventListener('click', printCalibration);
    $('cert-printer').addEventListener('change', function () {
      loadOffsetForPrinter();
      if (records.length) renderPreview();
    });
    loadOffsetForPrinter();
    $('cert-back').addEventListener('click', function () {
      closePreview();
      window.App.batch.showOnly(null);
    });
    $('cert-unsupported').hidden = bridgeOk();
    if (!bridgeOk()) $('cert-printer').disabled = true;

    /* 大图预览：关闭 / 上下一位 / 点击遮罩关闭 / 键盘导航 */
    $('cert-preview-close').addEventListener('click', closePreview);
    $('cert-preview-prev').addEventListener('click', function () { stepPreview(-1); });
    $('cert-preview-next').addEventListener('click', function () { stepPreview(1); });
    $('cert-preview-bg').addEventListener('click', function () {
      previewShowBg = !previewShowBg;
      this.textContent = previewShowBg ? '隐藏底图' : '显示底图';
      renderPreviewModal();
    });
    $('cert-preview').addEventListener('click', function (e) {
      if (e.target === this) closePreview();
    });
    document.addEventListener('keydown', function (e) {
      if ($('cert-preview').hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); closePreview(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepPreview(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepPreview(1); }
    });
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
      textFor: textFor,
      isValidIdNo: isValidIdNo,
      dateKey: dateKey,
      clampOffset: clampOffset,
      offsetKey: offsetKey,
      fieldDrawPos: fieldDrawPos,
      errorLines: errorLines
    }
  };
})();
