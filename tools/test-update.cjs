/* ============================================================
 * test-update.cjs — electron/update.js 主进程单测
 * 覆盖覆盖安装/版本更新的本机侧核心逻辑：
 *  - compareVersions 语义化比较（进位/段数不同/非法输入）
 *  - decideLaunch 四种启动类型（首启/升级/回滚/常规/未知）
 *  - atomicWrite 原子写（内容正确、无 .tmp 残留）
 *  - IPC 全链路（假 ipcMain/app 注入）：marker 读写、备份写入/读取/
 *    容量上限/裁剪保留 3 份/文件名白名单与路径穿越拒绝
 * update.js 不 require electron（同 system.js 范式），纯 Node 可跑。
 * ============================================================ */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChecker } = require('./_lib.cjs');

const checker = createChecker();
const assert = checker.assert;
const u = require('../electron/update');

/* ---------- compareVersions ---------- */
assert(u.compareVersions('1.3.5', '1.3.6') === -1, 'compareVersions 1.3.5 < 1.3.6');
assert(u.compareVersions('1.10.0', '1.9.9') === 1, 'compareVersions 1.10.0 > 1.9.9（数字段进位比较）');
assert(u.compareVersions('1.3.6', '1.3.6') === 0, 'compareVersions 相等');
assert(u.compareVersions('1.3', '1.3.0') === 0, 'compareVersions 段数不同按 0 补齐');
assert(u.compareVersions('2.0', '1.9.9') === 1, 'compareVersions 主版本进位');
assert(u.compareVersions('abc', '1.0.0') === null, 'compareVersions 非法输入返回 null');
assert(u.compareVersions('', '1.0.0') === null, 'compareVersions 空串返回 null');

/* ---------- decideLaunch ---------- */
const dFirst = u.decideLaunch(null, '1.3.6');
assert(dFirst.kind === 'first', 'decideLaunch 无 marker → first');
const dUp = u.decideLaunch({ lastVersion: '1.3.5' }, '1.3.6');
assert(dUp.kind === 'upgrade' && dUp.from === '1.3.5', 'decideLaunch 旧 marker → upgrade 且带来源版本');
const dBack = u.decideLaunch({ lastVersion: '1.3.6' }, '1.3.5');
assert(dBack.kind === 'rollback' && dBack.from === '1.3.6', 'decideLaunch marker 更新 → rollback');
const dSame = u.decideLaunch({ lastVersion: '1.3.6' }, '1.3.6');
assert(dSame.kind === 'normal', 'decideLaunch 版本相同 → normal');
const dBad = u.decideLaunch({ lastVersion: 'not-a-version' }, '1.3.6');
assert(dBad.kind === 'unknown', 'decideLaunch marker 损坏 → unknown（不崩溃）');

/* ---------- atomicWrite ---------- */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haoyue-update-test-'));
const target = path.join(tmpDir, 'marker.json');
u.atomicWrite(target, '{"a":1}');
assert(fs.readFileSync(target, 'utf8') === '{"a":1}', 'atomicWrite 内容正确');
const leftovers = fs.readdirSync(tmpDir).filter((f) => /\.tmp-/.test(f));
assert(leftovers.length === 0, 'atomicWrite 无 .tmp 残留');
/* 覆盖写（Windows rename 语义验证）：目标已存在时仍原子替换 */
u.atomicWrite(target, '{"a":2}');
assert(fs.readFileSync(target, 'utf8') === '{"a":2}', 'atomicWrite 覆盖已有文件成功');

/* ---------- readMarker / writeMarker：损坏自愈 ---------- */
u.writeMarker(target, '1.3.6');
assert(u.readMarker(target) && u.readMarker(target).lastVersion === '1.3.6', 'marker 写读回环');
fs.writeFileSync(target, '{broken');
assert(u.readMarker(target) === null, 'marker 损坏时 readMarker 返回 null（自愈路径）');

/* ---------- IPC 全链路（假件注入） ---------- */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'haoyue-update-ipc-'));
const handlers = {};
const fakeIpcMain = { handle: (name, fn) => { handlers[name] = fn; } };
const fakeApp = { getPath: () => userData, getVersion: () => '2.0.0' };
const diags = [];
const ctl = u.registerUpdateIpc(fakeIpcMain, fakeApp, (kind, detail) => diags.push({ kind, detail }));

/* 预置旧版 marker → 首扫应识别为升级 */
fs.writeFileSync(path.join(userData, 'version-marker.json'), JSON.stringify({ lastVersion: '1.3.5' }));
const info = ctl.scanOnLaunch();
assert(info.version === '2.0.0' && info.kind === 'upgrade' && info.from === '1.3.5', 'scanOnLaunch 识别升级');
assert(diags.some((d) => d.kind === 'upgrade'), '升级落诊断日志');
assert(u.readMarker(path.join(userData, 'version-marker.json')).lastVersion === '2.0.0', '扫描后 marker 已更新');

/* app:updateInfo 幂等（不重复扫描） */
const info2 = handlers['app:updateInfo']();
assert(info2 === info || (info2.kind === 'upgrade' && info2.version === '2.0.0'), 'app:updateInfo 返回扫描结果');

/* ---- 备份链路 ---- */
const badType = handlers['app:backupData'](null, 'not-a-string');
assert(badType.ok === false, 'backupData 非字符串拒绝');
const badJson = handlers['app:backupData'](null, '{broken');
assert(badJson.ok === false, 'backupData 非法 JSON 拒绝');
const okBak = handlers['app:backupData'](null, JSON.stringify({ spec: 'id1', v: 1 }));
assert(okBak.ok === true, 'backupData 合法数据写入成功');

const read1 = handlers['app:readBackup']();
assert(read1 && read1.file && typeof read1.data === 'string' && read1.version === '2.0.0', 'readBackup 返回最新备份');
assert(JSON.parse(read1.data).spec === 'id1', 'readBackup data 与写入一致');

/* 文件名穿越拒绝：绝对路径 / 相对穿越 / 非法字符 */
const trav1 = handlers['app:deleteBackup'](null, '../evil.json');
assert(trav1.ok === false, 'deleteBackup 相对穿越拒绝');
const trav2 = handlers['app:deleteBackup'](null, 'C:\\evil\\data-123-v1.json');
assert(trav2.ok === false, 'deleteBackup 绝对路径拒绝');
const trav3 = handlers['app:deleteBackup'](null, 'data-abc-def.json');
assert(trav3.ok === false, 'deleteBackup 非白名单文件名拒绝');

/* 连续写 5 份 → 裁剪到保留 3 份，且删的是最旧的 */
for (let i = 0; i < 4; i++) {
  const r = handlers['app:backupData'](null, JSON.stringify({ n: i }));
  assert(r.ok === true, 'backupData 第 ' + (i + 2) + ' 份写入成功');
}
const bakDir = path.join(userData, 'backups');
const remain = fs.readdirSync(bakDir).filter((f) => /^data-\d{13,}-[a-z0-9]{4}-v/.test(f));
assert(remain.length === u.BACKUP_KEEP, '备份裁剪保留 ' + u.BACKUP_KEEP + ' 份（实际 ' + remain.length + '）');
const latest = handlers['app:readBackup']();
assert(latest && JSON.parse(latest.data).n === 3, 'readBackup 取到最新一份');

/* 删除白名单内备份 */
const del = handlers['app:deleteBackup'](null, latest.file);
assert(del.ok === true, 'deleteBackup 白名单内删除成功');
const afterDel = handlers['app:readBackup']();
assert(afterDel && afterDel.file !== latest.file, '删除后 readBackup 回退到次新备份');

/* 同毫秒连续备份：时间戳必须严格递增，否则时间戳并列时
 * 字典序由随机后缀决定，"最新一份"会取错（CI ubuntu 上曾实际失败）。
 * 随机后缀固定为递减值——旧实现下最后写入的反而排最前，可稳定复现 */
const realNow = Date.now;
const realRandom = Math.random;
const fixedNow = realNow() + 10000;
const sameMs = [];
try {
  Date.now = () => fixedNow;
  let seed = 0.9;
  Math.random = () => { const v = seed; seed -= 0.1; return v; };
  for (let i = 0; i < 3; i++) {
    sameMs.push(handlers['app:backupData'](null, JSON.stringify({ sameMs: i })));
  }
} finally {
  Date.now = realNow;
  Math.random = realRandom;
}
const sameMsNames = sameMs.map((r) => r.file);
assert(sameMs.every((r) => r.ok), '同毫秒连续写入 3 份备份成功');
assert(sameMsNames[0] < sameMsNames[1] && sameMsNames[1] < sameMsNames[2],
  '同毫秒备份文件名严格递增（字典序 = 写入序）');
const sameMsLatest = handlers['app:readBackup']();
assert(sameMsLatest && sameMsLatest.file === sameMsNames[2]
  && JSON.parse(sameMsLatest.data).sameMs === 2, '同毫秒备份取到最后写入的一份');

/* 清理临时目录（失败不阻断） */
try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) { /* ignore */ }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

checker.finish();
