/* ============================================================
 * static-server.js — 内置静态服务（Electron 主进程用）
 * 随机端口监听 127.0.0.1，服务于应用根目录（asar 内文件可直接读）。
 *
 * 防护（2026-10-17 加固）：
 *   1) 仅放行 GET/HEAD；
 *   2) Host 白名单（回环地址），防 DNS rebinding / 本地网页跨源读文件；
 *   3) 路径解析归一化后必须位于 root 之内——比较 root + 分隔符，
 *      杜绝 /root2-xxx 这类同前缀兄弟目录被误放行（旧版 startsWith(root)
 *      的前缀碰撞缺陷）；
 *   4) 畸形百分号编码与 NUL 字节直接 400。
 * ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

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

/* 回环 Host 白名单（忽略端口） */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function hostAllowed(rawHost, allowedSet) {
  if (!rawHost) return true;              // HTTP/1.0 老客户端无 Host 头，交由回环绑定兜底
  let hostname = String(rawHost).trim().toLowerCase();
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(hostname);   // IPv6 字面量 [::1]:port
  if (m) hostname = m[1];
  else hostname = hostname.split(':')[0];
  return allowedSet.has(hostname);
}

/* 路径守卫：解码并归一化后必须落在 root 之内。
   返回归一化绝对路径；越界（含同前缀兄弟目录）返回 null。 */
function resolveWithin(root, urlPath) {
  if (typeof urlPath !== 'string' || urlPath.indexOf('\0') >= 0) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (e) {
    return null;                          // 畸形百分号编码
  }
  if (decoded.indexOf('\0') >= 0) return null;
  const rootNorm = path.resolve(root);
  let filePath = path.normalize(path.join(rootNorm, decoded));
  /* Windows 上 normalize 会保留尾部分隔符：根目录自身（/）归一化后多一个 sep，先修平 */
  if (filePath !== rootNorm && filePath.endsWith(path.sep)) filePath = filePath.slice(0, -1);
  if (filePath !== rootNorm && !filePath.startsWith(rootNorm + path.sep)) return null;
  return filePath;
}

function createStaticServer(root, memoryPages) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { 'Allow': 'GET, HEAD' });
          return res.end('Method Not Allowed');
        }
        if (!hostAllowed(req.headers.host, LOOPBACK_HOSTS)) {
          res.writeHead(403);
          return res.end('Forbidden');
        }
        const rawPath = req.url.split('?')[0];
        let urlPath = rawPath === '/' ? '/index.html' : rawPath;
        /* 内存路由优先（如打印页）：免磁盘、无 data: URL 2MB 长度限制 */
        if (memoryPages && memoryPages.has(urlPath)) {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
          });
          return res.end(memoryPages.get(urlPath));
        }
        const filePath = resolveWithin(root, urlPath);
        if (!filePath) {
          res.writeHead(403);
          return res.end('Forbidden');
        }
        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404);
            return res.end('Not Found');
          }
          res.writeHead(200, {
            'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
          });
          res.end(req.method === 'HEAD' ? undefined : data);
        });
      } catch (e) {
        res.writeHead(500);
        res.end('Error');
      }
    });

    server.on('error', reject);
    // 随机可用端口，仅监听本机回环
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
}

module.exports = { createStaticServer, resolveWithin, hostAllowed };
