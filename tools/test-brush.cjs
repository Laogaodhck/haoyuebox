/* ============================================================
 * test-brush.cjs — 笔刷（修补/擦除）交互测试
 * 1) 脏区上报：落笔/拖拽/收尾每次 onChange 携带工作图坐标包围盒（供局部重绘）
 * 2) 光标环：跟随指针、直径=笔刷尺寸×视图比、模式配色、平移隐藏、离开隐藏
 * 3) 手势：双指（第二指按下）终止笔画不落笔；抬起补末段；快照钩子
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createChecker, withServer } = require('./_lib.cjs');

const ROOT = path.join(__dirname, '..');
const PORT = 8444;
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  const msg = String(e.detail && e.detail.stack || e.message || e);
  errors.push(msg.split('\n')[0]);
});
vc.on('error', (m) => errors.push('console.error: ' + m));

const checker = createChecker();
const assert = checker.assert;

withServer(PORT, async () => {
  const dom = await JSDOM.fromURL('http://localhost:' + PORT + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    virtualConsole: vc,
    pretendToBeVisual: true
  });
  const win = dom.window;
  const doc = win.document;
  await new Promise((r) => setTimeout(r, 1500)); // 等外链脚本执行完

  /* jsdom 无 2D 上下文：注入记录型假 ctx（蒙版绘制/快照读写全部无副作用） */
  const ctxLog = [];
  function makeCtx(c) {
    const U8 = win.Uint8ClampedArray || Uint8ClampedArray;
    const ctx = {
      save() {}, restore() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
      moveTo() {}, lineTo() {}, quadraticCurveTo() {},
      clearRect() {}, fillRect() {}, drawImage() {}, putImageData() {}, setLineDash() {},
      getImageData(x, y, w, h) { return { width: w, height: h, data: new U8(w * h * 4) }; },
      createImageData(w, h) { return { width: w, height: h, data: new U8(w * h * 4) }; }
    };
    ctxLog.push(ctx);
    return ctx;
  }
  win.HTMLCanvasElement.prototype.getContext = function () { return makeCtx(this); };

  assert(typeof win.Brush.attach === 'function', 'Brush.attach 就绪');

  /* ---------- 夹具：显示画布 300×200 CSS px，蒙版/工作图 800×600 ---------- */
  const dc = doc.createElement('canvas');
  dc.width = 300; dc.height = 200;
  doc.body.appendChild(dc);
  dc.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200, right: 300, bottom: 200 });
  const mc = doc.createElement('canvas');   // 蒙版画布（工作图分辨率）
  mc.width = 800; mc.height = 600;

  const st = {
    workCanvas: { width: 800, height: 600 },
    maskCanvas: mc,
    brushMode: 'erase',
    brushSize: 30,               // 工作图像素 → sx=800/300=2.667 → sizeWork=80
    mattePanActive: false,
    viewTf: null
  };
  const events = { change: [], start: 0, end: 0, startSnaps: [] };
  win.Brush.attach(dc, st, {
    onStrokeStart(snap) { events.start++; events.startSnaps.push(snap); },
    onChange(rect) { events.change.push(rect); },
    onStrokeEnd() { events.end++; }
  });

  const PE = (type, x, y) => new win.MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
  const ring = () => doc.querySelector('.brush-ring');
  const lastRect = () => events.change[events.change.length - 1];
  const near = (v, want, eps) => Math.abs(v - want) <= (eps || 0.6);

  /* ---------- 1. 落笔：圆点脏区 + 光标环出现 ---------- */
  dc.dispatchEvent(PE('pointerdown', 150, 100));
  await new Promise((r) => setTimeout(r, 20));
  assert(events.start === 1, '笔画开始触发快照钩子');
  assert(events.startSnaps[0] && events.startSnaps[0].w === 800 && events.startSnaps[0].h === 600,
    '快照为单通道蒙版快照（w/h 正确）');
  const d0 = events.change[0];
  assert(d0 && near(d0.x0, 400 - 40, 1.5) && near(d0.y0, 300 - 40, 1.5)
    && near(d0.x1, 400 + 40, 1.5) && near(d0.y1, 300 + 40, 1.5),
    '落笔脏区=圆点包围盒（工作图坐标，含半径）');
  assert(!!ring(), '光标环元素已创建');
  assert(ring().style.display === 'block', '落笔时光标环可见');
  assert(near(parseFloat(ring().style.width), 30, 0.2),
    '环直径恒等于笔刷显示像素 30px（与缩放无关），实际 ' + ring().style.width);
  assert(ring().style.left === '150px' && ring().style.top === '100px', '环中心跟随指针');
  assert(ring().className.indexOf('erase') >= 0, '擦除模式环为红色（erase 类）');

  /* ---------- 2. 拖拽：线段脏区沿路径延伸 ---------- */
  const before = events.change.length;
  dc.dispatchEvent(PE('pointermove', 160, 100));
  await new Promise((r) => setTimeout(r, 20));
  assert(events.change.length > before, '拖拽产生新的脏区上报');
  const d1 = lastRect();
  assert(d1.x1 > 400 && d1.x0 < 466 && near(d1.y0, 260, 1.5) && near(d1.y1, 340, 1.5),
    '线段脏区覆盖拖拽方向并含笔刷半径');

  /* ---------- 3. 抬起：补末段 + 笔画结束 ---------- */
  dc.dispatchEvent(PE('pointerup', 160, 100));
  await new Promise((r) => setTimeout(r, 20));
  assert(events.end === 1, '抬起触发笔画结束');
  assert(events.change.length > before + 1, '收尾补画最后半段（有脏区上报）');
  const endCount = events.end, changeCount = events.change.length;

  /* ---------- 4. 双指：第二指按下终止笔画且不落笔 ---------- */
  dc.dispatchEvent(PE('pointerdown', 150, 100));
  dc.dispatchEvent(PE('pointerdown', 160, 100)); // 第二指
  await new Promise((r) => setTimeout(r, 20));
  assert(events.start === 2, '第二指按下前第一笔已开始');
  assert(events.end === endCount + 1, '第二指按下终止当前笔画');
  assert(events.change.length === changeCount + 1, '第二指按下不产生新的绘制脏区（仅落笔圆点）');

  /* ---------- 5. 平移模式隐藏环 / 悬停跟随 / 离开隐藏 / 修补模式配色 ---------- */
  st.mattePanActive = true;
  dc.dispatchEvent(PE('pointermove', 120, 60));
  await new Promise((r) => setTimeout(r, 10));
  assert(ring().style.display === 'none', '平移/捏合模式隐藏光标环');
  st.mattePanActive = false;
  dc.dispatchEvent(PE('pointermove', 100, 80));
  assert(ring().style.display === 'block' && ring().style.left === '100px', '悬停时环跟随指针');
  st.brushMode = 'restore';
  dc.dispatchEvent(PE('pointermove', 110, 80));
  assert(ring().className.indexOf('erase') < 0, '修补模式环为白色（无 erase 类）');
  dc.dispatchEvent(PE('pointerleave', 0, 0));
  assert(ring().style.display === 'none', '指针离开画布隐藏光标环');

  /* ---------- 6. 倾斜视图：落笔坐标经逆旋转映射到工作图坐标 ----------
   * work→画布：scale 2、平移 (10,20)、绕工作图中心 (400,300) 倾斜 90°。
   * 画布点 (150,100) → u=((150−10)/2,(100−20)/2)=(70,40)
   * → p = R(−90°)·u + (c − R(−90°)·c) = (140, 630)。 */
  const dc2 = doc.createElement('canvas');
  dc2.width = 300; dc2.height = 200;
  doc.body.appendChild(dc2);
  dc2.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200, right: 300, bottom: 200 });
  const mc2 = doc.createElement('canvas');
  mc2.width = 800; mc2.height = 600;
  const ev2 = { change: [], start: 0 };
  const st2 = {
    workCanvas: { width: 800, height: 600 },
    maskCanvas: mc2,
    brushMode: 'erase',
    brushSize: 30,
    mattePanActive: false,
    viewTf: { scale: 2, tx: 10, ty: 20, rot: Math.PI / 2 }
  };
  win.Brush.attach(dc2, st2, {
    onStrokeStart() { ev2.start++; },
    onChange(rect) { ev2.change.push(rect); },
    onStrokeEnd() {}
  });
  dc2.dispatchEvent(PE('pointerdown', 150, 100));
  await new Promise((r) => setTimeout(r, 20));
  assert(ev2.start === 1, '倾斜视图落笔触发快照');
  const t0 = ev2.change[0];
  assert(t0 && near(t0.x0, 140 - 7.5, 1) && near(t0.y0, 630 - 7.5, 1)
    && near(t0.x1, 140 + 7.5, 1) && near(t0.y1, 630 + 7.5, 1),
    '倾斜视图落笔脏区=逆旋转映射后的工作图坐标圆点包围盒');
  dc2.dispatchEvent(PE('pointerup', 150, 100));

  assert(errors.length === 0, '无脚本错误: ' + errors.join(' | '));
  checker.finish();
}).catch((e) => { console.error('测试执行失败:', e); process.exit(1); });
