/* ============================================================
 * test-archive.cjs — 压缩工具单测
 * 1) electron/7z-args.js 纯逻辑（参数构建 / 进度解析 / 退出码）
 * 2) js/archive.js 渲染层纯函数（大小格式化 / 默认名 / 去重合并 / 文案）
 * 3) 真实 7z 冒烟：存在 electron/bin/7z.exe 时做 7z/ZIP(加密)/GZ
 *    压缩与解压全链路（临时目录，结束后清理）
 * ============================================================ */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { createChecker } = require('./_lib.cjs');

const t = createChecker();
const ROOT = path.join(__dirname, '..');

/* ---------- 1. 7z-args.js 纯逻辑 ---------- */
const args7z = require(path.join(ROOT, 'electron', '7z-args.js'));

(function test7zArgs() {
  console.log('\n[1] 7z-args.js 纯逻辑');
  const exts = Object.keys(args7z.ARCHIVE_EXTS);
  t.assert(exts.length >= 15, 'ARCHIVE_EXTS 覆盖 ≥15 种扩展名');
  t.assert(exts.includes('7z') && exts.includes('zip') && exts.includes('rar')
    && exts.includes('tar') && exts.includes('gz') && exts.includes('iso'),
    'ARCHIVE_EXTS 含 7z/zip/rar/tar/gz/iso');
  t.assert(args7z.isArchiveFile('相册.ZIP'), 'isArchiveFile 大写扩展名可识别');
  t.assert(args7z.isArchiveFile('data.tar.gz'), 'isArchiveFile 识别 .tar.gz（gz）');
  t.assert(!args7z.isArchiveFile('photo.jpg') && !args7z.isArchiveFile('noext') && !args7z.isArchiveFile(''),
    'isArchiveFile 拒绝非压缩包/无扩展名/空串');
  t.assert(args7z.extOf('a.RAR') === 'rar' && args7z.extOf('noext') === '', 'extOf 小写化与空串处理');
  t.assert(args7z.isOkExitCode(0) && args7z.isOkExitCode(1) && !args7z.isOkExitCode(2) && !args7z.isOkExitCode(255),
    'isOkExitCode 0/1 成功，其余失败');
  t.assert(/校验/.test(args7z.exitCodeText(3)), 'exitCodeText 3 提示校验/密码');
  t.assert(/未知/.test(args7z.exitCodeText(99)), 'exitCodeText 未知代码有兜底文案');

  /* 压缩参数 */
  const out = 'C:\\tmp\\打包.7z';
  const ins = ['C:\\a\\照片.jpg', 'C:\\a\\文件夹'];
  let a = args7z.buildCompressArgs({ fmt: '7z', level: 'normal', inputs: ins, outPath: out });
  t.assert(a[0] === 'a' && a[1] === '-t7z' && a[2] === '-mx5', '默认参数：a -t7z -mx5（normal→5）');
  t.assert(!a.some(s => /^-p/.test(s)), '无密码时不带 -p');
  t.assert(!a.some(s => /^-mhe/.test(s)), '无密码时不带 -mhe');
  t.assert(a.includes('-bsp1') && a.includes('-bso0'), '进度走 stdout（-bsp1 -bso0）');
  const dd = a.indexOf('--');
  t.assert(dd > 0 && a[dd + 1] === out && a.slice(dd + 2).join('|') === ins.join('|'),
    '「--」后先输出路径再接输入列表');
  t.assert(args7z.buildCompressArgs({ fmt: 'rar', level: 'normal', inputs: [], outPath: out })[1] === '-t7z',
    '非法格式回退 7z');
  t.assert(args7z.buildCompressArgs({ fmt: '7z', level: 'ultra', inputs: [], outPath: out })[2] === '-mx5',
    '非法等级回退标准');
  t.assert(args7z.buildCompressArgs({ fmt: '7z', level: 'max', inputs: [], outPath: out })[2] === '-mx9'
    && args7z.buildCompressArgs({ fmt: '7z', level: 'store', inputs: [], outPath: out })[2] === '-mx0'
    && args7z.buildCompressArgs({ fmt: '7z', level: 'fast', inputs: [], outPath: out })[2] === '-mx1',
    'max/store/fast 等级映射正确');

  a = args7z.buildCompressArgs({ fmt: '7z', level: 'normal', pass: 'abc123', encNames: true, inputs: ins, outPath: out });
  t.assert(a.includes('-pabc123') && a.includes('-mhe=on'), '7z+密码+加密文件名：-p 与 -mhe=on');
  a = args7z.buildCompressArgs({ fmt: '7z', level: 'normal', pass: 'abc123', encNames: false, inputs: ins, outPath: out });
  t.assert(a.includes('-pabc123') && !a.includes('-mhe=on'), '7z+密码不加密文件名：仅 -p');
  a = args7z.buildCompressArgs({ fmt: 'zip', level: 'fast', pass: 'abc123', encNames: true, inputs: ins, outPath: out });
  t.assert(a.includes('-pabc123') && a.includes('-mem=AES256') && !a.includes('-mhe=on'),
    'ZIP+密码：-mem=AES256 且不加 -mhe');
  a = args7z.buildCompressArgs({ fmt: 'zip', level: 'fast', inputs: ins, outPath: out });
  t.assert(!a.some(s => /^-p|-mem/.test(s)), 'ZIP 无密码：无 -p / -mem');

  /* 解压参数 */
  let e = args7z.buildExtractArgs({ archive: 'C:\\x\\a.7z', outDir: 'C:\\x\\out', pass: '' });
  t.assert(e[0] === 'x' && e[1] === '-oC:\\x\\out' && e[2] === '-y', '解压参数：x -o<dir> -y（自动覆盖防挂起）');
  t.assert(!e.some(s => /^-p/.test(s)), '解压无密码不带 -p');
  e = args7z.buildExtractArgs({ archive: 'C:\\x\\a.7z', outDir: 'C:\\x\\out', pass: 'p@ss w' });
  t.assert(e.includes('-pp@ss w'), '解压密码原样作为单参数（免 shell 注入）');

  /* 进度与错误解析 */
  t.assert(args7z.parseProgress(' 42% 5 + path/to/file') === 42, 'parseProgress 解析 42%');
  t.assert(args7z.parseProgress('  7%\r') === 7, 'parseProgress 兼容 \\r 刷新行');
  t.assert(args7z.parseProgress('100%') === 100, 'parseProgress 100%');
  t.assert(args7z.parseProgress('一切正常输出') === null && args7z.parseProgress('123%') === null,
    'parseProgress 无进度/超界返回 null');
  t.assert(args7z.tailError(' 42%\r\n\r\nERROR: 错误的密码\r\n') === 'ERROR: 错误的密码',
    'tailError 取末行有效错误并忽略进度行');
  t.assert(args7z.tailError('') === '' && args7z.tailError(' 42%') === '', 'tailError 空输入/纯进度返回空');
})();

/* ---------- 2. js/archive.js 渲染层纯函数 ---------- */
global.window = { App: {} };
require(path.join(ROOT, 'js', 'archive.js'));
const at = global.window.App.archive;

(function testRendererHelpers() {
  console.log('\n[2] js/archive.js 渲染层纯函数');
  t.assert(!!at && typeof at.init === 'function' && typeof at.enter === 'function'
    && typeof at.showOnly === 'function' && !!at._test, 'App.archive 导出 init/enter/showOnly/_test');

  const T = at._test;
  t.assert(T.isArchiveName('a.7z') && T.isArchiveName('B.ZIP') && T.isArchiveName('c.rar')
    && !T.isArchiveName('d.exe') && !T.isArchiveName('noext') && !T.isArchiveName(''),
    'isArchiveName 与主进程扩展名表一致');
  t.assert(Object.keys(T.ARCHIVE_EXTS).length === Object.keys(args7z.ARCHIVE_EXTS).length,
    '渲染层与主进程扩展名表条目数一致');

  t.assert(T.fmtSize(0) === '0 B' && T.fmtSize(512) === '512 B', 'fmtSize 字节档');
  t.assert(T.fmtSize(2048) === '2 KB' && T.fmtSize(5 * 1024 * 1024) === '5 MB'
    && T.fmtSize(3.5 * 1024 * 1024 * 1024) === '3.5 GB', 'fmtSize KB/MB/GB 换算');
  t.assert(T.fmtSize(null) === '—' && T.fmtSize(-5) === '—' && T.fmtSize(undefined) === '—', 'fmtSize 非法值兜底');

  t.assert(T.typeLabel({ isDir: true }) === '文件夹', 'typeLabel 文件夹');
  t.assert(T.typeLabel({ name: '照片.jpg' }) === 'JPG 文件', 'typeLabel 大写扩展名');
  t.assert(T.typeLabel({ name: 'README' }) === '文件', 'typeLabel 无扩展名兜底');

  const one = [{ path: 'C:\\a\\照片.jpg', name: '照片.jpg', isDir: false, size: 10 }];
  t.assert(T.defaultArchiveName(one, '7z') === '照片.7z'
    && T.defaultArchiveName(one, 'zip') === '照片.zip', '默认名：单文件沿用其名称');
  const dirOne = [{ path: 'C:\\a\\旅行', name: '旅行', isDir: true, size: 0 }];
  t.assert(T.defaultArchiveName(dirOne, '7z') === '旅行.7z', '默认名：单文件夹沿用名称');
  t.assert(T.defaultArchiveName(one.concat(dirOne), '7z') === '压缩包.7z'
    && T.defaultArchiveName([], 'zip') === '压缩包.zip', '默认名：多项/空列表用「压缩包」');
  t.assert(T.defaultArchiveName([{ path: 'C:\\a\\data', name: 'data', isDir: true }], '7z') === 'data.7z',
    '默认名：无扩展名名称直接拼接');

  const merged = T.mergeItems(
    [{ path: 'C:\\a\\1.jpg', name: '1.jpg' }],
    [{ path: 'C:\\a\\1.jpg', name: '1.jpg' }, { path: 'C:\\a\\2.jpg', name: '2.jpg' }, null, { name: '无路径' }]
  );
  t.assert(merged.length === 2 && merged[1].path === 'C:\\a\\2.jpg', 'mergeItems 按 path 去重、跳过无效项');

  t.assert(T.countText([]) === '未选择', 'countText 空列表');
  const ct = T.countText([
    { path: 'C:\\a\\1.jpg', name: '1.jpg', isDir: false, size: 1024, checked: true },
    { path: 'C:\\a\\d', name: 'd', isDir: true, size: 0, checked: true },
    { path: 'C:\\a\\2.jpg', name: '2.jpg', isDir: false, size: 2048, checked: true }
  ]);
  t.assert(/共 3 项/.test(ct) && /已勾选 3 项/.test(ct) && /3 KB/.test(ct), 'countText 计数并累加文件大小（文件夹不计）');
  t.assert(T.isChecked({ checked: true }) && T.isChecked({}) && T.isChecked({ checked: false }) === false,
    'isChecked 缺省视为勾选、显式取消为未勾选');
  const cu = T.countText([
    { path: 'C:\\a\\1.jpg', name: '1.jpg', isDir: false, size: 1024, checked: false },
    { path: 'C:\\a\\d', name: 'd', isDir: true, size: 0, checked: true }
  ]);
  t.assert(/共 2 项/.test(cu) && /已勾选 1 项/.test(cu) && !/KB/.test(cu),
    'countText 仅统计勾选项（全为文件夹时无体积）');
  t.assert(T.countText([{ path: 'C:\\a\\1.jpg', name: '1.jpg', checked: false }, { path: 'C:\\b', name: 'b', checked: false }])
    .indexOf('未勾选') >= 0, 'countText 全部取消勾选提示');
  const m2 = T.mergeItems([], [{ path: 'C:\\a\\1.jpg', name: '1.jpg' }]);
  t.assert(m2[0].checked === true, 'mergeItems 新项默认勾选');

  t.assert(T.extractTargetText('photos.zip', 'sub') === 'photos/'
    && T.extractTargetText('photos.zip', 'same') === '压缩包所在目录', 'extractTargetText 两种模式');
  t.assert(T.extractTargetText('data', 'sub') === 'data/', 'extractTargetText 无扩展名兜底');

  t.assert(T.compressProgressText(45) === '压缩中… 45%', 'compressProgressText');
  t.assert(T.extractProgressText({ index: 1, total: 5, name: 'x.zip', pct: 30 }) === '解压中（2/5）：x.zip — 30%',
    'extractProgressText 带序号与文件名');

  /* 「压缩到」输出路径解析 */
  t.assert(T.parentDir('C:\\f\\照片1.jpg') === 'C:\\f', 'parentDir 文件 → 父目录');
  t.assert(T.parentDir('C:\\f\\旅行') === 'C:\\f', 'parentDir 文件夹 → 父目录');
  t.assert(T.parentDir('C:\\f\\旅行\\') === 'C:\\f', 'parentDir 去尾部斜杠');
  t.assert(T.parentDir('C:\\') === 'C:', 'parentDir 根目录兜底');
  t.assert(T.parentDir('') === '', 'parentDir 空串');
  const two = [{ path: 'C:\\f\\照片2.png', name: '照片2.png' }, { path: 'C:\\f\\旅行', name: '旅行' }];
  t.assert(T.resolveOutPath('same', two, '7z') === 'C:\\f\\压缩包.7z', 'resolveOutPath 源目录+自动命名');
  t.assert(T.resolveOutPath('same', one, 'zip') === 'C:\\a\\照片.zip', 'resolveOutPath 单项沿用名称与父目录');
  t.assert(T.resolveOutPath('dialog', two, '7z') === '', 'resolveOutPath dialog 模式走另存为');
})();

/* ---------- 3. 真实 7z 冒烟（压缩 → 解压全链路） ---------- */
const EXE = path.join(ROOT, 'electron', 'bin', '7z.exe');

function run7z(args) {
  return new Promise((resolve) => {
    const child = spawn(EXE, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let code = -1;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, out, err: String(e.message || e) }));
    child.on('close', (c) => { code = c; resolve({ code, out, err }); });
  });
}

(async function testReal7z() {
  if (!fs.existsSync(EXE)) {
    console.log('\n[3] 跳过真实 7z 冒烟（未找到 electron/bin/7z.exe）');
    t.finish();
    return;
  }
  console.log('\n[3] 真实 7z 冒烟');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haoyue-7z-'));
  try {
    const hello = path.join(tmp, '你好.txt');
    const bin = path.join(tmp, 'bin.dat');
    fs.writeFileSync(hello, '浩玥工具箱 7z 冒烟测试 ✓', 'utf8');
    fs.writeFileSync(bin, Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251)));

    /* 7z 压缩 → 解压 */
    const arc7z = path.join(tmp, '打包.7z');
    let r = await run7z(args7z.buildCompressArgs({ fmt: '7z', level: 'normal', inputs: [hello, bin], outPath: arc7z }));
    t.assert(args7z.isOkExitCode(r.code), '真实 7z：压缩 7z 成功（退出码 ' + r.code + '）');
    t.assert(fs.existsSync(arc7z) && fs.statSync(arc7z).size > 0, '真实 7z：压缩包已生成且非空');

    const exDir = path.join(tmp, 'out7z');
    r = await run7z(args7z.buildExtractArgs({ archive: arc7z, outDir: exDir, pass: '' }));
    t.assert(args7z.isOkExitCode(r.code), '真实 7z：解压 7z 成功');
    t.assert(fs.readFileSync(path.join(exDir, '你好.txt'), 'utf8') === '浩玥工具箱 7z 冒烟测试 ✓',
      '真实 7z：中文文件名与内容解压一致');

    /* ZIP 加密压缩 → 无密码解压失败 → 带密码解压成功 */
    const arcZip = path.join(tmp, '秘密.zip');
    r = await run7z(args7z.buildCompressArgs({ fmt: 'zip', level: 'fast', pass: 'abc123', inputs: [hello], outPath: arcZip }));
    t.assert(args7z.isOkExitCode(r.code), '真实 ZIP：AES-256 加密压缩成功');
    const exNoPass = path.join(tmp, 'out-nopass');
    r = await run7z(args7z.buildExtractArgs({ archive: arcZip, outDir: exNoPass, pass: '' }));
    t.assert(!args7z.isOkExitCode(r.code), '真实 ZIP：无密码解压加密包失败（退出码 ' + r.code + '）');
    t.assert(args7z.tailError(r.err) || args7z.tailError(r.out), '真实 ZIP：失败时能提取错误文案');
    const exZip = path.join(tmp, 'out-zip');
    r = await run7z(args7z.buildExtractArgs({ archive: arcZip, outDir: exZip, pass: 'abc123' }));
    t.assert(args7z.isOkExitCode(r.code)
      && fs.readFileSync(path.join(exZip, '你好.txt'), 'utf8') === '浩玥工具箱 7z 冒烟测试 ✓',
      '真实 ZIP：带密码解压且内容一致');

    /* 错误密码 → 校验失败（退出码 2 或 3） */
    const exBad = path.join(tmp, 'out-bad');
    r = await run7z(args7z.buildExtractArgs({ archive: arcZip, outDir: exBad, pass: 'wrong' }));
    t.assert(!args7z.isOkExitCode(r.code) && /校验|密码|Wrong|ERROR/i.test(args7z.tailError(r.err) || args7z.exitCodeText(r.code)),
      '真实 ZIP：错误密码报校验/密码错误');

    /* GZ 压缩 → 解压（非 7z/ZIP 格式链路） */
    const arcGz = path.join(tmp, '你好.txt.gz');
    r = await run7z(['a', '-tgzip', '-bsp1', '-bso0', '--', arcGz, hello]);

    t.assert(args7z.isOkExitCode(r.code), '真实 GZ：gzip 压缩成功');
    const exGz = path.join(tmp, 'out-gz');
    r = await run7z(args7z.buildExtractArgs({ archive: arcGz, outDir: exGz, pass: '' }));
    t.assert(args7z.isOkExitCode(r.code)
      && fs.readFileSync(path.join(exGz, '你好.txt'), 'utf8') === '浩玥工具箱 7z 冒烟测试 ✓',
      '真实 GZ：gzip 解压且内容一致');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
  t.finish();
})();
