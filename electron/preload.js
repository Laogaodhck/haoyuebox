/* ============================================================
 * preload.js — 渲染进程安全桥接
 * 仅暴露打印能力（读打印机 + 静默打印图片），不暴露 Node 能力。
 * ============================================================ */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zunhongPrint', {
  isDesktop: true,
  listPrinters: () => ipcRenderer.invoke('print:listPrinters'),
  showPrinterProperties: (printerName) => ipcRenderer.invoke('print:showProperties', printerName),
  probePrinter: (payload) => ipcRenderer.invoke('print:probePrinter', payload),
  printImage: (payload) => ipcRenderer.invoke('print:printImage', payload),
  /* 批量打印：文件选择（kind: image | doc）与文档字节读取 */
  pickPaths: (kind) => ipcRenderer.invoke('archive:pickPaths', kind),
  readFile: (filePath) => ipcRenderer.invoke('print:readFile', filePath)
});

/* 压缩工具桥接：选文件 / 保存路径 / 压缩 / 解压 / 进度回调 */
contextBridge.exposeInMainWorld('zunhongArchive', {
  isDesktop: true,
  check7z: () => ipcRenderer.invoke('archive:check7z'),
  pickPaths: (kind) => ipcRenderer.invoke('archive:pickPaths', kind),
  saveDialog: (defaultName) => ipcRenderer.invoke('archive:saveDialog', defaultName),
  compress: (payload) => ipcRenderer.invoke('archive:compress', payload),
  extract: (payload) => ipcRenderer.invoke('archive:extract', payload),
  list: (payload) => ipcRenderer.invoke('archive:list', payload),
  onProgress: (cb) => {
    ipcRenderer.on('archive:progress', (e, data) => cb(data));
  }
});

/* 诊断桥接：渲染层脚本错误上报（仅文本，主进程落盘 userData/logs） */
contextBridge.exposeInMainWorld('zunhongDiag', {
  isDesktop: true,
  logError: (msg) => ipcRenderer.send('app:logError', String(msg))
});

console.log('[zunhong] 打印桥接已就绪');
