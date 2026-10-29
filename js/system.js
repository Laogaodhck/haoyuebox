/* ============================================================
 * system.js — 系统工具渲染层：网络检测 + 添加打印机 面板逻辑
 * 桌面版经 haoyueSystem IPC（主进程固定白名单节点/系统向导）；
 * 浏览器版无桥接时显示不可用提示（同 print-batch 的降级模式）。
 * ============================================================ */
'use strict';

(function (App) {

  var $ = App.ui.$;
  var bridge = (typeof window.haoyueSystem !== 'undefined') ? window.haoyueSystem : null;

  /* 文本转 HTML 安全（接口名/IP/打印机名均来自系统返回，仍做转义） */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------- 网络检测 ---------- */

  /* 每次进入面板：重置检测结果并读取网卡信息 */
  function enterNet() {
    $('net-summary').textContent = '';
    $('net-results').hidden = true;
    $('net-results').innerHTML = '';
    $('net-browser-hint').hidden = !!bridge;
    $('net-probe-btn').disabled = !bridge;
    if (!bridge) {
      $('net-ifaces').innerHTML = '<div class="settings-hint">浏览器模式不可用，请使用桌面版。</div>';
      return;
    }
    $('net-ifaces').innerHTML = '<div class="settings-hint">读取中…</div>';
    bridge.netInfo().then(function (r) {
      renderIfaces((r && r.ifaces) || []);
    }).catch(function () {
      $('net-ifaces').innerHTML = '<div class="settings-hint">网卡信息读取失败</div>';
    });
  }

  function renderIfaces(ifaces) {
    if (!ifaces.length) {
      $('net-ifaces').innerHTML = '<div class="settings-hint">未检测到已联网的网卡</div>';
      return;
    }
    var html = '<div class="sys-table-row"><span>接口</span><span>IP 地址</span><span>MAC</span></div>';
    ifaces.forEach(function (f) {
      var ips = f.addrs.map(function (a) { return esc(a.addr); }).join('<br>');
      html += '<div class="sys-table-row"><span>' + esc(f.name) + '</span><span>' + ips +
        '</span><span>' + esc(f.mac || '—') + '</span></div>';
    });
    $('net-ifaces').innerHTML = html;
  }

  function probeRun() {
    if (!bridge) return;
    var btn = $('net-probe-btn');
    btn.disabled = true;
    btn.textContent = '检测中…';
    $('net-summary').textContent = '';
    bridge.netProbe().then(function (r) {
      renderProbe(r || {});
    }).catch(function (e) {
      $('net-summary').textContent = '检测失败：' + ((e && e.message) || e);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '重新检测';
    });
  }

  function renderProbe(r) {
    var probes = r.probes || [];
    var dnss = r.dns || [];
    var html = '<div class="sys-table-row"><span>节点</span><span>地址</span><span>延迟</span></div>';
    probes.forEach(function (p) {
      html += '<div class="sys-table-row ' + (p.ok ? 'ok' : 'bad') + '"><span>' + esc(p.name) +
        '</span><span>' + esc(p.host) + '</span><span class="sys-status">' +
        (p.ok ? p.ms + ' ms' : '不通') + '</span></div>';
    });
    dnss.forEach(function (d) {
      html += '<div class="sys-table-row ' + (d.ok ? 'ok' : 'bad') + '"><span>DNS 解析</span><span>' +
        esc(d.domain) + '</span><span class="sys-status">' +
        (d.ok ? esc(d.addr) + ' · ' + d.ms + ' ms' : '失败') + '</span></div>';
    });
    var box = $('net-results');
    box.innerHTML = html;
    box.hidden = false;
    /* 汇总：全通 / 部分通 / 全不通 三态 */
    var okCount = probes.filter(function (p) { return p.ok; }).length;
    var okDns = dnss.filter(function (d) { return d.ok; }).length;
    var min = Infinity;
    probes.forEach(function (p) { if (p.ok && p.ms < min) min = p.ms; });
    var summary;
    if (!okCount && !okDns) {
      summary = '无法连接外网：所有探测节点与域名解析均失败，请检查网络连接。';
    } else if (okCount < probes.length || okDns < dnss.length) {
      summary = '网络不稳定：' + okCount + '/' + probes.length + ' 个节点连通，' +
        okDns + '/' + dnss.length + ' 个域名解析成功。';
    } else {
      summary = '网络连通正常：全部节点可达，最快 ' + min + ' ms，域名解析正常。';
    }
    $('net-summary').textContent = summary;
  }

  /* ---------- 添加打印机 ---------- */

  var printersCache = [];

  function setPrinterButtons(disabled) {
    ['printer-wizard-btn', 'printer-settings-btn', 'printer-refresh-btn', 'printer-test-btn']
      .forEach(function (id) { $(id).disabled = disabled; });
  }

  /* 每次进入面板：刷新打印机列表（复用打印模块的枚举 IPC） */
  function enterPrinter() {
    $('printer-browser-hint').hidden = !!bridge;
    setPrinterButtons(!bridge);
    if (!bridge) {
      $('printer-list').innerHTML = '<div class="settings-hint">浏览器模式不可用，请使用桌面版。</div>';
      return;
    }
    refreshPrinters();
  }

  function refreshPrinters() {
    if (!bridge || !window.haoyuePrint) return;
    $('printer-list').innerHTML = '<div class="settings-hint">读取中…</div>';
    window.haoyuePrint.listPrinters().then(function (list) {
      printersCache = list || [];
      renderPrinters();
    }).catch(function () {
      $('printer-list').innerHTML = '<div class="settings-hint">打印机列表读取失败</div>';
    });
  }

  function renderPrinters() {
    if (!printersCache.length) {
      $('printer-list').innerHTML = '<div class="settings-hint">未检测到打印机，可点击下方「打开系统添加打印机向导」安装。</div>';
    } else {
      var html = '<div class="sys-table-row"><span>名称</span><span>状态</span></div>';
      printersCache.forEach(function (p) {
        html += '<div class="sys-table-row cols2"><span>' + esc(p.displayName || p.name) +
          '</span><span class="sys-status' + (p.isDefault ? ' ok' : '') + '">' +
          (p.isDefault ? '默认打印机' : '已安装') + '</span></div>';
      });
      $('printer-list').innerHTML = html;
    }
    var sel = $('printer-test-select');
    sel.innerHTML = printersCache.length
      ? printersCache.map(function (p) {
        return '<option value="' + esc(p.name) + '">' + esc(p.displayName || p.name) +
          (p.isDefault ? '（默认）' : '') + '</option>';
      }).join('')
      : '<option value="">（未检测到打印机）</option>';
  }

  function openWizard() {
    bridge.openAddPrinter().then(function (r) {
      if (r && r.ok) App.ui.toast('已打开系统「添加打印机」向导');
      else App.ui.toast('打开失败：' + ((r && r.error) || '未知错误'));
    }).catch(function (e) {
      App.ui.toast('打开失败：' + ((e && e.message) || e));
    });
  }

  function openSettingsPage() {
    bridge.openPrintSettings().then(function (r) {
      if (r && r.ok) App.ui.toast('已打开系统打印设置');
      else App.ui.toast('打开失败：' + ((r && r.error) || '未知错误'));
    }).catch(function (e) {
      App.ui.toast('打开失败：' + ((e && e.message) || e));
    });
  }

  var printTestBusy = false;   // 测试页在途标志：连点会向打印机发送多张测试页

  function printTest() {
    var name = $('printer-test-select').value;
    if (!name) { App.ui.toast('请先选择打印机'); return; }
    if (printTestBusy) return;
    printTestBusy = true;
    App.ui.toast('正在发送测试页…');
    bridge.printTestPage(name).then(function (r) {
      printTestBusy = false;
      if (r && r.ok) App.ui.toast('测试页已发送到「' + name + '」');
      else App.ui.toast('发送失败：' + ((r && r.error) || '未知错误'));
    }).catch(function (e) {
      printTestBusy = false;
      App.ui.toast('发送失败：' + ((e && e.message) || e));
    });
  }

  /* 浏览器模式下网络检测 / 打印机依赖主进程 IPC：
   * 入口徽章由「可用」降级为「仅桌面版」，避免点进去才发现不可用 */
  function applyModeBadges() {
    ['system-open-network', 'system-open-printer'].forEach(function (id) {
      var card = $(id);
      var badge = card && card.querySelector('.hc-badge');
      if (!badge) return;
      badge.textContent = bridge ? '可用' : '仅桌面版';
      badge.classList.toggle('off', !bridge);
    });
  }

  App.system = {
    init: function () {
      applyModeBadges();
      $('net-probe-btn').addEventListener('click', probeRun);
      $('printer-refresh-btn').addEventListener('click', refreshPrinters);
      $('printer-wizard-btn').addEventListener('click', openWizard);
      $('printer-settings-btn').addEventListener('click', openSettingsPage);
      $('printer-test-btn').addEventListener('click', printTest);
    },
    enterNet: enterNet,
    enterPrinter: enterPrinter,
    _test: { escRef: esc, applyModeBadges: applyModeBadges }
  };
})(window.App);
