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

/* 任务并发哨兵：compress/extract 同一时刻只允许一个（详见 compress 内注释） */
let archiveBusy = false;

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

/* 检查 7z 是否可用，返回 { ok, version | error }（15s 超时兜底防挂起） */
const CHECK7Z_TIMEOUT_MS = 15000;

async function check7z() {
  const exe = resolve7zPath();
  if (!exe) return { ok: false, error: '未找到 7z 引擎（electron/bin/7z.exe）' };
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
  /* 窗口可能已销毁（关闭竞态）：销毁窗口传回 dialog 会抛原生 Error，
   * 与 electron/system.js 的 isDestroyed 检查对齐，退回无父窗口对话框 */
  const win0 = getWin();
  const parent = win0 && !win0.isDestroyed() ? win0 : null;
  const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
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
  /* 窗口可能已销毁（关闭竞态）：销毁窗口传回 dialog 会抛原生 Error */
  const win0 = getWin();
  const parent = win0 && !win0.isDestroyed() ? win0 : null;
  const opts = {
    title: '保存压缩包',
    defaultPath: defaultName || '压缩包.7z',
    filters: [
      { name: '7z 压缩包', extensions: ['7z'] },
      { name: 'ZIP 压缩包', extensions: ['zip'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  };
  const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
  return r.canceled ? '' : (r.filePath || '');
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

/* 压缩：payload { items:[path], fmt, level, volumeMB, pass, encNames, outPath } */
async function compress(getWin, payload) {
  payload = payload || {};
  /* 并发哨兵：同一时刻只允许一个压缩/解压任务。渲染层 running 标志只能挡住
   * UI 并发，IPC 可被 devtools 直连——两个压缩并发会互相 removeOutputs 删掉
   * 对方产物，且 archive:cancel 设计上是 kill 全部子进程 */
  if (archiveBusy) return { ok: false, error: '已有压缩/解压任务进行中，请先完成或取消当前任务' };
  archiveBusy = true;
  try {
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
    /* 数据安全硬防护：输出与任一输入相同（如单文件压缩、自动命名恰好同名）时
     * 绝不能继续——下方 removeOutputs() 会先删「旧输出」，同名即删源文件 */
    if (args7z.hasInputConflict(items, outPath)) {
      return { ok: false, error: '输出路径与待压缩内容相同，已阻止执行（防止源文件被覆盖删除）' };
    }
    const fmt = args7z.COMPRESS_FMTS[payload.fmt] ? payload.fmt : '7z';
    const volumeMB = Math.round(+payload.volumeMB || 0);
    /* 分卷仅 7z 支持：buildCompressArgs 对 zip 不追加 -v。若 zip+分卷绕过渲染层
     * 双保险直达 IPC，会静默丢分卷参数并返回 {ok:true,size:0,parts:1}，
     * UI 显示「压缩完成（0 B）」——主进程显式拒绝 */
    if (fmt === 'zip' && volumeMB > 0) {
      return { ok: false, error: 'ZIP 格式不支持分卷压缩，请改用 7z 格式' };
    }
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
    // 失败（密码错误/磁盘满/致命错误）：清掉截断的半成品与残缺分卷，
    // 与取消路径策略一致——否则用户目录里残留打不开的 .7z
    removeOutputs();
    return res;
  } finally {
    archiveBusy = false;
  }
}

/* 解压：payload { items:[path], destMode:'sub'|'same', pass }
 * 多选包逐个处理，进度附带当前序号 */
async function extract(getWin, payload) {
  payload = payload || {};
  if (archiveBusy) return { ok: false, error: '已有压缩/解压任务进行中，请先完成或取消当前任务' };
  archiveBusy = true;
  try {
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
  } finally {
    archiveBusy = false;
  }
}

/* 内容浏览：payload { archive, pass } → 7z l -slt 列表解析
 * 列表操作带 30s 超时兜底（损坏包/慢速盘防挂起；压缩解压靠取消按钮）
 * 输出累积上限 64MB：超大/损坏包的 -slt 输出可达数百 MB，无上限会压垮主进程 */
const LIST_TIMEOUT_MS = 30000;
const LIST_MAX_OUT = 64 * 1024 * 1024;

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
    let outBytes = 0;
    let errTail = '';
    let overflow = false;
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
    child.stdout.on('data', (d) => {
      out += d;
      outBytes += Buffer.byteLength(d); // 按字节计：中文条目 1 字符 3 字节，按字符串长度会少算约 3 倍
      if (outBytes > LIST_MAX_OUT) {
        // 超出理论上限：杀子进程、报错退出（防主进程内存被数百 MB 列表压垮）
        overflow = true;
        try { child.kill(); } catch (e) { /* 已退出 */ }
      }
    });
    child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-4000); });
    child.on('error', (e) => finish({ ok: false, error: '7z 启动失败：' + (e.message || e) }));
    child.on('close', (code) => {
      if (child.killedByUser) return finish({ ok: false, error: '任务已取消', cancelled: true });
      if (overflow) {
        return finish({ ok: false, error: '内容列表超过 ' + Math.round(LIST_MAX_OUT / 1048576) + 'MB，已中止读取（包可能损坏或条目异常）' });
      }
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
