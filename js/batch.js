/* 批量工具模块：批量重命名（照片/文档等文件类型）
 * 纯本地实现：通过 File System Access API 直接重命名所选文件夹内的文件，
 * 不上传任何数据。桌面版（Electron/Chromium）完整支持。
 */
(function () {
  'use strict';

  var PHOTO_EXTS = ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'webp', 'tif', 'tiff', 'heic'];
  var DOC_EXTS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'wps', 'et', 'dps'];
  /* 文件名非法字符（含控制字符 \u0000-\u001f，Windows 命名规范禁用） */
  // eslint-disable-next-line no-control-regex
  var INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
  var RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

  var dirHandle = null;   // 当前文件夹句柄
  var plan = [];          // 当前重命名计划 [{old, handle, ext, autoName, custom, newName, status}]
  var customNames = {};   // 用户手动自定义的基础名 {原文件名: 自定义基础名}
  var planCache = null;   // 最近一次列目录结果 {files, allNames}，用于自定义名时免重读磁盘
  var thumbUrls = [];     // 已创建的缩略图 objectURL，重渲染前统一释放
  var lastCustomFocus = null; // 最近编辑的自定义输入框（重渲染后恢复焦点）
  var refreshTimer = null;
  var planTimer = null;

  var $ = window.App.ui.$;

  /* ================= 纯逻辑（可单测） ================= */

  // 校验基础名称：拒绝文件系统危险字符（Windows 保留字符 / 路径分隔符 / 控制字符）
  function validateBase(base) {
    base = (base || '').trim();
    if (!base) return { ok: false, msg: '基础名称不能为空' };
    if (INVALID_CHARS.test(base)) return { ok: false, msg: '基础名称包含非法字符（不能含有 \\ / : * ? " < > | 等）' };
    if (RESERVED_NAMES.test(base)) return { ok: false, msg: '基础名称使用了系统保留名（CON、PRN、NUL 等）' };
    if (/[. ]$/.test(base)) return { ok: false, msg: '基础名称不能以点或空格结尾' };
    if (base.length > 80) return { ok: false, msg: '基础名称过长（≤80 字符）' };
    return { ok: true };
  }

  // 解析自定义后缀输入："jpg, png;.PDF" -> ['jpg','png','pdf']
  function parseExts(str) {
    return (str || '').split(/[,;，；\s]+/)
      .map(function (s) { return s.replace(/^\.+/, '').toLowerCase(); })
      .filter(Boolean);
  }

  function padNum(n, digits) {
    var s = String(n);
    while (s.length < digits) s = '0' + s;
    return s;
  }

  // 构建重命名计划。files: [{name, handle}]；existsFn(name) 检查目标是否已存在
  // opts.custom: {原文件名: 自定义基础名}，优先于规则自动生成的名称
  // 返回行 {old, handle, ext, autoName, custom, newName, status}
  // status: ok / same / exists / chain / dup / invalid
  function buildPlan(files, opts, existsFn) {
    var base = (opts.base || '').trim();
    var sep = opts.sep || '';
    var start = opts.start | 0;
    var digits = opts.digits | 0;
    var custom = opts.custom || {};

    var rows = files.map(function (f, i) {
      var dot = f.name.lastIndexOf('.');
      var ext = dot > 0 ? f.name.slice(dot) : ''; // 保留原后缀大小写
      var autoName = base + sep + padNum(start + i, digits);
      var customName = (custom[f.name] || '').trim();
      var baseName = customName || autoName;
      return {
        old: f.name,
        handle: f.handle,
        ext: ext,
        autoName: autoName,
        custom: customName,
        newName: baseName + ext,
        status: 'ok'
      };
    });

    var oldSet = {};   // 文件夹内现存的全部文件名
    var sameSet = {};  // 保持原名的行（其文件不会腾出名字）
    var newCount = {};
    files.forEach(function (f) { oldSet[f.name] = true; });

    rows.forEach(function (r) {
      if (r.newName === r.old) sameSet[r.old] = true;
      if (newCount[r.newName]) r.status = 'dup';
      newCount[r.newName] = true;
    });
    rows.forEach(function (r) {
      if (r.status !== 'ok') return;
      if (sameSet[r.old]) { r.status = 'same'; return; }
      var v = validateBase(r.custom || base); // 自定义名与规则名都需通过校验
      if (!v.ok || INVALID_CHARS.test(r.newName) || RESERVED_NAMES.test(r.custom || base)) { r.status = 'invalid'; return; }
      // 目标名是另一个「会被改名腾出」的源文件：链式冲突，顺序执行有覆盖风险
      if (oldSet[r.newName] && !sameSet[r.newName]) { r.status = 'chain'; return; }
      if (existsFn && existsFn(r.newName)) { r.status = 'exists'; }
    });
    return rows;
  }

  /* ================= 文件操作 ================= */

  // 自然排序：数字段按数值比较（a2 < a10），其余按码点，跨环境结果一致
  function naturalCmp(x, y) {
    var i = 0, j = 0;
    var D = /\d/;
    while (i < x.length && j < y.length) {
      if (D.test(x[i]) && D.test(y[j])) {
        var s = i, t = j;
        while (i < x.length && D.test(x[i])) i++;
        while (j < y.length && D.test(y[j])) j++;
        var nx = x.slice(s, i), ny = y.slice(t, j);
        var c = (parseInt(nx, 10) || 0) - (parseInt(ny, 10) || 0) || (nx.length - ny.length);
        if (c) return c;
      } else {
        if (x[i] !== y[j]) return x[i] < y[j] ? -1 : 1;
        i++; j++;
      }
    }
    return x.length - y.length;
  }

  async function listFiles(kind, customExts) {
    var wanted = null;
    if (kind === '照片') wanted = PHOTO_EXTS;
    else if (kind === '文档') wanted = DOC_EXTS;
    else if (kind === '自定义') wanted = parseExts(customExts);

    var jobs = [];
    var allNames = [];
    for await (var it of dirHandle.values()) {  
      if (it.kind !== 'file') continue;
      allNames.push(it.name);
      var ext = it.name.slice(it.name.lastIndexOf('.') + 1).toLowerCase();
      if (!wanted || wanted.indexOf(ext) >= 0) jobs.push({ name: it.name, handle: it });
    }
    jobs.sort(function (a, b) { return naturalCmp(a.name, b.name); });
    return { files: jobs, allNames: allNames };
  }

  // 重命名单个文件：优先原生 move（原子操作），否则流式复制后删除
  function renameOne(row) {
    if (typeof row.handle.move === 'function') {
      return row.handle.move(row.newName);
    }
    return dirHandle.getFileHandle(row.newName, { create: true }).then(function (dst) {
      return row.handle.getFile().then(function (file) {
        return dst.createWritable().then(function (w) {
          return file.stream().pipeTo(w);
        });
      });
    }).then(function () {
      return dirHandle.removeEntry(row.old);
    });
  }

  /* ================= UI ================= */

  function toast(msg, isErr) { window.App.ui.toast(msg, isErr); }

  var BATCH_PANELS = ['batch-rename', 'batch-format', 'batch-watermark', 'print-batch'];

  function showMenu() {
    $('batch-menu').hidden = false;
    BATCH_PANELS.forEach(function (p) { $(p).hidden = true; });
  }

  function showRename() {
    $('batch-menu').hidden = true;
    BATCH_PANELS.forEach(function (p) { $(p).hidden = (p !== 'batch-rename'); });
  }

  // 子面板通用切换：显示指定面板（null=返回菜单），其余全部收纳
  function showOnly(panelId) {
    $('batch-menu').hidden = !!panelId;
    BATCH_PANELS.forEach(function (p) { $(p).hidden = (p !== panelId); });
  }

  function supported() {
    return typeof window.showDirectoryPicker === 'function';
  }

  function refreshRuleHint() {
    var base = $('batch-base').value.trim() || '文件';
    var ext = $('batch-kind').value === '自定义' ? '.pdf' : '.jpg';
    var hint = base + ($('batch-sep').value) + padNum(+$('batch-start').value || 1, +$('batch-digits').value || 3) + ext;
    var v = validateBase(base);
    $('batch-rule-hint').textContent = v.ok ? '示例：' + hint : v.msg;
    return v.ok;
  }

  // 缩略图点击放大：lightbox 显示原图（objectURL），点击任意处或按 Esc 关闭
  function openLightbox(src) {
    $('thumb-lightbox-img').src = src;
    $('thumb-lightbox').hidden = false;
  }

  function closeLightbox() {
    var box = $('thumb-lightbox');
    if (box.hidden) return;
    box.hidden = true;
    $('thumb-lightbox-img').removeAttribute('src'); // 释放大图引用
  }

  function statusText(s) {
    return { ok: '待重命名', same: '未变化', exists: '目标已存在', chain: '与源文件同名', dup: '名称重复', invalid: '名称非法' }[s] || s;
  }

  // 缩略图占位（无 src 时由 CSS 背景显示占位图形）
  var BLANK_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  var IMG_EXTS = { jpg: 1, jpeg: 1, png: 1, bmp: 1, gif: 1, webp: 1, tif: 1, tiff: 1, ico: 1, svg: 1, heic: 1 };

  function releaseThumbs() {
    if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
      thumbUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) { /* 忽略 */ } });
    }
    thumbUrls = [];
  }

  // 异步加载缩略图（objectURL 直接引用原文件）：图片后缀才尝试，失败静默保持占位。
  // 各过滤类型（全部/照片/自定义）下图片文件都加载，文档类型全是占位图。
  function loadThumbs() {
    if (typeof URL === 'undefined' || !URL.createObjectURL) return;
    plan.forEach(function (row) {
      if (!row.handle || !row.handle.getFile) return;
      if (!IMG_EXTS[(row.ext || '').toLowerCase().replace(/^\./, '')]) return;
      row.handle.getFile().then(function (f) {
        if (!f) return;
        var url = URL.createObjectURL(f);
        if (row._thumbEl && row._thumbEl.isConnected) {
          thumbUrls.push(url);
          row._thumbEl.src = url;
        } else {
          URL.revokeObjectURL(url); // 行已被重渲染替换，立即释放
        }
      }).catch(function () { /* 非图片或读取失败，保持占位 */ });
    });
  }

  function renderTable() {
    releaseThumbs();
    var tbody = $('batch-table').querySelector('tbody');
    tbody.textContent = '';
    var pending = 0;
    plan.forEach(function (row, i) {
      var tr = document.createElement('tr');

      var tdNum = document.createElement('td');
      tdNum.textContent = String(i + 1);
      tr.appendChild(tdNum);

      var tdThumb = document.createElement('td');
      var img = document.createElement('img');
      img.className = 'batch-thumb';
      img.alt = '';
      img.src = BLANK_SRC;
      row._thumbEl = img;
      tdThumb.appendChild(img);
      tr.appendChild(tdThumb);

      var tdOld = document.createElement('td');
      tdOld.textContent = row.old;
      tr.appendChild(tdOld);

      // 新文件名：输入框（留空=按规则自动编号）+ 原后缀
      var tdNew = document.createElement('td');
      var wrap = document.createElement('div');
      wrap.className = 'rename-cell';
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'rename-input';
      inp.spellcheck = false;
      inp.dataset.old = row.old;
      inp.value = row.custom;
      inp.placeholder = row.autoName;
      var ext = document.createElement('span');
      ext.className = 'ext-label';
      ext.textContent = row.ext || '（无后缀）';
      wrap.appendChild(inp);
      wrap.appendChild(ext);
      tdNew.appendChild(wrap);
      tr.appendChild(tdNew);

      var tdSt = document.createElement('td');
      tdSt.textContent = statusText(row.status);
      if (row.status === 'ok') { tdSt.className = 'st-ok'; pending++; }
      else if (row.status === 'same') tdSt.className = 'st-dim';
      else tdSt.className = 'st-bad';
      tr.appendChild(tdSt);

      tbody.appendChild(tr);
    });
    loadThumbs();
    if (lastCustomFocus) { // 恢复输入焦点，避免重渲染打断连续输入
      var target = null;
      tbody.querySelectorAll('input.rename-input').forEach(function (el) {
        if (el.dataset.old === lastCustomFocus) target = el;
      });
      if (target) {
        target.focus();
        try { target.setSelectionRange(target.value.length, target.value.length); } catch (e) { /* 忽略 */ }
      }
    }
    $('btn-batch-run').disabled = pending === 0;
    var bad = plan.length - pending - plan.filter(function (r) { return r.status === 'same'; }).length;
    $('batch-summary').textContent = plan.length
      ? '共 ' + plan.length + ' 个文件，待重命名 ' + pending + ' 个' + (bad ? '，冲突/异常 ' + bad + ' 个（红色行将跳过）' : '')
      : '';
  }

  // 仅依据缓存重建计划（自定义名输入时使用，不重新读磁盘）
  function rebuildPlanFromCache() {
    if (!planCache) { refreshPreview(); return; }
    var existing = {};
    planCache.allNames.forEach(function (n) { existing[n] = true; });
    plan = buildPlan(planCache.files, {
      base: $('batch-base').value,
      sep: $('batch-sep').value,
      start: +$('batch-start').value || 1,
      digits: +$('batch-digits').value || 3,
      custom: customNames
    }, function (name) { return existing[name]; });
    renderTable();
  }

  function schedulePlanRefresh() {
    clearTimeout(planTimer);
    planTimer = setTimeout(rebuildPlanFromCache, 200);
  }

  function refreshPreview() {
    releaseThumbs();
    var tbody = $('batch-table').querySelector('tbody');
    tbody.textContent = '';
    $('batch-summary').textContent = '';
    $('btn-batch-run').disabled = true;
    if (!dirHandle) { $('batch-empty').hidden = false; return Promise.resolve(); }
    $('batch-empty').hidden = true;

    if (!refreshRuleHint()) return Promise.resolve();
    return listFiles($('batch-kind').value, $('batch-custom-exts').value).then(function (res) {
      planCache = res;
      var files = res.files;
      if (!files.length) {
        planCache = null; plan = [];
        renderTable();
        $('batch-empty').hidden = false; $('batch-empty').textContent = '该文件夹内没有匹配类型的文件';
        return;
      }
      $('batch-empty').hidden = true;
      var existing = {};
      res.allNames.forEach(function (n) { existing[n] = true; });
      plan = buildPlan(files, {
        base: $('batch-base').value,
        sep: $('batch-sep').value,
        start: +$('batch-start').value || 1,
        digits: +$('batch-digits').value || 3,
        custom: customNames
      }, function (name) { return existing[name]; });
      renderTable();
    }).catch(function (e) { toast('读取文件夹失败：' + e.message, true); });
  }

  function onExecute() {
    var todo = plan.filter(function (r) { return r.status === 'ok'; });
    if (!todo.length) return;
    window.App.ui.confirm('确定将 ' + todo.length + ' 个文件按预览重命名吗？此操作不可自动撤销。')
      .then(function (ok) {
        if (!ok) return;
        executeRename(todo);
      });
  }

  function executeRename(todo) {
    var done = 0, failed = [];
    var chain = Promise.resolve();
    todo.forEach(function (row) {
      chain = chain.then(function () {
        return renameOne(row).then(function () { done++; }, function (e) { failed.push(row.old + '（' + e.message + '）'); });
      });
    });
    chain.then(function () {
      if (failed.length) toast('重命名完成：成功 ' + done + ' 个，失败 ' + failed.length + ' 个：' + failed[0], true);
      else toast('重命名完成：成功 ' + done + ' 个');
      customNames = {}; // 已改名的文件不再保留自定义项
      lastCustomFocus = null;
      refreshPreview();
    });
  }

  function pickFolder() {
    window.showDirectoryPicker({ mode: 'readwrite' }).then(function (h) {
      dirHandle = h;
      $('batch-folder').textContent = '已选择：' + h.name;
      refreshPreview();
    }).catch(function () { /* 用户取消 */ });
  }

  // 清空：释放缩略图缓存（objectURL）、关闭大图预览、清空计划与自定义名、退出文件夹
  function clearAll() {
    dirHandle = null;
    planCache = null;
    plan = [];
    customNames = {};
    lastCustomFocus = null;
    closeLightbox(); // 其大图引用即将被释放的 objectURL，先关闭
    releaseThumbs();
    $('batch-folder').textContent = '未选择文件夹';
    refreshPreview(); // dirHandle 为空 → 清空表格并回到「请先选择文件夹」
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshPreview, 200);
  }

  function init() {
    if (!supported()) {
      $('batch-unsupported').hidden = false;
      $('batch-pick').disabled = true;
    }
    $('batch-open-rename').addEventListener('click', function () {
      showRename();
      if (dirHandle) refreshPreview();
    });
    $('btn-batch-back').addEventListener('click', showMenu);
    $('batch-pick').addEventListener('click', pickFolder);
    $('batch-kind').addEventListener('change', function () {
      $('batch-custom-row').hidden = this.value !== '自定义';
      if (dirHandle) scheduleRefresh();
    });
    ['batch-custom-exts', 'batch-base', 'batch-start', 'batch-digits'].forEach(function (id) {
      $(id).addEventListener('input', function () { if (dirHandle) scheduleRefresh(); });
    });
    $('batch-sep').addEventListener('change', function () { if (dirHandle) refreshPreview(); });
    $('btn-batch-refresh').addEventListener('click', function () {
      if (!dirHandle) { toast('请先选择文件夹', true); return; }
      refreshPreview();
    });
    $('btn-batch-clear').addEventListener('click', clearAll);
    // 新文件名输入框：自定义名（留空=按规则自动编号），防抖后仅用缓存重建计划
    $('batch-table').querySelector('tbody').addEventListener('input', function (e) {
      var inp = e.target;
      if (!inp.classList || !inp.classList.contains('rename-input')) return;
      customNames[inp.dataset.old] = inp.value;
      lastCustomFocus = inp.dataset.old;
      schedulePlanRefresh();
    });
    // 点击缩略图放大预览（占位图给出提示）；lightbox 点击任意处或 Esc 关闭
    $('batch-table').querySelector('tbody').addEventListener('click', function (e) {
      var img = e.target;
      if (!img.classList || !img.classList.contains('batch-thumb')) return;
      var src = img.getAttribute('src');
      if (!src || src === BLANK_SRC) { toast('该文件无法预览（缩略图不可用）', true); return; }
      openLightbox(src);
    });
    $('thumb-lightbox').addEventListener('click', closeLightbox);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeLightbox();
    });
    $('btn-batch-run').addEventListener('click', onExecute);
  }

  window.App = window.App || {};
  window.App.batch = {
    init: init,
    enter: showMenu,
    showOnly: showOnly,
    // 以下导出仅供测试
    _test: {
      validateBase: validateBase,
      parseExts: parseExts,
      buildPlan: buildPlan,
      padNum: padNum,
      thumbCacheSize: function () { return thumbUrls.length; }
    }
  };
})();
