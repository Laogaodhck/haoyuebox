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
  var engineOk = true; /* 7z 引擎可用性（check7z 失败后置 false，锁死执行入口） */

  /* 密码状态：由密码弹窗维护，不再直接挂在输入框上 */
  var passState = { compress: '', extract: '' };
  var passTarget = ''; /* 当前密码弹窗作用对象：'compress' | 'extract' */

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

  /* 自动命名与已有路径冲突时追加 _1/_2 后缀（纯函数，防覆盖源文件）。
   * taken 为小写化路径字典；99 次仍冲突返回 ''（调用方报错兜底） */
  function bumpOutName(p, taken) {
    var s = String(p || '');
    if (!s) return '';
    var m = /^(.*)(\.[^.]*)$/.exec(s);
    var base = m ? m[1] : s;
    var ext = m ? m[2] : '';
    for (var i = 1; i <= 99; i++) {
      var cand = base + '_' + i + ext;
      if (!taken || !taken[cand.toLowerCase()]) return cand;
    }
    return '';
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

  function bridgeOk() { return !!(bridge && bridge.isDesktop && engineOk); }

  function setRunning(on, which) {
    running = on;
    var cancelBtn = $(which === 'compress' ? 'ac-cancel' : 'ax-cancel');
    if (on) {
      /* 开始任务：重建列表以禁用执行按钮，显示取消按钮 */
      if (which === 'compress') renderCompressList();
      else renderExtractList();
      cancelBtn.hidden = false;
      return;
    }
    /* 结束任务：仅恢复按钮可用性，保留结果行的 ✓/失败标记不被重建覆盖 */
    cancelBtn.hidden = true;
    var has = which === 'compress' ? items.length : archives.length;
    $(which === 'compress' ? 'ac-run' : 'ax-run').disabled = !has || !bridgeOk();
  }

  /* 取消当前 7z 任务：主进程 kill 后任务以「任务已取消」收场 */
  function cancelTask() {
    if (!running || !bridgeOk()) return;
    bridge.cancel().catch(function (e) { toast('取消失败：' + (e.message || e), true); });
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

  /* ================= 拖拽选择（桌面版） ================= */

  /* drop 事件 → 拖入 File 对象转本机路径 → 主进程 stat 出元数据，
   * onList 收到 [{path,name,isDir,size}]（与 pickPaths 相同形状） */
  function dropFiles(e, onList) {
    e.preventDefault();
    if (running || !bridgeOk()) return;
    var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
    if (!files.length) return;
    var paths = [];
    files.forEach(function (f) {
      var p = '';
      try { p = bridge.pathForFile(f); } catch (err) { p = ''; }
      if (p) paths.push(p);
    });
    if (!paths.length) { toast('无法获取拖拽内容的本地路径', true); return; }
    bridge.statPaths(paths).then(function (list) {
      onList(list || []);
    }).catch(function (err) { toast('读取拖拽内容失败：' + (err.message || err), true); });
  }

  /* 在指定区域绑定拖拽高亮与 drop 处理 */
  function bindDropZone(zone, onList) {
    zone.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      zone.classList.add('dz-over');
    });
    zone.addEventListener('dragleave', function () { zone.classList.remove('dz-over'); });
    zone.addEventListener('drop', function (e) {
      zone.classList.remove('dz-over');
      dropFiles(e, onList);
    });
  }

  function addDroppedCompress(list) {
    if (!list.length) { toast('拖拽的内容不可读取', true); return; }
    items = mergeItems(items, list);
    renderCompressList();
    toast('已添加 ' + list.length + ' 项');
  }

  function addDroppedArchives(list) {
    var filtered = list.filter(function (it) { return !it.isDir && isArchiveName(it.name); });
    if (!filtered.length) { toast('拖拽内容中没有可识别的压缩包', true); return; }
    archives = mergeItems(archives, filtered);
    $('ax-result').textContent = '';
    $('ax-progress').hidden = true; /* 新入列时收纳上一轮残留的进度行 */
    renderExtractList();
    toast('已添加 ' + filtered.length + ' 个压缩包');
  }

  function runCompress() {
    if (running || !items.length) return;
    if (!bridgeOk()) { toast('压缩功能需要在桌面版中使用', true); return; }
    var chosen = items.filter(isChecked);
    if (!chosen.length) { toast('请至少勾选一项要压缩的内容', true); return; }
    var fmt = $('ac-fmt').value;
    var autoPath = resolveOutPath($('ac-out').value, chosen, fmt);
    var useDialog = !autoPath;
    /* 数据安全：自动命名与待压缩内容同名（如单文件 report.7z → report.7z）
     * 时自动追加 _1 后缀，防止后续清产物步骤删掉源文件 */
    if (!useDialog) {
      var taken = {};
      chosen.forEach(function (it) { taken[String(it.path || '').toLowerCase()] = 1; });
      if (taken[autoPath.toLowerCase()]) {
        var bumped = bumpOutName(autoPath, taken);
        if (!bumped) { toast('无法生成安全的输出文件名，请改用「每次选择位置」', true); return; }
        autoPath = bumped;
      }
    }
    var next;
    if (useDialog) {
      next = bridge.saveDialog(defaultArchiveName(chosen, fmt));
    } else {
      /* 同目录自动命名：输出已存在时先经用户确认，不静默覆盖 */
      next = bridge.statPaths([autoPath]).then(function (list) {
        if (!list || !list.length) return autoPath;
        return window.App.ui.confirm('输出位置已存在同名文件：\n' + autoPath + '\n\n覆盖它吗？')
          .then(function (yes) { return yes ? autoPath : ''; });
      });
    }
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
        pass: passState.compress,
        encNames: fmt === '7z' && $('ac-encnames').checked,
        outPath: outPath
      }).then(function (res) {
        var prog = $('ac-progress');
        if (res && res.ok) {
          var volNote = res.parts > 1 ? '，分 ' + res.parts + ' 卷' : '';
          prog.textContent = '压缩完成 ✓ ' + outPath + '（' + fmtSize(res.size) + volNote + '）';
          toast('压缩完成');
        } else if (res && res.cancelled) {
          prog.textContent = '压缩已取消';
          toast('压缩已取消', true);
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
      $('ax-progress').hidden = true; /* 新入列时收纳上一轮残留的进度行 */
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
      pass: passState.extract
    }).then(function (res) {
      renderExtractResult(res || { ok: false, results: [], okCount: 0, failCount: 0 });
    }).catch(function (e) {
      $('ax-progress').hidden = true; /* 收纳进度行，异常信息走 ax-result */
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
    /* 收纳进度行：完成后结果由 ax-result 呈现，
     * 残留的「解压中 — N%」会让用户误以为任务卡住未结束 */
    $('ax-progress').hidden = true;
    var line = (res.cancelled ? '解压已取消' : '解压完成') +
      '：成功 ' + res.okCount + ' 个' + (res.failCount ? '，失败 ' + res.failCount + ' 个' : '');
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
    bridge.list({ archive: first.path, pass: passState.extract }).then(function (res) {
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

  /* ================= 密码（按键 + 弹窗输入，压缩/解压共用） ================= */

  function refreshPassBtns() {
    var ac = $('ac-pass-btn');
    var ax = $('ax-pass-btn');
    if (ac) ac.textContent = passState.compress ? '已设置密码 · 点击修改' : '设置密码…';
    if (ax) ax.textContent = passState.extract ? '已输入密码 · 点击修改' : '输入密码…';
  }

  function openPassDlg(target) {
    if (running) return;
    passTarget = target;
    var input = $('pass-dlg-input');
    $('pass-dlg-title').textContent = target === 'compress' ? '设置压缩包密码' : '输入压缩包密码';
    $('pass-dlg-hint').textContent = target === 'compress'
      ? '用于加密待生成的压缩包；仅 7z / ZIP 格式支持'
      : '仅对加密压缩包生效；多选时所有压缩包共用此密码';
    $('pass-dlg-clear').hidden = !passState[target];
    input.value = passState[target] || '';
    $('pass-dlg').hidden = false;
    input.focus();
    input.select();
  }

  function closePassDlg() {
    $('pass-dlg').hidden = true;
    passTarget = '';
  }

  function confirmPassDlg() {
    if (passTarget) {
      passState[passTarget] = $('pass-dlg-input').value;
      refreshPassBtns();
    }
    closePassDlg();
  }

  /* ================= 压缩包图标关联（桌面版） ================= */

  /* 探测结果 → 卡片徽标/文案/按钮可见性 */
  function renderAiState(data) {
    var exts = (data && data.exts) || {};
    var s7 = exts['7z'] || {};
    var sz = exts['zip'] || {};
    var badge = '检测中';
    var desc = '';
    var showApply = false;
    var showRestore = false;
    if (data && !data.dllFound) {
      badge = '资源缺失';
      desc = '未找到 7z.dll 图标资源，无法注册图标关联';
    } else if (s7.state === 'ours' || sz.state === 'ours') {
      badge = '已注册';
      desc = '.7z：' + (s7.hint || '—') + '；.zip：' + (sz.hint || '—') +
        '。若图标未立即刷新，按 F5 或重开资源管理器窗口';
      showRestore = true;
    } else if (s7.state === 'available' || sz.state === 'available') {
      badge = '未关联';
      desc = '.7z：' + (s7.hint || '—') + '；.zip：' + (sz.hint || '—') +
        '。注册后本机无需安装压缩软件即可显示专属图标';
      showApply = true;
    } else {
      badge = '已有关联';
      desc = '.7z：' + (s7.hint || '—') + '；.zip：' + (sz.hint || '—') + '。本程序不会改动';
    }
    $('ai-badge').textContent = badge;
    $('ai-desc').textContent = desc;
    $('ai-actions').hidden = !(showApply || showRestore);
    $('ai-apply').hidden = !showApply;
    $('ai-restore').hidden = !showRestore;
  }

  function initIconsCard() {
    var icons = window.zunhongArchiveIcons || null;
    if (!icons || !icons.isDesktop) {
      $('ai-badge').textContent = '桌面版可用';
      $('ai-desc').textContent = '压缩包图标关联需要在桌面版（安装版 / 便携版）中使用';
      return;
    }
    icons.probe().then(renderAiState).catch(function () {
      $('ai-badge').textContent = '未知';
      $('ai-desc').textContent = '图标关联状态读取失败';
    });
    $('ai-apply').addEventListener('click', function () {
      window.App.ui.confirm('将在当前用户注册 .7z / .zip 图标关联：\n仅当系统当前没有关联时生效，不改动已有打开方式。\n\n现在注册吗？')
        .then(function (yes) {
          if (!yes) return;
          icons.apply().then(function (r) {
            if (r && r.ok) {
              toast('图标关联已注册，若未立即生效请按 F5 刷新');
            } else {
              toast('注册失败：' + ((r && r.errors && r.errors.join('；')) || (r && r.error) || '未知错误'), true);
            }
            return icons.probe().then(renderAiState);
          }).catch(function (e) { toast('注册失败：' + (e.message || e), true); });
        });
    });
    $('ai-restore').addEventListener('click', function () {
      window.App.ui.confirm('将移除本程序注册的压缩包图标关联，并还原注册前的默认值。\n\n继续吗？')
        .then(function (yes) {
          if (!yes) return;
          icons.restore().then(function (r) {
            if (r && r.ok) {
              toast('已恢复默认');
            } else {
              toast('恢复失败：' + ((r && r.errors && r.errors.join('；')) || (r && r.error) || '未知错误'), true);
            }
            return icons.probe().then(renderAiState);
          }).catch(function (e) { toast('恢复失败：' + (e.message || e), true); });
        });
    });
  }

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
    /* 浏览器 / 引擎不可用环境：展示提示并禁用全部动作入口 */
    $('ac-unsupported').hidden = false;
    $('ax-unsupported').hidden = false;
    $('ac-run').disabled = true;
    $('ax-run').disabled = true;
    $('ac-pick-files').disabled = true;
    $('ac-pick-dir').disabled = true;
    $('ax-pick').disabled = true;
    $('ax-browse').disabled = true;
    $('ac-pass-btn').disabled = true;
    $('ax-pass-btn').disabled = true;
  }

  function init() {
    bridge = window.zunhongArchive || null;
    if (!bridgeOk()) markUnsupported();
    initIconsCard();

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
    /* 拖拽框：内容区（空态 / 列表所在画布）均可拖入文件与文件夹 */
    bindDropZone($('ac-drop'), addDroppedCompress);
    bindDropZone($('ax-drop'), addDroppedArchives);
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
    $('ac-pass-btn').addEventListener('click', function () { openPassDlg('compress'); });
    $('ax-pass-btn').addEventListener('click', function () { openPassDlg('extract'); });
    $('pass-dlg-ok').addEventListener('click', confirmPassDlg);
    $('pass-dlg-cancel').addEventListener('click', closePassDlg);
    $('pass-dlg-clear').addEventListener('click', function () {
      if (passTarget) { passState[passTarget] = ''; refreshPassBtns(); }
      closePassDlg();
    });
    $('pass-dlg').addEventListener('click', function (e) { if (e.target === this) closePassDlg(); });
    $('pass-dlg-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); confirmPassDlg(); }
      else if (e.key === 'Escape') { e.preventDefault(); closePassDlg(); }
    });
    refreshPassBtns();
    $('ac-cancel').addEventListener('click', cancelTask);
    $('ax-cancel').addEventListener('click', cancelTask);

    /* 进度回传 */
    bridge.onProgress(onProgress);

    /* 启动时确认 7z 引擎可用 */
    bridge.check7z().then(function (r) {
      if (r && r.ok) {
        $('ac-note').textContent = '7z 引擎已就绪（' + (r.version || '7-Zip') + '）';
      } else {
        engineOk = false;
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
      bumpOutName: bumpOutName,
      extractTargetText: extractTargetText,
      compressProgressText: compressProgressText,
      extractProgressText: extractProgressText,
      browseMeta: browseMeta,
      mtimeText: mtimeText,
      ARCHIVE_EXTS: ARCHIVE_EXTS
    }
  };
})();
