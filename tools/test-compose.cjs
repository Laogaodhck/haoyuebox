/* ============================================================
 * test-compose.cjs — 图片合成模块单元测试
 * computeLayout：横向 / 纵向拼接、网格拼图、间距、居中与 contain 缩放
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

// 以经典脚本方式加载 compose.js（模拟 window，不触发 DOM 初始化）
global.window = {};
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'compose.js'), 'utf8'));
const T = global.window.App.compose._test;

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}
function eq(a, b, name) { assert(JSON.stringify(a) === JSON.stringify(b), name); }

/* ---------- 1. 横向拼接 ---------- */
const dims3 = [{ w: 100, h: 50 }, { w: 80, h: 80 }, { w: 60, h: 40 }];
const H = T.computeLayout(dims3, 'horizontal', 3, 10);
assert(H.W === 260 && H.H === 80, '横向总尺寸 260×80（Σ宽 + 2×间距，高取最大）');
eq([H.boxes[0].x, H.boxes[0].y, H.boxes[0].w, H.boxes[0].h], [0, 15, 100, 50], '第 1 张 x=0 垂直居中 y=15');
eq([H.boxes[1].x, H.boxes[1].y], [110, 0], '第 2 张 x=110（100+间距） y=0（最高）');
eq([H.boxes[2].x, H.boxes[2].y], [200, 20], '第 3 张 x=200 y=20（居中）');
assert(H.boxes.every(function (b) { return b.scale === 1; }), '拼接模式原图 1:1 不缩放');

/* ---------- 2. 纵向拼接 ---------- */
const V = T.computeLayout(dims3, 'vertical', 3, 10);
assert(V.W === 100 && V.H === 190, '纵向总尺寸 100×190（宽取最大，Σ高 + 2×间距）');
eq([V.boxes[0].x, V.boxes[0].y], [0, 0], '第 1 张 y=0 水平居中 x=0');
eq([V.boxes[1].x, V.boxes[1].y], [10, 60], '第 2 张 y=60（50+间距） x=10（居中）');
eq([V.boxes[2].x, V.boxes[2].y], [20, 150], '第 3 张 y=150 x=20（居中）');

/* ---------- 3. 间距为 0 ---------- */
const H0 = T.computeLayout([{ w: 50, h: 50 }, { w: 50, h: 50 }], 'horizontal', 0, 0);
assert(H0.W === 100 && H0.H === 50, '间距 0 时无缝拼接 100×50');
assert(H0.boxes[1].x === 50, '第 2 张紧贴第 1 张');

/* ---------- 4. 单张 ---------- */
const S = T.computeLayout([{ w: 120, h: 90 }], 'horizontal', 3, 8);
assert(S.W === 120 && S.H === 90 && S.boxes.length === 1, '单张布局即原尺寸');

/* ---------- 5. 空输入 ---------- */
assert(T.computeLayout([], 'horizontal', 3, 8) === null, '空列表返回 null');
assert(T.computeLayout(null, 'grid', 3, 8) === null, 'null 输入返回 null');

/* ---------- 6. 网格拼图 ---------- */
const G = T.computeLayout(dims3, 'grid', 2, 10);
// 格子取最大宽高 100×80；2 列 2 行 → 210×170
assert(G.W === 210 && G.H === 170, '网格总尺寸 210×170（2 列 × 最大格）');
// 第 1 张 100×50：scale=min(1, 1.6)=1，格内垂直居中 y=15
eq([G.boxes[0].x, G.boxes[0].y, G.boxes[0].w, G.boxes[0].h], [0, 15, 100, 50], '第 1 张 (0,0) 格 1:1 居中');
// 第 2 张 80×80：scale=min(1.25,1)=1，位于第 2 列 x=100+10=110
eq([G.boxes[1].x, G.boxes[1].y, G.boxes[1].w, G.boxes[1].h], [120, 0, 80, 80], '第 2 张 (1,0) 格 1:1');
// 第 3 张 60×40：scale=min(100/60, 80/40)=1.6667 → 100×67，第 2 行第 1 列
const b2 = G.boxes[2];
assert(b2.w === 100 && b2.h === 67, '第 3 张 contain 放大至格宽 100×67');
assert(b2.x === 0 && b2.y === 97, '第 3 张第 2 行格内居中 (0, 97)');

/* ---------- 7. 网格小图放大填充 ---------- */
const GU = T.computeLayout([{ w: 100, h: 80 }, { w: 20, h: 10 }], 'grid', 1, 0);
assert(GU.W === 100 && GU.H === 160, '单列两行 100×160');
assert(GU.boxes[1].w === 100 && GU.boxes[1].h === 50, '小图等比放大填满格宽 100×50');
assert(GU.boxes[1].y === 95, '小图第 2 行格内居中 y=95');

/* ---------- 8. 网格列数钳制与默认 ---------- */
const G1 = T.computeLayout([{ w: 10, h: 10 }, { w: 10, h: 10 }], 'grid', 0, 5);
assert(G1.W === 10 && G1.H === 25, '非法列数 0 钳制为 1 列（10×25）');
const G9 = T.computeLayout([{ w: 10, h: 10 }, { w: 10, h: 10 }], 'grid', 9, 5);
assert(G9.W === 25 && G9.H === 10, '列数超过张数时钳制为张数（2 列 1 行 25×10）');
const Gd = T.computeLayout([{ w: 10, h: 10 }, { w: 10, h: 10 }, { w: 10, h: 10 }, { w: 10, h: 10 }], 'grid', undefined, 0);
assert(Gd.W === 10 && Gd.H === 40, 'undefined 列数回退 1 列（10×40）');

/* ---------- 9. 间距非法值 ---------- */
const GN = T.computeLayout([{ w: 50, h: 50 }, { w: 50, h: 50 }], 'horizontal', 0, -5);
assert(GN.W === 100, '负间距钳制为 0');

console.log('\n结果： ' + pass + ' 通过， ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
