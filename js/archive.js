/* 压缩工具模块：压缩文件 / 解压文件
 * 压缩与解压均由桌面版内置 7z 引擎（主进程 spawn）完成，
 * 渲染层只负责选择、参数与进度展示，全程本地、无网络。
 * 浏览器打开时功能不可用（无 zunhongArchive 桥接）。
 */
(function () {
  'use strict';

  /* 常见压缩包扩展名（与主进程 7z-args.js ARCHIVE_EXTS 保持一致） */
  var ARCHIVE_EXTS = {
    '7z': 1, zip: 1, rar: 1, tar: 1, gz: 1, tgz: 1, bz2: 1, tbz2: 1,
    xz: 1, txz: 1, cab: 1, iso: 1, jar: 1, lzma: 1, cpio: 1, deb: 1, rpm: 1
  };

  var ARCHIVE_PANELS = ['archive-compress', 'archive-extract'];

  var items = [];      /* 待压缩条目 [{path,name,isDir,size}] */
  var archives = [];   /* 待解压压缩包 [{path,name,isDir,size}] */
  var running = false; /* 是否有压缩/解压任务进行中 */
  var bridge = null;   /* window.zunhongArchive */

  var $ = window.App.ui.$;
  function toast(msg, isErr) { window.App.ui.toast(msg, isErr); }

  /* ================= 纯逻辑（可单测） ================= */

  function isArchiveName(name) {
    var m = /\.([^.]+)$/.exec(name || '');
    return !!(m && ARCHIVE_EXTS[m[1].toLowerCase()]);
  }

  /* 字节数 → 可读大小 */
  function fmtSize(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var v = bytes;
    var i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + ' ' + units[i];
  }

  /* 条目类型标签 */
  function typeLabel(item) {
    if (!item) return '文件';
    if (item.isDir) return '文件夹';
    var m = /\.([^.]+)$/.exec(item.name || '');
    return m ? m[1].toUpperCase() + ' 文件' : '文件';
  }

  /* 压缩包默认文件名：单项沿用其名称，多项用"压缩包" */
  function defaultArchiveName(list, fmt) {
    var ext = fmt === 'zip' ? 'zip' : '7z';
    if (list && list.length === 1 && list[0].name) {
      return (list[0].name.replace(/\.[^.]+$/, '') || '压缩包') + '.' + ext;
    }
    return '压缩包.' + ext;
  }

  /* 合并新选择的内容，按 path 去重（返回新数组），新项默认勾选 */
  function mergeItems(existing, added) {
    var seen = {};
    existing.forEach(function (it) { seen[it.path] = 1; });
    return existing.concat((added || []).filter(function (it) { return it && it.path && !seen[it.path]; })
      .map(function (it) { it.checked = true; return it; }));
  }

  /* 勾选判定：未显式取消（checked !== false）即视为勾选 */
  function isChecked(it) { return !!it && it.checked !== false; }

  /* 勾选项数量/体积摘要（仅统计勾选项） */
  function countText(list) {
    if (!list || !list.length) return '未选择';
    var checked = list.filter(isChecked);
    if (!checked.length) return '共 ' + list.length + ' 项 · 未勾选';
    var total = 0;
    checked.forEach(function (it) { if (!it.isDir && typeof it.size === 'number') total += it.size; });
    return '共 ' + list.length + ' 项 · 已勾选 ' + checked.length + ' 项 · ' + fmtSize(total);
  }

  /* 解压表格"解压到"列文案 */
  function extractTargetText(archiveName, destMode) {
    if (destMode === 'same') return '压缩包所在目录';
    var base = (archiveName || '').replace(/\.[^.]+$/, '') || '解压结果';
    return base + '/';
  }

  /* 进度文案（纯函数，便于单测） */
  function compressProgressText(pct) { return '压缩中… ' + pct + '%'; }
  function extractProgressText(d) {
    return '解压中（' + ((d.index || 0) + 1) + '/' + (d.total || 1) + '）：' + (d.name || '') + ' — ' + d.pct + '%';
  }

  /* 取路径的父目录（渲染层无 Node path，纯正则实现） */
  function parentDir(p) {
    var s = String(p || '').replace(/[\\/]+$/, '');
    var out = s.replace(/[\\/][^\\/]*$/, '');
    return out || s;
  }

  /* 「压缩到」模式 → 输出路径；dialog 模式返回 ''（走另存为对话框） */
  function resolveOutPath(mode, chosen, fmt) {
    if (mode !== 'same') return '';
    var dir = parentDir(chosen[0].path);
    return dir + (/[\\/]$/.test(dir) ? '' : '\\') + defaultArchiveName(chosen, fmt);
  }

  /* ================= 渲染 ================= */

  function renderCompressList() {
    var tbody = $('ac-table').querySelector('tbody');
    tbody.textContent = '';
    items.forEach(function (it, i) {
      var tr = document.createElement('tr');
      if (!isChecked(it)) tr.classList.add('row-unchecked');

      /* 勾选列：默认全选，取消勾选后不参与压缩 */
      var tdC = document.createElement('td');
      tdC.className = 'col-check';
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = isChecked(it);
      box.addEventListener('change', function () {
        it.checked = box.checked;
        tr.classList.toggle('row-unchecked', !box.checked);
        syncCheckAll();
        renderCompressMeta();
      });
      tdC.appendChild(box);

      var td0 = document.createElement('td');
      td0.textContent = String(i + 1);

      var td1 = document.createElement('td');
      td1.textContent = it.name || '';
      td1.title = it.path || '';

      var td2 = document.createElement('td');
      td2.className = 'st-dim';
      td2.textContent = typeLabel(it);

      var td3 = document.createElement('td');
      td3.className = 'st-dim';
      td3.textContent = it.isDir ? '—' : fmtSize(it.size);

      tr.appendChild(tdC); tr.appendChild(td0); tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      tbody.appendChild(tr);
    });
    renderCompressMeta();
  }

  /* 计数文案 / 全选框 / 执行按钮状态（勾选数为 0 时禁用压缩） */
  function renderCompressMeta() {
    $('ac-list').hidden = !items.length;
    $('ac-empty').hidden = !!items.length;
    $('ac-count').textContent = countText(items);
    var checkedCount = items.filter(isChecked).length;
    $('ac-run').disabled = !items.length || !checkedCount || running || !bridgeOk();
    syncCheckAll();
  }

  /* 全选框状态：全部勾选=选中，部分=半选，无=未选 */
  function syncCheckAll() {
    var all = $('ac-check-all');
    if (!items.length) { all.checked = false; all.indeterminate = false; return; }
    var n = items.filter(isChecked).length;
    all.checked = n === items.length;
    all.indeterminate = n > 0 && n < items.length;
  }

  function renderExtractList() {
    var destMode = $('ax-out').value;
    var tbody = $('ax-table').querySelector('tbody');
    tbody.textContent = '';
    archives.forEach(function (it, i) {
      var tr = document.createElement('tr');

      var td0 = document.createElement('td');
      td0.textContent = String(i + 1);

      var td1 = document.createElement('td');
      td1.textContent = it.name || '';
      td1.title = it.path || '';

      var td2 = document.createElement('td');
      td2.className = 'st-dim';
      td2.textContent = fmtSize(it.size);

      var td3 = document.createElement('td');
      td3.className = 'st-dim';
      td3.textContent = extractTargetText(it.name, destMode);

      tr.appendChild(td0); tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      tbody.appendChild(tr);
    });
    $('ax-list').hidden = !archives.length;
    $('ax-empty').hidden = !!archives.length;
    $('ax-count').textContent = countText(archives);
    $('ax-run').disabled = !archives.length || running || !bridgeOk();
    $('ax-browse').disabled = !archives.length || running || !bridgeOk();
  }

  function renderEncNamesRow() {
    /* 仅 7z 支持加密文件名（-mhe）与分卷（-v） */
    var is7z = $('ac-fmt').value === '7z';
    $('ac-encnames-row').hidden = !is7z;
    $('ac-volume-row').hidden = !is7z;
  }

  /* ================= 桌面桥接 ================= */

  function bridgeOk() { return !!(bridge && bridge.isDesktop); }

  function setRunning(on, which) {
    running = on;
    if (on) {
      /* 开始任务：重建列表以禁用执行按钮 */
      if (which === 'compress') renderCompressList();
      else renderExtractList();
      return;
    }
    /* 结束任务：仅恢复按钮可用性，保留结果行的 ✓/失败标记不被重建覆盖 */
    var has = which === 'compress' ? items.length : archives.length;
    $(which === 'compress' ? 'ac-run' : 'ax-run').disabled = !has || !bridgeOk();
  }

  function onProgress(d) {
    if (!d) return;
    if (d.task === 'compress') {
      var p = $('ac-progress');
      p.hidden = false;
      p.textContent = compressProgressText(d.pct);
    } else if (d.task === 'extract') {
      var q = $('ax-progress');
      q.hidden = false;
      q.textContent = extractProgressText(d);
    }
  }

  /* ================= 压缩 ================= */

  function pickCompress(kind) {
    if (!bridgeOk()) { toast('压缩功能需要在桌面版中使用', true); return; }
    bridge.pickPaths(kind).then(function (list) {
      if (!list || !list.length) return;
      items = mergeItems(items, list);
      renderCompressList();
    }).catch(function (e) { toast('选择失败：' + (e.message || e), true); });
  }

  function runCompress() {
    if (running || !items.length) return;
    if (!bridgeOk()) { toast('压缩功能需要在桌面版中使用', true); return; }
    var chosen = items.filter(isChecked);
    if (!chosen.length) { toast('请至少勾选一项要压缩的内容', true); return; }
    var fmt = $('ac-fmt').value;
    var autoPath = resolveOutPath($('ac-out').value, chosen, fmt);
    var useDialog = !autoPath;
    var next = useDialog
      ? bridge.saveDialog(defaultArchiveName(chosen, fmt))
      : Promise.resolve(autoPath);
    next.then(function (outPath) {
      if (!outPath) return; /* 用户取消保存对话框 */
      setRunning(true, 'compress');
      $('ac-progress').hidden = false;
      $('ac-progress').textContent = '准备压缩…';
      return bridge.compress({
        items: chosen.map(function (it) { return it.path; }),
        fmt: fmt,
        level: $('ac-level').value,
        volumeMB: fmt === '7z' ? (Math.round(+$('ac-volume').value || 0)) : 0,
        pass: $('ac-pass').value,
        encNames: fmt === '7z' && $('ac-encnames').checked,
        outPath: outPath
      }).then(function (res) {
        var prog = $('ac-progress');
        if (res && res.ok) {
          var volNote = res.parts > 1 ? '，分 ' + res.parts + ' 卷' : '';
          prog.textContent = '压缩完成 ✓ ' + outPath + '（' + fmtSize(res.size) + volNote + '）';
          toast('压缩完成');
        } else {
          prog.textContent = '压缩失败：' + ((res && res.error) || '未知错误');
          toast('压缩失败：' + ((res && res.error) || '未知错误'), true);
        }
      });
    }).catch(function (e) {
      $('ac-progress').hidden = false;
      $('ac-progress').textContent = '压缩失败：' + (e.message || e);
      toast('压缩失败：' + (e.message || e), true);
    }).then(function () { setRunning(false, 'compress'); });
  }

  /* ================= 解压 ================= */

  function pickArchives() {
    if (!bridgeOk()) { toast('解压功能需要在桌面版中使用', true); return; }
    bridge.pickPaths('archive').then(function (list) {
      if (!list || !list.length) return;
      var filtered = list.filter(function (it) { return !it.isDir && isArchiveName(it.name); });
      if (!filtered.length) { toast('所选文件中没有可识别的压缩包', true); return; }
      archives = mergeItems(archives, filtered);
      $('ax-result').textContent = '';
      renderExtractList();
    }).catch(function (e) { toast('选择失败：' + (e.message || e), true); });
  }

  function runExtract() {
    if (running || !archives.length) return;
    if (!bridgeOk()) { toast('解压功能需要在桌面版中使用', true); return; }
    setRunning(true, 'extract');
    $('ax-progress').hidden = false;
    $('ax-progress').textContent = '准备解压…';
    $('ax-result').textContent = '';
    bridge.extract({
      items: archives.map(function (it) { return it.path; }),
      destMode: $('ax-out').value,
      pass: $('ax-pass').value
    }).then(function (res) {
      renderExtractResult(res || { ok: false, results: [], okCount: 0, failCount: 0 });
    }).catch(function (e) {
      toast('解压失败：' + (e.message || e), true);
      $('ax-result').textContent = '解压失败：' + (e.message || e);
    }).then(function () { setRunning(false, 'extract'); });
  }

  /* 汇总解压结果：表格标色 + 结果文案 */
  function renderExtractResult(res) {
    var rows = $('ax-table').querySelectorAll('tbody tr');
    (res.results || []).forEach(function (r, i) {
      var tr = rows[i];
      if (!tr) return;
      var td3 = tr.children[3];
      if (!r.ok) {
        tr.classList.add('st-bad');
        td3.textContent = '失败：' + r.error;
        td3.className = 'st-bad';
      } else {
        td3.textContent = extractTargetText(r.name, $('ax-out').value) + ' ✓';
      }
    });
    var line = '解压完成：成功 ' + res.okCount + ' 个' + (res.failCount ? '，失败 ' + res.failCount + ' 个' : '');
    $('ax-result').textContent = line;
    toast(line, res.failCount > 0);
  }

  /* ================= 内容浏览 ================= */

  /* 列表摘要（纯函数）：文件数 / 目录数 / 总大小文案 */
  function browseMeta(entries) {
    var files = 0, dirs = 0, total = 0;
    (entries || []).forEach(function (e) {
      if (e.isDir) dirs++;
      else { files++; total += (typeof e.size === 'number' && isFinite(e.size)) ? e.size : 0; }
    });
    var parts = [];
    if (files) parts.push(files + ' 个文件');
    if (dirs) parts.push(dirs + ' 个文件夹');
    return { files: files, dirs: dirs, totalSize: total, text: parts.join(' · ') + (files ? ' · 共 ' + fmtSize(total) : '') };
  }

  /* 单个条目的修改时间显示（空值占位 —） */
  function mtimeText(e) { return (e && e.mtime) || '—'; }

  function browseArchive() {
    if (!bridgeOk()) { toast('内容浏览需要在桌面版中使用', true); return; }
    var first = archives[0];
    if (!first) return;
    var dlg = $('ax-browse-dlg');
    $('ax-browse-title').textContent = first.name || '';
    $('ax-browse-meta').textContent = '正在读取内容…';
    var body = $('ax-browse-body');
    body.textContent = '';
    dlg.hidden = false;
    bridge.list({ archive: first.path, pass: $('ax-pass').value }).then(function (res) {
      if (!res || !res.ok) {
        $('ax-browse-meta').textContent = '读取失败：' + ((res && res.error) || '未知错误');
        $('ax-browse-meta').className = 'hint-text st-bad';
        return;
      }
      $('ax-browse-meta').className = 'hint-text';
      var meta = browseMeta(res.entries || []);
      $('ax-browse-meta').textContent = meta.text || '空压缩包';
      body.textContent = '';
      (res.entries || []).forEach(function (e, i) {
        var tr = document.createElement('tr');
        var td0 = document.createElement('td');
        td0.textContent = String(i + 1);
        var td1 = document.createElement('td');
        td1.textContent = e.path || '';
        if (e.isDir) td1.className = 'st-dim';
        var td2 = document.createElement('td');
        td2.className = 'st-dim';
        td2.textContent = e.isDir ? '—' : fmtSize(e.size);
        var td3 = document.createElement('td');
        td3.className = 'st-dim';
        td3.textContent = mtimeText(e);
        tr.appendChild(td0); tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
        body.appendChild(tr);
      });
    }).catch(function (e) {
      $('ax-browse-meta').textContent = '读取失败：' + (e.message || e);
      $('ax-browse-meta').className = 'hint-text st-bad';
    });
  }

  function closeBrowse() { $('ax-browse-dlg').hidden = true; }

  /* ================= 模块入口 ================= */

  function showMenu() {
    $('archive-menu').hidden = false;
    ARCHIVE_PANELS.forEach(function (p) { $(p).hidden = true; });
  }

  /* 子面板通用切换：显示指定面板（null=返回菜单），其余全部收纳 */
  function showOnly(panelId) {
    $('archive-menu').hidden = !!panelId;
    ARCHIVE_PANELS.forEach(function (p) { $(p).hidden = (p !== panelId); });
  }

  function enter() { showMenu(); }

  function markUnsupported() {
    /* 浏览器环境：无 zunhongArchive 桥接，展示提示并禁用执行按钮 */
    $('ac-unsupported').hidden = false;
    $('ax-unsupported').hidden = false;
    $('ac-run').disabled = true;
    $('ax-run').disabled = true;
    $('ac-pick-files').disabled = true;
    $('ac-pick-dir').disabled = true;
    $('ax-pick').disabled = true;
  }

  function init() {
    bridge = window.zunhongArchive || null;
    if (!bridgeOk()) markUnsupported();

    /* 菜单 → 子面板（浏览器下也可浏览界面） */
    $('archive-open-compress').addEventListener('click', function () { showOnly('archive-compress'); });
    $('archive-open-extract').addEventListener('click', function () { showOnly('archive-extract'); });
    $('ac-back').addEventListener('click', function () { if (!running) showOnly(null); });
    $('ax-back').addEventListener('click', function () { if (!running) showOnly(null); });
    $('ac-fmt').addEventListener('change', renderEncNamesRow);
    $('ac-check-all').addEventListener('change', function () {
      if (running) return;
      var on = $('ac-check-all').checked;
      items.forEach(function (it) { it.checked = on; });
      renderCompressList();
    });
    $('ax-out').addEventListener('change', renderExtractList);

    if (!bridgeOk()) return; /* 浏览器环境：仅界面可浏览，动作不可用 */

    /* 压缩面板 */
    $('ac-pick-files').addEventListener('click', function () { pickCompress('file'); });
    $('ac-pick-dir').addEventListener('click', function () { pickCompress('dir'); });
    $('ac-clear').addEventListener('click', function () {
      if (running) return;
      items = [];
      $('ac-progress').hidden = true;
      renderCompressList();
    });
    $('ac-run').addEventListener('click', runCompress);

    /* 解压面板 */
    $('ax-pick').addEventListener('click', pickArchives);
    $('ax-browse').addEventListener('click', browseArchive);
    $('ax-browse-close').addEventListener('click', closeBrowse);
    $('ax-browse-dlg').addEventListener('click', function (e) { if (e.target === this) closeBrowse(); });
    $('ax-clear').addEventListener('click', function () {
      if (running) return;
      archives = [];
      $('ax-progress').hidden = true;
      $('ax-result').textContent = '';
      renderExtractList();
    });
    $('ax-run').addEventListener('click', runExtract);

    /* 进度回传 */
    bridge.onProgress(onProgress);

    /* 启动时确认 7z 引擎可用 */
    bridge.check7z().then(function (r) {
      if (r && r.ok) {
        $('ac-note').textContent = '7z 引擎已就绪（' + (r.version || '7-Zip') + '）';
      } else {
        markUnsupported();
        var msg = '7z 引擎不可用：' + ((r && r.error) || '未找到 7z.exe');
        $('ac-unsupported').textContent = msg;
        $('ax-unsupported').textContent = msg;
        $('ac-unsupported').hidden = false;
        $('ax-unsupported').hidden = false;
      }
    }).catch(function () { /* 忽略，点击执行时再报错 */ });
  }

  window.App.archive = {
    init: init,
    enter: enter,
    showOnly: showOnly,
    _test: {
      isArchiveName: isArchiveName,
      fmtSize: fmtSize,
      typeLabel: typeLabel,
      defaultArchiveName: defaultArchiveName,
      mergeItems: mergeItems,
      isChecked: isChecked,
      countText: countText,
      parentDir: parentDir,
      resolveOutPath: resolveOutPath,
      extractTargetText: extractTargetText,
      compressProgressText: compressProgressText,
      extractProgressText: extractProgressText,
      browseMeta: browseMeta,
      mtimeText: mtimeText,
      ARCHIVE_EXTS: ARCHIVE_EXTS
    }
  };
})();
