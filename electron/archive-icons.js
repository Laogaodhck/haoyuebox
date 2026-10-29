/* ============================================================
 * archive-icons.js — 压缩包图标关联（主进程）
 * 背景：资源管理器对 .7z/.zip 的图标由文件关联（ProgID/DefaultIcon）
 * 决定。没装任何压缩软件的电脑上，本工具箱生成的压缩包会显示白板
 * 图标。本模块按需注册用户级（HKCU，无需管理员）关联，把扩展名指
 * 向随包分发的 7z.dll 内置格式图标（索引 0=7z，1=zip，与 7-Zip 官方
 * 安装器注册值一致）。
 * 安全边界：
 *   - 只写 HKCU\Software\Classes，不碰 HKLM，不需要管理员；
 *   - 该扩展名已有关联（HKCR 有 ProgID 或存在 UserChoice）时绝不
 *     覆盖，只在「完全无关联」时才接管图标；
 *   - 接管前把 HKCU 原默认值备份进标记值，恢复时可精确还原；
 *   - ProgID 不注册打开方式，双击行为不受影响（系统照常弹选择框）。
 * ============================================================ */
'use strict';

const path = require('path');
const { execFile } = require('child_process');

/* 图标索引（7z.dll RT_GROUP_ICON 目录序，与 7-Zip 官方安装器一致） */
const ICON_INDEX = { '7z': 0, zip: 1 };
const FRIENDLY_NAME = { '7z': '7z 压缩包（浩玥工具箱）', zip: 'ZIP 压缩包（浩玥工具箱）' };
const REG_TIMEOUT_MS = 10000;

/* ---------- 纯逻辑（可单测） ---------- */

/* 解析 `reg query ... /ve` 输出中的默认值：取最后一个 REG_SZ 之后的文本。
 * 输出经 GBK 解码；值可能为空（仅键名行无值）。 */
function parseRegDefault(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const pos = lines[i].indexOf('REG_SZ');
    if (pos >= 0) return lines[i].slice(pos + 'REG_SZ'.length).trim();
  }
  return '';
}

/* 决策：某扩展名当前应处的状态（纯函数）
 * ours=已注册本程序 ProgID；hkcrDefault=HKCR 有默认 ProgID；
 * userChoice=用户经系统设置选择了打开方式 */
function decideExt(ours, hkcrDefault, userChoice) {
  if (ours) return 'ours';
  if (userChoice) return 'userchoice';
  if (hkcrDefault) return 'associated';
  return 'available';
}

/* 备份标记编码：空原值 → 'EMPTY'；否则 'b64:' + base64（避免注册表编码问题） */
function encodeBackup(original) {
  return original ? 'b64:' + Buffer.from(original, 'utf8').toString('base64') : 'EMPTY';
}

function decodeBackup(marker) {
  const m = String(marker || '');
  if (m === 'EMPTY') return '';
  if (m.startsWith('b64:')) {
    try { return Buffer.from(m.slice(4), 'base64').toString('utf8'); } catch (e) { return ''; }
  }
  return '';
}

/* DefaultIcon 值：路径含空格时引号包裹路径，索引放引号外 */
function buildIconValue(dllPath, iconIndex) {
  return '"' + dllPath + '",' + iconIndex;
}

/* 7z.dll 定位：打包 resources/bin → 开发 electron/bin → 系统 7-Zip */
function resolveIconDll() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'bin', '7z.dll') : '',
    path.join(__dirname, 'bin', '7z.dll'),
    'C:\\Program Files\\7-Zip\\7z.dll'
  ].filter(Boolean);
  const fs = require('fs');
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* 忽略 */ }
  }
  return '';
}

/* ---------- reg.exe 封装 ----------
 * 系统工具一律用 System32 绝对路径解析，避免 PATH（或当前目录）劫持 */
function sysExe(name) {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name + '.exe');
}

function runReg(args) {
  return new Promise((resolve) => {
    execFile(sysExe('reg'), args, { timeout: REG_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err && err.killed) return resolve({ ok: false, code: -1, out: '', error: 'reg 超时' });
      const code = err && typeof err.code === 'number' ? err.code : 0;
      let out = '';
      try { out = new TextDecoder('gbk').decode(Buffer.concat([Buffer.from(stdout || ''), Buffer.from(stderr || '')])); }
      catch (e) { out = String(stdout || '') + String(stderr || ''); }
      resolve({ ok: !err, code, out });
    });
  });
}

/* IPC 入口白名单：渲染层传入的 exts 先经此过滤，杜绝任意注册表键路径拼接 */
function sanitizeExts(list) {
  const allowed = Object.keys(ICON_INDEX);
  return (Array.isArray(list) ? list : [])
    .map((e) => String(e || '').replace(/^\./, '').toLowerCase())
    .filter((e) => allowed.indexOf(e) >= 0);
}

const keyProgId = (ext) => 'HKCU\\Software\\Classes\\ZunhongArchive.' + ext;
const keyExt = (ext) => 'HKCU\\Software\\Classes\\' + ext;
const keyUserChoice = (ext) => 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\' + ext + '\\UserChoice';

/* 探测：HKCR 合并视图默认 ProgID / UserChoice / 本程序注册状态 / HKCU 备份标记 */
async function probeExt(ext) {
  const [hkcr, uc, ours, backup] = await Promise.all([
    runReg(['query', 'HKCR\\' + ext, '/ve']),
    runReg(['query', keyUserChoice(ext), '/v', 'ProgId']),
    runReg(['query', keyProgId(ext)]),
    runReg(['query', keyProgId(ext), '/v', 'ZunhongBackup'])
  ]);
  return {
    hkcrDefault: hkcr.ok && hkcr.code === 0 ? parseRegDefault(hkcr.out) : '',
    userChoice: uc.ok && uc.code === 0,
    ours: ours.ok && ours.code === 0,
    backup: backup.ok && backup.code === 0 ? parseRegDefault(backup.out) : ''
  };
}

/* 写注册：ProgID 树 + 扩展名指向 + 备份标记 */
async function applyExt(ext, dllPath) {
  const iconIndex = ICON_INDEX[ext.replace(/^\./, '')];
  if (iconIndex === undefined) return { ok: false, error: '不支持的扩展名：' + ext };
  const backupKey = keyExt(ext);
  const before = await runReg(['query', backupKey, '/ve']);
  const original = before.ok && before.code === 0 ? parseRegDefault(before.out) : '';
  const steps = [
    ['add', keyProgId(ext), '/ve', '/d', FRIENDLY_NAME[ext.replace(/^\./, '')], '/f'],
    ['add', keyProgId(ext) + '\\DefaultIcon', '/ve', '/d', buildIconValue(dllPath, iconIndex), '/f'],
    ['add', keyProgId(ext), '/v', 'ZunhongBackup', '/d', encodeBackup(original), '/f'],
    ['add', backupKey, '/ve', '/d', 'ZunhongArchive.' + ext, '/f']
  ];
  for (const args of steps) {
    const r = await runReg(args);
    if (!r.ok || r.code !== 0) return { ok: false, error: 'reg 写入失败（' + args[1] + '）' };
  }
  return { ok: true };
}

/* 恢复：还原扩展名默认值（或删除我们的接管值）+ 删除 ProgID 树 */
async function restoreExt(ext) {
  const st = await probeExt(ext);
  if (!st.ours) return { ok: true, noop: true };
  const original = decodeBackup(st.backup);
  if (original) {
    const r = await runReg(['add', keyExt(ext), '/ve', '/d', original, '/f']);
    if (!r.ok || r.code !== 0) return { ok: false, error: '还原默认值失败（' + ext + '）' };
  } else {
    /* 原本无默认值：只删默认值，保留键内其他数据（如 OpenWithProgids） */
    await runReg(['delete', keyExt(ext), '/ve', '/f']);
  }
  const del = await runReg(['delete', keyProgId(ext), '/f']);
  if (!del.ok || del.code !== 0) return { ok: false, error: '清理 ProgID 失败（' + ext + '）' };
  return { ok: true };
}

/* 图标缓存/关联刷新：ie4uinit -show（Win10/11 官方途径，失败静默——
 * 用户 F5 或重开资源管理器窗口同样生效） */
function refreshShellIcons() {
  return new Promise((resolve) => {
    execFile(sysExe('ie4uinit'), ['-show'], { timeout: 5000, windowsHide: true }, () => resolve());
  });
}

/* ---------- 对外 API（IPC 调用） ---------- */

const EXT_LABEL = { '7z': '.7z（7z 格式）', zip: '.zip（ZIP 格式）' };

async function probe() {
  const dll = resolveIconDll();
  const out = {};
  for (const ext of ['7z', 'zip']) {
    const st = await probeExt(ext);
    const act = decideExt(st.ours, st.hkcrDefault, st.userChoice);
    out[ext] = {
      state: act,
      label: EXT_LABEL[ext],
      hint: act === 'ours' ? '已由本程序注册图标'
        : act === 'userchoice' ? '已有关联（用户指定），不改动'
        : act === 'associated' ? '已有关联（' + (st.hkcrDefault || '其他程序') + '），不改动'
        : '未关联，可注册图标'
    };
  }
  return { ok: true, dllFound: !!dll, dll: dll, exts: out };
}

async function apply(exts) {
  const dll = resolveIconDll();
  if (!dll) return { ok: false, error: '未找到 7z.dll（图标资源）' };
  const list = sanitizeExts(exts);
  if (!list.length) list.push('7z', 'zip');
  const applied = [];
  const skipped = [];
  const errors = [];
  for (const ext of list) {
    const st = await probeExt(ext);
    const act = decideExt(st.ours, st.hkcrDefault, st.userChoice);
    if (act !== 'available') { skipped.push(ext); continue; } /* 二次确认，绝不抢已有关联 */
    const r = await applyExt(ext, dll);
    if (r.ok) applied.push(ext); else errors.push(r.error || ext);
  }
  if (applied.length) refreshShellIcons();
  return { ok: errors.length === 0, applied, skipped, errors };
}

async function restore(exts) {
  const list = sanitizeExts(exts);
  if (!list.length) list.push('7z', 'zip');
  const restored = [];
  const errors = [];
  for (const ext of list) {
    const r = await restoreExt(ext);
    if (r.ok) { if (!r.noop) restored.push(ext); } else errors.push(r.error || ext);
  }
  if (restored.length) refreshShellIcons();
  return { ok: errors.length === 0, restored, errors };
}

module.exports = {
  ICON_INDEX,
  FRIENDLY_NAME,
  parseRegDefault,
  decideExt,
  encodeBackup,
  decodeBackup,
  buildIconValue,
  sanitizeExts,
  resolveIconDll,
  probe,
  apply,
  restore
};
