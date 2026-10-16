/* ============================================================
 * printer-manager.js — 打印机管理（打印工具子功能）
 * 维护托管打印机台账：添加 / 编辑 / 删除 / 查询，支持按名称、
 * 状态、类型检索筛选；可用性检测（系统打印机与系统列表比对，
 * 网络/共享打印机经主进程 TCP 探测）与连接状态展示；配置变更
 * 或连接异常时给出明确提示。数据持久化于 localStorage，纯本地
 * 离线可用；检测与系统导入需桌面版（window.zunhongPrint）。
 *
 * 数据结构：
 *   printer = {
 *     id: string,
 *     name: string,                    // 显示名（台账内唯一）
 *     type: 'system'|'network'|'shared',
 *     protocol: 'IPP'|'Raw9100'|'LPR'|'SMB'|'',   // 网络/共享可选
 *     address: string, port: number,   // 连接配置（network/shared 必填）
 *     location: string, note: string,  // 位置 / 备注
 *     isDefault: boolean,              // 台账内唯一默认
 *     status: 'online'|'offline'|'unknown',
 *     lastChecked: number|null,        // 最近检测时间戳
 *     lastLatency: number|null,        // 最近检测延迟 ms（网络探测）
 *     lastError: string,               // 最近一次异常原因
 *     createdAt: number, updatedAt: number
 *   }
 * ============================================================ */
'use strict';

window.App = window.App || {};
window.App.printerManager = (function () {

  var $ = function (id) { return document.getElementById(id); };
  var toast = window.App.ui ? window.App.ui.toast : function () {};
  var printApi = window.zunhongPrint || null;

  var STORE_KEY = 'zunhong-toolbox-printers';
  var PROBE_TIMEOUT_MS = 3000;

  var TYPE_LABELS = { system: '系统打印机', network: '网络打印机', shared: '共享打印机' };
  var STATUS_LABELS = { online: '在线', offline: '离线', unknown: '未检测' };
  /* 协议默认端口：切换协议时自动带入，减少手工输入 */
  var PROTOCOL_PORTS = { IPP: 631, Raw9100: 9100, LPR: 515, SMB: 445 };
  var CONN_TYPES = ['network', 'shared'];   // 需要连接配置的类型

  /* ================= 纯函数（供单测） ================= */

  function genId() {
    return 'p' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function typeLabel(t) { return TYPE_LABELS[t] || t || '—'; }
  function statusLabel(s) { return STATUS_LABELS[s] || '未检测'; }
  function defaultPortFor(protocol) {
    return Object.prototype.hasOwnProperty.call(PROTOCOL_PORTS, protocol) ? PROTOCOL_PORTS[protocol] : 9100;
  }

  /* 名称归一：去首尾空白、压缩内部连续空白（用于比对与展示） */
  function normalizeName(raw) {
    return String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  }

  /* 地址归一：去空白、剥协议前缀与末尾斜杠（与主进程校验保持一致） */
  function normalizeAddress(raw) {
    return String(raw == null ? '' : raw)
      .trim()
      .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
      .replace(/\/+$/, '');
  }

  /* 端口解析：空值回落 fallback；非法（非整数 / 越界）返回 null */
  function parsePort(raw, fallback) {
    if (raw == null || raw === '') return fallback;
    var v = Number(String(raw).trim());
    if (!Number.isInteger(v) || v < 1 || v > 65535) return null;
    return v;
  }

  /* 台账条目校验：返回 { ok, error }。existing 为当前列表（编辑时排除自身） */
  function validatePrinter(draft, existing, editingId) {
    var name = normalizeName(draft && draft.name);
    if (!name) return { ok: false, error: '请填写打印机名称' };
    if (name.length > 50) return { ok: false, error: '打印机名称不能超过 50 个字符' };
    var list = Array.isArray(existing) ? existing : [];
    var dup = list.some(function (p) {
      return p && p.id !== editingId && normalizeName(p.name).toLowerCase() === name.toLowerCase();
    });
    if (dup) return { ok: false, error: '已存在同名打印机，请换一个名称' };

    var type = draft && draft.type;
    if (!Object.prototype.hasOwnProperty.call(TYPE_LABELS, type)) {
      return { ok: false, error: '请选择打印机类型' };
    }
    if (CONN_TYPES.indexOf(type) >= 0 && !normalizeAddress(draft.address)) {
      return { ok: false, error: '网络/共享打印机必须填写地址（IP 或主机名）' };
    }
    /* 端口留空合法：保存时按协议默认端口回退；填了则必须是 1–65535 整数 */
    if (draft.port != null && draft.port !== '' && parsePort(draft.port, null) === null) {
      return { ok: false, error: '端口须为 1–65535 的整数' };
    }
    var loc = String(draft && draft.location || '');
    var note = String(draft && draft.note || '');
    if (loc.length > 60) return { ok: false, error: '位置信息不能超过 60 个字符' };
    if (note.length > 200) return { ok: false, error: '备注不能超过 200 个字符' };
    return { ok: true };
  }

  /* 检索筛选：keyword 命中名称/地址/位置/备注（大小写不敏感），status/type 精确匹配 */
  function filterPrinters(list, q) {
    var kw = String((q && q.keyword) || '').trim().toLowerCase();
    var st = (q && q.status) || 'all';
    var ty = (q && q.type) || 'all';
    return (Array.isArray(list) ? list : []).filter(function (p) {
      if (!p) return false;
      if (st !== 'all' && p.status !== st) return false;
      if (ty !== 'all' && p.type !== ty) return false;
      if (!kw) return true;
      var hay = [p.name, p.address, p.location, p.note].map(function (s) {
        return String(s || '').toLowerCase();
      }).join(' ');
      return hay.indexOf(kw) >= 0;
    });
  }

  /* 与系统打印机列表匹配：系统条目的 name 与 displayName 都参与比对
     （界面下拉显示的是 displayName，用户常按显示名登记），先按名称，
     网络/共享类再按地址兜底 */
  function matchSystem(sysList, printer) {
    if (!printer || !Array.isArray(sysList)) return null;
    var name = normalizeName(printer.name).toLowerCase();
    var addr = normalizeAddress(printer.address).toLowerCase();
    var byName = sysList.find(function (s) {
      if (!s) return false;
      var n1 = normalizeName(s.name).toLowerCase();
      var n2 = normalizeName(s.displayName).toLowerCase();
      return n1 === name || (!!n2 && n2 === name);
    });
    if (byName) return byName;
    if (addr && CONN_TYPES.indexOf(printer.type) >= 0) {
      return sysList.find(function (s) {
        return s && normalizeAddress(s.name || '').toLowerCase() === addr;
      }) || null;
    }
    return null;
  }

  /* 按状态计数 */
  function countByStatus(list) {
    var c = { total: 0, online: 0, offline: 0, unknown: 0 };
    (Array.isArray(list) ? list : []).forEach(function (p) {
      if (!p) return;
      c.total++;
      if (Object.prototype.hasOwnProperty.call(c, p.status)) c[p.status]++;
      else c.unknown++;
    });
    return c;
  }

  /* 从持久化数据恢复条目：丢脏数据、补默认字段（防旧版本/手改存储） */
  function sanitizePrinter(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = normalizeName(raw.name);
    if (!name) return null;
    var type = Object.prototype.hasOwnProperty.call(TYPE_LABELS, raw.type) ? raw.type : 'system';
    var status = Object.prototype.hasOwnProperty.call(STATUS_LABELS, raw.status) ? raw.status : 'unknown';
    var port = parsePort(raw.port, type === 'system' ? '' : 9100);
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : genId(),
      name: name,
      type: type,
      protocol: typeof raw.protocol === 'string' ? raw.protocol : '',
      address: normalizeAddress(raw.address),
      port: port == null ? '' : port,
      location: String(raw.location || '').slice(0, 60),
      note: String(raw.note || '').slice(0, 200),
      isDefault: !!raw.isDefault,
      status: status,
      lastChecked: typeof raw.lastChecked === 'number' ? raw.lastChecked : null,
      lastLatency: typeof raw.lastLatency === 'number' ? raw.lastLatency : null,
      lastError: String(raw.lastError || ''),
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now()
    };
  }

  /* 新增 / 更新（按 id 替换）；维护时间戳；默认打印机全台账唯一 */
  function upsertPrinter(list, draft) {
    var now = Date.now();
    var base = Array.isArray(list) ? list.slice() : [];
    var isNew = !draft.id;
    var rec = Object.assign({}, draft, {
      id: draft.id || genId(),
      createdAt: draft.createdAt || now,
      updatedAt: now
    });
    var out;
    if (isNew) {
      out = base.concat([rec]);
    } else {
      out = base.map(function (p) { return p && p.id === rec.id ? rec : p; });
    }
    if (rec.isDefault) {
      out = out.map(function (p) {
        return p && p.id !== rec.id ? Object.assign({}, p, { isDefault: false }) : p;
      });
    }
    /* 没有任何默认时保留原状；删除默认后由调用方决定是否提升 */
    return out;
  }

  function removePrinter(list, id) {
    return (Array.isArray(list) ? list : []).filter(function (p) { return !p || p.id !== id; });
  }

  /* 设置唯一默认打印机 */
  function setDefaultPrinter(list, id) {
    return (Array.isArray(list) ? list : []).map(function (p) {
      return p ? Object.assign({}, p, { isDefault: p.id === id }) : p;
    });
  }

  /* 连接配置展示文本 */
  function connectionText(p) {
    if (!p) return '—';
    if (CONN_TYPES.indexOf(p.type) < 0) return p.address ? p.address : '系统自动';
    var addr = p.address || '—';
    var port = p.port == null || p.port === '' ? '' : ':' + p.port;
    var proto = p.protocol ? '（' + p.protocol + '）' : '';
    return addr + port + proto;
  }

  /* 时间展示：MM-DD HH:mm（本地时区） */
  function fmtTime(ts) {
    if (typeof ts !== 'number' || !ts) return '—';
    var d = new Date(ts);
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  /* ================= 模块状态 ================= */

  var printers = [];     // 托管打印机台账
  var sysPrinters = [];  // 系统检测到的打印机（listPrinters 结果）
  var filters = { keyword: '', status: 'all', type: 'all' };
  var editingId = null;  // 对话框正在编辑的条目（null=新增）
  var checking = {};     // id → true，检测中（禁用按钮防重复）

  /* ================= 持久化 ================= */

  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      var list = Array.isArray(raw) ? raw : [];
      printers = list.map(sanitizePrinter).filter(Boolean);
      /* 默认唯一性兜底：多条默认只保留第一条 */
      var seenDefault = false;
      printers = printers.map(function (p) {
        if (p.isDefault) {
          if (seenDefault) return Object.assign({}, p, { isDefault: false });
          seenDefault = true;
        }
        return p;
      });
    } catch (e) {
      printers = [];
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(printers));
    } catch (e) { /* 存储不可用时静默忽略 */ }
  }

  /* ================= 系统打印机 / 可用性检测 ================= */

  function desktopOk() {
    return !!(printApi && printApi.listPrinters);
  }

  /* 拉取系统打印机列表，并按匹配结果刷新系统类条目状态 */
  async function refreshSystem() {
    if (!desktopOk()) {
      sysPrinters = [];
      render();
      return 0;
    }
    try {
      sysPrinters = await printApi.listPrinters() || [];
    } catch (e) {
      sysPrinters = [];
      toast('读取系统打印机失败：' + e.message, true);
    }
    reevaluateSystem();
    render();
    return sysPrinters.length;
  }

  /* 系统类条目：命中系统列表 → 在线，未命中 → 离线（刚查过即结论）；
     网络/共享类：命中系统列表 → 在线（已安装且可用），未命中维持原判（探测为准） */
  function reevaluateSystem() {
    var changed = [];
    printers = printers.map(function (p) {
      var matched = matchSystem(sysPrinters, p);
      if (matched) {
        if (p.status !== 'online') changed.push(p.name + '（在线）');
        return Object.assign({}, p, { status: 'online', lastChecked: Date.now(), lastError: '' });
      }
      if (p.type === 'system') {
        if (p.status !== 'offline') changed.push(p.name + '（离线）');
        return Object.assign({}, p, { status: 'offline', lastChecked: Date.now(), lastError: '系统列表中未找到该打印机' });
      }
      return p;
    });
    if (changed.length) {
      save();
      return changed;
    }
    return [];
  }

  /* 检测单台：系统类走列表匹配，网络/共享类走主进程 TCP 探测 */
  async function checkOne(p) {
    if (!p) return null;
    checking[p.id] = true;
    render();
    var res = null;
    try {
      if (p.type === 'system') {
        if (!desktopOk()) {
          toast('可用性检测需要在桌面版中使用', true);
          return null;
        }
        var matched = matchSystem(sysPrinters, p);
        res = matched
          ? { ok: true }
          : { ok: false, error: '系统列表中未找到该打印机' };
      } else {
        if (!printApi || !printApi.probePrinter) {
          toast('可用性检测需要在桌面版中使用', true);
          return null;
        }
        res = await printApi.probePrinter({
          address: p.address, port: p.port, timeoutMs: PROBE_TIMEOUT_MS
        });
      }
    } catch (e) {
      res = { ok: false, error: e.message || '检测失败' };
    } finally {
      delete checking[p.id];
    }
    var now = Date.now();
    printers = printers.map(function (x) {
      if (!x || x.id !== p.id) return x;
      return Object.assign({}, x, {
        status: res.ok ? 'online' : 'offline',
        lastChecked: now,
        lastLatency: res.ok && typeof res.latencyMs === 'number' ? res.latencyMs : null,
        lastError: res.ok ? '' : (res.error || '连接异常')
      });
    });
    save();
    render();
    if (res.ok) {
      toast('打印机「' + p.name + '」在线' + (res.latencyMs != null ? '（' + res.latencyMs + ' ms）' : ''));
    } else {
      toast('打印机「' + p.name + '」连接异常：' + (res.error || '未知原因'), true);
    }
    return res;
  }

  /* 检测全部：逐台进行，汇总提示 */
  async function checkAll() {
    if (!printers.length) { toast('尚未添加打印机', true); return; }
    if (!printApi || (!printApi.probePrinter && !printApi.listPrinters)) {
      toast('可用性检测需要在桌面版中使用', true);
      return;
    }
    if (!desktopOk()) { toast('可用性检测需要在桌面版中使用', true); return; }
    try {
      sysPrinters = await printApi.listPrinters() || [];
    } catch (e) {
      sysPrinters = [];
    }
    reevaluateSystem();
    var targets = printers.filter(function (p) { return p && p.type !== 'system'; });
    for (var i = 0; i < targets.length; i++) {   // eslint-disable-line no-await-in-loop
      await checkOne(targets[i]);                // eslint-disable-line no-await-in-loop
    }
    var c = countByStatus(printers);
    toast('检测完成：在线 ' + c.online + ' 台 · 离线 ' + c.offline + ' 台 · 未检测 ' + c.unknown + ' 台');
  }

  /* 从系统列表导入尚未托管的打印机 */
  async function importSystem() {
    if (!desktopOk()) { toast('导入系统打印机需要在桌面版中使用', true); return; }
    try {
      sysPrinters = await printApi.listPrinters() || [];
    } catch (e) {
      toast('读取系统打印机失败：' + e.message, true);
      return;
    }
    var known = {};
    printers.forEach(function (p) { known[p.name.toLowerCase()] = 1; });
    var added = 0;
    sysPrinters.forEach(function (s) {
      var name = normalizeName(s.displayName || s.name);
      if (!name || known[name.toLowerCase()]) return;
      known[name.toLowerCase()] = 1;
      printers = upsertPrinter(printers, {
        name: name,
        type: 'system',
        protocol: '',
        address: '',
        port: '',
        location: '',
        note: '',
        isDefault: !!s.isDefault && !printers.some(function (p) { return p.isDefault; }),
        status: 'online',
        lastChecked: Date.now(),
        lastError: ''
      });
      added++;
    });
    if (added) {
      save();
      toast('已导入 ' + added + ' 台系统打印机');
    } else {
      toast('系统打印机均已在工作台中（或无新增）');
    }
    reevaluateSystem();
    render();
  }

  /* ================= 渲染 ================= */

  function visibleList() {
    return filterPrinters(printers, filters);
  }

  function renderStats() {
    var c = countByStatus(printers);
    $('pm-stats').textContent = '共 ' + c.total + ' 台 · 在线 ' + c.online
      + ' · 离线 ' + c.offline + ' · 未检测 ' + c.unknown;
    var sysHint = $('pm-sys-hint');
    if (sysHint) {
      sysHint.textContent = desktopOk()
        ? '系统检测到 ' + sysPrinters.length + ' 台打印机'
        : '浏览器模式：可管理工作台，检测与导入需桌面版';
    }
  }

  function statusChip(p) {
    var span = document.createElement('span');
    var label = statusLabel(p.status);
    span.className = 'pm-st pm-st-' + p.status;
    span.textContent = label;
    if (p.status === 'online' && typeof p.lastLatency === 'number') {
      span.title = '最近检测延迟 ' + p.lastLatency + ' ms';
    }
    if (p.status === 'offline' && p.lastError) {
      span.title = p.lastError;
    }
    return span;
  }

  function renderRow(p) {
    var tr = document.createElement('tr');

    var tdName = document.createElement('td');
    tdName.className = 'pm-name';
    var star = document.createElement('span');
    star.className = 'pm-star';
    star.textContent = '★';
    star.title = '默认打印机';
    star.hidden = !p.isDefault;
    tdName.appendChild(star);
    tdName.appendChild(document.createTextNode(p.name));
    if (p.note) {
      var nt = document.createElement('div');
      nt.className = 'pm-note';
      nt.textContent = p.note;
      tdName.appendChild(nt);
    }

    var tdType = document.createElement('td');
    tdType.className = 'st-dim';
    tdType.textContent = typeLabel(p.type);

    var tdStatus = document.createElement('td');
    tdStatus.appendChild(statusChip(p));

    var tdConn = document.createElement('td');
    tdConn.className = 'st-dim pm-conn';
    tdConn.textContent = connectionText(p);
    if (p.location) {
      var loc = document.createElement('div');
      loc.className = 'pm-note';
      loc.textContent = p.location;
      tdConn.appendChild(loc);
    }

    var tdTime = document.createElement('td');
    tdTime.className = 'st-dim';
    tdTime.textContent = fmtTime(p.lastChecked);

    var tdOps = document.createElement('td');
    tdOps.className = 'pm-ops';
    var checkingNow = !!checking[p.id];
    var chk = document.createElement('button');
    chk.className = 'ghost pm-op';
    chk.textContent = checkingNow ? '检测中…' : '检测';
    chk.title = '可用性检测';
    chk.disabled = checkingNow;
    chk.addEventListener('click', function () { checkOne(p); });
    var edit = document.createElement('button');
    edit.className = 'ghost pm-op';
    edit.textContent = '编辑';
    edit.addEventListener('click', function () { openDialog(p.id); });
    var del = document.createElement('button');
    del.className = 'ghost pm-op pm-op-del';
    del.textContent = '删除';
    del.addEventListener('click', function () { deletePrinter(p.id); });
    tdOps.appendChild(chk);
    tdOps.appendChild(edit);
    tdOps.appendChild(del);

    tr.appendChild(tdName); tr.appendChild(tdType); tr.appendChild(tdStatus);
    tr.appendChild(tdConn); tr.appendChild(tdTime); tr.appendChild(tdOps);
    return tr;
  }

  function render() {
    if (!$('pm-table')) return;
    renderStats();
    var list = visibleList();
    var tbody = $('pm-table').querySelector('tbody');
    tbody.textContent = '';
    list.forEach(function (p) { tbody.appendChild(renderRow(p)); });
    $('pm-empty').hidden = printers.length > 0;
    $('pm-nofilter').hidden = !(printers.length > 0 && list.length === 0);
    $('pm-count').textContent = printers.length
      ? '显示 ' + list.length + ' / ' + printers.length + ' 台'
      : '';
    $('pm-check-all').disabled = !printers.length;
    $('pm-import').disabled = !desktopOk();
  }

  /* ================= 对话框（添加 / 编辑） ================= */

  function formDraft() {
    return {
      name: $('pm-f-name').value,
      type: $('pm-f-type').value,
      protocol: $('pm-f-protocol').value,
      address: $('pm-f-address').value,
      port: $('pm-f-port').value,
      location: $('pm-f-location').value,
      note: $('pm-f-note').value,
      isDefault: $('pm-f-default').checked
    };
  }

  function fillForm(p) {
    $('pm-f-name').value = p ? p.name : '';
    $('pm-f-type').value = p ? p.type : 'system';
    $('pm-f-protocol').value = p ? (p.protocol || '') : '';
    $('pm-f-address').value = p ? (p.address || '') : '';
    $('pm-f-port').value = p ? (p.port == null ? '' : p.port) : '';
    $('pm-f-location').value = p ? (p.location || '') : '';
    $('pm-f-note').value = p ? (p.note || '') : '';
    $('pm-f-default').checked = p ? !!p.isDefault : false;
    $('pm-dlg-err').textContent = '';
    syncConnRows();
  }

  /* 连接配置组仅对网络/共享类型显示并必填 */
  function syncConnRows() {
    var isConn = CONN_TYPES.indexOf($('pm-f-type').value) >= 0;
    $('pm-row-conn').hidden = !isConn;
  }

  function openDialog(id) {
    editingId = id || null;
    var p = id ? printers.find(function (x) { return x && x.id === id; }) : null;
    $('pm-dlg-title').textContent = p ? '编辑打印机' : '添加打印机';
    fillForm(p || null);
    $('pm-dlg').hidden = false;
    $('pm-f-name').focus();
  }

  function closeDialog() {
    $('pm-dlg').hidden = true;
    editingId = null;
  }

  /* 保存：校验 → 入库 → 连接配置变更时自动检测 → 明确提示 */
  async function submitDialog() {
    var draft = formDraft();
    var v = validatePrinter(draft, printers, editingId);
    if (!v.ok) {
      $('pm-dlg-err').textContent = v.error;
      toast(v.error, true);
      return;
    }
    var prev = editingId ? printers.find(function (x) { return x && x.id === editingId }) : null;
    var connChanged = !!prev && (
      normalizeAddress(prev.address) !== normalizeAddress(draft.address) ||
      String(prev.port == null ? '' : prev.port) !== String(draft.port) ||
      prev.protocol !== draft.protocol
    );
    var rec = {
      id: editingId || undefined,
      name: normalizeName(draft.name),
      type: draft.type,
      protocol: draft.protocol || '',
      address: normalizeAddress(draft.address),
      port: parsePort(draft.port, draft.type === 'system' ? '' : defaultPortFor(draft.protocol)),
      location: draft.location.trim(),
      note: draft.note.trim(),
      isDefault: draft.isDefault,
      status: prev ? prev.status : 'unknown',
      lastChecked: prev ? prev.lastChecked : null,
      lastLatency: prev ? prev.lastLatency : null,
      lastError: prev ? prev.lastError : '',
      createdAt: prev ? prev.createdAt : undefined
    };
    printers = upsertPrinter(printers, rec);
    save();
    render();
    closeDialog();
    toast(prev ? '打印机「' + rec.name + '」已更新' : '已添加打印机「' + rec.name + '」');

    /* 配置变更即重新检测，异常立刻明确提示（名称在台账内唯一，按名称回查） */
    var needCheck = connChanged || !prev;
    if (needCheck && CONN_TYPES.indexOf(rec.type) >= 0) {
      var saved = printers.find(function (x) { return x && x.name === rec.name; });
      if (saved) await checkOne(saved);
    }
  }

  function deletePrinter(id) {
    var p = printers.find(function (x) { return x && x.id === id; });
    if (!p) return;
    var ok = window.confirm('确定删除打印机「' + p.name + '」？\n删除后可在需要时重新添加。');
    if (!ok) return;
    var wasDefault = p.isDefault;
    printers = removePrinter(printers, id);
    if (wasDefault) {
      /* 删除的是默认打印机：自动将第一台提升为默认，避免默认真空 */
      var first = printers.find(function (x) { return x; });
      if (first) printers = setDefaultPrinter(printers, first.id);
    }
    save();
    render();
    toast('已删除打印机「' + p.name + '」');
  }

  /* ================= 面板切换 ================= */

  /* showOnly 模式：与批量打印面板协同（二者互斥，共用一个子功能菜单） */
  function showOnly(panelId) {
    $('print-menu').hidden = !!panelId;
    $('print-manager').hidden = panelId !== 'print-manager';
    var batch = $('print-batch');
    if (batch) batch.hidden = panelId !== 'print-batch';
  }

  function enter() {
    showOnly('print-manager');
    refreshSystem();
  }

  function back() { showOnly(null); }

  /* ================= 事件绑定 ================= */

  function init() {
    load();

    $('pm-add').addEventListener('click', function () { openDialog(null); });
    $('pm-import').addEventListener('click', importSystem);
    $('pm-check-all').addEventListener('click', checkAll);
    $('pm-back').addEventListener('click', back);

    $('pm-search').addEventListener('input', function () {
      filters.keyword = this.value;
      render();
    });
    $('pm-filter-status').addEventListener('change', function () {
      filters.status = this.value;
      render();
    });
    $('pm-filter-type').addEventListener('change', function () {
      filters.type = this.value;
      render();
    });

    $('pm-f-type').addEventListener('change', syncConnRows);
    $('pm-f-protocol').addEventListener('change', function () {
      /* 切换协议时端口为空则带入默认端口，省去手工输入 */
      if (!$('pm-f-port').value) {
        $('pm-f-port').value = defaultPortFor(this.value);
      }
    });
    $('pm-dlg-save').addEventListener('click', submitDialog);
    $('pm-dlg-cancel').addEventListener('click', closeDialog);
    $('pm-dlg-close').addEventListener('click', closeDialog);
    /* 点击遮罩空白处关闭（表单区域内点击不关） */
    $('pm-dlg').addEventListener('click', function (e) {
      if (e.target === this) closeDialog();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('pm-dlg').hidden) closeDialog();
    });

    render();
  }

  return {
    init: init,
    enter: enter,
    back: back,
    showOnly: showOnly,
    refreshSystem: refreshSystem,
    checkAll: checkAll,
    importSystem: importSystem,
    _test: {
      STORE_KEY: STORE_KEY,
      TYPE_LABELS: TYPE_LABELS,
      STATUS_LABELS: STATUS_LABELS,
      PROTOCOL_PORTS: PROTOCOL_PORTS,
      CONN_TYPES: CONN_TYPES,
      genId: genId,
      typeLabel: typeLabel,
      statusLabel: statusLabel,
      defaultPortFor: defaultPortFor,
      normalizeName: normalizeName,
      normalizeAddress: normalizeAddress,
      parsePort: parsePort,
      validatePrinter: validatePrinter,
      filterPrinters: filterPrinters,
      matchSystem: matchSystem,
      countByStatus: countByStatus,
      sanitizePrinter: sanitizePrinter,
      upsertPrinter: upsertPrinter,
      removePrinter: removePrinter,
      setDefaultPrinter: setDefaultPrinter,
      connectionText: connectionText,
      fmtTime: fmtTime
    }
  };
})();
