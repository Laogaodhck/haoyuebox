/* compress.js 纯逻辑单元测试：质量钳制 / 等比缩放 / 扩展名与 MIME 选择 / 命名冲突 / 字节显示 */
'use strict';
const fs = require('fs');
const path = require('path');

global.window = { App: { ui: { $: () => null, toast: () => {} } } };
// ZipUtil/createImageBitmap 在纯逻辑测试中不会被触达
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'compress.js'), 'utf8'));
const T = global.window.App.compress._test;

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}

/* ---------- clampQuality ---------- */
assert(T.clampQuality(80) === 80, '质量 80 原样保留');
assert(T.clampQuality(50) === 50 && T.clampQuality(100) === 100, '边界 50/100 保留');
assert(T.clampQuality(30) === 50 && T.clampQuality(150) === 100, '越界钳制到 50/100');
assert(T.clampQuality('abc') === 80 && T.clampQuality(NaN) === 80 && T.clampQuality(undefined) === 80, '非法输入回退 80');
assert(T.clampQuality(80.4) === 80, '小数四舍五入');

/* ---------- computeTargetSize ---------- */
assert(T.computeTargetSize(4000, 3000, 0).w === 4000, '不限制（0）保持原尺寸');
assert(T.computeTargetSize(4000, 3000, 1920).w === 1920 && T.computeTargetSize(4000, 3000, 1920).h === 1440, '横向超限等比缩小');
assert(T.computeTargetSize(3000, 4000, 1920).w === 1440 && T.computeTargetSize(3000, 4000, 1920).h === 1920, '纵向超限等比缩小');
assert(T.computeTargetSize(1000, 800, 1920).w === 1000, '未超限不放大');
assert(T.computeTargetSize(1000, 800, 'abc').w === 1000, '非法 maxEdge 视为不限制');
assert(T.computeTargetSize(3840, 3840, 1280).w === 1280 && T.computeTargetSize(3840, 3840, 1280).h === 1280, '正方形恰好命中上限');
assert(T.computeTargetSize(3, 2, 2).w === 2 && T.computeTargetSize(3, 2, 2).h === 1, '小尺寸向下取整不低于 1');

/* ---------- pickExt / pickMime ---------- */
assert(T.pickExt('a.png', 'jpeg') === 'jpg', '统一 JPG 输出 jpg');
assert(T.pickExt('a.png', 'webp') === 'webp', '统一 WebP 输出 webp');
assert(T.pickExt('a.PNG', 'keep', 'image/png') === 'png', 'keep 沿用原扩展名（大小写归一）');
assert(T.pickExt('a.jpeg', 'keep', 'image/jpeg') === 'jpg', 'jpeg 扩展名归一为 jpg');
assert(T.pickExt('noext', 'keep', 'image/png') === 'png', '无扩展名回退（可编码格式）');
assert(T.pickExt('a.gif', 'keep', 'image/gif') === 'jpg', 'keep+gif 实际编成 JPEG，扩展名改 jpg');
assert(T.pickExt('a.bmp', 'keep', 'image/bmp') === 'jpg', 'keep+bmp 实际编成 JPEG，扩展名改 jpg');
assert(T.pickExt('a.png', 'keep') === 'jpg', 'keep 且输出 MIME 未知时保守回退 jpg');
assert(T.pickMime('image/png', 'keep') === 'image/png', 'keep 沿用 PNG MIME');
assert(T.pickMime('image/x-unknown', 'keep') === 'image/jpeg', '未知 MIME 回退 JPEG');
assert(T.pickMime('image/png', 'webp') === 'image/webp', '指定格式覆盖源 MIME');

/* ---------- buildOutputName ---------- */
const used = {};
assert(T.buildOutputName('照片.png', 'jpeg', used) === '照片.jpg', '替换扩展名');
assert(T.buildOutputName('照片.png', 'jpeg', used) === '照片(2).jpg', '重名追加 (2)');
assert(T.buildOutputName('', 'keep', {}, 'image/png') === '图片.png', '空名回退 图片');

/* ---------- formatBytes ---------- */
assert(T.formatBytes(512) === '512 B', '字节直显');
assert(T.formatBytes(2048) === '2.0 KB', 'KB 一位小数');
assert(T.formatBytes(3 * 1024 * 1024) === '3.00 MB', 'MB 两位小数');
assert(T.formatBytes(-5) === '0 B', '负数钳制为 0');

console.log(fail === 0 ? `\ncompress 纯逻辑 ${pass}/${pass} 通过` : `\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
