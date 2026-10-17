/* ============================================================
 * preload.js — 渲染进程安全桥接
 * 仅暴露打印能力（读打印机 + 静默打印图片），不暴露 Node 能力。
 * ============================================================ */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

let progressCallback = null;  // archive:progress 回调（单注册，可替换）

contextBridge.exposeInMainWorld('zunhongPrint', {
  isDesktop: true,
  listPrinters: () => ipcRenderer.invoke('print:listPrinters'),
  showPrinterProperties: (printerName) => ipcRenderer.invoke('print:showProperties', printerName),
  printImage: (payload) => ipcRenderer.invoke('print:printImage', payload),
  /* 批量打印：文件选择（kind: image | doc）与文档字节读取 */
  pickPaths: (kind) => ipcRenderer.invoke('archive:pickPaths', kind),
  readFile: (filePath) => ipcRenderer.invoke('print:readFile', filePath)
});

/* 压缩工具桥接：选文件 / 保存路径 / 压缩 / 解压 / 进度回调 / 取消 */
contextBridge.exposeInMainWorld('zunhongArchive', {
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
  compress: (payload) => ipcRenderer.invoke('archive:compress', payload),
  extract: (payload) => ipcRenderer.invoke('archive:extract', payload),
  list: (payload) => ipcRenderer.invoke('archive:list', payload),
  cancel: () => ipcRenderer.invoke('archive:cancel'),
  onProgress: (cb) => {
    // 进度监听器只在首次调用时注册，后续调用仅替换回调（防重复绑定叠加触发）
    if (progressCallback === null) {
      ipcRenderer.on('archive:progress', (e, data) => { if (progressCallback) progressCallback(data); });
    }
    progressCallback = cb;
  }
});

/* 诊断桥接：渲染层脚本错误上报（仅文本，主进程落盘 userData/logs） */
contextBridge.exposeInMainWorld('zunhongDiag', {
  isDesktop: true,
  logError: (msg) => ipcRenderer.send('app:logError', String(msg))
});

/* 压缩包图标关联桥接：探测 / 注册 / 恢复（主进程经 reg.exe 写 HKCU） */
contextBridge.exposeInMainWorld('zunhongArchiveIcons', {
  isDesktop: true,
  probe: () => ipcRenderer.invoke('archive-icons:probe'),
  apply: (exts) => ipcRenderer.invoke('archive-icons:apply', exts),
  restore: (exts) => ipcRenderer.invoke('archive-icons:restore', exts)
});

console.log('[zunhong] 打印桥接已就绪');
