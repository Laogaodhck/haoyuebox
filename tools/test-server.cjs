/* static-server.js 独立测试：MIME、路径穿越防护、asar 式路径读取、
   Host 白名单、方法限制、前缀碰撞，以及 tools/server.js（浏览器模式）
   的同等防护与局域网 Host 放行。 */
'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { createStaticServer, resolveWithin, hostAllowed } = require(path.join(__dirname, '..', 'electron', 'static-server.js'));

const ROOT = path.join(__dirname, '..');

function get(port, p, opts) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: p, headers: (opts && opts.headers) || {} }, res => {
      let data = [];
      res.on('data', c => data.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], len: Buffer.concat(data).length }));
    });
    req.on('error', reject);
  });
}

function request(port, p, opts) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: port, path: p, method: (opts && opts.method) || 'GET', headers: (opts && opts.headers) || {} }, res => {
      let data = [];
      res.on('data', c => data.push(c));
      res.on('end', () => resolve({ status: res.statusCode, len: Buffer.concat(data).length }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  let pass = 0, fail = 0, skipped = 0;
  const assert = (c, n) => { if (c) { pass++; console.log('  ok -', n); } else { fail++; console.log('  FAIL -', n); } };
  const skip = (n) => { skipped++; console.log('  skip -', n); };

  /* ---------- resolveWithin 单元：路径守卫 ---------- */
  assert(resolveWithin(ROOT, '/index.html') === path.normalize(path.join(ROOT, 'index.html')), 'resolveWithin 正常路径');
  assert(resolveWithin(ROOT, '/js/app.js') !== null, 'resolveWithin 子目录路径');
  assert(resolveWithin(ROOT, '/../../etc/passwd') === null, 'resolveWithin 拒绝 .. 穿越');
  assert(resolveWithin(ROOT, '/..%2F..%2Fetc%2Fpasswd') === null, 'resolveWithin 拒绝编码穿越');
  assert(resolveWithin(ROOT, '/js/../../package.json') === null, 'resolveWithin 拒绝中段穿越');
  assert(resolveWithin(ROOT, '/../' + path.basename(ROOT) + '2/x') === null, 'resolveWithin 拒绝同前缀兄弟目录（前缀碰撞）');
  assert(resolveWithin(ROOT, '/a%00b') === null, 'resolveWithin 拒绝 NUL 字节');
  assert(resolveWithin(ROOT, '/%E0%A4%A') === null, 'resolveWithin 拒绝畸形百分号编码');
  assert(resolveWithin(ROOT, '/') === path.resolve(ROOT), 'resolveWithin 根路径');

  /* ---------- hostAllowed 单元 ---------- */
  assert(hostAllowed('127.0.0.1:1234', new Set(['127.0.0.1'])), 'hostAllowed 回环带端口放行');
  assert(hostAllowed('[::1]:1234', new Set(['::1'])), 'hostAllowed IPv6 字面量放行');
  assert(!hostAllowed('evil.example.com', new Set(['127.0.0.1', 'localhost'])), 'hostAllowed 拒绝外部 Host');
  assert(hostAllowed('', new Set(['127.0.0.1'])), 'hostAllowed 无 Host 头放行（HTTP/1.0，交由回环绑定兜底）');

  /* ---------- static-server.js 行为 ---------- */
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

  const evil = await get(port, '/..%2F..%2Fhaoyue%2FREADME.md');
  assert(evil.status === 403 || evil.status === 404, '路径穿越被拒绝');

  const evil2 = await get(port, '/..%2F' + encodeURIComponent(path.basename(ROOT) + '2') + '%2Fsecret.txt');
  assert(evil2.status === 403, '同前缀兄弟目录碰撞被拒绝');

  const badHost = await get(port, '/', { headers: { Host: 'evil.example.com' } });
  assert(badHost.status === 403, '外部 Host 被拒绝（DNS rebinding 防护）');

  const post = await request(port, '/', { method: 'POST' });
  assert(post.status === 405, 'POST 方法被拒绝（405）');

  const head = await request(port, '/index.html', { method: 'HEAD' });
  assert(head.status === 200 && head.len === 0, 'HEAD 请求正常且无 body');

  const missing = await get(port, '/no-such-file.js');
  assert(missing.status === 404, '404 处理正确');

  close();

  /* ---------- tools/server.js（浏览器模式，含局域网 Host 放行） ---------- */
  const srvPort = 18770 + (process.pid % 200);
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(srvPort) }),
    stdio: 'ignore'
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await get(srvPort, '/'); up = r.status === 200; } catch (e) { await new Promise(r => setTimeout(r, 150)); }
    }
    assert(up, 'server.js 启动并可访问');

    const okHost = await get(srvPort, '/', { headers: { Host: 'localhost:' + srvPort } });
    assert(okHost.status === 200, 'server.js localhost Host 放行');

    const evilHost = await get(srvPort, '/', { headers: { Host: 'evil.example.com' } });
    assert(evilHost.status === 403, 'server.js 外部 Host 被拒绝');

    const os = require('os');
    let lanIp = '';
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list || []) if (n.family === 'IPv4' && !n.internal) lanIp = n.address;
    }
    if (lanIp) {
      const lan = await get(srvPort, '/', { headers: { Host: lanIp + ':' + srvPort } });
      assert(lan.status === 200, 'server.js 本机局域网 IP Host 放行（手机访问功能保留）');
    } else {
      // 无局域网 IP 时确实无可断言项：显式记 skip 而非 assert(true) 冒充通过
      skip('server.js 无局域网 IP，跳过手机访问用例');
    }

    const cross = await get(srvPort, '/..%2F..%2Fetc%2Fpasswd');
    assert(cross.status === 403, 'server.js 路径穿越被拒绝');

    const post2 = await request(srvPort, '/', { method: 'POST' });
    assert(post2.status === 405, 'server.js POST 方法被拒绝（405）');
  } finally {
    child.kill();
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败'
    + (skipped ? '（另跳过 ' + skipped + ' 项：环境不满足）' : ''));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
