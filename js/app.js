/* ============================================================
 * app.js — 核心状态 + 照片流程：上传 → 抠图换底 → 规格调整 → 导出
 * 排版流程见 sheet.js，直接打印见 print.js，设置持久化见 settings.js。
 * ============================================================ */
'use strict';

window.App = (function () {

  /* ================= 全局状态 ================= */
  var State = {
    originalImg: null,
    sourceName: '',         // 原始文件名（去扩展名），用于导出命名
    workCanvas: null,
    baseCanvas: null,       // 分割原始基准图（美白重算的来源，只读）
    skin: null,             // 皮肤置信度 Float32Array（工作图尺寸；多分类模型才有）
    whiten: 0,              // 皮肤美白强度 0..100
    tilt: 0,                // 人像倾斜校正角度（度，±15；绕工作图中心旋转）
    maskCanvas: null,
    initialMask: null,      // 自动抠图初始蒙版（Brush.snapMask 快照）
    bg: '#FFFFFF',
    brushMode: 'restore',   // restore=修补 erase=擦除
    brushSize: 30,          // 显示像素（按比例换算工作图坐标）
    spec: window.SPECS[0],
    outW: 295,
    outH: 413,
    transform: null,        // {scale, tx, ty}  work → 输出画框
    matteView: null,        // 抠图步骤视图 {zoom, panX, panY}（zoom 相对适配比例）
    viewTf: null,           // 抠图视图合成变换 work → 画布 px（供笔刷坐标映射）
    fmt: 'png',
    quality: 0.92,
    appVersion: '',         // 真实应用版本（桌面版经 IPC，浏览器版留空走 HTML 文案）
    upgradedFrom: '',       // 本次启动若为升级首启，记录来源版本（诊断/展示用）
    undoStack: []
  };

  var $ = function (id) { return document.getElementById(id); };
  var cropperApi = null;
  var matteViewApi = null;
  var renderPending = false;

  /* ================= 步骤切换 ================= */
  var STEP_ORDER = ['upload', 'matte', 'spec', 'export'];

  function showStep(name) {
    for (var i = 0; i < STEP_ORDER.length; i++) {
      var s = STEP_ORDER[i];
      $('step-' + s).classList.toggle('active', s === name);
      var chip = document.querySelector('.step[data-step="' + s + '"]');
      if (chip) {
        chip.classList.toggle('active', s === name);
        chip.classList.toggle('done', STEP_ORDER.indexOf(s) < STEP_ORDER.indexOf(name));
      }
    }
    if (name === 'spec') enterSpecStep();
    if (name === 'export') enterExportStep();
  }

  /* ================= 通用 UI ================= */
  var loadingEl = $('loading');
  function showLoading(text) {
    loadingEl.querySelector('span').textContent = text || '处理中…';
    loadingEl.hidden = false;
  }
  function hideLoading() { loadingEl.hidden = true; }

  function toast(msg, isError, iconName) {
    var t = $('toast');
    t.textContent = '';
    if (iconName) t.appendChild(makeIcon(iconName)); // 成功/警示标识走 SVG（同 statusText）
    t.appendChild(document.createTextNode(msg));
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.className = 'toast'; }, 2600);
  }

  /* 通用确认对话框：Promise 化，替代原生 window.confirm（风格与应用一致）。
     返回 true（确定）/ false（取消或 Esc）。支持多行文案（\n 渲染为换行）。 */
  function confirm(message) {
    return new Promise(function (resolve) {
      var dlg = $('confirm-dlg');
      var msg = $('confirm-msg');
      var okBtn = $('confirm-ok');
      var cancelBtn = $('confirm-cancel');
      msg.textContent = message;
      dlg.hidden = false;
      function done(val) {
        dlg.hidden = true;
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
        resolve(val);
      }
      function onOk() { done(true); }
      function onCancel() { done(false); }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        else if (e.key === 'Enter') { e.preventDefault(); done(true); }
      }
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
      okBtn.focus();
    });
  }

  function download(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 800);
  }

  /* ================= 步骤 1：上传 ================= */
  function loadFile(file) {
    if (!file || !/^image\//.test(file.type)) {
      toast('请选择图片文件（JPG/PNG）', true);
      return;
    }
    // 记录原始文件名（去扩展名），导出时沿用
    State.sourceName = (file.name || '').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_') || '证件照';
    showLoading('正在加载 AI 人像分割模型…');

    var imgPromise;
    if (window.createImageBitmap) {
      imgPromise = createImageBitmap(file, { imageOrientation: 'from-image' });
    } else {
      imgPromise = new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = reject;
        img.src = url;
      });
    }

    imgPromise.then(function (img) {
      State.originalImg = img;
      return window.Matting.segment(img, showLoading); // 分割进度实时显示在遮罩上
    }).then(function (r) {
      State.workCanvas = r.workCanvas;
      /* 美白基准：独立克隆副本（与 workCanvas 同对象会让 clearRect+自绘
       * 清空整幅位图——canvas 自绘读取的是调用时刻的快照） */
      State.baseCanvas = document.createElement('canvas');
      State.baseCanvas.width = r.workCanvas.width;
      State.baseCanvas.height = r.workCanvas.height;
      State.baseCanvas.getContext('2d').drawImage(r.workCanvas, 0, 0);
      State.skin = r.skin || null;
      State.maskCanvas = r.maskCanvas;
      State.undoStack = [];
      State.initialMask = window.Brush.snapMask(State);
      State.bg = '#FFFFFF';
      State.tilt = 0;                                  // 新照片重置倾斜校正
      State.matteView = { zoom: 1, panX: 0, panY: 0 }; // 新照片重置视图
      initWhitenUI();
      syncTiltUI();
      applyWhiten();                     // 按已保存的美白偏好重算（0 值时零开销直通）
      if (matteViewApi) matteViewApi.fit();
      syncBgSwatches();
      renderMatteView();
      hideLoading();
      showStep('matte');
    }).catch(function (err) {
      hideLoading();
      console.error(err);
      toast('处理失败：' + err.message, true);
    });
  }

  function initUpload() {
    var fileInput = $('file-input');
    var dropzone = $('dropzone');
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
      fileInput.value = '';
    });
    dropzone.addEventListener('click', function () { fileInput.click(); });
    // 键盘激活（与 role="button" 语义一致）：Enter / Space 打开文件选择
    dropzone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });
    ['dragover', 'dragenter'].forEach(function (ev) {
      dropzone.addEventListener(ev, function (e) {
        e.preventDefault();
        dropzone.classList.add('drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dropzone.addEventListener(ev, function (e) {
        e.preventDefault();
        dropzone.classList.remove('drag');
      });
    });
    dropzone.addEventListener('drop', function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });
    // 支持粘贴截图（仅证照生成流程可见时响应，避免在其他子功能页误触发）
    window.addEventListener('paste', function (e) {
      if (document.body.dataset.module !== 'photo' ||
          document.body.dataset.photoSub !== 'idphoto') return;
      if (e.clipboardData && e.clipboardData.files && e.clipboardData.files[0]) {
        loadFile(e.clipboardData.files[0]);
      }
    });
  }

  /* ================= 步骤 2：抠图换底 ================= */

  /* ---------- 皮肤美白：基准图 + 皮肤置信度 → 重算工作图 ---------- */
  var whitenPending = false;
  function applyWhiten() {
    if (!State.baseCanvas || !State.workCanvas) return;
    var dst = State.workCanvas;
    var ctx = dst.getContext('2d');
    /* 基准图为整幅不透明照片，直接覆盖绘制（无需 clear） */
    ctx.drawImage(State.baseCanvas, 0, 0);
    var strength = State.whiten / 100 * 0.5;   // 滑块 100 → Screen 混合上限 0.5
    if (strength > 0 && State.skin) {
      var img = ctx.getImageData(0, 0, dst.width, dst.height);
      window.Matting.whitenData(img.data, State.skin, strength);
      ctx.putImageData(img, 0, 0);
    }
    State._workRev = (State._workRev || 0) + 1;  // 失效合成引擎的工作图层缓存
    renderMatteView();
  }
  function scheduleWhiten() {
    /* 滑块拖动高频触发：rAF 合帧，一帧只重算一次 */
    if (whitenPending) return;
    whitenPending = true;
    requestAnimationFrame(function () {
      whitenPending = false;
      applyWhiten();
    });
  }
  function initWhitenUI() {
    /* 新照片就绪后同步滑块；回退到二/三分类模型时无皮肤数据则禁用 */
    var range = $('whiten-range');
    var supported = !!State.skin;
    range.disabled = !supported;
    $('whiten-field').title = supported ? '' : '当前分割模型不支持皮肤识别，美白不可用';
    range.value = State.whiten;
    $('whiten-val').textContent = State.whiten;
  }

  /* ---------- 人像倾斜校正：合成管线级旋转（不改工作图与蒙版数据） ---------- */
  var tiltPending = false;
  function scheduleTiltRender() {
    /* 滑块拖动高频触发：rAF 合帧，一帧只全量重绘一次（倾斜影响全图） */
    if (tiltPending) return;
    tiltPending = true;
    requestAnimationFrame(function () {
      tiltPending = false;
      renderMatteView();
    });
  }
  function syncTiltUI() {
    $('tilt-range').value = State.tilt;
    $('tilt-val').textContent = State.tilt + '°';
  }

  function matteViewSize() {
    var work = State.workCanvas;
    var maxV = 900;
    var k = Math.min(1, maxV / Math.max(work.width, work.height));
    return { w: Math.round(work.width * k), h: Math.round(work.height * k) };
  }

  function renderMatteView(dirtyWork) {
    if (!State.workCanvas) return;
    var canvas = $('matte-view');
    var size = matteViewSize();
    if (canvas.width !== size.w || canvas.height !== size.h) {
      canvas.width = size.w;
      canvas.height = size.h;
    }
    var mv = State.matteView || { zoom: 1, panX: 0, panY: 0 };
    var k = size.w / State.workCanvas.width;
    var tf = { scale: k * mv.zoom, tx: mv.panX, ty: mv.panY, rot: (State.tilt || 0) * Math.PI / 180 };
    State.viewTf = tf;
    var ctx = canvas.getContext('2d');

    // 脏区（工作图坐标）→ 输出坐标矩形，外扩 2px 防锯齿边缘残留；无效则全量重绘
    var dirty = null;
    if (dirtyWork) {
      var x0 = Math.floor(dirtyWork.x0 * tf.scale + tf.tx) - 2;
      var y0 = Math.floor(dirtyWork.y0 * tf.scale + tf.ty) - 2;
      var x1 = Math.ceil(dirtyWork.x1 * tf.scale + tf.tx) + 2;
      var y1 = Math.ceil(dirtyWork.y1 * tf.scale + tf.ty) + 2;
      x0 = Math.max(0, x0); y0 = Math.max(0, y0);
      x1 = Math.min(canvas.width, x1); y1 = Math.min(canvas.height, y1);
      if (x1 > x0 && y1 > y0 && (x1 - x0) * (y1 - y0) < canvas.width * canvas.height * 0.7) {
        dirty = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
    }
    window.Composer.compositeInto(
      ctx, size.w, size.h,
      Object.assign({}, State, { transform: tf }),
      dirty
    );
    // 缩放/平移/倾斜后用虚线标出照片边界（视口外的区域与底色同色，需边界提示）
    // 脏区局部重绘时跳过虚线（笔画结束后会做一次全量重绘补齐）
    if (!dirty && (mv.zoom > 1 || mv.panX || mv.panY || State.tilt)) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1 / tf.scale;
      ctx.setLineDash([6 / tf.scale, 4 / tf.scale]);
      ctx.translate(tf.tx, tf.ty);
      ctx.scale(tf.scale, tf.scale);
      if (tf.rot) {
        ctx.translate(State.workCanvas.width / 2, State.workCanvas.height / 2);
        ctx.rotate(tf.rot);
        ctx.translate(-State.workCanvas.width / 2, -State.workCanvas.height / 2);
      }
      ctx.strokeRect(0.5, 0.5, State.workCanvas.width - 1, State.workCanvas.height - 1);
      ctx.restore();
    }
  }

  /* 笔刷每次落笔上报脏区（工作图坐标），同一帧内的多段合并成一个矩形，
     rAF 到期只对并集做局部合成——拖拽时每帧开销从全画布 5 次绘制降到小矩形 */
  var pendingDirty = null;
  function unionDirty(a, b) {
    if (!a) return b;
    if (!b) return a;
    return {
      x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
      x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1)
    };
  }
  function scheduleMatteRender(dirty) {
    pendingDirty = unionDirty(pendingDirty, dirty || null);
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(function () {
      renderPending = false;
      var d = pendingDirty;
      pendingDirty = null;
      renderMatteView(d);
    });
  }

  /* 撤销快照只存单通道蒙版 alpha（1 字节/像素，蒙版本身只有白+alpha），
     并按像素总量限制层数：RGBA ImageData 每层 4 字节，1600×1600 下 12 层要吃 120MB */
  var UNDO_BUDGET = 16 * 1024 * 1024;

  function pushUndo(snap) {
    State.undoStack.push(snap || window.Brush.snapMask(State));
    var px = State.maskCanvas.width * State.maskCanvas.height;
    var max = Math.max(3, Math.min(12, Math.floor(UNDO_BUDGET / px)));
    while (State.undoStack.length > max) State.undoStack.shift();
  }

  function undoMask() {
    var snap = State.undoStack.pop();
    if (!snap) { toast('没有可撤销的操作'); return; }
    window.Brush.restoreMask(State, snap);
    renderMatteView();
  }

  function resetMask() {
    if (!State.initialMask) return;
    window.Brush.restoreMask(State, State.initialMask);
    State.undoStack = [];
    renderMatteView();
  }

  function initMatte() {
    // 笔刷
    window.Brush.attach($('matte-view'), State, {
      onStrokeStart: pushUndo,
      onChange: scheduleMatteRender,
      onStrokeEnd: function () { renderMatteView(); }
    });

    // 画布自由缩放/平移：滚轮锚点缩放、双指捏合、空格/中键拖动平移
    matteViewApi = window.MatteView.attach($('matte-view'), State, {
      onChange: scheduleMatteRender,
      onZoom: function (pct) { $('mv-zoom-label').textContent = pct + '%'; },
      isActive: function () { return $('step-matte').classList.contains('active'); },
      onPanMode: function () { /* 平移状态由 MatteView 内部管理，此钩子预留给 UI 联动 */ }
    });
    $('mv-zoom-in').addEventListener('click', function () { matteViewApi.zoomStep(1.25); });
    $('mv-zoom-out').addEventListener('click', function () { matteViewApi.zoomStep(1 / 1.25); });
    $('mv-zoom-fit').addEventListener('click', function () { matteViewApi.fit(); });

    // 笔刷尺寸光标环由 brush.js 实现（.brush-ring，直径恒等于笔刷显示像素，
    // 含擦除/修补配色与平移隐藏），此处不再单独维护 #brush-cursor

    // 工具切换
    var btns = document.querySelectorAll('#tool-group button');
    btns.forEach(function (b) {
      b.addEventListener('click', function () {
        State.brushMode = b.dataset.mode;
        btns.forEach(function (x) { x.classList.toggle('active', x === b); });
      });
    });

    $('brush-size').addEventListener('input', function () {
      State.brushSize = +this.value;
      $('brush-size-val').textContent = this.value + 'px';
    });

    // 皮肤美白：input 实时预览（rAF 合帧重算），change 记住偏好
    $('whiten-range').addEventListener('input', function () {
      State.whiten = Math.min(100, Math.max(0, Math.round(+this.value || 0)));
      $('whiten-val').textContent = State.whiten;
      scheduleWhiten();
    });
    $('whiten-range').addEventListener('change', function () {
      window.App.settings.save();
    });

    // 人像倾斜校正：实时预览；若已进入过规格步骤，同步钳制裁剪变换防露底色
    $('tilt-range').addEventListener('input', function () {
      State.tilt = Math.min(15, Math.max(-15, Math.round((+this.value || 0) * 2) / 2));
      this.value = State.tilt;
      syncTiltUI();
      scheduleTiltRender();
      if (State.transform) window.Cropper.clampTransform(State);
    });
    $('btn-tilt-reset').addEventListener('click', function () {
      if (!State.tilt) return;
      State.tilt = 0;
      syncTiltUI();
      renderMatteView();
    });

    $('btn-undo').addEventListener('click', undoMask);
    $('btn-reset-mask').addEventListener('click', resetMask);
    $('btn-resegment').addEventListener('click', function () {
      resetMask();
      toast('已重新应用自动抠图结果');
    });

    // 背景色
    document.querySelectorAll('.swatch').forEach(function (s) {
      s.addEventListener('click', function () {
        State.bg = s.dataset.color;
        syncBgSwatches();
        renderMatteView();
        window.App.settings.save();
      });
    });
    $('custom-bg').addEventListener('input', function () {
      State.bg = this.value;
      document.querySelectorAll('.swatch').forEach(function (x) { x.classList.remove('active'); });
      renderMatteView();
      window.App.settings.save();
    });

    $('btn-to-spec').addEventListener('click', function () { showStep('spec'); });
    $('btn-back-upload').addEventListener('click', function () { showStep('upload'); });

    // 键盘快捷键（仅抠图步骤生效）：Ctrl+Z 撤销、[ ] 调节笔刷大小
    document.addEventListener('keydown', function (e) {
      if (!$('step-matte').classList.contains('active')) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        undoMask();
      } else if (e.key === '[' || e.key === ']') {
        var size = Math.min(120, Math.max(4, State.brushSize + (e.key === ']' ? 4 : -4)));
        State.brushSize = size;
        $('brush-size').value = size;
        $('brush-size-val').textContent = size + 'px';
        e.preventDefault();
      }
    });
  }

  function syncBgSwatches() {
    document.querySelectorAll('.swatch').forEach(function (s) {
      s.classList.toggle('active', s.dataset.color.toLowerCase() === State.bg.toLowerCase());
    });
  }

  /* ================= 步骤 3：规格与裁剪 ================= */
  function enterSpecStep() {
    if (!State.transform) {
      applySpec(); // 首次进入：初始化画框并智能对齐
    } else {
      renderCrop();
      renderGuides();
    }
    updateSpecInfo();
  }

  function buildSpecGrid() {
    var grid = $('spec-grid');
    window.SPECS.forEach(function (sp) {
      var card = document.createElement('div');
      card.className = 'spec-card' + (sp.id === State.spec.id ? ' active' : '');
      card.dataset.id = sp.id;
      // 微缩比例示意
      var ratio = sp.pxW / sp.pxH;
      var boxH = 44;
      var boxW = Math.round(boxH * ratio);
      card.innerHTML =
        '<div class="spec-shape" style="width:' + boxW + 'px;height:' + boxH + 'px"></div>' +
        '<div class="spec-name">' + sp.name + '</div>' +
        '<div class="spec-desc">' + sp.desc + ' · ' + sp.pxW + '×' + sp.pxH + '</div>';
      card.addEventListener('click', function () {
        State.spec = sp;
        document.querySelectorAll('.spec-card').forEach(function (c) {
          c.classList.toggle('active', c.dataset.id === sp.id);
        });
        applySpec();
        window.App.settings.save();
      });
      grid.appendChild(card);
    });
  }

  function applySpec() {
    State.outW = State.spec.pxW;
    State.outH = State.spec.pxH;
    var canvas = $('crop-view');
    var guides = $('crop-guides');
    canvas.width = State.outW;
    canvas.height = State.outH;
    guides.width = State.outW;
    guides.height = State.outH;
    window.Cropper.autoAlign(State); // 智能对齐：头顶/下巴参考线一次到位
    renderCrop();
    renderGuides();
    updateSpecInfo();
    syncZoomSlider();
  }

  function renderCrop() {
    var canvas = $('crop-view');
    if (canvas.width !== State.outW) { canvas.width = State.outW; canvas.height = State.outH; }
    window.Composer.compositeInto(canvas.getContext('2d'), State.outW, State.outH, State);
  }

  function renderGuides() {
    var g = $('crop-guides');
    var ctx = g.getContext('2d');
    var h = State.spec.head;
    ctx.clearRect(0, 0, g.width, g.height);

    function line(yFrac, color, label, dash) {
      var y = Math.round(g.height * yFrac) + 0.5;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      if (dash) ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(g.width, y);
      ctx.stroke();
      ctx.font = '11px sans-serif';
      ctx.fillStyle = color;
      ctx.fillText(label, 4, y - 3);
      ctx.restore();
    }
    line(h.top, 'rgba(255,90,90,0.95)', '头顶线', true);
    line(h.eye, 'rgba(80,190,255,0.95)', '眼线', false);
    line(h.chin, 'rgba(255,200,80,0.95)', '下巴线', true);
  }

  function updateSpecInfo() {
    var sp = State.spec;
    $('spec-info').textContent =
      sp.name + ' · ' + sp.mmW + '×' + sp.mmH + 'mm · ' +
      sp.pxW + '×' + sp.pxH + 'px · ' + sp.dpi + ' DPI';
  }

  function syncZoomSlider() {
    var work = State.workCanvas;
    var minScale = Math.max(State.outW / work.width, State.outH / work.height);
    var v = Math.round((State.transform.scale / minScale) * 100);
    $('zoom').value = Math.min(500, Math.max(100, v));
  }

  function initSpec() {
    buildSpecGrid();
    cropperApi = window.Cropper.attach($('crop-view'), State, {
      onChange: function () {
        renderCrop();
        syncZoomSlider();
      }
    });

    $('zoom').addEventListener('input', function () {
      var work = State.workCanvas;
      var minScale = Math.max(State.outW / work.width, State.outH / work.height);
      var newScale = minScale * (+this.value / 100);
      var factor = newScale / State.transform.scale;
      cropperApi.zoomAt(State.outW / 2, State.outH / 2, factor);
      renderCrop();
    });

    $('btn-refit').addEventListener('click', function () {
      window.Cropper.autoAlign(State);
      renderCrop();
      syncZoomSlider();
    });

    $('btn-to-export').addEventListener('click', function () { showStep('export'); });
    $('btn-back-matte').addEventListener('click', function () { showStep('matte'); });
  }

  /* ================= 步骤 4：导出 ================= */
  function enterExportStep() {
    renderCrop();
    var c = $('export-preview');
    if (c.width !== State.outW || c.height !== State.outH) {
      c.width = State.outW;
      c.height = State.outH;
    }
    c.getContext('2d').drawImage($('crop-view'), 0, 0);
    window.App.print.refreshExportList(); // 刷新打印机列表

    var sp = State.spec;
    var layout = window.Composer.bestLayout(sp.pxW, sp.pxH);
    $('export-info').innerHTML =
      '规格 <b>' + sp.name + '</b>（' + sp.mmW + '×' + sp.mmH + 'mm） · ' +
      '成品 <b>' + sp.pxW + '×' + sp.pxH + 'px</b> · ' + sp.dpi + 'DPI' +
      '<br>六寸相纸（1800×1200px）可排 <b>' + layout.n + '</b> 张（' + layout.cols + '列×' + layout.rows + '行）';

    previewSheet();
  }

  function previewSheet() {
    var sp = State.spec;
    var result = window.Composer.buildSheet(State, sp);
    var c = $('sheet-preview');
    c.width = 600; c.height = 400;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#1a1d24';
    ctx.fillRect(0, 0, 600, 400);
    if (result) {
      ctx.drawImage(result.canvas, 0, 0, 600, 400);
    }
  }

  function makeSingleCanvas() {
    var c = document.createElement('canvas');
    c.width = State.outW; c.height = State.outH;
    window.Composer.compositeInto(c.getContext('2d'), State.outW, State.outH, State);
    return c;
  }

  async function exportSingle() {
    var sp = State.spec;
    var c = makeSingleCanvas();
    var baseName = State.sourceName || ('证件照_' + sp.name + '_' + sp.pxW + 'x' + sp.pxH);
    try {
      if (State.fmt === 'jpeg') {
        var blob = await new Promise(function (r) { c.toBlob(r, 'image/jpeg', State.quality); });
        var buf = window.DpiUtil.setJpegDpi(await blob.arrayBuffer(), sp.dpi);
        download(new Blob([buf], { type: 'image/jpeg' }), baseName + '.jpg');
      } else {
        var blob2 = await new Promise(function (r) { c.toBlob(r, 'image/png'); });
        var buf2 = window.DpiUtil.setPngDpi(await blob2.arrayBuffer(), sp.dpi);
        download(new Blob([buf2], { type: 'image/png' }), baseName + '.png');
      }
      toast('成品已保存（已写入 ' + sp.dpi + ' DPI）');
    } catch (e) {
      console.error(e);
      toast('导出失败：' + e.message, true);
    }
  }

  async function exportSheet() {
    var sp = State.spec;
    var result = window.Composer.buildSheet(State, sp);
    if (!result) { toast('排版失败', true); return; }
    var baseName = (State.sourceName || '证件照') + '_六寸相纸' + result.layout.n + '张';
    try {
      var blob = await new Promise(function (r) { result.canvas.toBlob(r, 'image/png'); });
      var buf = window.DpiUtil.setPngDpi(await blob.arrayBuffer(), 300);
      download(new Blob([buf], { type: 'image/png' }), baseName + '.png');
      toast('六寸排版已保存（' + result.layout.n + ' 张，含裁切线）');
    } catch (e) {
      console.error(e);
      toast('导出失败：' + e.message, true);
    }
  }

  function initExport() {
    document.querySelectorAll('input[name="fmt"]').forEach(function (r) {
      r.addEventListener('change', function () {
        State.fmt = this.value;
        $('quality-row').hidden = State.fmt !== 'jpeg';
        window.App.settings.save();
      });
    });
    $('quality').addEventListener('input', function () {
      State.quality = (+this.value) / 100; // toBlob 需要 0–1 小数
      $('quality-val').textContent = this.value + '%';
      window.App.settings.save();
    });
    $('btn-download-single').addEventListener('click', exportSingle);
    $('btn-download-sheet').addEventListener('click', exportSheet);

    // 直接打印：照片导出模块（打印单张成品）
    window.App.print.setupPanel('print-export', function () {
      if (!State.workCanvas || !State.transform) throw new Error('请先完成一张照片');
      return [makeSingleCanvas().toDataURL('image/png')];
    });
    $('btn-back-spec').addEventListener('click', function () { showStep('spec'); });
    $('btn-restart').addEventListener('click', function () {
      State.originalImg = null;
      State.workCanvas = null;
      State.maskCanvas = null;
      State.transform = null;
      State.undoStack = [];
      showStep('upload');
    });
  }

  /* ================= 模块切换（首页 / 照片 / 排版） ================= */
  function showModule(name) {
    document.body.dataset.module = name;
    $('view-home').style.display = name === 'home' ? '' : 'none';
    $('view-photo').style.display = name === 'photo' ? '' : 'none';
    $('view-sheet').classList.toggle('active', name === 'sheet');
    $('view-batch').style.display = name === 'batch' ? 'block' : 'none';
    $('view-archive').style.display = name === 'archive' ? 'block' : 'none';
    $('view-print').style.display = name === 'print' ? 'block' : 'none';
    $('view-system').style.display = name === 'system' ? 'block' : 'none';
    document.querySelectorAll('.module-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.module === name);
    });
    if (name === 'photo') showPhotoSub('menu');               // 每次进入照片工具回到子功能菜单
    if (name === 'sheet') window.App.sheet.showStep('tpl'); // 每次进入排版模块回到第 1 步
    if (name === 'batch') window.App.batch.enter();          // 每次进入批量工具回到子功能菜单
    if (name === 'archive') window.App.archive.enter();      // 每次进入压缩工具回到子功能菜单
    if (name === 'print') {                                   // 每次进入文档工具回到子功能菜单
      window.App.printBatch.enter();
      window.App.printBatch.refreshPrinters();
    }
    if (name === 'system') showSystemMenu();                  // 每次进入系统工具回到子功能菜单
    /* 记录上次使用的模块（设置 → 启动时进入「上次使用的模块」用），随偏好一并持久化 */
    State.lastModule = name;
    window.App.settings.save();
  }

  /* 照片工具子功能：menu=子功能菜单 idphoto=证照生成 convert=图片转换 compose=图片合成
     steps-nav（上传/抠图/规格/导出）仅在证照生成流程中显示（见 style.css） */
  function showPhotoSub(name) {
    document.body.dataset.photoSub = name;
    $('photo-menu').hidden = name !== 'menu';
    $('photo-flow').hidden = name !== 'idphoto';
    $('photo-convert').hidden = name !== 'convert';
    $('photo-compose').hidden = name !== 'compose';
    $('photo-compress').hidden = name !== 'compress';
    $('photo-soon').hidden = name !== 'soon';   // 老照片修复（开发中占位）
  }

  /* 系统工具子功能：软件卸载/垃圾清理两项暂未开发，占位页共用一套外壳，
     标题/要点按入口填充，图标从对应菜单卡片克隆（见 style.css #view-system）；
     网络检测/添加打印机/设置已实装（js/system.js + #system-net/#system-printer/#system-settings） */
  var SYSTEM_SOON = {
    uninstall: { title: '软件卸载',
      desc: '列出本机已安装软件 · 一键安全卸载 · 残留清理',
      list: ['已安装程序列表扫描与分类', '一键调用系统卸载流程', '卸载残留文件与注册表清理'] },
    cleanup: { title: '垃圾清理',
      desc: '系统临时文件与缓存 · 常用软件垃圾 · 一键清理',
      list: ['系统临时文件与更新缓存清理', '浏览器与常用软件垃圾扫描', '清理前明细预览，只清垃圾不动文件'] }
  };

  function showSystemMenu() {
    $('system-menu').hidden = false;
    $('system-soon').hidden = true;
    $('system-settings').hidden = true;
    $('system-net').hidden = true;
    $('system-printer').hidden = true;
  }

  function showSystemSoon(key) {
    var info = SYSTEM_SOON[key];
    if (!info) return;
    var iconBox = $('system-soon-icon');
    var iconSvg = document.querySelector('#system-open-' + key + ' .hc-icon svg');
    iconBox.innerHTML = '';
    if (iconSvg) iconBox.appendChild(iconSvg.cloneNode(true));
    $('system-soon-title').textContent = info.title;
    $('system-soon-desc').textContent = info.desc;
    $('system-soon-list').innerHTML = info.list.map(function (t) {
      return '<li>' + t + '</li>';
    }).join('');
    $('system-menu').hidden = true;
    $('system-soon').hidden = false;
  }

  /* 系统工具 → 网络检测 / 添加打印机：切到对应面板并触发数据加载（js/system.js） */
  function showSystemNet() {
    $('system-menu').hidden = true;
    $('system-soon').hidden = true;
    $('system-settings').hidden = true;
    $('system-printer').hidden = true;
    $('system-net').hidden = false;
    window.App.system.enterNet();
  }

  function showSystemPrinter() {
    $('system-menu').hidden = true;
    $('system-soon').hidden = true;
    $('system-settings').hidden = true;
    $('system-net').hidden = true;
    $('system-printer').hidden = false;
    window.App.system.enterPrinter();
  }

  /* 系统工具 → 设置：打开时同步控件取值、统计存储占用并填充关于信息 */
  function showSystemSettings() {
    $('system-menu').hidden = true;
    $('system-soon').hidden = true;
    $('system-settings').hidden = false;
    window.App.settings.applyToUI();
    var bytes = 0;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        bytes += (k.length + (localStorage.getItem(k) || '').length) * 2; // UTF-16 每字符 2 字节
      }
    } catch (e) { /* 存储不可用时显示占位 */ }
    $('set-storage').textContent = bytes > 0
      ? '约 ' + (bytes / 1024).toFixed(1) + ' KB（localStorage，仅存本机）'
      : '暂无本地存储数据';
    var verEl = document.querySelector('.home-version');
    var verMatch = /v[\d.]+/.exec(verEl && verEl.textContent || '');
    /* 版本显示以主进程真实版本（app.getVersion）为准，HTML 文案仅浏览器版兜底
     * ——避免包版本与页面硬编码文案漂移导致显示错版本 */
    $('set-ver').textContent = State.appVersion
      ? 'v' + State.appVersion + (State.upgradedFrom ? '（自 v' + State.upgradedFrom + ' 升级）' : '')
      : (verMatch ? verMatch[0] : '未知');
    $('set-mode').textContent = (window.haoyuePrint || window.haoyueArchive || window.haoyueDiag)
      ? '桌面版（Electron）'
      : '浏览器版（功能受限）';
    var diag = window.haoyueApp && typeof window.haoyueApp.exportLogs === 'function';
    $('set-diag').disabled = !diag;
    $('set-diag-hint').textContent = diag
      ? '导出最近 10 份运行日志（纯文本，不含照片或文件内容），便于排查异常。'
      : '浏览器版没有本地运行日志；桌面版可导出最近 10 份日志（纯文本）。';
    if (window.App.updaterUI) window.App.updaterUI.refresh();
  }

  /* ================= 应用内更新（设置页 · 关于面板） =================
   * 桥接 window.haoyueAppUpdate（electron/updater.js），手动触发制：
   * 检查 → 用户确认下载 → 进度反馈 → 用户确认安装并重启。
   * 浏览器版 / 便携版 / 开发模式自动降级，只提供「打开发布页」手动下载。 */
  var RELEASES_URL = 'https://github.com/Laogaodhck/haoyuebox/releases/latest';

  function fmtBps(bps) {
    if (!bps || bps <= 0) return '';
    return bps >= 1048576
      ? (bps / 1048576).toFixed(1) + ' MB/s'
      : Math.max(1, Math.round(bps / 1024)) + ' KB/s';
  }

  /* 快照 → 关于面板（状态行 + 按钮组 + 进度条） */
  function renderUpdate(snap) {
    var bridge = window.haoyueAppUpdate;
    if (!snap || !bridge) return;
    var status = $('upd-status');
    var bCheck = $('upd-check');
    var bDownload = $('upd-download');
    var bInstall = $('upd-install');
    var bOpen = $('upd-open');
    var bar = $('upd-progress');
    var v = snap.version ? 'v' + snap.version : '当前版本';
    status.title = (snap.info && snap.info.notes) || '';

    /* 运行模式精确化（覆盖 showSystemSettings 的粗粒度文案） */
    $('set-mode').textContent = snap.kind === 'packaged' ? '桌面安装版（Electron）'
      : snap.kind === 'portable' ? '桌面便携版（Electron）'
        : '开发模式（Electron）';

    var busy = snap.phase === 'checking' || snap.phase === 'downloading';
    bCheck.disabled = busy;
    bDownload.disabled = busy;
    bCheck.hidden = false;
    bDownload.hidden = !(snap.kind === 'packaged' && snap.phase === 'available');
    bInstall.hidden = !(snap.kind === 'packaged' && snap.phase === 'downloaded');
    bOpen.hidden = snap.kind !== 'portable' && snap.kind !== 'dev';
    bar.hidden = snap.phase !== 'downloading';
    if (!bar.hidden) bar.value = Math.floor((snap.progress && snap.progress.percent) || 0);

    switch (snap.phase) {
      case 'checking':
        status.textContent = '正在检查更新…'; break;
      case 'available':
        status.textContent = '发现新版本 v' + snap.info.version + '（当前 ' + v + '），可下载'; break;
      case 'noupdate':
        status.textContent = '已是最新版本（' + v + '）'; break;
      case 'downloading': {
        var bps = fmtBps(snap.progress && snap.progress.bps);
        status.textContent = '下载中 ' + Math.floor((snap.progress && snap.progress.percent) || 0) + '%' + (bps ? ' · ' + bps : '');
        break;
      }
      case 'downloaded':
        status.textContent = '新版本 v' + ((snap.info && snap.info.version) || '') + ' 已就绪，点击「安装并重启」完成升级'; break;
      case 'error':
        status.textContent = snap.error || '更新失败，可重试'; break;
      default: /* idle */
        status.textContent = snap.kind === 'packaged'
          ? '点击「检查更新」获取新版本（联网仅在点击后发生）'
          : '点击「检查更新」查看发布（就地更新仅安装版可用）';
    }
  }

  /* app.js 的 IIFE 以 return App → window.App 赋值收尾，挂载须走局部 App
   *（window.App 在 IIFE 执行期间尚未就绪，直接挂会抛 undefined） */
  var updaterUI = {
    /* initModules 调用：绑定按钮与进度推送 */
    init: function () {
      var bridge = window.haoyueAppUpdate;
      if (!bridge) { /* 浏览器版：降级文案，仅保留手动下载入口 */
        var status = $('upd-status');
        status.textContent = '浏览器版不支持应用内更新，请到发布页手动下载';
        $('upd-check').hidden = true;
        $('upd-download').hidden = true;
        $('upd-install').hidden = true;
        $('upd-open').hidden = false;
        $('upd-open').addEventListener('click', function () {
          window.open(RELEASES_URL, '_blank');
        });
        return;
      }
      $('upd-check').addEventListener('click', function () {
        bridge.check().then(renderUpdate).catch(function () { /* 快照必返，失败已含 error 态 */ });
      });
      $('upd-download').addEventListener('click', function () {
        bridge.download().then(renderUpdate).catch(function () { /* 同上 */ });
      });
      $('upd-install').addEventListener('click', function () {
        bridge.install().then(renderUpdate).catch(function () { /* 进程将退出 */ });
      });
      $('upd-open').addEventListener('click', function () {
        bridge.openReleases().catch(function () { window.open(RELEASES_URL, '_blank'); });
      });
      bridge.onProgress(renderUpdate);
    },
    /* 进入设置页时拉取一次状态快照 */
    refresh: function () {
      var bridge = window.haoyueAppUpdate;
      if (!bridge) return;
      bridge.status().then(renderUpdate).catch(function () {
        $('upd-status').textContent = '更新状态获取失败（桥接异常）';
      });
    }
  };

  /* ============ 入口注册表（声明式） ============
     新增首页卡片/子功能入口只需在此各加一行，无需再改 initModules 与绑定代码。 */
  var MODULE_CARDS = [
    { card: 'home-photo',    module: 'photo' },
    { card: 'home-sheet',    module: 'sheet' },
    { card: 'home-batch',    module: 'batch' },
    { card: 'home-archive',  module: 'archive' },
    { card: 'home-print',    module: 'print' },
    { card: 'home-system',   module: 'system' }
  ];
  var SUB_ENTRIES = [
    { card: 'photo-open-idphoto',    run: function () { showPhotoSub('idphoto'); } },
    { card: 'photo-open-convert',    run: function () { window.App.convert.enter(); showPhotoSub('convert'); } },
    { card: 'photo-open-compose',    run: function () { window.App.compose.enter(); showPhotoSub('compose'); } },
    { card: 'photo-open-compress',   run: function () { window.App.compress.enter(); showPhotoSub('compress'); } },
    { card: 'batch-open-watermark',  run: function () { window.App.batchWatermark.enter(); } },
    { card: 'batch-open-format',     run: function () { window.App.batchFormat.enter(); } },
    /* 批量体积优化复用照片工具的压缩子功能（传入来源，返回时回批量工具） */
    { card: 'batch-open-optimize',   run: function () { showModule('photo'); window.App.compress.enter('batch'); showPhotoSub('compress'); } },
    /* 未开发子功能占位页（进入 / 返回） */
    { card: 'photo-open-restore',    run: function () { showPhotoSub('soon'); } },
    { card: 'soon-photo-back',       run: function () { showPhotoSub('menu'); } },
    /* 批量打印（图片面板）已自打印工具迁入批量工具 */
    { card: 'batch-open-printbatch', run: function () { window.App.batch.showOnly('print-batch'); window.App.printBatch.refreshPrinters(); } },
    /* 文档工具：六项子功能均已实装 */
    { card: 'print-open-docs',      run: function () { window.App.printBatch.showOnly('print-docs'); } },
    { card: 'print-open-convert',   run: function () {
      window.App.printBatch.showOnly('docs-convert');
      window.App.docsConvert.enter();
    } },
    { card: 'print-open-pdf',       run: function () {
      window.App.printBatch.showOnly('docs-pdf');
      window.App.docsPdf.enter();
    } },
    { card: 'print-open-reader',    run: function () {
      window.App.printBatch.showOnly('docs-reader');
      window.App.docsReader.enter();
    } },
    { card: 'print-open-ocr',       run: function () {
      window.App.printBatch.showOnly('docs-ocr');
      window.App.docsOcr.enter();
    } },
    { card: 'print-open-watermark', run: function () {
      window.App.printBatch.showOnly('docs-watermark');
      window.App.docsWatermark.enter();
    } },
    { card: 'dc-back',              run: function () { window.App.printBatch.showOnly(null); } },
    { card: 'dp-back',              run: function () { window.App.printBatch.showOnly(null); } },
    { card: 'dr-back',              run: function () { window.App.printBatch.showOnly(null); } },
    { card: 'dw-back',              run: function () { window.App.printBatch.showOnly(null); } },
    { card: 'do-back',              run: function () { window.App.printBatch.showOnly(null); } },
    /* 系统工具：软件卸载/垃圾清理为占位页，网络检测/添加打印机/设置已实装 */
    { card: 'system-open-uninstall', run: function () { showSystemSoon('uninstall'); } },
    { card: 'system-open-cleanup',   run: function () { showSystemSoon('cleanup'); } },
    { card: 'system-open-network',   run: function () { showSystemNet(); } },
    { card: 'system-open-printer',   run: function () { showSystemPrinter(); } },
    { card: 'system-open-settings',  run: function () { showSystemSettings(); } },
    { card: 'soon-system-back',      run: function () { showSystemMenu(); } },
    { card: 'back-system-net',       run: function () { showSystemMenu(); } },
    { card: 'back-system-printer',   run: function () { showSystemMenu(); } },
    { card: 'set-back',              run: function () { showSystemMenu(); } }
  ];
  /* boot 时逐个调用的模块 init 列表（与 window.App 键名一致） */
  var MODULE_INITS = ['sheet', 'batch', 'batchFormat', 'batchWatermark', 'archive', 'convert', 'compose', 'compress', 'print', 'printBatch', 'docsWatermark', 'docsConvert', 'docsPdf', 'docsReader', 'docsOcr', 'system', 'updaterUI'];

  function initModules() {
    document.querySelectorAll('.module-tab').forEach(function (t) {
      t.addEventListener('click', function () { showModule(t.dataset.module); });
    });
    MODULE_CARDS.forEach(function (e) {
      $(e.card).addEventListener('click', function () { showModule(e.module); });
    });
    SUB_ENTRIES.forEach(function (e) {
      $(e.card).addEventListener('click', e.run);
    });
    /* 系统工具 → 设置：偏好修改即时生效并持久化 */
    $('set-theme').addEventListener('change', function () {
      State.theme = this.value === 'light' ? 'light' : 'dark';
      window.App.settings.applyTheme();
      window.App.settings.save();
    });
    $('set-start').addEventListener('change', function () {
      State.startMode = this.value === 'last' ? 'last' : 'home';
      window.App.settings.save();
    });
    $('set-diag').addEventListener('click', function () {
      var bridge = window.haoyueApp;
      if (!bridge || typeof bridge.exportLogs !== 'function') {
        toast('浏览器版没有本地日志，请使用桌面版导出', true);
        return;
      }
      var btn = this;
      btn.disabled = true;
      bridge.exportLogs().then(function (res) {
        if (res && res.ok) toast('已导出 ' + res.files + ' 份日志', false, 'check');
        else if (!res || !res.cancelled) toast('导出失败：' + ((res && res.error) || '未知错误'), true);
      }).catch(function (e) {
        toast('导出失败：' + ((e && e.message) || e), true);
      }).finally(function () {
        btn.disabled = !(window.haoyueApp && typeof window.haoyueApp.exportLogs === 'function');
      });
    });
    $('set-reset').addEventListener('click', function () {
      window.App.ui.confirm('确定清空全部本机设置并恢复默认吗？\n（含规格/底色/输出记忆与主题、启动偏好）')
        .then(function (ok) {
          if (!ok) return;
          try { localStorage.clear(); } catch (e) { /* 忽略 */ }
          location.reload();
        });
    });
  }

  /* ================= 启动 ================= */
  /* 渲染层异常上报（桌面版经 haoyueDiag 桥接落盘，浏览器版静默跳过） */
  function reportError(kind, msg) {
    try {
      if (window.haoyueDiag && window.haoyueDiag.logError) {
        window.haoyueDiag.logError('[' + kind + '] ' + msg);
      }
    } catch (e) { /* 桥接不可用时静默 */ }
  }

  /* 桌面版：升级/回滚检测 + 数据备份恢复（纯本机，浏览器版无桥接直接跳过）。
   * 覆盖安装/版本更新后的首启流程：
   *  1. 主进程已按 version-marker 判定本次启动类型（升级/回滚/常规/首启）；
   *  2. 升级首启：把当前设置快照再备份一份（升级前数据的保险，迁移流程
   *     亦各有快照）；
   *  3. 回滚（更新失败退回旧版）：提示用户数据未受影响（主进程已落日志）；
   *  4. 设置主键缺失（用户清空/存储损坏）但存在备份时，确认后恢复——
   *     恢复内容经迁移框架落盘，拒绝则删除该备份（放弃恢复）。 */
  function checkUpdateAndBackup() {
    if (!window.haoyueApp || !window.haoyueApp.updateInfo) return;
    window.haoyueApp.updateInfo().then(function (info) {
      if (!info || !info.version) return;
      State.appVersion = info.version;
      State.upgradedFrom = info.kind === 'upgrade' ? (info.from || '') : '';
      if (info.kind === 'upgrade') {
        try {
          var raw = localStorage.getItem(window.App.settings.KEY);
          if (raw) window.haoyueApp.backupData(raw).catch(function () { /* 静默 */ });
        } catch (e) { /* 存储不可用静默 */ }
      }
      if (info.kind === 'rollback') {
        toast('检测到版本回滚（v' + info.from + ' → v' + info.version + '），本机数据未受影响');
      }
      return window.haoyueApp.readBackup().then(function (bak) {
        var have = false;
        try { have = localStorage.getItem(window.App.settings.KEY) !== null; } catch (e) { /* 存储不可用 */ }
        if (!bak || !bak.data || have) return;
        var parsed = null;
        try { parsed = JSON.parse(bak.data); } catch (e) { /* 备份损坏按无备份处理 */ }
        if (!parsed || typeof parsed !== 'object') return;
        return confirm('检测到 v' + (bak.version || '?') + ' 的设置备份，当前设置记忆为空。\n是否恢复该备份？')
          .then(function (ok) {
            if (ok) {
              try {
                localStorage.setItem(window.App.settings.KEY, JSON.stringify(parsed));
              } catch (e) { return; }
              location.reload(); // 重启后经迁移框架加载备份（含 v1 旧格式自动迁移）
            } else {
              window.haoyueApp.deleteBackup(bak.file).catch(function () { /* 静默 */ });
            }
          });
      });
    }).catch(function () { /* 桥接异常静默（旧主进程/非桌面环境） */ });
  }

  /* 运行模式标记：浏览器直接打开时首页版本行改为「浏览器版」，
   * 桌面版保持静态文案（发布校验按 HTML 静态文本核对版本号） */
  function applyRuntimeTag() {
    if (window.haoyuePrint || window.haoyueArchive || window.haoyueDiag) return;
    var el = document.querySelector('.home-version');
    if (el) el.textContent = el.textContent.replace('桌面离线版', '浏览器版');
  }

  function boot() {
    // 全局兜底：任何未捕获错误都必须关掉加载遮罩并提示，避免“永久转圈”
    window.addEventListener('unhandledrejection', function (e) {
      hideLoading();
      var msg = e && e.reason && (e.reason.message || String(e.reason)) || '未知错误';
      console.error(e && e.reason || msg);
      reportError('unhandledrejection', msg);
      toast('处理失败：' + msg, true);
    });
    window.addEventListener('error', function (e) {
      if (e && e.message && !/favicon/.test(e.message)) {
        hideLoading();
        reportError('script-error', e.message);
        toast('脚本错误：' + e.message, true);
      }
    });

    if (location.protocol === 'file:') {
      var warn = $('offline-warning');
      warn.hidden = false;
      // 警告图标用内联 SVG（与全项目 Lucide 风格描边图标一致），不用 emoji
      warn.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>' +
        '<line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
        '<span>当前以 file:// 方式打开，AI 模型无法加载。请双击 start.bat（或用任意静态服务器）打开本工具。</span>';
    }
    window.App.settings.load();   // 恢复上次的规格/背景/输出设置（须在 buildSpecGrid 之前）
    applyRuntimeTag();
    initModules();
    initUpload();
    initMatte();
    initSpec();
    initExport();
    // 逐模块隔离初始化：单个模块脚本缺失/init 抛错只影响自身，
    // 其余模块与首页展示照常就绪（失败原因上报诊断日志）
    MODULE_INITS.forEach(function (name) {
      var mod = window.App[name];
      if (!mod || typeof mod.init !== 'function') {
        reportError('init', '模块 ' + name + ' 未注册，已跳过');
        return;
      }
      try {
        mod.init();
      } catch (e) {
        reportError('init', '模块 ' + name + ' 初始化失败：' + (e && e.message || e));
        console.error('[haoyue] 模块初始化失败:', name, e);
      }
    });
    window.App.settings.applyToUI();
    /* 启动模块：默认首页；设置选择「上次使用的模块」时恢复上次位置（未知值兜底回首页） */
    var KNOWN_MODULES = ['home', 'photo', 'sheet', 'batch', 'archive', 'system', 'print'];
    var startModule = 'home';
    if (State.startMode === 'last' && KNOWN_MODULES.indexOf(State.lastModule) >= 0) {
      startModule = State.lastModule;
    }
    showModule(startModule); // 启动进入首页或上次模块
    /* 升级/回滚检测与数据恢复：UI 就绪后异步执行，不阻塞首屏 */
    checkUpdateAndBackup();
  }

  /* Lucide 风格内联 SVG 图标（与 warn-banner 警告图标同一体系）：
   * 交互控件标识、状态/结果行标识统一走此处，不用 emoji / 排版符号
   * （对勾 / 警示 / 左右箭头等一律 SVG 化或改文字描述，见 test-dom 源码扫描断言）。
   * name: x | up | down | left | right | check | alert；返回 <svg class="icon"> 元素，
   * 尺寸随字号（.icon = 1.05em），可访问名称由调用方设在按钮的 aria-label 上。
   * 路径值可以是单字符串或多 path 数组（alert 三角+竖线+点需三条 path） */
  var ICON_PATHS = {
    x: 'M18 6 6 18M6 6l12 12',
    up: 'm18 15-6-6-6 6',
    down: 'm6 9 6 6 6-6',
    left: 'm15 18-6-6 6-6',
    right: 'm9 18 6-6-6-6',
    check: 'm20 6-11 11-5-5',
    alert: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z', 'M12 9v4', 'M12 17h.01']
  };

  function makeIcon(name) {
    var NS = 'http://www.w3.org/2000/svg';
    if (!ICON_PATHS[name]) console.warn('[haoyue] App.ui.icon 未知图标名，已回退 x：', name);
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    var ds = ICON_PATHS[name] || ICON_PATHS.x;
    (Array.isArray(ds) ? ds : [ds]).forEach(function (d) {
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  /* 状态/结果行写入：纯文本 + 末尾 SVG 标识（替代「对勾 / 警示」排版符号拼接）。
   * 文本一律走 textContent（防 innerHTML 注入），标识走 makeIcon 体系 */
  function setStatusText(el, text, iconName) {
    el.textContent = '';
    el.appendChild(document.createTextNode(text));
    if (iconName) el.appendChild(makeIcon(iconName));
  }

  /* 长任务取消令牌：模块持有 token，逐项/逐页 checkpoint；
   * 取消后 checkpoint 抛出哨兵，由 run 的 catch 识别为「已取消」而非失败。
   * 哨兵对象不携带堆栈信息，只用于身份比较，不会被当作错误上报。 */
  var TASK_CANCELLED = { cancelled: true };
  function createTask() {
    return { cancelled: false, cancel: function () { this.cancelled = true; } };
  }
  function checkpoint(task) {
    if (task && task.cancelled) throw TASK_CANCELLED;
  }
  function isCancelled(err) { return err === TASK_CANCELLED; }

  /* 文件拖放统一绑定：section 内任意位置接收拖拽，target 元素显示虚线高亮。
   * accept 为正则或判定函数（返回 true 保留），onFiles 接收过滤后的文件数组。
   * 运行期由调用方在 onFiles 内自行守卫（见各文档模块）。 */
  function bindFileDrop(sectionId, opts) {
    var sec = $(sectionId);
    if (!sec) return;
    var o = opts || {};
    var target = (o.target && $(o.target)) || sec;
    var accept = o.accept;
    var msg = o.rejectMsg || '文件类型不支持';
    var depth = 0;
    function accepted(f) {
      return !accept || (typeof accept === 'function' ? accept(f) : accept.test(f.name));
    }
    sec.addEventListener('dragenter', function (e) {
      e.preventDefault();
      depth++;
      target.classList.add('file-drop-over');
    });
    sec.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    sec.addEventListener('dragleave', function () {
      depth = Math.max(0, depth - 1);
      if (!depth) target.classList.remove('file-drop-over');
    });
    sec.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      target.classList.remove('file-drop-over');
      var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []).filter(accepted);
      if (!files.length) { toast(msg, true); return; }
      if (o.onFiles) o.onFiles(files);
    });
  }

  var App = {
    State: State,
    showModule: showModule,
    ui: {
      $: $, toast: toast, confirm: confirm, showLoading: showLoading, hideLoading: hideLoading, download: download,
      icon: makeIcon, statusText: setStatusText, bindFileDrop: bindFileDrop
    },
    task: { create: createTask, checkpoint: checkpoint, isCancelled: isCancelled },
    photo: {
      showStep: showStep,
      showPhotoSub: showPhotoSub,
      syncBgSwatches: syncBgSwatches,
      makeSingleCanvas: makeSingleCanvas
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  App.updaterUI = updaterUI; // 应用内更新 UI（设置页 · 关于面板）
  return App;
})();
