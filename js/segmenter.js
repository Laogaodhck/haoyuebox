/* MediaPipe 本地人像分割：多分类保护、连通域清理、轮廓 alpha 与发丝混色净化。 */
'use strict';

window.Matting = (function () {

  var segmenter = null;
  var initPromise = null;
  var MAX_DIM = 1600;      // 工作图长边上限（控制内存与性能）
  var TILE = 512;          // 精修瓦片边长
  var OVERLAP = 96;        // 瓦片重叠宽度（加权融合过渡带）
  var TILED_MIN = 800;     // 长边超过该值才启用分块精修

  function vision() {
    /* tasks-vision 1.x 的 IIFE 构建挂全局 Vision；保留 __mpVision 兼容旧版 */
    var v = window.Vision || window.__mpVision;
    if (!v) {
      throw new Error('MediaPipe 运行时未加载');
    }
    return v;
  }

  function createSegmenter(modelPath) {
    return vision().FilesetResolver
      .forVisionTasks('vendor/mediapipe/wasm')
      .then(function (fileset) {
        return vision().ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: modelPath },
          runningMode: 'IMAGE',
          outputConfidenceMasks: true,
          outputCategoryMask: false
        });
      });
  }

  function init() {
    if (initPromise) return initPromise;
    initPromise = createSegmenter('vendor/mediapipe/models/selfie_multiclass_256x256.tflite')
      .catch(function (e) {
        // 多分类模型（头发/皮肤/衣服细分，边缘更准）加载失败时回退基础模型
        console.warn('多分类模型加载失败，回退基础分割模型:', e);
        return createSegmenter('vendor/mediapipe/models/selfie_segmenter.tflite');
      })
      .then(function (s) { segmenter = s; })
      .catch(function (e) {
        // 两个模型都失败：清空缓存让下次调用重新尝试（文件恢复后本会话内可自愈）
        initPromise = null;
        throw e;
      });
    return initPromise;
  }

  function isReady() { return segmenter !== null; }

  /* 原图 → 限边工作图 */
  function makeWorkCanvas(image) {
    var w = image.naturalWidth || image.width;
    var h = image.naturalHeight || image.height;
    var k = Math.min(1, MAX_DIM / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d').drawImage(image, 0, 0, c.width, c.height);
    return c;
  }

  /* 依据边界置信度均值挑选“人像”通道（双通道模型防呆） */
  function pickPersonMask(masks) {
    if (masks.length === 1) {
      return { mask: masks[0], arr: new Float32Array(masks[0].getAsFloat32Array()), w: masks[0].width, h: masks[0].height };
    }
    var best = null, bestBorder = Infinity;
    for (var i = 0; i < masks.length; i++) {
      var arr = new Float32Array(masks[i].getAsFloat32Array());
      var w = masks[i].width, h = masks[i].height;
      var sum = 0, n = 0;
      for (var x = 0; x < w; x++) {
        sum += arr[x] + arr[(h - 1) * w + x]; n += 2;
      }
      for (var y = 0; y < h; y++) {
        sum += arr[y * w] + arr[y * w + w - 1]; n += 2;
      }
      var borderAvg = sum / n;
      if (borderAvg < bestBorder) { bestBorder = borderAvg; best = { mask: masks[i], arr: arr, w: w, h: h }; }
    }
    return best;
  }

  // 浮点插值避免细发丝置信度经 8 位画布往返量化。
  function resampleF32(src, w, h, tw, th) {
    var out = new Float32Array(tw * th);
    for (var y = 0; y < th; y++) {
      var sy = Math.max(0, Math.min(h - 1, (y + 0.5) * h / th - 0.5));
      var y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
      for (var x = 0; x < tw; x++) {
        var sx = Math.max(0, Math.min(w - 1, (x + 0.5) * w / tw - 0.5));
        var x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
        var top = src[y0 * w + x0] * (1 - fx) + src[y0 * w + x1] * fx;
        var bottom = src[y1 * w + x0] * (1 - fx) + src[y1 * w + x1] * fx;
        out[y * tw + x] = top * (1 - fy) + bottom * fy;
      }
    }
    return out;
  }

  function extractPersonConf(result, expectW, expectH) {
    var masks = result.confidenceMasks;
    var m;
    var hair = null, clothes = null, face = null, body = null;
    if (masks.length >= 3) {
      var bg = new Float32Array(masks[0].getAsFloat32Array());
      var conf = new Float32Array(bg.length);
      for (var i = 0; i < bg.length; i++) conf[i] = 1 - bg[i];
      if (masks.length >= 6) { // 6 通道多分类：0背景 1头发 2身体皮肤 3脸部皮肤 4衣服 5其他
        hair = new Float32Array(masks[1].getAsFloat32Array());
        body = new Float32Array(masks[2].getAsFloat32Array());
        face = new Float32Array(masks[3].getAsFloat32Array());
        clothes = new Float32Array(masks[4].getAsFloat32Array());
      }
      m = { conf: conf, w: masks[0].width, h: masks[0].height };
    } else {
      var picked = pickPersonMask(masks);
      m = { conf: picked.arr, w: picked.w, h: picked.h };
    }
    if (m.w !== expectW || m.h !== expectH) {
      m.conf = resampleF32(m.conf, m.w, m.h, expectW, expectH);
      if (hair) hair = resampleF32(hair, m.w, m.h, expectW, expectH);
      if (face) face = resampleF32(face, m.w, m.h, expectW, expectH);
      if (body) body = resampleF32(body, m.w, m.h, expectW, expectH);
      if (clothes) clothes = resampleF32(clothes, m.w, m.h, expectW, expectH);
      m.w = expectW; m.h = expectH;
    }
    // 皮肤置信度 = max(身体皮肤, 脸部皮肤)：两通道 softmax 天然互补，
    // 取 max 而非相加，避免交界处双高置信导致美白过强
    var skin = null;
    if (body && face) {
      skin = new Float32Array(body.length);
      for (var si = 0; si < skin.length; si++) skin[si] = Math.max(body[si], face[si]);
    }
    m.hair = hair; m.clothes = clothes; m.face = face; m.skin = skin;
    return m;
  }

  /* 皮肤美白：data(RGBA) 就地修改。strength 0..1，skin 为逐像素皮肤置信度（0..1）。
   * 算法 = 白色 Screen 混合 × 置信度门控：
   *   screen(c) = 255-(255-c)²/255 —— 高光提亮多、暗部少，
   *   且 R/G/B 中原本越低的通道增益越大 → 肤色饱和度相对收敛，偏白不偏橙。
   * 强度再乘以像素皮肤置信度，蒙版边缘自然羽化，不产生硬边。 */
  function whitenData(data, skin, strength) {
    if (!(strength > 0) || !skin || skin.length * 4 !== data.length) return 0;
    var n = 0;
    for (var i = 0, j = 0; i < skin.length; i++, j += 4) {
      var a = skin[i];
      if (a < 0.08) continue;          // 非皮肤像素零开销跳过
      var t = strength * a;
      var r = data[j], g = data[j + 1], b = data[j + 2];
      var sr = 255 - (255 - r) * (255 - r) / 255;
      var sg = 255 - (255 - g) * (255 - g) / 255;
      var sb = 255 - (255 - b) * (255 - b) / 255;
      data[j] = r + (sr - r) * t;
      data[j + 1] = g + (sg - g) * t;
      data[j + 2] = b + (sb - b) * t;
      n++;
    }
    return n;
  }

  /* 对任一画布做一次人像分割，返回其原始分辨率的置信度 */
  function segmentConf(canvas) {
    var result = segmenter.segment(canvas);
    try {
      return extractPersonConf(result, canvas.width, canvas.height).conf;
    } finally {
      if (result && result.close) result.close();
    }
  }

  /* ---------- 瓦片加权融合 ---------- */
  /* 轴向权重：瓦片中部=1，靠近边缘线性衰减到 0；与图像边界重合的边不衰减（无需过渡） */
  function axisWeight(p, len, over, isFirst, isLast) {
    var w0 = isFirst ? 1 : Math.min(1, p / over);
    var w1 = isLast ? 1 : Math.min(1, (len - 1 - p) / over);
    return Math.min(w0, w1);
  }

  /* 让渡事件循环：rAF 保证进度文字真正绘制一帧后再继续重活。
   * 窗口最小化/被遮挡时 rAF 会暂停导致 await 永不 resolve（界面假死），
   * 此时退化为 setTimeout 节流让渡 */
  function yieldUI() {
    return new Promise(function (r) {
      if (window.requestAnimationFrame && !document.hidden) {
        window.requestAnimationFrame(function () { setTimeout(r, 0); });
      } else {
        setTimeout(r, 32);
      }
    });
  }

  function tileStarts(length) {
    var starts = [0];
    while (starts[starts.length - 1] + TILE < length) {
      starts.push(Math.min(length - TILE, starts[starts.length - 1] + TILE - OVERLAP));
    }
    return starts;
  }

  /* 大图分块精修：返回与工作图同尺寸的融合置信度 */
  async function tiledRefine(work, base, report) {
    var W = work.width, H = work.height;
    // 末块贴边，避免窄条瓦片丢失人像上下文后把衣服识别成背景。
    var xs = tileStarts(W), ys = tileStarts(H);
    var total = xs.length * ys.length;
    var done = 0;

    var acc = new Float32Array(W * H);
    var wacc = new Float32Array(W * H);
    var tc = document.createElement('canvas');
    var tctx = tc.getContext('2d', { willReadFrequently: true });

    for (var yi = 0; yi < ys.length; yi++) {
      for (var xi = 0; xi < xs.length; xi++) {
        var tx = xs[xi], ty = ys[yi];
        var tw = Math.min(TILE, W - tx), th = Math.min(TILE, H - ty);
        tc.width = tw; tc.height = th;
        tctx.drawImage(work, tx, ty, tw, th, 0, 0, tw, th);
        var tconf = segmentConf(tc);
        for (var y = 0; y < th; y++) {
          var wy = axisWeight(y, th, OVERLAP, ty === 0, ty + th === H);
          var rowT = y * tw, rowG = (ty + y) * W + tx;
          for (var x = 0; x < tw; x++) {
            var wt = wy * axisWeight(x, tw, OVERLAP, tx === 0, tx + tw === W);
            var gi = rowG + x;
            acc[gi] += tconf[rowT + x] * wt;
            wacc[gi] += wt;
          }
        }
        done++;
        report('AI 高分辨率边缘精修 ' + done + '/' + total);
        await yieldUI();
      }
    }

    var out = new Float32Array(W * H);
    for (var i = 0; i < out.length; i++) {
      var s = wacc[i];
      var v;
      if (s > 0.01) {
        var wt2 = Math.min(1, s) * 0.65;
        v = (acc[i] / s) * wt2 + base[i] * (1 - wt2);
      } else {
        v = base[i];
      }
      /* 防过度裁切：粗分割高置信的人像区（脸部/衣服主体）不允许被瓦片稀释削弱，
         瓦片只负责细化边缘，不回收主体 */
      if (base[i] >= 0.75 && v < base[i]) v = base[i];
      out[i] = v;
    }
    return out;
  }

  /* ---------- 导向滤波边缘精修（零依赖，纯本地） ---------- */
  /* 模型内部仅 256px，输出上采样后边缘偏离真实轮廓；导向滤波以原图灰度为引导，
     把遮罩边缘吸附到真实发丝/衣缘处：平坦区平滑、边缘区按 I 的梯度对齐 */

  /* 可分离滑动窗口均值（前缀和实现，O(N)，边界窗口收缩） */
  function boxBlur(src, w, h, r) {
    var N = w * h;
    var tmp = new Float32Array(N);
    var out = new Float32Array(N);
    var pre = new Float64Array(Math.max(w, h) + 1);
    var x, y;
    // 水平
    for (y = 0; y < h; y++) {
      var row = y * w;
      pre[0] = 0;
      for (x = 0; x < w; x++) pre[x + 1] = pre[x] + src[row + x];
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        tmp[row + x] = (pre[x1] - pre[x0]) / (x1 - x0);
      }
    }
    // 垂直
    for (x = 0; x < w; x++) {
      pre[0] = 0;
      for (y = 0; y < h; y++) pre[y + 1] = pre[y] + tmp[y * w + x];
      for (y = 0; y < h; y++) {
        var y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
        out[y * w + x] = (pre[y1] - pre[y0]) / (y1 - y0);
      }
    }
    return out;
  }

  /* 灰度导向滤波：I=引导图(0..1)，p=输入置信度；q = meanA*I + meanB */
  function guidedFilter(conf, lum, w, h, r, eps) {
    var N = w * h;
    var meanI = boxBlur(lum, w, h, r);
    var meanP = boxBlur(conf, w, h, r);
    var IP = new Float32Array(N), II = new Float32Array(N);
    for (var i = 0; i < N; i++) { IP[i] = lum[i] * conf[i]; II[i] = lum[i] * lum[i]; }
    var meanIP = boxBlur(IP, w, h, r);
    var meanII = boxBlur(II, w, h, r);
    var a = new Float32Array(N), b = new Float32Array(N);
    for (var j = 0; j < N; j++) {
      var varI = Math.max(0, meanII[j] - meanI[j] * meanI[j]);
      a[j] = (meanIP[j] - meanI[j] * meanP[j]) / (varI + eps);
      b[j] = meanP[j] - a[j] * meanI[j];
    }
    var meanA = boxBlur(a, w, h, r);
    var meanB = boxBlur(b, w, h, r);
    var q = new Float32Array(N);
    for (var k = 0; k < N; k++) {
      var v = meanA[k] * lum[k] + meanB[k];
      q[k] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
    return q;
  }

  /* ---------- 遮罩清理（纯 Uint8Array 运算） ---------- */

  /* ---------- 分类感知增强（头发 / 白色衣服） ---------- */
  /* 多分类模型的头发/衣服通道携带了 1-背景 之外的空间语义：
     头发丝细、白衣服与浅背景难分，二者置信度天然偏低。
     在像素的专属通道占优时对其增益提升，把原本落在阈值之下的
     发丝/白衣像素拉回二值化可达区间（增益后仍须通过滞后阈值连通性检验）。 */
  function classBoost(conf, hair, clothes, face) {
    for (var i = 0; i < conf.length; i++) {
      var h = hair ? hair[i] : 0;
      var c = clothes ? clothes[i] : 0;
      var f = face ? face[i] : 0;
      if (h > 0.25) conf[i] = Math.max(conf[i], Math.min(1, h * 1.3));
      if (c > 0.3) conf[i] = Math.max(conf[i], Math.min(1, c * 1.25));
      if (f > 0.4) conf[i] = Math.max(conf[i], Math.min(1, f * 1.1));
    }
    return conf;
  }

  /* 分类感知阈值下调量：头发/衣服主导像素的强/弱阈值都适度降低，
     与 classBoost 配合——boost 负责「拉高置信度」，gain 负责「降低门槛」 */
  function classGain(hair, clothes, face) {
    var channel = hair || clothes || face;
    if (!channel) return null;
    var gain = new Float32Array(channel.length);
    for (var i = 0; i < gain.length; i++) {
      var h = hair ? hair[i] : 0;
      var c = clothes ? clothes[i] : 0;
      var f = face ? face[i] : 0;
      gain[i] = Math.min(0.15, h * 0.10 + c * 0.15 + f * 0.05);
    }
    return gain;
  }

  /* 滞后阈值二值化：强阈值定种子，弱阈值沿连通生长。
     头发等细结构在模型输出中置信度常落在强弱之间，单阈值会整片切掉；
     只要与强置信主体连通就保留（发丝连着头），孤立的背景弱噪声则被丢弃。
     gain（可选）：逐像素阈值下调量（分类感知），有效阈值 = T - gain[i]，下限 0.15 */
  function hysteresisBin(conf, w, h, strongT, weakT, gain) {
    var N = w * h;
    var bin = new Uint8Array(N);   // 1=强种子/已收录
    var weak = new Uint8Array(N);  // 1=弱置信待定
    var i, x, y;
    for (i = 0; i < N; i++) {
      var g = gain ? gain[i] : 0;
      var st = strongT - g; if (st < 0.15) st = 0.15;
      var wt = weakT - g; if (wt < 0.15) wt = 0.15;
      var v = conf[i];
      if (v >= st) bin[i] = 1;
      else if (v >= wt) weak[i] = 1;
    }
    var stack = new Int32Array(N);
    var sp = 0;
    for (i = 0; i < N; i++) if (bin[i]) stack[sp++] = i;
    function push(q) {
      if (weak[q]) { weak[q] = 0; bin[q] = 1; stack[sp++] = q; }
    }
    while (sp > 0) {
      var p = stack[--sp];
      x = p % w; y = (p / w) | 0;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) {
        push(p - w);
        if (x > 0) push(p - w - 1);
        if (x < w - 1) push(p - w + 1);
      }
      if (y < h - 1) {
        push(p + w);
        if (x > 0) push(p + w - 1);
        if (x < w - 1) push(p + w + 1);
      }
    }
    return bin; // 未被强主体连通的 weak 保持 0 → 孤立弱噪声被丢弃
  }

  // 已连通的细发丝只需一个邻居，背景像素不放宽阈值以免蒙版膨胀。
  function medianFilter3(bin, w, h, hairMask) {
    var out = new Uint8Array(bin.length);
    for (var y = 0; y < h; y++) {
      var y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
      for (var x = 0; x < w; x++) {
        var x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
        var n = 0;
        for (var yy = y0; yy <= y1; yy++) {
          var row = yy * w;
          for (var xx = x0; xx <= x1; xx++) n += bin[row + xx];
        }
        var idx = y * w + x;
        var need = (hairMask && hairMask[idx] && bin[idx]) ? 2 : 5;
        need = Math.min(need, Math.ceil((x1 - x0 + 1) * (y1 - y0 + 1) / 2));
        out[idx] = n >= need ? 1 : 0;
      }
    }
    return out;
  }

  /* 连通域清理：保留最大人像域；其余域面积 ≥ 最大域 3% 才保留（合影第二人等） */
  function cleanComponents(bin, w, h) {
    var N = w * h;
    var label = new Int32Array(N);          // 0=未访问
    var stack = new Int32Array(N);
    var comps = [];                          // {id, size, pixels? 不存像素，改用二次扫描}
    var cur = 0;
    var sizes = [0];                         // sizes[cid]
    for (var start = 0; start < N; start++) {
      if (bin[start] !== 1 || label[start] !== 0) continue;
      cur++;
      var sp = 0, size = 0;
      stack[sp++] = start;
      label[start] = cur;
      while (sp > 0) {
        var p = stack[--sp];
        size++;
        var px = p % w, py = (p / w) | 0;
        if (px > 0 && bin[p - 1] === 1 && label[p - 1] === 0) { label[p - 1] = cur; stack[sp++] = p - 1; }
        if (px < w - 1 && bin[p + 1] === 1 && label[p + 1] === 0) { label[p + 1] = cur; stack[sp++] = p + 1; }
        if (py > 0 && bin[p - w] === 1 && label[p - w] === 0) { label[p - w] = cur; stack[sp++] = p - w; }
        if (py < h - 1 && bin[p + w] === 1 && label[p + w] === 0) { label[p + w] = cur; stack[sp++] = p + w; }
        for (var dy = -1; dy <= 1; dy += 2) {
          if (py + dy < 0 || py + dy >= h) continue;
          for (var dx = -1; dx <= 1; dx += 2) {
            if (px + dx < 0 || px + dx >= w) continue;
            var q = p + dy * w + dx;
            if (bin[q] === 1 && label[q] === 0) { label[q] = cur; stack[sp++] = q; }
          }
        }
      }
      sizes[cur] = size;
      comps.push(cur);
    }
    if (comps.length <= 1) return bin;
    var biggest = 0;
    for (var i = 0; i < comps.length; i++) if (sizes[comps[i]] > sizes[biggest]) biggest = comps[i];
    var minKeep = Math.max(50, sizes[biggest] * 0.03);
    var keep = new Uint8Array(cur + 1);
    keep[biggest] = 1;
    for (var j = 0; j < comps.length; j++) {
      if (sizes[comps[j]] >= minKeep) keep[comps[j]] = 1;
    }
    var out = new Uint8Array(N);
    for (var k = 0; k < N; k++) out[k] = keep[label[k]] ? bin[k] : 0;
    return out;
  }

  /* 人像触边补实：证件照下半身常被照片底边裁断，模型对贴边区域置信度不稳，
     会在遮罩底边留下锯齿状缺口；判定人像延伸出画面后，边界过渡带内的
     背景缺口若「纵向邻近人体前景」（向上/向内 LOOK 窗口内有人像）才补为前景，
     避免把角落里真正的背景一起填掉（换红蓝底会露白角） */
  function solidifyBorders(bin, w, h, conf) {
    var bandY = Math.max(8, Math.round(h * 0.05));
    var bandX = Math.max(8, Math.round(w * 0.05));
    var LOOK = Math.max(48, Math.round(h * 0.08)); // 纵向邻近判定窗口：覆盖更高的贴底缺口
    var EDGE_FRAC = 0.25;  // 边界线附近人像占比 ≥ 此值 → 认为人像被画面裁断
    var SPAN_MIN = 0.04;   // 行/列内人像 ≥ 此比例才处理（防误处理背景噪声）

    /* dir: -1 = 缺口向上找人体（底边），+1 = 向下找（顶边） */
    function rowSpan(y, dir) {
      var row = y * w, first = -1, last = -1, cnt = 0;
      for (var x = 0; x < w; x++) if (bin[row + x]) { if (first < 0) first = x; last = x; cnt++; }
      if (first < 0 || cnt < w * SPAN_MIN) return;
      for (var x2 = first; x2 <= last; x2++) {
        if (bin[row + x2] || conf[row + x2] < 0.25) continue;
        for (var k = 1; k <= LOOK; k++) {
          var yy = y + dir * k;
          if (yy < 0 || yy >= h) break;
          if (bin[yy * w + x2]) { bin[row + x2] = 1; break; } // 纵向紧邻人体 → 补
        }
      }
    }
    function colSpan(x) {
      var first = -1, last = -1, cnt = 0;
      for (var y = 0; y < h; y++) if (bin[y * w + x]) { if (first < 0) first = y; last = y; cnt++; }
      if (first < 0 || cnt < h * SPAN_MIN) return;
      for (var y2 = first; y2 <= last; y2++) {
        if (bin[y2 * w + x] || conf[y2 * w + x] < 0.25) continue;
        // 纵向邻近判定：缺口上/下沿列方向 LOOK 窗口内有人像 → 补（边缘轮廓抖动产生的竖向缺口）
        var hit = false;
        for (var k2 = 1; k2 <= LOOK; k2++) {
          if (y2 - k2 >= 0 && bin[(y2 - k2) * w + x]) { hit = true; break; }
          if (y2 + k2 < h && bin[(y2 + k2) * w + x]) { hit = true; break; }
        }
        if (hit) bin[y2 * w + x] = 1;
      }
    }
    function rowCnt(y) { var c = 0, row = y * w; for (var x = 0; x < w; x++) c += bin[row + x]; return c; }
    function colCnt(x) { var c = 0; for (var y = 0; y < h; y++) c += bin[y * w + x]; return c; }

    var y, t;
    // 底边：最后 3 行中任一行人像占比达标即触发
    var bottomHit = false;
    for (t = 1; t <= 3 && t <= h; t++) if (rowCnt(h - t) >= w * EDGE_FRAC) { bottomHit = true; break; }
    if (bottomHit) for (y = Math.max(0, h - bandY); y < h; y++) rowSpan(y, -1);
    // 顶边
    var topHit = false;
    for (t = 0; t < 3 && t < h; t++) if (rowCnt(t) >= w * EDGE_FRAC) { topHit = true; break; }
    if (topHit) for (y = 0; y < Math.min(bandY, h); y++) rowSpan(y, 1);
    // 左右两边
    var rightHit = false;
    for (t = 1; t <= 3 && t <= w; t++) if (colCnt(w - t) >= h * EDGE_FRAC) { rightHit = true; break; }
    if (rightHit) for (var xr = Math.max(0, w - bandX); xr < w; xr++) colSpan(xr);
    var leftHit = false;
    for (t = 0; t < 3 && t < w; t++) if (colCnt(t) >= h * EDGE_FRAC) { leftHit = true; break; }
    if (leftHit) for (var xl = 0; xl < Math.min(bandX, w); xl++) colSpan(xl);
  }

  // 只修补仍有前景证据的孔洞，保留发丝间与手臂间的真实背景。
  function fillHoles(bin, w, h, conf) {
    var N = w * h;
    var reach = new Uint8Array(N);
    var stack = new Int32Array(N);
    var sp = 0;
    function push(p) { if (bin[p] === 0 && reach[p] === 0) { reach[p] = 1; stack[sp++] = p; } }
    for (var x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (var y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp > 0) {
      var p = stack[--sp];
      var px = p % w, py = (p / w) | 0;
      if (px > 0) push(p - 1);
      if (px < w - 1) push(p + 1);
      if (py > 0) push(p - w);
      if (py < h - 1) push(p + w);
    }
    for (var i = 0; i < N; i++) {
      if (bin[i] === 0 && reach[i] === 0 && conf[i] >= 0.35) bin[i] = 1;
    }
  }

  /* 轮廓透明度 + 发丝混色净化：
     边界窄带内解 C = a·F + (1-a)·B 得到连续 alpha；发丝主导像素再把混合色
     反解为纯前景色写回工作图，换底时发梢不会残留原背景的彩色光晕。
     直接修改 rgba（调用方需把该 ImageData 写回工作画布）。 */
  function refineAlpha(bin, conf, rgba, w, h, classes) {
    var N = bin.length;
    var radius = Math.max(3, Math.round(Math.min(w, h) * 0.01));
    var density = boxBlur(bin, w, h, radius);
    var edge = boxBlur(bin, w, h, 1);
    // 5×5 前景占比：颜色方程无解的发丝外圈用它做亚像素柔边
    var cover = boxBlur(bin, w, h, 2);
    var hair = classes.hair, clothes = classes.clothes, face = classes.face;
    var fg = new Float32Array(N), bg = new Float32Array(N);
    var alpha = new Uint8Array(N);
    var gBg = [0, 0, 0], bgCount = 0;
    for (var i = 0; i < N; i++) {
      alpha[i] = bin[i] ? 255 : 0;
      fg[i] = density[i] > 0.995 && conf[i] >= 0.7 ? 1 : 0;
      bg[i] = density[i] < 0.005 && conf[i] <= 0.15 ? 1 : 0;
      if (hair && bg[i]) {
        bgCount++;
        gBg[0] += rgba[i * 4]; gBg[1] += rgba[i * 4 + 1]; gBg[2] += rgba[i * 4 + 2];
      }
    }
    // 全图背景均值：局部估计不可用时的净化基准，样本太少则不启用
    var hasGlobal = bgCount >= 512;
    if (hasGlobal) { gBg[0] /= bgCount; gBg[1] /= bgCount; gBg[2] /= bgCount; }
    var sampleRadius = radius * 4;
    var fgWeight = boxBlur(fg, w, h, sampleRadius);
    var bgWeight = boxBlur(bg, w, h, sampleRadius);
    var dot = new Float32Array(N), norm = new Float32Array(N), distance = new Float32Array(N);
    var fgColor = new Float32Array(N), bgColor = new Float32Array(N);
    var bMap = hair ? new Uint8Array(N * 3) : null;   // 逐像素局部背景色（0..255）
    for (var channel = 0; channel < 3; channel++) {
      for (var j = 0; j < N; j++) {
        var value = rgba[j * 4 + channel] / 255;
        fgColor[j] = value * fg[j];
        bgColor[j] = value * bg[j];
      }
      var meanF = boxBlur(fgColor, w, h, sampleRadius);
      var meanB = boxBlur(bgColor, w, h, sampleRadius);
      for (var k = 0; k < N; k++) {
        if (fgWeight[k] < 0.001 || bgWeight[k] < 0.001) continue;
        var b = meanB[k] / bgWeight[k];
        if (bMap) bMap[k * 3 + channel] = bgWeight[k] >= 0.02
          ? Math.max(0, Math.min(255, Math.round(b * 255))) : 0;
        var delta = meanF[k] / fgWeight[k] - b;
        var observed = rgba[k * 4 + channel] / 255 - b;
        dot[k] += observed * delta;
        norm[k] += delta * delta;
        distance[k] += observed * observed;
      }
    }
    // F = C + k·(C − B)，k=(1−a)/a；上限避免把噪声放大成色斑
    function purify(p, a, b0, b1, b2, limit) {
      var k = Math.min(limit, (1 - a) / Math.max(a, 1e-3));
      if (k <= 0.01) return;
      var o = p * 4;
      rgba[o] += k * (rgba[o] - b0);
      rgba[o + 1] += k * (rgba[o + 1] - b1);
      rgba[o + 2] += k * (rgba[o + 2] - b2);
    }
    for (var p = 0; p < N; p++) {
      if (density[p] <= 0.005 || density[p] >= 0.995) continue;
      var hp = hair ? hair[p] : 0;
      var strand = hp > 0.15 && hp > Math.max(clothes ? clothes[p] : 0, face ? face[p] : 0);
      // 皮肤和花纹衣物不能用宽带颜色混合推断透明度，否则浅色纹理会被挖空。
      if (!strand) {
        if (edge[p] <= 0 || edge[p] >= 1) continue;
        if (bin[p] && conf[p] >= 0.85) continue;
      }
      var a = -1;
      if ((bin[p] || conf[p] >= 0.02) && fgWeight[p] >= 0.001 &&
          bgWeight[p] >= 0.001 && norm[p] >= 0.01) {
        var est = Math.max(0, Math.min(1, dot[p] / norm[p]));
        var residual = distance[p] - 2 * est * dot[p] + est * est * norm[p];
        if (residual <= 0.03) a = Math.max(0, Math.min(1, (est - 0.03) / 0.94));
      }
      if (a >= 0) {
        if (strand && a >= 0.12) {
          var o = p * 3;
          purify(p, a, bMap[o], bMap[o + 1], bMap[o + 2], 1.5);
        }
      } else if (strand && bin[p] && hasGlobal && cover[p] < 0.999) {
        // 前背景同色等无解情形：发丝仍按覆盖率柔边，并按全局背景色做保守净化
        a = Math.max(0, Math.min(1, (cover[p] - 0.30) / 0.62));
        purify(p, Math.max(a, 0.35), gBg[0], gBg[1], gBg[2], 0.4);
      } else {
        continue;   // 证据不足时保留语义轮廓的原值
      }
      alpha[p] = Math.round(a * 255);
    }
    return alpha;
  }

  /* 发丝间隙透出原底色：判据是「离背景色比离发色近得多」且该处与画面外背景连通
     ——只有这样的窄通道才是发丝间真正透出的墙，而不是发丝高光或孤立亮斑。
     再加语义护栏：模型判为衣服/脸部、人像证据强或处在头发包围区之外的一律不动。 */
  function clearHairGaps(alpha, bin, conf, rgba, classes, w, h) {
    var N = w * h;
    var hair = classes.hair, clothes = classes.clothes, face = classes.face;
    if (!hair) return 0;
    var isHair = new Uint8Array(N);
    var hR = 0, hG = 0, hB = 0, hn = 0;
    for (var i = 0; i < N; i++) {
      var hv = hair[i];
      if (hv <= 0.3 || hv <= Math.max(clothes ? clothes[i] : 0, face ? face[i] : 0)) continue;
      isHair[i] = 1;
      if (bin[i] && conf[i] >= 0.8) {
        var o = i * 4;
        hR += rgba[o]; hG += rgba[o + 1]; hB += rgba[o + 2]; hn++;
      }
    }
    if (hn < 256) return 0;                     // 没有可靠发色参照 → 无从判定
    hR /= hn; hG /= hn; hB /= hn;
    var rr = Math.max(6, Math.round(Math.min(w, h) * 0.02));
    var trust = new Float32Array(N), cr = new Float32Array(N), cg = new Float32Array(N), cb = new Float32Array(N);
    var n = 0, bR = 0, bG = 0, bB = 0;
    for (var s = 0; s < N; s++) {
      if (bin[s] || conf[s] > 0.15) continue;   // 蒙版外且模型也不认为是人像 → 真背景样本
      var so = s * 4;
      trust[s] = 1; cr[s] = rgba[so]; cg[s] = rgba[so + 1]; cb[s] = rgba[so + 2]; n++;
      bR += rgba[so]; bG += rgba[so + 1]; bB += rgba[so + 2];
    }
    if (n < 512) return 0;
    bR /= n; bG /= n; bB /= n;
    // 局部背景色场：墙面有明暗渐变时不能用全图均值当参照
    var wt = boxBlur(trust, w, h, rr);
    var lr = boxBlur(cr, w, h, rr), lg = boxBlur(cg, w, h, rr), lb = boxBlur(cb, w, h, rr);
    trust = cr = cg = cb = null;
    var near = new Uint8Array(N);
    for (var p = 0; p < N; p++) {
      var q = p * 4;
      // 头发内部深处的缺口取不到局部样本，退回全图均值：仍有连通性和语义护栏兜底
      var iw = wt[p] >= 0.05 ? 1 / wt[p] : 0;
      var rBg = iw ? lr[p] * iw : bR, gBg = iw ? lg[p] * iw : bG, bBg = iw ? lb[p] * iw : bB;
      var dBg = Math.abs(rgba[q] - rBg) + Math.abs(rgba[q + 1] - gBg) + Math.abs(rgba[q + 2] - bBg);
      var dHair = Math.abs(rgba[q] - hR) + Math.abs(rgba[q + 1] - hG) + Math.abs(rgba[q + 2] - hB);
      near[p] = dBg < dHair * 0.5 ? 1 : 0;
    }
    wt = lr = lg = lb = null;
    // 只有被头发包围的间隙才处理，避免吃穿浅色衣领与脸部高光
    var r = Math.max(4, rr);
    var hairDens = boxBlur(isHair, w, h, r);
    var reach = new Uint8Array(N), stack = new Int32Array(N), sp = 0;
    function push(p) { if (near[p] && !reach[p]) { reach[p] = 1; stack[sp++] = p; } }
    for (var x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (var y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp > 0) {
      var c = stack[--sp];
      var cx = c % w, cy = (c / w) | 0;
      if (cx > 0) push(c - 1);
      if (cx < w - 1) push(c + 1);
      if (cy > 0) push(c - w);
      if (cy < h - 1) push(c + w);
    }
    var punch = [];
    function eligible(k2) {
      if (alpha[k2] === 0 || !near[k2] || !bin[k2]) return false;
      if (!reach[k2]) return false;                             // 孤立亮斑：不动
      if (conf[k2] >= 0.6) return false;                        // 人像证据强：不动
      if (hairDens[k2] < 0.12) return false;                    // 不在头发包围区内：不动
      if (clothes && clothes[k2] > hair[k2]) return false;      // 模型判为衣服：那是浅色衣领不是间隙
      if (face && face[k2] > hair[k2]) return false;
      return true;
    }
    for (var k2 = 0; k2 < N; k2++) if (eligible(k2)) punch.push(k2);
    if (punch.length > N * 0.02) return 0;   // 大面积同色说明判定不可靠，整体放弃
    for (var i2 = 0; i2 < punch.length; i2++) alpha[punch[i2]] = 0;
    return punch.length;
  }

  function alphaToCanvas(alpha, w, h) {
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(w, h);
    var d = img.data;
    for (var i = 0, j = 0; i < alpha.length; i++, j += 4) {
      d[j] = 255; d[j + 1] = 255; d[j + 2] = 255;
      d[j + 3] = alpha[i];
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /* 主入口：image → { workCanvas, maskCanvas }；onProgress(text) 可选进度回调 */
  async function segment(image, onProgress) {
    var report = onProgress || function () {};
    await init();
    var work = makeWorkCanvas(image);

    // 1) 粗分割：整图推理，建立全图人像置信度锚点
    report('AI 智能识别人像…');
    await yieldUI();
    var coarse;
    var res = segmenter.segment(work);
    try {
      coarse = extractPersonConf(res, work.width, work.height);
    } finally {
      if (res && res.close) res.close();
    }
    var baseConf = coarse.conf;

    // 2) 大图分块精修（长边 ≥ 800 时启用）
    var conf;
    if (Math.max(work.width, work.height) >= TILED_MIN) {
      conf = await tiledRefine(work, baseConf, report);
    } else {
      conf = baseConf;
    }

    // 3) 导向滤波边缘精修：以原图灰度为引导，遮罩边缘吸附到真实发丝/衣缘
    report('AI 边缘对齐…');
    await yieldUI();
    var W = work.width, H = work.height;
    var wctx = work.getContext('2d', { willReadFrequently: true });
    var wimg = wctx.getImageData(0, 0, W, H);
    var wd = wimg.data;
    var lum = new Float32Array(W * H);
    for (var li = 0, lj = 0; li < lum.length; li++, lj += 4) {
      lum[li] = (0.299 * wd[lj] + 0.587 * wd[lj + 1] + 0.114 * wd[lj + 2]) / 255;
    }
    var guided = guidedFilter(conf, lum, W, H,
      Math.max(6, Math.round(Math.min(W, H) * 0.01)), 8e-4);
    /* 与原置信度混合：导向滤波只主导边缘吸附，避免把纹理丰富的衣服/脸部区域过度纠偏 */
    for (var gi = 0; gi < conf.length; gi++) {
      conf[gi] = guided[gi] * 0.75 + conf[gi] * 0.25;
    }

    // 3.5) 头发细节导向滤波：头发主导区用小半径低 eps 二次精修，
    //      把遮罩边缘吸附到单根发丝级轮廓（大半径 pass 负责整体边缘）
    var hair = coarse.hair, clothes = coarse.clothes, face = coarse.face;
    if (hair) {
      var gSmall = guidedFilter(conf, lum, W, H, 4, 1.5e-4);
      for (var hi = 0; hi < conf.length; hi++) {
        if (hair[hi] > 0.3) conf[hi] = gSmall[hi] * 0.6 + conf[hi] * 0.4;
      }
    }

    // 3.6) 分类感知增强：头发/白衣服专属通道增益 + 阈值下调（须在二值化之前）
    classBoost(conf, hair, clothes, face);

    // 4) 二值化（滞后阈值：强 0.5 / 弱 0.35，头发/衣服主导区阈值适度下调）
    report('遮罩去噪与精修…');
    await yieldUI();
    var gain = classGain(hair, clothes, face);
    var bin = hysteresisBin(conf, W, H, 0.5, 0.35, gain);
    var hairMask = null;
    if (hair) {
      hairMask = new Uint8Array(W * H);
      for (var hm = 0; hm < hairMask.length; hm++) hairMask[hm] = hair[hm] > 0.3 ? 1 : 0;
    }
    bin = medianFilter3(bin, W, H, hairMask);
    solidifyBorders(bin, W, H, conf);
    bin = cleanComponents(bin, W, H);
    fillHoles(bin, W, H, conf);
    report('AI 发丝与人像轮廓透明度精修…');
    await yieldUI();
    var alpha = refineAlpha(bin, conf, wd, W, H, coarse);
    if (coarse.hair) {
      clearHairGaps(alpha, bin, conf, wd, coarse, W, H);   // 发丝间隙透出新的底色
      wctx.putImageData(wimg, 0, 0);                       // 发丝混色净化写回工作图
    }

    return { workCanvas: work, maskCanvas: alphaToCanvas(alpha, W, H), skin: coarse.skin || null };
  }

  return {
    init: init, segment: segment, isReady: isReady,
    whitenData: whitenData,   // 皮肤美白像素混合（app.js applyWhiten 调用）
    /* 内部纯算法函数，供 Node 冒烟测试（不依赖 DOM） */
    _test: { axisWeight: axisWeight, tileStarts: tileStarts, resampleF32: resampleF32, extractPersonConf: extractPersonConf, refineAlpha: refineAlpha, clearHairGaps: clearHairGaps, medianFilter3: medianFilter3, cleanComponents: cleanComponents, fillHoles: fillHoles, solidifyBorders: solidifyBorders, boxBlur: boxBlur, guidedFilter: guidedFilter, hysteresisBin: hysteresisBin, classBoost: classBoost, classGain: classGain, whitenData: whitenData }
  };
})();
