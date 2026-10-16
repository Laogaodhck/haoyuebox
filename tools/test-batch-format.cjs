/* ============================================================
 * test-batch-format.cjs — 批量格式转换模块单元测试
 * 质量钳制 / 输出命名 / PDF 纯 JS 生成器字节结构
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

// 以经典脚本方式加载 batch-format.js（模拟 window，不触发 DOM 初始化）
global.window = {};
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'batch-format.js'), 'utf8'));
const T = global.window.App.batchFormat._test;

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}
function latin1(bytes) { return Buffer.from(bytes).toString('latin1'); }

/* ---------- 1. 质量钳制 ---------- */
assert(T.clampQuality(92) === 92, '正常值 92 保持不变');
assert(T.clampQuality(50) === 50 && T.clampQuality(100) === 100, '边界 50 / 100');
assert(T.clampQuality(10) === 50 && T.clampQuality(150) === 100, '越界钳制');
assert(T.clampQuality('abc') === 50 && T.clampQuality(undefined) === 50, '非法输入回退 50');

/* ---------- 2. 输出命名 ---------- */
assert(T.buildOutputName('照片.png', 'jpeg', {}) === '照片.jpg', '替换扩展名（中文名）');
assert(T.buildOutputName('a.b.c.jpg', 'pdf', {}) === 'a.b.c.pdf', '仅替换最后一段扩展名');
assert(T.buildOutputName('', 'png', {}) === '图片.png', '空名回退「图片」');
const used = {};
assert(T.buildOutputName('a.jpg', 'webp', used) === 'a.webp', '首个同名直接输出');
assert(T.buildOutputName('a.jpg', 'webp', used) === 'a(2).webp', '重名追加 (2)');

/* ---------- 3. 格式与扩展名表 ---------- */
assert(T.FMTS.pdf && T.FMTS.pdf.ext === 'pdf' && T.FMTS.pdf.pdf === true, 'pdf 目标格式存在');
assert(T.FMTS.jpeg.fill === true && T.FMTS.pdf.fill === true, 'jpeg / pdf 需填充透明底色');
assert(T.FMTS.png.fill === false && T.FMTS.webp.fill === false, 'png / webp 保留透明');
assert(T.IMG_EXTS.jpg === 1 && T.IMG_EXTS.jpeg === 1 && T.IMG_EXTS.bmp === 1 && T.IMG_EXTS.gif === 1, '可识别图片后缀表');
assert(!T.IMG_EXTS.tif && !T.IMG_EXTS.heic, 'tif / heic 不在支持表');
assert(T.SUB_DIR === '转换输出', '输出子文件夹名');

/* ---------- 4. PDF 页面内容流 ---------- */
assert(T.pdfPageContent(595, 842) === 'q 595 0 0 842 0 0 cm /Im0 Do Q', '内容流 cm 矩阵铺满整页');

/* ---------- 5. PDF 生成器：单页字节结构 ---------- */
const jpeg1 = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x01, 0x02, 0xFF, 0xD9]); // 伪 JPEG（含 SOI/EOI）
const pdf1 = T.buildPdf([{ jpeg: jpeg1, w: 100, h: 200 }]);
const s1 = latin1(pdf1);

assert(s1.startsWith('%PDF-1.4\n'), '以 %PDF-1.4 头开始');
assert(pdf1[9] === 0x25 && pdf1[10] > 127, '二进制注释行含高位字节（第 10 字节起）');
assert(s1.includes('/Type /Catalog'), 'obj1 Catalog 存在');
assert(s1.includes('/Type /Pages') && s1.includes('/Count 1'), 'obj2 Pages / Count 1');
assert(s1.includes('[3 0 R]'), 'Kids 指向首页对象 3');
assert((s1.match(/\/Type \/Page[^s]/g) || []).length === 1, '恰好 1 个 Page 对象');
assert(s1.includes('/MediaBox [0 0 100 200]'), 'MediaBox 为图片尺寸');
assert(s1.includes('/Filter /DCTDecode'), '图像使用 DCTDecode');
assert(s1.includes('/Width 100') && s1.includes('/Height 200'), '图像宽高声明');
assert(s1.includes('/ColorSpace /DeviceRGB') && s1.includes('/BitsPerComponent 8'), 'DeviceRGB / 8bit');
assert(s1.includes('q 100 0 0 200 0 0 cm /Im0 Do Q'), '内容流铺满页面');
// JPEG 原始字节必须原样嵌入流中
let jpegPos = -1;
for (let i = 0; i + jpeg1.length <= pdf1.length; i++) {
  let hit = true;
  for (let j = 0; j < jpeg1.length; j++) { if (pdf1[i + j] !== jpeg1[j]) { hit = false; break; } }
  if (hit) { jpegPos = i; break; }
}
assert(jpegPos > 0, 'JPEG 字节完整嵌入');
assert(s1.lastIndexOf('/Length ' + jpeg1.length) > 0, '/Length 与 JPEG 字节数一致');
assert(s1.endsWith('%%EOF'), '以 %%EOF 结束');

/* ---------- 6. xref 表可解析 ---------- */
const sxm = s1.match(/startxref\n(\d+)\n/);
assert(!!sxm, 'startxref 存在');
const xrefStart = +sxm[1];
assert(s1.slice(xrefStart, xrefStart + 4) === 'xref', 'startxref 指向 xref 表');
const cntm = s1.slice(xrefStart).match(/xref\n0 (\d+)\n/);
assert(!!cntm && +cntm[1] === 6, 'xref 条目数 = 对象总数 + 1（单页 5 对象 + 0 号 = 6）');
// 解析每个对象条目，偏移处应为 "N 0 obj"（条目：10 位偏移 + 空格 + 5 位代 + 空格 + n/f + 空格 + \n = 20 字节）
const xrefBody = s1.slice(xrefStart);
const lines = xrefBody.split('\n');
let okOffsets = 0;
for (let objNum = 1; objNum <= 3; objNum++) {
  const entry = lines[2 + objNum]; // 0: xref, 1: "0 N", 2: 空闲项, 3+: 对象
  const off = parseInt(entry.slice(0, 10), 10);
  const tag = entry.slice(17, 18);
  if (tag === 'n' && s1.slice(off, off + String(objNum).length + 6) === objNum + ' 0 obj') okOffsets++;
}
assert(okOffsets === 3, 'xref 偏移逐项可解析（obj1-3）');
assert(lines[2].slice(0, 10) === '0000000000' && lines[2].slice(17, 18) === 'f', '0 号空闲项');
assert(s1.includes('0000000000 65535 f \n'), '空闲项条目定长 20 字节（含结尾 \\n）');

/* ---------- 7. 多页 PDF ---------- */
const pdf2 = T.buildPdf([
  { jpeg: jpeg1, w: 100, h: 200 },
  { jpeg: jpeg1, w: 300, h: 400 }
]);
const s2 = latin1(pdf2);
assert(s2.includes('/Count 2'), 'Count 2');
assert(s2.includes('[3 0 R 6 0 R]'), 'Kids 指向 3 / 6');
assert((s2.match(/\/Type \/Page[^s]/g) || []).length === 2, '恰好 2 个 Page 对象');
assert(s2.includes('/MediaBox [0 0 300 400]'), '第二页 MediaBox');
const sxm2 = s2.match(/startxref\n(\d+)\n/);
assert(s2.slice(+sxm2[1], +sxm2[1] + 4) === 'xref', '多页 startxref 仍可解析');
assert(/xref\n0 9\n/.test(s2.slice(+sxm2[1])), '多页 xref 条目数 9（2 页 × 3 + 3）');
const c1 = +sxm[1], c2 = +sxm2[1];
assert(c2 > c1, '页数增加则文件增大');

console.log('\n结果： ' + pass + ' 通过， ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
