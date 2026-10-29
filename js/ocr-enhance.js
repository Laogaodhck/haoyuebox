/* ============================================================
 * ocr-enhance.js — OCR 图像增强与识别结果后处理（纯逻辑，可单测）
 * 纯本地实现，不依赖 DOM / Canvas，输入输出均为像素对象 {data,width,height}
 * （data 为 RGBA Uint8ClampedArray），便于 Node 单元测试。
 *
 * 图像增强管线（对应模糊 / 倾斜 / 低光照 / 复杂背景四类退化）：
 *  1. 灰度 + 亮度 / 对比度 / 模糊度统计；
 *  2. 投影剖面方差估计文字倾斜角（粗扫 2° 步进 + 细化 0.5°），
 *     剪切变换纠偏（逐列垂直平移，无重采样损失）；
 *  3. 直方图 2%/98% 百分位对比度拉伸（低光照自适应）；
 *  4. 模糊度高时做非锐化掩模（unsharp mask）提升笔画边缘；
 *  5. Sauvola 自适应二值化（局部均值 + 标准差，压掉复杂背景、
 *     阴影与渐变光照），窗口按图像尺寸自适应；
 *  6. 二值图 3×3 孤点去噪。
 *
 * 结果后处理：
 *  - 全半角归一、中文间冗余空格压缩、标点空格整理；
 *  - 数字上下文字符纠错（O→0 / I→1 / B→8 等，仅命中数字串内部）；
 *  - 结构化字段提取：身份证号（含校验位验证与混淆位纠错）、
 *    手机号、日期；
 *  - 基于词级 bbox 的表格检测与网格还原、基于行 bbox 的段落重建。
 *
 * 依赖：无（App 仅用于挂载命名空间）。
 * ============================================================ */
(function (App) {
  'use strict';

  var CJK_RE = /[\u2e80-\u2eff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff01-\uff60\u2018\u2019\u201c\u201d]/;

  /* ================= 像素级基础 ================= */

  // RGBA → 灰度（ITU-R BT.601 亮度权重）
  function toGray(px) {
    var d = px.data, n = px.width * px.height;
    var g = new Uint8ClampedArray(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      g[i] = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000;
    }
    return g;
  }

  // 盒式降采样（长边压到 maxEdge 内），返回灰度
  function downscaleGray(gray, w, h, maxEdge) {
    var scale = Math.min(1, maxEdge / Math.max(w, h));
    if (scale >= 1) return { g: gray, w: w, h: h, scale: 1 };
    var sw = Math.max(1, Math.round(w * scale));
    var sh = Math.max(1, Math.round(h * scale));
    var out = new Float64Array(sw * sh);
    var cnt = new Float64Array(sw * sh);
    for (var y = 0; y < h; y++) {
      var sy = Math.min(sh - 1, (y * scale) | 0);
      for (var x = 0; x < w; x++) {
        var sx = Math.min(sw - 1, (x * scale) | 0);
        var k = sy * sw + sx;
        out[k] += gray[y * w + x];
        cnt[k] += 1;
      }
    }
    var g = new Uint8ClampedArray(sw * sh);
    for (var i = 0; i < g.length; i++) g[i] = out[i] / cnt[i];
    return { g: g, w: sw, h: sh, scale: scale };
  }

  // Otsu 全局阈值（直方图法，返回 0-255）
  function otsu(gray) {
    var hist = new Float64Array(256);
    for (var i = 0; i < gray.length; i++) hist[gray[i]]++;
    var total = gray.length, sum = 0;
    for (var t = 0; t < 256; t++) sum += t * hist[t];
    var sumB = 0, wB = 0, best = 0, thr = 128;
    for (var t2 = 0; t2 < 256; t2++) {
      wB += hist[t2];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += t2 * hist[t2];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t2; }
    }
    return thr;
  }

  /* ================= 倾斜估计与纠偏 ================= */

  // 投影剖面方差估计文字倾斜角（度）。
  // 返回值 a 的含义：行走向满足 y ≈ y0 - (x-x0)·tan(a)（a>0 表示文字向右上扬），
  // 对该角做剪切纠偏后行恢复水平。
  function estimateSkew(gray, w, h) {
    var ds = downscaleGray(gray, w, h, 700);
    var sg = ds.g, sw = ds.w, sh = ds.h;
    var thr = otsu(sg);
    // Otsu 在双峰间隙内并列最优时返回间隙下界（暗簇上缘），须用 <= 才能取到墨点
    var ink = [];
    for (var i = 0; i < sg.length; i++) if (sg[i] <= thr) ink.push(i);
    if (ink.length < 30) return 0; // 近空白图，无从估计
    var cx = sw / 2;
    function score(deg) {
      var tan = Math.tan(deg * Math.PI / 180);
      var span = Math.ceil(Math.abs(tan) * sw) + 2;
      var rows = new Float64Array(sh + span);
      for (var k = 0; k < ink.length; k++) {
        var idx = ink[k];
        var y = (idx / sw) | 0, x = idx - y * sw;
        var yy = Math.round(y + (x - cx) * tan) + (span >> 1);
        if (yy < 0) yy = 0; else if (yy >= rows.length) yy = rows.length - 1;
        rows[yy] += 1;
      }
      var s = 0;
      for (var r = 0; r < rows.length; r++) s += rows[r] * rows[r];
      return s;
    }
    // 粗扫 -12..12 步进 2，再在最优角 ±2 内步进 0.5 细化
    var bestA = 0, bestS = -1;
    for (var a = -12; a <= 12; a += 2) {
      var s = score(a);
      if (s > bestS) { bestS = s; bestA = a; }
    }
    var fine = bestA;
    for (var a2 = bestA - 2; a2 <= bestA + 2 + 1e-9; a2 += 0.25) {
      var s2 = score(a2);
      if (s2 > bestS) { bestS = s2; fine = a2; }
    }
    return fine;
  }

  // 剪切纠偏：按估计角反向逐列平移，输出高维度加边距（白底填充）。
  // angleDeg 为 estimateSkew 的返回值，作用后行恢复水平。
  function deskewShearRGBA(px, angleDeg) {
    if (!angleDeg) return px;
    var w = px.width, h = px.height, d = px.data;
    var tan = Math.tan(angleDeg * Math.PI / 180);
    var span = Math.ceil(Math.abs(tan) * w);
    var ow = w, oh = h + span;
    var out = new Uint8ClampedArray(ow * oh * 4);
    // 白底
    for (var i = 0; i < out.length; i += 4) {
      out[i] = 255; out[i + 1] = 255; out[i + 2] = 255; out[i + 3] = 255;
    }
    var cx = w / 2;
    for (var y = 0; y < oh; y++) {
      for (var x = 0; x < ow; x++) {
        // 目标行 y 对应源行：y = sy + (x-cx)·tan → sy = y - (x-cx)·tan
        var sy = Math.round(y - (x - cx) * tan);
        if (sy < 0 || sy >= h) continue;
        var si = (sy * w + x) * 4, di = (y * ow + x) * 4;
        out[di] = d[si]; out[di + 1] = d[si + 1];
        out[di + 2] = d[si + 2]; out[di + 3] = d[si + 3];
      }
    }
    return { data: out, width: ow, height: oh };
  }

  /* ================= 对比度 / 锐化 / 二值化 ================= */

  // 百分位对比度拉伸：p2/p98 → 0/255（低光照、灰暗扫描件自适应）
  function percentileNorm(gray, w, h) {
    var hist = new Float64Array(256);
    for (var i = 0; i < gray.length; i++) hist[gray[i]]++;
    var total = gray.length, lo = 0, hi = 255, acc = 0;
    var loTarget = total * 0.02, hiTarget = total * 0.98;
    for (var t = 0; t < 256; t++) {
      acc += hist[t];
      if (acc >= loTarget) { lo = t; break; }
    }
    acc = 0;
    for (var t2 = 255; t2 >= 0; t2--) {
      acc += hist[t2];
      if (acc >= total - hiTarget) { hi = t2; break; }
    }
    if (hi - lo < 12) return gray; // 动态范围已足，不拉伸
    var out = new Uint8ClampedArray(gray.length);
    var range = hi - lo;
    for (var j = 0; j < gray.length; j++) {
      out[j] = (gray[j] - lo) * 255 / range;
    }
    return out;
  }

  // 盒式模糊（3×3，滑动窗口），unsharp mask 用
  function boxBlur3(g, w, h) {
    var tmp = new Float64Array(g.length);
    var out = new Uint8ClampedArray(g.length);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var s = 0, c = 0;
        for (var dx = -1; dx <= 1; dx++) {
          var xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += g[y * w + xx]; c++;
        }
        tmp[y * w + x] = s / c;
      }
    }
    for (var y2 = 0; y2 < h; y2++) {
      for (var x2 = 0; x2 < w; x2++) {
        var s2 = 0, c2 = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y2 + dy;
          if (yy < 0 || yy >= h) continue;
          s2 += tmp[yy * w + x2]; c2++;
        }
        out[y2 * w + x2] = s2 / c2;
      }
    }
    return out;
  }

  // 非锐化掩模：g + amount·(g - blur)，增强笔画边缘（模糊图像用）
  function unsharp(g, w, h, amount) {
    var blur = boxBlur3(g, w, h);
    var out = new Uint8ClampedArray(g.length);
    for (var i = 0; i < g.length; i++) {
      out[i] = g[i] + amount * (g[i] - blur[i]);
    }
    return out;
  }

  // 拉普拉斯方差（模糊度指标，仅统计参考，作用于降采样灰度）
  function laplacianVar(sg, sw, sh) {
    var vals = [];
    for (var y = 1; y < sh - 1; y++) {
      for (var x = 1; x < sw - 1; x++) {
        var i = y * sw + x;
        var lap = 4 * sg[i] - sg[i - 1] - sg[i + 1] - sg[i - sw] - sg[i + sw];
        vals.push(lap);
      }
    }
    if (!vals.length) return 0;
    var mean = 0, i2;
    for (i2 = 0; i2 < vals.length; i2++) mean += vals[i2];
    mean /= vals.length;
    var v = 0;
    for (i2 = 0; i2 < vals.length; i2++) v += (vals[i2] - mean) * (vals[i2] - mean);
    return v / vals.length;
  }

  // Sauvola 自适应二值化：T = mean·(1 + k·(std/R - 1))，R=128。
  // 积分图 O(n)，窗口按图像短边自适应。输出 0=文字（墨），255=背景。
  function sauvolaBinarize(gray, w, h, opts) {
    var k = (opts && typeof opts.k === 'number') ? opts.k : 0.25;
    var R = 128;
    // 窗口须明显大于笔画宽度（否则笔画内部 std→0，阈值跌破墨值导致镂空），
    // 取短边 20% 并放宽下限
    var win = Math.round(Math.min(w, h) * 0.2) | 1;
    if (win < 31) win = 31; else if (win > 151) win = 151;
    // 积分图 + 平方积分图（(w+1)*(h+1)）
    var iw = w + 1;
    var I = new Float64Array(iw * (h + 1));
    var I2 = new Float64Array(iw * (h + 1));
    for (var y = 0; y < h; y++) {
      var rs = 0, rs2 = 0;
      for (var x = 0; x < w; x++) {
        var v = gray[y * w + x];
        rs += v; rs2 = rs2 + v * v;
        I[(y + 1) * iw + x + 1] = I[y * iw + x + 1] + rs;
        I2[(y + 1) * iw + x + 1] = I2[y * iw + x + 1] + rs2;
      }
    }
    var half = win >> 1;
    var out = new Uint8ClampedArray(w * h);
    for (var py = 0; py < h; py++) {
      var y0 = py - half; if (y0 < 0) y0 = 0;
      var y1 = py + half; if (y1 > h - 1) y1 = h - 1;
      for (var px = 0; px < w; px++) {
        var x0 = px - half; if (x0 < 0) x0 = 0;
        var x1 = px + half; if (x1 > w - 1) x1 = w - 1;
        var n = (y1 - y0 + 1) * (x1 - x0 + 1);
        var a = y0 * iw + x0, b = y0 * iw + x1 + 1;
        var c = (y1 + 1) * iw + x0, d2 = (y1 + 1) * iw + x1 + 1;
        var s = I[d2] - I[b] - I[c] + I[a];
        var s2 = I2[d2] - I2[b] - I2[c] + I2[a];
        var m = s / n;
        var va = s2 / n - m * m;
        if (va < 0) va = 0;
        var sd = Math.sqrt(va);
        var thr = m * (1 + k * (sd / R - 1));
        out[py * w + px] = gray[py * w + px] < thr ? 0 : 255;
      }
    }
    return out;
  }

  // 二值图去噪：3×3 内墨点（含自身）≤2 视为孤立噪点转背景
  function denoiseBinary(bin, w, h) {
    var out = new Uint8ClampedArray(bin);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (bin[y * w + x] !== 0) continue;
        var cnt = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            if (bin[yy * w + xx] === 0) cnt++;
          }
        }
        if (cnt <= 2) out[y * w + x] = 255;
      }
    }
    return out;
  }

  function binToRGBA(bin, w, h) {
    var out = new Uint8ClampedArray(w * h * 4);
    for (var i = 0, j = 0; i < bin.length; i++, j += 4) {
      var v = bin[i];
      out[j] = v; out[j + 1] = v; out[j + 2] = v; out[j + 3] = 255;
    }
    return { data: out, width: w, height: h };
  }

  /* ================= 增强主入口 ================= */

  // 完整增强管线。opts: {mode: 'full'|'gray'|'off', k, sharpenAmount, autoInvert, minSkew}
  //  mode='full' 二值化（默认，适合低分辨率/低光照/反色）；'gray' 仅灰度+拉伸/锐化（保留抗锯齿，
  //  适合干净件与纹理背景）；'off' 只做纠偏与统计。
  // 返回 {px, info}；info 含 skew / brightness / blur / 动作标记（含极性翻转）
  function enhance(px, opts) {
    var o = opts || {};
    var mode = o.mode || 'full';
    var k = typeof o.k === 'number' ? o.k : 0.25;
    var sharpenAmount = typeof o.sharpenAmount === 'number' ? o.sharpenAmount : 0.6;
    var autoInvert = o.autoInvert !== false;
    var minSkew = typeof o.minSkew === 'number' ? o.minSkew : 0.6;
    var w = px.width, h = px.height;
    var gray = toGray(px);
    var skew = estimateSkew(gray, w, h);
    var deskewed = Math.abs(skew) >= minSkew ? deskewShearRGBA(px, skew) : px;
    var work = deskewed === px ? { data: null, width: w, height: h } : deskewed;
    var gray2 = deskewed === px ? gray : toGray(deskewed);
    // 亮度 / 对比度 / 模糊度统计（降采样上算，省时）
    var ds = downscaleGray(gray2, work.width, work.height, 500);
    var mean = 0;
    for (var i = 0; i < ds.g.length; i++) mean += ds.g[i];
    mean /= ds.g.length;
    var blurVar = laplacianVar(ds.g, ds.w, ds.h);
    var info = {
      skew: skew,
      deskewed: deskewed !== px,
      brightness: Math.round(mean),
      blur: Math.round(blurVar),
      sharpened: false,
      inverted: false,
      lowLight: mean < 100,
      mode: mode
    };
    if (mode === 'off') {
      if (deskewed === px) return { px: px, info: info };
      return { px: deskewed, info: info };
    }
    var norm = percentileNorm(gray2, work.width, work.height);
    // 暗底浅字：Sauvola 假定"暗字亮底"，直接在深底图上会整幅判白。
    // 二值化前先取反（仅 full 档，且整体明显偏暗时），post-check 仍保留兜底。
    if (mode === 'full' && autoInvert && mean < 110) {
      for (var pi = 0; pi < norm.length; pi++) norm[pi] = 255 - norm[pi];
      info.inverted = true;
    }
    if (blurVar < 60 && work.width > 32) {
      norm = unsharp(norm, work.width, work.height, sharpenAmount);
      info.sharpened = true;
    }
    if (mode === 'gray') {
      var rgba = new Uint8ClampedArray(norm.length * 4);
      for (var gi = 0, gj = 0; gi < norm.length; gi++, gj += 4) {
        var v = norm[gi];
        rgba[gj] = v; rgba[gj + 1] = v; rgba[gj + 2] = v; rgba[gj + 3] = 255;
      }
      return { px: { data: rgba, width: work.width, height: work.height }, info: info };
    }
    var bin = sauvolaBinarize(norm, work.width, work.height, { k: k });
    bin = denoiseBinary(bin, work.width, work.height);
    // 明暗极性归一（兜底）：未预取反但二值化后墨点仍过半 → 整幅取反
    if (autoInvert && !info.inverted) {
      var ink = 0;
      for (var j = 0; j < bin.length; j++) if (bin[j] === 0) ink++;
      if (ink / bin.length > 0.5) {
        for (var m = 0; m < bin.length; m++) bin[m] = bin[m] === 0 ? 255 : 0;
        info.inverted = true;
      }
    }
    return { px: binToRGBA(bin, work.width, work.height), info: info };
  }

  /* ================= 文本后处理 ================= */

  // 全半角归一 + 冗余空格压缩 + 标点空格整理（逐行）
  function normalizeLine(line) {
    var s = String(line || '')
      .replace(/[\uFF10-\uFF19]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[\uFF21-\uFF3A\uFF41-\uFF5A]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/\u3000/g, ' ');
    // 中文字符之间的空串压掉（OCR 常见切分噪声）
    s = s.replace(/([\u4e00-\u9fff\u3001\u3002\uff0c\uff1b\uff1a\uff1f\uff01\u300a\u300b\u201c\u201d])[ ]+(?=[\u4e00-\u9fff\u3001\u3002\uff0c\uff1b\uff1a\uff1f\uff01\u300a\u300b\u201c\u201d])/g, '$1');
    // 标点前的空格去掉
    s = s.replace(/[ ]+([，。；：、！？）》】])/g, '$1');
    s = s.replace(/([（《【])[ ]+/g, '$1');
    // 中文后紧跟的 ASCII 标点归一为全角（OCR 常把「备注：」输出为「备注 :」）；
    // 西文上下文的标点保持原样（Email: / Tel:）
    s = s.replace(/([\u4e00-\u9fff])\s*([:;,!?])\s*/g, function (m, pre, p) {
      return pre + ({ ':': '：', ';': '；', ',': '，', '!': '！', '?': '？' })[p];
    });
    // 数字与中文日期单位之间的空格去掉（「2026 年 10 月」→「2026年10月」）
    s = s.replace(/(\d)\s+(?=[年月日])/g, '$1').replace(/([年月日])\s+(?=\d)/g, '$1');
    s = s.replace(/[ \t]+/g, ' ').trim();
    return s;
  }

  // 数字上下文混淆纠错：仅当令牌含数字、且除易混字符外不含其他字母时映射。
  // 含 A/C/E/F 等真实字母的令牌是型号/编号（如 A12-38B、B1280），一律不改写——
  // 否则会把编号尾部的 B 改成 8；纯字母单词（ZOO / OK）同样不受影响。
  var DIGIT_FIX = { O: '0', o: '0', Q: '0', I: '1', l: '1', '|': '1', Z: '2', S: '5', B: '8', G: '6', q: '9', D: '0' };
  // 按「非中西文标点空白」切令牌，分隔符随原文保留
  var TOKEN_RE = /[^\s\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/g;
  var FIX_RESIDUE = /[0-9OoQIl|ZSBGqD.,:%+\-/$¥\\()[\]]/g;
  function fixDigitContext(s) {
    return String(s || '').replace(TOKEN_RE, function (tok) {
      if (!/\d/.test(tok) || !/[A-Za-z]/.test(tok)) return tok;
      if (tok.replace(FIX_RESIDUE, '')) return tok; // 残留真实字母 → 型号/编号，不改写
      return tok.replace(/[OoQIl|ZSBGqD]/g, function (c) { return DIGIT_FIX[c]; });
    });
  }

  /* ---------- 结构化字段提取 ---------- */

  // 身份证校验码（GB 11643-1999）：权重与 mod11 映射
  var ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  var ID_MAP = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  function idChecksumOk(id) {
    var s = String(id || '').toUpperCase();
    if (!/^\d{17}[\dX]$/.test(s)) return false;
    var sum = 0;
    for (var i = 0; i < 17; i++) sum += Number(s[i]) * ID_WEIGHTS[i];
    return ID_MAP[sum % 11] === s[17];
  }
  // 对校验失败的证号尝试逐位混淆替换，使校验通过（唯一解才采纳）。
  // 允许输入含 OCR 混淆字符（O/Q/D→0、I/L→1、Z→2、S→5、B→8、G→6）。
  var ID_FIXABLE = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' };
  function fixIdCard(id) {
    var s = String(id || '').toUpperCase();
    if (!/^[0-9OQDILZSBG]{17}[0-9XOQDILZSBG]$/.test(s) || idChecksumOk(s)) return null;
    var candidates = [];
    for (var i = 0; i < 18; i++) {
      var d = ID_FIXABLE[s[i]];
      if (d === undefined) continue;
      var fixed = s.slice(0, i) + d + s.slice(i + 1);
      if (idChecksumOk(fixed)) candidates.push(fixed);
    }
    // 去重后唯一才纠错
    var uniq = candidates.filter(function (v, idx) { return candidates.indexOf(v) === idx; });
    return uniq.length === 1 ? uniq[0] : null;
  }

  var RE_ID = /(^|[^0-9Xx])([1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])($|[^0-9Xx])/g;
  var RE_PHONE = /(^|\D)(1[3-9]\d{9})($|\D)/g;
  var RE_DATE = /\d{4}[-/.年]\s?\d{1,2}[-/.月]\s?\d{1,2}日?/g;

  // 提取结构化字段：返回 {idCards:[{value,valid,fixed}], phones:[], dates:[]}
  function extractFields(text) {
    var t = String(text || '');
    var idCards = [], seen = {};
    var m;
    RE_ID.lastIndex = 0;
    while ((m = RE_ID.exec(t)) !== null) {
      var raw = m[2].toUpperCase();
      if (seen[raw]) continue;
      seen[raw] = true;
      var entry = { value: raw, valid: idChecksumOk(raw), fixed: null };
      if (!entry.valid) {
        var fx = fixIdCard(raw);
        if (fx) { entry.fixed = fx; entry.valid = true; }
      }
      idCards.push(entry);
    }
    var phones = [], seenP = {};
    RE_PHONE.lastIndex = 0;
    while ((m = RE_PHONE.exec(t)) !== null) {
      if (!seenP[m[2]]) { seenP[m[2]] = true; phones.push(m[2]); }
    }
    var dates = [], seenD = {};
    RE_DATE.lastIndex = 0;
    while ((m = RE_DATE.exec(t)) !== null) {
      if (!seenD[m[0]]) { seenD[m[0]] = true; dates.push(m[0]); }
    }
    return { idCards: idCards, phones: phones, dates: dates };
  }

  /* ---------- 版面重建（bbox 级） ---------- */

  // 展示宽度（CJK 计 2、其余计 1），表格对齐用
  function displayWidth(s) {
    var w = 0;
    for (var i = 0; i < s.length; i++) {
      w += s.charCodeAt(i) > 0xFF ? 2 : 1;
    }
    return w;
  }
  function padEndDW(s, target) {
    var pad = target - displayWidth(s);
    var out = s;
    while (pad > 0) { out += pad >= 2 ? '\u3000' : ' '; pad -= 2; }
    return out;
  }
  function padStartDW(s, target) {
    var pad = target - displayWidth(s);
    var out = '';
    while (pad > 0) { out += pad >= 2 ? '\u3000' : ' '; pad -= 2; }
    return out + s;
  }

  // 从 Tesseract blocks 收集行：[{text, x0,y0,x1,y1, conf, words:[{text,bbox,conf}]}]
  function collectLines(blocks) {
    var lines = [];
    (blocks || []).forEach(function (b) {
      (b.paragraphs || []).forEach(function (p) {
        (p.lines || []).forEach(function (l) {
          var words = (l.words || []).filter(function (wd) {
            return wd && typeof wd.text === 'string' && wd.text.trim();
          });
          if (!words.length && !(l.text && l.text.trim())) return;
          var bb = l.bbox || {};
          var confSum = 0, confN = 0;
          words.forEach(function (wd) {
            if (typeof wd.confidence === 'number') { confSum += wd.confidence; confN++; }
          });
          lines.push({
            text: (l.text && l.text.trim()) ? l.text : words.map(function (wd) { return wd.text; }).join(' '),
            x0: bb.x0 != null ? bb.x0 : 0,
            y0: bb.y0 != null ? bb.y0 : 0,
            x1: bb.x1 != null ? bb.x1 : 0,
            y1: bb.y1 != null ? bb.y1 : 0,
            conf: confN ? confSum / confN : null,
            words: words
          });
        });
      });
    });
    lines.sort(function (a, b2) { return a.y0 - b2.y0 || a.x0 - b2.x0; });
    return lines;
  }

  // 词级表格检测：按 y 聚行、按 x 聚列，行列规模达标才认定表格。
  // 同时推断每列对齐方式（x0 / x1 / 中心离散度最小者）与相对列宽。
  // 返回 null 或 {rows, colCount, aligns:['left'|'center'|'right'], widths:[相对值], band}
  function detectTable(lines) {
    var words = [];
    lines.forEach(function (l) {
      l.words.forEach(function (wd) {
        var bb = wd.bbox || {};
        if (bb.x0 == null) return;
        words.push({
          text: wd.text, x0: bb.x0, x1: bb.x1, y0: bb.y0, y1: bb.y1,
          conf: (typeof wd.confidence === 'number') ? wd.confidence : null
        });
      });
    });
    if (words.length < 6) return null;
    // 行高中位数
    var hs = words.map(function (w) { return w.y1 - w.y0; }).sort(function (a, b) { return a - b; });
    var mh = hs[(hs.length / 2) | 0] || 10;
    // 聚行（y 中心距 > 0.6·行高 即新行）
    words.sort(function (a, b) { return (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2; });
    var rows = [], cur = null, lastCy = -1e9;
    words.forEach(function (w) {
      var cy = (w.y0 + w.y1) / 2;
      if (!cur || cy - lastCy > 0.6 * mh) { cur = []; rows.push(cur); }
      cur.push(w);
      lastCy = cy;
    });
    rows.forEach(function (r) { r.sort(function (a, b) { return a.x0 - b.x0; }); });
    if (rows.length < 3) return null;   // 少于 3 行不足以区分"表格"与"普通多行文本"
    // 词宽中位数（对齐容差与间隙判据用）
    var ws2 = words.map(function (w) { return w.x1 - w.x0; }).sort(function (a, b) { return a - b; });
    var mw = ws2[(ws2.length / 2) | 0] || 20;
    // 行内分格：同一单元格的词可能被 Tesseract 拆开（如「项 目」「均 摊」，
    // 粗体字距被当成词边界），先按水平间隙聚成单元格，再按单元格归列。
    // 阈值取 0.9·行高：格内字距远小于此，列间定界间隙远大于此。
    var cellGap = Math.max(12, mh * 0.9);
    var cellRows = rows.map(function (r) {
      var cells = [];
      r.forEach(function (w) {
        var cur2 = cells[cells.length - 1];
        if (cur2 && w.x0 - cur2.x1 <= cellGap) {
          var joiner = (CJK_RE.test(cur2.text[cur2.text.length - 1]) || CJK_RE.test(w.text[0])) ? '' : ' ';
          cur2.text += joiner + w.text;
          cur2.x1 = Math.max(cur2.x1, w.x1);
          if (w.conf != null) { cur2.confSum += w.conf; cur2.confN++; }
        } else {
          cells.push({
            text: w.text, x0: w.x0, x1: w.x1,
            confSum: (w.conf || 0), confN: (w.conf != null ? 1 : 0)
          });
        }
      });
      return cells;
    });
    var allCells = [];
    cellRows.forEach(function (r) { r.forEach(function (c) { allCells.push(c); }); });
    if (allCells.length < 4) return null;
    var cws = allCells.map(function (c) { return c.x1 - c.x0; }).sort(function (a, b) { return a - b; });
    var medCellW = cws[(cws.length / 2) | 0] || 20;
    // 归列：同一列的单元格要么左缘对齐（左对齐列），要么右缘对齐（右对齐列），
    // 要么区间大幅重叠（宽度不一的混合列）。此前按"中心距"归最近锚点，
    // 会把「合计」(91–142) 吸到相邻锚点 (124) 上，导致整列内容串位、首字被丢。
    var tolC = Math.max(8, medCellW * 0.3);
    function overlap(a0, a1, b0, b1) { return Math.min(a1, b1) - Math.max(a0, b0); }
    var colDefs = []; // {left, right, cells:[{ri, cell}]}
    cellRows.forEach(function (r, ri) {
      r.forEach(function (c) {
        var hit = null;
        for (var i = 0; i < colDefs.length; i++) {
          var d = colDefs[i];
          var minW = Math.min(c.x1 - c.x0, d.right - d.left) || 1;
          if (Math.abs(c.x0 - d.left) <= tolC || Math.abs(c.x1 - d.right) <= tolC ||
            overlap(c.x0, c.x1, d.left, d.right) >= minW * 0.5) {
            hit = d; break;
          }
        }
        if (!hit) { hit = { left: c.x0, right: c.x1, cells: [] }; colDefs.push(hit); }
        hit.cells.push({ ri: ri, cell: c });
      });
    });
    if (colDefs.length < 2) return null;
    // 列按左缘排序，保证输出列序与阅读顺序一致
    colDefs.sort(function (a, b) { return a.left - b.left; });
    // 列支持率：≥ 75% 行（且至少 3 行）才保留；行覆盖率不足则放弃
    var keepCols = colDefs.filter(function (d) {
      var rowsHit = {};
      d.cells.forEach(function (m) { rowsHit[m.ri] = true; });
      return Object.keys(rowsHit).length >= Math.max(3, cellRows.length * 0.75);
    });
    if (keepCols.length < 2) return null;
    var grid = cellRows.map(function () { return keepCols.map(function () { return null; }); });
    keepCols.forEach(function (d, ci) {
      d.cells.forEach(function (m) { grid[m.ri][ci] = m.cell; });
    });
    var filled = 0, total = 0;
    grid.forEach(function (row) {
      row.forEach(function (cell) {
        total++;
        if (cell != null) filled++;
      });
    });
    if (total < 6 || filled / total < 0.7) return null;
    var keptIdx = keepCols.map(function (_, ci) { return ci; });
    // 每列对齐推断：x0 离散小 → 左对齐；x1 离散小（且明显小于 x0）→ 右对齐；
    // 中心离散最小 → 居中。容差取词宽中位数 40%。
    // 稳定性过滤：三个边里至少有一个在容差内，否则该"列"只是普通文本的偶然对齐 → 丢弃
    var tolA = Math.max(8, mw * 0.4);
    function spread(arr) {
      var mn = Math.min.apply(null, arr), mx = Math.max.apply(null, arr);
      return mx - mn;
    }
    var cols = [];
    keptIdx.forEach(function (ci) {
      var cells = grid.map(function (row) { return row[ci]; }).filter(Boolean);
      var x0s = cells.map(function (c) { return c.x0; });
      var x1s = cells.map(function (c) { return c.x1; });
      var cs = cells.map(function (c) { return (c.x0 + c.x1) / 2; });
      var spL = spread(x0s), spR = spread(x1s), spC = spread(cs);
      var stable = (spL <= tolA) || (spR <= tolA) || (spC <= tolA);
      if (!stable) return;
      var al = 'left';
      if (spC <= tolA && spC < spL && spC < spR) al = 'center';
      else if (spR <= tolA && spR < spL) al = 'right';
      cols.push({
        idx: ci,
        align: al,
        width: Math.max(1, Math.max.apply(null, x1s) - Math.min.apply(null, x0s))
      });
    });
    if (cols.length < 2) return null;
    // 强判别：普通多行正文每行词数远多于列数（一句 10 个词），表格每格 1–2 个词。
    // 中位数词数 > 列数×1.8+1 直接判为非表格，避免把正文当成表格后"按列裁掉"其余文字。
    var wpr = rows.map(function (r) { return r.length; }).sort(function (a, b) { return a - b; });
    var medWords = wpr[(wpr.length / 2) | 0] || 0;
    if (medWords > cols.length * 1.8 + 1) return null;
    // 列间稳定间隙：表格列之间有明显空白（≥ 词宽中位数 25%）；正文词间距远小于此，
    // 该判据是"表格 vs 多列排版正文"的主要分水岭
    for (var gi = 0; gi + 1 < cols.length; gi++) {
      var gaps = [];
      for (var ri2 = 0; ri2 < grid.length; ri2++) {
        var cellA = grid[ri2][cols[gi].idx];
        var cellB = grid[ri2][cols[gi + 1].idx];
        if (cellA && cellB) gaps.push(cellB.x0 - cellA.x1);
      }
      if (!gaps.length) continue;
      gaps.sort(function (a, b) { return a - b; });
      if (gaps[(gaps.length / 2) | 0] < mw * 0.25) return null;
    }
    // 行带（每行 y 范围）与单元格裁剪框，供低置信单元格重识别
    var rowBands = rows.map(function (r) {
      var y0 = Math.min.apply(null, r.map(function (w) { return w.y0; }));
      var y1 = Math.max.apply(null, r.map(function (w) { return w.y1; }));
      return { y0: y0, y1: y1 };
    });
    var boxes = grid.map(function (row, ri) {
      return cols.map(function (c) {
        var cell = row[c.idx];
        return cell ? { x0: cell.x0, y0: rowBands[ri].y0, x1: cell.x1, y1: rowBands[ri].y1 } : null;
      });
    });
    var aligns = cols.map(function (c) { return c.align; });
    var widths = cols.map(function (c) { return c.width; });
    return {
      rows: grid.map(function (row) {
        return cols.map(function (c) {
          var cell = row[c.idx];
          return cell == null ? '' : cell.text;
        });
      }),
      // 单元格平均置信度（与 rows 同形，空单元格为 null），供低置信单元格重识别
      confs: grid.map(function (row) {
        return cols.map(function (c) {
          var cell = row[c.idx];
          return (cell && cell.confN) ? Math.round(cell.confSum / cell.confN) : null;
        });
      }),
      boxes: boxes,
      rowBands: rowBands,
      colCount: cols.length,
      aligns: aligns,
      widths: widths,
      band: {
        y0: Math.min.apply(null, words.map(function (w) { return w.y0; })),
        y1: Math.max.apply(null, words.map(function (w) { return w.y1; }))
      }
    };
  }

  // 表格网格文本渲染：按列对齐方式补格（全角空格），列间两个空格
  function renderGrid(table) {
    var aligns = table.aligns || [];
    var widths = [];
    table.rows.forEach(function (row) {
      row.forEach(function (cell, ci) {
        var w = displayWidth(String(cell || ''));
        widths[ci] = Math.max(widths[ci] || 0, w);
      });
    });
    return table.rows.map(function (row) {
      return row.map(function (cell, ci) {
        var s = String(cell || '');
        var w = widths[ci], dw = displayWidth(s);
        var al = aligns[ci] || 'left';
        if (w <= dw) return s;
        if (al === 'right') return padStartDW(s, w);
        if (al === 'center') {
          var lft = Math.floor((w - dw) / 2);
          return padStartDW('', lft) + s + padEndDW('', w - dw - lft);
        }
        return padEndDW(s, w);
      }).join('  ');
    }).join('\n');
  }

  // 段落结构化重建：行距 > 0.75·行高即分段；同段内按 CJK/西文决定连接符；
  // 段首行相对页面左缘的缩进超过 1.2·行高判定为首行缩进（indent=1）。
  // 返回 [{type:'p', text, indent}]
  function rebuildBlocks(lines) {
    if (!lines.length) return [];
    var hs = lines.map(function (l) { return l.y1 - l.y0; }).filter(function (v) { return v > 0; })
      .sort(function (a, b) { return a - b; });
    var mh = hs[(hs.length / 2) | 0] || 12;
    var margin = Math.min.apply(null, lines.map(function (l) { return l.x0; }));
    var indentThr = Math.max(1.2 * mh, 12);
    var blocks = [], paraText = '', paraIndent = 0;
    function flush() {
      if (paraText) blocks.push({ type: 'p', text: paraText, indent: paraIndent });
      paraText = '';
      paraIndent = 0;
    }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var txt = normalizeLine(ln.text);
      if (!txt) { flush(); continue; }
      if (!paraText) {
        paraText = txt;
        paraIndent = (ln.x0 - margin) > indentThr ? 1 : 0;
        continue;
      }
      var prev = lines[i - 1];
      var gap = ln.y0 - prev.y1;
      if (gap > 0.75 * mh) {
        flush();
        paraText = txt;
        paraIndent = (ln.x0 - margin) > indentThr ? 1 : 0;
      } else {
        var joiner = (CJK_RE.test(txt[0]) || CJK_RE.test(paraText[paraText.length - 1])) ? '' : ' ';
        paraText += joiner + txt;
      }
    }
    flush();
    return blocks;
  }

  // 段落重建（文本视图，保持既有 API 与断言兼容）
  function rebuildParagraphs(lines) {
    return rebuildBlocks(lines).map(function (b) { return b.text; }).join('\n\n');
  }

  // 结构化文档模型：blocks = 段落 + 表格块，供文本渲染与 DOCX 导出共用
  function buildDoc(data) {
    var lines = collectLines(data && data.blocks);
    if (!lines.length) return null;
    var cleaned = lines.map(function (l) {
      return { text: fixDigitContext(normalizeLine(l.text)), x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, words: l.words, conf: l.conf };
    });
    var table = detectTable(cleaned);
    var confSum = 0, confN = 0;
    cleaned.forEach(function (l) {
      if (typeof l.conf === 'number') { confSum += l.conf; confN++; }
    });
    var blocks;
    if (table) {
      // 表格带内 / 带外拆分：带内行（含表格行与零散行）由网格表达，
      // 带外行按段落重建，表格块置于正文之后
      var outLines = cleaned.filter(function (l) {
        var cy = (l.y0 + l.y1) / 2;
        return cy < table.band.y0 || cy > table.band.y1;
      });
      blocks = rebuildBlocks(outLines);
      blocks.push({
        type: 'table', rows: table.rows, aligns: table.aligns, widths: table.widths,
        confs: table.confs, boxes: table.boxes, rowBands: table.rowBands, band: table.band
      });
    } else {
      blocks = rebuildBlocks(cleaned);
    }
    return {
      blocks: blocks,
      conf: confN ? confSum / confN : null,
      lineCount: cleaned.length,
      hasTable: !!table,
      page: pageExtent(cleaned)
    };
  }

  // 页面外接尺寸（px）：优先词级 bbox，缺失时退回行级
  function pageExtent(lines) {
    var pw = 0, ph = 0;
    lines.forEach(function (l) {
      l.words.forEach(function (w) {
        var bb = w.bbox || {};
        if (bb.x1 != null) pw = Math.max(pw, bb.x1);
        if (bb.y1 != null) ph = Math.max(ph, bb.y1);
      });
    });
    if (!pw || !ph) {
      lines.forEach(function (l) {
        if (l.x1 != null) pw = Math.max(pw, l.x1);
        if (l.y1 != null) ph = Math.max(ph, l.y1);
      });
    }
    return { w: Math.round(pw), h: Math.round(ph) };
  }

  // 页面方向判定：宽高比 > 1.2 判为横向（横向扫描件 / 表格截图），否则竖向
  function pageOrientation(doc) {
    var p = (doc && doc.page) || {};
    if (!p.w || !p.h) return 'p';
    return (p.w / p.h) > 1.2 ? 'l' : 'p';
  }

  // 结构化块 → 文本视图（段落空行分隔、表格网格渲染）
  function renderDocText(blocks) {
    return (blocks || []).map(function (b) {
      if (b.type === 'table') return renderGrid(b);
      return b.text;
    }).join('\n\n');
  }

  // blocks → 版面还原文本：检测到表格时输出网格 + 表格带外的段落文本
  function buildFromBlocks(data) {
    var doc = buildDoc(data);
    if (!doc) return null;
    return {
      text: renderDocText(doc.blocks),
      conf: doc.conf,
      lineCount: doc.lineCount,
      hasTable: doc.hasTable,
      doc: doc
    };
  }

  /* ================= 测试钩子 ================= */

  App.ocrEnhance = {
    enhance: enhance,
    /* 倾斜角估计（度）：识别编排据此决定是否增加纯纠偏通道（仅统计，不改像素）。
     * 入参可为 canvas 或 {data,width,height} 像素对象。 */
    skewAngle: function (src) {
      if (!src || !src.width || !src.height) return 0;
      var px = (typeof src.getContext === 'function')
        ? src.getContext('2d').getImageData(0, 0, src.width, src.height)
        : src;
      if (!px || !px.data) return 0;
      return estimateSkew(toGray(px), px.width, px.height);
    },
    /* 后处理主入口（docs-ocr 调用）：纯文本模式下做归一 + 数字纠错 */
    polishText: function (raw) {
      var lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
      return lines.map(function (l) { return fixDigitContext(normalizeLine(l)); })
        .join('\n').replace(/\n{3,}/g, '\n\n').trim();
    },
    buildFromBlocks: buildFromBlocks,
    buildDoc: buildDoc,
    renderDocText: renderDocText,
    pageOrientation: pageOrientation,
    _test: {
      toGray: toGray,
      downscaleGray: downscaleGray,
      otsu: otsu,
      estimateSkew: estimateSkew,
      deskewShearRGBA: deskewShearRGBA,
      percentileNorm: percentileNorm,
      unsharp: unsharp,
      laplacianVar: laplacianVar,
      sauvolaBinarize: sauvolaBinarize,
      denoiseBinary: denoiseBinary,
      binToRGBA: binToRGBA,
      normalizeLine: normalizeLine,
      fixDigitContext: fixDigitContext,
      idChecksumOk: idChecksumOk,
      fixIdCard: fixIdCard,
      extractFields: extractFields,
      displayWidth: displayWidth,
      padEndDW: padEndDW,
      padStartDW: padStartDW,
      collectLines: collectLines,
      detectTable: detectTable,
      renderGrid: renderGrid,
      rebuildBlocks: rebuildBlocks,
      rebuildParagraphs: rebuildParagraphs,
      pageExtent: pageExtent
    }
  };
})(window.App);
