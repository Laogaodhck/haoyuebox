/* 照片工具子功能：图片转换（JPG / PNG / WebP 批量互转）
 * 纯本地实现：解码、重绘与编码全部在本机完成，不上传任何数据。
 * 多张转换结果打包为单个 ZIP（复用 js/zip.js），仅弹出一次保存对话框。
 */
(function () {
  'use strict';

  var FMTS = {
    jpeg: { ext: 'jpg', mime: 'image/jpeg', fill: true, quality: true },
    png:  { ext: 'png', mime: 'image/png', fill: false, quality: false },
    webp: { ext: 'webp', mime: 'image/webp', fill: false, quality: true }
  };

  var items = [];      // [{file, name, w, h, url, outName}]
  var running = false;

  var $ = window.App.ui.$;
  function toast(msg, isErr) { window.App.ui.toast(msg, isErr); }

  /* ================= 纯逻辑（可单测） ================= */

  // 质量百分比钳制到 50–100（非法输入回退下限）
  function clampQuality(pct) {
    pct = Math.round(+pct || 0);
    return Math.min(100, Math.max(50, pct));
  }

  // 生成输出文件名：替换原扩展名为目标格式；与已用名冲突时追加 (2)、(3)…
  function buildOutputName(origName, fmt, used) {
    var base = (origName || '').replace(/\.[^.]+$/, '') || '图片';
    var ext = FMTS[fmt] ? FMTS[fmt].ext : 'png';
    var name = base + '.' + ext;
    var n = 2;
    while (used[name]) {
      name = base + '(' + n + ').' + ext;
      n++;
    }
    used[name] = true;
    return name;
  }

  /* ================= 列表管理 ================= */

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) {
      return f && /^image\//.test(f.type);
    });
    if (!files.length) { toast('请选择图片文件（JPG/PNG/WebP 等）', true); return; }
    var chain = Promise.resolve();
    var failed = 0;
    files.forEach(function (file) {
      chain = chain.then(function () {
        return createImageBitmap(file).catch(function () { return null; });
      }).then(function (bmp) {
        if (!bmp) { failed++; return; } // HEIC 等浏览器无法解码的格式
        items.push({
          file: file,
          name: file.name || '图片',
          w: bmp.width,
          h: bmp.height,
          url: (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(file) : ''
        });
        if (bmp.close) bmp.close();
      });
    });
    chain.then(function () {
      if (failed) toast(failed + ' 个文件无法识别，已跳过', true);
      renderAll();
    });
  }

  function clearAll() {
    if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
      items.forEach(function (it) { try { URL.revokeObjectURL(it.url); } catch (e) { /* 忽略 */ } });
    }
    items = [];
    renderAll();
  }

  /* ================= 渲染 ================= */

  function renderAll() {
    var fmt = $('conv-fmt').value;
    var used = {};
    var tbody = $('conv-table').querySelector('tbody');
    tbody.textContent = '';
    items.forEach(function (it, i) {
      it.outName = buildOutputName(it.name, fmt, used);

      var tr = document.createElement('tr');

      var td1 = document.createElement('td');
      td1.textContent = String(i + 1);
      tr.appendChild(td1);

      var td2 = document.createElement('td');
      var img = document.createElement('img');
      img.className = 'batch-thumb';
      img.alt = '';
      if (it.url) img.src = it.url;
      td2.appendChild(img);
      tr.appendChild(td2);

      var td3 = document.createElement('td');
      td3.textContent = it.name;
      tr.appendChild(td3);

      var td4 = document.createElement('td');
      td4.textContent = it.w + '×' + it.h;
      tr.appendChild(td4);

      var td5 = document.createElement('td');
      td5.textContent = it.outName;
      tr.appendChild(td5);

      tbody.appendChild(tr);
    });
    $('conv-empty').hidden = items.length > 0;
    $('conv-list').hidden = items.length === 0;
    $('conv-count').textContent = items.length ? '已选择 ' + items.length + ' 张图片' : '未选择图片';
    $('conv-run').disabled = items.length === 0 || running;
  }

  /* ================= 转换与保存 ================= */

  /* 转换期间锁定全部会重建列表/表格的控件（与 compress.js 一致，防写错行/中途改参数） */
  function setControlsLocked(on) {
    ['conv-fmt', 'conv-quality', 'conv-bg', 'conv-pick', 'conv-clear', 'conv-file'].forEach(function (id) {
      $(id).disabled = on;
    });
  }

  async function run() {
    if (!items.length || running) return;
    var fmt = $('conv-fmt').value;
    var conf = FMTS[fmt] || FMTS.png;
    var quality = clampQuality($('conv-quality').value) / 100;
    var bg = $('conv-bg').value;
    running = true;
    $('conv-run').disabled = true;
    setControlsLocked(true);
    var zipFiles = [];
    var failed = [];
    // 已用名表：优先取 renderAll 生成的 outName，兜底命名时防重名
    var usedNames = {};
    items.forEach(function (x) { if (x.outName) usedNames[x.outName] = true; });
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      window.App.ui.showLoading('正在转换 ' + (i + 1) + '/' + items.length + ' …');
      try {
        var bmp = await createImageBitmap(it.file);
        var canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        var ctx = canvas.getContext('2d');
        if (conf.fill) { // JPG 不支持透明，先铺底色再绘制
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(bmp, 0, 0);
        if (bmp.close) bmp.close();
        var blob = await new Promise(function (res, rej) {
          canvas.toBlob(function (b) { b ? res(b) : rej(new Error('编码失败')); },
            conf.mime, conf.quality ? quality : undefined);
        });
        var data = new Uint8Array(await blob.arrayBuffer());
        // 兜底命名复用全局已用名表（防 outName 缺失时生成重名 ZIP 条目）
        zipFiles.push({ name: it.outName || buildOutputName(it.name, fmt, usedNames), data: data });
      } catch (e) {
        failed.push(it.name);
      }
    }
    window.App.ui.hideLoading();
    running = false;
    setControlsLocked(false);
    $('conv-run').disabled = items.length === 0;
    if (!zipFiles.length) { toast('转换失败：没有可输出的图片', true); renderAll(); return; }
    try {
      if (zipFiles.length === 1) {
        window.App.ui.download(new Blob([zipFiles[0].data], { type: conf.mime }), zipFiles[0].name);
      } else {
        var zip = await window.ZipUtil.store(zipFiles);
        window.App.ui.download(zip, '图片转换结果.zip');
      }
      toast('转换完成：成功 ' + zipFiles.length + ' 张' +
        (failed.length ? '，失败 ' + failed.length + ' 张（' + failed[0] + '）' : ''));
    } catch (e) {
      toast('保存失败：' + e.message, true);
    }
    renderAll();
  }

  /* ================= 事件绑定 ================= */

  // 整个子页支持拖入图片；拖拽悬停时占位框高亮
  function bindDrop(sectionId) {
    var sec = $(sectionId);
    var es = sec.querySelector('.empty-state');
    ['dragover', 'dragenter'].forEach(function (ev) {
      sec.addEventListener(ev, function (e) {
        e.preventDefault();
        if (es) es.classList.add('drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      sec.addEventListener(ev, function () { if (es) es.classList.remove('drag'); });
    });
    sec.addEventListener('drop', function (e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        addFiles(e.dataTransfer.files);
      }
    });
  }

  // 空态占位框点击 / 回车直接打开选图
  function bindEmptyPick(emptyId, inputId) {
    var el = $(emptyId);
    el.addEventListener('click', function () { $(inputId).click(); });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        $(inputId).click();
      }
    });
  }

  function init() {
    $('conv-pick').addEventListener('click', function () { $('conv-file').click(); });
    $('conv-file').addEventListener('change', function () {
      if (this.files && this.files.length) addFiles(this.files);
      this.value = '';
    });
    bindEmptyPick('conv-empty', 'conv-file');
    $('conv-fmt').addEventListener('change', function () {
      var conf = FMTS[this.value] || FMTS.png;
      $('conv-quality-row').hidden = !conf.quality;
      $('conv-bg-row').hidden = !conf.fill;
      renderAll(); // 目标格式变化会改变输出文件名
    });
    $('conv-quality').addEventListener('input', function () {
      $('conv-quality-val').textContent = this.value + '%';
    });
    $('conv-clear').addEventListener('click', clearAll);
    $('conv-run').addEventListener('click', run);
    $('conv-back').addEventListener('click', function () { window.App.photo.showPhotoSub('menu'); });
    bindDrop('photo-convert');
  }

  window.App = window.App || {};
  window.App.convert = {
    init: init,
    enter: function () { renderAll(); },
    // 以下导出仅供测试
    _test: {
      FMTS: FMTS,
      clampQuality: clampQuality,
      buildOutputName: buildOutputName
    }
  };
})();
