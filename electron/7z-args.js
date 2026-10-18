/* ============================================================
 * 7z-args.js — 7z 命令行参数构建与输出解析（纯逻辑，可单测）
 * 供 main.js（Electron 主进程）与单测共用，不依赖 electron。
 * ============================================================ */
'use strict';

const path = require('path');

/* 可解压的常见压缩包扩展名（7z.exe 支持的解码格式） */
const ARCHIVE_EXTS = {
  '7z': 1, zip: 1, rar: 1, tar: 1, gz: 1, tgz: 1, bz2: 1, tbz2: 1,
  xz: 1, txz: 1, cab: 1, iso: 1, jar: 1, lzma: 1, cpio: 1, deb: 1, rpm: 1
};

/* 支持的压缩目标格式 */
const COMPRESS_FMTS = { '7z': 1, zip: 1 };

/* 压缩等级映射：UI 档位 → -mx 值 */
const COMPRESS_LEVELS = { store: 0, fast: 1, normal: 5, max: 9 };

function extOf(name) {
  const dot = String(name || '').lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function isArchiveFile(name) {
  return !!ARCHIVE_EXTS[extOf(name)];
}

/* 判断 7z 退出码是否代表成功（0=无错误；1=警告，如文件被锁定，仍视为可用结果） */
function isOkExitCode(code) {
  return code === 0 || code === 1;
}

/* 7z 退出码 → 中文说明 */
function exitCodeText(code) {
  const M = {
    2: '致命错误',
    3: '校验失败（文件损坏或密码错误）',
    4: '内存不足',
    5: '磁盘空间不足',
    7: '参数错误',
    8: '操作未完成（文件被占用？）',
    255: '用户取消'
  };
  return M[code] || ('未知错误（代码 ' + code + '）');
}

/* 路径归一化键：resolve 消解相对段、统一分隔符、Windows 语义下不区分大小写
 * （本应用仅发 Windows 版；lowercase 对 Linux 极端同名场景可能误报，可接受）。
 * 固定用 path.win32：Windows 上与 path.resolve 等价；非 Windows（CI ubuntu）
 * 也能按 Windows 语义消解 C:\a\.\x 这类相对段，保证测试跨平台一致 */
function normPathKey(p) {
  let s = String(p || '').trim();
  if (!s) return '';
  try { s = path.win32.resolve(s); } catch (e) { /* 保持原样 */ }
  if (/^[a-zA-Z]:/.test(s)) s = s.charAt(0).toLowerCase() + s.slice(1);
  return s.replace(/\\/g, '/').toLowerCase();
}

/* 输出路径是否与任一输入路径相同（compress 删除旧产物前必须检查，
 * 防止「单文件压缩、自动命名与源文件同名」时把源文件当旧产物删掉） */
function hasInputConflict(inputs, outPath) {
  const key = normPathKey(outPath);
  if (!key) return false;
  return (inputs || []).some((p) => normPathKey(p) === key);
}

/* 构建压缩命令参数
 * opts: { fmt:'7z'|'zip', level:'store'|'fast'|'normal'|'max',
 *         volumeMB:number, pass:string, encNames:boolean, inputs:string[], outPath:string }
 * 返回参数数组（不经 shell，无注入风险） */
function buildCompressArgs(opts) {
  const fmt = COMPRESS_FMTS[opts.fmt] ? opts.fmt : '7z';
  const mx = COMPRESS_LEVELS[opts.level] !== undefined ? COMPRESS_LEVELS[opts.level] : 5;
  const pass = String(opts.pass || '');
  const args = ['a', '-t' + fmt, '-mx' + mx];
  /* 分卷：仅 7z 格式支持，-v{N}m（N 为正整数 MB） */
  const vol = Math.round(+opts.volumeMB || 0);
  if (fmt === '7z' && vol > 0) args.push('-v' + vol + 'm');
  if (pass) {
    /* 已知残留风险：-p 密码经命令行传递，本机其他进程可从进程列表读到。
     * 7-Zip 无 stdin 密码通道（列表文件同样不收密码），离线单用户场景
     * 评估为可接受；若未来需求升级可换 7z SFX 或外部加密层。 */
    args.push('-p' + pass);
    if (fmt === 'zip') args.push('-mem=AES256'); // ZIP 用 AES-256 加密内容
  }
  if (fmt === '7z' && pass && opts.encNames) args.push('-mhe=on'); // 仅 7z 支持加密文件名
  args.push('-bsp1', '-bso0'); // 进度 → stdout，关闭文件列表输出
  args.push('--', opts.outPath);
  return args.concat(opts.inputs || []);
}

/* 构建解压命令参数
 * opts: { archive:string, outDir:string, pass:string }
 * -y 自动确认覆盖（避免 7z 等待交互输入挂起） */
function buildExtractArgs(opts) {
  const pass = String(opts.pass || '');
  const args = ['x', '-o' + opts.outDir, '-y', '-bsp1', '-bso0'];
  if (pass) args.push('-p' + pass);
  args.push('--', opts.archive);
  return args;
}

/* 从 7z 进度输出片段解析百分比（0-100），无进度则返回 null
 * -bsp1 行首刷新，形如 " 42% 5 + path/to/file"（\r 同行重写），
 * 取行内首个百分比即可——% 后的数字是文件计数，不能要求其后无数字 */
function parseProgress(chunk) {
  const m = String(chunk).match(/(\d{1,3})%/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 0 && n <= 100 ? n : null;
}

/* 从 stderr/stdout 尾部提取用户可读的错误行（去掉空行与进度残留） */
function tailError(text) {
  const lines = String(text || '').split(/[\r\n]+/)
    .map(s => s.trim())
    .filter(s => s && !/^\d{1,3}%$/.test(s));
  return lines[lines.length - 1] || '';
}

/* 构建内容浏览命令参数：-slt 技术列表（机器可解析），-ba 省略表头，
 * -sccUTF-8 强制输出 UTF-8（否则按控制台代码页 GBK 输出，中文条目会乱码）
 * opts: { archive:string, pass:string } */
function buildListArgs(opts) {
  const args = ['l', '-ba', '-slt', '-sccUTF-8'];
  const pass = String(opts.pass || '');
  if (pass) args.push('-p' + pass);
  args.push('--', opts.archive);
  return args;
}

/* 解析 `l -slt` 技术列表输出 → [{path, size, mtime, isDir}]
 * 每个条目为空行分隔的字段块：Path = / Size = / Modified = / Attributes = D… */
function parseListOutput(text) {
  const entries = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.path) entries.push(cur);
    cur = null;
  };
  String(text || '').split(/[\r\n]+/).forEach((line) => {
    const m = /^(.*?)\s*=\s*(.*)$/.exec(line);
    if (!m) { flush(); return; }
    const key = m[1].trim();
    const val = m[2].trim();
    if (key === 'Path') { flush(); cur = { path: val, size: 0, mtime: '', isDir: false }; }
    else if (!cur) { /* 表头或无 Path 前的字段，忽略 */ }
    else if (key === 'Size') { cur.size = parseInt(val, 10) || 0; }
    else if (key === 'Modified') { cur.mtime = val; }
    else if (key === 'Attributes') { cur.isDir = /\bD/.test(val); }
  });
  flush();
  return entries;
}

module.exports = {
  ARCHIVE_EXTS,
  COMPRESS_FMTS,
  COMPRESS_LEVELS,
  extOf,
  isArchiveFile,
  isOkExitCode,
  exitCodeText,
  normPathKey,
  hasInputConflict,
  buildCompressArgs,
  buildExtractArgs,
  buildListArgs,
  parseListOutput,
  parseProgress,
  tailError
};
