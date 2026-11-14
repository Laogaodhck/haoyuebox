/* ============================================================
 * test-ocr-engine.cjs — OCR 引擎按需下载与安装测试
 * 不依赖真实 40 MB 引擎与公网：
 *  1) 用 7z 现造「完整 / 缺文件」两个精简包，本地 HTTP 服务模拟 Release
 *     （覆盖 302 跳转、404、Content-Length 进度）；
 *  2) 验证未安装判定、下载→解压→校验→marker 写入、重复安装短路、
 *     移除、缺文件与 404 的可读报错；
 *  3) 全部落在临时目录，结束后清理。
 * ============================================================ */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { ROOT, createChecker } = require('./_lib.cjs');

const engine = require(path.join(ROOT, 'electron', 'ocr-engine.js'));
const { resolve7zPath, no7zError } = require(path.join(ROOT, 'electron', 'archive-engine.js'));

const checker = createChecker();
const assert = checker.assert;

const exe7z = resolve7zPath();
const canRun7z = !!exe7z && process.platform === 'win32';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haoyue-ocr-engine-test-'));
const srcFull = path.join(tmp, 'src-full');
const srcPartial = path.join(tmp, 'src-partial');
const installRoot = path.join(tmp, 'install');
const zipFull = path.join(tmp, 'engine.zip');
const zipPartial = path.join(tmp, 'partial.zip');

function writeTree(base, skip) {
  engine.NEEDED.forEach((rel) => {
    if (skip && rel === skip) return;
    const p = path.join(base, 'umi-ocr', rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'dummy:' + rel);
  });
}

function makeZip(srcBase, out) {
  const r = spawnSync(exe7z, ['a', '-tzip', '-mx=1', out, 'umi-ocr'], {
    cwd: srcBase,
    windowsHide: true,
    encoding: 'utf8'
  });
  if (r.status !== 0) throw new Error('7z 打包失败：' + (r.stderr || r.stdout));
}

function serve(files) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/engine.zip' });
        res.end();
        return;
      }
      const file = files[req.url];
      if (!file) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const size = fs.statSync(file).size;
      res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/zip' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async function main() {
  if (!canRun7z) {
    console.log('\n[跳过] ' + (process.platform !== 'win32' ? '非 Windows 平台' : no7zError())
      + '，仅执行常量与文件校验断言（下载/解压链路需 Windows + 随包 7z）');
    fs.rmSync(tmp, { recursive: true, force: true });
    checker.finish();
    return;
  }
  writeTree(srcFull);
  writeTree(srcPartial, 'models/dict_en.txt');
  makeZip(srcFull, zipFull);
  makeZip(srcPartial, zipPartial);

  /* ---------- 1. 常量与文件校验 ---------- */
  assert(engine.ASSET_NAME === 'haoyue-ocr-engine-2.1.5.zip', '精简包文件名带版本号');
  assert(engine.DEFAULT_URL.indexOf('/releases/download/ocr-engine-2.1.5/') > 0,
    '默认下载地址指向专用 Release');
  const srcs = engine.sources();
  assert(srcs.length === 3 && srcs[0] === engine.DEFAULT_URL
    && srcs[1].indexOf(engine.DEFAULT_URL) > 0, '默认按 GitHub 直连 → 镜像顺序回退');
  assert(engine.NEEDED.length === 9 && engine.NEEDED.indexOf('LICENSE') >= 0,
    '精简包清单含 exe / 中英模型 / 字典 / 许可证');
  assert(engine.missingFiles(path.join(srcFull, 'umi-ocr')).length === 0, '完整包通过文件校验');
  assert(engine.missingFiles(path.join(srcPartial, 'umi-ocr')).length === 1, '缺文件时能准确报出缺失项');

  /* ---------- 2. 环境指向本地服务 ---------- */
  process.env.HAOYUE_OCR_ENGINE_DIR = installRoot;
  const srv = await serve({
    '/engine.zip': zipFull,
    '/partial.zip': zipPartial
  });
  const base = 'http://127.0.0.1:' + srv.address().port;
  process.env.HAOYUE_OCR_ENGINE_URL = base + '/redirect';

  const before = engine.status();
  assert(before.ok && before.installed === false, '首次使用判定为未安装');
  assert(before.dir === path.join(installRoot, 'umi-ocr'), '安装目录为 <用户数据>/ocr-engine/umi-ocr');
  assert(engine.downloadUrl() === base + '/redirect', '下载地址可被环境变量覆盖（镜像 / 测试）');
  assert(engine.sources().length === 1, '显式覆盖时不追加镜像，尊重自建源');

  /* ---------- 3. 下载 + 解压 + 校验 ---------- */
  const phases = [];
  const progress = [];
  const st = await engine.install((p) => {
    if (!p) return;
    if (phases.indexOf(p.phase) < 0) phases.push(p.phase);
    if (p.phase === 'download') progress.push(p);
  });
  assert(st.installed === true, '安装完成后状态为已安装');
  assert(phases.indexOf('download') >= 0 && phases.indexOf('extract') >= 0
    && phases[phases.length - 1] === 'done', '进度依次经过下载 / 解压 / 完成');
  const last = progress[progress.length - 1] || {};
  assert(last.received > 0 && last.total === fs.statSync(zipFull).size,
    '下载进度按 Content-Length 计算（含 302 跳转）');
  assert(engine.missingFiles(engine.engineDir()).length === 0, '解压后引擎文件齐全');
  const marker = JSON.parse(fs.readFileSync(path.join(installRoot, 'engine.json'), 'utf8'));
  assert(marker.version === engine.ENGINE_VERSION, '写入版本标记 engine.json');
  assert(!fs.existsSync(path.join(installRoot, engine.ASSET_NAME + '.part')),
    '临时下载文件已清理');

  /* ---------- 4. 重复安装短路 ---------- */
  const again = await engine.install();
  assert(again.installed === true, '已安装时重复调用直接返回（不重复下载）');

  /* ---------- 5. 移除 ---------- */
  const removed = engine.remove();
  assert(removed.installed === false && !fs.existsSync(installRoot), '移除后目录与标记一并删除');

  /* ---------- 6. 异常路径 ---------- */
  process.env.HAOYUE_OCR_ENGINE_URL = base + '/partial.zip';
  let partialErr = '';
  try {
    await engine.install();
  } catch (e) { partialErr = e.message; }
  assert(/不完整/.test(partialErr) && /dict_en/.test(partialErr), '缺文件的包给出具体缺失项');
  assert(engine.status().installed === false, '失败安装不留下「已安装」状态');

  process.env.HAOYUE_OCR_ENGINE_URL = base + '/nope.zip';
  let httpErr = '';
  try {
    await engine.install();
  } catch (e) { httpErr = e.message; }
  assert(/HTTP 404/.test(httpErr), '404 时给出 HTTP 状态与地址');

  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  checker.finish();
})().catch((e) => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (err) { /* 忽略 */ }
  console.error('测试异常:', e && e.message ? e.message : e);
  process.exit(1);
});
