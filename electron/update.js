/* ============================================================
 * update.js — 版本检测 / 升级标记 / 数据备份（主进程模块）
 * 纯本地离线应用：无自动更新服务器，「更新」= 用户用新 Setup 覆盖安装。
 * 本模块负责更新前后应用自身能做的事：
 *  1. 启动时比对 version-marker（userData/version-marker.json，原子写），
 *     识别 升级 / 版本回滚（更新失败退回旧版）/ 常规 / 首启，落诊断日志；
 *  2. 渲染层可把关键设置快照备份到 userData/backups（保留最近 3 份），
 *     设置迁移前/升级首启各备份一次；数据丢失时可经确认恢复；
 *  3. 全部落盘走原子写（tmp + rename）：安装中断/断电不留半截 JSON，
 *     marker 损坏时按无标记自愈（视作首启重写）。
 * 纯函数（compareVersions / decideLaunch / atomicWrite）独立导出，
 * 可在纯 Node 环境单测（同 system.js 范式，不 require electron）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

/* 备份保留份数与单份上限（设置类 JSON 远小于此，防异常 payload 撑爆磁盘） */
const BACKUP_KEEP = 3;
const BACKUP_MAX_BYTES = 2 * 1024 * 1024;

/* ---------- 纯函数（可单测） ---------- */

/* '1.10.0' → [1,10,0]；非数字段/空串 → null */
function parseVersion(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const parts = v.trim().split('.');
  if (!parts.length || parts.length > 6) return null;
  const nums = [];
  for (let i = 0; i < parts.length; i++) {
    if (!/^\d+$/.test(parts[i])) return null;
    nums.push(parseInt(parts[i], 10));
  }
  return nums;
}

/* 语义化版本比较：a<b → -1，a>b → 1，相等（含段数不同按 0 补齐）→ 0；
 * 任一不可解析 → null（调用方按未知处理，绝不该崩溃） */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const x = va[i] || 0;
    const y = vb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/* 依据上次运行记录的版本标记判定本次启动类型。
 * marker：{ lastVersion } 或 null（无标记/损坏）。 */
function decideLaunch(marker, version) {
  if (!marker || !marker.lastVersion) return { kind: 'first', from: '' };
  const c = compareVersions(marker.lastVersion, version);
  if (c === null) return { kind: 'unknown', from: marker.lastVersion };
  if (c > 0) return { kind: 'rollback', from: marker.lastVersion };
  if (c < 0) return { kind: 'upgrade', from: marker.lastVersion };
  return { kind: 'normal', from: '' };
}

/* 原子写：先写同目录临时文件再 rename 覆盖。
 * 中断（断电/杀进程）最坏留下 .tmp 残片，目标文件要么旧要么新，绝无半截。 */
function atomicWrite(file, data) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* 尽力清理 */ }
    throw e;
  }
}

/* 读版本标记：损坏/不可读一律返回 null（自愈路径——scanOnLaunch 会重写） */
function readMarker(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (obj && typeof obj === 'object' && typeof obj.lastVersion === 'string') return obj;
  } catch (e) { /* 无标记或损坏 */ }
  return null;
}

function writeMarker(file, version) {
  atomicWrite(file, JSON.stringify({
    lastVersion: String(version),
    lastLaunchAt: new Date().toISOString()
  }));
}

/* ---------- 备份文件名与校验 ---------- */
const BACKUP_NAME_RE = /^data-\d{13,}-[a-z0-9]{4}-v[\w.]*\.json$/i;

/* 备份文件名：毫秒时间戳 + 4 位随机后缀（同毫秒多次备份不互相覆盖）
 * + 版本号。字典序 = 时间序（时间戳定宽），latestBackup 直接取排序末位 */
function backupName(version) {
  let rand = '';
  while (rand.length < 4) rand += Math.random().toString(36).replace(/[^a-z0-9]/g, '');
  return 'data-' + Date.now() + '-' + rand.slice(0, 4) + '-v' + String(version).replace(/[^\w.]/g, '') + '.json';
}

/* 备份目录内按文件名取最新（时间戳定宽，字典序=时间序） */
function latestBackup(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => BACKUP_NAME_RE.test(f)).sort();
  } catch (e) {
    return null;
  }
  return files.length ? files[files.length - 1] : null;
}

/* 只保留最近 BACKUP_KEEP 份，旧的静默清理 */
function pruneBackups(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => BACKUP_NAME_RE.test(f)).sort();
  } catch (e) {
    return;
  }
  while (files.length > BACKUP_KEEP) {
    try { fs.unlinkSync(path.join(dir, files.shift())); } catch (e) { break; }
  }
}

/* ---------- IPC 注册与启动扫描 ---------- */

/* diag: function(kind, detail) — 诊断日志（main.js 的 appendDiag）。
 * 返回 { scanOnLaunch }，主进程在 whenReady 后调用一次。 */
function registerUpdateIpc(ipcMain, app, diag) {
  const markerFile = () => path.join(app.getPath('userData'), 'version-marker.json');
  const backupDir = () => path.join(app.getPath('userData'), 'backups');
  let launchInfo = null;

  function scanOnLaunch() {
    const version = app.getVersion();
    const d = decideLaunch(readMarker(markerFile()), version);
    try {
      writeMarker(markerFile(), version);
    } catch (e) {
      diag('update-marker-failed', (e && e.message) || String(e));
    }
    if (d.kind === 'upgrade') diag('upgrade', 'v' + d.from + ' → v' + version);
    if (d.kind === 'rollback') diag('rollback', '检测到版本回滚 v' + d.from + ' → v' + version + '（更新失败退回旧版或降级安装）');
    launchInfo = { version: version, kind: d.kind, from: d.from || '' };
    return launchInfo;
  }

  /* 当前版本与升级/回滚信息（渲染层版本行显示与升级备份的依据） */
  ipcMain.handle('app:updateInfo', () => launchInfo || scanOnLaunch());

  /* 数据备份：raw 为渲染层设置 JSON 原文。校验 JSON 合法 + 大小上限后
   * 原子写入 backups/，保留最近 3 份。失败只返回错误，绝不抛出。 */
  ipcMain.handle('app:backupData', (e, raw) => {
    try {
      if (typeof raw !== 'string' || !raw || raw.length > BACKUP_MAX_BYTES) {
        return { ok: false, error: '无效的备份数据' };
      }
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e2) { /* 非法 JSON */ }
      if (!parsed || typeof parsed !== 'object') return { ok: false, error: '无效的备份数据' };
      const info = launchInfo || scanOnLaunch();
      fs.mkdirSync(backupDir(), { recursive: true });
      const name = backupName(info.version);
      const payload = JSON.stringify({
        app: 'haoyue-idphoto',
        kind: 'data-backup',
        version: info.version,
        savedAt: new Date().toISOString(),
        data: raw
      });
      atomicWrite(path.join(backupDir(), name), payload);
      pruneBackups(backupDir());
      return { ok: true, file: name };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  /* 读最近一份备份（无备份/损坏 → null，由渲染层走无备份路径） */
  ipcMain.handle('app:readBackup', () => {
    try {
      const name = latestBackup(backupDir());
      if (!name) return null;
      const obj = JSON.parse(fs.readFileSync(path.join(backupDir(), name), 'utf8'));
      if (!obj || obj.kind !== 'data-backup' || typeof obj.data !== 'string') return null;
      return { file: name, version: obj.version || '', savedAt: obj.savedAt || '', data: obj.data };
    } catch (e) {
      return null;
    }
  });

  /* 删除指定备份（用户拒绝恢复即放弃该备份）。文件名白名单校验 +
   * 强制落在备份目录内（防路径穿越删除任意文件）。 */
  ipcMain.handle('app:deleteBackup', (e, name) => {
    try {
      if (typeof name !== 'string' || !BACKUP_NAME_RE.test(name)) {
        return { ok: false, error: '无效的备份文件名' };
      }
      const dir = backupDir();
      const target = path.join(dir, name);
      if (path.dirname(target) !== dir) return { ok: false, error: '无效的备份文件名' };
      fs.unlinkSync(target);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  return { scanOnLaunch: scanOnLaunch };
}

module.exports = {
  BACKUP_KEEP: BACKUP_KEEP,
  parseVersion: parseVersion,
  compareVersions: compareVersions,
  decideLaunch: decideLaunch,
  atomicWrite: atomicWrite,
  readMarker: readMarker,
  writeMarker: writeMarker,
  registerUpdateIpc: registerUpdateIpc
};
