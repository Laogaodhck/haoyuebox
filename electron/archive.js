/* ============================================================
 * archive.js — 压缩工具 IPC（主进程）
 * 本文件是 IPC 层：对话框、入参校验、webContents 进度回传、通道注册。
 * 7z 进程机制（定位/运行/取消/哨兵）在同目录 archive-engine.js。
 * 压缩与解压均由桌面版内置 7z.exe（electron/bin，LGPL 分发）完成，
 * 全程本地执行，无网络。
 * ============================================================ */
'use strict';

const { app, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const args7z = require('./7z-args');
const engine = require('./archive-engine');

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
  const metas = await Promise.all(r.filePaths.map(engine.statEntry));
  return metas.filter(Boolean);
}

/* 拖拽落盘路径 → 条目元数据（渲染层经 webUtils.getPathForFile 拿到真实路径后调用）
 * 与 pickPaths 返回相同形状 [{path,name,isDir,size,mtime}]；非法/不存在路径静默剔除 */
async function statPaths(paths) {
  const list = (Array.isArray(paths) ? paths : [])
    .filter((p) => typeof p === 'string' && p && path.isAbsolute(p));
  const metas = await Promise.all(list.map(engine.statEntry));
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

/* 压缩：payload { items:[path], fmt, level, volumeMB, pass, encNames, outPath } */
async function compress(getWin, payload) {
  payload = payload || {};
  /* 并发哨兵在引擎层（runExclusive）：同一时刻只允许一个压缩/解压任务。
   * 渲染层 running 标志只能挡住 UI 并发，IPC 可被 devtools 直连——
   * 两个压缩并发会互相 removeOutputs 删掉对方产物，且 archive:cancel
   * 设计上是 kill 全部子进程 */
  return engine.runExclusive(async () => {
    const exe = engine.resolve7zPath();
    if (!exe) return { ok: false, error: engine.no7zError() };
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
    const res = await engine.run7z(exe, args, (pct) => {
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
  });
}

/* 解压：payload { items:[path], destMode:'sub'|'same'|'desktop-sub', pass }
 * 多选包逐个处理，进度附带当前序号 */
async function extract(getWin, payload) {
  payload = payload || {};
  return engine.runExclusive(async () => {
    const exe = engine.resolve7zPath();
    if (!exe) return { ok: false, error: engine.no7zError() };
    const items = (payload.items || []).filter(p => typeof p === 'string' && p && path.isAbsolute(p));
    if (!items.length) return { ok: false, error: '未选择压缩包' };
    const win = getWin();
    const results = [];
    for (let i = 0; i < items.length; i++) {
      const src = items[i];
      const base = path.basename(src).replace(/\.[^.]+$/, '') || '解压结果';
      const dir = path.dirname(src);
      const outDir = payload.destMode === 'same'
        ? dir
        : payload.destMode === 'desktop-sub'
          ? path.join(app.getPath('desktop'), base)
          : path.join(dir, base);
      try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { /* 已存在 */ }
      const args = args7z.buildExtractArgs({ archive: src, outDir, pass: payload.pass });
      const res = await engine.run7z(exe, args, (pct) => {
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
  });
}

/* 内容浏览：payload { archive, pass } → 7z l -slt 列表解析
 * 列表操作带 30s 超时兜底（损坏包/慢速盘防挂起；压缩解压靠取消按钮）
 * 输出累积上限 64MB：超大/损坏包的 -slt 输出可达数百 MB，无上限会压垮主进程。
 * 列表是只读操作，不占压缩/解压互斥哨兵 */
const LIST_TIMEOUT_MS = 30000;
const LIST_MAX_OUT = 64 * 1024 * 1024;

async function listArchive(payload) {
  const exe = engine.resolve7zPath();
  if (!exe) return { ok: false, error: engine.no7zError() };
  const archive = payload && typeof payload.archive === 'string' ? payload.archive : '';
  /* 与 compress/extract 同规：路径须为绝对路径（防渲染层传入相对路径按 CWD 解析） */
  if (!archive || !path.isAbsolute(archive)) return { ok: false, error: '压缩包路径非法' };
  if (!fs.existsSync(archive)) return { ok: false, error: '压缩包不存在' };
  return new Promise((resolve) => {
    const child = spawn(exe, args7z.buildListArgs({ archive, pass: payload.pass }),
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    engine.trackChild(child);
    let out = '';
    let outBytes = 0;
    let errTail = '';
    let overflow = false;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      engine.untrackChild(child);
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

function registerArchiveIpc(ipcMain, getWin, onPaths) {
  /* 路径来源登记（可选回调）：pickPaths/statPaths 返回的本机路径上报给主进程，
   * 供 print:readFile 做会话级白名单校验（渲染进程被攻破时无法凭空指定路径读文件） */
  const record = (metas) => {
    if (typeof onPaths === 'function' && Array.isArray(metas)) onPaths(metas);
    return metas;
  };
  ipcMain.handle('archive:check7z', () => engine.check7z());
  ipcMain.handle('archive:pickPaths', async (e, kind) => record(await pickPaths(getWin, kind)));
  ipcMain.handle('archive:statPaths', async (e, paths) => record(await statPaths(paths)));
  ipcMain.handle('archive:saveDialog', (e, defaultName) => saveDialog(getWin, defaultName));
  ipcMain.handle('archive:desktopPath', () => app.getPath('desktop'));
  ipcMain.handle('archive:compress', (e, payload) => compress(getWin, payload));
  ipcMain.handle('archive:extract', (e, payload) => extract(getWin, payload));
  ipcMain.handle('archive:list', (e, payload) => listArchive(payload));
  ipcMain.handle('archive:cancel', () => engine.cancelActiveJobs());
}

/* 引擎层函数经此再导出，保持既有引用面（main.js 目前只用 registerArchiveIpc） */
module.exports = {
  registerArchiveIpc,
  resolve7zPath: engine.resolve7zPath,
  check7z: engine.check7z,
  listArchive,
  cancelActiveJobs: engine.cancelActiveJobs
};
