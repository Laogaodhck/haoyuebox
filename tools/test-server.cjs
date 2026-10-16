/* static-server.js 独立测试：MIME、路径穿越防护、asar 式路径读取 */
'use strict';
const http = require('http');
const path = require('path');
const { createStaticServer } = require(path.join(__dirname, '..', 'electron', 'static-server.js'));

const ROOT = path.join(__dirname, '..');

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + port + p, res => {
      let data = [];
      res.on('data', c => data.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], len: Buffer.concat(data).length }));
    }).on('error', reject);
  });
}

(async () => {
  let pass = 0, fail = 0;
  const assert = (c, n) => { if (c) { pass++; console.log('  ok -', n); } else { fail++; console.log('  FAIL -', n); } };

  const { port, close } = await createStaticServer(ROOT);
  assert(port > 0, '随机端口监听成功: ' + port);

  const idx = await get(port, '/');
  assert(idx.status === 200 && idx.type.includes('text/html'), 'index.html 200');
  assert(idx.len > 3000, 'index.html 内容完整');

  const wasm = await get(port, '/vendor/mediapipe/wasm/vision_wasm_internal.wasm');
  assert(wasm.status === 200 && wasm.type === 'application/wasm', 'wasm MIME 正确');

  const tflite = await get(port, '/vendor/mediapipe/models/selfie_segmenter.tflite');
  assert(tflite.status === 200 && tflite.len === 249537, '模型文件字节完整');

  const ico = await get(port, '/assets/icon.png');
  assert(ico.status === 200 && ico.type === 'image/png', 'icon.png 可访问');

  const evil = await get(port, '/..%2F..%2Fzunhong%2FREADME.md');
  assert(evil.status === 403 || evil.status === 404, '路径穿越被拒绝');

  const missing = await get(port, '/no-such-file.js');
  assert(missing.status === 404, '404 处理正确');

  close();
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
