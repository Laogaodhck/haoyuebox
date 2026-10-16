/* ============================================================
 * test-hair-clothes.cjs — 分类感知增强（头发/白衣服）纯算法直测
 * 直测 Matting._test，不依赖 DOM/模型
 * ============================================================ */
'use strict';
global.window = {};
eval(require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'segmenter.js'), 'utf8'));
var T = window.Matting._test;

var pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}

/* ---------- 1. 滞后阈值：gain 关闭（回归旧行为） ---------- */
var conf = new Float32Array([0.6, 0.30, 0.28, 0, 0]); // 中间 0.30<0.35 弱阈值以下 → 断链
var bin = T.hysteresisBin(conf, 5, 1, 0.5, 0.35);
assert(bin[0] === 1 && bin[1] === 0 && bin[2] === 0, '无 gain：弱阈值以下像素断链丢弃（旧行为回归）');

/* ---------- 2. 滞后阈值：分类 gain 降低门槛后连通保留 ---------- */
var gain = new Float32Array([0, 0.10, 0.10, 0, 0]);
var bin2 = T.hysteresisBin(conf, 5, 1, 0.5, 0.35, gain); // 有效弱阈值 0.25
assert(bin2[0] === 1 && bin2[1] === 1 && bin2[2] === 1, 'gain=0.10：0.30/0.28 连通生长保留（头发/白衣增益路径）');

/* ---------- 3. gain 钳制与下限 ---------- */
var gain2 = new Float32Array([0.9, 0, 0, 0, 0]); // 0.5-0.9 → 下限 0.15
var bin3 = T.hysteresisBin(new Float32Array([0.16, 0, 0, 0, 0]), 5, 1, 0.5, 0.35, gain2);
assert(bin3[0] === 1, 'gain 过大时有效阈值钳制下限 0.15');

/* ---------- 4. classBoost（Float32Array 存在 32 位精度，用容差比较） ---------- */
var EPS = 1e-6;
var c1 = new Float32Array([0.40, 0.90, 0.40]);
var hair = new Float32Array([0.50, 0.50, 0.20]);   // 前两个头发主导
var clothes = new Float32Array([0, 0, 0.45]);       // 第三个衣服主导
T.classBoost(c1, hair, clothes);
assert(Math.abs(c1[0] - Math.min(1, 0.5 * 1.3)) < EPS && c1[0] > 0.4, '头发 0.5 → 置信度提升到 0.65');
assert(Math.abs(c1[1] - 0.90) < EPS, '已高置信度不被增益覆盖');
assert(Math.abs(c1[2] - Math.min(1, 0.45 * 1.25)) < EPS && c1[2] > 0.4, '衣服 0.45 → 置信度提升到 0.5625（白衣服）');
var c2 = new Float32Array([0.40]);
T.classBoost(c2, null, null);
assert(Math.abs(c2[0] - 0.40) < EPS, '二分类回退模型：classBoost 直通');

/* ---------- 5. classGain ---------- */
var g1 = T.classGain(new Float32Array([0.5]), new Float32Array([0.6]));
assert(Math.abs(g1[0] - (0.05 + 0.09)) < 1e-5, 'gain = hair*0.10 + clothes*0.15');
var g2 = T.classGain(new Float32Array([1]), new Float32Array([1]));
assert(Math.abs(g2[0] - 0.15) < EPS, 'gain 上限钳制 0.15');

/* ---------- 6. 中值滤波：头发区宽容保细丝 ---------- */
// 5x5 全 0，中间列 y1..y3 为 1（1px 竖线）
function lineBin() {
  var b = new Uint8Array(25);
  b[1 * 5 + 2] = 1; b[2 * 5 + 2] = 1; b[3 * 5 + 2] = 1;
  return b;
}
var b1 = T.medianFilter3(lineBin(), 5, 5);
assert(b1[2 * 5 + 2] === 0, '无 hairMask：5/9 多数票切掉 1px 细丝（旧行为回归）');
var hm = new Uint8Array(25);
hm[1 * 5 + 2] = 1; hm[2 * 5 + 2] = 1; hm[3 * 5 + 2] = 1;
var b2 = T.medianFilter3(lineBin(), 5, 5, hm);
assert(b2[2 * 5 + 2] === 1, 'hairMask：保留发丝中心');
assert(b2[1 * 5 + 2] === 1 && b2[3 * 5 + 2] === 1, 'hairMask：保留与邻居连通的发梢');

/* ---------- 7. 组合管线冒烟：boost + gain 联动（模拟白衣区域） ---------- */
// 7x1：人物主体(0.9) | 白衣过渡(0.30) | 白衣(0.32) | 白衣(0.32) | 背景(0.05)...
var confW = new Float32Array([0.9, 0.30, 0.32, 0.32, 0.05, 0.05, 0.05]);
var clothesW = new Float32Array([0.05, 0.5, 0.6, 0.6, 0.02, 0.02, 0.02]);
var hairW = new Float32Array(7);
T.classBoost(confW, hairW, clothesW);
var gainW = T.classGain(hairW, clothesW);
var binW = T.hysteresisBin(confW, 7, 1, 0.5, 0.35, gainW);
assert(binW[1] === 1 && binW[2] === 1 && binW[3] === 1, '白衣服区域：boost+gain 后与主体连通保留');
assert(binW[4] === 0 && binW[5] === 0, '真背景仍被丢弃（不外溢）');

var faceConf = new Float32Array([0.2, 0.95, 0.1]);
T.classBoost(faceConf, null, null, new Float32Array([0.8, 0.8, 0.1]));
assert(Math.abs(faceConf[0] - 0.88) < EPS && Math.abs(faceConf[1] - 0.95) < EPS, '脸部通道恢复主体置信度且不削弱高置信像素');
assert(Math.abs(faceConf[2] - 0.1) < EPS, '低脸部置信度不放大背景');
assert(T.classGain(null, null, null) === null, '二分类模型无分类增益');
assert(Math.abs(T.classGain(null, new Float32Array([0.6]), null)[0] - 0.09) < EPS, '仅有衣服通道时可计算增益');
assert(Math.abs(T.classGain(null, null, new Float32Array([0.8]))[0] - 0.04) < EPS, '脸部采用较小阈值增益');

var masks = [0.1, 0.2, 0.1, 0.45, 0.1, 0.05].map(v => ({
  width: 1, height: 1, getAsFloat32Array: () => new Float32Array([v])
}));
var extracted = T.extractPersonConf({ confidenceMasks: masks }, 2, 2);
assert(extracted.face.length === 4 && Math.abs(extracted.face[3] - 0.45) < EPS, '六分类脸部通道正确提取并重采样');
var fallback = T.extractPersonConf({ confidenceMasks: [masks[0]] }, 1, 1);
assert(fallback.face === null && fallback.hair === null && fallback.clothes === null, '单通道模型保持无分类回退');
var interpolated = T.resampleF32(new Float32Array([0.123456, 0.654321]), 2, 1, 4, 2);
assert(Math.abs(interpolated[0] - 0.123456) < EPS && Math.abs(interpolated[3] - 0.654321) < EPS, '浮点重采样不产生 8 位量化损失');
assert(Math.abs(interpolated[1] - (0.123456 * 0.75 + 0.654321 * 0.25)) < EPS, '重采样对齐像素中心进行双线性插值');
[1, 511, 512, 513, 800, 1600].forEach(length => {
  const starts = T.tileStarts(length);
  assert(starts[0] === 0 && starts[starts.length - 1] === Math.max(0, length - 512), '瓦片末块贴边：' + length);
  let covered = true;
  for (let x = 0; x < length; x++) {
    const weight = starts.reduce((sum, start) => {
      const size = Math.min(512, length);
      return x < start || x >= start + size ? sum : sum + T.axisWeight(x - start, size, 96, start === 0, start + size === length);
    }, 0);
    if (weight <= 0) covered = false;
  }
  assert(covered, '瓦片融合每个像素都有正权重：' + length);
});

var diagonal = new Float32Array(81), diagonalHair = new Uint8Array(81);
for (var d = 1; d <= 7; d++) { diagonal[d * 9 + d] = d === 1 ? 0.9 : 0.4; diagonalHair[d * 9 + d] = 1; }
var diagonalBin = T.hysteresisBin(diagonal, 9, 9, 0.5, 0.35);
assert(diagonalBin[7 * 9 + 7] === 1, '八邻域生长保留斜向发丝');
diagonalBin = T.medianFilter3(diagonalBin, 9, 9, diagonalHair);
diagonalBin[8] = 1;
diagonalBin = T.cleanComponents(diagonalBin, 9, 9);
assert(diagonalBin[7 * 9 + 7] === 1 && diagonalBin[8] === 0, '连通域清理保留斜发丝并移除孤立噪声');
var haloHair = new Uint8Array(25).fill(1);
assert(T.medianFilter3(lineBin(), 5, 5, haloHair)[2 * 5 + 1] === 0, '头发宽容规则不向背景膨胀');
assert(T.medianFilter3(new Uint8Array(9).fill(1), 3, 3)[0] === 1, '画布角落的完整衣物不被中值滤波侵蚀');
var holes = new Uint8Array(49).fill(1), holeConf = new Float32Array(49).fill(1);
holes[16] = 0; holeConf[16] = 0.02;
holes[32] = 0; holeConf[32] = 0.6;
T.fillHoles(holes, 7, 7, holeConf);
assert(holes[16] === 0 && holes[32] === 1, '孔洞清理保留真实背景、补回人像内部误删区域');
var border = new Uint8Array(400), borderConf = new Float32Array(400);
for (var by = 10; by < 20; by++) for (var bx = 4; bx < 16; bx++) { border[by * 20 + bx] = 1; borderConf[by * 20 + bx] = 0.9; }
border[390] = 0; borderConf[390] = 0.3;
border[391] = 0; borderConf[391] = 0.01;
T.solidifyBorders(border, 20, 20, borderConf);
assert(border[390] === 1 && border[391] === 0, '贴边修补不填入低置信背景缺口');

function alphaFixture(foreground, background) {
  const w = 64, h = 32, bin = new Uint8Array(w * h), conf = new Float32Array(w * h);
  const rgba = new Uint8ClampedArray(w * h * 4), hair = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    bin[i] = x < 32 ? 1 : 0;
    conf[i] = x < 29 ? 1 : x < 33 ? 0.5 : 0;
    hair[i] = x < 33 ? 0.8 : 0;
    const coverage = x === 30 ? 0 : x === 31 ? 0.5 : x < 32 ? 1 : 0;
    for (let ch = 0; ch < 3; ch++) rgba[i * 4 + ch] = foreground[ch] * coverage + background[ch] * (1 - coverage);
    rgba[i * 4 + 3] = 255;
  }
  return { w, h, bin, conf, rgba, classes: { hair } };
}
const af = alphaFixture([20, 30, 40], [220, 220, 210]);
const rgbaBefore = af.rgba.slice();
const alpha = T.refineAlpha(af.bin, af.conf, af.rgba, af.w, af.h, af.classes);
const row = 16 * af.w;
assert(alpha[row + 20] === 255 && alpha[row + 45] === 0, '透明度精修保持主体不透明、远处背景全透明');
assert(alpha[row + 30] === 0, '颜色精修移除硬蒙版内残留的背景色');
assert(Math.abs(alpha[row + 31] - 128) <= 2, '半覆盖发丝恢复为约 50% alpha 而非硬切');
const fringe = (row + 31) * 4;
assert(af.rgba[fringe] === 20 && af.rgba[fringe + 1] === 30 && af.rgba[fringe + 2] === 40,
  '发丝混色反解回纯前景色，换底不残留原背景光晕');
const body = (row + 20) * 4, outside = (row + 45) * 4, leftover = (row + 30) * 4;
assert(af.rgba[body] === rgbaBefore[body] && af.rgba[outside] === rgbaBefore[outside] &&
  af.rgba[leftover] === rgbaBefore[leftover], '发丝净化不改动人像主体、远处背景与全透明像素');
let recolored = 0;
for (let i = 0; i < af.bin.length; i++) {
  const o = i * 4;
  if (af.rgba[o] !== rgbaBefore[o] || af.rgba[o + 1] !== rgbaBefore[o + 1] || af.rgba[o + 2] !== rgbaBefore[o + 2]) recolored++;
}
assert(recolored > 0 && recolored <= 2 * af.h, '颜色改动仅限发丝轮廓窄带（' + recolored + ' 像素）');
const protectedConf = Float32Array.from(af.conf, (v, i) => af.bin[i] ? 0.9 : v);
const afSolid = alphaFixture([20, 30, 40], [220, 220, 210]);
const solidBefore = afSolid.rgba.slice();
const protectedClasses = { hair: null, clothes: new Float32Array(afSolid.bin.length).fill(0.8), face: null };
const protectedAlpha = T.refineAlpha(afSolid.bin, protectedConf, afSolid.rgba, afSolid.w, afSolid.h, protectedClasses);
assert(protectedAlpha[row + 30] === 255 && protectedAlpha[row + 31] === 255, '高置信浅色衣服不被当成背景挖空');
protectedClasses.clothes = null; protectedClasses.face = new Float32Array(afSolid.bin.length).fill(0.8);
const faceAlpha = T.refineAlpha(afSolid.bin, afSolid.conf, afSolid.rgba, afSolid.w, afSolid.h, protectedClasses);
assert(faceAlpha[row + 30] === 255, '脸部内部高光不因颜色类似背景而透明');
assert(afSolid.rgba.every((v, i) => v === solidBefore[i]), '无头发通道（回退模型）时完全不改动原图颜色');
const lowContrast = alphaFixture([180, 180, 180], [180, 180, 180]);
const lowBefore = lowContrast.rgba.slice();
const lowAlpha = T.refineAlpha(lowContrast.bin, lowContrast.conf, lowContrast.rgba, 64, 32, lowContrast.classes);
assert(lowAlpha[row + 31] > 60 && lowAlpha[row + 31] < 200, '前背景同色无法判定时发丝按覆盖率柔边，不再硬切成锯齿');
assert(lowAlpha[row + 29] === 255 && lowAlpha[row + 32] === 0, '柔边不侵蚀发丝内部、不外溢到背景');
assert(lowContrast.rgba.every((v, i) => v === lowBefore[i]), '背景色与前景色相同时光晕无从判定，不做任何染色');

/* ---------- 发丝间隙透出原底色 ---------- */
function gapFixture(clothesInNotch) {
  const w = 60, h = 40, N = w * h;
  const bin = new Uint8Array(N), conf = new Float32Array(N), alpha = new Uint8Array(N);
  const hair = new Float32Array(N), clothes = new Float32Array(N);
  const rgba = new Uint8ClampedArray(N * 4);
  const BG = [230, 230, 230], STRAND = [30, 30, 30];
  const paint = (i, rgb) => { rgba[i * 4] = rgb[0]; rgba[i * 4 + 1] = rgb[1]; rgba[i * 4 + 2] = rgb[2]; rgba[i * 4 + 3] = 255; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    paint(i, BG);
    if (x >= 4 && x <= 24 && y >= 8 && y <= 32) { bin[i] = 1; alpha[i] = 255; hair[i] = 0.9; conf[i] = 0.9; paint(i, STRAND); }
    const notch = x >= 18 && x <= 24 && y >= 18 && y <= 22;   // 与外部背景连通的发丝缺口
    const isolated = x >= 8 && x <= 11 && y >= 10 && y <= 13; // 被发丝完全包住的亮斑
    if (notch || isolated) { conf[i] = 0.3; hair[i] = 0.2; paint(i, BG); }
    if (notch && clothesInNotch) clothes[i] = 0.9;
  }
  return { w, h, bin, conf, alpha, rgba, classes: { hair, clothes, face: null } };
}
const gapA = gapFixture(false);
const punched = T.clearHairGaps(gapA.alpha, gapA.bin, gapA.conf, gapA.rgba, gapA.classes, gapA.w, gapA.h);
const notchIdx = 20 * 60 + 21, isolatedIdx = 11 * 60 + 9, strandIdx = 30 * 60 + 6;
assert(gapA.alpha[notchIdx] === 0, '与外部背景连通的发丝缺口透出底色，不再残留原墙色');
assert(gapA.alpha[isolatedIdx] === 255, '被发丝包住的内部亮斑不被挖穿');
assert(gapA.alpha[strandIdx] === 255, '高置信发丝本体不受间隙清除影响');
assert(punched === 35, '间隙清除只命中缺口本身（' + punched + ' 像素）');
const gapB = gapFixture(true);
T.clearHairGaps(gapB.alpha, gapB.bin, gapB.conf, gapB.rgba, gapB.classes, gapB.w, gapB.h);
assert(gapB.alpha[notchIdx] === 255, '衣服通道占优的同色区域不被当成发丝缺口吃穿');
assert(T.clearHairGaps(gapB.alpha, gapB.bin, gapB.conf, gapB.rgba, { hair: null }, 60, 40) === 0,
  '回退模型无头发通道时不做间隙清除');

/* ---------- 8. 皮肤通道提取与美白 ---------- */
// 六分类模型：ch2 身体皮肤 0.6 / ch3 脸部皮肤 0.9 → skin = max = 0.9
var masks2 = [0.05, 0.1, 0.6, 0.9, 0.1, 0.05].map(v => ({
  width: 1, height: 1, getAsFloat32Array: () => new Float32Array([v])
}));
var ext2 = T.extractPersonConf({ confidenceMasks: masks2 }, 2, 2);
assert(ext2.skin && ext2.skin.length === 4 && Math.abs(ext2.skin[3] - 0.9) < EPS,
  '皮肤置信度 = max(身体皮肤, 脸部皮肤)');
// 交界处双通道中等置信：max 不叠加（0.5 与 0.5 → 0.5 而非 1.0）
var masks3 = [0.05, 0.1, 0.5, 0.5, 0.1, 0.05].map(v => ({
  width: 1, height: 1, getAsFloat32Array: () => new Float32Array([v])
}));
var ext3 = T.extractPersonConf({ confidenceMasks: masks3 }, 1, 1);
assert(Math.abs(ext3.skin[0] - 0.5) < EPS, '皮肤交界处取 max 不叠加');

// 美白：白色 Screen 混合 × 置信度门控
var rgba = new Uint8ClampedArray([200, 150, 100, 255,  30, 40, 50, 255,  220, 220, 220, 255]);
var skin = new Float32Array([1.0, 1.0, 0.0]);
var nHit = T.whitenData(rgba, skin, 0.5);
assert(nHit === 2, '低置信像素跳过不计入');
// screen(200)=255-55²/255≈243.14；t=0.5 → 200+43.14*0.5≈221.6 → 钳位取整 222
assert(rgba[0] === 222, 'Screen 混合提亮红色通道');
// 低通道增益更大：screen(100)=160.8 → 100+60.8*0.5≈130（涨幅 30）
// screen(150)=211.8 → 181（涨幅 31）；B 涨幅 30 与 R 相当，白化方向收敛
assert(rgba[2] === 130, '低亮度通道按 Screen 曲线提亮');
assert(rgba[8] === 220 && rgba[9] === 220, '置信度 0 像素保持原值');
assert(T.whitenData(rgba, skin, 0) === 0, '强度 0 直通');
assert(T.whitenData(new Uint8ClampedArray(4), new Float32Array(2), 0.5) === 0,
  '长度不匹配拒绝执行');

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
