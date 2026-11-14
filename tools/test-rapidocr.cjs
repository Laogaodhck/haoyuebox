/* ============================================================
 * test-rapidocr.cjs — RapidOCR 引擎（RapidOCR-json）测试
 *
 * 引擎已改为按需下载（约 40 MB，不入库），因此本测试分两档：
 *  1) 结构测试（始终执行）：结果码归一、状态结构；
 *  2) 真实引擎测试（仅当本机已安装引擎，如开发期 electron/bin/umi-ocr
 *     或已通过应用下载）：文件清单、白图判空、英文识别、中英模型切换、
 *     并发串行、退出释放。
 * 下载/解压链路见 test-ocr-engine.cjs（用本地假包，不依赖公网）。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { Jimp, loadFont } = require('jimp');
const { SANS_32_BLACK } = require('jimp/fonts');
const { ROOT, createChecker } = require('./_lib.cjs');

const checker = createChecker();
const assert = checker.assert;
const rapid = require(path.join(ROOT, 'electron', 'rapidocr.js'));

const info = rapid.locate();
const hasEngine = !!info.dir && info.missing.length === 0;

/* ---------- 1. 结果码归一 ---------- */
const okRes = rapid.normalizeResult({
  code: 100,
  data: [{ text: '合计 100', score: 0.9, box: [[0, 0], [10, 0], [10, 10], [0, 10]] }]
}, 120);
assert(okRes.ok && okRes.code === 100 && okRes.data.length === 1 && okRes.empty === false,
  'code 100 返回识别项');
assert(okRes.time === 0.12, '毫秒耗时换算为秒');

const emptyRes = rapid.normalizeResult({ code: 101, data: '' }, 50);
assert(emptyRes.ok && emptyRes.empty && emptyRes.data.length === 0, 'code 101 视为无文字');

let errMsg = '';
try {
  rapid.normalizeResult({ code: 301, data: 'Base64 data imdecode failed.' }, 10);
} catch (e) { errMsg = e.message; }
assert(/301/.test(errMsg) && /imdecode/.test(errMsg), '其它错误码抛出可读异常');

/* ---------- 2. 状态结构 ---------- */
const engineStatus = rapid.engine.status();
assert(engineStatus.ok === true && engineStatus.available === hasEngine, '状态与实际引擎文件一致');
assert(engineStatus.installed === hasEngine, 'installed 标记与可用性一致');
if (!hasEngine) assert(/下载/.test(engineStatus.error), '未安装时提示下载引擎');

/* ---------- 3. 真实引擎（可选） ---------- */
if (!hasEngine) {
  console.log('\n[跳过] 本机未安装 RapidOCR 引擎（' + (info.dir || rapid.engine.status().dir)
    + '），仅执行结构断言。安装后可复跑以验证真实识别链路。');
  checker.finish();
} else {
  const modelDir = path.join(info.dir, 'models');
  const configs = fs.readFileSync(path.join(modelDir, 'configs.txt'), 'utf8');
  const blocks = configs.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  assert(blocks.length === 10, 'configs.txt 仅保留 2 种语言（10 行）');
  assert(blocks[0] === '简体中文' && blocks.indexOf('English') > 0, '保留简体中文与 English');
  assert(blocks.indexOf('日本語') < 0 && blocks.indexOf('繁體中文') < 0, '已裁剪未随包的语言');
  assert(blocks.indexOf('ch_PP-OCRv4_det_infer.onnx') < 0, '未引用未随包的 v4 检测模型');
  for (let i = 0; i < blocks.length; i += 5) {
    const files = blocks.slice(i + 1, i + 5);
    assert(files.every((f) => fs.existsSync(path.join(modelDir, f))),
      blocks[i] + ' 引用的模型与字典均存在');
  }

  (async function main() {
    const white = (await new Jimp({ width: 360, height: 120, color: 0xffffffff })
      .getBuffer('image/png')).toString('base64');
    const r1 = await rapid.engine.recognize(white, 'zh');
    assert(r1.ok && r1.empty, '空白图返回无文字（code ' + r1.code + '）');
    assert(rapid.engine.status().running, '识别后引擎进程常驻复用');

    const font = await loadFont(SANS_32_BLACK);
    const img = new Jimp({ width: 620, height: 160, color: 0xffffffff });
    img.print({ font, x: 20, y: 60, text: 'Hello World 123' });
    const textB64 = (await img.getBuffer('image/png')).toString('base64');

    const r2 = await rapid.engine.recognize(textB64, 'en');
    const joined = r2.data.map((d) => d.text).join(' ');
    assert(r2.ok && !r2.empty, '英文文字图识别出内容');
    assert(/hello/i.test(joined) && /123/.test(joined), '识别文本含 Hello 与 123（实际：' + joined + '）');
    assert(rapid.engine.status().lang === 'en', '语言切换后引擎使用英文模型');

    /* 并发：管道协议必须串行，否则两次结果会错配 */
    const [a, b] = await Promise.all([
      rapid.engine.recognize(white, 'zh'),
      rapid.engine.recognize(textB64, 'zh')
    ]);
    assert(a.empty && !b.empty, '并发请求按队列串行，结果不串台');

    await rapid.engine.stop();
    assert(!rapid.engine.status().running, 'stop 后引擎进程已释放');

    checker.finish();
  })().catch(async (e) => {
    console.error('测试异常:', e && e.message ? e.message : e);
    try { await rapid.engine.stop(); } catch (err) { /* 已退出 */ }
    process.exit(1);
  });
}
