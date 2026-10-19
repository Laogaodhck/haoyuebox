/* ============================================================
 * test-pdfcore.cjs — 文档工具共享 PDF 核心单元测试
 * 页码范围解析：单页/区间/开口区间/中英文分隔/越界钳制/去重升序/非法忽略
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

global.window = { App: { ui: { $: () => null, toast: () => {} } } };
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'pdfcore.js'), 'utf8'));
const P = global.window.App.pdfcore;

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- parsePageRanges ---------- */
assert(eq(P.parsePageRanges('3', 10), [3]), '单页');
assert(eq(P.parsePageRanges('1-3', 10), [1, 2, 3]), '闭区间');
assert(eq(P.parsePageRanges('8-', 10), [8, 9, 10]), '开口区间补齐到 max');
assert(eq(P.parsePageRanges('-4', 10), [1, 2, 3, 4]), '省略起点从 1 开始');
assert(eq(P.parsePageRanges('1-3,5,7', 10), [1, 2, 3, 5, 7]), '逗号混合列表');
assert(eq(P.parsePageRanges('1-3，5；7  9', 10), [1, 2, 3, 5, 7, 9]), '中英文分隔符与空白');
assert(eq(P.parsePageRanges('3,1,2,3', 10), [1, 2, 3]), '去重并升序');
assert(eq(P.parsePageRanges('9-12', 10), [9, 10]), '越界钳到 max');
assert(eq(P.parsePageRanges('0-2', 10), [1, 2]), '下界钳到 1');
assert(eq(P.parsePageRanges('5-3', 10), []), '倒序区间忽略');
assert(eq(P.parsePageRanges('abc,--,3x', 10), []), '非法段全部忽略');
assert(eq(P.parsePageRanges('', 10), []), '空字符串');
assert(eq(P.parsePageRanges('1-3', 0), []), 'max 为 0 → 空');
assert(eq(P.parsePageRanges('1~3, 4–5', 10), [1, 2, 3, 4, 5]), '~ 与 – 分隔符');
assert(eq(P.parsePageRanges('2--3', 10), []), '双连字符段忽略');

/* ---------- 导出面 ---------- */
assert(typeof P.loadPdf === 'function' && typeof P.renderPage === 'function', '渲染接口导出');
assert(typeof P.encodeCanvas === 'function' && typeof P.writeBytes === 'function', '编码/写入接口导出');
assert(typeof P.ensureSubDir === 'function' && typeof P.pickOutputDir === 'function', 'FSA 接口导出');

console.log(fail ? `\n结果: ${pass} 通过, ${fail} 失败` : `\n结果: ${pass} 通过, 0 失败`);
process.exit(fail ? 1 : 0);
