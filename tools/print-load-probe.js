/* ============================================================
 * print-load-probe.js — 打印装载路径探针（Electron 运行）
 * 复现旧 data: URL 装载 >2MB 失败（ERR_INVALID_URL），
 * 对比 file:// 与自定义协议 zunhong-print:// 两条替代路径，
 * 验证图片真实解码。运行：electron.exe tools/print-load-probe.js
 * ============================================================ */
'use strict';

const { app, BrowserWindow, protocol } = require('electron');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('in-process-gpu');

/* 自定义打印协议：内存直供 HTML（需在 app ready 前注册特权） */
protocol.registerSchemesAsPrivileged([
  { scheme: 'zunhong-print', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

const printPages = new Map();

app.whenReady().then(async () => {
  const results = {};

  protocol.handle('zunhong-print', (req) => {
    const id = new URL(req.url).hostname;
    const html = printPages.get(id);
    if (!html) return new Response('gone', { status: 404 });
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });

  /* 构造 ~4MB 的图片 data URL（超出 Chromium data: URL 2MB 上限） */
  const bigBase64 = Buffer.alloc(3 * 1024 * 1024, 0x88).toString('base64');
  const dataUrl = 'data:image/png;base64,' + bigBase64;
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
    + '@page{margin:0}html,body{margin:0;padding:0;background:#fff}'
    + 'img{display:block;width:100%;height:auto}'
    + '</style></head><body><img src="' + dataUrl + '"></body></html>';

  /* 1. 旧路径：data: URL 直载（对照组，预期 FAIL） */
  const w1 = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await w1.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    results.dataUrl = 'OK';
  } catch (err) {
    results.dataUrl = 'FAIL: ' + String((err && err.message) || err).slice(0, 60);
  }
  w1.destroy();

  /* 2. 自定义协议 × sandbox 矩阵 + file:// 矩阵 */
  printPages.set('probe', html);
  async function tryLoad(label, url, sandbox) {
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: sandbox } });
    try {
      await w.loadURL(url);
      results[label] = 'OK';
    } catch (err) {
      results[label] = 'FAIL: ' + String((err && err.message) || err).slice(0, 60);
    }
    w.destroy();
  }
  await tryLoad('customProto_sandbox', 'zunhong-print://probe/x', true);
  await tryLoad('customProto_nosandbox', 'zunhong-print://probe/x', false);
  const tmp = path.join(os.tmpdir(), 'zunhong-print-probe-' + Date.now() + '.html');
  fs.writeFileSync(tmp, html, 'utf8');
  await tryLoad('file_sandbox', 'file:///' + tmp.replace(/\\/g, '/'), true);
  await tryLoad('file_nosandbox', 'file:///' + tmp.replace(/\\/g, '/'), false);
  /* 3. 检查渲染进程是否存活（区分「加载失败」与「进程崩溃」） */
  const w3 = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await w3.loadURL('about:blank');
    const alive = await w3.webContents.executeJavaScript('1+1');
    results.sandboxRendererAlive = alive === 2 ? 'OK' : 'FAIL';
  } catch (err) {
    results.sandboxRendererAlive = 'FAIL: ' + String((err && err.message) || err).slice(0, 60);
  }
  w3.destroy();
  try { fs.unlinkSync(tmp); } catch (err) { /* 占用时忽略 */ }

  console.log('[PROBE]' + JSON.stringify(results));
  app.exit(0);
});
