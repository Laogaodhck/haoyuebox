/* ============================================================
 * printer-probe.js — 打印机可用性检测（主进程）
 * 网络 / 共享打印机：TCP 连接测试（IPP / Raw9100 / LPR / SMB
 * 均为 TCP 服务，连通即视为可用，延迟一并测出）；
 * 系统打印机：由渲染层与 getPrintersAsync 列表比对判定
 *（见 js/printer-manager.js 的 matchSystem）。
 * 本模块不依赖 electron，可在 node 下直接单测。
 * ============================================================ */
'use strict';

const net = require('net');

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 10000;

/* 地址清洗：去空白、剥协议前缀（ipp://、smb:// 等）与末尾斜杠 */
function normalizeAddress(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .replace(/\/+$/, '');
}

/* 端口解析：空值回落默认端口；非法（非整数 / 越界）返回 null */
function parsePort(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const v = Number(String(raw).trim());
  if (!Number.isInteger(v) || v < 1 || v > 65535) return null;
  return v;
}

/* 连接配置校验：地址必填且 ≤253 字符；端口 1–65535（缺省 9100） */
function validateConnection(cfg) {
  const address = normalizeAddress(cfg && cfg.address);
  if (!address) return { ok: false, error: '请填写打印机地址（IP 或主机名）' };
  if (address.length > 253) return { ok: false, error: '打印机地址过长' };
  const port = parsePort(cfg && cfg.port, 9100);
  if (port === null) return { ok: false, error: '端口须为 1–65535 的整数' };
  return { ok: true, address: address, port: port };
}

/* 常见网络错误 → 中文可读原因 */
function friendlyError(err) {
  switch (err && err.code) {
    case 'ECONNREFUSED': return '连接被拒绝（目标未监听该端口）';
    case 'ENOTFOUND':
    case 'EAI_AGAIN': return '无法解析主机名';
    case 'ETIMEDOUT': return '连接超时';
    case 'EHOSTUNREACH': return '主机不可达';
    case 'ENETUNREACH': return '网络不可达';
    default: return (err && err.message) || '连接失败';
  }
}

/* TCP 探测：resolve({ ok, latencyMs }) 或 resolve({ ok:false, error })（不 reject） */
function probeTcp(address, port, timeoutMs) {
  const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let timer = null;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { socket.destroy(); } catch (e) { /* 已断开 */ }
      resolve(ok
        ? { ok: true, latencyMs: Date.now() - started }
        : { ok: false, error: error || '连接失败' });
    };
    const socket = net.connect({ host: address, port: port });
    timer = setTimeout(() => finish(false, '连接超时（' + timeout + 'ms）'), timeout);
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, '连接超时（' + timeout + 'ms）'));
    socket.once('error', (err) => finish(false, friendlyError(err)));
  });
}

/* 探测入口：先校验配置，再 TCP 连接 */
async function probePrinter(payload) {
  const v = validateConnection(payload || {});
  if (!v.ok) return { ok: false, error: v.error };
  try {
    return await probeTcp(v.address, v.port, payload && payload.timeoutMs);
  } catch (err) {
    return { ok: false, error: '检测失败：' + (err && err.message || '未知错误') };
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  normalizeAddress,
  parsePort,
  validateConnection,
  probeTcp,
  probePrinter
};
