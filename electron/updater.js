/* 应用内更新器：安装版经 GitHub Release 就地升级（electron-updater / NSIS）
 *
 * 设计要点：
 * - Feed 指向公开源码仓库 Laogaodhck/haoyuebox（仓库公开后匿名可拉 Release；仓库若改名需同步 FEED）
 * - 手动触发制：不做启动自动检查——纯本地离线工具，联网行为一律由用户发起
 * - 便携版（PORTABLE_EXECUTABLE_DIR）与开发模式不提供就地更新，UI 引导打开发布页
 * - 未签名安装包：更新下载的 exe 由 NSIS 安装器执行，Windows SmartScreen 提示属
 *   预期行为，由设置页文案告知用户「更多信息 → 仍要运行」
 * - 失败路径全部归类为用户可读文案并落诊断日志，不阻断任何功能
 */
'use strict';

const FEED = { provider: 'github', owner: 'Laogaodhck', repo: 'haoyuebox' };
const RELEASES_URL = 'https://github.com/Laogaodhck/haoyuebox/releases/latest';

/* —— 纯函数（tools/test-appupdater.cjs 覆盖）—— */

/* 运行形态：便携版 / 打包安装版 / 开发模式 */
function envKind(env, isPackaged) {
  if (env && env.PORTABLE_EXECUTABLE_DIR) return 'portable';
  return isPackaged ? 'packaged' : 'dev';
}

/* electron-updater 错误 → 用户可读文案（含诊断日志用的英文原文由 logger 另行落盘） */
function classifyError(e) {
  const raw = String((e && e.message) || e || '');
  const msg = raw;
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPROTO|net::|network|fetch failed/i.test(msg)) {
    return '网络不可用或连接失败，请检查网络后重试';
  }
  if (/403|rate limit/i.test(msg)) return 'GitHub 访问受限（请求过于频繁），请稍后再试';
  if (/404|ENOENT|latest\.yml|no published versions|Cannot find.*\.yml/i.test(msg)) {
    return '更新元数据缺失（发布资产不完整），请到发布页手动下载';
  }
  return '更新失败：' + (msg.length > 140 ? msg.slice(0, 140) + '…' : msg);
}

/* 进度推送节流：状态切换必推；同状态下仅整数百分比变化才推，避免 IPC 风暴 */
function shouldPushProgress(prev, next) {
  if (!prev || !next) return true;
  if (prev.phase !== next.phase) return true;
  const a = Math.floor((prev.progress && prev.progress.percent) || 0);
  const b = Math.floor((next.progress && next.progress.percent) || 0);
  return a !== b;
}

/* releaseNotes 归一：GitHub provider 为字符串，其他源可能是 [{note}] 数组
 *（字符串数组也宽容支持，逐项按字符串拼接） */
function normalizeNotes(notes) {
  if (!notes) return '';
  if (Array.isArray(notes)) {
    return normalizeNotes(notes.map((n) => (typeof n === 'string' ? n : (n && n.note) || '')).join('\n'));
  }
  const s = typeof notes === 'string' ? notes : String(notes);
  return s.trim().slice(0, 600);
}

function fmtLog(m) {
  if (!m) return '';
  if (m instanceof Error) return m.message;
  if (typeof m === 'object') { try { return JSON.stringify(m); } catch (e) { return String(m); } }
  return String(m);
}

/* —— 状态机（依赖注入，便于纯 Node 测试）——
 * deps: { emitter(事件源), api {checkForUpdates, downloadUpdate, quitAndInstall},
 *         version, kind, push(快照推送), diag(诊断日志) }
 * phase: idle → checking → available | noupdate | error → downloading → downloaded
 */
function createController(deps) {
  const st = { phase: 'idle', info: null, progress: null, error: null };
  let lastPushed = null;

  function snapshot() {
    return {
      kind: deps.kind,
      version: deps.version,
      phase: st.phase,
      info: st.info,
      progress: st.progress,
      error: st.error,
    };
  }

  function publish() {
    const snap = snapshot();
    if (shouldPushProgress(lastPushed, snap)) { lastPushed = snap; deps.push && deps.push(snap); }
    return snap;
  }

  function fail(err) {
    st.phase = 'error';
    st.error = classifyError(err);
    st.progress = null;
    deps.diag && deps.diag('app-update', st.error);
    return publish();
  }

  /* electron-updater 的 checkForUpdates 会同时 reject 并发 error 事件，
     两路都以赋值收敛，重复触发无副作用 */
  deps.emitter.on('checking-for-update', () => {
    st.phase = 'checking'; st.error = null; publish();
  });
  deps.emitter.on('update-available', (info) => {
    st.phase = 'available';
    st.info = {
      version: (info && info.version) || '',
      notes: normalizeNotes(info && info.releaseNotes),
      date: (info && info.releaseDate) || '',
    };
    st.error = null; publish();
  });
  deps.emitter.on('update-not-available', () => {
    st.phase = 'noupdate'; st.info = null; st.error = null; publish();
  });
  deps.emitter.on('download-progress', (p) => {
    st.phase = 'downloading';
    st.progress = {
      percent: Math.max(0, Math.min(100, Number(p && p.percent) || 0)),
      bps: (p && p.bytesPerSecond) || 0,
      transferred: (p && p.transferred) || 0,
      total: (p && p.total) || 0,
    };
    publish();
  });
  deps.emitter.on('update-downloaded', () => {
    st.phase = 'downloaded'; st.progress = null; publish();
  });
  deps.emitter.on('error', (err) => { fail(err); });

  return {
    /* 检查更新：checking/downloading 期间重入直接返回当前快照 */
    check: function () {
      if (st.phase === 'checking' || st.phase === 'downloading') return Promise.resolve(snapshot());
      st.info = null; st.error = null; st.progress = null;
      let p;
      try { p = deps.api.checkForUpdates(); } catch (e) { return Promise.resolve(fail(e)); }
      return Promise.resolve(p).then(() => snapshot(), fail);
    },
    /* 下载更新：仅 available 状态允许（autoDownload=false 手动触发） */
    download: function () {
      if (st.phase !== 'available' || !st.info) return Promise.resolve(snapshot());
      let p;
      try { p = deps.api.downloadUpdate(); } catch (e) { return Promise.resolve(fail(e)); }
      return Promise.resolve(p).then(() => snapshot(), fail);
    },
    /* 安装并重启：仅 downloaded 状态且打包安装版允许；走向导，装完自启 */
    install: function () {
      if (st.phase !== 'downloaded' || deps.kind !== 'packaged') return snapshot();
      try { deps.api.quitAndInstall(false, true); } catch (e) { fail(e); }
      return snapshot();
    },
    snapshot: snapshot,
  };
}

/* —— IPC 注册（main.js 调用）——
 * 通道：app-update:status/check/download/install/openReleases + 推送 app-update:progress */
function registerAppUpdateIpc(ipcMain, app, diag, getWin) {
  const { NsisUpdater } = require('electron-updater');
  const kind = envKind(process.env, app.isPackaged);

  const updater = new NsisUpdater(FEED);
  updater.autoDownload = false;         // 发现新版本后由用户确认再下载
  updater.autoInstallOnAppQuit = false; // 下载完成也不自动安装，用户点「安装并重启」
  updater.logger = {
    info: (m) => diag('app-update', 'info ' + fmtLog(m)),
    warn: (m) => diag('app-update', 'warn ' + fmtLog(m)),
    error: (m) => diag('app-update', 'error ' + fmtLog(m)),
    debug: () => {},
  };

  const ctl = createController({
    emitter: updater,
    api: updater,
    version: app.getVersion(),
    kind: kind,
    push: function (snap) {
      const w = getWin && getWin();
      if (w && !w.isDestroyed()) w.webContents.send('app-update:progress', snap);
    },
    diag: diag,
  });

  ipcMain.handle('app-update:status', () => ctl.snapshot());
  ipcMain.handle('app-update:check', () => ctl.check());
  ipcMain.handle('app-update:download', () => ctl.download());
  ipcMain.handle('app-update:install', () => ctl.install());
  ipcMain.handle('app-update:openReleases', async () => {
    const { shell } = require('electron');
    await shell.openExternal(RELEASES_URL);
    return { ok: true };
  });
  return ctl;
}

module.exports = {
  FEED: FEED,
  RELEASES_URL: RELEASES_URL,
  envKind: envKind,
  classifyError: classifyError,
  shouldPushProgress: shouldPushProgress,
  normalizeNotes: normalizeNotes,
  createController: createController,
  registerAppUpdateIpc: registerAppUpdateIpc,
};
