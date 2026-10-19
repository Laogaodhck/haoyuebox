/* ============================================================
 * system.js — 系统工具主进程模块：网络检测 + 打印机系统操作
 * 安全边界（与 main.js / archive-icons.js 同规）：
 *  - 网络探测仅连固定白名单节点（公共 DNS 53 端口），渲染层无输入参与连接目标
 *  - 系统向导/设置页/测试页一律 sysExe() 解析 System32 绝对路径 + 数组参数（防注入、防 PATH 劫持）
 *  - 打印测试页的打印机名先经系统枚举白名单校验，再交给 printui.dll
 * ============================================================ */
'use strict';

const os = require('os');
const dns = require('dns');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

/* System32 绝对路径解析，避免 PATH（或当前目录）劫持 */
function sysExe(name) {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name + '.exe');
}

/* ---------- 网络检测 ---------- */

/* 探测节点：固定公共 DNS（TCP 53 握手测延迟，不发 HTTP、不上传任何数据） */
const PROBE_HOSTS = [
  { name: '阿里 DNS', host: '223.5.5.5', port: 53 },
  { name: 'DNSPod', host: '119.29.29.29', port: 53 },
  { name: '114 DNS', host: '114.114.114.114', port: 53 },
  { name: 'Google DNS', host: '8.8.8.8', port: 53 }
];
/* DNS 解析测试域名：仅经系统解析器查询，不访问站点 */
const DNS_DOMAINS = ['www.baidu.com', 'www.qq.com'];
const PROBE_TIMEOUT = 3000;

/* 单节点 TCP 握手延迟（连接即断开） */
function tcpProbe(host, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host: host, port: port });
    const done = (ok, error) => {
      sock.destroy();
      resolve({ ok: ok, ms: ok ? Date.now() - t0 : 0, error: error || '' });
    };
    sock.setTimeout(PROBE_TIMEOUT, () => done(false, '连接超时'));
    sock.once('connect', () => done(true));
    sock.once('error', (err) => done(false, err && err.code === 'ETIMEDOUT' ? '连接超时' : '无法连接'));
  });
}

/* 域名解析测试（走系统 DNS，getaddrinfo；带超时兜底——系统解析器挂起时
   netProbe IPC 不能无限期不返回，与 tcpProbe 的 3s 超时对齐） */
function dnsProbe(domain) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const timer = setTimeout(() => done({ domain: domain, ok: false, addr: '', ms: 0 }), PROBE_TIMEOUT);
    dns.lookup(domain, (err, addr) => {
      clearTimeout(timer);
      if (err) done({ domain: domain, ok: false, addr: '', ms: 0 });
      else done({ domain: domain, ok: true, addr: addr, ms: Date.now() - t0 });
    });
  });
}

/* 本机网卡信息（过滤回环接口） */
function netInfo() {
  const ifaces = os.networkInterfaces();
  const list = [];
  Object.keys(ifaces).forEach((name) => {
    const addrs = (ifaces[name] || []).filter(
      (a) => !a.internal && (a.family === 'IPv4' || a.family === 'IPv6')
    );
    if (!addrs.length) return;
    list.push({
      name: name,
      mac: addrs[0].mac || '',
      addrs: addrs.map((a) => ({ addr: a.address, family: a.family }))
    });
  });
  return { ok: true, ifaces: list };
}

async function netProbe() {
  const probes = await Promise.all(PROBE_HOSTS.map((p) =>
    tcpProbe(p.host, p.port).then((r) => ({
      name: p.name, host: p.host + ':' + p.port, ok: r.ok, ms: r.ms, error: r.error
    }))
  ));
  const dnss = await Promise.all(DNS_DOMAINS.map(dnsProbe));
  return { ok: true, probes: probes, dns: dnss };
}

/* ---------- 打印机系统操作（仅 Windows） ---------- */

const NOT_WIN = { ok: false, error: '当前系统不支持此操作（仅 Windows）' };

/* 启动系统 GUI 流程（向导/设置页），等待 300ms 捕捉启动失败后即返回 */
function launch(exe, args) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    try {
      const child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' });
      child.once('error', (err) => done({ ok: false, error: err.message || '启动失败' }));
      setTimeout(() => done({ ok: true }), 300);
    } catch (err) {
      done({ ok: false, error: err.message || '启动失败' });
    }
  });
}

/* 打开系统「添加打印机」向导（printui.dll 安装向导，交互流程由系统接管） */
function openAddPrinter() {
  if (process.platform !== 'win32') return Promise.resolve(NOT_WIN);
  return launch(sysExe('rundll32'), ['printui.dll,PrintUIEntry', '/il']);
}

/* 打开系统「打印机和扫描仪」设置页 */
function openPrintSettings() {
  if (process.platform !== 'win32') return Promise.resolve(NOT_WIN);
  return launch(sysExe('explorer'), ['ms-settings:printers']);
}

/* 打印测试页：打印机名先过本机枚举白名单，再交 printui.dll /k */
function printTestPage(getPrinters, printerName) {
  if (process.platform !== 'win32') return Promise.resolve(NOT_WIN);
  if (!printerName || typeof printerName !== 'string') {
    return Promise.resolve({ ok: false, error: '未选择打印机' });
  }
  return getPrinters().then((printers) => {
    const names = (printers || []).map((p) => p.name);
    if (names.indexOf(printerName) < 0) return { ok: false, error: '打印机不在本机列表中' };
    return launch(sysExe('rundll32'), ['printui.dll,PrintUIEntry', '/k', '/n', printerName]);
  }).catch(() => ({ ok: false, error: '打印机枚举失败' }));
}

function registerSystemIpc(ipcMain, getWin) {
  ipcMain.handle('system:netInfo', () => netInfo());
  ipcMain.handle('system:netProbe', () => netProbe());
  ipcMain.handle('system:openAddPrinter', () => openAddPrinter());
  ipcMain.handle('system:openPrintSettings', () => openPrintSettings());
  ipcMain.handle('system:printTestPage', (e, printerName) => {
    const win = getWin();
    if (!win || win.isDestroyed()) return Promise.resolve({ ok: false, error: '窗口未就绪' });
    return printTestPage(() => win.webContents.getPrintersAsync(), printerName);
  });
}

module.exports = {
  registerSystemIpc, netInfo, netProbe,
  /* 以下导出供单测（printTestPage 白名单校验、sysExe 防劫持、探测超时） */
  printTestPage, sysExe, dnsProbe, tcpProbe
};
