/* ============================================================
 * _lib.cjs — tools/ 脚本共用工具
 * 断言计数、本地静态服务、Chromium 启动、测试照片解析。
 *
 * 环境覆盖（全部可选，便于换机器运行）：
 *   ZUNHONG_PHOTO     E2E 用单人正面照的绝对路径
 *   ZUNHONG_CHROMIUM  Chrome 可执行文件路径（默认用 Playwright 自带浏览器）
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 通过则计数、失败则打印；finish() 汇总并以失败数决定退出码 */
function createChecker() {
  let pass = 0, fail = 0;
  return {
    assert(cond, name) {
      if (cond) { pass++; console.log('  ok - ' + name); }
      else { fail++; console.log('  FAIL - ' + name); }
    },
    finish() {
      console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
      process.exit(fail ? 1 : 0);
    }
  };
}

/* E2E 测试照片：真人照片不入库（隐私），按需从环境变量或 fixtures/ 提供 */
function resolvePhoto() {
  const candidates = [
    process.env.ZUNHONG_PHOTO,
    path.join(ROOT, 'fixtures', 'photo.jpg'),
    path.join(ROOT, 'fixtures', 'photo.jpeg'),
    path.join(ROOT, 'fixtures', 'photo.png')
  ].filter(Boolean);
  for (const c of candidates) {
    const p = path.resolve(c);
    if (fs.existsSync(p)) return p;
  }
  throw new Error('找不到 E2E 测试照片。请把一张单人正面照放为 fixtures/photo.jpg，'
    + '或设置 ZUNHONG_PHOTO=<照片绝对路径> 后重试。');
}

async function launchBrowser() {
  const chromium = require('playwright').chromium;
  const exe = process.env.ZUNHONG_CHROMIUM;
  try {
    return await chromium.launch(exe ? { executablePath: exe } : {});
  } catch (e) {
    throw new Error('Chromium 启动失败：' + String(e.message || e).split('\n')[0]
      + '\n  请先执行 npx playwright install chromium，'
      + '或设置 ZUNHONG_CHROMIUM=<chrome.exe 绝对路径>');
  }
}

/* 起零依赖静态服务，等它真正可访问后再执行 fn，结束时关掉子进程。
 * 端口被无关进程的临时连接（如 CLOSE_WAIT）占住时自动换下一个端口重试
 * （最多试 5 个），实际端口以参数形式传给 fn，页内 URL 一律用该参数 */
async function withServer(port, fn) {
  let server = null;
  let realPort = port;
  for (let t = 0; t < 5 && !server; t++) {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(realPort) }),
      stdio: 'ignore'
    });
    const okBind = await new Promise((resolve) => {
      let exited = false;
      child.on('exit', () => { exited = true; });
      setTimeout(() => resolve(!exited), 400); // EADDRINUSE 会立即退出
    });
    if (okBind) { server = child; break; }
    try { child.kill(); } catch (e) { /* 已退出 */ }
    realPort++;
  }
  if (!server) throw new Error('静态服务启动失败（端口 ' + port + '-' + realPort + ' 均被占用）');
  try {
    for (let i = 0; i < 100; i++) {
      try {
        const res = await fetch('http://127.0.0.1:' + realPort + '/', { signal: AbortSignal.timeout(500) });
        if (res.ok) break;
      } catch (e) { /* 还没起来 */ }
      await sleep(100);
      if (i === 99) throw new Error('静态服务启动超时（端口 ' + realPort + '）');
    }
    return await fn(realPort);
  } finally {
    server.kill();
  }
}

/* 全画布扫描非白像素数，确认画布确实出了图（作为 page.$eval 的页内函数传入） */
function countNonWhite(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i] !== 255 || d[i + 1] !== 255 || d[i + 2] !== 255) n++; }
  return n;
}

module.exports = {
  ROOT, sleep, createChecker, resolvePhoto, launchBrowser, withServer, countNonWhite
};
