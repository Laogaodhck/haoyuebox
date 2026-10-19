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

console.log('\n共 ' + (pass + fail) + ' 项断言：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
