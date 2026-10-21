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
    for (var a2 = bestA - 2; a2 <= bestA + 2 + 1e-9; a2 += 0.5) {
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

  // 完整增强管线。返回 {px, info}；info 含 skew / brightness / blur / 动作标记。
  function enhance(px) {
    var w = px.width, h = px.height;
    var gray = toGray(px);
    var skew = estimateSkew(gray, w, h);
    var deskewed = Math.abs(skew) >= 0.6 ? deskewShearRGBA(px, skew) : px;
    var work = deskewed === px ? { data: null, width: w, height: h } : deskewed;
    var gray2 = deskewed === px ? gray : toGray(deskewed);
    // 亮度 / 对比度 / 模糊度统计（降采样上算，省时）
    var ds = downscaleGray(gray2, work.width, work.height, 500);
    var mean = 0;
    for (var i = 0; i < ds.g.length; i++) mean += ds.g[i];
    mean /= ds.g.length;
    var blurVar = laplacianVar(ds.g, ds.w, ds.h);
    var norm = percentileNorm(gray2, work.width, work.height);
    var sharpened = false;
    if (blurVar < 60 && work.width > 32) { norm = unsharp(norm, work.width, work.height, 0.6); sharpened = true; }
    var bin = sauvolaBinarize(norm, work.width, work.height);
    bin = denoiseBinary(bin, work.width, work.height);
    var out = binToRGBA(bin, work.width, work.height);
    return {
      px: out,
      info: {
        skew: skew,
        deskewed: deskewed !== px,
        brightness: Math.round(mean),
        blur: Math.round(blurVar),
        sharpened: sharpened,
        lowLight: mean < 100
      }
    };
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
    s = s.replace(/[ \t]+/g, ' ').trim();
    return s;
  }

  // 数字上下文混淆纠错：仅当字母串内含真实数字且串长≥2 时映射，
  // 纯字母单词（如 ZOO / OK）不受影响。
  var DIGIT_FIX = { O: '0', o: '0', Q: '0', I: '1', l: '1', '|': '1', Z: '2', S: '5', B: '8', G: '6', q: '9', D: '0' };
  function fixDigitContext(s) {
    return String(s || '').replace(/[0-9OoQIl|ZSBGqD]{2,}/g, function (run) {
      var hasDigit = /[0-9]/.test(run);
      if (!hasDigit) return run;
      return run.replace(/[OoQIl|ZSBGqD]/g, function (c) { return DIGIT_FIX[c]; });
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
        words.push({ text: wd.text, x0: bb.x0, x1: bb.x1, y0: bb.y0, y1: bb.y1 });
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
    if (rows.length < 2) return null;
    // 聚列：全词左缘聚类（容差 0.5·词宽中位数），统计各列支持行数
    var ws2 = words.map(function (w) { return w.x1 - w.x0; }).sort(function (a, b) { return a - b; });
    var mw = ws2[(ws2.length / 2) | 0] || 20;
    var tol = Math.max(8, mw * 0.5);
    var anchors = []; // 列锚点 x
    words.forEach(function (w) {
      var hit = null;
      for (var i = 0; i < anchors.length; i++) {
        if (Math.abs(anchors[i] - w.x0) <= tol) { hit = i; break; }
      }
      if (hit == null) anchors.push(w.x0);
    });
    anchors.sort(function (a, b) { return a - b; });
    if (anchors.length < 2) return null;
    // 每词归入最近列（按中心距），格子记录文本与词级范围（供对齐推断）
    var grid = rows.map(function () { return anchors.map(function () { return null; }); });
    rows.forEach(function (r, ri) {
      r.forEach(function (w) {
        var cxx = (w.x0 + w.x1) / 2;
        var ci = -1, best = 1e18;
        for (var i = 0; i < anchors.length; i++) {
          var d = Math.abs(anchors[i] - cxx);
          if (d < best) { best = d; ci = i; }
        }
        if (ci >= 0) {
          var cell = grid[ri][ci];
          if (cell) {
            cell.text += ' ' + w.text;
            cell.x0 = Math.min(cell.x0, w.x0);
            cell.x1 = Math.max(cell.x1, w.x1);
          } else {
            grid[ri][ci] = { text: w.text, x0: w.x0, x1: w.x1 };
          }
        }
      });
    });
    // 列支持率：≥ max(2, 半数行) 才保留；行覆盖率不足则放弃
    var colSupport = anchors.map(function (_, ci) {
      return grid.filter(function (row) { return row[ci] != null; }).length;
    });
    var keep = colSupport.map(function (n) { return n >= Math.max(2, rows.length * 0.5); });
    var keptIdx = [];
    keep.forEach(function (k, ci) { if (k) keptIdx.push(ci); });
    if (keptIdx.length < 2) return null;
    var filled = 0, total = 0;
    grid.forEach(function (row) {
      row.forEach(function (cell, ci) {
        if (!keep[ci]) return;
        total++;
        if (cell != null) filled++;
      });
    });
    if (total < 4 || filled / total < 0.5) return null;
    // 每列对齐推断：x0 离散小 → 左对齐；x1 离散小（且明显小于 x0）→ 右对齐；
    // 中心离散最小 → 居中。容差取词宽中位数 40%。
    var tolA = Math.max(8, mw * 0.4);
    function spread(arr) {
      var mn = Math.min.apply(null, arr), mx = Math.max.apply(null, arr);
      return mx - mn;
    }
    var aligns = [], widths = [];
    keptIdx.forEach(function (ci) {
      var cells = grid.map(function (row) { return row[ci]; }).filter(Boolean);
      var x0s = cells.map(function (c) { return c.x0; });
      var x1s = cells.map(function (c) { return c.x1; });
      var cs = cells.map(function (c) { return (c.x0 + c.x1) / 2; });
      var spL = spread(x0s), spR = spread(x1s), spC = spread(cs);
      var al = 'left';
      if (spC <= tolA && spC < spL && spC < spR) al = 'center';
      else if (spR <= tolA && spR < spL) al = 'right';
      aligns.push(al);
    });
    // 相对列宽：列内格子的最大水平跨度
    widths = keptIdx.map(function (ci) {
      var cells = grid.map(function (row) { return row[ci]; }).filter(Boolean);
      var mn = Math.min.apply(null, cells.map(function (c) { return c.x0; }));
      var mx = Math.max.apply(null, cells.map(function (c) { return c.x1; }));
      return Math.max(1, mx - mn);
    });
    return {
      rows: grid.map(function (row) {
        return row.map(function (cell, ci) { return keep[ci] ? (cell == null ? '' : cell.text) : null; })
          .filter(function (_, ci) { return keep[ci]; });
      }),
      colCount: keptIdx.length,
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
      blocks.push({ type: 'table', rows: table.rows, aligns: table.aligns, widths: table.widths });
    } else {
      blocks = rebuildBlocks(cleaned);
    }
    return {
      blocks: blocks,
      conf: confN ? confSum / confN : null,
      lineCount: cleaned.length,
      hasTable: !!table
    };
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
    /* 后处理主入口（docs-ocr 调用）：纯文本模式下做归一 + 数字纠错 */
    polishText: function (raw) {
      var lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
      return lines.map(function (l) { return fixDigitContext(normalizeLine(l)); })
        .join('\n').replace(/\n{3,}/g, '\n\n').trim();
    },
    buildFromBlocks: buildFromBlocks,
    buildDoc: buildDoc,
    renderDocText: renderDocText,
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
      rebuildParagraphs: rebuildParagraphs
    }
  };
})(window.App);
