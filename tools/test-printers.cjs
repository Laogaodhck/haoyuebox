/* ============================================================
 * test-printers.cjs — 打印机管理单测
 * ① js/printer-manager.js 纯函数：条目校验 / 检索筛选 / 系统匹配 /
 *    状态计数 / 持久化清洗 / 增删改与默认唯一 / 展示文本；
 * ② electron/printer-probe.js：连接配置校验 + 真实 TCP 探测
 *    （本地起服务对拍：通 → ok+latency，断 → 失败+中文原因）。
 * ============================================================ */
'use strict';

const path = require('path');
const net = require('net');
const { createChecker } = require('./_lib.cjs');

const t = createChecker();

global.window = { App: { ui: { $: () => null, toast: () => {}, showLoading: () => {}, hideLoading: () => {} } } };
require(path.join(__dirname, '..', 'js', 'printer-manager.js'));
const T = global.window.App.printerManager._test;

const probe = require(path.join(__dirname, '..', 'electron', 'printer-probe.js'));

/* ---------- 1. 条目校验 ---------- */
const base = {
  name: '前台打印机', type: 'system', protocol: '',
  address: '', port: '', location: '', note: '', isDefault: false
};
t.assert(T.validatePrinter(base, [], null).ok, 'validatePrinter 系统类最小配置合法');
t.assert(!T.validatePrinter(Object.assign({}, base, { name: '   ' }), [], null).ok,
  'validatePrinter 名称为空白拒绝');
t.assert(!T.validatePrinter(Object.assign({}, base, { name: 'x'.repeat(51) }), [], null).ok,
  'validatePrinter 名称超 50 字拒绝');
t.assert(!T.validatePrinter(Object.assign({}, base, { name: '重复名' }), [{ id: 'a', name: '重复名' }], null).ok,
  'validatePrinter 同名拒绝');
t.assert(!T.validatePrinter(Object.assign({}, base, { name: 'ABC' }), [{ id: 'b', name: 'abc' }], null).ok,
  'validatePrinter 同名忽略大小写');
t.assert(T.validatePrinter(Object.assign({}, base, { name: '重复名' }), [{ id: 'a', name: '重复名' }], 'a').ok,
  'validatePrinter 编辑自身允许保留同名');
t.assert(!T.validatePrinter(Object.assign({}, base, { type: 'weird' }), [], null).ok,
  'validatePrinter 非法类型拒绝');

const net1 = Object.assign({}, base, { type: 'network', address: '192.168.1.50' });
t.assert(T.validatePrinter(net1, [], null).ok, 'validatePrinter 网络类填地址即合法（端口留空回退默认）');
t.assert(!T.validatePrinter(Object.assign({}, net1, { address: '  ' }), [], null).ok,
  'validatePrinter 网络类缺地址拒绝');
t.assert(!T.validatePrinter(Object.assign({}, net1, { port: '70000' }), [], null).ok,
  'validatePrinter 端口越界拒绝');
t.assert(!T.validatePrinter(Object.assign({}, net1, { port: '8.5' }), [], null).ok,
  'validatePrinter 端口非整数拒绝');
t.assert(!T.validatePrinter(Object.assign({}, net1, { port: 'abc' }), [], null).ok,
  'validatePrinter 端口非数字拒绝');
t.assert(!T.validatePrinter(Object.assign({}, base, { port: '99999' }), [], null).ok,
  'validatePrinter 系统类填了端口也须合法');
t.assert(!T.validatePrinter(Object.assign({}, base, { location: 'x'.repeat(61) }), [], null).ok,
  'validatePrinter 位置超 60 字拒绝');
t.assert(!T.validatePrinter(Object.assign({}, base, { note: 'x'.repeat(201) }), [], null).ok,
  'validatePrinter 备注超 200 字拒绝');

/* ---------- 2. 检索筛选 ---------- */
const list = [
  { name: '前台打印机', type: 'system', status: 'online', address: '', location: '一楼大厅', note: '' },
  { name: '仓库网络机', type: 'network', status: 'offline', address: '192.168.1.50', location: '仓库', note: '老机器，备用' },
  { name: '文印室共享', type: 'shared', status: 'unknown', address: '', location: '三楼', note: '' }
];
t.assert(T.filterPrinters(list, { keyword: '前台' }).length === 1, 'filterPrinters 名称关键词');
t.assert(T.filterPrinters(list, { keyword: '192.168' }).length === 1, 'filterPrinters 地址关键词');
t.assert(T.filterPrinters(list, { keyword: '老机器' }).length === 1, 'filterPrinters 备注关键词');
t.assert(T.filterPrinters(list, { keyword: 'printer' }).length === 0
  && T.filterPrinters(list, { keyword: 'PRINTER' }).length === 0, 'filterPrinters 关键词大小写不敏感（无命中）');
t.assert(T.filterPrinters(list, { keyword: '打印机', status: 'online' }).length === 1,
  'filterPrinters 关键词 + 状态组合');
t.assert(T.filterPrinters(list, { keyword: '打印机', status: 'offline' }).length === 0,
  'filterPrinters 组合无命中');
t.assert(T.filterPrinters(list, { status: 'offline' }).length === 1, 'filterPrinters 按状态');
t.assert(T.filterPrinters(list, { type: 'network' }).length === 1, 'filterPrinters 按类型');
t.assert(T.filterPrinters(list, {}).length === 3 && T.filterPrinters(list, null).length === 3,
  'filterPrinters 无条件返回全部');
t.assert(T.filterPrinters(null, { keyword: 'x' }).length === 0, 'filterPrinters 空列表兜底');

/* ---------- 3. 系统匹配与状态计数 ---------- */
const sys = [
  { name: 'Microsoft Print to PDF', displayName: 'Microsoft Print to PDF' },
  { name: 'EPSON_L4150', displayName: '爱普生 L4150 系列' }
];
t.assert(T.matchSystem(sys, { name: 'epson_l4150', type: 'system' }) !== null, 'matchSystem 名称忽略大小写');
t.assert(T.matchSystem(sys, { name: '爱普生 L4150 系列', type: 'system' }) !== null, 'matchSystem 命中 displayName');
t.assert(T.matchSystem(sys, { name: '不存在的打印机', type: 'system' }) === null, 'matchSystem 未命中返回 null');
t.assert(T.matchSystem(sys, { name: '网络机', type: 'network', address: '192.168.1.50' }) === null,
  'matchSystem 网络类地址不匹配返回 null');
const sys2 = sys.concat([{ name: '192.168.1.50', displayName: 'HP 网络打印机' }]);
t.assert(T.matchSystem(sys2, { name: '任意显示名', type: 'network', address: '192.168.1.50' }) !== null,
  'matchSystem 网络类按地址兜底命中');
t.assert(T.matchSystem(null, { name: 'x', type: 'system' }) === null, 'matchSystem 系统列表为空兜底');
t.assert(T.matchSystem(sys, null) === null, 'matchSystem 条目为空兜底');

const cnt = T.countByStatus([
  { status: 'online' }, { status: 'offline' }, { status: 'unknown' }, {}, { status: 'weird' }
]);
t.assert(cnt.total === 5 && cnt.online === 1 && cnt.offline === 1 && cnt.unknown === 3,
  'countByStatus 分类计数（缺失/非法状态计入未检测）');
t.assert(T.countByStatus(null).total === 0, 'countByStatus 空输入兜底');

/* ---------- 4. 持久化清洗 ---------- */
const clean = T.sanitizePrinter({
  id: 'p1', name: '  前台   打印机 ', type: 'network', protocol: 'IPP',
  address: ' ipp://192.168.1.50/ ', port: '631', location: '一楼', note: '备注',
  isDefault: true, status: 'online', lastChecked: 123, lastLatency: 12, lastError: '',
  createdAt: 100, updatedAt: 200
});
t.assert(clean && clean.name === '前台 打印机', 'sanitizePrinter 名称归一');
t.assert(clean.type === 'network' && clean.status === 'online', 'sanitizePrinter 合法枚举保留');
t.assert(clean.address === '192.168.1.50' && clean.port === 631, 'sanitizePrinter 地址剥协议、端口转数字');
t.assert(clean.id === 'p1' && clean.createdAt === 100, 'sanitizePrinter 保留 id 与时间戳');
t.assert(T.sanitizePrinter({ name: '  ' }) === null, 'sanitizePrinter 无名条目丢弃');
t.assert(T.sanitizePrinter(null) === null && T.sanitizePrinter('x') === null, 'sanitizePrinter 非对象丢弃');
t.assert(T.sanitizePrinter({ name: 'A', type: 'weird', status: 'weird', port: 'abc' }).type === 'system'
  && T.sanitizePrinter({ name: 'A', type: 'weird', status: 'weird', port: 'abc' }).status === 'unknown'
  && T.sanitizePrinter({ name: 'A', type: 'weird', status: 'weird', port: 'abc' }).port === '',
  'sanitizePrinter 非法枚举回落、非法端口置空');
t.assert(T.sanitizePrinter({ name: 'A', note: 'x'.repeat(300) }).note.length === 200,
  'sanitizePrinter 备注截断 200 字');

/* ---------- 5. 增删改与默认唯一 ---------- */
let l0 = [];
l0 = T.upsertPrinter(l0, Object.assign({}, base, { isDefault: true }));
t.assert(l0.length === 1 && typeof l0[0].id === 'string' && l0[0].isDefault, 'upsertPrinter 新增补 id 与默认');
const firstId = l0[0].id;
l0 = T.upsertPrinter(l0, Object.assign({}, base, { name: '网络机', type: 'network', address: '10.0.0.2', isDefault: true }));
t.assert(l0.length === 2 && l0[0].isDefault === false && l0[1].isDefault === true,
  'upsertPrinter 默认打印机全台账唯一');
l0 = T.upsertPrinter(l0, Object.assign({}, base, { name: '网络机改', type: 'network', address: '10.0.0.2', id: l0[1].id, isDefault: true }));
t.assert(l0.length === 2 && l0[1].name === '网络机改' && l0[1].isDefault, 'upsertPrinter 按 id 更新保留默认');
t.assert(T.removePrinter(l0, l0[1].id).length === 1, 'removePrinter 按 id 删除');
const d1 = T.setDefaultPrinter(l0, l0[0].id);
t.assert(d1[0].isDefault && !d1[1].isDefault, 'setDefaultPrinter 唯一默认切换');

/* ---------- 6. 展示文本与杂项 ---------- */
t.assert(T.typeLabel('system') === '系统打印机' && T.typeLabel('network') === '网络打印机'
  && T.typeLabel('shared') === '共享打印机' && T.typeLabel('') === '—', 'typeLabel 三类标签');
t.assert(T.statusLabel('online') === '在线' && T.statusLabel('offline') === '离线'
  && T.statusLabel('unknown') === '未检测' && T.statusLabel('weird') === '未检测', 'statusLabel 状态标签');
t.assert(T.defaultPortFor('IPP') === 631 && T.defaultPortFor('Raw9100') === 9100
  && T.defaultPortFor('LPR') === 515 && T.defaultPortFor('SMB') === 445 && T.defaultPortFor('') === 9100,
  'defaultPortFor 协议默认端口');
t.assert(T.connectionText({ type: 'system', address: '' }) === '系统自动', 'connectionText 系统类自动');
t.assert(T.connectionText({ type: 'system', address: '192.168.1.5' }) === '192.168.1.5', 'connectionText 系统类带地址');
t.assert(T.connectionText({ type: 'network', address: '192.168.1.50', port: 9100, protocol: 'Raw9100' })
  === '192.168.1.50:9100（Raw9100）', 'connectionText 网络类完整格式');
t.assert(T.connectionText({ type: 'network', address: '192.168.1.50', port: '', protocol: 'IPP' })
  === '192.168.1.50（IPP）', 'connectionText 端口为空省略');
t.assert(T.fmtTime(null) === '—' && T.fmtTime(0) === '—', 'fmtTime 空值占位');
t.assert(T.fmtTime(new Date(2026, 0, 2, 3, 4).getTime()) === '01-02 03:04', 'fmtTime 本地时间格式');
t.assert(T.normalizeAddress('  IPP://192.168.1.5/ ') === '192.168.1.5', 'normalizeAddress 剥协议与斜杠');
t.assert(T.normalizeAddress(null) === '', 'normalizeAddress 空值兜底');
t.assert(T.parsePort('', 9100) === 9100 && T.parsePort(null, 7) === 7, 'parsePort 空值回落默认端口');
t.assert(T.parsePort('80', 0) === 80 && T.parsePort('65535', 0) === 65535, 'parsePort 合法端口');
t.assert(T.parsePort('0', 9) === null && T.parsePort('65536', 9) === null
  && T.parsePort('8.5', 9) === null && T.parsePort('abc', 9) === null, 'parsePort 非法端口返回 null');
t.assert(T.normalizeName('  前台   打印机 ') === '前台 打印机', 'normalizeName 压缩空白');
const idA = T.genId(), idB = T.genId();
t.assert(typeof idA === 'string' && idA.indexOf('p') === 0 && idA !== idB, 'genId 生成唯一 id');

/* ---------- 7. 连接配置校验（主进程模块） ---------- */
t.assert(!probe.validateConnection({ address: '', port: 9100 }).ok, 'validateConnection 空地址拒绝');
t.assert(probe.validateConnection({ address: ' 192.168.1.5 ', port: '' }).ok
  && probe.validateConnection({ address: ' 192.168.1.5 ', port: '' }).port === 9100,
  'validateConnection 端口留空回落 9100');
t.assert(probe.validateConnection({ address: 'a', port: 'abc' }).ok === false, 'validateConnection 非法端口拒绝');
t.assert(probe.validateConnection({ address: 'x'.repeat(254) }).ok === false, 'validateConnection 超长地址拒绝');
t.assert(probe.normalizeAddress('smb://PC/share/') === 'PC/share', 'normalizeAddress（主进程）剥协议前缀');

/* ---------- 8. 真实 TCP 探测（本地服务对拍） ---------- */
(async () => {
  /* 起一个本地 TCP 服务：探测应成功并给出延迟 */
  const server = net.createServer((sock) => { sock.end(); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const okRes = await probe.probeTcp('127.0.0.1', port, 2000);
  t.assert(okRes.ok && typeof okRes.latencyMs === 'number' && okRes.latencyMs >= 0,
    'probeTcp 本地服务探测成功并测出延迟');

  /* probePrinter 入口：合法配置走探测 */
  const viaEntry = await probe.probePrinter({ address: '127.0.0.1', port: port, timeoutMs: 2000 });
  t.assert(viaEntry.ok, 'probePrinter 合法配置探测成功');

  /* 关闭服务后探测同一端口：应失败并给出中文原因 */
  await new Promise((resolve) => server.close(resolve));
  await new Promise((r) => setTimeout(r, 150));
  const badRes = await probe.probeTcp('127.0.0.1', port, 1500);
  t.assert(!badRes.ok && typeof badRes.error === 'string' && badRes.error.length > 0,
    'probeTcp 端口关闭后探测失败并给出原因');

  /* 不可达地址：短时间内失败（超时或网络不可达，均须有原因） */
  const deadRes = await probe.probeTcp('192.0.2.1', 9100, 1000);
  t.assert(!deadRes.ok && !!deadRes.error, 'probeTcp 不可达地址失败并给出原因');

  /* 非法配置不发起连接，直接返回错误 */
  const badCfg = await probe.probePrinter({ address: '', port: 9100 });
  t.assert(!badCfg.ok && badCfg.error.indexOf('地址') >= 0, 'probePrinter 非法配置直接报错');

  t.finish();
})().catch((e) => {
  console.log('  FAIL - TCP 探测测试异常：' + (e && e.message || e));
  process.exit(1);
});
