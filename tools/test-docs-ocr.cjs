/* ============================================================
 * test-docs-ocr.cjs — OCR 文字识别模块单元测试
 * 文本清理 / 结果拼接 / 导出名 / DOCX XML 生成
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

// 以经典脚本方式加载 docs-ocr.js（模拟 window，不触发 DOM 初始化）
global.window = { App: { ui: { $: () => null, toast: () => {} } } };
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'docs-ocr.js'), 'utf8'));
const T = global.window.App.docsOcr._test;

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}

/* ---------- 1. cleanText 文本清理 ---------- */
assert(T.cleanText('a\r\nb\rc') === 'a\nb\nc', '统一 CRLF / CR 为 LF');
assert(T.cleanText('a  \nb\t') === 'a\nb', '去除行尾空白');
assert(T.cleanText('a\n\n\n\n\nb') === 'a\n\nb', '连续空行压缩为单空行');
assert(T.cleanText('  a\nb  ') === 'a\nb', '整体首尾 trim');
assert(T.cleanText('') === '' && T.cleanText(null) === '', '空 / null 输入得空串');
assert(T.cleanText('中文\r\n \r\nEnglish') === '中文\n\nEnglish', '中英混合与空白行处理');

/* ---------- 2. joinUnits 结果拼接 ---------- */
assert(T.joinUnits([{ label: 'a.jpg', text: 'hello' }]) === 'hello', '单项结果不加分隔头');
assert(T.joinUnits([{ label: 'a.jpg', text: 'one' }, { label: 'b.pdf 第1页', text: 'two' }]) ===
  '===== a.jpg =====\none\n\n===== b.pdf 第1页 =====\ntwo', '多项结果带分隔头');
assert(T.joinUnits([{ label: 'x', text: '' }]) === '（未识别到文字）', '单项空文本给占位说明');
assert(T.joinUnits([{ label: 'x', text: '' }, { label: 'y', text: 'ok' }]) ===
  '===== x =====\n（未识别到文字）\n\n===== y =====\nok', '多项时空文本项也保留');
assert(T.joinUnits([]) === '', '空数组得空串');

/* ---------- 3. exportBaseName 导出名 ---------- */
assert(T.exportBaseName([{ name: 'scan.pdf' }]) === 'scan-识别', '单文件 → 原名-识别（去扩展名）');
assert(T.exportBaseName([{ name: '照片 2026.jpg' }]) === '照片 2026-识别', '中文名保留');
assert(T.exportBaseName([{ name: 'a.pdf' }, { name: 'b.jpg' }]) === '识别结果', '多文件 → 识别结果');
assert(T.exportBaseName([]) === '识别结果', '空列表 → 识别结果');
assert(T.exportBaseName() === '识别结果', '无参 → 识别结果');

/* ---------- 4. escXml 转义 ---------- */
assert(T.escXml('a<b>&"c"d') === 'a&lt;b&gt;&amp;&quot;c&quot;d', 'XML 特殊字符全转义');
assert(T.escXml('普通文本123') === '普通文本123', '普通文本不变');

/* ---------- 5. buildDocxXml document.xml 生成 ---------- */
const xml = T.buildDocxXml('第一行\n\n第三行 & <测试>');
assert(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'), '以 XML 声明开始');
assert(xml.includes('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'), 'w:document 命名空间正确');
assert(xml.includes('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>'), 'A4 页面尺寸 sectPr');
assert((xml.match(/<w:p>/g) || []).length === 3, '三行输入生成 3 个段落（空行也为空段落）');
assert(xml.includes('xml:space="preserve"'), '段落保留空白属性');
assert(xml.includes('第三行 &amp; &lt;测试&gt;'), '段落内容已转义');
assert(!xml.includes('\n'), 'document.xml 为单行（无裸换行）');

/* ---------- 6. buildDocxFiles 最小 OOXML 三件套 ---------- */
const files = T.buildDocxFiles('hello\nworld');
assert(Array.isArray(files) && files.length === 3, '输出 3 个包内文件');
assert(files[0].name === '[Content_Types].xml' && files[1].name === '_rels/.rels' &&
  files[2].name === 'word/document.xml', '包内路径正确');
assert(files.every(function (f) { return f.data instanceof Uint8Array; }), '全部为 Uint8Array');
const dec = new TextDecoder();
const docXml = dec.decode(files[2].data);
assert(docXml === T.buildDocxXml('hello\nworld'), 'document.xml 字节可还原为生成内容');
const ct = dec.decode(files[0].data);
assert(ct.includes('wordprocessingml.document.main+xml'), 'Content_Types 声明 DOCX 主部件');
const rels = dec.decode(files[1].data);
assert(rels.includes('officeDocument') && rels.includes('word/document.xml'), '.rels 指向主文档');

/* ---------- 7. 结构化 DOCX 导出（段落缩进 + 真表格） ---------- */
assert(T.paraXml('正文', 1) ===
  '<w:p><w:pPr><w:ind w:firstLine="480"/></w:pPr><w:r><w:t xml:space="preserve">正文</w:t></w:r></w:p>',
  '段落 XML：indent 输出首行缩进');
assert(T.paraXml('x', 0, 'right').includes('<w:jc w:val="right"/>'), '段落 XML：右对齐输出 jc');
assert(!T.paraXml('x', 0, 'left').includes('<w:jc'), '段落 XML：左对齐省略 jc（默认）');
assert(T.paraXml('a&<b', 0).includes('a&amp;&lt;b'), '段落 XML：内容转义');

const tXml = T.tableXml({
  rows: [['名', '12'], ['额', '9']],
  aligns: ['left', 'right'],
  widths: [2, 1]
}, 9026);
assert(tXml.startsWith('<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>'), '表格 XML 以 tbl + 百分比宽开始');
assert(tXml.includes('<w:tblBorders>') && tXml.includes('<w:insideH w:val="single"'), '表格 XML 全边框');
assert((tXml.match(/<w:gridCol w:w="\d+"\/>/g) || []).length === 2, '表格 XML tblGrid 两列');
assert(tXml.indexOf('w:w="6017"') >= 0 && tXml.indexOf('w:w="3009"') >= 0,
  '列宽按相对比例分配（2:1 → 6017/3009 dxa）');
assert((tXml.match(/<w:jc w:val="right"\/>/g) || []).length === 2, '右对齐列两格均输出 jc');
assert((tXml.match(/<w:tc>/g) || []).length === 4, '2×2 表 4 个单元格');

const docXml2 = T.buildDocxXmlFromUnits([
  { label: '', doc: { blocks: [
    { type: 'p', text: '首行缩进段', indent: 1 },
    { type: 'table', rows: [['名', '12']], aligns: ['left', 'right'], widths: [2, 1] }
  ] } }
]);
assert(docXml2.includes('<w:ind w:firstLine="480"/>'), '结构化导出段落带缩进');
assert(docXml2.includes('<w:tbl>'), '结构化导出含真表格');
assert(/<\/w:tbl><w:p><\/w:p>/.test(docXml2.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/g, '')) ||
  /<\/w:tbl>.{0,40}<w:p><w:r><w:t xml:space="preserve"><\/w:t>/.test(docXml2),
  '表格为最后块级元素时其后补空段落');
assert(!docXml2.includes('====='), '单项导出不加分隔头');

const docXml3 = T.buildDocxXmlFromUnits([
  { label: 'a.jpg', doc: { blocks: [{ type: 'p', text: 'A 段', indent: 0 }] } },
  { label: 'b.jpg', text: 'B1\nB2' }
]);
assert(docXml3.includes('===== a.jpg ====='), '多项导出加分隔头');
assert(docXml3.includes('===== b.jpg =====') && docXml3.includes('B1') && docXml3.includes('B2'),
  '无结构单元回退逐行成段');

// 兼容：字符串入参仍走纯文本路径
const files2 = T.buildDocxFiles('x\ny');
const dec2 = new TextDecoder();
assert(dec2.decode(files2[2].data) === T.buildDocxXml('x\ny'), 'buildDocxFiles 字符串入参兼容旧路径');
const files3 = T.buildDocxFiles([{ label: '', doc: { blocks: [{ type: 'p', text: 'S', indent: 0 }] } }]);
assert(dec2.decode(files3[2].data).includes('S'), 'buildDocxFiles 数组入参走结构化路径');

/* ---------- 8. A4 版心方向（竖向默认 / 横向转置） ---------- */
assert(T.pageSizeXml(false) === '<w:pgSz w:w="11906" w:h="16838"/>', '竖向页面尺寸 11906×16838');
assert(T.pageSizeXml(true) === '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>',
  '横向页面尺寸转置并标 orient=landscape');
assert(T.buildDocxXml('x').includes('<w:pgSz w:w="11906" w:h="16838"/>'), '默认导出为竖向');
assert(T.buildDocxXml('x', { landscape: true }).includes('w:orient="landscape"'),
  '纯文本路径支持横向导出');
const landUnits = T.buildDocxXmlFromUnits([{ label: '', doc: { blocks: [{ type: 'p', text: '横', indent: 0 }] } }],
  { landscape: true });
assert(landUnits.includes('<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>'),
  '结构化路径支持横向导出');
assert(landUnits.includes('<w:tbl') === false && landUnits.includes('横'), '横向导出内容不受影响');
const landFiles = T.buildDocxFiles('a\nb', { landscape: true });
assert(new TextDecoder().decode(landFiles[2].data).includes('orient="landscape"'),
  'buildDocxFiles 字符串入参透传方向');

/* ---------- 9. 方向自动判定 ---------- */
{
  const portrait = T.detectOrient([{ doc: { page: { w: 800, h: 1200 } } }]);
  assert(portrait === 'p', '竖向页（宽高比 < 1.2）判定为竖向');
  const landscape = T.detectOrient([{ doc: { page: { w: 1400, h: 900 } } }]);
  assert(landscape === 'l', '横向页（宽高比 > 1.2）判定为横向');
  const mixed = T.detectOrient([
    { doc: { page: { w: 1400, h: 900 } } },
    { doc: { page: { w: 1400, h: 900 } } },
    { doc: { page: { w: 800, h: 1200 } } }
  ]);
  assert(mixed === 'l', '多页横向占多数时取横向');
  assert(T.detectOrient([{ text: '无结构' }]) === 'p', '无结构信息回退竖向');
}

/* ---------- 11. 行重叠率（纠偏通道结构判据） ---------- */
{
  const overlapped = T.lineOverlapRatio({
    blocks: [{ paragraphs: [{ lines: [
      { bbox: { y0: 10, y1: 60 } },
      { bbox: { y0: 40, y1: 90 } }
    ] }] }]
  });
  assert(overlapped === 1, '相邻行 bbox 垂直重叠计满（1/1）');
  const separated = T.lineOverlapRatio({
    blocks: [{ paragraphs: [{ lines: [
      { bbox: { y0: 10, y1: 34 } },
      { bbox: { y0: 60, y1: 84 } },
      { bbox: { y0: 110, y1: 134 } }
    ] }] }]
  });
  assert(separated === 0, '行间留白无重叠');
  assert(T.lineOverlapRatio(null) === 0, '空数据不报错');
  assert(T.MULTI.skewDeg > 0, '纠偏通道有倾斜阈值');
}

console.log('\n共 ' + (pass + fail) + ' 项断言：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
