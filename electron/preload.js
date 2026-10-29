/* ============================================================
 * preload.js — 渲染进程安全桥接（contextBridge 白名单）
 * 暴露五组能力：打印（haoyuePrint）、压缩工具（haoyueArchive）、
 * 诊断上报（haoyueDiag）、压缩包图标关联（haoyueArchiveIcons）、
 * 系统工具（haoyueSystem）。不暴露 Node 能力。
 * ============================================================ */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

let progressCallback = null;  // archive:progress 回调（可替换）
let progressBound = false;    // ipcRenderer 监听器是否已注册（只绑一次）

contextBridge.exposeInMainWorld('haoyuePrint', {
  isDesktop: true,
  listPrinters: () => ipcRenderer.invoke('print:listPrinters'),
  showPrinterProperties: (printerName) => ipcRenderer.invoke('print:showProperties', printerName),
  printImage: (payload) => ipcRenderer.invoke('print:printImage', payload),
  /* 批量打印：文件选择（kind: image | doc）与文档字节读取 */
  pickPaths: (kind) => ipcRenderer.invoke('archive:pickPaths', kind),
  readFile: (filePath) => ipcRenderer.invoke('print:readFile', filePath)
});

/* 压缩工具桥接：选文件 / 保存路径 / 压缩 / 解压 / 进度回调 / 取消 */
contextBridge.exposeInMainWorld('haoyueArchive', {
  isDesktop: true,
  check7z: () => ipcRenderer.invoke('archive:check7z'),
  pickPaths: (kind) => ipcRenderer.invoke('archive:pickPaths', kind),
  /* 拖拽支持：File 对象 → 本机真实路径（非本机文件 / 虚拟文件返回 ''） */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; }
    catch (e) { return ''; }
  },
  /* 拖拽路径 → 条目元数据（主进程 stat，返回 [{path,name,isDir,size,mtime}]） */
  statPaths: (paths) => ipcRenderer.invoke('archive:statPaths', paths),
  saveDialog: (defaultName) => ipcRenderer.invoke('archive:saveDialog', defaultName),
  /* 桌面目录（压缩到桌面 / 解压到桌面同名文件夹 的输出基准路径） */
  desktopPath: () => ipcRenderer.invoke('archive:desktopPath'),
  compress: (payload) => ipcRenderer.invoke('archive:compress', payload),
  extract: (payload) => ipcRenderer.invoke('archive:extract', payload),
  list: (payload) => ipcRenderer.invoke('archive:list', payload),
  cancel: () => ipcRenderer.invoke('archive:cancel'),
  onProgress: (cb) => {
    // 监听器全局只注册一次（与 callback 是否为空无关），后续调用仅替换回调：
    // 若用「callback===null 才绑定」判断，onProgress(null) 后再 onProgress(cb)
    // 会重复绑定 ipcRenderer 监听，每个进度事件双触发
    if (!progressBound) {
      progressBound = true;
      ipcRenderer.on('archive:progress', (e, data) => { if (progressCallback) progressCallback(data); });
    }
    progressCallback = cb;
  }
});

/* 诊断桥接：渲染层脚本错误上报（仅文本，主进程落盘 userData/logs） */
contextBridge.exposeInMainWorld('haoyueDiag', {
  isDesktop: true,
  logError: (msg) => ipcRenderer.send('app:logError', String(msg))
});

/* 压缩包图标关联桥接：探测 / 注册 / 恢复（主进程经 reg.exe 写 HKCU） */
contextBridge.exposeInMainWorld('haoyueArchiveIcons', {
  isDesktop: true,
  probe: () => ipcRenderer.invoke('archive-icons:probe'),
  apply: (exts) => ipcRenderer.invoke('archive-icons:apply', exts),
  restore: (exts) => ipcRenderer.invoke('archive-icons:restore', exts)
});

/* 系统工具桥接：网络检测（主进程仅连固定白名单 DNS 节点）+ 打印机系统操作 */
contextBridge.exposeInMainWorld('haoyueSystem', {
  isDesktop: true,
  netInfo: () => ipcRenderer.invoke('system:netInfo'),
  netProbe: () => ipcRenderer.invoke('system:netProbe'),
  openAddPrinter: () => ipcRenderer.invoke('system:openAddPrinter'),
  openPrintSettings: () => ipcRenderer.invoke('system:openPrintSettings'),
  printTestPage: (printerName) => ipcRenderer.invoke('system:printTestPage', printerName)
});

/* 版本/更新桥接：版本信息（升级/回滚识别）与设置备份（迁移前快照、
 * 数据丢失恢复）。全部纯本机操作，无任何网络。 */
contextBridge.exposeInMainWorld('haoyueApp', {
  isDesktop: true,
  updateInfo: () => ipcRenderer.invoke('app:updateInfo'),
  backupData: (raw) => ipcRenderer.invoke('app:backupData', raw),
  readBackup: () => ipcRenderer.invoke('app:readBackup'),
  deleteBackup: (name) => ipcRenderer.invoke('app:deleteBackup', name)
});

/* 应用内更新桥接：检查/下载/安装（仅安装版可用，见 electron/updater.js）。
 * 进度经 app-update:progress 推送，回调由渲染层覆盖注册（与 haoyueArchive 同模式）。 */
var updateProgressCb = null;
ipcRenderer.on('app-update:progress', (_e, snap) => { if (updateProgressCb) updateProgressCb(snap); });
contextBridge.exposeInMainWorld('haoyueAppUpdate', {
  status: () => ipcRenderer.invoke('app-update:status'),
  check: () => ipcRenderer.invoke('app-update:check'),
  download: () => ipcRenderer.invoke('app-update:download'),
  install: () => ipcRenderer.invoke('app-update:install'),
  openReleases: () => ipcRenderer.invoke('app-update:openReleases'),
  onProgress: (cb) => { updateProgressCb = typeof cb === 'function' ? cb : null; }
});

console.log('[haoyue] 打印桥接已就绪');
