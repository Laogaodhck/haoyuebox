/* ============================================================
 * main.js — 浩玥工具箱 Electron 主进程
 * 全部资源本地化：内置静态服务 + 本地窗口，断网完整可用。
 * ============================================================ */
'use strict';

const { app, BrowserWindow, Menu, dialog, shell, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { createStaticServer } = require('./static-server');
const { buildPrintDoc } = require('./print-doc');
const { registerArchiveIpc } = require('./archive');
const archiveIcons = require('./archive-icons');
const { registerSystemIpc } = require('./system');
const update = require('./update');
const appUpdater = require('./updater');

const APP_TITLE = '浩玥工具箱';

/* 品牌更名一次性数据迁移（尊泓工具箱 → 浩玥工具箱）：userData 目录名随
   productName 变化，首次以新名启动时若新目录尚未生成而旧目录存在，
   则把旧数据整体带入（设置备份 / 版本标记 / 诊断日志 / Local Storage），
   旧目录保留不动以支持回滚到旧版本。 */
(function migrateLegacyUserData() {
  try {
    const appData = app.getPath('appData');
    const curDir = path.join(appData, app.getName());
    const legacyDir = path.join(appData, '尊泓工具箱');
    if (!fs.existsSync(curDir) && fs.existsSync(legacyDir)) {
      fs.cpSync(legacyDir, curDir, { recursive: true });
      console.log('[haoyue] 已从旧版目录迁移用户数据:', legacyDir, '→', curDir);
    }
  } catch (e) { /* 迁移失败不阻断启动 */ }
})();

let mainWindow = null;
let serverPort = 0;
/* 打印页内存路由：key=/__print__/<token>，value=html。经内置静态服务
   以 http://127.0.0.1 提供（与主窗口同源、生产已验证可靠的装载路径），
   规避 Chromium data: URL 2MB 上限（ERR_INVALID_URL -300）与临时文件清理 */
const printPages = new Map();

/* ---------- 诊断日志：异常落盘（离线软件无远程上报，日志是排障最后手段） ----------
   写入 <userData>/logs/app-YYYY-MM-DD.log，按天分文件，自动轮转保留最近 LOG_KEEP 份。
   覆盖：主进程未捕获异常 / Promise 拒绝 / 渲染进程与子进程异常退出 / 渲染层上报。 */
/* 诊断日志单行化：CR/LF 展平为 ↵，防止伪造多行日志条目干扰排障 */
function flattenLog(s) {
  return String(s).replace(/\r\n?|\n/g, ' ↵ ');
}

const LOG_KEEP = 10;
function appendDiag(kind, detail) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'app-' + new Date().toISOString().slice(0, 10) + '.log');
    fs.appendFileSync(file, new Date().toISOString() + ' [' + kind + '] ' + flattenLog(detail).slice(0, 4000) + '\n');
    const files = fs.readdirSync(dir)
      .filter((f) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort();
    while (files.length > LOG_KEEP) {
      try { fs.unlinkSync(path.join(dir, files.shift())); } catch (e) { break; }
    }
  } catch (e) { /* 日志写入失败（如磁盘只读）只能静默 */ }
}
process.on('uncaughtException', (err) => {
  appendDiag('uncaughtException', (err && err.stack) || String(err));
  console.error('[haoyue] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  appendDiag('unhandledRejection', (reason && (reason.stack || reason.message)) || String(reason));
});
app.on('child-process-gone', (_e, details) => appendDiag('child-process-gone', JSON.stringify(details)));
app.on('render-process-gone', (_e, _wc, details) => appendDiag('render-process-gone', JSON.stringify(details)));
ipcMain.on('app:logError', (_e, msg) => appendDiag('renderer', msg));

/* ---------- 打印 IPC：读取本地打印机 + 静默打印图片 ---------- */

/* Windows 默认打印机名（Electron 36+ 移除了 PrinterInfo.isDefault，无替代 API；
   Windows 上经 CIM 查询补回，失败/非 Windows 返回空串 = 无默认标记） */
/* 系统工具一律用 System32 绝对路径解析，避免 PATH（或当前目录）劫持 */
function sysExe(name) {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name + '.exe');
}

function windowsDefaultPrinter() {
  if (process.platform !== 'win32') return Promise.resolve('');
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    // 中文 Windows 的 PowerShell 5.1 管道输出走 OEM 代码页（GBK 936），Node 按 UTF-8
    // 解码会成乱码，与 Electron 枚举的 Unicode 打印机名永不相等（默认徽标静默失效），
    // 故 -Command 前强制控制台输出编码为 UTF-8
    execFile(sysExe('powershell'), [
      '-NoProfile', '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
        '(Get-CimInstance Win32_Printer | Where-Object { $_.Default -eq $true } | Select-Object -First 1).Name'
    ], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || '').trim());
    });
  });
}

function registerPrintIpc() {
  ipcMain.handle('print:listPrinters', async () => {
    const printers = await mainWindow.webContents.getPrintersAsync();
    let def = '';
    try { def = await windowsDefaultPrinter(); } catch (e) { /* 降级：无默认标记 */ }
    return printers.map((p) => ({
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: !!def && p.name === def
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
    /* 打印机名白名单校验（与 system.js printTestPage 同规）：
     * 名字必须来自本机枚举列表，杜绝渲染层伪造名称直达系统调用 */
    try {
      const printers = await mainWindow.webContents.getPrintersAsync();
      if (!(printers || []).some((p) => p.name === printerName)) {
        return { ok: false, error: '打印机不在本机列表中' };
      }
    } catch (err) {
      return { ok: false, error: '打印机枚举失败' };
    }
    const { spawn } = require('child_process');
    return new Promise((resolve) => {
      // rundll32 printui.dll,PrintUIEntry /p /n "打印机名" → 打印机属性
      // 对话框由 rundll32 托管且用户交互期间常驻：不能用 execFile 超时杀它
      // （到期 kill 会把用户设置到一半的对话框强关），spawn 成功即视为打开
      const child = spawn(sysExe('rundll32'), ['printui.dll,PrintUIEntry', '/p', '/n', printerName],
        { windowsHide: true, stdio: 'ignore' });
      child.once('error', (err) => resolve({ ok: false, error: '无法打开打印机属性：' + (err.message || '未知错误') }));
      child.once('spawn', () => resolve({ ok: true }));
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
    const token = require('crypto').randomUUID();
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
        let settled = false;
        const done = (r) => { if (settled) return; settled = true; clearTimeout(watchdog); resolve(r); };
        // 看门狗：print 回调永不触发（驱动挂起）时销毁隐藏窗口并返回错误，
        // 防隐藏窗口 + printPages 路由 + IPC promise 三者一起泄漏、按钮永久禁用
        const watchdog = setTimeout(() => {
          try { printWin.destroy(); } catch (e) { /* 已销毁 */ }
          done({ ok: false, error: '打印超时（60 秒）：打印机驱动可能无响应，请重试' });
        }, 60000);
        printWin.webContents.print(opts, (ok, failureReason) => {
          try { printWin.destroy(); } catch (e) { /* 已销毁 */ }
          done({ ok: !!ok, error: ok ? '' : (failureReason || '打印失败') });
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
/* print:readFile 会话级路径白名单：只允许读取经 archive:pickPaths（对话框选择）
 * 或 archive:statPaths（拖拽）登记过的本机路径。纵深防御——渲染进程即使被
 * 攻破（XSS 已被 CSP 大幅压缩），也无法凭空指定任意磁盘路径读取文件。
 * 归一化键与 7z-args.normPathKey 同思路：resolve 消解相对段 + Windows 不区分大小写 */
const readPathWhitelist = new Set();
const READ_PATH_MAX = 5000; // 容量上限：单次超限时整体清空（正常使用远达不到）
function normReadPathKey(p) {
  let s = path.resolve(String(p));
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}
function allowReadPaths(metas) {
  (Array.isArray(metas) ? metas : []).forEach((m) => {
    if (m && typeof m.path === 'string' && m.path) {
      if (readPathWhitelist.size >= READ_PATH_MAX) readPathWhitelist.clear();
      readPathWhitelist.add(normReadPathKey(m.path));
    }
  });
}
registerArchiveIpc(ipcMain, () => mainWindow, allowReadPaths);
/* 系统工具：网络检测（固定白名单 DNS 节点）+ 打印机向导/设置页/测试页 */
registerSystemIpc(ipcMain, () => mainWindow);
/* 版本检测/升级标记/数据备份（覆盖安装与版本更新的本机侧支撑） */
const updateCtl = update.registerUpdateIpc(ipcMain, app, appendDiag);
/* 应用内更新器（安装版就地升级，GitHub Release 源；手动触发制，见 electron/updater.js） */
appUpdater.registerAppUpdateIpc(ipcMain, app, appendDiag, () => mainWindow);

/* 压缩包图标关联（HKCU 用户级，只补无关联的电脑，不动已有关联） */
ipcMain.handle('archive-icons:probe', () => archiveIcons.probe());
ipcMain.handle('archive-icons:apply', (e, exts) => archiveIcons.apply(exts));
ipcMain.handle('archive-icons:restore', (e, exts) => archiveIcons.restore(exts));

/* 打印文档/图片读取：渲染层沙箱无 fs，经此读取所选文件字节。
   文档（pdf.js / mammoth 渲染）与图片（缩略图 / 打印绘制）共用，
   限定可打印扩展名与 200MB 上限，返回 ArrayBuffer（IPC 结构化克隆传输）。
   异步 fs.promises：大文件（可达 200MB）同步读会长时间阻塞主进程事件循环，
   期间窗口无响应、IPC 全排队——此处改为异步读。 */
const FILE_READ_EXTS = ['pdf', 'txt', 'docx', 'doc', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'];
ipcMain.handle('print:readFile', async (e, filePath) => {
  if (!filePath || typeof filePath !== 'string') return { ok: false, error: '未指定文件' };
  /* 会话级白名单：路径必须先经文件选择对话框/拖拽登记（见 allowReadPaths） */
  if (!readPathWhitelist.has(normReadPathKey(filePath))) {
    return { ok: false, error: '文件未经选择授权，请重新选择文件' };
  }
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  if (FILE_READ_EXTS.indexOf(ext) < 0) return { ok: false, error: '不支持的文件类型：' + ext };
  try {
    const st = await fs.promises.stat(filePath);
    if (!st.isFile()) return { ok: false, error: '不是常规文件' };
    if (st.size > 200 * 1024 * 1024) return { ok: false, error: '文档超过 200MB，无法读取' };
    const buf = await fs.promises.readFile(filePath);
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
  /* 静态服务随应用存活，close 无需保存 */
  const { port } = await createStaticServer(root, printPages);
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

  // 显式 CSP（与 index.html meta 策略逐字一致）：允许本地资源 + WASM 编译
  // （MediaPipe 必需）+ data:/blob: 图片，阻止远程内容、内联脚本与框架嵌套
  const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP]
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

/* 设置 AppUserModelID：任务栏/通知归属到 com.haoyue.idphoto，
   也让安全软件把进程与已安装应用对应起来（无此 ID 时进程身份模糊） */
if (process.platform === 'win32') {
  app.setAppUserModelId('com.haoyue.idphoto');
}

// 启动失败（如静态服务监听失败）不能静默变僵尸：落诊断日志 + 弹窗告知 + 退出
app.whenReady().then(() => {
  // 升级/回滚扫描须在窗口创建前完成：marker 原子写 + 诊断日志，
  // 渲染层 boot 后即可取到本次启动类型（升级首启触发数据备份）
  updateCtl.scanOnLaunch();
  return createWindow();
}).catch((err) => {
  appendDiag('createWindow-failed', (err && err.stack) || String(err));
  dialog.showErrorBox('浩玥工具箱启动失败', '窗口初始化失败：' + ((err && err.message) || err));
  app.quit();
});

app.on('window-all-closed', () => {
  app.quit();
});
