/* ============================================================
 * 7z-args.js — 7z 命令行参数构建与输出解析（纯逻辑，可单测）
 * 供 main.js（Electron 主进程）与单测共用，不依赖 electron。
 * ============================================================ */
'use strict';

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

/* 构建压缩命令参数
 * opts: { fmt:'7z'|'zip', level:'store'|'fast'|'normal'|'max',
 *         pass:string, encNames:boolean, inputs:string[], outPath:string }
 * 返回参数数组（不经 shell，无注入风险） */
function buildCompressArgs(opts) {
  const fmt = COMPRESS_FMTS[opts.fmt] ? opts.fmt : '7z';
  const mx = COMPRESS_LEVELS[opts.level] !== undefined ? COMPRESS_LEVELS[opts.level] : 5;
  const pass = String(opts.pass || '');
  const args = ['a', '-t' + fmt, '-mx' + mx];
  if (pass) {
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

module.exports = {
  ARCHIVE_EXTS,
  COMPRESS_FMTS,
  COMPRESS_LEVELS,
  extOf,
  isArchiveFile,
  isOkExitCode,
  exitCodeText,
  buildCompressArgs,
  buildExtractArgs,
  parseProgress,
  tailError
};
