/* ============================================================
 * test-ocr-umi.cjs — OCR 引擎接入（渲染层）测试
 *  1) 结果转换：四角框 → 行框、按空白切词、文本还原、置信度换算
 *  2) RapidOCR 适配：语言模型选择、无桥接时的能力标记与预热返回
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { ROOT, createChecker } = require('./_lib.cjs');

const checker = createChecker();
const assert = checker.assert;

/* ---------- 加载渲染层模块（经典脚本 + window 桩） ---------- */
global.window = { App: {} };
eval(fs.readFileSync(path.join(ROOT, 'js', 'ocr-umi.js'), 'utf8'));
const U = global.window.App.ocrUmi._test;

/* ---------- 1. 结果转换 ---------- */
const bb = U.boxBounds([[10, 20], [110, 20], [110, 60], [10, 60]]);
assert(bb.x0 === 10 && bb.y0 === 20 && bb.x1 === 110 && bb.y1 === 60, '四角坐标转外接矩形');
assert(U.boxBounds([]).x0 === 0 && U.boxBounds([]).x1 === 0, '空四角框退回零尺寸');

const words = U.splitWords('项目 金额', { x0: 0, y0: 0, x1: 40, y1: 20 }, 90);
assert(words.length === 2 && words[0].text === '项目' && words[0].bbox.x1 === 20,
  '按空白切词并按字符比例分配词框');
assert(words[1].bbox.x0 === 20 && words[1].bbox.x1 === 40, '第二个词框接续且总宽不变');

assert(U.buildText([
  { text: '第一行', end: '\n' },
  { text: '第二行', end: '' }
]) === '第一行\n第二行', '按行尾结束符还原文本');
assert(U.buildText([]) === '', '空结果得空串');

const data = U.convert([
  { text: '合计 100', score: 0.9, box: [[0, 0], [100, 0], [100, 20], [0, 20]], end: '\n' }
]);
assert(data.blocks.length === 1 && data.blocks[0].paragraphs[0].lines.length === 1,
  '转换为 Tesseract 同构 blocks');
assert(Math.round(data.confidence) === 90, '置信度由 0~1 换算为 0~100');
assert(data.text === '合计 100\n', '纯文本输出保留行尾换行');
assert(U.convert([]).blocks.length === 0, '空结果不产生 blocks');

/* ---------- 2. RapidOCR 适配 ---------- */
assert(U.rapidLang('en') === 'en', '仅英文用英文模型');
assert(U.rapidLang('zh') === 'zh' && U.rapidLang('both') === 'zh',
  '中英混合 / 中文共用中文模型');
assert(global.window.App.ocrUmi.rapidAvailable() === false, '无桥接时 RapidOCR 标记为不可用');
assert(typeof global.window.App.ocrUmi.rapidWarmup === 'function', '导出引擎预热接口');

global.window.App.ocrUmi.rapidWarmup('zh').then((r) => {
  assert(r && r.ok === false && /仅桌面版可用/.test(r.error || ''), '无桥接时预热返回可读错误');
  checker.finish();
});
