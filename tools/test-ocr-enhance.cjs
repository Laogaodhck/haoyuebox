/* ============================================================
 * test-ocr-enhance.cjs — OCR 增强/后处理纯逻辑单元测试
 * 覆盖 js/ocr-enhance.js：图像管线（灰度 / Otsu / 倾角估计与剪切纠偏 /
 * 百分位拉伸 / Sauvola 二值化 / 去噪 / 整体 enhance）与文本后处理
 * （归一 / 数字上下文纠错 / 证件校验 / 字段提取 / 表格网格 / 段落重建）。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

// 经典脚本方式加载 ocr-enhance.js（模拟 window，无 DOM）
global.window = { App: {} };
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'ocr-enhance.js'), 'utf8'));
const T = global.window.App.ocrEnhance._test;

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}

// 合成像素对象：RGBA
function makePx(w, h, fill) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = fill[0]; d[i + 1] = fill[1]; d[i + 2] = fill[2]; d[i + 3] = 255;
  }
  return { data: d, width: w, height: h };
}
// 在像素对象上画实心矩形（灰度 v → RGB 同值）
function drawRect(px, x0, y0, rw, rh, v) {
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) {
      const j = (y * px.width + x) * 4;
      px.data[j] = v; px.data[j + 1] = v; px.data[j + 2] = v;
    }
  }
}
function grayOf(px) { return T.toGray(px); }

/* ---------- 1. 灰度与统计 ---------- */
{
  const px = makePx(2, 1, [255, 0, 0]);
  const g = grayOf(px);
  assert(g[0] === 76 && g[1] === 76, '纯红像素灰度 ≈ 76（BT.601）');
}

/* ---------- 2. Otsu ---------- */
{
  const vals = [];
  for (let i = 0; i < 500; i++) vals.push(40 + (i % 10));   // 暗簇
  for (let i = 0; i < 500; i++) vals.push(200 + (i % 10));  // 亮簇
  const thr = T.otsu(Uint8ClampedArray.from(vals));
  assert(thr >= 40 && thr <= 210, 'Otsu 阈值落在暗簇上缘与亮簇之间（实际 ' + thr + '）');
}

/* ---------- 3. 倾角估计与剪切纠偏 ---------- */
function barDoc(w, h) {
  const px = makePx(w, h, [255, 255, 255]);
  for (let y = 40; y < h - 40; y += 44) drawRect(px, 30, y, w - 60, 6, 20);
  return px;
}
{
  const straight = barDoc(520, 300);
  const skewed = T.deskewShearRGBA(straight, -3);   // 人为制造 -3° 斜
  const est = T.estimateSkew(grayOf(skewed), skewed.width, skewed.height);
  assert(Math.abs(est - 3) <= 1.0, '估计出 +3° 倾角（实际 ' + est + '°）');
  const fixed = T.deskewShearRGBA(skewed, est);
  const est2 = T.estimateSkew(grayOf(fixed), fixed.width, fixed.height);
  assert(Math.abs(est2) <= 1.0, '纠偏后倾角归零（实际 ' + est2 + '°）');
  const straightEst = T.estimateSkew(grayOf(straight), 520, 300);
  assert(Math.abs(straightEst) <= 0.75, '水平文档倾角≈0（实际 ' + straightEst + '°）');
}

/* ---------- 4. 百分位拉伸 / 拉普拉斯模糊度 / 锐化 ---------- */
{
  const flat = new Uint8ClampedArray(400).fill(128);
  assert(T.percentileNorm(flat, 20, 20) === flat, '动态范围已足（平灰图）不拉伸');
  const low = new Uint8ClampedArray(400 * 4);
  for (let i = 0; i < low.length; i++) low[i] = 60 + (i % 40); // 60..99
  const stretched = T.percentileNorm(low, 40, 40);
  let mn = 255, mx = 0;
  for (const v of stretched) { if (v < mn) mn = v; if (v > mx) mx = v; }
  assert(mn <= 5 && mx >= 250, '低对比度灰度拉伸到近全幅（' + mn + '..' + mx + '）');
  assert(T.laplacianVar(new Float64Array(2500).fill(100), 50, 50) === 0, '平图拉普拉斯方差为 0');
  const chk = [];
  for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) chk.push((x + y) % 2 ? 30 : 220);
  assert(T.laplacianVar(Float64Array.from(chk), 50, 50) > 1000, '棋盘格拉普拉斯方差很大');
}

/* ---------- 5. Sauvola 二值化（复杂背景压制） ---------- */
{
  // 背景横向渐变 60..190（模拟阴影/复杂底），文字深色
  const w = 300, h = 120;
  const g = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      g[y * w + x] = 60 + Math.round((x / w) * 130);
    }
  }
  drawRect({ data: (() => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g[i]; d[i * 4 + 3] = 255; } return d; })(), width: w, height: h }, 0, 0, 0, 0, 0);
  const px = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  for (let i = 0; i < w * h; i++) { px.data[i * 4] = px.data[i * 4 + 1] = px.data[i * 4 + 2] = g[i]; px.data[i * 4 + 3] = 255; }
  drawRect(px, 40, 40, 80, 24, 15);  // 「文字」
  drawRect(px, 180, 40, 60, 24, 15);
  const bin = T.sauvolaBinarize(grayOf(px), w, h);
  let inkOk = 0, bgOk = 0;
  for (let y = 45; y < 58; y++) for (let x = 60; x < 100; x++) if (bin[y * w + x] === 0) inkOk++;
  for (let y = 10; y < 20; y++) for (let x = 20; x < 200; x++) if (bin[y * w + x] === 255) bgOk++;
  assert(inkOk === 520, '渐变背景上的深色文字完整二值化为墨点（' + inkOk + '/520，无内部镂空）');
  assert(bgOk === 1800, '背景区域全部保留为白（' + bgOk + '/1800）');
}

/* ---------- 6. 二值去噪 ---------- */
{
  const w = 40, h = 40;
  const bin = new Uint8ClampedArray(w * h).fill(255);
  bin[20 * w + 20] = 0; // 孤点
  drawRect({ data: (() => { const d = new Uint8ClampedArray(w * h * 4); d.fill(255); return d; })(), width: w, height: h }, 5, 5, 4, 4, 0);
  const px2 = { data: new Uint8ClampedArray(w * h * 4).fill(255), width: w, height: h };
  drawRect(px2, 5, 5, 4, 4, 0); // 4×4 实心块
  const gray = grayOf(px2);
  const bin2 = T.sauvolaBinarize(gray, w, h);
  const out = T.denoiseBinary(bin2.slice ? bin2 : bin2, w, h);
  const out2 = T.denoiseBinary(bin, w, h);
  assert(out2[20 * w + 20] === 255, '孤立墨点被去除');
  let blk = 0;
  for (let y = 5; y < 9; y++) for (let x = 5; x < 9; x++) if (out[y * w + x] === 0) blk++;
  assert(blk > 8, '4×4 实心块保留（' + blk + ' 点）');
  void bin2; void out;
}

/* ---------- 7. enhance 整体管线 ---------- */
{
  // 低对比度 + 斜 -2.5° 的文档（背景偏亮，验证纠偏 + 二值化）
  const w = 560, h = 360;
  const px = makePx(w, h, [170, 170, 170]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4;
      const v = 150 + Math.round((x / w) * 40); // 150..190 背景渐变
      px.data[j] = v; px.data[j + 1] = v; px.data[j + 2] = v;
    }
  }
  for (let y = 50; y < h - 50; y += 44) drawRect(px, 40, y, w - 80, 7, 90);
  const skewed = T.deskewShearRGBA(px, -2.5);
  const r = global.window.App.ocrEnhance.enhance(skewed);
  assert(r.info.deskewed === true, 'enhance 报告已纠偏');
  assert(r.info.lowLight === false, '亮背景不误报低光照（brightness=' + r.info.brightness + '）');
  let ink = 0, white = 0;
  const d = r.px.data;
  for (let i = 0; i < d.length; i += 4) { if (d[i] === 0) ink++; else if (d[i] === 255) white++; }
  assert(white > d.length / 4 * 0.6, '输出以白底为主（白 ' + white + '）');
  assert(ink > 500, '输出保留文字墨点（墨 ' + ink + '）');
  assert(r.px.width === skewed.width, '增强输出宽度不变');

  // 暗光文档（整体偏暗）应报告低光照
  const dk = makePx(400, 260, [50, 50, 50]);
  for (let y = 30; y < 230; y += 40) drawRect(dk, 30, y, 340, 6, 12);
  const rk = global.window.App.ocrEnhance.enhance(dk);
  assert(rk.info.lowLight === true, '暗光文档报告低光照（brightness=' + rk.info.brightness + '）');
}

/* ---------- 8. 文本归一 ---------- */
assert(T.normalizeLine('１２３ＡＢＣ') === '123ABC', '全角数字字母转半角');
assert(T.normalizeLine('你\u3000好， 世界 。') === '你好，世界。', '全角空格与中文间空格压缩、标点前空格去除');
assert(T.normalizeLine('  Hello   World  ') === 'Hello World', '西文多空格压缩、首尾清理');
assert(T.normalizeLine('《 简介 》内容') === '《简介》内容', '书名号内侧空格去除');

/* ---------- 9. 数字上下文纠错 ---------- */
assert(T.fixDigitContext('电话 138O0O12345') === '电话 13800012345', '长数字串内 O→0');
assert(T.fixDigitContext('编号 2026O') === '编号 20260', '数字尾随 O→0');
assert(T.fixDigitContext('编号 IlZSBG123') === '编号 112586123', '数字串内 I/l/Z/S/B/G 逐一映射');
assert(T.fixDigitContext('ZOO OK lOve') === 'ZOO OK lOve', '纯字母单词不受影响');
assert(T.fixDigitContext('房间 l02 室') === '房间 102 室', 'l+数字 组合纠为 1');
assert(T.fixDigitContext('plain text') === 'plain text', '普通西文不变');

/* ---------- 10. 身份证校验与纠错 ---------- */
{
  // 按算法构造合法号：前 17 位自定，末位由权重推出
  const base = '11010519491231002';
  const W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const MAP = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(base[i]) * W[i];
  const valid = base + MAP[sum % 11];
  assert(T.idChecksumOk(valid) === true, '构造的身份证号校验通过');
  // 把第 2 位 '1' 换成 'I'（OCR 常见混淆）→ 校验失败 → 应唯一纠回
  const broken = valid[0] + 'I' + valid.slice(2);
  assert(T.idChecksumOk(broken) === false, '混淆位证号校验失败');
  assert(T.fixIdCard(broken) === valid, '混淆位证号唯一纠回（' + T.fixIdCard(broken) + '）');
  assert(T.fixIdCard('123') === null, '非法格式不纠错');
  assert(T.fixIdCard(valid) === null, '合法证号无需纠错');

  const f = T.extractFields('联系电话 13812345678，证件号 ' + valid + '，日期 2026年10月21日。');
  assert(f.phones.length === 1 && f.phones[0] === '13812345678', '手机号提取');
  assert(f.idCards.length === 1 && f.idCards[0].valid && !f.idCards[0].fixed, '合法证号提取且标记有效');
  assert(f.dates.length === 1 && f.dates[0] === '2026年10月21日', '中文日期提取');
  const f2 = T.extractFields('证件号 ' + valid.slice(0, 17) +
    (valid[17] === '5' ? '6' : '5') + ' 请核对');
  assert(f2.idCards.length === 1 && f2.idCards[0].valid === false,
    '校验失败的证号被提取且标记无效（不误报纠错）');
}

/* ---------- 11. 展示宽度与网格对齐 ---------- */
assert(T.displayWidth('中a') === 3, 'CJK 计 2、西文计 1');
{
  const grid = T.renderGrid({
    rows: [
      ['姓名', '数量'],
      ['张三', '12'],
      ['O 外', '345']
    ],
    colCount: 2
  });
  const lines = grid.split('\n');
  assert(lines.length === 3, '网格逐行输出');
  assert(lines[0].indexOf('姓') < lines[0].indexOf('数'), '列顺序保持');
  const dw0 = T.displayWidth(lines[0]);
  assert(lines.every(function (l) { return T.displayWidth(l) === dw0; }), '各行展示宽度一致（全角补齐对齐）');
}

/* ---------- 12. 段落重建 ---------- */
{
  // 同段两行（y 连续）应连接；大间隔另起段
  const lines = [
    { text: '第一段第一行内容', x0: 10, y0: 10, x1: 210, y1: 30, words: [], conf: 90 },
    { text: '第一段第二行内容', x0: 10, y0: 34, x1: 210, y1: 54, words: [], conf: 90 },
    { text: '第二段标题行', x0: 10, y0: 120, x1: 210, y1: 140, words: [], conf: 90 }
  ];
  const out = T.rebuildParagraphs(lines);
  assert(out === '第一段第一行内容第一段第二行内容\n\n第二段标题行', 'CJK 同段拼接无空格、段间空行（实际: ' + JSON.stringify(out) + '）');
  const linesEn = [
    { text: 'Hello world', x0: 10, y0: 10, x1: 210, y1: 30, words: [], conf: 90 },
    { text: 'next line', x0: 10, y0: 34, x1: 210, y1: 54, words: [], conf: 90 }
  ];
  assert(T.rebuildParagraphs(linesEn) === 'Hello world next line', '西文同段以空格连接');
}

/* ---------- 13. blocks 收集与版面还原 ---------- */
function word(text, x0, y0, x1, y1, conf) {
  return { text: text, confidence: conf, bbox: { x0: x0, y0: y0, x1: x1, y1: y1 } };
}
{
  const blocks = [{
    paragraphs: [{
      lines: [
        { text: 'Hello', bbox: { x0: 10, y0: 10, x1: 120, y1: 40 }, words: [word('Hello', 10, 10, 120, 40, 95)] },
        { text: 'World', bbox: { x0: 10, y0: 44, x1: 120, y1: 74 }, words: [word('World', 10, 44, 120, 74, 85)] }
      ]
    }]
  }];
  const lines = T.collectLines(blocks);
  assert(lines.length === 2 && lines[0].text === 'Hello', 'collectLines 提取行并按 y 排序');
  const built = global.window.App.ocrEnhance.buildFromBlocks({ blocks: blocks });
  assert(built && built.text === 'Hello World', '无表格时段落重建（西文空格连接）');
  assert(typeof built.conf === 'number' && built.conf === 90, '行级置信度均值（' + built.conf + '）');
}

/* ---------- 14. 表格检测与还原 ---------- */
{
  // 3 行 × 2 列整齐词格（行级 bbox 与词级 bbox 都要有，与 Tesseract 输出同构）
  function row(y, c1, c2) {
    return {
      text: c1 + ' ' + c2, bbox: { x0: 20, y0: y, x1: 300, y1: y + 24 },
      words: [word(c1, 20, y, 140, y + 24, 92), word(c2, 180, y, 300, y + 24, 92)]
    };
  }
  const blocks = [{
    paragraphs: [{
      lines: [row(10, '姓名', '数量'), row(40, '张三', '12'), row(70, '李四', '34')]
    }]
  }];
  const lines = T.collectLines(blocks);
  const table = T.detectTable(lines);
  assert(!!table && table.colCount === 2 && table.rows.length === 3, '识别出 2 列 × 3 行表格');
  const built = global.window.App.ocrEnhance.buildFromBlocks({ blocks: blocks });
  assert(built && built.hasTable === true, 'buildFromBlocks 标记表格还原');
  assert(built.text.indexOf('张三') >= 0 && built.text.indexOf('34') >= 0, '表格内容进入输出');
  const gl = built.text.split('\n');
  assert(gl.length >= 3 && gl.every(function (l) { return T.displayWidth(l) === T.displayWidth(gl[0]); }),
    '网格各行展示宽度一致（全角补齐）');
}

/* ---------- 15. 列对齐推断 / 相对列宽 / 对齐渲染 ---------- */
assert(T.padStartDW('12', 4) === '\u3000' + '12', 'padStartDW 全角前置补位（展示宽 2）');
assert(T.displayWidth(T.padStartDW('', 3)) === 3, 'padStartDW 空串补满');
let blocksA;
{
  // 3 列：左对齐文本（x0 恒定）/ 右对齐数字（x1 恒定）/ 居中（中心恒定）
  function row3(y) {
    return {
      text: 'r', bbox: { x0: 20, y0: y, x1: 430, y1: y + 24 },
      words: [
        word('姓名', 20, y, 140, y + 24, 92),
        word(y === 40 ? '9' : '12', y === 40 ? 200 : 180, y, 300, y + 24, 92),
        // 居中列：中心恒定 390、宽度随字变化（否则与左对齐不可区分）
        word('甲', 350, y, 430, y + 24, 92)
      ]
    };
  }
  blocksA = [{ paragraphs: [{ lines: [row3(10), row3(40), row3(70)] }] }];
  blocksA[0].paragraphs[0].lines[1].words[2] = word('乙', 360, 40, 420, 64, 92);
  const table = T.detectTable(T.collectLines(blocksA));
  assert(!!table && table.colCount === 3, '三列表格检出');
  assert(table.aligns.join(',') === 'left,right,center',
    '列对齐推断为 左/右/中（实际 ' + table.aligns.join(',') + '）');
  assert(table.widths.length === 3 && table.widths.every(function (w) { return w > 0; }),
    '相对列宽齐全且为正');
  // 右对齐列在网格文本中右对齐（前置补格）
  const gridTxt = T.renderGrid({ rows: [['A', '12'], ['BB', '9']], aligns: ['left', 'right'] });
  const gl = gridTxt.split('\n');
  assert(gl[0] === 'A   12' && gl[1] === 'BB   9', '网格按列对齐补格（右对齐列前置空格）');
  const gridC = T.renderGrid({ rows: [['A', '乙'], ['BB', '甲']], aligns: ['left', 'center'] });
  assert(T.displayWidth(gridC.split('\n')[0]) === T.displayWidth(gridC.split('\n')[1]),
    '居中列各行展示宽度一致');
}

/* ---------- 16. 段落缩进识别与结构化模型 ---------- */
{
  const lines = [
    { text: '普通段落起点', x0: 10, y0: 10, x1: 210, y1: 30, words: [], conf: 90 },
    { text: '缩进段落起点', x0: 58, y0: 120, x1: 210, y1: 140, words: [], conf: 90 }
  ];
  const blocks = T.rebuildBlocks(lines);
  assert(blocks.length === 2 && blocks[0].type === 'p' && blocks[0].indent === 0,
    '顶格段 indent=0');
  assert(blocks[1].indent === 1, '首行缩进段 indent=1（x0 偏移 > 1.2·行高）');
  assert(T.rebuildParagraphs(lines) === blocks.map(function (b) { return b.text; }).join('\n\n'),
    'rebuildParagraphs 为 blocks 的文本视图');

  // 结构化文档模型：无表格 → 纯段落块
  const docP = global.window.App.ocrEnhance.buildDoc({
    blocks: [{ paragraphs: [{ lines: [
      { text: 'Hello', bbox: { x0: 10, y0: 10, x1: 120, y1: 40 }, words: [word('Hello', 10, 10, 120, 40, 95)] },
      { text: 'World', bbox: { x0: 10, y0: 44, x1: 120, y1: 74 }, words: [word('World', 10, 44, 120, 74, 85)] }
    ] }] }]
  });
  assert(docP && docP.blocks.length === 1 && docP.blocks[0].type === 'p' &&
    docP.blocks[0].text === 'Hello World' && !docP.hasTable, 'buildDoc 无表格产出段落块');

  // 结构化文档模型：含表格 → 段落块 + 表格块（带对齐）
  const docT = global.window.App.ocrEnhance.buildDoc({ blocks: blocksA });
  assert(docT.hasTable === true, 'buildDoc 标记含表格');
  const tb = docT.blocks.filter(function (b) { return b.type === 'table'; })[0];
  assert(!!tb && tb.rows.length === 3 && tb.aligns.length === 3, '表格块携带行列与对齐');
  assert(global.window.App.ocrEnhance.renderDocText(docT.blocks).indexOf('姓名') >= 0,
    'renderDocText 渲染表格块');
}

/* ---------- 17. 页面尺寸与方向判定 ---------- */
{
  const docT2 = global.window.App.ocrEnhance.buildDoc({ blocks: blocksA });
  assert(docT2.page && docT2.page.w > 0 && docT2.page.h > 0,
    'buildDoc 产出页面外接尺寸（' + JSON.stringify(docT2.page) + '）');
  assert(docT2.page.w === 430 && docT2.page.h === 94, '页面尺寸取词级 bbox 最大边界');
  assert(global.window.App.ocrEnhance.pageOrientation(docT2) === 'l',
    '宽 > 高时判为横向（430×94）');
  const tall = global.window.App.ocrEnhance.buildDoc({
    blocks: [{ paragraphs: [{ lines: [
      { text: 'A', bbox: { x0: 10, y0: 10, x1: 200, y1: 40 }, words: [word('A', 10, 10, 200, 40, 90)] },
      { text: 'B', bbox: { x0: 10, y0: 60, x1: 180, y1: 90 }, words: [word('B', 10, 60, 180, 90, 90)] },
      { text: 'C', bbox: { x0: 10, y0: 110, x1: 160, y1: 140 }, words: [word('C', 10, 110, 160, 140, 90)] },
      { text: 'D', bbox: { x0: 10, y0: 160, x1: 190, y1: 190 }, words: [word('D', 10, 160, 190, 190, 90)] }
    ] }] }]
  });
  assert(global.window.App.ocrEnhance.pageOrientation(tall) === 'p',
    '竖向页（200×190 比例 < 1.2）判为竖向');
  assert(global.window.App.ocrEnhance.pageOrientation(null) === 'p', '无文档回退竖向');
}

console.log('\n共 ' + (pass + fail) + ' 项断言：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
