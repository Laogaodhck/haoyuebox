/* ============================================================
 * test-system.cjs — electron/system.js 主进程单测（QA-B4 覆盖缺口）
 * 覆盖：sysExe System32 解析、printTestPage 打印机名白名单四条路径
 * （非 win32 / 空名 / 白名单外 / 白名单内）、netInfo 回环过滤、
 * dnsProbe 失败路径。child_process.spawn 在 require 前替换为假件，
 * 绝不真正启动 rundll32（不会真的打印测试页）。
 * win32 前提路径经 withPlatform('win32') 切假平台：Windows 上为恒等包装，
 * 非 Windows（CI ubuntu 腿）上也能机械验证同一逻辑——否则 printTestPage
 * 首行 NOT_WIN 短路，白名单内路径取 spawnCalls[0] 还会 TypeError 硬崩套件。
 * ============================================================ */
'use strict';
const { EventEmitter } = require('events');
const { createChecker } = require('./_lib.cjs');

const checker = createChecker();
const assert = checker.assert;

/* ---- spawn 假件：记录调用，永不启动真实进程 ----
 * 必须在 require system.js 之前替换：该模块在加载时已解构 spawn */
const childProcess = require('child_process');
const spawnCalls = [];
childProcess.spawn = function (exe, args, opts) {
  spawnCalls.push({ exe: exe, args: args || [], opts: opts || {} });
  const ee = new EventEmitter();
  return ee; // launch() 只挂 once('error') + 300ms 定时器，不会真触发
};

const sys = require('../electron/system');

/* process.platform 临时切换（测试后复原） */
function withPlatform(value, fn) {
  const orig = process.platform;
  Object.defineProperty(process, 'platform', { value: value, configurable: true });
  return Promise.resolve()
    .then(fn)
    .finally(() => Object.defineProperty(process, 'platform', { value: orig, configurable: true }));
}

(async function () {
  /* ---- sysExe：System32 绝对路径（防 PATH/当前目录劫持） ---- */
  var exe = sys.sysExe('rundll32');
  assert(/System32[\\/]rundll32\.exe$/.test(exe), 'sysExe 解析到 System32 绝对路径（rundll32）');

  /* ---- printTestPage：非 win32 直接拒绝 ---- */
  await withPlatform('linux', async function () {
    var r = await sys.printTestPage(async function () { return [{ name: 'HP' }]; }, 'HP');
    assert(r.ok === false && /仅 Windows/.test(r.error), 'printTestPage 非 win32 返回 NOT_WIN');
  });

  /* ---- printTestPage：空名/白名单外/白名单内/枚举失败 ----
   * 这些路径以 process.platform === 'win32' 为前提（CI ubuntu 腿同样要跑），
   * 统一切假平台；Windows 上 withPlatform 是恒等包装，行为零变化 */
  await withPlatform('win32', async function () {
    /* ---- printTestPage：空名/非字符串拒绝 ---- */
    var rEmpty = await sys.printTestPage(async function () { return []; }, '');
    assert(rEmpty.ok === false && /未选择打印机/.test(rEmpty.error), 'printTestPage 空名拒绝');
    var rNull = await sys.printTestPage(async function () { return []; }, null);
    assert(rNull.ok === false && /未选择打印机/.test(rNull.error), 'printTestPage null 名拒绝');

    /* ---- printTestPage：白名单外拒绝（防任意字符串交给 rundll32） ---- */
    var rOut = await sys.printTestPage(async function () { return [{ name: 'Microsoft Print to PDF' }]; }, ' Evil;calc');
    assert(rOut.ok === false && /不在本机列表中/.test(rOut.error), 'printTestPage 白名单外打印机名拒绝');
    assert(spawnCalls.length === 0, 'printTestPage 拒绝路径未启动任何子进程');

    /* ---- printTestPage：白名单内放行（spawn 被调用、参数含 /n 名） ---- */
    spawnCalls.length = 0;
    var rIn = await sys.printTestPage(async function () {
      return [{ name: 'Microsoft Print to PDF' }, { name: 'HP LaserJet' }];
    }, 'HP LaserJet');
    assert(rIn.ok === true, 'printTestPage 白名单内放行返回 ok');
    assert(spawnCalls.length === 1, 'printTestPage 放行时恰好启动一个子进程');
    assert(/System32[\\/]rundll32\.exe$/.test(spawnCalls[0].exe)
      && spawnCalls[0].args.indexOf('/n') >= 0
      && spawnCalls[0].args.indexOf('HP LaserJet') >= 0,
      'printTestPage 经 System32 rundll32 以数组参数传 /n 打印机名（无注入面）');

    /* ---- printTestPage：枚举失败兜底 ---- */
    var rEnum = await sys.printTestPage(async function () { throw new Error('enum fail'); }, 'HP');
    assert(rEnum.ok === false && /枚举失败/.test(rEnum.error), 'printTestPage 打印机枚举失败时兜底报错');
  });

  /* ---- netInfo：回环接口过滤 ---- */
  var info = sys.netInfo();
  assert(info.ok === true && Array.isArray(info.ifaces), 'netInfo 返回 {ok, ifaces} 结构');
  assert(info.ifaces.every(function (f) {
    return f.addrs.every(function (a) { return !/^127\./.test(a.addr); });
  }), 'netInfo 过滤回环地址（127.x 不出现在列表）');
  assert(info.ifaces.every(function (f) { return !!f.name && Array.isArray(f.addrs); }),
    'netInfo 条目含 name 与 addrs 数组');

  /* ---- dnsProbe：解析失败路径（不存在的保留域名，无网络也返回失败态） ---- */
  var d = await sys.dnsProbe('nx.invalid.example.invalid');
  assert(d.ok === false && d.addr === '', 'dnsProbe 解析失败返回 {ok:false, addr:空}');
  var d2 = await sys.dnsProbe('127.0.0.1'); // 字面 IP 经系统解析器直接成功
  assert(d2.ok === true && d2.addr === '127.0.0.1', 'dnsProbe 字面 IP 解析成功');

  /* ---- dnsProbe：解析器挂起时 3s 超时兜底（与 tcpProbe 对齐；stub dns.lookup 永不回调） ---- */
  var dns = require('dns');
  var origLookup = dns.lookup;
  dns.lookup = function () { /* 模拟系统解析器挂起：永不回调 */ };
  var t1 = Date.now();
  var dHang = await sys.dnsProbe('hang.example.invalid');
  dns.lookup = origLookup;
  assert(dHang.ok === false && dHang.addr === '' && Date.now() - t1 < 4000,
    'dnsProbe 解析器挂起时 3s 超时返回失败（不等无限期）');

  /* ---- tcpProbe：拒绝端口快速失败（不等满超时） ---- */
  var t0 = Date.now();
  var tp = await sys.tcpProbe('127.0.0.1', 1); // 1 端口几乎必然拒绝
  assert(tp.ok === false && Date.now() - t0 < 4000, 'tcpProbe 连接拒绝快速返回失败（不等满 3s 超时）');

  checker.finish();
})().catch(function (e) {
  console.error('脚本异常:', (e && e.stack) || e);
  process.exit(2);
});
