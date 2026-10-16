/* ============================================================
 * test-convert.cjs — 图片转换模块单元测试
 * 质量钳制 / 输出文件名生成与重名序号 / 格式能力表
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

// 以经典脚本方式加载 convert.js（模拟 window，不触发 DOM 初始化）
global.window = { App: { ui: { $: () => null, toast: () => {}, showLoading: () => {}, hideLoading: () => {} } } };
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'convert.js'), 'utf8'));
const T = global.window.App.convert._test;

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}

/* ---------- 1. 质量钳制 ---------- */
assert(T.clampQuality(92) === 92, '正常值 92 保持不变');
assert(T.clampQuality(50) === 50, '下边界 50');
assert(T.clampQuality(100) === 100, '上边界 100');
assert(T.clampQuality(10) === 50, '低于下限钳制到 50');
assert(T.clampQuality(150) === 100, '高于上限钳制到 100');
assert(T.clampQuality(92.4) === 92, '小数四舍五入 92.4 → 92');
assert(T.clampQuality(92.5) === 93, '小数四舍五入 92.5 → 93');
assert(T.clampQuality('abc') === 50, '非法输入回退下限 50');
assert(T.clampQuality('') === 50, '空字符串回退下限 50');
assert(T.clampQuality(undefined) === 50, 'undefined 回退下限 50');

/* ---------- 2. 输出文件名 ---------- */
assert(T.buildOutputName('照片.png', 'jpeg', {}) === '照片.jpg', '替换扩展名为 jpg（中文名）');
assert(T.buildOutputName('photo.PNG', 'png', {}) === 'photo.png', '大写扩展名替换');
assert(T.buildOutputName('无扩展名', 'webp', {}) === '无扩展名.webp', '无扩展名追加');
assert(T.buildOutputName('a.b.c.jpg', 'png', {}) === 'a.b.c.png', '仅替换最后一段扩展名');
assert(T.buildOutputName('', 'png', {}) === '图片.png', '空文件名回退「图片」');
assert(T.buildOutputName('.hidden', 'png', {}) === '图片.png', '隐藏文件回退「图片」');
assert(T.buildOutputName('x', 'gif', {}) === 'x.png', '未知格式回退 png');

// 重名序号：同一 used 集合依次分配 a.png → a(2).png → a(3).png
const used = {};
assert(T.buildOutputName('a.jpg', 'png', used) === 'a.png', '首个同名直接输出');
assert(T.buildOutputName('a.jpg', 'png', used) === 'a(2).png', '第二个同名追加 (2)');
assert(T.buildOutputName('a.jpg', 'png', used) === 'a(3).png', '第三个同名追加 (3)');
assert(T.buildOutputName('b.jpg', 'png', used) === 'b.png', '不同名不受影响');
assert(T.buildOutputName('a(2).jpg', 'png', used) === 'a(2)(2).png', '与已占用名冲突时继续递增');

/* ---------- 3. 格式能力表 ---------- */
assert(T.FMTS.jpeg.ext === 'jpg' && T.FMTS.jpeg.mime === 'image/jpeg', 'jpeg → jpg / image/jpeg');
assert(T.FMTS.png.ext === 'png' && T.FMTS.png.mime === 'image/png', 'png → png / image/png');
assert(T.FMTS.webp.ext === 'webp' && T.FMTS.webp.mime === 'image/webp', 'webp → webp / image/webp');
assert(T.FMTS.jpeg.fill === true, 'jpeg 需填充透明底色');
assert(T.FMTS.png.fill === false && T.FMTS.webp.fill === false, 'png / webp 保留透明不填充');
assert(T.FMTS.jpeg.quality === true && T.FMTS.webp.quality === true, 'jpeg / webp 使用质量参数');
assert(T.FMTS.png.quality === false, 'png 不使用质量参数');

console.log('\n结果： ' + pass + ' 通过， ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
