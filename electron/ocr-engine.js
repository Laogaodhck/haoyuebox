/* ============================================================
 * ocr-engine.js — 随包 OCR 引擎的下载与安装（主进程）
 *
 * 引擎不再随安装包分发（约 40 MB），改为首次使用时按需下载：
 *  - 下载源为本项目 GitHub Release 的精简包（仅中英模型，MIT/Apache-2.0）；
 *  - 下载到用户数据目录 %APPDATA%/浩玥工具箱/ocr-engine，用随包 7z 解压，
 *    校验文件齐全后写入 engine.json 标记；安装目录可被卸载/升级保留；
 *  - 全程 HTTPS 下载 + 本地解压，不上传任何用户数据；
 *  - 通过 HAOYUE_OCR_ENGINE_URL / HAOYUE_OCR_ENGINE_DIR 覆盖下载源与安装
 *    目录（局域网镜像、离线安装包、自动化测试）。
 *
 * IPC：ocr:engineStatus / ocr:engineInstall / ocr:engineRemove，
 * 进度经 ocr-engine:progress 单向事件推送（download → extract → done）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { app } = require('electron');
const { resolve7zPath, no7zError, run7z } = require('./archive-engine');

const ENGINE_VERSION = '2.1.5';
const ASSET_NAME = 'haoyue-ocr-engine-' + ENGINE_VERSION + '.zip';
const REPO = 'Laogaodhck/haoyuebox';
const RELEASE_TAG = 'ocr-engine-' + ENGINE_VERSION;
const DEFAULT_URL = 'https://github.com/' + REPO + '/releases/download/' + RELEASE_TAG + '/' + ASSET_NAME;
/* GitHub 直连在部分网络不可达时的镜像回退（第三方加速，按序尝试；
 * 只加前缀不改包内容，内网可用 HAOYUE_OCR_ENGINE_URL 指向自建镜像） */
const MIRRORS = ['https://gh-proxy.com/', 'https://ghproxy.net/'];

const ENGINE_SUBDIR = 'umi-ocr';
const EXE_NAME = 'RapidOCR-json.exe';
/* 精简包必须包含的文件（exe + 中英模型与字典 + 许可证） */
const NEEDED = [
  EXE_NAME,
  'LICENSE',
  path.posix.join('models', 'configs.txt'),
  path.posix.join('models', 'ch_PP-OCRv3_det_infer.onnx'),
  path.posix.join('models', 'ch_ppocr_mobile_v2.0_cls_infer.onnx'),
  path.posix.join('models', 'rec_ch_PP-OCRv4_infer.onnx'),
  path.posix.join('models', 'dict_chinese.txt'),
  path.posix.join('models', 'rec_en_PP-OCRv3_infer.onnx'),
  path.posix.join('models', 'dict_en.txt')
];

const MARKER = 'engine.json';
const DOWNLOAD_TIMEOUT = 120000; // 单次无数据超时（40 MB 慢网也足够）
const MAX_REDIRECTS = 5;

let installTask = null; // 进行中的安装 Promise（并发调用复用）

/* ---------- 路径 ---------- */

function envDir() {
  const v = process.env.HAOYUE_OCR_ENGINE_DIR;
  return v ? path.resolve(v) : '';
}

/* 安装根目录：测试/离线安装可用环境变量覆盖；否则落在用户数据目录 */
function rootDir() {
  const override = envDir();
  if (override) return override;
  try {
    return path.join(app.getPath('userData'), 'ocr-engine');
  } catch (err) {
    return path.join(os.tmpdir(), 'haoyue-ocr-engine');
  }
}

function engineDir() {
  return path.join(rootDir(), ENGINE_SUBDIR);
}

function exePath() {
  return path.join(engineDir(), EXE_NAME);
}

function downloadUrl() {
  const v = process.env.HAOYUE_OCR_ENGINE_URL;
  return v ? String(v) : DEFAULT_URL;
}

/* 候选下载源：显式覆盖时只用一个；否则 GitHub 直连 + 镜像依次回退 */
function sources() {
  if (process.env.HAOYUE_OCR_ENGINE_URL) return [String(process.env.HAOYUE_OCR_ENGINE_URL)];
  const url = DEFAULT_URL;
  return [url].concat(MIRRORS.map((m) => m + url));
}

/* ---------- 校验 ---------- */

function missingFiles(dir) {
  const base = dir || engineDir();
  return NEEDED.filter((rel) => {
    try {
      return !fs.existsSync(path.join(base, rel.split('/').join(path.sep)));
    } catch (err) {
      return true;
    }
  });
}

function readMarker() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(rootDir(), MARKER), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch (err) {
    return null;
  }
}

/* 当前安装状态：installed 以文件齐全为准（手工放置的引擎也算） */
function status() {
  const dir = engineDir();
  const missing = missingFiles(dir);
  const marker = readMarker();
  return {
    ok: true,
    installed: missing.length === 0,
    version: marker && marker.version ? String(marker.version) : (missing.length === 0 ? '' : ''),
    dir,
    missing,
    url: downloadUrl(),
    asset: ASSET_NAME,
    installing: !!installTask
  };
}

/* ---------- 下载 ---------- */

/* 跟随重定向的下载：返回 { ok, bytes } 或抛错。
 * 用 Node http/https 而非 Electron net，便于测试注入本地服务与超时控制。 */
function download(url, dest, onProgress, redirects) {
  const hops = redirects || 0;
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new Error('下载地址无效：' + url));
      return;
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      reject(new Error('下载地址仅支持 http / https'));
      return;
    }
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.get(target, {
      headers: { 'User-Agent': 'haoyue-idphoto/' + ENGINE_VERSION }
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (hops >= MAX_REDIRECTS) {
          reject(new Error('下载重定向次数过多'));
          return;
        }
        const next = new URL(res.headers.location, target).toString();
        download(next, dest, onProgress, hops + 1).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new Error('下载失败：HTTP ' + code + '（' + downloadUrl() + '）'));
        return;
      }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      let lastPct = -1;
      let lastEmit = 0;
      const out = fs.createWriteStream(dest);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        out.destroy();
        reject(err);
      };
      res.on('data', (chunk) => {
        received += chunk.length;
        if (!onProgress) return;
        const pct = total ? Math.min(99, Math.round(received / total * 100)) : null;
        /* 限流：进度变化 1% 或距上次 300ms 才推一次，避免高频 IPC */
        const now = Date.now();
        if (pct === lastPct && now - lastEmit < 300) return;
        lastPct = pct;
        lastEmit = now;
        onProgress({ received, total, pct });
      });
      res.on('aborted', () => fail(new Error('下载中断（连接被关闭）')));
      res.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        if (settled) return;
        settled = true;
        if (total && received < total) {
          reject(new Error('下载不完整：' + received + ' / ' + total + ' 字节'));
          return;
        }
        resolve({ bytes: received });
      });
      res.pipe(out);
    });
    req.setTimeout(DOWNLOAD_TIMEOUT, () => {
      req.destroy(new Error('下载超时：' + Math.round(DOWNLOAD_TIMEOUT / 1000) + ' 秒无数据'));
    });
    req.on('error', (err) => {
      reject(new Error('下载失败：' + ((err && err.message) || err)));
    });
  });
}

/* ---------- 安装 ---------- */

function emitProgress(onProgress, data) {
  if (onProgress) {
    try { onProgress(data); } catch (err) { /* 回调异常不影响安装 */ }
  }
}

async function doInstall(onProgress) {
  const exe7z = resolve7zPath();
  if (!exe7z) throw new Error(no7zError());

  const root = rootDir();
  fs.mkdirSync(root, { recursive: true });
  const zipPath = path.join(root, ASSET_NAME + '.part');

  emitProgress(onProgress, { phase: 'download', received: 0, total: 0, pct: 0 });
  const urls = sources();
  const failures = [];
  let downloaded = false;
  for (let i = 0; i < urls.length && !downloaded; i++) {
    if (i > 0) emitProgress(onProgress, { phase: 'download', received: 0, total: 0, pct: 0, retry: i });
    try {
      await download(urls[i], zipPath, (p) => {
        emitProgress(onProgress, Object.assign({ phase: 'download', source: urls[i] }, p));
      });
      downloaded = true;
    } catch (err) {
      try { fs.unlinkSync(zipPath); } catch (e) { /* 未生成 */ }
      failures.push((err && err.message) || String(err));
    }
  }
  if (!downloaded) {
    throw new Error((failures[failures.length - 1] || '下载失败')
      + '（已尝试 ' + urls.length + ' 个下载源，可稍后重试或先改用内置引擎）');
  }

  emitProgress(onProgress, { phase: 'extract', pct: null });
  try {
    const r = await run7z(exe7z, ['x', zipPath, '-o' + root, '-y'], (pct) => {
      emitProgress(onProgress, { phase: 'extract', pct });
    });
    if (!r.ok) throw new Error('解压失败：' + (r.error || '未知错误'));
  } finally {
    try { fs.unlinkSync(zipPath); } catch (err) { /* 已删除 */ }
  }

  const missing = missingFiles(engineDir());
  if (missing.length) {
    throw new Error('引擎文件不完整（缺少 ' + missing.join('、') + '），请重新下载');
  }
  fs.writeFileSync(path.join(root, MARKER), JSON.stringify({
    version: ENGINE_VERSION,
    asset: ASSET_NAME,
    installedAt: new Date().toISOString()
  }, null, 2));
  emitProgress(onProgress, { phase: 'done', pct: 100 });
  return status();
}

/* 安装（并发调用复用同一任务；已装好则直接返回，失败后可重试） */
function install(onProgress) {
  if (installTask) return installTask;
  const st = status();
  if (st.installed && (!st.version || st.version === ENGINE_VERSION)) return Promise.resolve(st);
  installTask = doInstall(onProgress).then((next) => {
    installTask = null;
    return next;
  }, (err) => {
    installTask = null;
    throw err;
  });
  return installTask;
}

/* 移除已下载引擎（释放约 40 MB；应用内设置不必提供，供排查/测试使用） */
function remove() {
  if (installTask) throw new Error('正在安装引擎，请稍后再试');
  const root = rootDir();
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (err) {
    throw new Error('删除引擎失败：' + ((err && err.message) || err));
  }
  return status();
}

/* ---------- IPC ---------- */

function registerIpc(ipcMain, getWin) {
  const send = (data) => {
    try {
      const win = getWin && getWin();
      if (win && !win.isDestroyed()) win.webContents.send('ocr-engine:progress', data);
    } catch (err) { /* 窗口已关闭：忽略 */ }
  };
  ipcMain.handle('ocr:engineStatus', () => {
    try {
      return status();
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
  ipcMain.handle('ocr:engineInstall', async () => {
    try {
      return await install(send);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
  ipcMain.handle('ocr:engineRemove', () => {
    try {
      return remove();
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
}

module.exports = {
  ENGINE_VERSION,
  ASSET_NAME,
  RELEASE_TAG,
  DEFAULT_URL,
  MIRRORS,
  NEEDED,
  rootDir,
  engineDir,
  exePath,
  downloadUrl,
  sources,
  missingFiles,
  status,
  install,
  remove,
  registerIpc
};
