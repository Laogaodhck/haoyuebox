/* ============================================================
 * test-ocr-umi.cjs — Umi-OCR 接入测试
 *  1) 主进程 HTTP 客户端：参数探测 / 识别成功 / 无文本 / 错误码 / 地址规范化
 *     （用本机临时 HTTP 服务模拟 Umi-OCR，不依赖真实安装）
 *  2) 渲染层适配：参数裁剪、四角框 → 行框、文本还原、置信度换算
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { ROOT, createChecker } = require('./_lib.cjs');

const checker = createChecker();
const assert = checker.assert;

/* ---------- 加载渲染层模块（经典脚本 + window 桩） ---------- */
global.window = { App: {} };
eval(fs.readFileSync(path.join(ROOT, 'js', 'ocr-umi.js'), 'utf8'));
const U = global.window.App.ocrUmi._test;

/* ---------- 1. 主进程客户端 ---------- */
const umi = require(path.join(ROOT, 'electron', 'umi-ocr.js'));

assert(umi.normalizeBase('') === umi.DEFAULT_BASE, '空地址回退默认 127.0.0.1:1224');
assert(umi.normalizeBase('127.0.0.1:9000/') === 'http://127.0.0.1:9000', '缺协议自动补 http:// 并去尾斜杠');
assert(umi.normalizeBase('http://192.168.1.8:1224/api/ocr') === 'http://192.168.1.8:1224', '带路径地址归一为 origin');
let badProto = false;
try { umi.normalizeBase('ftp://127.0.0.1:21'); } catch (e) { badProto = true; }
assert(badProto, '非 http/https 协议被拒绝');

const OPTIONS_FIXTURE = {
  'ocr.language': {
    type: 'enum',
    default: 'models/config_chinese.txt',
    optionsList: [
      ['models/config_chinese.txt', '简体中文'],
      ['models/config_en.txt', 'English'],
      ['models/config_chinese_cht(v2).txt', '繁體中文']
    ]
  },
  'ocr.cls': { type: 'boolean', default: false },
  'ocr.limit_side_len': { type: 'enum', default: 960, optionsList: [[960, '960'], [4320, '4320']] },
  'tbpu.parser': { type: 'enum', default: 'multi_para', optionsList: [['multi_para', '多栏'], ['multi_line', '多栏-总是换行']] },
  'data.format': { type: 'enum', default: 'dict', optionsList: [['dict', '字典'], ['text', '纯文本']] }
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const send = (obj) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(obj));
        };
        if (req.url === '/api/ocr/get_options') {
          send(OPTIONS_FIXTURE);
          return;
        }
        if (req.url === '/api/ocr') {
          let payload = {};
          try { payload = JSON.parse(body || '{}'); } catch (e) { payload = {}; }
          if (!payload.base64) {
            send({ code: 902, data: '缺少图片数据' });
            return;
          }
          if (payload.base64 === 'EMPTY') {
            send({ code: 101, data: '未识别到文本', time: 0.02 });
            return;
          }
          send({
            code: 100,
            time: 0.12,
            data: [
              { text: '第一行', score: 0.99, box: [[10, 10], [110, 10], [110, 40], [10, 40]], end: '\n' },
              { text: '第二行', score: 0.8, box: [[10, 50], [110, 50], [110, 80], [10, 80]], end: '' }
            ]
          });
          return;
        }
        res.writeHead(404);
        res.end('not found');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async function main() {
  const server = await startServer();
  const port = server.address().port;
  const base = '127.0.0.1:' + port;

  try {
    const p = await umi.probe(base);
    assert(p.ok === true && p.options && p.options['ocr.language'], '探测接口返回参数定义');

    const r = await umi.recognize({ base, base64: 'ABC', options: { 'data.format': 'dict' } });
    assert(r.ok && r.code === 100 && r.data.length === 2, '识别成功返回两行结果');
    assert(r.time === 0.12, '识别耗时透传');

    const e = await umi.recognize({ base, base64: 'EMPTY', options: {} });
    assert(e.ok && e.code === 101 && e.empty && e.data.length === 0, 'code 101 视为无文本而非失败');

    let err = '';
    try { await umi.recognize({ base, base64: '', options: {} }); } catch (ex) { err = ex.message; }
    assert(/缺少图片数据/.test(err), '空图片数据本地拦截');

    err = '';
    try { await umi.recognize({ base: 'http://127.0.0.1:1', base64: 'A', options: {} }); } catch (ex) { err = ex.message; }
    assert(/无法连接 Umi-OCR/.test(err), '连接拒绝给出可操作提示');
  } finally {
    server.close();
  }

  /* ---------- 2. 渲染层适配 ---------- */
  assert(U.pickLanguage(OPTIONS_FIXTURE['ocr.language'].optionsList, 'both') === 'models/config_chinese.txt',
    '中英混合选简体中文模型');
  assert(U.pickLanguage(OPTIONS_FIXTURE['ocr.language'].optionsList, 'zh') === 'models/config_chinese.txt',
    '仅中文选简体中文模型');
  assert(U.pickLanguage(OPTIONS_FIXTURE['ocr.language'].optionsList, 'en') === 'models/config_en.txt',
    '仅英文选英文模型');
  assert(U.pickLanguage([], 'en') === '', '无模型列表时不下发语言参数');

  const optAuto = U.pickOptions(OPTIONS_FIXTURE, 'both', 'auto', true);
  assert(optAuto['data.format'] === 'dict', '固定请求结构化字典');
  assert(optAuto['tbpu.parser'] === 'multi_para', '智能排版用多栏自然段解析');
  assert(optAuto['ocr.cls'] === true, '开启增强时启用方向纠正');
  assert(optAuto['ocr.limit_side_len'] === 4320, '大图限制边长取较高精度档');
  const optPlain = U.pickOptions(OPTIONS_FIXTURE, 'en', 'plain', false);
  assert(optPlain['tbpu.parser'] === 'multi_line' && optPlain['ocr.cls'] === undefined,
    '纯文本模式按行解析且不启用方向纠正');
  const optNone = U.pickOptions(null, 'both', 'auto', true);
  assert(optNone['data.format'] === 'dict' && !optNone['ocr.language'],
    '无参数定义时只请求字典格式');

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

  /* ---------- 3. RapidOCR 渲染层适配 ---------- */
  assert(U.rapidLang('en') === 'en', '仅英文用英文模型');
  assert(U.rapidLang('zh') === 'zh' && U.rapidLang('both') === 'zh',
    '中英混合 / 中文共用中文模型');
  assert(global.window.App.ocrUmi.rapidAvailable() === false, '无桥接时 RapidOCR 标记为不可用');

  checker.finish();
})();
