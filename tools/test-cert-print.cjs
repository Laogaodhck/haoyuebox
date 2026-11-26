/* ============================================================
 * test-cert-print.cjs — 结业证打印模块单元测试
 * 日期解析 / 表头别名 / 记录规范化 / 模板表结构 / 版面坐标边界 /
 * XLSX 读取（store + deflate-raw、inlineStr + sharedStrings、长编号不丢精度）
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

global.window = {
  App: {
    ui: {
      $: () => null,
      toast: () => {},
      download: () => {},
      confirm: () => Promise.resolve(false)
    }
  }
};
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'xlsx-lite.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'zip.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'cert-print.js'), 'utf8'));

const C = global.window.App.certPrint._test;
const XL = global.window.App.xlsxLite;
const Zip = global.window.ZipUtil;

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}
const enc = new TextEncoder();

/* ---------- 1. 日期解析 ---------- */
{
  const a = C.parseDate('2026-10-14');
  assert(a && a.y === 2026 && a.m === 10 && a.d === 14, 'YYYY-MM-DD');
  const b = C.parseDate('2026/2/9');
  assert(b && b.m === 2 && b.d === 9, 'YYYY/M/D 单位数');
  const c = C.parseDate('2026年10月14日');
  assert(c && c.y === 2026 && c.m === 10 && c.d === 14, '中文年月日');
  const d = C.parseDate('20261014');
  assert(d && d.y === 2026 && d.m === 10 && d.d === 14, '紧凑 8 位');
  const serial = 45000;
  const dt = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  const e = C.parseDate(serial);
  assert(e && e.y === dt.getUTCFullYear() && e.m === dt.getUTCMonth() + 1 && e.d === dt.getUTCDate(),
    'Excel 日期序列号');
  assert(C.parseDate('2026-13-40') === null, '非法日期返回 null');
  assert(C.parseDate('') === null && C.parseDate(null) === null, '空值返回 null');
  assert(C.pad2(9) === '09' && C.pad2(10) === '10', '月/日补零');
}

/* ---------- 2. 表头别名与规范化 ---------- */
assert(C.normHeader(' 姓 名 ') === '姓名', '表头去空白');
assert(C.normHeader('学员姓名') === '姓名', '别名：学员姓名 → 姓名');
assert(C.normHeader('身份证号码') === '身份证号', '别名：身份证号码 → 身份证号');
assert(C.normHeader('街道乡镇') === '街道/乡镇', '别名：街道乡镇 → 街道/乡镇');
assert(C.normHeader('专业') === '项目', '别名：专业 → 项目');
assert(C.normHeader('发证时间') === '发证日期', '别名：发证时间 → 发证日期');

/* ---------- 3. 记录规范化与校验 ---------- */
{
  const rows = [
    C.HEADERS.slice(),
    ['11010519491231002X', '张三', '男', '30', '示例省', '示例市', '示例乡镇', '2026-02-10', '2026-10-14', '示例培训学校', '示例项目', '2026-10-14', '科目一', '合格', '科目二', '80'],
    ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['123456789012345679', '', '男', '31', '示例省', '示例市', '示例乡镇', '', '', '', '', '2026-10-14', '', '', '', '']
  ];
  const list = C.recordsFromRows(rows);
  assert(list.length === 2, '空行跳过，保留 2 行');
  assert(list[0].name === '张三' && list[0].age === '30', '姓名 / 年龄读取');
  assert(list[0].start && list[0].start.m === 2 && list[0].start.d === 10, '起始日期拆分');
  assert(list[0].issue && list[0].issue.y === 2026, '发证日期读取');
  assert(list[0].errors.length === 0, '完整行无错误');
  assert(list[1].errors.indexOf('姓名为空') >= 0, '缺姓名被标记');
}
assert(C.recordsFromRows([]).length === 0, '空表返回空数组');

/* ---------- 3b. 身份证 / 日期区间 / 年龄校验 ---------- */
{
  assert(C.isValidIdNo('11010519491231002X'), '身份证校验位正确（X 结尾）');
  assert(!C.isValidIdNo('11010519491231002'), '17 位身份证不通过');
  assert(!C.isValidIdNo('110105194912310020'), '校验位错误不通过');
  assert(!C.isValidIdNo('11010519491231002Y'), '非法校验字符不通过');
  assert(!C.isValidIdNo(''), '空身份证不参与校验');

  const badId = C.normalizeRecord({ '姓名': '李四', '身份证号': '110105194912310020', '发证日期': '2026-07-01' });
  assert(badId.errors.indexOf('身份证号校验位不正确') >= 0, '身份证校验位错误被标记');
  const shortId = C.normalizeRecord({ '姓名': '李四', '身份证号': '11010519491231002', '发证日期': '2026-07-01' });
  assert(shortId.errors.indexOf('身份证号需为 18 位') >= 0, '身份证非 18 位被标记');

  const reversed = C.normalizeRecord({
    '姓名': '王五', '发证日期': '2026-07-01', '起始日期': '2026-10-14', '结束日期': '2026-02-10'
  });
  assert(reversed.errors.indexOf('起始日期晚于结束日期') >= 0, '起始日期晚于结束日期被标记');

  const badDate = C.normalizeRecord({ '姓名': '王五', '发证日期': '2026-07-01', '起始日期': '2026-13-40' });
  assert(badDate.errors.indexOf('起始日期格式不正确') >= 0, '无效起始日期被标记');

  const badAge = C.normalizeRecord({ '姓名': '赵六', '发证日期': '2026-07-01', '年龄': '0' });
  assert(badAge.errors.indexOf('年龄需为 1-120 的整数') >= 0, '年龄越界被标记');
  const bigAge = C.normalizeRecord({ '姓名': '赵六', '发证日期': '2026-07-01', '年龄': '121' });
  assert(bigAge.errors.indexOf('年龄需为 1-120 的整数') >= 0, '年龄超过 120 被标记');
  const okAge = C.normalizeRecord({ '姓名': '赵六', '发证日期': '2026-07-01', '年龄': '30' });
  assert(okAge.errors.length === 0, '合法年龄无错误');
  assert(C.normalizeRecord({ '姓名': '赵六', '发证日期': '2026-07-01', '年龄': '' }).errors.length === 0,
    '年龄留空不报错');
}

/* ---------- 3c. 错误清单（不含有效行，带行号） ---------- */
{
  const list = [
    C.normalizeRecord({ __row: 2, '姓名': '张三', '身份证号': '11010519491231002X', '发证日期': '2026-07-01' }),
    C.normalizeRecord({ __row: 5, '姓名': '', '发证日期': '2026-07-01' })
  ];
  const bad = C.errorLines(list);
  assert(bad.length === 1 && bad[0].row === 5, '错误清单只含问题行并保留行号');
  assert(bad[0].reasons.indexOf('姓名为空') >= 0, '错误清单包含具体原因');
}

/* ---------- 3d. 套位偏移（±10mm / 0.1mm 步进 / 字段叠加） ---------- */
{
  assert(C.clampOffset(1.24) === 1.2 && C.clampOffset(-1.26) === -1.3, '偏移按 0.1mm 取整');
  assert(C.clampOffset(99) === 10 && C.clampOffset(-99) === -10, '偏移收敛到 ±10mm');
  assert(C.clampOffset('abc') === 0 && C.clampOffset('') === 0, '非法偏移归零');
  const f = C.FACES.b[0];
  const pos = C.fieldDrawPos(f, { x: 0.5, y: -1.2 });
  assert(Math.abs(pos.x - (f.x + 0.5)) < 1e-9 && Math.abs(pos.y - (f.y - 1.2)) < 1e-9, '字段坐标叠加偏移');
  const base = C.fieldDrawPos(f, { x: 0, y: 0 });
  assert(base.x === f.x && base.y === f.y, '零偏移保持原坐标');
  assert(C.offsetKey('HP-1020') === 'haoyue.cert.offset.HP-1020', '偏移按打印机名分键存储');
  assert(C.offsetKey('') === 'haoyue.cert.offset.__default', '无打印机名时使用默认键');
}

/* ---------- 4. 模板表结构 ---------- */
{
  const sheets = C.buildTemplateSheets();
  assert(sheets.length === 2 && sheets[0].name === '学员信息' && sheets[1].name === '填写说明', '两个工作表');
  const rows = sheets[0].table.rows;
  assert(rows[0].length === C.HEADERS.length, '表头列数一致');
  assert(rows[0][0] === '身份证号' && rows[0][11] === '发证日期', '表头顺序（身份证号…发证日期）');
  assert(rows[1].length === C.HEADERS.length, '示例行列数一致');
  assert(rows[1][0] === C.EXAMPLE_ROW[0], '示例行身份证号');
  assert(sheets[1].table.rows.length >= 8, '填写说明含多条说明');
}

/* ---------- 5. 版式坐标 ---------- */
{
  assert(C.PAGE_MM.w === 210 && C.PAGE_MM.h === 148, 'A5 横向 210×148mm');
  const a = C.FACES.a, b = C.FACES.b;
  assert(a.length === 4 && b.length === 21, '第1页 4 个字段，第2、3页 21 个字段');
  let inBounds = true;
  a.concat(b).forEach(function (f) {
    if (!(f.x >= 0 && f.x < C.PAGE_MM.w && f.y >= 0 && f.y < C.PAGE_MM.h)) inBounds = false;
  });
  assert(inBounds, '全部字段落在 A5 版面内');
  assert(a.every(function (f) { return f.x > 105; }), '第1页字段位于右半版（封面左侧留空）');
  const keys = b.map(function (f) { return f.key; });
  assert(keys.indexOf('name') >= 0 && keys.indexOf('cityCounty') >= 0 && keys.indexOf('streetTown') >= 0,
    '第2页包含姓名 / 市/县 / 街道/乡镇');
  assert(keys.filter(function (k) { return k === 'issueY'; }).length === 1, '第2页发证日期年字段唯一');
  assert(keys.indexOf('subj1') >= 0 && keys.indexOf('score2') >= 0, '第3页包含两组科目 / 成绩');
}

/* ---------- 6. XLSX 读取：store 模式（本模块导出的模板） ---------- */
function zipOf(files) {
  return Zip.store(files).arrayBuffer().then(function (b) { return new Uint8Array(b); });
}
async function compressRaw(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
/* 构造指定压缩方式的 ZIP（用于模拟 Excel / WPS 保存后的压缩包） */
async function buildZip(entries, method) {
  const locals = [], central = [];
  let offset = 0;
  const now = new Date();
  const dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dd = (((now.getFullYear() - 1980) & 0x7F) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const e of entries) {
    const name = enc.encode(e.name);
    const raw = e.data;
    const data = method === 8 ? await compressRaw(raw) : raw;
    const crc = Zip.crc32(raw);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, method, true); lv.setUint16(10, dt, true); lv.setUint16(12, dd, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    local.set(name, 30); local.set(data, 30 + name.length);
    locals.push(local);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true); cv.setUint16(10, method, true);
    cv.setUint16(12, dt, true); cv.setUint16(14, dd, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length;
  }
  const cdSize = central.reduce((s, x) => s + x.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true); ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const total = locals.reduce((s, x) => s + x.length, 0) + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  locals.concat(central, [eocd]).forEach(function (part) { out.set(part, p); p += part.length; });
  return out;
}

(async function () {
  /* 6a. 模板导出 → 解析回来 */
  const templateFiles = XL.buildXlsxFiles(C.buildTemplateSheets());
  const stored = await zipOf(templateFiles);
  const back = await C.parseXlsxBuffer(stored);
  assert(back.length === 1, 'store 模式：读回 1 行示例');
  assert(back[0].name === '张三' && back[0].idNo === '11010519491231002X', 'store 模式：姓名 / 身份证号');
  assert(back[0].issue && back[0].issue.y === 2026 && back[0].issue.m === 7, 'store 模式：发证日期');
  assert(back[0].subj2 === '科目二' && back[0].score2 === '80', 'store 模式：第二组科目 / 成绩');
  assert(back[0].errors.length === 0, 'store 模式：记录校验通过');

  /* 6b. deflate 模式 + sharedStrings + 数值长编号 + Excel 日期序列号 */
  const sheetXml = '<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>' +
    '<row r="1">' +
    '<c r="A1" t="inlineStr"><is><t>姓名</t></is></c>' +
    '<c r="B1" t="inlineStr"><is><t>身份证号</t></is></c>' +
    '<c r="C1" t="inlineStr"><is><t>发证日期</t></is></c>' +
    '</row>' +
    '<row r="2">' +
    '<c r="A2" t="s"><v>0</v></c>' +
    '<c r="B2"><v>11010519491231002X</v></c>' +
    '<c r="C2"><v>45000</v></c>' +
    '</row></sheetData></worksheet>';
  const sstXml = '<?xml version="1.0" encoding="UTF-8"?><sst><si><t>张三</t></si></sst>';
  const zipped = await buildZip([
    { name: 'xl/sharedStrings.xml', data: enc.encode(sstXml) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml) }
  ], 8);
  const list = await C.parseXlsxBuffer(zipped);
  assert(list.length === 1, 'deflate 模式：读回 1 行');
  assert(list[0].name === '张三', 'deflate + sharedStrings：姓名');
  assert(list[0].idNo === '11010519491231002X', 'deflate：18 位身份证号不丢精度');
  assert(list[0].issue && list[0].issue.y === 2023, 'deflate：Excel 日期序列号解析');
  assert(list[0].errors.length === 0, 'deflate：记录校验通过');

  /* 6c. 无效文件 */
  let rejected = false;
  try { await C.parseXlsxBuffer(new Uint8Array([1, 2, 3, 4])); }
  catch (e) { rejected = /xlsx|ZIP/.test(e.message); }
  assert(rejected, '非 xlsx 文件给出可读错误');

  /* 6d. 压缩解压往返 */
  const raw = enc.encode('hello-cert');
  const packed = await compressRaw(raw);
  const unpacked = await C.inflateRaw(packed);
  assert(Buffer.from(unpacked).toString('utf8') === 'hello-cert', 'deflate-raw 解压往返');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
