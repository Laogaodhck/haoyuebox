/* ============================================================
 * main.js — 浩玥工具箱 Electron 主进程
 * 全部资源本地化：内置静态服务 + 本地窗口，断网完整可用。
 * ============================================================ */
'use strict';

const { app, BrowserWindow, Menu, shell, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { createStaticServer } = require('./static-server');
const { buildPrintDoc } = require('./print-doc');
const { registerArchiveIpc } = require('./archive');

const APP_TITLE = '浩玥工具箱';
let mainWindow = null;
let serverPort = 0;
/* 打印页内存路由：key=/__print__/<token>，value=html。经内置静态服务
   以 http://127.0.0.1 提供（与主窗口同源、生产已验证可靠的装载路径），
   规避 Chromium data: URL 2MB 上限（ERR_INVALID_URL -300）与临时文件清理 */
const printPages = new Map();

/* ---------- 打印 IPC：读取本地打印机 + 静默打印图片 ---------- */
function registerPrintIpc() {
  ipcMain.handle('print:listPrinters', async () => {
    const printers = await mainWindow.webContents.getPrintersAsync();
    return printers.map((p) => ({
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: !!p.isDefault,
      status: p.status || ''
    }));
  });

  /* 打开所选打印机的系统属性对话框（Windows: printui.dll） */
  ipcMain.handle('print:showProperties', async (e, printerName) => {
    if (!printerName || typeof printerName !== 'string') {
      return { ok: false, error: '未选择打印机' };
    }
    if (process.platform !== 'win32') {
      return { ok: false, error: '当前系统不支持打印机属性对话框' };
    }
    const { execFile } = require('child_process');
    return new Promise((resolve) => {
      // rundll32 printui.dll,PrintUIEntry /p /n "打印机名" → 打印机属性
      execFile('rundll32', ['printui.dll,PrintUIEntry', '/p', '/n', printerName], (err) => {
        if (err) resolve({ ok: false, error: '无法打开打印机属性：' + (err.message || '未知错误') });
        else resolve({ ok: true });
      });
    });
  });

  /* 打印图片（支持多页）：dataUrl（单张，兼容旧调用）或 dataUrls（多张）。
     全部页合并为一次打印任务——一个隐藏窗口装载整份多页文档、一次 print()
     发送；逐页各发任务会让打印机驱动每个任务弹一次确认框。 */
  ipcMain.handle('print:printImage', async (e, payload) => {
    const { dataUrl, dataUrls, printerName, copies, pageSize, landscape, marginType, duplex } = payload || {};
    const doc = buildPrintDoc(Array.isArray(dataUrls) && dataUrls.length ? dataUrls : [dataUrl], pageSize, !!landscape);
    if (!doc.pageCount) return { ok: false, error: '无效的图片数据' };
    // 隐藏窗口装载图片，按所选纸张/方向/边距静默发送到指定打印机
    const html = doc.html;
    const token = 'p' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const route = '/__print__/' + token;
    printPages.set(route, html);
    const printWin = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    try {
      await printWin.loadURL('http://127.0.0.1:' + serverPort + route);
      const opts = {
        silent: true,
        printBackground: true,
        deviceName: printerName || undefined,
        copies: Math.max(1, Math.min(99, copies || 1)),
        margins: { marginType: marginType === 'printableArea' ? 'printableArea' : 'none' }
      };
      if (pageSize) opts.pageSize = pageSize;          // 'A4'/'A5'/'Letter' 或 {width,height} 微米
      if (landscape) opts.landscape = true;
      // 双面：simplex 单面 / longEdge 长边翻页 / shortEdge 短边翻页
      if (duplex === 'longEdge' || duplex === 'shortEdge') opts.duplexMode = duplex;
      return await new Promise((resolve) => {
        printWin.webContents.print(opts, (ok, failureReason) => {
          printWin.destroy();
          resolve({ ok: !!ok, error: ok ? '' : (failureReason || '打印失败') });
        });
      });
    } catch (err) {
      printWin.destroy();
      return { ok: false, error: String((err && err.message) || err) };
    } finally {
      printPages.delete(route);
    }
  });
}
registerPrintIpc();
registerArchiveIpc(ipcMain, () => mainWindow);

/* 打印文档/图片读取：渲染层沙箱无 fs，经此读取所选文件字节。
   文档（pdf.js / mammoth 渲染）与图片（缩略图 / 打印绘制）共用，
   限定可打印扩展名与 200MB 上限，返回 ArrayBuffer（IPC 结构化克隆传输） */
const FILE_READ_EXTS = ['pdf', 'txt', 'docx', 'doc', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'];
ipcMain.handle('print:readFile', (e, filePath) => {
  if (!filePath || typeof filePath !== 'string') return { ok: false, error: '未指定文件' };
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  if (FILE_READ_EXTS.indexOf(ext) < 0) return { ok: false, error: '不支持的文件类型：' + ext };
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return { ok: false, error: '不是常规文件' };
    if (st.size > 200 * 1024 * 1024) return { ok: false, error: '文档超过 200MB，无法读取' };
    const buf = fs.readFileSync(filePath);
    return { ok: true, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), size: st.size };
  } catch (err) {
    return { ok: false, error: '读取失败：' + (err.message || err) };
  }
});

// 照片工具以 Canvas 2D 为主，禁用硬件加速换取稳定性（弱 GPU 机器防崩）
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
// 部分 GPU 驱动异常的机器上 GPU 进程仍可能崩溃（GPU process isn't usable），
// 强制进程内软件合成，彻底绕开 GPU 进程
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('in-process-gpu');

// 单实例
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

async function createWindow() {
  const root = app.getAppPath(); // 打包后指向 app.asar
  const { port, close } = await createStaticServer(root, printPages);
  serverPort = port;

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: APP_TITLE,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    backgroundColor: '#12151c',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  Menu.setApplicationMenu(null);

  // 标题不被页面改动覆盖（保留品牌署名）
  mainWindow.on('page-title-updated', (e) => e.preventDefault());

  // 禁止导航到外部与弹出新窗口；http(s) 链接交给系统浏览器
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://127.0.0.1:' + port)) {
      e.preventDefault();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 显式 CSP：允许本地资源 + WASM 编译（MediaPipe 必需），阻止远程内容
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' http://127.0.0.1:*; script-src 'self' http://127.0.0.1:* 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' http://127.0.0.1:* 'unsafe-inline'; img-src 'self' http://127.0.0.1:* data: blob:; worker-src 'self' http://127.0.0.1:* blob:"
        ]
      }
    });
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  try {
    await mainWindow.loadURL('http://127.0.0.1:' + port + '/');
  } catch (err) {
    // 首次加载偶发失败（GPU/网络服务抖动）时重试一次
    console.warn('[haoyue] 首次加载失败，重试中:', err && err.message);
    await new Promise((r) => setTimeout(r, 800));
    await mainWindow.loadURL('http://127.0.0.1:' + port + '/').catch(() => {});
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
