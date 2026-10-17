/* ============================================================
 * archive.js — 压缩工具 IPC（主进程）
 * 通过内置 7z.exe（electron/bin，LGPL 分发）完成压缩 / 解压，
 * 全程本地执行，无网络。进度经 webContents.send 回传渲染层。
 * ============================================================ */
'use strict';

const { app, dialog } = require('electron');
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

/* 进行中的 7z 子进程集合：供「取消任务」统一 kill */
const activeChildren = new Set();

/* 取消全部进行中的 7z 任务，返回终止数 */
function cancelActiveJobs() {
  let n = 0;
  activeChildren.forEach((c) => {
    try { c.killedByUser = true; c.kill(); n++; } catch (e) { /* 已退出 */ }
  });
  return { killed: n };
}

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

/* 检查 7z 是否可用，返回 { ok, version | error } */
async function check7z() {
  const exe = resolve7zPath();
  if (!exe) return { ok: false, error: '未找到 7z 引擎（electron/bin/7z.exe）' };
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(exe, [], { windowsHide: true });
    child.stdout.on('data', d => { out += d; });
    child.on('error', e => resolve({ ok: false, error: String(e.message || e) }));
    child.on('close', () => {
      const m = out.match(/7-Zip[^\r\n]*/i);
      resolve({ ok: true, version: m ? m[0] : '7-Zip', path: exe });
    });
  });
}

/* 文件/文件夹/压缩包选择对话框，返回 [{path,name,isDir,size,mtime}]
 * kind: file 任意文件 / dir 文件夹 / archive 压缩包 / image 图片 / doc 文档 */
const PICK_KINDS = {
  image: { title: '选择要打印的图片', name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] },
  doc: { title: '选择要打印的文档', name: '文档', extensions: ['pdf', 'txt', 'docx', 'doc'] }
};

async function pickPaths(getWin, kind) {
  const opts = { title: '选择要压缩的文件', properties: ['openFile', 'multiSelections'] };
  if (kind === 'dir') {
    opts.title = '选择要压缩的文件夹';
    opts.properties = ['openDirectory'];
  } else if (kind === 'archive') {
    opts.title = '选择要解压的压缩包';
    opts.filters = [{
      name: '压缩包',
      extensions: Object.keys(args7z.ARCHIVE_EXTS)
    }, { name: '全部文件', extensions: ['*'] }];
  } else if (PICK_KINDS[kind]) {
    opts.title = PICK_KINDS[kind].title;
    opts.filters = [
      { name: PICK_KINDS[kind].name, extensions: PICK_KINDS[kind].extensions },
      { name: '全部文件', extensions: ['*'] }
    ];
  }
  const win = getWin();
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths || !r.filePaths.length) return [];
  const metas = await Promise.all(r.filePaths.map(statEntry));
  return metas.filter(Boolean);
}

/* 拖拽落盘路径 → 条目元数据（渲染层经 webUtils.getPathForFile 拿到真实路径后调用）
 * 与 pickPaths 返回相同形状 [{path,name,isDir,size,mtime}]；非法/不存在路径静默剔除 */
async function statPaths(paths) {
  const list = (Array.isArray(paths) ? paths : [])
    .filter((p) => typeof p === 'string' && p && path.isAbsolute(p));
  const metas = await Promise.all(list.map(statEntry));
  return metas.filter(Boolean);
}

/* 另存为对话框（确定压缩包输出路径） */
async function saveDialog(getWin, defaultName) {
  const win = getWin();
  const opts = {
    title: '保存压缩包',
    defaultPath: defaultName || '压缩包.7z',
    filters: [
      { name: '7z 压缩包', extensions: ['7z'] },
      { name: 'ZIP 压缩包', extensions: ['zip'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  };
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  return r.canceled ? '' : (r.filePath || '');
}

/* 运行一次 7z，进度经 onProgress(pct) 回传，错误收集尾部。
 * 子进程登记进 activeChildren（可被 archive:cancel 终止，
 * 终止后 close 以「任务已取消」收场而非报未知错误） */
function run7z(exe, args, onProgress) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChildren.add(child);
    let outTail = '';
    let errTail = '';
    const push = (acc, d) => {
      acc += d;
      return acc.length > 4000 ? acc.slice(-4000) : acc;
    };
    child.stdout.on('data', (d) => {
      outTail = push(outTail, d);
      const pct = args7z.parseProgress(String(d));
      if (pct !== null && onProgress) onProgress(pct);
    });
    child.stderr.on('data', (d) => { errTail = push(errTail, d); });
    child.on('error', (e) => { activeChildren.delete(child); resolve({ ok: false, error: '7z 启动失败：' + (e.message || e) }); });
    child.on('close', (code) => {
      activeChildren.delete(child);
      if (child.killedByUser) return resolve({ ok: false, cancelled: true, error: '任务已取消' });
      if (args7z.isOkExitCode(code)) {
        resolve({ ok: true, code });
      } else {
        resolve({
          ok: false,
          code,
          error: args7z.tailError(errTail) || args7z.tailError(outTail) || args7z.exitCodeText(code)
        });
      }
    });
  });
}

/* 压缩：payload { items:[path], fmt, level, volumeMB, pass, encNames, outPath } */
async function compress(getWin, payload) {
  const exe = resolve7zPath();
  if (!exe) return { ok: false, error: '未找到 7z 引擎' };
  // IPC 输入校验（纵深防御：路径须来自本机对话框风格的真实路径）
  const items = (payload.items || []).filter(p => typeof p === 'string' && p && path.isAbsolute(p));
  if (!items.length) return { ok: false, error: '未选择要压缩的文件' };
  const outPath = payload.outPath;
  const outExt = path.extname(String(outPath || '')).toLowerCase();
  if (!outPath || typeof outPath !== 'string' || !path.isAbsolute(outPath)) {
    return { ok: false, error: '输出路径非法' };
  }
  if (outExt !== '.7z' && outExt !== '.zip') {
    return { ok: false, error: '输出文件扩展名须为 .7z 或 .zip' };
  }
  const volumeMB = Math.round(+payload.volumeMB || 0);
  /* 精确清理输出产物：非分卷删 outPath 本身；分卷删 out.7z.NNN 编号卷
   * （只匹配 .NNN 后缀，防误删同前缀无关文件） */
  const removeOutputs = () => {
    try {
      if (fs.existsSync(outPath)) fs.rmSync(outPath);
      if (volumeMB > 0) {
        const dir = path.dirname(outPath);
        const base = path.basename(outPath);
        fs.readdirSync(dir).filter(f => f.startsWith(base + '.') && /^\.\d{3}$/.test(f.slice(base.length))).forEach(f => {
          try { fs.rmSync(path.join(dir, f)); } catch (e) { /* 逐个忽略 */ }
        });
      }
    } catch (e) { /* 尽力清理，失败由后续流程报错 */ }
  };
  /* 输出已存在则删除重建：7z a 的更新模式会在包内残留旧条目 */
  removeOutputs();
  const args = args7z.buildCompressArgs({
    fmt: payload.fmt,
    level: payload.level,
    volumeMB: volumeMB,
    pass: payload.pass,
    encNames: payload.encNames,
    inputs: items,
    outPath: outPath
  });
  const win = getWin();
  const res = await run7z(exe, args, (pct) => {
    if (win && !win.isDestroyed()) win.webContents.send('archive:progress', { task: 'compress', pct });
  });
  if (res.cancelled) {
    // 用户取消：清掉半成品（非分卷的残缺包 / 分卷的 .001… 卷），不留垃圾文件
    removeOutputs();
    return res;
  }
  if (res.ok) {
    let size = 0;
    let parts = 1;
    try {
      if (volumeMB > 0) {
        /* 分卷：统计 out.7z.NNN 全部卷的大小 */
        const dir = path.dirname(outPath);
        const base = path.basename(outPath);
        const vols = fs.readdirSync(dir)
          .filter(f => f.startsWith(base + '.') && /^\.\d{3}$/.test(f.slice(base.length)))
          .sort();
        vols.forEach(f => { size += fs.statSync(path.join(dir, f)).size; });
        parts = vols.length || 1;
      } else {
        size = fs.statSync(outPath).size;
      }
    } catch (e) { /* 已删除？ */ }
    return { ok: true, outPath: outPath, size, parts };
  }
  return res;
}

/* 解压：payload { items:[path], destMode:'sub'|'same', pass }
 * 多选包逐个处理，进度附带当前序号 */
async function extract(getWin, payload) {
  const exe = resolve7zPath();
  if (!exe) return { ok: false, error: '未找到 7z 引擎' };
  const items = (payload.items || []).filter(p => typeof p === 'string' && p && path.isAbsolute(p));
  if (!items.length) return { ok: false, error: '未选择压缩包' };
  const win = getWin();
  const results = [];
  for (let i = 0; i < items.length; i++) {  
    const src = items[i];
    const base = path.basename(src).replace(/\.[^.]+$/, '') || '解压结果';
    const dir = path.dirname(src);
    const outDir = payload.destMode === 'same' ? dir : path.join(dir, base);
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { /* 已存在 */ }
    const args = args7z.buildExtractArgs({ archive: src, outDir, pass: payload.pass });
    const res = await run7z(exe, args, (pct) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('archive:progress', { task: 'extract', index: i, total: items.length, name: path.basename(src), pct });
      }
    });
    if (res.cancelled) {
      // 用户取消：当前包记为已取消，不再继续后续压缩包
      results.push({ path: src, name: path.basename(src), outDir, ok: false, error: '任务已取消', cancelled: true });
      break;
    }
    results.push({
      path: src,
      name: path.basename(src),
      outDir,
      ok: res.ok,
      error: res.ok ? '' : res.error
    });
  }
  const okCount = results.filter(r => r.ok).length;
  const cancelled = results.some(r => r.cancelled);
  return { ok: okCount > 0, results, okCount, failCount: results.length - okCount, cancelled };
}

/* 内容浏览：payload { archive, pass } → 7z l -slt 列表解析
 * 列表操作带 30s 超时兜底（损坏包/慢速盘防挂起；压缩解压靠取消按钮） */
const LIST_TIMEOUT_MS = 30000;

async function listArchive(payload) {
  const exe = resolve7zPath();
  if (!exe) return { ok: false, error: '未找到 7z 引擎' };
  const archive = payload && typeof payload.archive === 'string' ? payload.archive : '';
  if (!archive || !fs.existsSync(archive)) return { ok: false, error: '压缩包不存在' };
  return new Promise((resolve) => {
    const child = spawn(exe, args7z.buildListArgs({ archive, pass: payload.pass }),
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChildren.add(child);
    let out = '';
    let errTail = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      try { child.kill(); } catch (e) { /* 已退出 */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: '读取超时（' + LIST_TIMEOUT_MS / 1000 + 's），包可能过大或损坏' }), LIST_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-4000); });
    child.on('error', (e) => finish({ ok: false, error: '7z 启动失败：' + (e.message || e) }));
    child.on('close', (code) => {
      if (child.killedByUser) return finish({ ok: false, error: '任务已取消' });
      if (args7z.isOkExitCode(code)) {
        const entries = args7z.parseListOutput(out);
        finish({ ok: true, entries, count: entries.length });
      } else {
        finish({ ok: false, error: args7z.tailError(errTail) || args7z.exitCodeText(code) });
      }
    });
  });
}

function registerArchiveIpc(ipcMain, getWin) {
  ipcMain.handle('archive:check7z', () => check7z());
  ipcMain.handle('archive:pickPaths', (e, kind) => pickPaths(getWin, kind));
  ipcMain.handle('archive:statPaths', (e, paths) => statPaths(paths));
  ipcMain.handle('archive:saveDialog', (e, defaultName) => saveDialog(getWin, defaultName));
  ipcMain.handle('archive:compress', (e, payload) => compress(getWin, payload));
  ipcMain.handle('archive:extract', (e, payload) => extract(getWin, payload));
  ipcMain.handle('archive:list', (e, payload) => listArchive(payload));
  ipcMain.handle('archive:cancel', () => cancelActiveJobs());
}

module.exports = { registerArchiveIpc, resolve7zPath, check7z, listArchive, cancelActiveJobs };
