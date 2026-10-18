/* ============================================================
 * test-tilt.cjs — 人像倾斜校正纯数学测试
 * Composer._test.tiltFwd / tiltInv（work ↔ 输出 的倾斜映射）：
 * 1) 零角度恒等；2) 正逆映射互逆；3) 中心不动点；4) 90° 定向；
 * 5) 前向映射与 canvas 变换序列（T(t)·S(s)·T(c)·R(θ)·T(−c)）逐项一致。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { createChecker } = require('./_lib.cjs');

const checker = createChecker();
const assert = checker.assert;

/* composer.js 顶层只挂 window，DOM 调用都在函数体内 → 最小全局直接加载 */
const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'composer.js'), 'utf8');
const win = {};
new Function('window', code)(win);
const T = win.Composer && win.Composer._test;
assert(!!T && typeof T.tiltFwd === 'function' && typeof T.tiltInv === 'function',
  'Composer._test.tiltFwd / tiltInv 已导出');

const st = { workCanvas: { width: 800, height: 600 }, tilt: 0 };
const near = (v, want, eps) => Math.abs(v - want) <= (eps || 1e-9);

/* ---------- 1. 零角度恒等 ---------- */
st.tilt = 0;
let p = T.tiltFwd(st, 123.4, -56.7);
assert(near(p.x, 123.4) && near(p.y, -56.7), '零倾斜 tiltFwd 恒等');
p = T.tiltInv(st, 123.4, -56.7);
assert(near(p.x, 123.4) && near(p.y, -56.7), '零倾斜 tiltInv 恒等');

/* ---------- 2. 正逆互逆（任意角度往返） ---------- */
for (const deg of [-15, -7.5, 0.5, 12, 15]) {
  st.tilt = deg;
  const q = T.tiltFwd(st, 640, 120);
  const back = T.tiltInv(st, q.x, q.y);
  assert(near(back.x, 640, 1e-7) && near(back.y, 120, 1e-7),
    '倾斜 ' + deg + '° 正逆映射互逆');
}

/* ---------- 3. 中心不动点 ---------- */
st.tilt = 13;
p = T.tiltFwd(st, 400, 300);
assert(near(p.x, 400) && near(p.y, 300), '旋转中心（工作图中心）为不动点');

/* ---------- 4. 90° 定向：中心右侧点转到中心正下方 ---------- */
st.tilt = 90;
p = T.tiltFwd(st, 700, 300);
assert(near(p.x, 400) && near(p.y, 600), '90° 时右侧点 (700,300) → 下方 (400,600)');

/* ---------- 5. 与 canvas 变换序列一致 ----------
 * 绘制时铺开的变换：translate(t) → scale(s) → translate(c) → rotate(θ) → translate(−c)
 * 对 work 点 (640,120) 的落点应与 tiltFwd 再套 s/t 完全一致 */
st.tilt = 12;
const s = 0.37, tx = -45, ty = 80;
const f = T.tiltFwd(st, 640, 120);
const wantX = f.x * s + tx, wantY = f.y * s + ty;
/* 手工展开矩阵（与 applyTf 等价）：M = T(t)·S(s)·T(c)·R(θ)·T(−c) */
const th = st.tilt * Math.PI / 180;
const cos = Math.cos(th), sin = Math.sin(th), cx = 400, cy = 300;
const dx = 640 - cx, dy = 120 - cy;
const mx = cx + dx * cos - dy * sin, my = cy + dx * sin + dy * cos;
assert(near(wantX, mx * s + tx, 1e-7) && near(wantY, my * s + ty, 1e-7),
  'tiltFwd + 缩放平移 与 canvas 变换序列展开式一致');

/* ---------- 6. 逆映射直接验证（不依赖正映射） ---------- */
st.tilt = -9;
const inv = T.tiltInv(st, 210, 455);
const dx2 = 210 - 400, dy2 = 455 - 300;
const cos2 = Math.cos(-9 * Math.PI / 180), sin2 = Math.sin(-9 * Math.PI / 180);
/* tiltInv 内部实现为 c + [cos, sin; −sin, cos]·(q − c)，与旋转矩阵定义独立核对 */
const wx = 400 + dx2 * cos2 + dy2 * sin2;
const wy = 300 - dx2 * sin2 + dy2 * cos2;
assert(near(inv.x, wx, 1e-7) && near(inv.y, wy, 1e-7), 'tiltInv 展开式核对（−9°）');

checker.finish();
