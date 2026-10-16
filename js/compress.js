/* 照片工具子功能：图片压缩 / 尺寸调整
 * 纯本地实现：解码、缩放与编码全部在本机完成，不上传任何数据。
 * 与「图片转换」共享 canvas 管线形态；核心差异：按质量重编码 + 最长边等比缩小
 * （只缩不放），并逐张对比压缩前后体积。多张结果打包为 ZIP。
 */
(function () {
  'use strict';

  var OUT_FMTS = {
    keep: null,                                  // 保持原格式：按源文件 MIME 输出
    jpeg: { ext: 'jpg', mime: 'image/jpeg', fill: true },
    webp: { ext: 'webp', mime: 'image/webp', fill: false }
  };

  var items = [];      // [{file, name, mime, w, h, size, url, outName, outSize, outW, outH}]
  var running = false;

  var $ = window.App.ui.$;
  function toast(msg, isErr) { window.App.ui.toast(msg, isErr); }

  /* ================= 纯逻辑（可单测） ================= */

  // 质量百分比钳制到 50–100（非法输入回退 80，越界值钳到边界）
  function clampQuality(pct) {
    pct = Math.round(+pct || 0);
    if (!(pct > 0 && pct <= 1000)) return 80;
    return Math.min(100, Math.max(50, pct));
  }

  // 最长边限制下的等比目标尺寸：只缩不放；maxEdge 非正数视为不限制
  function computeTargetSize(w, h, maxEdge) {
    w = Math.max(1, Math.round(+w || 0));
    h = Math.max(1, Math.round(+h || 0));
    maxEdge = Math.round(+maxEdge || 0);
    if (maxEdge <= 0) return { w: w, h: h };
    var longest = Math.max(w, h);
    if (longest <= maxEdge) return { w: w, h: h };
    var k = maxEdge / longest;
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }

  // 输出扩展名：keep 沿用原扩展名（无扩展名回退 jpg），否则按目标格式
  function pickExt(origName, fmt) {
    if (fmt === 'jpeg') return 'jpg';
    if (fmt === 'webp') return 'webp';
    var m = /\.(jpe?g|png|webp|bmp|gif)$/i.exec(origName || '');
    return m ? m[1].toLowerCase().replace(/^jpeg$/, 'jpg') : 'jpg';
  }

  // 输出 MIME：keep 时沿用源 MIME（未知回退 image/jpeg），否则按目标格式
  function pickMime(origMime, fmt) {
    if (fmt !== 'keep') return (OUT_FMTS[fmt] || {}).mime || 'image/jpeg';
    return /^image\/(jpeg|png|webp)$/.test(origMime || '') ? origMime : 'image/jpeg';
  }

  // 生成输出文件名：替换扩展名；与已用名冲突时追加 (2)、(3)…
  function buildOutputName(origName, fmt, used) {
    var base = (origName || '').replace(/\.[^.]+$/, '') || '图片';
    var ext = pickExt(origName, fmt);
    var name = base + '.' + ext;
    var n = 2;
    while (used[name]) {
      name = base + '(' + n + ').' + ext;
      n++;
    }
    used[name] = true;
    return name;
  }

  // 字节数人性化显示
  function formatBytes(n) {
    n = Math.max(0, Math.round(+n || 0));
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
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
        if (!bmp) { failed++; return; }
        items.push({
          file: file,
          name: file.name || '图片',
          mime: file.type || '',
          w: bmp.width,
          h: bmp.height,
          size: file.size || 0,
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
    var fmt = $('cmp-fmt').value;
    var used = {};
    var tbody = $('cmp-table').querySelector('tbody');
    tbody.textContent = '';
    items.forEach(function (it, i) {
      it.outName = buildOutputName(it.name, fmt, used);
      var target = computeTargetSize(it.w, it.h, $('cmp-maxedge').value);
      it.outW = target.w;
      it.outH = target.h;
      it.outSize = null;   // 重新渲染意味着设置变化，旧的压缩结果作废

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
      td5.textContent = target.w + '×' + target.h;
      tr.appendChild(td5);

      var td6 = document.createElement('td');
      td6.textContent = formatBytes(it.size);
      tr.appendChild(td6);

      var td7 = document.createElement('td');
      td7.textContent = '—';
      td7.dataset.role = 'out-size';
      tr.appendChild(td7);

      tbody.appendChild(tr);
    });
    $('cmp-empty').hidden = items.length > 0;
    $('cmp-list').hidden = items.length === 0;
    $('cmp-count').textContent = items.length ? '已选择 ' + items.length + ' 张图片' : '未选择图片';
    $('cmp-run').disabled = items.length === 0 || running;
  }

  // 压缩完成后把第 idx 行（0 起）的输出体积与降幅写回表格
  function writeOutSize(idx, outSize, saved) {
    var rows = $('cmp-table').querySelectorAll('tbody tr');
    var cell = rows[idx] && rows[idx].querySelector('[data-role="out-size"]');
    if (cell) cell.textContent = formatBytes(outSize) + (saved > 0 ? '（-' + saved + '%）' : saved === 0 ? '（持平）' : '（+' + (-saved) + '%）');
  }

  /* ================= 压缩与保存 ================= */

  async function run() {
    if (!items.length || running) return;
    var fmt = $('cmp-fmt').value;
    var quality = clampQuality($('cmp-quality').value) / 100;
    var maxEdge = Math.round(+$('cmp-maxedge').value || 0);
    running = true;
    $('cmp-run').disabled = true;
    var zipFiles = [];
    var failed = [];
    var savedTotal = 0, beforeTotal = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      window.App.ui.showLoading('正在压缩 ' + (i + 1) + '/' + items.length + ' …');
      try {
        var bmp = await createImageBitmap(it.file);
        var target = computeTargetSize(bmp.width, bmp.height, maxEdge);
        var canvas = document.createElement('canvas');
        canvas.width = target.w;
        canvas.height = target.h;
        var ctx = canvas.getContext('2d');
        var mime = pickMime(it.mime, fmt);
        var conf = fmt === 'keep'
          ? { fill: false, qualityable: mime !== 'image/png' }
          : (OUT_FMTS[fmt] || OUT_FMTS.jpeg);
        if (conf.fill) { // JPG 不支持透明，先铺白底再绘制
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(bmp, 0, 0, target.w, target.h);
        if (bmp.close) bmp.close();
        var blob = await new Promise(function (res, rej) {
          canvas.toBlob(function (b) { b ? res(b) : rej(new Error('编码失败')); },
            mime, conf.qualityable ? quality : undefined);
        });
        var data = new Uint8Array(await blob.arrayBuffer());
        it.outSize = data.length;
        beforeTotal += it.size;
        savedTotal += it.size - data.length;
        zipFiles.push({ name: it.outName || buildOutputName(it.name, fmt, {}), data: data });
        writeOutSize(i, data.length, it.size > 0 ? Math.round((1 - data.length / it.size) * 100) : 0);
      } catch (e) {
        failed.push(it.name);
      }
    }
    window.App.ui.hideLoading();
    running = false;
    $('cmp-run').disabled = items.length === 0;
    if (!zipFiles.length) { toast('压缩失败：没有可输出的图片', true); return; }
    var savedPct = beforeTotal > 0 ? Math.round(savedTotal / beforeTotal * 100) : 0;
    try {
      if (zipFiles.length === 1) {
        window.App.ui.download(new Blob([zipFiles[0].data], { type: 'image/*' }), zipFiles[0].name);
      } else {
        var zip = await window.ZipUtil.store(zipFiles);
        window.App.ui.download(zip, '图片压缩结果.zip');
      }
      toast('压缩完成：成功 ' + zipFiles.length + ' 张，共节省 ' + formatBytes(Math.max(0, savedTotal)) +
        (savedPct > 0 ? '（-' + savedPct + '%）' : '') +
        (failed.length ? '；失败 ' + failed.length + ' 张（' + failed[0] + '）' : ''));
    } catch (e) {
      toast('保存失败：' + e.message, true);
    }
    renderAll();
  }

  /* ================= 事件绑定 ================= */

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
    $('cmp-pick').addEventListener('click', function () { $('cmp-file').click(); });
    $('cmp-file').addEventListener('change', function () {
      if (this.files && this.files.length) addFiles(this.files);
      this.value = '';
    });
    bindEmptyPick('cmp-empty', 'cmp-file');
    $('cmp-fmt').addEventListener('change', renderAll);
    $('cmp-maxedge').addEventListener('change', renderAll);
    $('cmp-quality').addEventListener('input', function () {
      $('cmp-quality-val').textContent = this.value + '%';
    });
    $('cmp-clear').addEventListener('click', clearAll);
    $('cmp-run').addEventListener('click', run);
    $('cmp-back').addEventListener('click', function () { window.App.photo.showPhotoSub('menu'); });
    bindDrop('photo-compress');
  }

  window.App = window.App || {};
  window.App.compress = {
    init: init,
    enter: function () { renderAll(); },
    // 以下导出仅供测试
    _test: {
      clampQuality: clampQuality,
      computeTargetSize: computeTargetSize,
      pickExt: pickExt,
      pickMime: pickMime,
      buildOutputName: buildOutputName,
      formatBytes: formatBytes
    }
  };
})();
