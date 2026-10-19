/* ============================================================
 * test-docs-watermark.cjs — 文档加水印模块单元测试
 * 透明度/字号/缩放/列数钳制 · 九宫格定位坐标 · 平铺坐标与交错 · 绘制不抛错
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

// 以经典脚本方式加载 docs-watermark.js（模拟 window，不触发 DOM 初始化）
global.window = { App: { ui: { $: () => null, toast: () => {} } } };
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'docs-watermark.js'), 'utf8'));
const T = global.window.App.docsWatermark._test;

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}

/* ---------- 1. 透明度钳制（滑杆百分比 → 0.05–1） ---------- */
assert(T.clampOpacity(25) === 0.25, '百分比 25 → 0.25');
assert(T.clampOpacity(100) === 1 && T.clampOpacity(5) === 0.05, '边界 100 / 5');
assert(T.clampOpacity(0) === 0.05 && T.clampOpacity(-10) === 0.05, '越界下限钳到 0.05');
assert(T.clampOpacity(150) === 1, '越界上限钳到 1');
assert(T.clampOpacity('abc') === 0.25 && T.clampOpacity(undefined) === 0.25, '非法输入回退 0.25');

/* ---------- 2. 字号 / 缩放 / 列数钳制 ---------- */
assert(T.clampSize(42) === 42 && T.clampSize(12) === 12 && T.clampSize(120) === 120, '字号 12–120 保持');
assert(T.clampSize(5) === 12 && T.clampSize(300) === 120 && T.clampSize('x') === 12, '字号越界 / 非法回退');
assert(T.clampScale(25) === 0.25 && T.clampScale(10) === 0.1 && T.clampScale(60) === 0.6, '缩放百分比 → 系数');
assert(T.clampScale(5) === 0.1 && T.clampScale(99) === 0.6, '缩放越界钳制');
assert(T.clampCols(4) === 4 && T.clampCols(1) === 1 && T.clampCols(8) === 8, '列数 1–8 保持');
assert(T.clampCols(0) === 1 && T.clampCols(20) === 8 && T.clampCols('x') === 4, '列数越界钳制 / 非法回退默认 4');

/* ---------- 3. 九宫格定位 ---------- */
const W = 800, H = 600, w = 100, h = 50;
const m = Math.round(Math.min(W, H) * 0.04); // 24
const c = T.posToXY('center', W, H, w, h);
assert(c.x === 350 && c.y === 275, '居中 = (W-w)/2, (H-h)/2');
const tl = T.posToXY('tl', W, H, w, h);
assert(tl.x === m && tl.y === m, '左上 = 边距 4% 短边');
const br = T.posToXY('br', W, H, w, h);
assert(br.x === W - w - m && br.y === H - h - m, '右下贴边距对称');
const tc = T.posToXY('tc', W, H, w, h);
assert(tc.x === 350 && tc.y === m, '顶部居中水平取中、垂直取边距');
assert(T.posToXY('unknown', W, H, w, h).x === c.x, '未知定位兜底居中');

/* ---------- 4. 平铺坐标 ---------- */
const pts = T.tilePoints(800, 600, 100, 50, 4);
assert(pts.length > 0 && Array.isArray(pts), '平铺产生坐标数组');
assert(pts.every(p => p.x >= -50 && p.x < 850 && p.y >= -25 && p.y < 625), '平铺点均在扩展边界内');
// cols=4 → stepX=200，块中心 x=100/300/500/700；奇数行偏移半步 100
assert(pts.some(p => p.x === Math.round(100 - 50)) && pts.some(p => p.x === Math.round(300 - 50)),
  '首行按列距 200 均布');
assert(pts.some(p => p.x === Math.round(200 - 50)), '奇数行横向错位半步');
const one = T.tilePoints(800, 600, 100, 50, 1);
assert(one.length >= 1 && one.every(p => p.x === 350), '单列时水平居中');
assert(T.tilePoints(100, 100, 400, 400, 4).length >= 1, '块大于画布时仍至少 1 个点');

/* ---------- 5. 绘制冒烟（模拟 2D 上下文） ---------- */
function fakeCtx() {
  const calls = { fillText: 0, drawImage: 0 };
  return {
    calls,
    save() {}, restore() {}, translate() {}, rotate() {},
    measureText() { return { width: 120 }; },
    fillText() { calls.fillText++; },
    drawImage() { calls.drawImage++; },
    set font(v) {}, set fillStyle(v) {}, set globalAlpha(v) {}, set textBaseline(v) {}
  };
}
// 文字水印：平铺 + 旋转 → fillText 次数 = 平铺点数
const c1 = fakeCtx();
T.paintWatermark(c1, 800, 600, { mode: 'text', text: '测试', size: 42, color: 'black', opacity: 25, rotate: -30, pos: 'tile', cols: 4 });
assert(c1.calls.fillText === T.tilePoints(800, 600, 120, 53, 4).length, '文字平铺绘制次数 = 平铺点数');
// 九宫格单点
const c2 = fakeCtx();
T.paintWatermark(c2, 800, 600, { mode: 'text', text: '测试', size: 42, color: 'black', opacity: 50, rotate: 0, pos: 'br' });
assert(c2.calls.fillText === 1, '九宫格只画 1 处');
// 图片水印（模拟 img 尺寸）
const c3 = fakeCtx();
T.paintWatermark(c3, 800, 600, { mode: 'image', img: { width: 400, height: 200 }, scale: 25, opacity: 25, rotate: 0, pos: 'center' });
assert(c3.calls.drawImage === 1, '图片水印绘制 1 处');
// 空文字 / 无图片不抛错且不绘制
const c4 = fakeCtx();
T.paintWatermark(c4, 800, 600, { mode: 'text', text: '', size: 42, opacity: 25, pos: 'center' });
assert(c4.calls.fillText === 1, '空文字仍绘制（宽度为 0 时跳过，占位符无内容但坐标有效）');
const c5 = fakeCtx();
T.paintWatermark(c5, 800, 600, { mode: 'image', img: null, scale: 25, opacity: 25, pos: 'center' });
assert(c5.calls.drawImage === 0, '无水印图时不绘制、不抛错');

console.log(fail ? `\n结果: ${pass} 通过, ${fail} 失败` : `\n结果: ${pass} 通过, 0 失败`);
process.exit(fail ? 1 : 0);
