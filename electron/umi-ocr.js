/* ============================================================
 * umi-ocr.js — Umi-OCR 本地 HTTP 服务客户端（主进程）
 *
 * 为什么放在主进程：
 *  - 渲染层 CSP 为 connect-src 'self'，直接 fetch 127.0.0.1:1224 会被拦截；
 *  - 跨源请求还依赖 Umi-OCR 的 CORS 配置，主进程转发不受同源策略限制。
 *
 * 只做两件事：探测服务（/api/ocr/get_options）与图片识别（/api/ocr）。
 * 全程访问用户本机（或用户自填的局域网地址），不经过任何外部服务器。
 * 接口文档：https://github.com/hiroi-sora/Umi-OCR/blob/main/docs/http/api_ocr.md
 * ============================================================ */
'use strict';

const http = require('http');
const https = require('https');

const DEFAULT_BASE = 'http://127.0.0.1:1224';
const PROBE_TIMEOUT = 3000;
const RECOGNIZE_TIMEOUT = 120000;

/* 地址规范化：空值用默认端口；缺协议补 http://；只允许 http/https。
 * 返回 origin（忽略用户多填的路径），非法地址抛错。 */
function normalizeBase(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return DEFAULT_BASE;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'http://' + s;
  const u = new URL(s);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Umi-OCR 地址仅支持 http / https');
  }
  return u.origin;
}

/* 通用 JSON 请求：超时、连接拒绝等错误统一成可读中文提示 */
function requestJson(base, pathname, opts) {
  const options = opts || {};
  const method = options.method || 'GET';
  const body = options.body == null ? null : Buffer.from(JSON.stringify(options.body), 'utf8');
  const timeout = options.timeout || RECOGNIZE_TIMEOUT;
  let target;
  try {
    target = new URL(pathname, normalizeBase(base));
  } catch (e) {
    return Promise.reject(e);
  }
  const mod = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(target, {
      method,
      headers: Object.assign(
        { Accept: 'application/json' },
        body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}
      )
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('Umi-OCR 返回 HTTP ' + res.statusCode + '：' + text.slice(0, 120)));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error('Umi-OCR 返回内容不是合法 JSON，请确认地址指向 Umi-OCR 服务'));
        }
      });
    });
    req.setTimeout(timeout, () => {
      req.destroy(new Error('连接 Umi-OCR 超时（' + Math.round(timeout / 1000) + ' 秒无响应）'));
    });
    req.on('error', (err) => {
      if (err && err.code === 'ECONNREFUSED') {
        reject(new Error('无法连接 Umi-OCR：请先启动 Umi-OCR，并在「全局设置 → 高级」中允许 HTTP 服务'));
        return;
      }
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

/* 探测服务并取回参数定义（语言模型、排版解析、返回格式等） */
async function probe(base) {
  const options = await requestJson(base, '/api/ocr/get_options', { timeout: PROBE_TIMEOUT });
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Umi-OCR 参数接口返回格式异常');
  }
  return { ok: true, options };
}

/* 图片识别：payload = { base, base64, options }。
 * 返回 { ok, code, data, time, empty }；data 为 Umi 的原始识别项列表。 */
async function recognize(payload) {
  const p = payload || {};
  const base64 = String(p.base64 || '');
  if (!base64) throw new Error('缺少图片数据');
  const options = p.options && typeof p.options === 'object' ? p.options : {};
  const res = await requestJson(p.base, '/api/ocr', {
    method: 'POST',
    body: { base64, options },
    timeout: RECOGNIZE_TIMEOUT
  });
  const code = Number(res && res.code);
  if (code === 101) {
    return { ok: true, code, data: [], time: Number(res.time) || 0, empty: true };
  }
  if (code !== 100) {
    const msg = typeof (res && res.data) === 'string' ? res.data : '识别失败';
    throw new Error('Umi-OCR 识别失败（' + (Number.isFinite(code) ? code : '未知') + '）：' + msg);
  }
  return {
    ok: true,
    code,
    data: Array.isArray(res.data) ? res.data : [],
    time: Number(res.time) || 0,
    empty: false
  };
}

/* IPC 注册：返回 {ok:false,error} 而不是抛错，渲染层能拿到原始提示文案 */
function registerOcrIpc(ipcMain) {
  ipcMain.handle('ocr:umiProbe', async (e, base) => {
    try {
      return await probe(base);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
  ipcMain.handle('ocr:umiRecognize', async (e, payload) => {
    try {
      return await recognize(payload);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
}

module.exports = {
  DEFAULT_BASE,
  normalizeBase,
  probe,
  recognize,
  registerOcrIpc
};
