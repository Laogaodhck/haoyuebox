/* ============================================================
 * test-print-batch.cjs — 批量打印纯函数单测
 * 旋转归一 / contain 适配 / 文本折行分页 / 类型识别 / HTML 转文本。
 * require js/print-batch.js（浏览器 IIFE，node 下以 window={} 装载）。
 * ============================================================ */
'use strict';

const path = require('path');
const { createChecker } = require('./_lib.cjs');

const t = createChecker();

global.window = { App: { ui: { $: () => null, toast: () => {}, showLoading: () => {}, hideLoading: () => {} } } };
global.URL = URL;
global.Blob = class {};   // 占位（不触发路径）
require(path.join(__dirname, '..', 'js', 'print-batch.js'));

const T = global.window.App.printBatch._test;

/* ---------- 1. 旋转与几何 ---------- */
t.assert(T.normalizeRot(0) === 0 && T.normalizeRot(90) === 90, 'normalizeRot 直角保持');
t.assert(T.normalizeRot(360) === 0 && T.normalizeRot(450) === 90, 'normalizeRot 越界回卷');
t.assert(T.normalizeRot(-90) === 270 && T.normalizeRot(-360) === 0, 'normalizeRot 负角回卷');
t.assert(T.normalizeRot(45) === 90 && T.normalizeRot(10) === 0, 'normalizeRot 非直角取最近 90 倍数');
t.assert(T.nextRot(0) === 90 && T.nextRot(90) === 180 && T.nextRot(270) === 0, 'nextRot 每次 +90°');
t.assert(T.rotatedSize(100, 50, 0).w === 100 && T.rotatedSize(100, 50, 0).h === 50, 'rotatedSize 0° 不变');
t.assert(T.rotatedSize(100, 50, 90).w === 50 && T.rotatedSize(100, 50, 90).h === 100, 'rotatedSize 90° 交换');
t.assert(T.rotatedSize(100, 50, 180).w === 100, 'rotatedSize 180° 不变');
t.assert(T.rotatedSize(100, 50, 270).h === 100, 'rotatedSize 270° 交换');

/* contain：只缩小不放大 */
const f1 = T.fitContain(2000, 1000, 100, 100);
t.assert(f1.w === 100 && f1.h === 50, 'fitContain 宽约束缩放');
const f2 = T.fitContain(500, 1000, 100, 100);
t.assert(f2.w === 50 && f2.h === 100, 'fitContain 高约束缩放');
const f3 = T.fitContain(50, 50, 100, 100);
t.assert(f3.w === 50 && f3.h === 50, 'fitContain 小图不放大');
t.assert(T.fitContain(0, 100, 100, 100).w === 0, 'fitContain 零尺寸兜底');

/* drawParams：90° 旋转时 k 按交换后外接盒计算 */
const dp0 = T.drawParams(1000, 500, 0, 1680, 2376);
t.assert(dp0.dw === 1000 && dp0.dh === 500, 'drawParams 0° 不缩放（小于页面）');
const dp90 = T.drawParams(1000, 500, 90, 1680, 2376);
t.assert(dp90.dw === 1000 && dp90.dh === 500, 'drawParams 90° 旋转后原比例绘制');
const dpBig = T.drawParams(4000, 2000, 90, 100, 200);
/* 旋转后外接盒 2000×4000 → k = min(100/2000, 200/4000) = 0.05 → dw=200 dh=100 */
t.assert(Math.abs(dpBig.dw - 200) < 1e-9 && Math.abs(dpBig.dh - 100) < 1e-9,
  'drawParams 旋转后外接盒正确适配');

/* ---------- 2. 类型识别 / 份数 ---------- */
t.assert(T.docTypeOf('a.PDF') === 'pdf' && T.docTypeOf('b.txt') === 'txt'
  && T.docTypeOf('c.docx') === 'docx' && T.docTypeOf('d.doc') === 'doc', 'docTypeOf 四种扩展');
t.assert(T.docTypeOf('e.exe') === '' && T.docTypeOf('f.jpg') === '' && T.docTypeOf('noext') === '',
  'docTypeOf 非文档返回空');
t.assert(T.extOf('照片.JPG') === 'jpg', 'extOf 大写扩展归一');
t.assert(T.IMG_EXTS.indexOf('webp') >= 0 && T.IMG_EXTS.indexOf('gif') >= 0, 'IMG_EXTS 含 webp/gif');
t.assert(T.clampCopies('5') === 5 && T.clampCopies(0) === 1 && T.clampCopies(-3) === 1
  && T.clampCopies(1000) === 99 && T.clampCopies('abc') === 1, 'clampCopies 钳制 1–99');

/* ---------- 3. 文本折行与分页（mock measureText：10px/字符） ---------- */
const mockCtx = { measureText: (s) => ({ width: s.length * 10 }) };
t.assert(T.splitTextLines(mockCtx, '短行', 100).join('|') === '短行', 'splitTextLines 短行不折');
t.assert(T.splitTextLines(mockCtx, '一二三四五六七八九十甲乙丙丁', 100).join('|') === '一二三四五六七八九十|甲乙丙丁',
  'splitTextLines 超宽折行');
t.assert(T.splitTextLines(mockCtx, '第一段\n\n第二段', 1000).length === 3
  && T.splitTextLines(mockCtx, '第一段\n\n第二段', 1000)[1] === '', 'splitTextLines 空行保留');
t.assert(T.splitTextLines(mockCtx, 'a\r\nb', 1000).join('|') === 'a|b', 'splitTextLines 兼容 CRLF');

const pg = T.paginateRows(['a', 'b', 'c', 'd', 'e'], 2);
t.assert(pg.length === 3 && pg[0].length === 2 && pg[2].length === 1, 'paginateRows 按页行数切分');
t.assert(T.paginateRows([], 5).length === 1, 'paginateRows 空输入返回一页');

/* A4 版面行数：高 297mm*8=2376px，边距 15mm*8=120px，行高 24 → (2376-240)/24 = 89 */
t.assert(T.docLinesPerPage({ w: 210, h: 297 }) === 89, 'docLinesPerPage A4 行数计算');

/* ---------- 4. 文本解码与 HTML 转文本 ---------- */
const utf8 = new TextEncoder().encode('浩玥工具箱 测试');
t.assert(T.decodeText(utf8.buffer) === '浩玥工具箱 测试', 'decodeText UTF-8 正常解码');

t.assert(T.htmlToText('<p>第一段</p><p>第二段</p>') === '第一段\n\n第二段', 'htmlToText 段落换行');
t.assert(T.htmlToText('A<br>B<div>C</div>') === 'A\nB\nC', 'htmlToText br 与 div');
t.assert(T.htmlToText('<b>&amp;</b> &lt;tag&gt; &nbsp;X') === '& <tag>  X', 'htmlToText 实体解码');
t.assert(T.htmlToText('<style>p{}</style><p>正文</p>').indexOf('正文') >= 0
  && T.htmlToText('<style>p{}</style><p>正文</p>').indexOf('p{}') < 0, 'htmlToText 剥离 style');

/* ---------- 5. 大小格式 ---------- */
t.assert(T.fmtSize(0) === '0 B' && T.fmtSize(512) === '512 B', 'fmtSize 字节');
t.assert(T.fmtSize(2048) === '2.0 KB' && T.fmtSize(3 * 1024 * 1024) === '3.0 MB', 'fmtSize KB/MB');
t.assert(T.fmtSize(undefined) === '—' && T.fmtSize(-5) === '—', 'fmtSize 非法值兜底');

/* ---------- 6. 勾选过滤 ---------- */
const items = [
  { name: 'a', checked: true },
  { name: 'b', checked: false },
  { name: 'c' }               /* 新增项默认勾选（undefined 视为勾选） */
];
t.assert(T.isChecked(items[0]) && T.isChecked(items[2]), 'isChecked 默认勾选');
t.assert(!T.isChecked(items[1]), 'isChecked 取消项识别');
t.assert(T.checkedOf(items).length === 2 && T.checkedOf(items)[0].name === 'a'
  && T.checkedOf(items)[1].name === 'c', 'checkedOf 仅保留勾选项');
t.assert(T.checkedOf([]).length === 0 && T.checkedOf(null).length === 0, 'checkedOf 空输入兜底');

t.finish();
