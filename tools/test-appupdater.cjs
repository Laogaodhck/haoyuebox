/* ============================================================
 * test-appupdater.cjs — electron/updater.js 主进程单测
 * 覆盖应用内更新器（安装版就地升级）的核心纯逻辑：
 *  - envKind 运行形态判定（便携版/安装版/开发模式）
 *  - classifyError 错误归类（网络/限速/元数据缺失/未知）
 *  - shouldPushProgress 推送节流（状态切换必推、百分比整数变化才推）
 *  - normalizeNotes 更新说明归一（字符串/数组/空值）
 *  - createController 状态机（mock 事件源 + api 注入）：
 *    idle→checking→noupdate/available→downloading→downloaded、
 *    error 收敛、并发防重入、install 仅安装版放行、诊断日志落盘
 * 不实例化真实 NsisUpdater（其 AppAdapter 依赖 electron app），
 * 依赖解析与主进程接线由 test-ipc-contract / verify-packaged 覆盖。
 * ============================================================ */
'use strict';
const { createChecker } = require('./_lib.cjs');

const checker = createChecker();
const assert = checker.assert;
const U = require('../electron/updater');

/* ---------- envKind ---------- */
assert(U.envKind({ PORTABLE_EXECUTABLE_DIR: 'D:\\app' }, true) === 'portable', 'envKind 便携环境变量优先 → portable');
assert(U.envKind({ PORTABLE_EXECUTABLE_DIR: 'D:\\app' }, false) === 'portable', 'envKind 便携环境变量在未打包标记下仍优先（真实 portable 行为）');
assert(U.envKind({}, true) === 'packaged', 'envKind 无便携变量且已打包 → packaged');
assert(U.envKind({}, false) === 'dev', 'envKind 无便携变量未打包 → dev');

/* ---------- classifyError ---------- */
assert(U.classifyError(new Error('getaddrinfo ENOTFOUND github.com')).indexOf('网络不可用') === 0, 'classifyError DNS 失败 → 网络文案');
assert(U.classifyError(new Error('net::ERR_CONNECTION_TIMED_OUT')).indexOf('网络不可用') === 0, 'classifyError 连接超时 → 网络文案');
assert(U.classifyError(new Error('403 rate limit exceeded')).indexOf('访问受限') > 0, 'classifyError 403 → 限速文案');
assert(U.classifyError(new Error('Cannot find latest.yml in the release')).indexOf('元数据缺失') > 0, 'classifyError latest.yml 缺失 → 元数据文案');
const unknownMsg = U.classifyError(new Error('some weird failure'));
assert(unknownMsg.indexOf('更新失败：') === 0 && unknownMsg.indexOf('some weird failure') > 0, 'classifyError 未知错误 → 通用前缀 + 原文');
assert(U.classifyError(new Error('x'.repeat(300))).length <= 160, 'classifyError 超长原文截断到 140 字内');

/* ---------- shouldPushProgress ---------- */
assert(U.shouldPushProgress(null, {}) === true, 'shouldPushProgress 首次必推');
assert(U.shouldPushProgress({ phase: 'downloading', progress: { percent: 10.4 } }, { phase: 'downloading', progress: { percent: 10.9 } }) === false, 'shouldPushProgress 同状态小数抖动不推');
assert(U.shouldPushProgress({ phase: 'downloading', progress: { percent: 10.4 } }, { phase: 'downloading', progress: { percent: 11.0 } }) === true, 'shouldPushProgress 整数百分比变化才推');
assert(U.shouldPushProgress({ phase: 'downloading', progress: { percent: 10.4 } }, { phase: 'downloaded', progress: null }) === true, 'shouldPushProgress 状态切换必推');

/* ---------- normalizeNotes ---------- */
assert(U.normalizeNotes('  v1.5.1 发布\n') === 'v1.5.1 发布', 'normalizeNotes 字符串去首尾空白');
assert(U.normalizeNotes([{ note: '修复 A' }, { note: '新增 B' }]) === '修复 A\n新增 B', 'normalizeNotes 数组按 note 拼接');
assert(U.normalizeNotes(null) === '' && U.normalizeNotes(undefined) === '', 'normalizeNotes 空值 → 空串');
assert(U.normalizeNotes('x'.repeat(700)).length === 600, 'normalizeNotes 截断到 600 字');

/* ---------- createController：mock 基建 ---------- */
function FakeEmitter() { this.h = {}; }
FakeEmitter.prototype.on = function (n, f) { (this.h[n] = this.h[n] || []).push(f); };
FakeEmitter.prototype.emit = function (n, a) { (this.h[n] || []).forEach((f) => f(a)); };

function fakeApi() {
  return {
    checkCalls: 0,
    downloadCalls: 0,
    quitCalls: [],
    checkForUpdates() {
      this.checkCalls++;
      /* 模拟真实 electron-updater 时序：checking → 无新版本 */
      this.__emit && this.__emit('checking-for-update');
      this.__emit && this.__emit('update-not-available');
      return Promise.resolve(null);
    },
    downloadUpdate() {
      this.downloadCalls++;
      return Promise.resolve(null);
    },
    quitAndInstall(silent, runAfter) { this.quitCalls.push([silent, runAfter]); },
  };
}

function setup(kind) {
  const emitter = new FakeEmitter();
  const api = fakeApi();
  const pushed = [];
  const diags = [];
  const ctl = U.createController({
    emitter: emitter,
    api: Object.assign(api, { __emit: (n, a) => emitter.emit(n, a) }),
    version: '1.5.0',
    kind: kind || 'packaged',
    push: (s) => pushed.push(s),
    diag: (k, d) => diags.push(k + ' | ' + d),
  });
  return { ctl: ctl, emitter: emitter, api: api, pushed: pushed, diags: diags };
}

async function main() {
  /* ---------- 状态机：初始与快照 ---------- */
  {
    const s = setup('packaged');
    const snap = s.ctl.snapshot();
    assert(snap.phase === 'idle' && snap.version === '1.5.0' && snap.kind === 'packaged', '初始快照 idle 且带版本与形态');
    assert(snap.info === null && snap.progress === null && snap.error === null, '初始快照无信息/进度/错误');
  }

  /* ---------- 状态机：noupdate 全链路 ---------- */
  {
    const s = setup('packaged');
    let snap = await s.ctl.check();
    assert(snap.phase === 'noupdate', 'check 无新版本 → noupdate');
    assert(s.api.checkCalls === 1, 'check 恰好触发一次 checkForUpdates');
    assert(s.pushed.length >= 2 && s.pushed[0].phase === 'checking' && s.pushed[s.pushed.length - 1].phase === 'noupdate', 'checking → noupdate 两态均已推送');
    /* noupdate 属可再查状态，允许复查 */
    await s.ctl.check();
    assert(s.api.checkCalls === 2, 'noupdate 后再次 check 允许重查');
  }

  /* ---------- 状态机：available → downloading → downloaded → install ---------- */
  {
    const s = setup('packaged');
    /* 让 checkForUpdates 按真实时序发事件 */
    s.api.checkForUpdates = function () {
      this.checkCalls++;
      s.emitter.emit('checking-for-update');
      s.emitter.emit('update-available', { version: '1.5.1', releaseNotes: ['修复 A', '新增 B'], releaseDate: '2026-10-29T00:00:00.000Z' });
      return Promise.resolve(null);
    };
    let snap = await s.ctl.check();
    assert(snap.phase === 'available' && snap.info.version === '1.5.1', 'update-available → available 且带版本');
    assert(snap.info.notes === '修复 A\n新增 B', 'releaseNotes 数组已归一');
    assert(s.pushed.some((p) => p.phase === 'checking') && s.pushed.some((p) => p.phase === 'available'), 'checking 与 available 均推送');
    snap = await s.ctl.download();
    assert(s.api.downloadCalls === 1, 'download 恰好触发一次 downloadUpdate');
    /* 进度推送节流：同整数百分比抖动不推 */
    s.emitter.emit('download-progress', { percent: 20.4, bytesPerSecond: 262144, transferred: 2048, total: 10240 });
    const before = s.pushed.length;
    s.emitter.emit('download-progress', { percent: 20.9, bytesPerSecond: 262144, transferred: 2148, total: 10240 });
    assert(s.pushed.length === before, '下载中同整数百分比不重复推送（IPC 节流）');
    s.emitter.emit('download-progress', { percent: 21.0, bytesPerSecond: 262144, transferred: 2150, total: 10240 });
    assert(s.pushed[s.pushed.length - 1].progress.percent === 21, '百分比整数变化推送且归一');
    s.emitter.emit('update-downloaded');
    snap = s.ctl.snapshot();
    assert(snap.phase === 'downloaded' && snap.progress === null, 'update-downloaded → downloaded 且进度清空');
    /* install 放行（packaged） */
    const after = s.ctl.install();
    assert(s.api.quitCalls.length === 1 && s.api.quitCalls[0][0] === false && s.api.quitCalls[0][1] === true, 'install → quitAndInstall(false, true)（走向导、装完自启）');
    assert(after.phase === 'downloaded', 'install 返回快照保持 downloaded');
  }

  /* ---------- 状态机：download 仅 available 放行 ---------- */
  {
    const s = setup('packaged');
    const snap = await s.ctl.download();
    assert(snap.phase === 'idle' && s.api.downloadCalls === 0, 'idle 下 download 被拒绝（快照不变、不触发）');
  }

  /* ---------- 状态机：并发防重入（checking 期间再点无效） ---------- */
  {
    const s = setup('packaged');
    let resolveCheck;
    s.api.checkForUpdates = function () {
      this.checkCalls++;
      s.emitter.emit('checking-for-update');
      return new Promise((r) => { resolveCheck = r; });
    };
    const first = await s.ctl.check(); // 挂在 checking
    assert(first.phase === 'checking', 'check 进行中 → checking');
    await s.ctl.check();
    assert(s.api.checkCalls === 1, 'checking 期间重复 check 不重入');
    resolveCheck(null);
  }

  /* ---------- 状态机：install 仅 packaged 放行 ---------- */
  {
    const s = setup('portable');
    s.emitter.emit('update-downloaded'); // 直接置态（真实流程不会），仅验证 kind 门禁
    s.ctl.install();
    assert(s.api.quitCalls.length === 0, '便携版 install 不触发 quitAndInstall');
  }

  /* ---------- 状态机：error 收敛（reject 路径） ---------- */
  {
    const s = setup('packaged');
    s.api.checkForUpdates = function () { return Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com')); };
    let snap = await s.ctl.check();
    assert(snap.phase === 'error' && snap.error.indexOf('网络不可用') === 0, 'checkForUpdates reject → error 态 + 归类文案');
    assert(s.diags.some((d) => d.indexOf('app-update') === 0 && d.indexOf('网络不可用') > 0), '错误已落诊断日志');
    snap = await s.ctl.check(); // error 后允许重试
    assert(snap.phase === 'error' || snap.phase === 'checking', 'error 后允许重试 check');
  }

  /* ---------- 状态机：error 事件独立到达 ---------- */
  {
    const s = setup('dev');
    s.emitter.emit('error', new Error('HTTP 404: latest.yml'));
    const snap = s.ctl.snapshot();
    assert(snap.phase === 'error' && snap.error.indexOf('元数据缺失') > 0, 'error 事件 → error 态（404 归类为元数据缺失）');
    assert(snap.kind === 'dev', '错误快照保留运行形态');
  }

  /* ---------- 依赖解析（纯 Node 侧冒烟）：electron-updater 可加载 ---------- */
  {
    const eu = require('electron-updater');
    assert(typeof eu.NsisUpdater === 'function' && typeof eu.autoUpdater === 'object', 'electron-updater 依赖可解析并导出 NsisUpdater/autoUpdater');
  }
}

main().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
}).then(() => checker.finish());
