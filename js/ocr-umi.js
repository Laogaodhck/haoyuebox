/* ============================================================
 * ocr-umi.js — Umi-OCR 引擎接入（渲染层）
 *
 * 两条链路，共用同一套结果转换（行级 text + 四角 box + score → 内置
 * 引擎同构的 Tesseract blocks，复用版面还原 / 表格 / DOCX / Excel 导出）：
 *  1) RapidOCR 引擎：window.haoyueOcr.rapid*，主进程拉起 Umi-OCR 内置的
 *     RapidOCR-json 子进程（引擎按需下载，装到用户数据目录）；
 *  2) 本机服务：window.haoyueOcr.probe/recognize，转发用户自行启动的
 *     Umi-OCR HTTP 服务（默认 http://127.0.0.1:1224）。
 *
 * 依赖：window.haoyueOcr（仅桌面版存在）、App.ocrEnhance（可选）。
 * ============================================================ */
(function (App) {
  'use strict';

  var DEFAULT_URL = 'http://127.0.0.1:1224';

  function bridge() {
    return (typeof window !== 'undefined' && window.haoyueOcr) || null;
  }

  // 桌面版桥接是否可用（浏览器版无法访问本机服务）
  function available() {
    var b = bridge();
    return !!(b && typeof b.probe === 'function' && typeof b.recognize === 'function');
  }

  // RapidOCR 引擎桥接是否可用（主进程拉起 RapidOCR-json 子进程）
  function rapidBridge() {
    var b = bridge();
    return b && typeof b.rapidRecognize === 'function' ? b : null;
  }

  function rapidAvailable() {
    return !!rapidBridge();
  }

  // RapidOCR 引擎状态：{available, running, version, error}
  function rapidStatus() {
    var b = rapidBridge();
    if (!b || typeof b.rapidStatus !== 'function') {
      return Promise.resolve({ ok: false, error: 'RapidOCR 引擎仅桌面版可用' });
    }
    return Promise.resolve(b.rapidStatus()).then(function (r) {
      return r && typeof r === 'object' ? r : { ok: false, error: '引擎状态返回格式异常' };
    }).catch(function (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    });
  }

  // 语言偏好 → RapidOCR 引擎模型：仅英文用 en，其余（中英混合 / 中文）用中文模型
  function rapidLang(langKey) {
    return langKey === 'en' ? 'en' : 'zh';
  }

  /* ---------- 引擎按需下载（约 40 MB，装到用户数据目录） ---------- */

  function engineStatus() {
    var b = rapidBridge();
    if (!b || typeof b.engineStatus !== 'function') {
      return Promise.resolve({ ok: false, error: '引擎下载仅桌面版可用' });
    }
    return Promise.resolve(b.engineStatus()).then(function (r) {
      return r && typeof r === 'object' ? r : { ok: false, error: '引擎状态返回格式异常' };
    }).catch(function (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    });
  }

  /* 下载并安装：onProgress 接收 {phase, received, total, pct} */
  async function engineInstall(onProgress) {
    var b = rapidBridge();
    if (!b || typeof b.engineInstall !== 'function') {
      throw new Error('引擎下载仅桌面版可用：浏览器版请使用内置引擎');
    }
    if (typeof b.onEngineProgress === 'function') b.onEngineProgress(onProgress || null);
    var r = await b.engineInstall();
    if (!r || r.ok === false) throw new Error((r && r.error) || '引擎下载失败');
    return r;
  }

  function engineRemove() {
    var b = rapidBridge();
    if (!b || typeof b.engineRemove !== 'function') {
      return Promise.resolve({ ok: false, error: '仅桌面版可用' });
    }
    return Promise.resolve(b.engineRemove()).catch(function (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    });
  }

  // 仅做展示用规范化：去空白、缺协议补 http://
  function normalizeUrl(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return DEFAULT_URL;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'http://' + s;
    return s.replace(/\/+$/, '');
  }

  /* ---------- 参数选择（按服务端 get_options 的能力裁剪） ---------- */

  // 从 optionsList（[[值, 名称], …]）中按语言偏好挑一个模型
  function pickLanguage(list, langKey) {
    var vals = (list || []).map(function (it) {
      return { value: String(it && it[0] || ''), label: String(it && it[1] || '') };
    }).filter(function (v) { return v.value; });
    function hay(v) { return v.label || v.value; }
    if (langKey === 'en') {
      var en = vals.filter(function (v) {
        return /english|英文/i.test(hay(v)) && !/中文|chinese/i.test(hay(v));
      });
      return en.length ? en[0].value : '';
    }
    var zh = vals.filter(function (v) {
      return /中文|chinese/i.test(hay(v)) && !/繁体|繁|traditional|cht/i.test(hay(v) + ' ' + v.value);
    });
    if (zh.length) return zh[0].value;
    var any = vals.filter(function (v) { return /中文|chinese/i.test(hay(v)); });
    return any.length ? any[0].value : '';
  }

  // 语言 / 排版 / 方向纠正等参数只在服务端声明支持时才发送
  function pickOptions(defs, langKey, mode, enhance) {
    var d = defs || {};
    var opts = {};
    if (d['ocr.language'] && Array.isArray(d['ocr.language'].optionsList)) {
      var lang = pickLanguage(d['ocr.language'].optionsList, langKey);
      if (lang) opts['ocr.language'] = lang;
    }
    if (d['ocr.cls'] && enhance !== false) opts['ocr.cls'] = true;
    if (d['ocr.limit_side_len']) {
      var lens = (d['ocr.limit_side_len'].optionsList || []).map(function (it) {
        return Number(it && it[0]);
      }).filter(function (n) { return n > 0; });
      if (lens.indexOf(4320) >= 0) opts['ocr.limit_side_len'] = 4320;
    }
    if (d['tbpu.parser'] && Array.isArray(d['tbpu.parser'].optionsList)) {
      var want = mode === 'plain' ? 'multi_line' : 'multi_para';
      var has = d['tbpu.parser'].optionsList.some(function (it) { return it && it[0] === want; });
      if (has) opts['tbpu.parser'] = want;
    }
    // 固定取结构化字典：行级 box 是版面还原的基础
    if (d['data.format'] || !defs) opts['data.format'] = 'dict';
    return opts;
  }

  /* ---------- 结果转换 ---------- */

  // 四角坐标 → 外接矩形；非法时退回 0 尺寸框
  function boxBounds(box) {
    var xs = [], ys = [];
    (box || []).forEach(function (p) {
      if (p && p.length === 2) {
        var x = Number(p[0]), y = Number(p[1]);
        if (isFinite(x) && isFinite(y)) { xs.push(x); ys.push(y); }
      }
    });
    if (!xs.length) return { x0: 0, y0: 0, x1: 0, y1: 0 };
    return {
      x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys),
      x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys)
    };
  }

  // Umi 只给行框：按空白切词并在行内按字符数比例估算词框，
  // 让表格检测能利用单元格之间的空格间隙（中文整行无空格时保留整行）。
  function splitWords(text, bb, conf) {
    var raw = String(text || '');
    var tokens = raw.split(/\s+/).filter(function (t) { return t; });
    if (!tokens.length) return [];
    if (tokens.length === 1) {
      return [{ text: tokens[0], bbox: { x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1 }, confidence: conf }];
    }
    var total = tokens.reduce(function (n, t) { return n + t.length; }, 0) || 1;
    var width = bb.x1 - bb.x0;
    var x = bb.x0;
    return tokens.map(function (t) {
      var w = width * (t.length / total);
      var word = {
        text: t,
        bbox: { x0: x, y0: bb.y0, x1: x + w, y1: bb.y1 },
        confidence: conf
      };
      x += w;
      return word;
    });
  }

  // 纯文本：按 Umi 给出的行尾结束符（end）还原段落结构
  function buildText(items) {
    var out = '';
    (items || []).forEach(function (it) {
      var t = String(it && it.text || '');
      if (!t) return;
      var end = it.end == null ? '\n' : String(it.end);
      out += t + end;
    });
    return out;
  }

  // Umi data → { text, blocks, confidence }（blocks 与 Tesseract 输出同构）
  function convert(items, confOverride) {
    var lines = [];
    var confSum = 0, confN = 0;
    (items || []).forEach(function (it) {
      var text = String(it && it.text || '').replace(/\s+$/, '');
      if (!text) return;
      var score = Number(it.score);
      var conf = isFinite(score) ? Math.max(0, Math.min(100, score * 100)) : null;
      if (conf != null) { confSum += conf; confN++; }
      var bb = boxBounds(it.box);
      lines.push({
        text: text,
        bbox: bb,
        confidence: conf,
        words: splitWords(text, bb, conf)
      });
    });
    var confidence = confN ? confSum / confN : (typeof confOverride === 'number' ? confOverride : 0);
    return {
      text: buildText(items),
      blocks: lines.length ? [{ paragraphs: [{ lines: lines }] }] : [],
      confidence: confidence
    };
  }

  /* ---------- 对外能力 ---------- */

  function probe(url) {
    var b = bridge();
    if (!b) {
      return Promise.resolve({ ok: false, error: 'Umi-OCR 仅桌面版可用（浏览器版无法访问本机服务）' });
    }
    return Promise.resolve(b.probe(normalizeUrl(url))).then(function (r) {
      return r && typeof r === 'object' ? r : { ok: false, error: 'Umi-OCR 探测返回格式异常' };
    }).catch(function (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    });
  }

  // canvas → base64（PNG 保真优先；调用发生在本机回环，体积不是瓶颈）
  function canvasBase64(canvas) {
    var url = canvas.toDataURL('image/png');
    var i = url.indexOf(',');
    return i >= 0 ? url.slice(i + 1) : '';
  }

  /* 识别一张图：opts = { url, defs, lang, mode, enhance }
   * 返回 { data: {text, blocks, confidence}, time, empty }，可直接交给 buildResult */
  async function recognize(canvas, opts) {
    var b = bridge();
    if (!b) throw new Error('Umi-OCR 仅桌面版可用（浏览器版无法访问本机服务）');
    var o = opts || {};
    var res = await b.recognize({
      base: normalizeUrl(o.url),
      base64: canvasBase64(canvas),
      options: pickOptions(o.defs, o.lang, o.mode, o.enhance)
    });
    if (!res || res.ok === false) {
      throw new Error((res && res.error) || 'Umi-OCR 识别失败');
    }
    return {
      data: convert(res.data),
      time: Number(res.time) || 0,
      empty: !!res.empty
    };
  }

  /* RapidOCR 引擎识别一张图：opts = { lang, mode, enhance }
   * 检测 / 方向纠正 / 行合并都由引擎完成，这里只做语言选择与结构转换 */
  async function recognizeRapid(canvas, opts) {
    var b = rapidBridge();
    if (!b) throw new Error('RapidOCR 引擎仅桌面版可用（浏览器版请使用内置引擎）');
    var o = opts || {};
    var res = await b.rapidRecognize({
      base64: canvasBase64(canvas),
      lang: rapidLang(o.lang)
    });
    if (!res || res.ok === false) {
      throw new Error((res && res.error) || 'RapidOCR 引擎识别失败');
    }
    return {
      data: convert(res.data),
      time: Number(res.time) || 0,
      empty: !!res.empty
    };
  }

  App.ocrUmi = {
    DEFAULT_URL: DEFAULT_URL,
    available: available,
    rapidAvailable: rapidAvailable,
    rapidStatus: rapidStatus,
    engineStatus: engineStatus,
    engineInstall: engineInstall,
    engineRemove: engineRemove,
    normalizeUrl: normalizeUrl,
    probe: probe,
    recognize: recognize,
    recognizeRapid: recognizeRapid,
    _test: {
      pickLanguage: pickLanguage,
      pickOptions: pickOptions,
      boxBounds: boxBounds,
      splitWords: splitWords,
      buildText: buildText,
      convert: convert,
      rapidLang: rapidLang
    }
  };
})(window.App);
