/* ============================================================
 * server.js — 零依赖静态文件服务器（供 start.bat 调用）
 * 仅提供本地静态资源，无任何后端逻辑；断网可用。
 *
 * 默认 0.0.0.0 监听以支持「同一局域网手机访问」；防护（2026-10-17 加固）：
 *   1) 仅放行 GET/HEAD；
 *   2) Host 白名单 = 回环地址 + 本机全部网卡地址（见 buildHostWhitelist），
 *      防 DNS rebinding 与跨站网页读取本机文件；
 *   3) 路径守卫复用 electron/static-server.js 的 resolveWithin
 *      （归一化后必须在 ROOT 之内，杜绝同前缀兄弟目录碰撞）。
 * ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveWithin, hostAllowed } = require('../electron/static-server.js');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 8410;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream'
};

/* Host 白名单：回环 + 本机所有网卡地址（手机经局域网 IP 访问时 Host 即该 IP） */
function buildHostWhitelist() {
  const set = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) set.add(n.address);
      if (n.family === 'IPv6' && !n.internal) { set.add(n.address); set.add('[' + n.address + ']'); }
    }
  }
  return set;
}

const server = http.createServer((req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Allow': 'GET, HEAD' });
      return res.end('Method Not Allowed');
    }
    if (!hostAllowed(req.headers.host, buildHostWhitelist())) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    const rawPath = req.url.split('?')[0];
    const urlPath = rawPath === '/' ? '/index.html' : rawPath;

    const filePath = resolveWithin(ROOT, urlPath);
    if (!filePath) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not Found');
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  } catch (e) {
    res.writeHead(500);
    res.end('Error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  let lan = '';
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) lan = n.address;
    }
  }
  console.log('==============================================');
  console.log('  尊泓工具箱已启动（本地离线服务）');
  console.log('  本机访问:  http://localhost:' + PORT + '/');
  if (lan) console.log('  手机访问:  http://' + lan + ':' + PORT + '/  （需同一局域网）');
  console.log('  按 Ctrl+C 停止服务');
  console.log('==============================================');
});
