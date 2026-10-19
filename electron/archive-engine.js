/* ============================================================
 * archive-engine.js — 7z 引擎层（主进程，自 archive.js 拆出）
 * 只管 7z.exe 的进程生命周期：定位可执行文件、跑子进程、进度/错误
 * 解析、任务并发哨兵、子进程取消。不管通道注册、对话框与进度回传
 * ——那些在 IPC 层 archive.js。
 * 通过内置 7z.exe（electron/bin，LGPL 分发）完成压缩 / 解压，
 * 全程本地执行，无网络。
 * ============================================================ */
'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const args7z = require('./7z-args');

/* ---------- 7z 可执行文件定位 ----------
 * 打包：extraResources → resources/bin/7z.exe
 * 开发：electron/bin/7z.exe；都没有时回退系统安装的 7-Zip */
function resolve7zPath() {
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, 'bin', '7z.exe') : '',
    path.join(__dirname, 'bin', '7z.exe'),
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe'
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* 忽略 */ }
  }
  return '';
}

/* 未找到 7z 的统一文案：安全软件（杀毒/防火墙）误隔离随包 7z.exe 是
 * 最高频原因——全新安装或刚更新后首次使用尤其多见（用户看到的结果
 * 就是「引擎突然没了」，实际文件被移进了隔离区）。
 * 排查步骤详见 docs/security-software-compatibility.md */
function no7zError() {
  return '未找到 7z 引擎。若软件刚安装或刚更新，可能是安全软件（杀毒软件 / 防火墙）'
    + '误隔离了随包附带的 7z.exe：请在其「隔离区 / 拦截记录」中恢复该文件并添加信任，'
    + '然后重启本软件；也可安装 7-Zip 后重试。';
}

/* 进行中的 7z 子进程集合：供「取消任务」统一 kill */
const activeChildren = new Set();

/* 任务并发哨兵：compress/extract 同一时刻只允许一个
 * （并发会互相删对方产物，详见 archive.js compress 内注释） */
let archiveBusy = false;

/* 压缩/解压互斥执行：已被占用时返回同一句错误（不排队），
 * 否则占用哨兵执行 fn 并在 finally 释放（含 fn 抛错路径） */
function runExclusive(fn) {
  if (archiveBusy) {
    return Promise.resolve({ ok: false, error: '已有压缩/解压任务进行中，请先完成或取消当前任务' });
  }
  archiveBusy = true;
  return (async () => {
    try { return await fn(); } finally { archiveBusy = false; }
  })();
}

/* 取消全部进行中的 7z 任务，返回终止数 */
function cancelActiveJobs() {
  let n = 0;
  activeChildren.forEach((c) => {
    try { c.killedByUser = true; c.kill(); n++; } catch (e) { /* 已退出 */ }
  });
  return { killed: n };
}

/* 子进程登记/注销：listArchive 自带超时与输出上限策略（不能直接用 run7z），
 * 但其子进程仍须纳入 activeChildren，否则 archive:cancel 漏杀列表进程 */
function trackChild(child) { activeChildren.add(child); return child; }
function untrackChild(child) { activeChildren.delete(child); }

function statEntry(p) {
  return new Promise((resolve) => {
    fs.stat(p, (err, st) => {
      if (err || !st) { resolve(null); return; }
      resolve({
        path: p,
        name: path.basename(p),
        isDir: st.isDirectory(),
        size: st.size,
        mtime: st.mtimeMs
      });
    });
  });
}

/* 检查 7z 是否可用，返回 { ok, version | error }（15s 超时兜底防挂起） */
const CHECK7Z_TIMEOUT_MS = 15000;

async function check7z() {
  const exe = resolve7zPath();
  if (!exe) return { ok: false, error: no7zError() };
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const child = spawn(exe, [], { windowsHide: true });
    child.stdout.on('data', d => { out += d; });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch (e) { /* 已退出 */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: '7z 引擎检测超时（' + CHECK7Z_TIMEOUT_MS / 1000 + 's）' }), CHECK7Z_TIMEOUT_MS);
    child.on('error', e => finish({ ok: false, error: String(e.message || e) }));
    child.on('close', () => {
      // 版本行形如「7-Zip 26.03 (x64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-09-03」，
      // 在首个 ' :' 处截断，只把「7-Zip 26.03 (x64)」给 UI 备注（不带出版权/日期行）
      const m = out.match(/7-Zip[^\r\n]*/i);
      const version = m ? m[0].split(' :')[0].trim() : '';
      finish({ ok: true, version: version || '7-Zip', path: exe });
    });
  });
}

/* 7z 错误输出解码：随包 7z.exe 若为本地化构建，错误行走 OEM 代码页
 * （中文 Windows = GBK 936），按 UTF-8 解会成乱码且乱码行优先级高于
 * exitCodeText 的中文说明。策略：先判 UTF-8 合法性——干净（无 U+FFFD）
 * 则采用（含合法 UTF-8 非 ASCII：GBK 优先会把它解成乱码）；含替换符
 * 再试 GBK，GBK 也乱则整体弃用，让 exitCodeText 兜底。 */
function decodeErrTail(buf) {
  if (!buf || !buf.length) return { text: '', garbled: false };
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (utf8.indexOf('\uFFFD') < 0) return { text: utf8, garbled: false };
  try {
    const gbk = new TextDecoder('gbk').decode(buf);
    if (gbk.indexOf('\uFFFD') < 0) return { text: gbk, garbled: false };
  } catch (e) { /* 运行环境无 GBK 解码器 */ }
  return { text: utf8, garbled: true };
}

/* 运行一次 7z，进度经 onProgress(pct) 回传，错误收集尾部。
 * 子进程登记进 activeChildren（可被 archive:cancel 终止，
 * 终止后 close 以「任务已取消」收场而非报未知错误） */
function run7z(exe, args, onProgress) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChildren.add(child);
    let outTail = '';
    let errBuf = Buffer.alloc(0);
    const push = (acc, d) => {
      acc += d;
      return acc.length > 4000 ? acc.slice(-4000) : acc;
    };
    child.stdout.on('data', (d) => {
      outTail = push(outTail, d);
      const pct = args7z.parseProgress(String(d));
      if (pct !== null && onProgress) onProgress(pct);
    });
    child.stderr.on('data', (d) => {
      errBuf = errBuf.length + d.length > 8000 ? Buffer.concat([errBuf, d]).slice(-8000) : Buffer.concat([errBuf, d]);
    });
    child.on('error', (e) => {
      activeChildren.delete(child);
      // 取消竞态边缘：cancel 后子进程可能先发 'error'（kill 导致）再 'close'，
      // 此时按「任务已取消」收场，不让用户看到「7z 启动失败」
      if (child.killedByUser) return resolve({ ok: false, cancelled: true, error: '任务已取消' });
      resolve({ ok: false, error: '7z 启动失败：' + (e.message || e) });
    });
    child.on('close', (code) => {
      activeChildren.delete(child);
      if (child.killedByUser) return resolve({ ok: false, cancelled: true, error: '任务已取消' });
      if (args7z.isOkExitCode(code)) {
        resolve({ ok: true, code });
      } else {
        // 乱码 stderr 不采用（让 exitCodeText 中文说明优先）；干净的本地化错误行保留
        const et = decodeErrTail(errBuf);
        const errText = et.garbled ? '' : args7z.tailError(et.text);
        resolve({
          ok: false,
          code,
          error: errText || args7z.tailError(outTail) || args7z.exitCodeText(code)
        });
      }
    });
  });
}

module.exports = {
  resolve7zPath,
  no7zError,
  runExclusive,
  cancelActiveJobs,
  trackChild,
  untrackChild,
  statEntry,
  check7z,
  decodeErrTail,
  run7z
};
