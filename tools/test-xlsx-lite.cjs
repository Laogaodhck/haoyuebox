/* ============================================================
 * test-xlsx-lite.cjs — 结构化 Excel 导出（SpreadsheetML 生成）单元测试
 * 列字母 / 工作表名清洗去重 / 数值判定 / 样式映射 / 列宽换算 /
 * 工作表 XML（表格行列 + 对齐 + 表头加粗 + 转义）/ 包内路径 / 多表组装
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

global.window = { App: {} };
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'xlsx-lite.js'), 'utf8'));
const L = global.window.App.xlsxLite;
const T = L._test;

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}
const dec = new TextDecoder();
function fileByName(files, name) {
  const hit = files.filter(function (f) { return f.name === name; })[0];
  return hit ? dec.decode(hit.data) : null;
}

/* ---------- 1. 列字母 ---------- */
assert(T.colLetter(0) === 'A' && T.colLetter(25) === 'Z', 'A..Z 单字母');
assert(T.colLetter(26) === 'AA' && T.colLetter(27) === 'AB', 'AA / AB 进位');
assert(T.colLetter(51) === 'AZ' && T.colLetter(52) === 'BA', 'AZ / BA 进位');

/* ---------- 2. 工作表名清洗与去重 ---------- */
assert(T.sanitizeSheetName('表[1]:*?/\\格') === '表 1 格', '非法字符替换为空格并清理');
assert(T.sanitizeSheetName('') === '表格', '空名给默认名');
assert(T.sanitizeSheetName('x'.repeat(40)).length === 31, '超长名截断到 31 字符');
{
  const used = {};
  assert(T.sanitizeSheetName('扫描件', used) === '扫描件', '首个同名保留原名');
  assert(T.sanitizeSheetName('扫描件', used) === '扫描件(2)', '重名追加序号');
  assert(T.sanitizeSheetName('扫描件', used) === '扫描件(3)', '第三次重名递增序号');
  const usedLong = {};
  const longName = 'y'.repeat(40);
  const second = T.sanitizeSheetName(longName, usedLong);
  assert(second.length <= 31, '截断后重名仍不超过 31 字符');
}

/* ---------- 3. 数值判定（证件号/长编号保持文本） ---------- */
assert(T.isNumericCell('123') === true, '整数识别为数值');
assert(T.isNumericCell('-4.5') === true, '负数小数识别为数值');
assert(T.isNumericCell('0012') === false, '前导零保持文本');
assert(T.isNumericCell('123456789012345678') === false, '18 位编号保持文本（避免精度截断）');
assert(T.isNumericCell('13812345678') === true, '11 位手机号可存数值');
assert(T.isNumericCell('12,000') === false, '带千分位保持文本');
assert(T.isNumericCell('') === false && T.isNumericCell('abc') === false, '空串 / 非数字为文本');

/* ---------- 4. 样式与列宽 ---------- */
assert(T.styleIndex('left') === 0 && T.styleIndex('center') === 1 && T.styleIndex('right') === 2,
  '对齐映射 0/1/2');
assert(T.styleIndex('left', true) === 3 && T.styleIndex('right', true) === 5, '加粗样式偏移 +3');
assert(T.excelColWidth(120) === 16, '列宽像素换算字符宽（120px → 16）');
assert(T.excelColWidth(10) === 8, '列宽下限 8');
assert(T.excelColWidth(9999) === 60, '列宽上限 60');

/* ---------- 5. 工作表 XML ---------- */
{
  const xml = T.buildSheetXml({
    rows: [['项目', '数量'], ['合计', '12'], ['均摊', '9']],
    aligns: ['left', 'right'],
    widths: [150, 75]
  });
  assert(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'),
    'XML 声明开头');
  assert(xml.includes('<dimension ref="A1:B3"/>'), 'dimension 覆盖数据区');
  assert((xml.match(/<row r="\d+">/g) || []).length === 3, '三行数据');
  assert((xml.match(/<col min="\d+" max="\d+" width="\d+" customWidth="1"\/>/g) || []).length === 2,
    '两列列宽定义');
  assert(xml.includes('width="20"') && xml.includes('width="10"'), '列宽按相对宽度换算（150→20、75→10）');
  assert(xml.includes('<c r="A1" s="3" t="inlineStr">'), '表头左列加粗样式 s=3');
  assert(xml.includes('<c r="B1" s="5" t="inlineStr">'), '表头右列加粗右对齐样式 s=5');
  assert(/<c r="B2" s="2"><v>12<\/v><\/c>/.test(xml), '数值单元格输出 <v> 且保留右对齐');
  assert(xml.includes('t="inlineStr"') && xml.includes('<is><t xml:space="preserve">合计</t></is>'),
    '文本单元格走 inlineStr');
  const esc = T.buildSheetXml({ rows: [['a&<b>', 'c']], aligns: [], widths: [] });
  assert(esc.includes('a&amp;&lt;b&gt;'), '单元格文本 XML 转义');
  const empty = T.buildSheetXml({ rows: [['']], aligns: [], widths: [] });
  assert(!empty.includes('<c '), '空单元格不输出 c 元素');
}

/* ---------- 6. 包结构与关系 ---------- */
{
  const files = L.buildXlsxFiles([
    { name: '第1页', table: { rows: [['名', '12']], aligns: ['left', 'right'], widths: [100, 50] } },
    { name: '第2页', table: { rows: [['额', '9']], aligns: ['left', 'right'], widths: [100, 50] } }
  ]);
  assert(Array.isArray(files) && files.length === 7, '两表包内 7 个部件（5 公共 + 2 工作表）');
  assert(files.every(function (f) { return f.data instanceof Uint8Array; }), '全部为 Uint8Array');
  const names = files.map(function (f) { return f.name; });
  ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels',
   'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'].forEach(function (n) {
    assert(names.indexOf(n) >= 0, '包含部件 ' + n);
  });
  const wb = fileByName(files, 'xl/workbook.xml');
  assert(wb.includes('<sheet name="第1页" sheetId="1" r:id="rId1"/>') &&
    wb.includes('<sheet name="第2页" sheetId="2" r:id="rId2"/>'), 'workbook 两张表带关系 id');
  const rels = fileByName(files, 'xl/_rels/workbook.xml.rels');
  assert(rels.includes('Target="worksheets/sheet1.xml"') && rels.includes('Target="styles.xml"'),
    'workbook.rels 指向工作表与样式');
  assert(/Id="rId3" Type="[^"]+\/styles"/.test(rels), '样式关系 id 排在表之后（rId3）');
  const ct = fileByName(files, '[Content_Types].xml');
  assert((ct.match(/spreadsheetml\.worksheet\+xml/g) || []).length === 2, 'Content_Types 每表一个 Override');
  assert(ct.includes('spreadsheetml.sheet.main+xml') && ct.includes('spreadsheetml.styles+xml'),
    'Content_Types 声明工作簿与样式');
  const styles = fileByName(files, 'xl/styles.xml');
  assert((styles.match(/<xf /g) || []).length === 7, 'styles 含 1 个 cellStyleXfs + 6 个 cellXfs');
  assert(styles.includes('<b/>') && styles.includes('horizontal="right"'), '样式含加粗与右对齐定义');
  files.forEach(function (f) {
    assert(dec.decode(f.data).indexOf('<?xml') === 0, f.name + ' 以 XML 声明开头');
  });
}

/* ---------- 7. 识别单元 → 工作簿 ---------- */
{
  const table = { rows: [['项目', '数量'], ['合计', '9']], aligns: ['left', 'right'], widths: [120, 60] };
  const built = L.buildXlsxFromUnits([
    { label: 'a.jpg 第1页', doc: { blocks: [{ type: 'p', text: '说明文字' }, { type: 'table', rows: table.rows, aligns: table.aligns, widths: table.widths }] } },
    { label: 'a.jpg 第2页', doc: { blocks: [{ type: 'p', text: '纯文本页' }] } },
    { label: 'b.jpg', doc: { blocks: [{ type: 'table', rows: table.rows, aligns: table.aligns, widths: table.widths }] } }
  ]);
  assert(!!built && built.stats.sheets === 2, '仅表格块成表（纯文本页跳过）');
  assert(built.stats.rows === 4 && built.stats.cells === 8, '统计行数与单元格数');
  assert(built.stats.names.join(',') === 'a.jpg 第1页,b.jpg', '工作表名取单元标签');
  assert(built.files.length === 7, '两表 7 个部件');
  assert(L.buildXlsxFromUnits([{ label: 'x', text: '没有表格' }]) === null, '无表格返回 null');
  assert(L.buildXlsxFromUnits([]) === null && L.buildXlsxFromUnits() === null, '空入参返回 null');
  // 同名标签去重
  const dup = L.buildXlsxFromUnits([
    { label: '扫描件', doc: { blocks: [{ type: 'table', rows: table.rows, aligns: table.aligns, widths: table.widths }] } },
    { label: '扫描件', doc: { blocks: [{ type: 'table', rows: table.rows, aligns: table.aligns, widths: table.widths }] } }
  ]);
  assert(dup.stats.names.join(',') === '扫描件,扫描件(2)', '同名标签工作表自动去重');
}

console.log('\n共 ' + (pass + fail) + ' 项断言：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
