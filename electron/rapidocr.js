/* ============================================================
 * rapidocr.js — RapidOCR 引擎进程管理（主进程）
 *
 * 为什么放在主进程：
 *  - 引擎是独立 exe，需 spawn 子进程与 stdin/stdout 管道通信，渲染层无此能力；
 *  - 渲染层 CSP 限制与沙箱不允许直接拉起本机进程。
 *
 * 引擎来源：Umi-OCR 发布包（MIT）中的 RapidOCR-json 插件，由 ocr-engine.js
 * 按需下载到用户数据目录（开发期也可放在 electron/bin/umi-ocr，已 gitignore）。
 * 只保留简体中文 + 英文两套模型（解压后约 40 MB），configs.txt 同步裁剪。
 *
 * 协议（PaddleOCR-json / RapidOCR-json 管道模式）：
 *  启动：子进程 stdout 输出 "OCR init completed." 表示模型加载完成；
 *  识别：向 stdin 写一行 {"image_base64":"…"}，stdout 读一行 JSON
 *        {code, data}：100 成功（data 为 [{text, score, box, end}]）、
 *        101 无文字、其余为错误。
 *  语言由启动参数决定（rec 模型 + keys 字典），切换语言需重启进程。
 *
 * 全程本机执行，无网络。
 * ============================================================ */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const ocrEngine = require('./ocr-engine');

const ENGINE_DIR = 'umi-ocr';
const EXE_NAME = 'RapidOCR-json.exe';
const START_TIMEOUT = 60000;      // 首次启动要加载 ONNX 模型，冷盘较慢
const RECOGNIZE_TIMEOUT = 120000; // 单张图识别上限（超大扫描件留足余量）
const MAX_SIDE_LEN = 4096;
const STDERR_KEEP = 2000;         // 出错时保留的 stderr 尾部长度

/* 语言 → 识别模型 + 字典（det / cls 共用） */
const LANGS = {
  zh: { label: '简体中文', rec: 'rec_ch_PP-OCRv4_infer.onnx', keys: 'dict_chinese.txt' },
  en: { label: 'English', rec: 'rec_en_PP-OCRv3_infer.onnx', keys: 'dict_en.txt' }
};
const DET = 'ch_PP-OCRv3_det_infer.onnx';
const CLS = 'ch_ppocr_mobile_v2.0_cls_infer.onnx';

/* electron 在纯 Node（测试）环境下 require 得到的是可执行文件路径字符串，
 * 只有主进程里才是带 app 的对象，这里做兼容判断 */
function electronApp() {
  try {
    const e = require('electron');
    return e && typeof e === 'object' && e.app ? e.app : null;
  } catch (err) {
    return null;
  }
}

/* ---------- 引擎文件定位 ---------- */

function engineCandidates() {
  return [
    ocrEngine.engineDir(),                  // 按需下载后的安装目录（用户数据）
    path.join(__dirname, 'bin', ENGINE_DIR) // 开发期手工放置（.gitignore 忽略，不入库）
  ];
}

/* 返回 { dir, exe, models, missing }：dir 为空表示引擎尚未安装 */
function locate() {
  const candidates = engineCandidates();
  for (const dir of candidates) {
    const exe = path.join(dir, EXE_NAME);
    try {
      if (fs.existsSync(exe)) {
        const models = path.join(dir, 'models');
        const need = [DET, CLS, LANGS.zh.rec, LANGS.zh.keys, LANGS.en.rec, LANGS.en.keys];
        const missing = need.filter((f) => !fs.existsSync(path.join(models, f)));
        return { dir, exe, models, missing };
      }
    } catch (err) { /* 路径不可访问：尝试下一个 */ }
  }
  return { dir: '', exe: '', models: '', missing: [] };
}

/* 引擎缺失文案：未下载优先提示下载；模型缺失多为安全软件误隔离 */
function missingError(info) {
  if (!info.dir) {
    return 'OCR 引擎尚未下载（约 40 MB，仅首次需要）：请在 OCR 面板点击'
      + '「下载 OCR 引擎」，下载完成后自动解压到用户数据目录。';
  }
  return 'OCR 引擎文件不完整（缺少 ' + info.missing.join('、') + '），'
    + '可能被安全软件隔离，请重新下载或恢复后重试。';
}

/* ---------- 逐行读取器：stdout 按行切分，供启动握手与识别取结果共用 ---------- */

class LineReader {
  constructor(stream) {
    this.buf = '';
    this.pending = [];   // 等待中的 nextLine
    this.lines = [];     // 已到达但无人取的行
    this.exited = false;
    this.exitError = null;
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        const waiter = this.pending.shift();
        if (waiter) waiter.resolve(line);
        else this.lines.push(line);
      }
    });
    stream.on('error', (err) => this.fail(err));
  }

  nextLine(timeoutMs) {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.exited) return Promise.reject(this.exitError || new Error('OCR 引擎进程已退出'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve: null, reject: null, timer: null };
      waiter.resolve = (line) => { clearTimeout(waiter.timer); resolve(line); };
      waiter.reject = (err) => { clearTimeout(waiter.timer); reject(err); };
      waiter.timer = setTimeout(() => {
        const idx = this.pending.indexOf(waiter);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error('等待 OCR 引擎响应超时'));
      }, Math.max(1, timeoutMs));
      this.pending.push(waiter);
    });
  }

  fail(err) {
    if (this.exited) return;
    this.exited = true;
    this.exitError = err;
    const waiters = this.pending.splice(0);
    waiters.forEach((w) => w.reject(err));
  }
}

/* ---------- 引擎实例（单例：同一时刻只保留一个进程） ---------- */

class RapidEngine {
  constructor() {
    this.child = null;
    this.reader = null;
    this.lang = '';
    this.version = '';
    this.stderrTail = '';
    this.queue = Promise.resolve();
  }

  /* 串行化：管道协议一问一答，并发写会造成结果错配 */
  enqueue(fn) {
    const run = this.queue.then(() => fn());
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.reader = null;
    this.lang = '';
    if (child) {
      /* 标记为主动关闭：exit 事件异步到达，不能用共享的 stopping 标志判断 */
      child.__haoyueExpectedExit = true;
      try { child.kill(); } catch (err) { /* 已退出 */ }
    }
  }

  /* 启动并完成握手：语言一致且进程存活时直接复用 */
  async start(langKey) {
    const lang = LANGS[langKey] ? langKey : 'zh';
    if (this.child && this.reader && !this.reader.exited && this.lang === lang) return;
    await this.stop();

    const info = locate();
    if (!info.dir || info.missing.length) throw new Error(missingError(info));

    const threads = Math.max(1, Math.min(4, os.cpus().length - 1));
    const args = [
      '--models=' + info.models,
      '--det=' + DET,
      '--cls=' + CLS,
      '--rec=' + LANGS[lang].rec,
      '--keys=' + LANGS[lang].keys,
      '--ensureAscii=1',
      '--numThread=' + threads,
      '--maxSideLen=' + MAX_SIDE_LEN,
      '--doAngle=1'
    ];

    const child = spawn(info.exe, args, {
      cwd: info.dir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    this.lang = lang;
    this.version = '';
    this.stderrTail = '';
    const reader = new LineReader(child.stdout);
    this.reader = reader;
    const engine = this;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      engine.stderrTail = (engine.stderrTail + chunk).slice(-STDERR_KEEP);
    });

    const exitError = new Error('OCR 引擎进程已退出');
    child.on('error', (err) => {
      const msg = err && err.code === 'ENOENT'
        ? '无法启动 OCR 引擎：文件不存在或无权访问（可能被杀毒软件拦截）'
        : '无法启动 OCR 引擎：' + ((err && err.message) || err);
      reader.fail(new Error(msg));
    });
    child.on('exit', (code) => {
      const tail = engine.stderrTail.trim();
      const err = child.__haoyueExpectedExit
        ? exitError
        : new Error('OCR 引擎意外退出（退出码 ' + code + '）' + (tail ? '：' + tail.slice(-300) : ''));
      reader.fail(err);
      if (engine.child === child) {
        engine.child = null;
        engine.reader = null;
        engine.lang = '';
      }
    });

    /* 启动握手：读到 "OCR init completed." 才算可用 */
    const deadline = Date.now() + START_TIMEOUT;
    for (;;) {
      const remain = deadline - Date.now();
      if (remain <= 0) {
        await this.stop();
        throw new Error('OCR 引擎启动超时（' + Math.round(START_TIMEOUT / 1000) + ' 秒）：'
          + (this.stderrTail.trim() || '请检查模型文件是否完整'));
      }
      let line;
      try {
        line = await reader.nextLine(remain);
      } catch (err) {
        await this.stop();
        throw new Error(((err && err.message) || err) + (this.stderrTail.trim() ? '：' + this.stderrTail.trim() : ''));
      }
      const m = /RapidOCR-json\s*v?([\d.]+)/i.exec(line);
      if (m) this.version = m[1];
      if (/OCR init completed/i.test(line)) return;
    }
  }

  /* 单张识别：imgBase64 为不带 data: 前缀的 base64 */
  async recognizeOnce(imgBase64, langKey) {
    const base64 = String(imgBase64 || '');
    if (!base64) throw new Error('缺少图片数据');
    await this.start(langKey);

    const started = Date.now();
    const child = this.child;
    if (!child || !child.stdin.writable) throw new Error('OCR 引擎未就绪');
    try {
      child.stdin.write(JSON.stringify({ image_base64: base64 }) + '\n');
    } catch (err) {
      await this.stop();
      throw new Error('向 OCR 引擎发送图片失败：' + ((err && err.message) || err));
    }

    const deadline = started + RECOGNIZE_TIMEOUT;
    for (;;) {
      const remain = deadline - Date.now();
      if (remain <= 0) {
        await this.stop();
        throw new Error('OCR 识别超时（' + Math.round(RECOGNIZE_TIMEOUT / 1000) + ' 秒无响应）');
      }
      const line = await this.reader.nextLine(remain);
      const text = line.trim();
      if (!text || text[0] !== '{') continue; // 引擎日志行（版本 / 警告）跳过
      let res;
      try {
        res = JSON.parse(text);
      } catch (err) {
        continue;
      }
      return normalizeResult(res, Date.now() - started);
    }
  }

  recognize(imgBase64, langKey) {
    return this.enqueue(() => this.recognizeOnce(imgBase64, langKey));
  }

  status() {
    const info = locate();
    const available = !!(info.dir && !info.missing.length);
    return {
      ok: true,
      available,
      installed: available,
      dir: info.dir,
      missing: info.missing,
      running: !!(this.child && this.reader && !this.reader.exited),
      lang: this.lang,
      version: this.version,
      error: available ? '' : missingError(info)
    };
  }
}

/* 引擎返回 → 统一结构（与 electron/umi-ocr.js 的识别结果同构） */
function normalizeResult(res, elapsedMs) {
  const code = Number(res && res.code);
  const time = elapsedMs / 1000;
  if (code === 100) {
    const data = Array.isArray(res.data) ? res.data : [];
    return { ok: true, code, data, time, empty: data.length === 0 };
  }
  if (code === 101) return { ok: true, code, data: [], time, empty: true };
  const msg = typeof (res && res.data) === 'string' ? res.data : '识别失败';
  const err = new Error('OCR 引擎识别失败（' + (Number.isFinite(code) ? code : '未知') + '）：' + msg);
  err.code = Number.isFinite(code) ? code : 0;
  throw err;
}

const engine = new RapidEngine();

/* IPC 注册：错误以 {ok:false,error} 返回，渲染层可原样展示 */
function registerRapidIpc(ipcMain) {
  ipcMain.handle('ocr:rapidStatus', () => {
    try {
      return engine.status();
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
  ipcMain.handle('ocr:rapidRecognize', async (e, payload) => {
    try {
      const p = payload || {};
      return await engine.recognize(p.base64, p.lang);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
}

/* 应用退出时释放子进程（不挂在 IPC 上：退出阶段 IPC 已不可用） */
function registerLifecycle() {
  const app = electronApp();
  if (app && typeof app.on === 'function') {
    app.on('will-quit', () => {
      engine.stop();
    });
  }
}

module.exports = {
  LANGS,
  engine,
  locate,
  registerRapidIpc,
  registerLifecycle,
  normalizeResult,
  RapidEngine
};
