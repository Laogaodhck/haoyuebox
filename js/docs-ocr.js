/* ============================================================
 * docs-ocr.js — 文档工具子功能：OCR 文字识别
 * 三引擎：随包 RapidOCR（Umi-OCR 组件，electron/bin/umi-ocr，开箱即用）、
 *        用户自启的 Umi-OCR HTTP 服务（js/ocr-umi.js，需桌面版）、
 *        内置 Tesseract LSTM 引擎（vendor/ocr，Apache-2.0，兜底与浏览器版），
 *  - 图片（JPG / PNG / WebP / BMP）与扫描 PDF 逐页识别，简体中文 + 英文；
 *  - 图像增强（App.ocrEnhance，js/ocr-enhance.js）：自动纠偏、低光照
 *    对比度拉伸、模糊锐化、Sauvola 自适应二值化压复杂背景、孤点去噪，
 *    可在面板关闭；
 *  - 小图自动放大、超大图限长边 2600px，兼顾准确率与速度/内存；
 *  - 识别结果支持两种模式：智能排版（词级 bbox 段落重建 + 表格网格
 *    还原 + 结构化字段提取）与纯文本（归一 + 数字上下文纠错）；
 *  - 引擎懒加载：首次识别才初始化 Worker，语言包切换时 reinitialize 复用内核；
 *  - 识别结果集中在文本框中可编辑，支持复制 / 导出 TXT / 导出 DOCX；
 *  - DOCX 为最小 OOXML 包（[Content_Types].xml + _rels/.rels + word/document.xml），
 *    经 window.ZipUtil.store 打包，零额外依赖；
 *  - 全程不访问外部网络：内置引擎纯本机；Umi-OCR 只连用户指定的本机 /
 *    局域网地址，图片不出本地网络。
 * 依赖：window.Tesseract（vendor/ocr/tesseract.min.js）、App.ocrEnhance、
 *       App.ocrUmi + window.haoyueOcr（Umi-OCR 本地服务，可选）、
 *       App.pdfcore（PDF 渲染）、window.ZipUtil（ZIP 打包）、App.ui.download。
 * ============================================================ */
(function (App) {
  'use strict';

  var $ = App.ui.$;
  var core = App.pdfcore;
  var PDF_RE = /\.pdf$/i;
  var IMG_RE = /\.(jpe?g|png|webp|bmp)$/i;
  var LANGS = { both: ['chi_sim', 'eng'], zh: ['chi_sim'], en: ['eng'] };
  // recognize 输出声明：text + blocks（blocks 携带词级 bbox / 置信度，供版面还原）
  var OUT_OPTS = { text: true, blocks: true };
  var SCALE_MAX = 2600;    // 长边上限：更大的图对准确率无益且耗时耗内存
  var SCALE_UP_MIN = 1000; // 长边低于此值视为小图，放大提升识别率

  var items = [];        // [{file, isPdf}]
  var worker = null;     // Tesseract Worker（懒加载）
  var workerLang = '';   // 当前 worker 已加载的语言包
  var curLabel = '';     // 当前识别项标签（进度显示用）
  var running = false;
  var task = null;       // 本次识别的取消令牌（App.task）
  var lastUnits = null;    // 最近一次识别的单元（含结构化 doc，供 DOCX 导出）
  var lastFullText = null; // 最近一次识别写入文本框的原文（判断是否被用户编辑）
  var orient = 'p';        // 结果区页面方向：p 竖向 / l 横向（同时决定 DOCX 页面方向）

  function toast(msg, isErr) { App.ui.toast(msg, isErr); }

  /* ================= 引擎选择（Umi-OCR / 内置） ================= */

  var OCR_PREF_KEY = 'haoyue-ocr-pref'; // 引擎偏好 + 本机服务地址（独立于主设置白名单）

  var DEFAULT_UMI_URL = (App.ocrUmi && App.ocrUmi.DEFAULT_URL) || 'http://127.0.0.1:1224';

  function umiUrl() {
    var el = $('do-umi-url');
    var v = el && el.value ? el.value.trim() : '';
    return v || DEFAULT_UMI_URL;
  }

  function loadPref() {
    try {
      var s = JSON.parse(localStorage.getItem(OCR_PREF_KEY) || 'null');
      if (!s || typeof s !== 'object') return;
      var sel = $('do-engine');
      if (sel && ['auto', 'rapid', 'umi', 'builtin'].indexOf(s.engine) >= 0) sel.value = s.engine;
      var url = $('do-umi-url');
      if (url && typeof s.url === 'string' && s.url) url.value = s.url;
    } catch (e) { /* 存储不可用或数据损坏：保持默认值 */ }
  }

  function savePref() {
    try {
      var sel = $('do-engine');
      localStorage.setItem(OCR_PREF_KEY, JSON.stringify({
        engine: sel ? sel.value : 'auto',
        url: umiUrl()
      }));
    } catch (e) { /* 存储不可用：忽略 */ }
  }

  function setUmiState(msg) {
    var el = $('do-umi-state');
    if (el) el.textContent = msg || '';
  }

  async function testUmi() {
    if (running) return;
    if (!App.ocrUmi) { setUmiState('Umi-OCR 接入模块未加载，请刷新页面'); return; }
    var btn = $('do-umi-test');
    if (btn) btn.disabled = true;
    setUmiState('正在连接 Umi-OCR…');
    var r = await App.ocrUmi.probe(umiUrl());
    if (btn && !running) btn.disabled = false;
    if (r && r.ok) {
      var langs = r.options && r.options['ocr.language'] && r.options['ocr.language'].optionsList;
      setUmiState('已连接 Umi-OCR' + (langs && langs.length ? '（可用模型 ' + langs.length + ' 个）' : ''));
      savePref();
    } else {
      setUmiState((r && r.error) || '连接失败：请确认 Umi-OCR 已启动并允许 HTTP 服务');
    }
  }

  /* RapidOCR 引擎状态提示：仅在桌面版（有桥接）时探测，浏览器版不提示 */
  async function refreshRapidState() {
    if (!App.ocrUmi || !App.ocrUmi.rapidAvailable || !App.ocrUmi.rapidAvailable()) return;
    var installBtn = $('do-rapid-install');
    var st = await App.ocrUmi.engineStatus();
    if (st && st.installed) {
      if (installBtn) installBtn.hidden = true;
      var rs = await App.ocrUmi.rapidStatus();
      setRapidState('OCR 引擎已就绪' + (rs && rs.version ? '（RapidOCR ' + rs.version + '）' : ''));
      return;
    }
    if (st && st.ok === false) {
      if (installBtn) installBtn.disabled = false;
      setRapidState(st.error || '引擎状态不可用');
      return;
    }
    if (installBtn) {
      installBtn.hidden = false;
      installBtn.disabled = false;
    }
    setRapidState('尚未下载 OCR 引擎（约 40 MB，仅首次需要）：下载后识别质量更高；不下载时自动使用其它引擎');
  }

  function setRapidState(msg) {
    var el = $('do-rapid-state');
    if (el) el.textContent = msg || '';
  }

  /* 下载并安装引擎：主进程负责下载与解压，进度经 IPC 推送 */
  async function installRapid() {
    if (running) return;
    if (!App.ocrUmi || !App.ocrUmi.engineInstall) { toast('引擎下载仅桌面版可用', true); return; }
    var btn = $('do-rapid-install');
    if (btn) btn.disabled = true;
    setRapidState('正在下载 OCR 引擎…');
    try {
      await App.ocrUmi.engineInstall(function (p) {
        if (!p) return;
        if (p.phase === 'download') {
          setRapidState('正在下载 OCR 引擎…' + (p.pct == null ? '' : ' ' + p.pct + '%'));
        } else if (p.phase === 'extract') {
          setRapidState('正在解压引擎…' + (p.pct == null ? '' : ' ' + p.pct + '%'));
        }
      });
      await refreshRapidState();
      toast('OCR 引擎下载完成');
    } catch (e) {
      setRapidState((e && e.message) || '引擎下载失败');
      toast('下载 OCR 引擎失败：' + ((e && e.message) || e), true);
      if (btn) btn.disabled = false;
    }
  }

  /* 解析本次使用的引擎：
   *  rapid   → 按需下载的 RapidOCR（装到用户数据目录，离线可用）；
   *  auto    → RapidOCR → 用户自启的 Umi-OCR 服务 → 内置 Tesseract；
   *  umi     → 仅本机 Umi-OCR HTTP 服务，连接失败直接报错（不静默降级）；
   *  builtin → 内置 Tesseract。 */
  async function resolveEngine() {
    var sel = $('do-engine');
    var key = sel ? sel.value : 'auto';
    if (key === 'builtin') return { kind: 'builtin' };
    var rapidOk = !!(App.ocrUmi && App.ocrUmi.rapidAvailable && App.ocrUmi.rapidAvailable());
    if (key === 'rapid') {
      if (!rapidOk) throw new Error('RapidOCR 仅桌面版可用：请使用安装版 / 便携版，或把引擎切换为内置');
      var rs = await App.ocrUmi.rapidStatus();
      if (rs && rs.available) return { kind: 'rapid' };
      throw new Error((rs && rs.error) || 'OCR 引擎尚未下载：请点击「下载 OCR 引擎」后重试');
    }
    if (key === 'auto' && rapidOk) {
      var st = await App.ocrUmi.rapidStatus();
      if (st && st.available) return { kind: 'rapid' };
    }
    if (!App.ocrUmi || !App.ocrUmi.available()) {
      if (key === 'umi') throw new Error('Umi-OCR 仅桌面版可用：请使用安装版 / 便携版，或把引擎切换为内置');
      return { kind: 'builtin' };
    }
    setStatus(key === 'auto' ? '正在检测 Umi-OCR…' : '正在连接 Umi-OCR…');
    var p = await App.ocrUmi.probe(umiUrl());
    if (p && p.ok) return { kind: 'umi', defs: p.options || {} };
    if (key === 'umi') throw new Error((p && p.error) || '无法连接 Umi-OCR');
    return { kind: 'builtin' };
  }

  /* ================= 图像预处理（缩放 + 增强） ================= */

  // 计算绘制缩放：小图放大（≥2 倍）、超大图压缩到长边上限
  function calcScale(w, h) {
    var long = Math.max(w, h);
    if (long < SCALE_UP_MIN) return Math.min(3, Math.max(2, SCALE_UP_MIN / long));
    if (long > SCALE_MAX) return SCALE_MAX / long;
    return 1;
  }

  // 文件 → 缩放后的 canvas（createImageBitmap 解码，用完即关）
  async function fileToCanvas(file) {
    var bmp = await createImageBitmap(file);
    try {
      var s = calcScale(bmp.width, bmp.height);
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * s));
      c.height = Math.max(1, Math.round(bmp.height * s));
      var ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      return c;
    } finally {
      if (typeof bmp.close === 'function') bmp.close();
    }
  }

  // 就地增强 canvas 像素（增强档位见 App.ocrEnhance.enhance 的 mode），返回 info
  function enhanceCanvas(c, mode) {
    var ctx = c.getContext('2d');
    var img = ctx.getImageData(0, 0, c.width, c.height);
    var r = App.ocrEnhance.enhance(img, { mode: mode || 'full' });
    // 纠偏会改变高度：尺寸变化时必须同步调整画布，否则底部内容被裁掉
    if (c.width !== r.px.width || c.height !== r.px.height) {
      c.width = r.px.width;
      c.height = r.px.height;
      ctx = c.getContext('2d');
    }
    // 必须包装为 ImageData：putImageData 拒绝普通 {data,width,height} 对象
    // （此前直接传对象会抛 TypeError，被上层 catch 静默回退原图，导致增强从未生效）
    ctx.putImageData(new ImageData(r.px.data, r.px.width, r.px.height), 0, 0);
    return r.info;
  }

  /* ================= 多通道识别（精度优先，带预算上限） ================= */

  var MULTI = {
    lowConf: 60,     // 行均置信度低于此值（严重劣化）→ 换版式通道重识别
    pixelConf: 55,   // 低于此值才无条件启用灰度变体（避免清晰件白跑一遍）
    minLinePx: 22,   // 行高中位数低于此值视为低分辨率 → 放大 2x 重识别
    cellConf: 70,    // 单元格置信度低于此值 → 单元格裁剪重识别
    maxCells: 60,    // 单元格重识别次数上限（耗时保护）
    skewDeg: 1.2,    // 倾斜角超过此值 → 增加纯纠偏通道（行 bbox 重叠会导致行被并段）
    colorMin: 0.004, // 彩色像素占比达到此值才尝试 R/G 单通道（红字 / 红章）
    colorConf: 70,   // 基座置信度低于此值时，即使颜色占比很小也试单通道（压红章 / 救红字）
    colorLineMin: 0.12, // 行框彩色像素占比达到此值才做彩色行定向重识别
    colorLineLowConf: 60, // 仅对基座置信度低于此值的彩色行做定向重识别（避免改坏正常行）
    colorLines: 8,   // 彩色行重识别次数上限（耗时保护）
    colorRegions: 6, // 彩色文字补识区域上限（整行漏识的红字等）
    colorRegionConf: 60, // 彩色补识区域的最低置信度
    colorRegionGood: 75, // 达到此置信度即采用，不再跑第二个通道（省一次识别）
    blurVar: 1200,   // 清晰度低于此值视为糊片（配小字号才尝试 2x 放大）
    decimalLines: 8, // 数据行小数点修复的重识别行数上限（耗时保护）
    sceneScore: 12,  // 基座评分低于此值且置信度极低 → 判定为场景照片，走招牌定位兜底
    sceneConf: 30,   // 场景判定的行均置信度上限（薄纸单据虽分低但通常高于此值）
    sceneWordConf: 55, // 场景定位时「可信词」的最低置信度
    sceneLineConf: 35, // 场景兜底输出保留行的最低置信度
    // 基座通道：tesseract.js worker 的默认 tessedit_pageseg_mode 是 SINGLE_BLOCK(6)，
    // 显式写 6 才能既复现 v1.4.1 行为、又不受上一次调用残留参数影响
    psmBase: 6,
    psmAuto: 3,      // AUTO：多栏 / 版式复杂、基座漏行时尝试
    psmSparse: 11,   // 稀疏文字（海报 / 截图标注）
    gain: 1.05       // 备选通道需超过当前评分 5% 才采纳（避免抖动式换通道）
  };

  // 识别参数：仅指定分页模式。
  // 注意：不要开启 preserve_interword_spaces——它改变分词粒度（把列间空格并入词），
  // 会破坏基于词级 bbox 的列聚类，实测导致表格列丢失（见 docs/ocr-accuracy-optimization.md）。
  function psmParams(psm) {
    return { tessedit_pageseg_mode: String(psm) };
  }

  function scaleCanvas(src, factor) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * factor));
    c.height = Math.max(1, Math.round(src.height * factor));
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  // 复制画布（增强会就地改写像素，变体必须各自持有副本）
  function cloneCanvas(src) {
    var c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  // 平均亮度（降采样估算，判暗底/反色底）
  function meanBrightness(canvas) {
    var s = Math.max(1, Math.round(160 / Math.max(canvas.width, canvas.height) * 100) / 100);
    var small = scaleCanvas(canvas, Math.min(1, s));
    var d = small.getContext('2d').getImageData(0, 0, small.width, small.height).data;
    var sum = 0, n = 0;
    for (var i = 0; i < d.length; i += 4) { sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; n++; }
    return n ? sum / n : 255;
  }

  // 彩色像素统计（降采样）：红章 / 彩色标题 / 彩色图标占比与主色。
  // 仅统计"有饱和度且不过暗过亮"的像素；白底黑字文档占比接近 0。
  // 彩色像素分类（0 无 / 1 红 / 2 绿 / 3 蓝）：阈值放宽到褪色印章、淡红票号也能命中，
  // 三处统计（整页 / 行框 / 连通域）共用，避免各自阈值漂移。
  function colorPixel(r, g, b) {
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 30 || mx < 60 || mn > 245) return 0;
    if (r > g + 18 && r > b + 14) return 1;
    if (g > r + 22 && g > b + 22) return 2;
    if (b > r + 22 && b > g + 12) return 3;
    return 0;
  }

  function colorStats(canvas) {
    var longEdge = Math.max(canvas.width, canvas.height) || 1;
    var small = scaleCanvas(canvas, Math.min(1, 240 / longEdge));
    var d = small.getContext('2d').getImageData(0, 0, small.width, small.height).data;
    var n = 0, colored = 0, red = 0, green = 0, blue = 0;
    for (var i = 0; i < d.length; i += 4) {
      n++;
      var c = colorPixel(d[i], d[i + 1], d[i + 2]);
      if (!c) continue;
      colored++;
      if (c === 1) red++;
      else if (c === 2) green++;
      else blue++;
    }
    return {
      ratio: n ? colored / n : 0,
      red: colored ? red / colored : 0,
      green: colored ? green / colored : 0,
      blue: colored ? blue / colored : 0
    };
  }

  // 清晰度（拉普拉斯方差）：糊片 + 小字号时才尝试 2x 放大通道
  function sharpness(canvas) {
    if (!App.ocrEnhance || typeof App.ocrEnhance.sharpness !== 'function') return 1e9;
    try { return App.ocrEnhance.sharpness(canvas); } catch (e) { return 1e9; }
  }

  /* ---------- 场景照片兜底 ---------- */
  // 整页识别只剩低置信乱码（评分极低）时，全尺寸多通道既慢又全是噪声。
  // 该路径改用「缩小 + 二值化」快速定位高置信词簇（招牌 / 路牌 / 门牌），
  // 再对簇区域 2x 裁图重识别；定位不到时仅过滤乱码行，避免输出满屏噪声。
  function collectWords(data) {
    var words = [];
    ((data && data.blocks) || []).forEach(function (b) {
      (b.paragraphs || []).forEach(function (p) {
        (p.lines || []).forEach(function (l) {
          (l.words || []).forEach(function (w) {
            if (!w || !w.text || !w.bbox || w.bbox.x1 == null) return;
            words.push({
              text: String(w.text).trim(),
              conf: typeof w.confidence === 'number' ? w.confidence : 0,
              x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1
            });
          });
        });
      });
    });
    return words.filter(function (w) { return w.text; });
  }

  function medianNum(list) {
    if (!list.length) return 0;
    var s = list.slice().sort(function (a, b) { return a - b; });
    return s[(s.length / 2) | 0];
  }

  // 从半分辨率定位结果里挑「词最密的高置信簇」，返回源图坐标裁剪框或 null
  function pickSceneBox(data, smallW, smallH, inv) {
    var words = collectWords(data);
    var cjk = words.filter(function (w) {
      return /[\u4e00-\u9fff]/.test(w.text) && w.conf >= MULTI.sceneWordConf;
    }).sort(function (a, b) { return b.conf - a.conf; });
    // 至少 2 个可信中文词：单个词可能是纹理噪声，不足以代表文字区域
    if (cjk.length < 2) return null;
    var seed = cjk[0];
    var scx = (seed.x0 + seed.x1) / 2, scy = (seed.y0 + seed.y1) / 2;
    var medH = medianNum(words.map(function (w) { return w.y1 - w.y0; })) || (smallH * 0.03);
    // 簇：纵向 ±3 行高、横向 ±8 行高内、且本身不是超长乱码词
    var near = words.filter(function (w) {
      var wcx = (w.x0 + w.x1) / 2, wcy = (w.y0 + w.y1) / 2;
      if (Math.abs(wcy - scy) > medH * 3 || Math.abs(wcx - scx) > medH * 8) return false;
      return w.conf >= 30 && w.text.length <= 12;
    });
    var nearCjk = near.filter(function (w) { return /[\u4e00-\u9fff]/.test(w.text); }).length;
    if (near.length < 3 || nearCjk < 2) return null;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    near.forEach(function (w) {
      if (w.x0 < x0) x0 = w.x0;
      if (w.y0 < y0) y0 = w.y0;
      if (w.x1 > x1) x1 = w.x1;
      if (w.y1 > y1) y1 = w.y1;
    });
    // 裁图框：簇外扩 2.2 行高；过大说明没框住“一块招牌”，放弃
    var pad = medH * 2.2;
    var box = { x0: (x0 - pad) * inv, y0: (y0 - pad) * inv, x1: (x1 + pad) * inv, y1: (y1 + pad) * inv };
    if ((box.x1 - box.x0) * (box.y1 - box.y0) > (smallW * inv) * (smallH * inv) * 0.7) return null;
    return box;
  }

  // 场景兜底：返回 {best, passes} 或 null（定位失败）
  async function recoverSceneText(wk, sourceCanvas) {
    var W = sourceCanvas.width, H = sourceCanvas.height;
    var f = Math.min(1, 700 / Math.max(W, H));
    var small = f < 1 ? scaleCanvas(sourceCanvas, f) : cloneCanvas(sourceCanvas);
    try { enhanceCanvas(small, 'full'); } catch (e) { return null; }
    var loc = await wk.recognize(small, psmParams(MULTI.psmBase), OUT_OPTS);
    var passes = 1;
    var box = pickSceneBox(loc.data, small.width, small.height, 1 / f);
    if (!box) return { best: null, passes: passes };
    box.x0 = Math.max(0, Math.floor(box.x0));
    box.y0 = Math.max(0, Math.floor(box.y0));
    box.x1 = Math.min(W, Math.ceil(box.x1));
    box.y1 = Math.min(H, Math.ceil(box.y1));
    var crop = cropCanvas(sourceCanvas, box);
    if (!crop) return { best: null, passes: passes };
    var best = null, bestScore = 0;
    var preps = ['gray', 'full'];
    for (var i = 0; i < preps.length; i++) {
      var c = scaleCanvas(crop, 2);
      try { enhanceCanvas(c, preps[i]); } catch (e) { continue; }
      var r = await wk.recognize(c, psmParams(MULTI.psmBase), OUT_OPTS);
      passes++;
      var sc = passScore(r.data);
      if (sc > bestScore) {
        bestScore = sc;
        best = { res: r, enh: preps[i], scale: 2, psm: MULTI.psmBase, canvas: c, enhInfo: null };
      }
    }
    return { best: best, passes: passes, box: box };
  }

  // 低置信行过滤：只保留「置信度达标且含中文/至少两个字符」的行。
  // 仅在整页评分极低（场景照片）时使用，避免糊字被整屏输出成垃圾。
  function stripLowConfLines(data, minConf) {
    var dropped = 0;
    ((data && data.blocks) || []).forEach(function (b) {
      (b.paragraphs || []).forEach(function (p) {
        var keep = [];
        (p.lines || []).forEach(function (l) {
          var txt = String((l && l.text) || '').trim();
          var cf = (l && typeof l.confidence === 'number') ? l.confidence : 0;
          var hasCjk = /[\u4e00-\u9fff]/.test(txt);
          var alnum = (txt.match(/[0-9A-Za-z]/g) || []).length;
          if (cf >= minConf && (hasCjk || alnum >= 2)) keep.push(l);
          else dropped++;
        });
        p.lines = keep;
      });
    });
    return dropped;
  }


  // 页面统计：字符数、行数、字符加权平均置信度、行高中位数
  function pageStats(data) {
    var lines = [];
    ((data && data.blocks) || []).forEach(function (b) {
      (b.paragraphs || []).forEach(function (p) {
        (p.lines || []).forEach(function (l) {
          if (!l) return;
          var txt = typeof l.text === 'string' ? l.text.trim() : '';
          var conf = (typeof l.confidence === 'number') ? l.confidence : 0;
          var h = (l.bbox && l.bbox.y1 != null) ? (l.bbox.y1 - l.bbox.y0) : 0;
          lines.push({ len: txt.length, conf: conf, h: h });
        });
      });
    });
    var chars = 0, wsum = 0, hs = [];
    lines.forEach(function (l) {
      chars += l.len;
      wsum += l.len * l.conf;
      if (l.h > 0) hs.push(l.h);
    });
    hs.sort(function (a, b) { return a - b; });
    return {
      chars: chars,
      lines: lines.length,
      meanConf: chars ? wsum / chars : 0,
      medLineH: hs.length ? hs[(hs.length / 2) | 0] : 0
    };
  }

  // 通道评分：字符量 × 置信度平方/1e4（置信度优先，避免"多识别多错"的通道胜出）
  function passScore(data) {
    var st = pageStats(data);
    return st.chars * Math.pow(st.meanConf / 100, 2);
  }

  // 文本字符二元组重合度（Dice，去空白）：用于判断两个通道是否在"读同一段字"。
  // Tesseract 对纹理噪声读成的乱码同样给出高置信，评分会虚高；单通道 / 二值化
  // 变体必须与本通道文本重合度足够高（或在评分上大幅领先）才能采纳。
  function textDice(a, b) {
    var x = String(a || '').replace(/\s+/g, '');
    var y = String(b || '').replace(/\s+/g, '');
    if (!x.length && !y.length) return 1;
    if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
    var m = new Map();
    for (var i = 0; i < x.length - 1; i++) {
      var g = x.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    var ov = 0;
    for (var j = 0; j < y.length - 1; j++) {
      var g2 = y.slice(j, j + 2);
      var n = m.get(g2) || 0;
      if (n > 0) { ov++; m.set(g2, n - 1); }
    }
    return (2 * ov) / ((x.length - 1) + (y.length - 1));
  }

  // 版面结构分：相邻行 bbox 发生垂直重叠的比例（越小越好）。
  // 倾斜页的旋转行 bbox 会互相覆盖，段落重建因此把多行并成一段；
  // 字符评分看不出这个退化，纠偏通道采纳时用它做结构判据。
  function lineOverlapRatio(data) {
    var boxes = [];
    ((data && data.blocks) || []).forEach(function (b) {
      (b.paragraphs || []).forEach(function (p) {
        (p.lines || []).forEach(function (l) {
          if (l && l.bbox && l.bbox.y0 != null && l.bbox.y1 != null) boxes.push(l.bbox);
        });
      });
    });
    if (boxes.length < 2) return 0;
    boxes.sort(function (a, b) { return a.y0 - b.y0; });
    var n = 0;
    for (var i = 1; i < boxes.length; i++) {
      if (boxes[i].y0 < boxes[i - 1].y1 - 1) n++;
    }
    return n / (boxes.length - 1);
  }

  // 质量门控多通道识别。实测结论（docs/ocr-accuracy-optimization.md）：
  //  原图直识在多数场景最优，无条件二值化反而损害清晰件与纹理背景；
  //  因此先跑原图，仅在质量信号差时才启用对应像素变体，且变体需超过当前评分 5% 才采纳。
  //  通道 1 原图（基座 PSM）→ 通道 2 倾斜 >1.2° 时的纯纠偏 →
  //  通道 3 低分辨率 2x / 1.5x 放大 + 灰度增强 →
  //  通道 4 暗底/反色二值化（含极性归一）→ 通道 5 AUTO / 稀疏 PSM。
  //  strategy='legacy' 复现 v1.4.1 行为（单遍原图），供评测对比。
  async function recognizeSmart(wk, sourceCanvas, opts) {
    var o = opts || {};
    var psmBase = o.psm || MULTI.psmBase;
    // 显式指定 PSM：worker 的分页参数有状态，若沿用上次调用（单元格 PSM 7 / 稀疏 PSM 11）
    // 会污染后续识别，出现"同图不同结果"。
    var base = await wk.recognize(sourceCanvas, psmParams(psmBase), OUT_OPTS);
    if (o.strategy === 'legacy') {
      return {
        res: base, passes: 1, psm: psmBase, scale: 1, enh: 'off',
        canvas: sourceCanvas, enhInfo: null, stats: pageStats(base && base.data)
      };
    }
    var best = { res: base, enh: 'off', scale: 1, psm: psmBase, canvas: sourceCanvas, enhInfo: null };
    var bestScore = passScore(base.data);
    var passes = 1;
    var attempts = [{ prep: 'off', scale: 1, score: bestScore, adopt: true }];
    var st = pageStats(base.data);
    // 场景照片：整页几乎全是低置信乱码。此时继续跑像素变体/换版式只会更慢更乱，
    // 改为定位招牌词簇后定向重识别；定位不到就只过滤乱码行。
    var lowYield = o.enhance !== false &&
      bestScore < MULTI.sceneScore && st.meanConf < MULTI.sceneConf;
    if (lowYield) {
      var rec = null;
      try { rec = await recoverSceneText(wk, sourceCanvas); } catch (e) { rec = null; }
      if (rec) {
        passes += rec.passes;
        if (rec.best) {
          best = rec.best;
          bestScore = passScore(rec.best.res.data);
          attempts.push({ prep: 'scene', scale: 2, score: bestScore, adopt: true, region: rec.box });
        }
      }
      var dropped = stripLowConfLines(best.res.data, MULTI.sceneLineConf);
      return {
        res: best.res, passes: passes, psm: best.psm, scale: best.scale,
        enh: best.enh, canvas: best.canvas, enhInfo: best.enhInfo, attempts: attempts,
        colorLines: 0, colorRegions: 0, decimalLines: 0,
        colorAttempts: [], colorRegionAttempts: [],
        sceneDropped: dropped,
        scene: true,
        stats: pageStats(best.res && best.res.data)
      };
    }
    var variants = [];
    if (o.enhance !== false) {
      // 倾斜 >1.2°：Tesseract 行切分不稳，且旋转后的行 bbox 互相重叠，
      // 版面重建会把多行并成一段。此时增加"纯纠偏"通道（只做几何校正，不改像素）。
      var skew = 0;
      if (App.ocrEnhance && typeof App.ocrEnhance.skewAngle === 'function') {
        try { skew = App.ocrEnhance.skewAngle(sourceCanvas); } catch (e) { skew = 0; }
      }
      if (Math.abs(skew) >= MULTI.skewDeg) variants.push({ prep: 'deskew', scale: 1 });
      var bright = meanBrightness(sourceCanvas);
      var longEdge = Math.max(sourceCanvas.width, sourceCanvas.height);
      // 小字判定：行高 <18px，或行高 <24px 且画布本身很小（截图/缩略图）；
      // 大画布上的 20px 文字无需放大（放大只增耗时）
      var tinyText = st.medLineH > 0 && (st.medLineH < 18 || (st.medLineH < 24 && longEdge < 1200));
      if (tinyText) {
        variants.push({ prep: null, scale: 2 });        // 纯放大：小字场景
        variants.push({ prep: 'gray', scale: 1.5 });    // 放大 + 灰度增强
      } else if (st.lines >= 8 && st.medLineH < 44 && sharpness(sourceCanvas) < MULTI.blurVar) {
        // 糊片 + 中小字号（检验单 / 拍摄文档）：2x 双三次放大后行分割与小数点更稳；
        // 清晰扫描件放大反而掉精度，故只在清晰度低时尝试（评分门控仍兜底）
        variants.push({ prep: null, scale: 2 });
      } else if (st.meanConf < MULTI.pixelConf || bright < 200) {
        // 低置信或整体偏暗（扫描件/照片）才做灰度增强；清晰件不白跑
        variants.push({ prep: 'gray', scale: 1 });
      }
      // 红字 / 绿字 / 红章：亮度通道对比度不足，补单通道灰度。
      // 红通道压红章、恢复绿/蓝字；红字（票号、印章褪色）在绿通道上更接近黑字。
      // 仅在彩色像素占比可观且识别质量有提升空间时触发，避免清晰件白白多跑。
      var cs = colorStats(sourceCanvas);
      var colorHint = cs.ratio >= MULTI.colorMin || st.meanConf < MULTI.colorConf;
      if (colorHint && (st.meanConf < 85 || bright < 210)) {
        variants.push({ prep: 'r', scale: 1 });
        if (cs.red >= 0.2) variants.push({ prep: 'g', scale: 1 });
        if (bright >= 110) variants.push({ prep: 'neutral', scale: 1 });
      }
      if (bright < 110) {
        variants.push({ prep: 'full', scale: 1 });      // 暗底 / 反色底：二值化 + 极性归一
      }
    }
    for (var i = 0; i < variants.length; i++) {
      var v = variants[i];
      var c = v.scale === 1 ? cloneCanvas(sourceCanvas) : scaleCanvas(sourceCanvas, v.scale);
      var info = null;
      if (v.prep) {
        // 'deskew' 只做几何纠偏（enhance mode='off'），不二值化/拉伸
        try { info = enhanceCanvas(c, v.prep === 'deskew' ? 'off' : v.prep); } catch (e) { continue; }
      }
      var r = await wk.recognize(c, psmParams(psmBase), OUT_OPTS);
      passes++;
      var sc = passScore(r.data);
      var attempt = { prep: v.prep || 'raw', scale: v.scale, score: sc, adopt: false };
      // 纠偏是几何校正：评分允许小幅波动（-2%），但行重叠率必须不劣于当前通道
      // （倾斜行 bbox 互相覆盖会让段落重建并段，字符评分对此不敏感）；
      // 其余像素变体必须明确更优（+5%），避免抖动式换通道。
      var adopt;
      if (v.prep === 'deskew') {
        adopt = sc >= bestScore * 0.98 &&
          lineOverlapRatio(r.data) <= lineOverlapRatio(best.res.data);
      } else {
        adopt = sc > bestScore * MULTI.gain;
        // 单通道 / 二值化变体可能把背景纹理读成「高置信乱码」（评分虚高），
        // 除非评分大幅领先（+25%），否则要求与当前最优文本的字符重合度达标
        if (adopt && (v.prep === 'r' || v.prep === 'g' || v.prep === 'b' || v.prep === 'neutral') &&
            sc <= bestScore * 1.25) {
          adopt = textDice(r.data.text, best.res.data.text) >= 0.75;
        }
      }
      if (adopt) {
        best = { res: r, enh: v.prep || 'off', scale: v.scale, psm: psmBase, canvas: c, enhInfo: info };
        bestScore = sc;
        attempt.adopt = true;
      }
      attempts.push(attempt);
    }
    var stB = pageStats(best.res.data);
    if (stB.meanConf < MULTI.lowConf || stB.lines <= 2) {
      var altPsm = stB.lines <= 2 ? MULTI.psmSparse : MULTI.psmAuto;
      var altSrc = best.scale === 1 ? sourceCanvas : scaleCanvas(sourceCanvas, best.scale);
      // 单通道（r/g/b）是「压某色 / 提某色」的像素替换，会改变版面结构信号；
      // 换版式通道时应回到原图像素，否则实测 bank-receipt 的 r 通道会把
      // PSM3 的收益吃掉（161 → 128）。纠偏 / 灰度仍沿用当前通道画布。
      var colorEnh = best.enh === 'r' || best.enh === 'g' || best.enh === 'b' ||
        best.enh === 'neutral' || best.enh === 'full';
      if (best.enh !== 'off' && !colorEnh) altSrc = best.canvas;
      var r4 = await wk.recognize(altSrc, psmParams(altPsm), OUT_OPTS);
      passes++;
      var sc4 = passScore(r4.data);
      var adopt4 = sc4 > bestScore * MULTI.gain;
      attempts.push({ prep: 'psm' + altPsm, scale: best.scale, score: sc4, adopt: adopt4 });
      if (adopt4) {
        best = { res: r4, enh: best.enh, scale: best.scale, psm: altPsm, canvas: altSrc, enhInfo: best.enhInfo };
        bestScore = sc4;
      }
    }
    // 有线表格：SINGLE_BLOCK(6) 会把窄数字列整列丢掉（列间无空格、行被表格线切碎）。
    // 图像检测到明显表格线时补一遍稀疏 PSM(11)，其词级结果按表格线归格。
    // 阈值放宽到 0.95：表格页字符多、置信高，评分通常显著领先，个别格抖动不应导致整列丢失。
    var grid = null;
    try {
      grid = App.ocrEnhance && App.ocrEnhance.detectGridLines
        ? App.ocrEnhance.detectGridLines(sourceCanvas) : null;
    } catch (e) { grid = null; }
    if (grid) {
      var gSrc = best.scale === 1 ? sourceCanvas : scaleCanvas(sourceCanvas, best.scale);
      if (best.enh !== 'off') gSrc = best.canvas;
      var rg = await wk.recognize(gSrc, psmParams(MULTI.psmSparse), OUT_OPTS);
      passes++;
      var scg = passScore(rg.data);
      var adoptG = scg >= bestScore * 0.95;
      attempts.push({ prep: 'grid+psm' + MULTI.psmSparse, scale: best.scale, score: scg, adopt: adoptG });
      if (adoptG) {
        best = { res: rg, enh: best.enh, scale: best.scale, psm: MULTI.psmSparse, canvas: gSrc, enhInfo: best.enhInfo };
        bestScore = scg;
      }
    }
    var colorLines = 0, colorRegions = 0, decimalLines = 0;
    if (o.enhance !== false) {
      try { colorLines = await refineColorLines(wk, sourceCanvas, best); } catch (e) { colorLines = 0; }
      try { colorRegions = await recoverColorRegions(wk, sourceCanvas, best); } catch (e) { colorRegions = 0; }
      try { decimalLines = await refineDecimalLines(wk, best); } catch (e) { decimalLines = 0; }
    }
    return {
      res: best.res, passes: passes, psm: best.psm, scale: best.scale,
      enh: best.enh, canvas: best.canvas, enhInfo: best.enhInfo, attempts: attempts,
      colorLines: colorLines, colorRegions: colorRegions, decimalLines: decimalLines,
      colorAttempts: best.colorAttempts || [], colorRegionAttempts: best.colorRegionAttempts || [],
      stats: pageStats(best.res && best.res.data)
    };
  }

  // 恢复默认识别参数（单元格重识别后调用，避免污染后续页面/文件）
  async function resetParams(wk) {
    try { await wk.setParameters(psmParams(MULTI.psmBase)); } catch (e) { /* 引擎未就绪时忽略 */ }
  }

  // 裁剪单元格（外扩 3px 容差）
  function cropCanvas(canvas, box) {
    var x0 = Math.max(0, Math.floor(box.x0) - 3);
    var y0 = Math.max(0, Math.floor(box.y0) - 3);
    var x1 = Math.min(canvas.width, Math.ceil(box.x1) + 3);
    var y1 = Math.min(canvas.height, Math.ceil(box.y1) + 3);
    var w = x1 - x0, h = y1 - y0;
    if (w < 4 || h < 4) return null;
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
    return c;
  }

  // 行框内彩色像素统计（源图坐标；best 与源图同尺寸时可直接复用 bbox）
  function lineColorStats(canvas, bb) {
    var x0 = Math.max(0, Math.floor(bb.x0));
    var y0 = Math.max(0, Math.floor(bb.y0));
    var x1 = Math.min(canvas.width, Math.ceil(bb.x1));
    var y1 = Math.min(canvas.height, Math.ceil(bb.y1));
    if (x1 - x0 < 4 || y1 - y0 < 4) return null;
    var d;
    try {
      d = canvas.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
    } catch (e) { return null; }
    var n = 0, colored = 0, red = 0, green = 0, blue = 0;
    for (var i = 0; i < d.length; i += 4) {
      n++;
      var c = colorPixel(d[i], d[i + 1], d[i + 2]);
      if (!c) continue;
      colored++;
      if (c === 1) red++;
      else if (c === 2) green++;
      else blue++;
    }
    return {
      ratio: n ? colored / n : 0,
      red: colored ? red / colored : 0,
      green: colored ? green / colored : 0,
      blue: colored ? blue / colored : 0
    };
  }

  // 彩色行定向重识别：红字用绿通道、绿/蓝字用红通道裁剪重识别（PSM 7）。
  // 只在行框彩色占比明显、单行文字不长、候选置信度明显更高时替换，
  // 直接改写 blocks 内的 line.text（words 保持原样，避免扰乱表格列聚类）。
  async function refineColorLines(wk, sourceCanvas, best) {
    if (!best || !best.res || !best.res.data || !App.ocrEnhance) return 0;
    // 仅当最佳通道与源图同尺寸时 bbox 才能直接复用（缩放 / 纠偏会改变坐标）
    if (best.scale !== 1 || !best.canvas ||
      best.canvas.width !== sourceCanvas.width || best.canvas.height !== sourceCanvas.height) return 0;
    var refined = 0, budget = MULTI.colorLines, log = [];
    best.colorAttempts = log;
    var blocks = best.res.data.blocks || [];
    for (var bi = 0; bi < blocks.length && budget > 0; bi++) {
      var paras = blocks[bi].paragraphs || [];
      for (var pi = 0; pi < paras.length && budget > 0; pi++) {
        var lines = paras[pi].lines || [];
        for (var li = 0; li < lines.length && budget > 0; li++) {
          var ln = lines[li];
          var bb = ln && ln.bbox;
          if (!bb || bb.x1 == null) continue;
          var cur = String(ln.text || '').replace(/\s+/g, '');
          if (!cur || cur.length > 30) continue;
          var cs = lineColorStats(sourceCanvas, bb);
          if (!cs || cs.ratio < MULTI.colorLineMin) continue;
          var curConf = 0;
          (ln.words || []).forEach(function (w) {
            if (w && typeof w.confidence === 'number') curConf += w.confidence;
          });
          if (ln.words && ln.words.length) curConf /= ln.words.length;
          if (curConf > MULTI.colorLineLowConf) continue;
          // 红字 → 绿通道；绿/蓝字 → 红通道；混合彩色 → 三通道交集（去彩章）
          var ch = cs.red >= 0.5 ? 'g' : ((cs.green + cs.blue >= 0.5) ? 'r' : 'neutral');
          budget--;
          var crop = cropCanvas(sourceCanvas, bb);
          if (!crop) continue;
          try { enhanceCanvas(crop, ch); } catch (e) { continue; }
          var r = await wk.recognize(crop, psmParams(7), OUT_OPTS);
          var text = String((r.data && r.data.text) || '').replace(/\s+/g, ' ').trim();
          var conf2 = (r.data && typeof r.data.confidence === 'number') ? r.data.confidence : 0;
          var ratio = text ? text.replace(/\s+/g, '').length / cur.length : 0;
          // 只救"明显认错"的彩色行：原行置信度低、候选显著更高才替换，
          // 避免把红章压过的正常行换成另一版错误结果。
          var adopted = curConf <= MULTI.colorLineLowConf && !!text &&
            conf2 >= curConf + 12 && conf2 >= 58 && ratio >= 0.5 && ratio <= 2;
          if (log.length < 12) {
            log.push({
              cur: cur, curConf: Math.round(curConf), ch: ch,
              cand: text, candConf: Math.round(conf2), ratio: Number(ratio.toFixed(2)), adopted: adopted
            });
          }
          if (adopted) {
            ln.text = text;
            refined++;
          }
        }
      }
    }
    if (budget < MULTI.colorLines) await resetParams(wk);
    return refined;
  }

  // 小数点修复：小字 / 糊片上 Tesseract 常丢小数点（1.31→131、0.1→01）。
  // 只对「同一行既有 2–4 位无小数点数字、又有带小数点数值」的数据行做行裁剪 PSM7 重识别；
  // 候选必须与原文「去掉小数点后完全一致」才采纳——即只允许补小数点，不允许换数字。
  function decimalLineCandidate(text) {
    var s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s || s.length > 48) return false;
    return /(^|[^0-9.])\d{2,4}([^0-9.]|$)/.test(s) && /\d[.．]\d/.test(s);
  }
  function acceptDecimalLine(cur, next) {
    var strip = function (s) { return s.replace(/[\s.．]/g, '').toLowerCase(); };
    var dots = function (s) { return (s.match(/[.．]/g) || []).length; };
    var a = String(cur || ''), b = String(next || '');
    if (!b) return false;
    return strip(b) === strip(a) && dots(b) > dots(a);
  }
  async function refineDecimalLines(wk, best) {
    if (!best || !best.res || !best.res.data || !best.canvas || !App.ocrEnhance) return 0;
    var blocks = best.res.data.blocks || [];
    var refined = 0, budget = MULTI.decimalLines;
    for (var bi = 0; bi < blocks.length && budget > 0; bi++) {
      var paras = blocks[bi].paragraphs || [];
      for (var pi = 0; pi < paras.length && budget > 0; pi++) {
        var lines = paras[pi].lines || [];
        for (var li = 0; li < lines.length && budget > 0; li++) {
          var ln = lines[li];
          var bb = ln && ln.bbox;
          if (!bb || bb.x1 == null) continue;
          var cur = String(ln.text || '').replace(/\s+/g, ' ').trim();
          if (!decimalLineCandidate(cur)) continue;
          budget--;
          var crop = cropCanvas(best.canvas, bb);
          if (!crop) continue;
          var r = await wk.recognize(crop, psmParams(7), OUT_OPTS);
          var text = String((r.data && r.data.text) || '').replace(/\s+/g, ' ').trim();
          if (acceptDecimalLine(cur, text)) {
            ln.text = text;
            refined++;
          }
        }
      }
    }
    if (refined) await resetParams(wk);
    return refined;
  }

  // 彩色文字区域检测（降采样到长边 ≤ 900）：连通域按行聚合成候选文本行。
  // 过滤实心色块（背景 / 大图标）与高度过小的噪点，返回源图坐标与主色。
  function detectColorRegions(canvas) {
    var scale = Math.min(1, 900 / Math.max(canvas.width, canvas.height));
    var small = scaleCanvas(canvas, scale);
    var w = small.width, h = small.height;
    var d = small.getContext('2d').getImageData(0, 0, w, h).data;
    var mask = new Uint8Array(w * h), hue = new Uint8Array(w * h);
    for (var y = 0, i = 0, j = 0; y < h; y++) {
      for (var x = 0; x < w; x++, i++, j += 4) {
        var c = colorPixel(d[j], d[j + 1], d[j + 2]);
        if (!c) continue;
        mask[i] = 1;
        hue[i] = c === 1 ? 1 : 2; // 1 红 / 2 绿蓝
      }
    }
    var seen = new Uint8Array(w * h);
    var comps = [];
    var stack = [];
    for (var p = 0; p < mask.length; p++) {
      if (!mask[p] || seen[p]) continue;
      stack.length = 0;
      stack.push(p);
      seen[p] = 1;
      var x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0, red = 0;
      var cls = hue[p];
      while (stack.length) {
        var q = stack.pop();
        var qy = (q / w) | 0, qx = q - qy * w;
        area++;
        if (hue[q] === 1) red++;
        if (qx < x0) x0 = qx;
        if (qx > x1) x1 = qx;
        if (qy < y0) y0 = qy;
        if (qy > y1) y1 = qy;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            var nx = qx + dx, ny = qy + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            var ni = ny * w + nx;
            // 只在同类色相内连通：彩色底色包围的文字若与背景连成一片，
            // 会被"实心色块"过滤掉，红字（淡红票号）就永远检不出来。
            if (mask[ni] && !seen[ni] && hue[ni] === cls) { seen[ni] = 1; stack.push(ni); }
          }
        }
      }
      var bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (area < 4) continue;
      // 仅排除近乎实心的色块（背景 / 图标）；低分辨率下 "0/A" 等字形填充率可达 0.7，
      // 阈值过高会把票号里的字母整片漏掉。
      if (area / (bw * bh) > 0.75) continue;
      comps.push({ x0: x0, y0: y0, x1: x1, y1: y1, hue: red >= area - red ? 1 : 2 });
    }
    comps.sort(function (a, b) { return (a.y0 + a.y1) - (b.y0 + b.y1); });
    var groups = [];
    comps.forEach(function (c) {
      var ch = c.y1 - c.y0 + 1;
      var hit = null;
      for (var gi = 0; gi < groups.length; gi++) {
        var gp = groups[gi];
        var gh = gp.y1 - gp.y0 + 1;
        var ov = Math.min(gp.y1, c.y1) - Math.max(gp.y0, c.y0);
        var gap = c.x0 > gp.x1 ? c.x0 - gp.x1 : (gp.x0 > c.x1 ? gp.x0 - c.x1 : 0);
        if (ov >= Math.min(gh, ch) * 0.6 && gap <= Math.max(gh, ch) && gp.hue === c.hue) { hit = gp; break; }
      }
      if (!hit) { groups.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, hue: c.hue, n: 1 }); return; }
      hit.n++;
      if (c.x0 < hit.x0) hit.x0 = c.x0;
      if (c.x1 > hit.x1) hit.x1 = c.x1;
      if (c.y0 < hit.y0) hit.y0 = c.y0;
      if (c.y1 > hit.y1) hit.y1 = c.y1;
    });
    var inv = 1 / scale;
    return groups.filter(function (g) {
      return g.n >= 3 && g.x1 > g.x0 && g.y1 > g.y0;
    }).map(function (g) {
      return {
        x0: g.x0 * inv, y0: g.y0 * inv, x1: g.x1 * inv, y1: g.y1 * inv,
        hue: g.hue === 1 ? 'red' : 'color'
      };
    });
  }

  // 彩色文字补识：识别被基座整行漏掉的彩色文字（如红底票号），
  // 跳过与已识别行重叠的区域（水印 / 装饰），高置信度才作为新行插入。
  async function recoverColorRegions(wk, sourceCanvas, best) {
    if (!best || !best.res || !best.res.data || !App.ocrEnhance) return 0;
    if (best.scale !== 1 || !best.canvas ||
      best.canvas.width !== sourceCanvas.width || best.canvas.height !== sourceCanvas.height) return 0;
    var regions;
    try { regions = detectColorRegions(sourceCanvas); } catch (e) { return 0; }
    var blocks = best.res.data.blocks || [];
    var lines = [];
    blocks.forEach(function (b) {
      (b.paragraphs || []).forEach(function (pp) {
        (pp.lines || []).forEach(function (l) { if (l && l.bbox) lines.push(l); });
      });
    });
    var existing = [];
    lines.forEach(function (l) { existing.push(String(l.text || '').replace(/\s+/g, '')); });
    var added = 0, budget = MULTI.colorRegions, log = [];
    best.colorRegionAttempts = log;
    for (var i = 0; i < regions.length && budget > 0; i++) {
      var rg = regions[i];
      var rw = rg.x1 - rg.x0, rh = rg.y1 - rg.y0;
      if (rh < 12 || rw < 30 || rw / rh < 1.3) continue;
      if (rw > sourceCanvas.width * 0.9 || rh > sourceCanvas.height * 0.3) continue;
      var overlap = 0;
      lines.forEach(function (l) {
        var bb = l.bbox;
        if (!bb || bb.x1 == null) return;
        var ow = Math.min(rg.x1, bb.x1) - Math.max(rg.x0, bb.x0);
        var oh = Math.min(rg.y1, bb.y1) - Math.max(rg.y0, bb.y0);
        if (ow > 0 && oh > 0) overlap += ow * oh;
      });
      if (overlap > rw * rh * 0.15) continue;
      budget--;
      var crop = cropCanvas(sourceCanvas, rg);
      if (!crop) continue;
      var base = rh < 28 ? 2 : 1;
      if (base > 1) crop = scaleCanvas(crop, base);
      // 淡色文字在亮度通道上往往已足够清晰，单通道增强反而可能压低置信度；
      // 原图与通道增强各跑一遍，取置信度更高者。
      var cands = [{ mode: 'none', canvas: cloneCanvas(crop) }];
      var cc = cloneCanvas(crop);
      try { enhanceCanvas(cc, rg.hue === 'red' ? 'g' : 'r'); cands.push({ mode: 'color', canvas: cc }); } catch (e) { /* 仅原图候选 */ }
      var text = '', conf = 0, mode = '';
      for (var ci = 0; ci < cands.length; ci++) {
        var res = await wk.recognize(cands[ci].canvas, psmParams(7), OUT_OPTS);
        var t = String((res.data && res.data.text) || '').replace(/\s+/g, ' ').trim();
        var cf = (res.data && typeof res.data.confidence === 'number') ? res.data.confidence : 0;
        if (cf > conf || !text) { text = t; conf = cf; mode = cands[ci].mode; }
        if (conf >= MULTI.colorRegionGood) break;
      }
      var normText = text.replace(/\s+/g, '');
      var dup = existing.some(function (e) {
        return e && (e.indexOf(normText) >= 0 || normText.indexOf(e) >= 0);
      });
      var ok = !!normText && normText.length >= 3 && conf >= MULTI.colorRegionConf && !dup;
      if (log.length < 12) {
        log.push({ box: [Math.round(rg.x0), Math.round(rg.y0), Math.round(rg.x1), Math.round(rg.y1)],
          hue: rg.hue, mode: mode, text: text, conf: Math.round(conf), adopted: ok });
      }
      if (!ok) continue;
      var line = {
        text: text,
        confidence: conf,
        bbox: { x0: Math.round(rg.x0), y0: Math.round(rg.y0), x1: Math.round(rg.x1), y1: Math.round(rg.y1) },
        words: [{
          text: text,
          confidence: conf,
          bbox: { x0: Math.round(rg.x0), y0: Math.round(rg.y0), x1: Math.round(rg.x1), y1: Math.round(rg.y1) }
        }]
      };
      if (!blocks.length) blocks.push({ paragraphs: [] });
      if (!blocks[0].paragraphs) blocks[0].paragraphs = [];
      if (!blocks[0].paragraphs.length) blocks[0].paragraphs.push({ lines: [] });
      if (!blocks[0].paragraphs[0].lines) blocks[0].paragraphs[0].lines = [];
      blocks[0].paragraphs[0].lines.push(line);
      existing.push(normText);
      added++;
    }
    if (budget < MULTI.colorRegions) await resetParams(wk);
    return added;
  }

  // 低置信单元格重识别：整页识别对单元格串列/串行敏感，裁剪为单行（PSM 7）后
  // 重新识别，仅在置信度明显更高（+3）时替换。次数受 maxCells 预算约束。
  async function refineTableCells(wk, canvas, doc) {
    if (!doc || !doc.blocks || !canvas) return 0;
    var refined = 0, budget = MULTI.maxCells;
    for (var i = 0; i < doc.blocks.length && budget > 0; i++) {
      var b = doc.blocks[i];
      if (!b || b.type !== 'table' || !b.boxes || !b.confs) continue;
      for (var ri = 0; ri < b.rows.length && budget > 0; ri++) {
        for (var ci = 0; ci < b.rows[ri].length && budget > 0; ci++) {
          var conf = b.confs[ri][ci];
          var box = b.boxes[ri][ci];
          var cur = String(b.rows[ri][ci] || '');
          if (!box || conf == null || !cur || conf >= MULTI.cellConf) continue;
          // 仅对「数字型单元格」重识别：实测中文短格裁剪后易把 摊→难（置信更高但更错），
          // 而数字格（金额/数量）在单行 PSM 下收益稳定且可校验
          if (!/^[\d.,¥$%+\-/\s]+$/.test(cur)) continue;
          budget--;
          var crop = cropCanvas(canvas, box);
          if (!crop) continue;
          var r = await wk.recognize(crop, psmParams(7), OUT_OPTS);
          var text = String((r.data && r.data.text) || '').replace(/\s+/g, ' ').trim();
          var conf2 = (r.data && typeof r.data.confidence === 'number') ? r.data.confidence : 0;
          // 采纳条件（防"裁剪碎片当作更优结果"）：置信度至少 +10 且达 75，
          // 且字数与原文接近（0.8–1.25 倍）——中文单字替换比多字更危险，必须严格
          var ratio = text ? text.replace(/\s+/g, '').length / Math.max(1, cur.replace(/\s+/g, '').length) : 0;
          if (text && conf2 >= conf + 10 && conf2 >= 75 && ratio >= 0.8 && ratio <= 1.25) {
            b.rows[ri][ci] = App.ocrEnhance && App.ocrEnhance.normalizeCell
              ? App.ocrEnhance.normalizeCell(text) : text;
            b.confs[ri][ci] = Math.round(conf2);
            refined++;
          }
        }
      }
    }
    if (refined) await resetParams(wk);
    return refined;
  }

  // 从识别结果构建输出文本：智能排版（blocks → 结构化文档模型）或纯文本
  function buildResult(res, mode, canvas, opts) {
    var data = (res && res.data) || {};
    var conf = (typeof data.confidence === 'number') ? data.confidence : null;
    var enh = App.ocrEnhance;
    if (mode !== 'plain' && enh && data.blocks && data.blocks.length) {
      try {
        var b = enh.buildFromBlocks(data, canvas, opts && opts.scene ? { keepLines: true } : null);
        if (b && b.text) {
          return {
            text: b.text,
            conf: (typeof b.conf === 'number') ? b.conf : conf,
            hasTable: !!b.hasTable,
            doc: b.doc || null
          };
        }
      } catch (e) {
        console.warn('[haoyue] 版面还原失败，回退纯文本:', e);
      }
    }
    return {
      text: enh ? enh.polishText(data.text || '') : cleanText(data.text || ''),
      conf: conf,
      hasTable: false,
      doc: null
    };
  }

  // 结构化字段摘要（证件号 / 手机号 / 日期），附加到 meta 行
  function fieldsSummary(text) {
    if (!App.ocrEnhance || !text) return '';
    var f;
    try { f = App.ocrEnhance.extractFields(text); } catch (e) { return ''; }
    var parts = [];
    if (f.idCards.length) {
      var fixed = f.idCards.filter(function (x) { return x.fixed; }).length;
      parts.push('证件号 ' + f.idCards.length + (fixed ? '（校验位纠错 ' + fixed + ' 个）' : ''));
    }
    if (f.phones.length) parts.push('手机号 ' + f.phones.length);
    if (f.dates.length) parts.push('日期 ' + f.dates.length);
    return parts.length ? '检测到：' + parts.join('、') : '';
  }

  /* ================= 纯逻辑（可单测） ================= */

  // 识别文本清理：统一换行、去行尾空白、压缩连续空行、整体验trim
  function cleanText(raw) {
    return String(raw || '')
      .replace(/\r\n?/g, '\n')
      .split('\n').map(function (l) { return l.replace(/[ \t\u00a0]+$/g, ''); }).join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // 多项结果拼接：单项直接输出；多项加「===== 名称 =====」分隔头；空结果给占位说明
  function joinUnits(units) {
    var list = (units || []).map(function (u) {
      return { label: String(u.label || ''), text: cleanText(u.text) };
    });
    var multi = list.length > 1;
    return list.map(function (u) {
      var t = u.text || '（未识别到文字）';
      return multi ? '===== ' + u.label + ' =====\n' + t : t;
    }).join('\n\n');
  }

  // 导出文件基础名：单文件 → 「原名-识别」，多文件 / 无文件 → 「识别结果」
  function exportBaseName(files) {
    var names = (files || []).map(function (f) { return String(f && f.name) || ''; })
      .filter(function (s) { return s; });
    if (names.length === 1) return names[0].replace(/\.[^.]+$/, '') + '-识别';
    return '识别结果';
  }

  // XML 文本转义（DOCX 段落内容用）
  function escXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // word/document.xml：逐行成段（A4，方向随 opts.landscape），空行输出空段落保留排版
  function buildDocxXml(text, opts) {
    return buildDocxXmlFromUnits([{ label: '', text: String(text || '') }], opts);
  }

  // 页面尺寸：A4 竖向 11906×16838 twips，横向转置并标 orient
  function pageSizeXml(landscape) {
    return landscape
      ? '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>'
      : '<w:pgSz w:w="11906" w:h="16838"/>';
  }

  // 段落 XML：indent=1 输出首行缩进（2 字符 ≈ 480 twips），jc 非左对齐时输出对齐
  function paraXml(text, indent, jc) {
    var pPr = '';
    if (indent) pPr += '<w:ind w:firstLine="480"/>';
    if (jc && jc !== 'left') pPr += '<w:jc w:val="' + jc + '"/>';
    return '<w:p>' + (pPr ? '<w:pPr>' + pPr + '</w:pPr>' : '') +
      '<w:r><w:t xml:space="preserve">' + escXml(text) + '</w:t></w:r></w:p>';
  }

  // 表格 XML：真 w:tbl（tblGrid 列宽按相对宽度比例分配、单元格按列对齐、全边框）。
  // totalDxa 为版心总宽（A4 11906 − 左右页边距 2×1440 = 9026 twips）
  function tableXml(tb, totalDxa) {
    var cols = (tb.rows && tb.rows[0] && tb.rows[0].length) || 0;
    if (!cols) return paraXml('');
    var rel = (tb.widths && tb.widths.length === cols) ? tb.widths : tb.rows[0].map(function () { return 1; });
    var sum = rel.reduce(function (a, b) { return a + b; }, 0) || 1;
    var dxa = rel.map(function (w) { return Math.max(400, Math.round(w / sum * totalDxa)); });
    var grid = '<w:tblGrid>' + dxa.map(function (w) {
      return '<w:gridCol w:w="' + w + '"/>';
    }).join('') + '</w:tblGrid>';
    var borders = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (s) {
      return '<w:' + s + ' w:val="single" w:sz="4" w:space="0" w:color="auto"/>';
    }).join('') + '</w:tblBorders>';
    var trs = tb.rows.map(function (row) {
      return '<w:tr>' + row.map(function (cell, ci) {
        return '<w:tc><w:tcPr><w:tcW w:w="' + dxa[ci] + '" w:type="dxa"/></w:tcPr>' +
          paraXml(String(cell == null ? '' : cell), 0, (tb.aligns || [])[ci]) + '</w:tc>';
      }).join('') + '</w:tr>';
    }).join('');
    return '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>' + borders + '</w:tblPr>' +
      grid + trs + '</w:tbl>';
  }

  // 识别单元 → document.xml 正文：结构化块（段落缩进 + 真表格）优先，
  // 无结构时逐行成段（与旧行为一致）；opts.landscape 控制 A4 页面方向
  function buildDocxXmlFromUnits(units, opts) {
    var list = units || [];
    var landscape = !!(opts && opts.landscape);
    var multi = list.length > 1;
    var body = '';
    list.forEach(function (u, idx) {
      if (idx > 0) body += paraXml('');
      if (multi) body += paraXml('===== ' + (u.label || '') + ' =====');
      var doc = u.doc;
      if (doc && doc.blocks && doc.blocks.length) {
        doc.blocks.forEach(function (b) {
          if (b.type === 'table') body += tableXml(b, 9026);
          else body += paraXml(b.text, b.indent);
        });
      } else {
        String(u.text || '').split('\n').forEach(function (l) { body += paraXml(l); });
      }
    });
    // OOXML 要求表格为 body 最后一个块级元素时其后必须有段落
    if (/<\/w:tbl>$/.test(body)) body += paraXml('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' + body +
      '<w:sectPr>' + pageSizeXml(landscape) + '</w:sectPr>' +
      '</w:body></w:document>';
  }

  // 最小 OOXML 三件套 → ZipUtil.store 入参（name + Uint8Array）。
  // 入参为字符串时走纯文本路径；为数组时走结构化路径（[{label, text, doc}]）
  function buildDocxFiles(input, opts) {
    var enc = new TextEncoder();
    var xml = (typeof input === 'string')
      ? buildDocxXml(input, opts)
      : buildDocxXmlFromUnits(input, opts);
    return [
      { name: '[Content_Types].xml', data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>') },
      { name: '_rels/.rels', data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>') },
      { name: 'word/document.xml', data: enc.encode(xml) }
    ];
  }

  /* ================= 引擎管理（懒加载） ================= */

  // tesseract.js 在 blob: Worker 内 importScripts / fetch，相对路径无法解析，须转为绝对 URL
  function absUrl(p) {
    try { return new URL(p, window.location.href).href; }
    catch (e) { return p; }
  }

  // Worker 进度回调：仅识别阶段按百分比刷新状态行（其余加载态保持中文提示）
  function onLog(m) {
    if (m && m.status === 'recognizing text' && typeof m.progress === 'number') {
      $('do-status').textContent = curLabel + Math.round(m.progress * 100) + '%';
    }
  }

  // 获取（或切换语言后重建）Worker；内核仅首次加载，切语言走 reinitialize
  async function ensureWorker(langKey) {
    if (worker && workerLang === langKey) return worker;
    if (!worker) {
      worker = await window.Tesseract.createWorker(LANGS[langKey], 1, {
        workerPath: absUrl('vendor/ocr/worker.min.js'),
        corePath: absUrl('vendor/ocr') + '/',
        langPath: absUrl('vendor/ocr/lang') + '/',
        logger: onLog
      });
    } else {
      try {
        await worker.reinitialize(LANGS[langKey]);
      } catch (e) {
        await worker.terminate().catch(function () { /* 忽略 */ });
        worker = null;
        return ensureWorker(langKey);
      }
    }
    workerLang = langKey;
    return worker;
  }

  /* ================= UI 状态 ================= */

  // 结果区方向：切换版心比例、标签与按钮选中态（导出沿用同一方向）
  function setOrient(o) {
    orient = o === 'l' ? 'l' : 'p';
    var page = $('do-page');
    if (page) page.classList.toggle('landscape', orient === 'l');
    var pBtn = $('do-page-p'), lBtn = $('do-page-l');
    if (pBtn && lBtn) {
      pBtn.classList.toggle('active', orient === 'p');
      lBtn.classList.toggle('active', orient === 'l');
    }
    var label = $('do-page-label');
    if (label) {
      label.textContent = orient === 'l' ? 'A4 横向（297 × 210 mm）' : 'A4 竖向（210 × 297 mm）';
    }
  }

  function setStatus(msg) { $('do-status').textContent = msg || ''; }

  /* 运行期控件锁：选择/语言/选项/清空一律停用，只留取消按钮可点，
   * 避免识别过程中文件列表或参数被改动导致结果与设置不一致 */
  var CTRL_IDS = ['do-pick', 'do-file', 'do-clear', 'do-lang', 'do-enhance', 'do-mode', 'do-run',
    'do-engine', 'do-umi-url', 'do-umi-test', 'do-rapid-install'];
  function setRunning(on) {
    running = on;
    CTRL_IDS.forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = on;
    });
    $('do-cancel').hidden = !on;
  }

  function itemNames() {
    return items.map(function (it) { return it.file.name; });
  }

  function renderCount() {
    var n = items.length;
    var pdfN = items.filter(function (it) { return it.isPdf; }).length;
    $('do-count').textContent = n ? '已选 ' + n + ' 个文件' + (pdfN ? '（含 PDF ' + pdfN + '）' : '') : '';
    $('do-empty').hidden = n > 0;
    $('do-clear').hidden = n === 0;
  }

  function updateMeta() {
    var text = $('do-text').value;
    var base = '';
    if (text) {
      base = text.length + ' 字符 · ' + text.split('\n').length + ' 行（可编辑）';
      var fs = fieldsSummary(text);
      if (fs) base += ' · ' + fs;
    }
    $('do-meta').textContent = base;
    $('do-empty-hint').hidden = !!text;
  }

  // Excel 导出仅在本次识别到结构化表格时可用（hasTable）
  function exportsEnable(on, hasTable) {
    ['do-copy', 'do-txt', 'do-docx'].forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = !on;
    });
    var xl = $('do-xlsx');
    if (xl) xl.disabled = !(on && hasTable);
  }

  /* ================= 主流程 ================= */

  function pickFiles() {
    var input = $('do-file');
    input.value = '';
    input.click();
  }

  function addFiles(files) {
    if (running) { toast('正在识别中，请先取消或等待完成'); return; }
    if (!files.length) return;
    var skipped = 0;
    files.forEach(function (f) {
      if (PDF_RE.test(f.name)) items.push({ file: f, isPdf: true });
      else if (IMG_RE.test(f.name)) items.push({ file: f, isPdf: false });
      else skipped++;
    });
    if (skipped) toast('已跳过 ' + skipped + ' 个不支持的文件（仅支持 JPG / PNG / WebP / BMP / PDF）');
    renderCount();
  }

  function onFilesPicked() {
    addFiles(Array.prototype.slice.call($('do-file').files || []));
  }

  // 清空：文件列表与识别结果区一并复位（结果文本、统计、导出按钮、结构化缓存、状态行）
  function clearFiles() {
    items = [];
    lastUnits = null;
    lastFullText = null;
    $('do-text').value = '';
    var input = $('do-file');
    if (input) input.value = '';
    renderCount();
    updateMeta();
    exportsEnable(false, false);
    setStatus('');
  }

  // 单页处理：质量门控多通道识别 → 版面构建 → 低置信表格单元格重识别（预算内）
  async function recognizePage(wk, canvas, mode, acc, canEnhance) {
    var smart = await recognizeSmart(wk, canvas, { enhance: canEnhance !== false });
    acc.passes += smart.passes;
    if (smart.psm !== MULTI.psmBase) acc.psmAlt++;
    if (smart.scale > 1) acc.rescaled++;
    if (smart.enh !== 'off') acc.enhanced++;
    if (smart.colorLines) acc.colorLines += smart.colorLines;
    if (smart.colorRegions) acc.colorRegions += smart.colorRegions;
    if (smart.enhInfo) noteEnh(acc.enhFlags, smart.enhInfo);
    var built = buildResult(smart.res, mode, smart.canvas, smart);
    if (built && built.doc && built.hasTable) {
      // 单元格裁剪必须用「实际参与识别的那张画布」（可能是放大/增强后的变体）
      var fixed = await refineTableCells(wk, smart.canvas, built.doc);
      if (fixed) {
        acc.cells += fixed;
        built.text = App.ocrEnhance ? App.ocrEnhance.renderDocText(built.doc.blocks) : built.text;
      }
    }
    return built;
  }

  // Umi-OCR 单页识别：服务端已完成检测 / 方向纠正 / 排版解析，
  // 这里不再跑多通道与单元格重识别，只做结果结构转换与版面还原复用
  async function recognizePageUmi(canvas, engine, mode, langKey, canEnhance) {
    var res = await App.ocrUmi.recognize(canvas, {
      url: umiUrl(),
      defs: engine.defs,
      lang: langKey,
      mode: mode,
      enhance: canEnhance
    });
    return buildResult(res, mode, canvas);
  }

  // RapidOCR 引擎单页识别：RapidOCR 已完成检测 / 方向纠正 / 行合并，
  // 与 Umi 服务分支一样只做结构转换与版面还原复用
  async function recognizePageRapid(canvas, mode, langKey) {
    var res = await App.ocrUmi.recognizeRapid(canvas, { lang: langKey, mode: mode });
    return buildResult(res, mode, canvas);
  }

  async function run() {
    if (running) return;
    if (!items.length) { toast('请先选择要识别的图片或 PDF'); return; }
    var engine;
    try {
      engine = await resolveEngine();
    } catch (e) {
      setStatus('');
      toast(((e && e.message) || e), true);
      return;
    }
    if (engine.kind === 'builtin' && (!window.Tesseract || typeof window.Tesseract.createWorker !== 'function')) {
      toast('内置 OCR 引擎未加载，请刷新页面后重试', true);
      return;
    }
    task = App.task.create();
    setRunning(true);
    var langKey = $('do-lang').value;
    var mode = $('do-mode') ? $('do-mode').value : 'auto';
    var enhanceOn = !$('do-enhance') || $('do-enhance').checked;
    var canEnhance = enhanceOn && App.ocrEnhance && typeof App.ocrEnhance.enhance === 'function';
    var usingUmi = engine.kind === 'umi';
    var usingRapid = engine.kind === 'rapid';
    var usingService = usingUmi || usingRapid; // 非内置引擎：无 Worker、无多通道
    var units = [];
    var okN = 0, errN = 0;
    var cancelled = false;
    var smartAcc = {
      passes: 0, psmAlt: 0, rescaled: 0, cells: 0, enhanced: 0, colorLines: 0, colorRegions: 0,
      enhFlags: { deskew: false, lowLight: false, sharpen: false, inverted: false, color: false }
    };
    if (usingRapid) {
      savePref();
      setStatus('RapidOCR 引擎就绪，开始识别…');
    } else if (usingUmi) {
      savePref();
      setStatus('已连接 Umi-OCR，开始识别…');
    }
    try {
      var wk = null;
      if (!usingService) {
        if (!worker) setStatus('正在加载识别内核（约 12 MB，仅首次较慢，全程本机）…');
        wk = await ensureWorker(langKey);
      }
      App.task.checkpoint(task);
      for (var i = 0; i < items.length; i++) {
        App.task.checkpoint(task);
        var it = items[i];
        try {
          if (it.isPdf) {
            var pdf = await core.loadPdf(it.file);
            try {
              for (var p = 1; p <= pdf.numPages; p++) {
                App.task.checkpoint(task);
                curLabel = '识别 ' + it.file.name + ' 第 ' + p + '/' + pdf.numPages + ' 页：';
                setStatus(curLabel + (usingService ? '识别中…' : '0%'));
                var canvas = await core.renderPage(pdf, p, 2, 2000);
                var builtP = usingRapid
                  ? await recognizePageRapid(canvas, mode, langKey)
                  : usingUmi
                    ? await recognizePageUmi(canvas, engine, mode, langKey, canEnhance)
                    : await recognizePage(wk, canvas, mode, smartAcc, canEnhance);
                pushUnit(units, builtP, it.file.name + ' 第' + p + '页');
                okN++;
              }
            } finally {
              if (pdf) pdf.cleanup();
            }
          } else {
            App.task.checkpoint(task);
            curLabel = '识别 ' + it.file.name + '：';
            setStatus(curLabel + (usingService ? '识别中…' : '0%'));
            var imgCanvas = await fileToCanvas(it.file);
            var builtI = usingRapid
              ? await recognizePageRapid(imgCanvas, mode, langKey)
              : usingUmi
                ? await recognizePageUmi(imgCanvas, engine, mode, langKey, canEnhance)
                : await recognizePage(wk, imgCanvas, mode, smartAcc, canEnhance);
            pushUnit(units, builtI, it.file.name);
            okN++;
          }
        } catch (e) {
          if (App.task.isCancelled(e)) throw e;
          errN++;
          console.error('[haoyue] OCR 识别失败:', it.file.name, e);
          toast('识别 ' + it.file.name + ' 失败：' + ((e && e.message) || e), true);
        }
      }
    } catch (e) {
      if (App.task.isCancelled(e)) {
        cancelled = true;
      } else {
        errN++;
        console.error('[haoyue] OCR 引擎初始化失败:', e);
        toast('识别引擎初始化失败：' + ((e && e.message) || e), true);
      }
    }
    /* 收尾全部包在 try 内、finally 复位：此前 joinUnits/updateMeta/exportsEnable
     * 若抛错会跳过 disabled=false 复位，按钮永久锁死、running 永 true */
    try {
      curLabel = '';
      if (units.length) {
        lastUnits = units;
        lastFullText = joinUnits(units);
        $('do-text').value = lastFullText;
        setOrient(detectOrient(units));
        updateMeta();
        exportsEnable(true, anyTableFlag(units));
        var engineNote = usingRapid ? '（RapidOCR 引擎）' : usingUmi ? '（Umi-OCR 引擎）' : '';
        setStatus(cancelled
          ? '已取消：已完成 ' + okN + ' 项' + (errN ? '，失败 ' + errN + ' 项' : '') +
            '，已识别结果保留在右侧，可编辑后复制或导出。'
          : '识别完成' + engineNote + '：成功 ' + okN + ' 项' + (errN ? '，失败 ' + errN + ' 项' : '') +
            (anyTableFlag(units) ? '，含表格还原' : '') + enhNoteText(smartAcc.enhFlags) + smartNoteText(smartAcc) +
            '，结果可在右侧编辑后复制或导出。');
      } else {
        setStatus(cancelled ? '已取消：未产生识别结果' : '');
      }
    } finally {
      setRunning(false);
      task = null;
    }
  }

  // 按本次识别结果推断结果区方向（横向页占多数则用横向；无结构信息保持竖向）。
  // 优先用 ocrEnhance.pageOrientation（单一判定口径），模块缺失时按宽高比本地回退。
  function detectOrient(units) {
    var l = 0, p = 0;
    (units || []).forEach(function (u) {
      var page = u.doc && u.doc.page;
      if (!page || !page.w || !page.h) return;
      var isL = (App.ocrEnhance && typeof App.ocrEnhance.pageOrientation === 'function')
        ? App.ocrEnhance.pageOrientation(u.doc) === 'l'
        : (page.w / page.h) > 1.2;
      if (isL) l++; else p++;
    });
    return l > p ? 'l' : 'p';
  }

  // 逐项识别结果登记：保留表格标记与结构化文档模型，文本缺省给空串
  function pushUnit(units, built, label) {
    units.push({ label: label, text: built.text || '', hasTable: !!built.hasTable, doc: built.doc || null });
  }

  function noteEnh(flags, info) {
    if (!info) return;
    if (info.deskewed) flags.deskew = true;
    if (info.lowLight) flags.lowLight = true;
    if (info.sharpened) flags.sharpen = true;
    if (info.inverted) flags.inverted = true;
    if (info.color) flags.color = true;
  }

  // 多通道统计摘要（让用户知道多花的算力用在哪）
  function smartNoteText(acc) {
    var parts = [];
    if (acc.passes > 1) parts.push('多通道 ' + acc.passes + ' 遍');
    if (acc.enhanced) parts.push('增强通道 ' + acc.enhanced + ' 次');
    if (acc.psmAlt) parts.push('换版式 ' + acc.psmAlt + ' 次');
    if (acc.rescaled) parts.push('放大重识别 ' + acc.rescaled + ' 次');
    if (acc.colorLines) parts.push('彩色行校正 ' + acc.colorLines + ' 行');
    if (acc.colorRegions) parts.push('彩色补识 ' + acc.colorRegions + ' 处');
    if (acc.cells) parts.push('单元格校正 ' + acc.cells + ' 格');
    return parts.length ? '（' + parts.join('、') + '）' : '';
  }

  function enhNoteText(flags) {
    var notes = [];
    if (flags.deskew) notes.push('纠偏');
    if (flags.lowLight) notes.push('低光照优化');
    if (flags.sharpen) notes.push('锐化');
    if (flags.inverted) notes.push('反色归一');
    if (flags.color) notes.push('彩色通道');
    return notes.length ? '（图像增强：' + notes.join(' / ') + '）' : '';
  }

  function anyTableFlag(units) {
    return units.some(function (u) { return u.hasTable; });
  }

  async function copyText() {
    var text = $('do-text').value;
    if (!text.trim()) { toast('暂无可复制的识别文本'); return; }
    var ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      try {
        var ta = $('do-text');
        ta.focus();
        ta.select();
        ok = document.execCommand('copy');
      } catch (e2) { ok = false; }
    }
    toast(ok ? '已复制到剪贴板' : '复制失败，请手动选中文本后 Ctrl+C', !ok);
  }

  function exportTxt() {
    var text = $('do-text').value;
    if (!text.trim()) { toast('暂无可导出的识别文本'); return; }
    App.ui.download(new Blob([text], { type: 'text/plain;charset=utf-8' }),
      exportBaseName(itemNames()) + '.txt');
  }

  function exportDocx() {
    var text = $('do-text').value;
    if (!text.trim()) { toast('暂无可导出的识别文本'); return; }
    if (!window.ZipUtil || typeof window.ZipUtil.store !== 'function') {
      toast('ZIP 打包组件未就绪，无法导出 DOCX', true);
      return;
    }
    try {
      // 结构化导出条件：本次识别产出过结构化模型且文本框未被编辑
      // （编辑后导出以用户文本为准，回退纯文本段落）
      var structured = lastUnits && lastFullText != null && text === lastFullText &&
        lastUnits.some(function (u) { return u.doc && u.doc.blocks && u.doc.blocks.length; });
      var blob = window.ZipUtil.store(buildDocxFiles(structured ? lastUnits : text,
        { landscape: orient === 'l' }));
      App.ui.download(blob, exportBaseName(itemNames()) + '.docx');
    } catch (e) {
      toast('导出 DOCX 失败：' + ((e && e.message) || e), true);
    }
  }

  // 表格结构化导出为 Excel：每张识别到的表格一个工作表（保留行列、数值类型与列对齐）
  function exportXlsx() {
    if (!lastUnits) { toast('请先识别含表格的图片或 PDF'); return; }
    var xl = App.xlsxLite;
    if (!xl || typeof xl.buildXlsxFromUnits !== 'function') {
      toast('Excel 导出组件未加载，请刷新页面后重试', true);
      return;
    }
    if (!window.ZipUtil || typeof window.ZipUtil.store !== 'function') {
      toast('ZIP 打包组件未就绪，无法导出 Excel', true);
      return;
    }
    try {
      var built = xl.buildXlsxFromUnits(lastUnits);
      if (!built || !built.files) {
        toast('本次识别未检测到表格，无法导出 Excel（可导出 TXT / DOCX）', true);
        return;
      }
      var blob = window.ZipUtil.store(built.files);
      App.ui.download(blob, exportBaseName(itemNames()) + '.xlsx');
      var edited = lastFullText != null && $('do-text').value !== lastFullText;
      toast('已导出 ' + built.stats.sheets + ' 个工作表（' + built.stats.rows + ' 行 / ' +
        built.stats.cells + ' 个单元格）' + (edited ? '，按识别到的原始表格结构导出' : ''));
    } catch (e) {
      toast('导出 Excel 失败：' + ((e && e.message) || e), true);
    }
  }

  /* 每次进入面板：只复位状态行与计数，保留已选文件、识别结果与页面方向 */
  function enter() {
    setStatus('');
    renderCount();
    updateMeta();
    setOrient(orient);
  }

  App.docsOcr = {
    enter: enter,
    _test: {
      calcScale: calcScale,
      fileToCanvas: fileToCanvas,
      cleanText: cleanText,
      joinUnits: joinUnits,
      exportBaseName: exportBaseName,
      escXml: escXml,
      buildDocxXml: buildDocxXml,
      buildDocxFiles: buildDocxFiles,
      paraXml: paraXml,
      tableXml: tableXml,
      pageSizeXml: pageSizeXml,
      buildDocxXmlFromUnits: buildDocxXmlFromUnits,
      detectOrient: detectOrient,
      recognizeSmart: recognizeSmart,
      detectColorRegions: detectColorRegions,
      colorPixel: colorPixel,
      refineTableCells: refineTableCells,
      pageStats: pageStats,
      passScore: passScore,
      textDice: textDice,
      decimalLineCandidate: decimalLineCandidate,
      acceptDecimalLine: acceptDecimalLine,
      lineOverlapRatio: lineOverlapRatio,
      MULTI: MULTI,
      /* 原始识别（不增强、不版面）：供评测工具比较不同参数形态与通道 */
      rawRecognize: async function (canvas, options, lang) {
        var wk = await ensureWorker(lang || 'both');
        var res = await wk.recognize(canvas, options || undefined, OUT_OPTS);
        return {
          text: (res.data && res.data.text) || '',
          conf: (res.data && typeof res.data.confidence === 'number') ? res.data.confidence : 0,
          stats: pageStats(res.data),
          data: res.data
        };
      },
      /* 评测钩子（tools/eval-ocr.cjs 用）：整条管线（增强 → 多通道识别 → 版面 → 单元格校正），
       * strategy='legacy' 复现 v1.4.1 旧行为，用于优化前后对比。 */
      pipelineEval: async function (canvas, opts) {
        var o = opts || {};
        var wk = await ensureWorker(o.lang || 'both');
        var strategy = o.strategy || 'auto';
        // 增强由 recognizeSmart 内部按质量门控决定；此处仅传开关（false/'off' 关闭像素变体）
        var smart = await recognizeSmart(wk, canvas, {
          strategy: strategy,
          enhance: o.enhance !== false && o.enhance !== 'off'
        });
        var built = buildResult(smart.res, o.mode || 'auto', smart.canvas, smart);
        var refined = 0;
        if (built && built.doc && built.hasTable && o.cellRefine !== false && strategy !== 'legacy') {
          refined = await refineTableCells(wk, smart.canvas, built.doc);
          if (refined) built.text = App.ocrEnhance.renderDocText(built.doc.blocks);
        }
        var rawLines = [];
        try {
          rawLines = App.ocrEnhance._test.collectLines(smart.res.data && smart.res.data.blocks)
            .map(function (l) {
              return { text: l.text, x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, conf: l.conf };
            });
        } catch (e) { /* 诊断字段，失败不影响识别结果 */ }
        var tableDiag = null;
        try {
          var tb = ((built.doc && built.doc.blocks) || []).filter(function (b) { return b.type === 'table'; })[0];
          if (tb) tableDiag = { colCount: tb.rows[0].length, rowCount: tb.rows.length };
          else {
            var dt = App.ocrEnhance._test.detectTable(
              App.ocrEnhance._test.collectLines(smart.res.data && smart.res.data.blocks));
            tableDiag = dt ? { colCount: dt.colCount, rowCount: dt.rows.length } : null;
          }
        } catch (e2) { /* 诊断字段 */ }
        return {
          text: built.text,
          hasTable: !!built.hasTable,
          tableDiag: tableDiag,
          doc: built.doc,
          conf: built.conf,
          rawLines: rawLines,
          stats: smart.stats,
          passes: smart.passes,
          attempts: smart.attempts,
          colorLines: smart.colorLines || 0,
          colorAttempts: smart.colorAttempts || [],
          decimalLines: smart.decimalLines || 0,
          colorRegions: smart.colorRegions || 0,
          colorRegionAttempts: smart.colorRegionAttempts || [],
          psm: smart.psm,
          scale: smart.scale,
          enhMode: smart.enh,
          enh: smart.enhInfo,
          refinedCells: refined
        };
      },
      /* 主链路冒烟钩子（verify-ocr.cjs 用）：真实创建/复用 worker、识别、清理文本。
       * 纯函数断言覆盖不到「worker 初始化 → 语言包加载 → recognize → 回调」链路，
       * 该钩子让整条链可在真实浏览器里跑断言。
       * opts.enhance = true 时走图像增强管线（缩放 → 纠偏/二值化）。 */
      ocrRef: async function (file, langKey, opts) {
        var wk = await ensureWorker(langKey || 'en');
        var input = file;
        if (opts && opts.enhance && App.ocrEnhance) {
          var canvas = await fileToCanvas(file);
          try { enhanceCanvas(canvas); } catch (e) { /* 增强失败用原图 */ }
          input = canvas;
        }
        var res = await wk.recognize(input, {}, OUT_OPTS);
        return {
          text: cleanText(res && res.data && res.data.text),
          conf: (res && res.data && typeof res.data.confidence === 'number') ? res.data.confidence : 0
        };
      }
    }
  };

  App.docsOcr.init = function () {
    $('do-pick').addEventListener('click', pickFiles);
    $('do-file').addEventListener('change', onFilesPicked);
    $('do-clear').addEventListener('click', clearFiles);
    $('do-run').addEventListener('click', run);
    $('do-cancel').addEventListener('click', function () {
      if (!task) return;
      task.cancel();
      setStatus('正在取消识别…');
    });
    App.ui.bindFileDrop('docs-ocr', {
      target: 'do-stage',
      accept: /\.(pdf|jpe?g|png|webp|bmp)$/i,
      rejectMsg: '请拖入图片（JPG / PNG / WebP / BMP）或 PDF',
      onFiles: addFiles
    });
    $('do-copy').addEventListener('click', copyText);
    $('do-txt').addEventListener('click', exportTxt);
    $('do-docx').addEventListener('click', exportDocx);
    if ($('do-xlsx')) $('do-xlsx').addEventListener('click', exportXlsx);
    if ($('do-page-p')) $('do-page-p').addEventListener('click', function () { setOrient('p'); });
    if ($('do-page-l')) $('do-page-l').addEventListener('click', function () { setOrient('l'); });
    $('do-text').addEventListener('input', updateMeta);
    if ($('do-engine')) $('do-engine').addEventListener('change', savePref);
    if ($('do-umi-url')) $('do-umi-url').addEventListener('change', savePref);
    if ($('do-umi-test')) $('do-umi-test').addEventListener('click', testUmi);
    if ($('do-rapid-install')) $('do-rapid-install').addEventListener('click', installRapid);
    loadPref();
    refreshRapidState();
    setOrient(orient);
  };
})(window.App);
