/* ============================================================
 * test-batch-watermark.cjs — 去除水印模块单元测试
 * 强度钳制 / 矩形归一化与像素换算 / 周边取色中值 / 输出命名
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

// 以经典脚本方式加载 batch-watermark.js（模拟 window，不触发 DOM 初始化）
global.window = {};
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'batch-watermark.js'), 'utf8'));
const T = global.window.App.batchWatermark._test;

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}
function near(a, b) { return Math.abs(a - b) < 1e-9; }

/* ---------- 1. 模式与强度 ---------- */
assert(T.MODES.length === 4 && T.MODES.join(',') === 'blur,block,fill,median', '四种处理模式');
assert(T.clampStrength(5) === 5, '正常值 5');
assert(T.clampStrength(1) === 1 && T.clampStrength(10) === 10, '边界 1 / 10');
assert(T.clampStrength(0) === 1 && T.clampStrength(99) === 10, '越界钳制');
assert(T.clampStrength('x') === 1 && T.clampStrength(undefined) === 1, '非法输入回退 1');

/* ---------- 2. 矩形归一化 ---------- */
let r = T.normalizeRect(0.1, 0.2, 0.5, 0.7);
assert(near(r.x, 0.1) && near(r.y, 0.2) && near(r.w, 0.4) && near(r.h, 0.5), '正向拖拽');
r = T.normalizeRect(0.5, 0.7, 0.1, 0.2);
assert(near(r.x, 0.1) && near(r.y, 0.2) && near(r.w, 0.4) && near(r.h, 0.5), '反向拖拽结果一致');
r = T.normalizeRect(-0.2, -0.1, 1.3, 1.5);
assert(near(r.x, 0) && near(r.y, 0) && near(r.w, 1) && near(r.h, 1), '越界钳制到全图');
r = T.normalizeRect(-0.2, 0.1, 0.3, 0.6);
assert(near(r.x, 0) && near(r.w, 0.3), '端点先钳制：x+w 不超界');
r = T.normalizeRect(0.3, 0.3, 0.3, 0.3);
assert(r.w === 0 && r.h === 0, '点击无拖拽为空矩形');

/* ---------- 3. 比例矩形 → 像素 ---------- */
let p = T.rectToPx({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 1000, 500);
assert(p.x === 100 && p.y === 100 && p.w === 300 && p.h === 200, '标准换算');
p = T.rectToPx({ x: 0.99, y: 0.99, w: 0.5, h: 0.5 }, 100, 100);
assert(p.x === 99 && p.y === 99 && p.w === 1 && p.h === 1, '右下角越界钳制');
p = T.rectToPx({ x: 0, y: 0, w: 1, h: 1 }, 640, 480);
assert(p.x === 0 && p.y === 0 && p.w === 640 && p.h === 480, '全图矩形');
p = T.rectToPx({ x: 0.15, y: 0, w: 0.333, h: 0 }, 1000, 100);
assert(p.x === 150 && p.w === 333, '四舍五入取整');

/* ---------- 4. 周边取色中值 ---------- */
let mc = T.medianColor([]);
assert(mc[0] === 255 && mc[1] === 255 && mc[2] === 255, '空采样回退白色');
mc = T.medianColor([[10, 20, 30], [100, 200, 50], [30, 40, 60]]);
assert(mc[0] === 30 && mc[1] === 40 && mc[2] === 50, '各通道取中位数');

/* ---------- 5. 环形采样 ---------- */
// 10×10 图，像素值 = [x, y, 0, 255]；矩形 (4,4)-(5,5)，环宽 2
const W = 10, H = 10;
const data = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    data[i] = x; data[i + 1] = y; data[i + 2] = 0; data[i + 3] = 255;
  }
}
const rect = { x: 4, y: 4, w: 2, h: 2 };
const colors = T.collectRingColors(data, W, H, rect, 2);
assert(colors.length > 0, '采样到环形颜色');
const has = (x, y) => colors.some(c => c[0] === x && c[1] === y);
assert(has(3, 3) && has(6, 6) && has(4, 2) && has(7, 5), '环上的点被采集（含四角与上下左右）');
assert(!has(4, 4) && !has(5, 5), '矩形内部点不采集');
assert(!has(0, 0) && !has(9, 9), '环外远点不采集');

/* ---------- 6. 输出命名 ---------- */
assert(T.buildOutName('照片.jpg', 'suffix') === '照片-无水印.jpg', 'suffix 模式加「-无水印」');
assert(T.buildOutName('照片.jpg', 'overwrite') === '照片.jpg', 'overwrite 模式保持原名');
assert(T.buildOutName('noext', 'suffix') === 'noext-无水印.png', '无扩展名回退 png');
assert(T.buildOutName('a.b.jpg', 'suffix') === 'a.b-无水印.jpg', '仅取最后一段扩展名');
assert(T.buildOutName('scan.bmp', 'overwrite', 'png') === 'scan.png', 'BMP 强制转 PNG（覆盖模式）');
assert(T.buildOutName('动图.gif', 'suffix', 'png') === '动图-无水印.png', 'GIF 强制转 PNG（suffix 模式）');
assert(T.buildOutName('web.webp', 'suffix') === 'web-无水印.webp', 'WebP 保持原格式');

console.log('\n结果： ' + pass + ' 通过， ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
