/* ============================================================
 * eval-ocr.cjs — OCR 精度与命中率评测（真实浏览器 + 真实 Tesseract）
 *
 * 用途：量化「单遍识别（前）」与「多通道识别 + 版面/后处理（后）」
 * 在 8 类典型场景下的差异。合成场景全部确定性生成（固定坐标 / 固定字体 / 固定噪声种子），
 * 不含真人照片，可重复运行。
 *
 * 指标：
 *   CER      字符错误率 = (S+D+I)/N（N = 标准答案字符数，归一化后按 Unicode 字符计）
 *   字符召回   = M/N（衡量"命中率"）
 *   字符精确率 = M/(M+S+I)（衡量"多识别出的错误字符"）
 *   F1        = 2PR/(P+R)
 *   行召回     = 标准答案行中被正确还原（相似度 ≥ 0.8）的比例
 *   行序准确   = 第 i 行与第 i 条输出行匹配的比例（衡量定位/顺序）
 *   单元格准确 = 表格场景中单元格文本完全一致的比例
 *   耗时       = 单页管线毫秒数（含增强与多通道）
 *
 * 运行：node tools/eval-ocr.cjs [--write] [--only=clean,table]
 *   --write  把结果表写入 docs/ocr-eval-report.md
 * 依赖：Chromium（同 verify 系列，支持 HAOYUE_CHROMIUM）
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { launchBrowser, withServer } = require('./_lib.cjs');

const PORT = 8453;
const WRITE = process.argv.includes('--write');
const DUMP = process.argv.includes('--dump');
const MATRIX = process.argv.includes('--matrix');
const ONLY = (process.argv.filter((a) => a.indexOf('--only=') === 0)[0] || '').replace('--only=', '');

/* ================= 场景定义（确定性合成，含标准答案） ================= */

const TITLE = '浩玥工具箱 OCR 精度评测样本';
const L1 = 'Total 128 items, batch No. A12-38B';
const L2 = '电话 13812345678 日期 2026年10月21日';
const L3 = '备注：识别结果需与原件保持一致。';

const TEXT_SPEC = {
  w: 1400, h: 760, bg: '#ffffff', ink: '#111111',
  lines: [
    { text: TITLE, x: 90, y: 120, size: 32, weight: 'bold' },
    { text: L1, x: 90, y: 220, size: 24 },
    { text: L2, x: 90, y: 290, size: 24 },
    { text: L3, x: 90, y: 360, size: 24 }
  ]
};

const TABLE_ROWS = [
  ['项目', '数量', '金额'],
  ['合计', '9', '1,280.50'],
  ['均摊', '12', '106.71'],
  ['备注', '3', '0.00']
];
const TABLE_ALIGNS = ['left', 'right', 'right'];

const SCENES = [
  {
    id: 'clean', name: '清晰文档（基线）', kind: 'text',
    spec: TEXT_SPEC,
    gt: [TITLE, L1, L2, L3]
  },
  {
    id: 'blur', name: '模糊 + 低对比度', kind: 'text',
    spec: Object.assign({}, TEXT_SPEC, { bg: '#e6e6e6', ink: '#5f5f5f', blur: 1.4 }),
    gt: [TITLE, L1, L2, L3]
  },
  {
    id: 'skew', name: '整体倾斜 3°', kind: 'text',
    spec: Object.assign({}, TEXT_SPEC, { rotate: 3, w: 1400, h: 820 }),
    gt: [TITLE, L1, L2, L3]
  },
  {
    id: 'lowres', name: '低分辨率（0.42x 小字）', kind: 'text',
    spec: Object.assign({}, TEXT_SPEC, { scaleTo: 0.42 }),
    gt: [TITLE, L1, L2, L3]
  },
  {
    id: 'complex', name: '复杂背景（渐变 + 噪点）', kind: 'text',
    spec: Object.assign({}, TEXT_SPEC, {
      gradient: ['#c9d6e3', '#eef2f6'], noise: 900, seed: 7, ink: '#1b1b1b'
    }),
    gt: [TITLE, L1, L2, L3]
  },
  {
    id: 'table', name: '复杂表格（4×3 · 右对齐数字）', kind: 'table',
    spec: {
      w: 1200, h: 640, bg: '#ffffff', ink: '#111111',
      colAnchors: [
        { left: 90, right: 520 },
        { left: 600, right: 800 },
        { left: 880, right: 1110 }
      ],
      rowY: [140, 240, 340, 440], size: 26,
      rows: TABLE_ROWS, aligns: TABLE_ALIGNS
    },
    gt: TABLE_ROWS.map((r) => r.join(' ')),
    gtTable: TABLE_ROWS,
    gtAligns: TABLE_ALIGNS
  },
  {
    id: 'sparse', name: '文字定位偏差（稀疏分散）', kind: 'text',
    spec: {
      w: 1400, h: 900, bg: '#ffffff', ink: '#111111',
      lines: [
        { text: '左上角标签 A1', x: 120, y: 140, size: 22 },
        { text: '右上区域 Code B-27', x: 820, y: 200, size: 22 },
        { text: '中左 说明文字', x: 300, y: 430, size: 22 },
        { text: '中右 24 件', x: 960, y: 530, size: 22 },
        { text: '左下 备注 2026-10', x: 160, y: 720, size: 22 },
        { text: '底部 合计 3,860.00', x: 700, y: 790, size: 22 }
      ]
    },
    gt: ['左上角标签 A1', '右上区域 Code B-27', '中左 说明文字', '中右 24 件', '左下 备注 2026-10', '底部 合计 3,860.00']
  },
  {
    id: 'mixed', name: '中英数混排', kind: 'text',
    spec: {
      w: 1300, h: 620, bg: '#ffffff', ink: '#111111',
      lines: [
        { text: '型号 Model A12-38B 数量 Qty 24 件', x: 90, y: 160, size: 26 },
        { text: '单价 ¥1,280.50 折扣 5% 合计 ¥1,216.48', x: 90, y: 250, size: 26 },
        { text: '联系人：张伟 Tel: 13812345678 Email: a@b.com', x: 90, y: 340, size: 26 },
        { text: '批次 Batch #20261021-01 状态 OK', x: 90, y: 430, size: 26 }
      ]
    },
    gt: [
      '型号 Model A12-38B 数量 Qty 24 件',
      '单价 ¥1,280.50 折扣 5% 合计 ¥1,216.48',
      '联系人：张伟 Tel: 13812345678 Email: a@b.com',
      '批次 Batch #20261021-01 状态 OK'
    ]
  }
];

/* ================= 指标计算 ================= */

// 归一化：NFKC + 去空白 + 小写（中文不受影响，西文大小写不敏感）
function norm(s) {
  return String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

// Levenshtein 对齐（含回溯），返回 匹配/替换/删除/插入
function alignChars(a, b) {
  const m = a.length, n = b.length;
  const dp = new Uint32Array((m + 1) * (n + 1));
  const w = n + 1;
  for (let i = 0; i <= m; i++) dp[i * w] = i;
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(dp[(i - 1) * w + j] + 1, dp[i * w + j - 1] + 1, dp[(i - 1) * w + j - 1] + cost);
      dp[i * w + j] = v;
    }
  }
  let i = m, j = n, M = 0, S = 0, D = 0, I = 0;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { M++; i--; j--; continue; }
    const cur = dp[i * w + j];
    if (cur === dp[(i - 1) * w + j - 1] + 1) { S++; i--; j--; }
    else if (cur === dp[(i - 1) * w + j] + 1) { D++; i--; }   // 标准答案缺字（漏识）
    else { I++; j--; }                                        // 输出多字（误识）
  }
  D += i; I += j;
  return { M, S, D, I, dist: S + D + I, gtLen: m, outLen: n };
}

// 单行相似度（用于行召回）
function lineSim(gt, out) {
  const a = norm(gt), b = norm(out);
  if (!a.length && !b.length) return 1;
  const d = alignChars(a, b).dist;
  return Math.max(0, 1 - d / Math.max(a.length, b.length));
}

function textMetrics(gtLines, outText) {
  const gt = norm(gtLines.join(''));
  const out = norm(outText);
  const al = alignChars(gt, out);
  const M = al.M;
  const recall = gt.length ? M / gt.length : 0;
  const precision = out.length ? M / out.length : 0;
  const f1 = (precision + recall) ? 2 * precision * recall / (precision + recall) : 0;
  const cer = gt.length ? al.dist / gt.length : 0;

  // 行召回 / 行序
  const outLines = String(outText || '').split('\n').map((s) => s.trim()).filter(Boolean);
  let hit = 0;
  gtLines.forEach((g) => {
    const best = outLines.reduce((mx, o) => Math.max(mx, lineSim(g, o)), 0);
    if (best >= 0.8) hit++;
  });
  let order = 0;
  gtLines.forEach((g, i) => {
    if (outLines[i] && lineSim(g, outLines[i]) >= 0.8) order++;
  });
  return {
    cer: cer, recall: recall, precision: precision, f1: f1,
    lineRecall: gtLines.length ? hit / gtLines.length : 0,
    lineOrder: gtLines.length ? order / gtLines.length : 0,
    chars: out.length
  };
}

function tableMetrics(gtRows, gtAligns, doc) {
  const table = ((doc && doc.blocks) || []).filter((b) => b.type === 'table')[0];
  if (!table) return { found: false, cellAcc: 0, cols: 0, alignsOk: false };
  let total = 0, match = 0;
  gtRows.forEach((row, ri) => {
    row.forEach((cell, ci) => {
      total++;
      const got = (table.rows[ri] || [])[ci];
      if (got != null && norm(got) === norm(cell)) match++;
    });
  });
  return {
    found: true,
    cellAcc: total ? match / total : 0,
    cols: (table.rows[0] || []).length,
    alignsOk: JSON.stringify(table.aligns) === JSON.stringify(gtAligns)
  };
}

/* ================= 浏览器内绘制与识别 ================= */

const PAGE_FN = async function (arg) {
  const spec = arg.spec;
  const strategy = arg.strategy;
  const enhanceMode = arg.enhanceMode || 'full';
  function mk(w, h, bg) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    const x = c.getContext('2d');
    x.fillStyle = bg || '#ffffff';
    x.fillRect(0, 0, c.width, c.height);
    return { c, x };
  }
  const base = mk(spec.w, spec.h, spec.bg);
  let target = base.x;
  // 复杂背景：线性渐变 + 确定性噪点（LCG，种子固定）
  if (spec.gradient) {
    const g = base.x.createLinearGradient(0, 0, spec.w, spec.h);
    g.addColorStop(0, spec.gradient[0]);
    g.addColorStop(1, spec.gradient[1]);
    base.x.fillStyle = g;
    base.x.fillRect(0, 0, spec.w, spec.h);
  }
  if (spec.noise) {
    let s = (spec.seed || 1) * 9301 + 49297;
    const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    for (let i = 0; i < spec.noise; i++) {
      const r = 1 + rnd() * 2;
      base.x.fillStyle = 'rgba(80,90,110,' + (0.15 + rnd() * 0.35).toFixed(2) + ')';
      base.x.beginPath();
      base.x.arc(rnd() * spec.w, rnd() * spec.h, r, 0, Math.PI * 2);
      base.x.fill();
    }
  }
  if (spec.blur) target.filter = 'blur(' + spec.blur + 'px)';
  target.fillStyle = spec.ink || '#111111';
  target.textBaseline = 'alphabetic';

  // 表格场景：按列锚点与对齐方式定位
  if (spec.rows) {
    spec.rows.forEach((row, ri) => {
      const y = spec.rowY[ri];
      row.forEach((cell, ci) => {
        target.font = (ri === 0 ? 'bold ' : '') + spec.size + 'px "Microsoft YaHei", sans-serif';
        const a = spec.colAnchors[ci];
        const align = spec.aligns[ci];
        const w = target.measureText(cell).width;
        const px = align === 'right' ? a.right - w : (align === 'center' ? (a.left + a.right - w) / 2 : a.left);
        target.fillText(cell, px, y);
      });
    });
  } else {
    spec.lines.forEach((l) => {
      target.font = (l.weight ? l.weight + ' ' : '') + l.size + 'px "Microsoft YaHei", sans-serif';
      target.fillText(l.text, l.x, l.y);
    });
  }
  target.filter = 'none';

  // 倾斜：整体旋转（白底补边）
  let src = base.c;
  if (spec.rotate) {
    const rot = mk(spec.w, spec.h, '#ffffff');
    rot.x.translate(spec.w / 2, spec.h / 2);
    rot.x.rotate(spec.rotate * Math.PI / 180);
    rot.x.drawImage(base.c, -spec.w / 2, -spec.h / 2);
    src = rot.c;
  }
  // 低分辨率：整体缩小后直接送识别（检验自适应放大）
  if (spec.scaleTo) {
    const small = mk(spec.w * spec.scaleTo, spec.h * spec.scaleTo, '#ffffff');
    small.x.imageSmoothingEnabled = true;
    small.x.imageSmoothingQuality = 'high';
    small.x.drawImage(src, 0, 0, small.c.width, small.c.height);
    src = small.c;
  }

  const t0 = performance.now();
  const r = await window.App.docsOcr._test.pipelineEval(src,
    { strategy: strategy, mode: 'auto', enhance: arg.enhanceMode === 'off' ? false : true });
  r.ms = Math.round(performance.now() - t0);
  r.canvas = { w: src.width, h: src.height };
  return r;
};

/* ================= 主流程 ================= */

function pct(v) { return (v * 100).toFixed(1) + '%'; }
function delta(a, b) {
  const d = (b - a) * 100;
  return (d >= 0 ? '+' : '') + d.toFixed(1) + 'pt';
}

withServer(PORT, async (port) => {
  const browser = await launchBrowser();
  const results = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
    await page.goto('http://localhost:' + port + '/');
    await page.waitForFunction(() => window.App && window.App.docsOcr && window.App.docsOcr._test
      && typeof window.App.docsOcr._test.pipelineEval === 'function', null, { timeout: 30000 });

    const scenes = ONLY ? SCENES.filter((s) => ONLY.split(',').indexOf(s.id) >= 0) : SCENES;
    // --matrix：同一场景在三种通道配置下的效果（调参用）
    if (MATRIX) {
      console.log('| 场景 | 单遍原图（v1.4.1） | 多通道·增强关 | 多通道·增强开 |');
      console.log('| --- | --- | --- | --- |');
      const configs = [
        { strategy: 'legacy', enhanceMode: 'off' },
        { strategy: 'auto', enhanceMode: 'off' },
        { strategy: 'auto', enhanceMode: 'full' }
      ];
      for (const scene of scenes) {
        const cells = [];
        for (const cfg of configs) {
          const r = await page.evaluate(PAGE_FN, {
            spec: scene.spec, strategy: cfg.strategy, enhanceMode: cfg.enhanceMode
          });
          const tm = textMetrics(scene.gt, r.text);
          cells.push(pct(tm.cer) + ' / ' + pct(tm.recall));
        }
        console.log('| ' + scene.name + ' | ' + cells.join(' | ') + ' |');
      }
      return;
    }
    for (const scene of scenes) {
      const row = { id: scene.id, name: scene.name };
      for (const strategy of ['legacy', 'auto']) {
        const r = await page.evaluate(PAGE_FN, { spec: scene.spec, strategy: strategy });
        const tm = textMetrics(scene.gt, r.text);
        row[strategy] = Object.assign({ ms: r.ms, passes: r.passes, refinedCells: r.refinedCells }, tm);
        if (scene.gtTable) row[strategy].table = tableMetrics(scene.gtTable, scene.gtAligns, r.doc);
        if (strategy === 'auto') row.sample = String(r.text || '').split('\n').slice(0, 2).join(' / ');
        if (DUMP) {
          const tm = textMetrics(scene.gt, r.text);
          console.log('\n--- ' + scene.id + ' / ' + strategy + ' | CER ' + pct(tm.cer) + ' 命中 ' + pct(tm.recall) +
            ' 行召回 ' + pct(tm.lineRecall) + ' 行序 ' + pct(tm.lineOrder) + ' | psm=' + r.psm + ' passes=' + r.passes +
            ' scale=' + r.scale + ' cells=' + r.refinedCells);
          console.log(String(r.text || '(空)'));
          if (scene.gtTable) console.log('TABLE:', JSON.stringify((r.doc && (r.doc.blocks || []).filter((b) => b.type === 'table')[0] || {}).rows || null));
          console.log('GT   :', JSON.stringify(scene.gt));
        }
      }
      results.push(row);
      console.log('  ' + scene.id.padEnd(8) +
        ' CER ' + pct(row.legacy.cer) + ' → ' + pct(row.auto.cer) + ' (' + delta(row.legacy.cer, row.auto.cer) + ')' +
        '  命中 ' + pct(row.legacy.recall) + ' → ' + pct(row.auto.recall) +
        '  ' + row.legacy.ms + 'ms → ' + row.auto.ms + 'ms');
    }
  } finally {
    await browser.close();
  }

  // 汇总表
  const head = '| 场景 | CER（前 → 后） | 字符命中率（前 → 后） | F1（前 → 后） | 行召回（前 → 后） | 单元格准确 | 耗时 ms（前 → 后） |';
  const sep = '| --- | --- | --- | --- | --- | --- | --- |';
  const rows = results.map((r) => {
    const cell = r.auto.table ? (r.auto.table.found ? pct(r.auto.table.cellAcc) + '（前 ' + pct(r.legacy.table.cellAcc) + '）' : '未检出') : '—';
    return '| ' + r.name + ' | ' + pct(r.legacy.cer) + ' → **' + pct(r.auto.cer) + '** | ' +
      pct(r.legacy.recall) + ' → **' + pct(r.auto.recall) + '** | ' +
      r.legacy.f1.toFixed(3) + ' → ' + r.auto.f1.toFixed(3) + ' | ' +
      pct(r.legacy.lineRecall) + ' → ' + pct(r.auto.lineRecall) + ' | ' + cell + ' | ' +
      r.legacy.ms + ' → ' + r.auto.ms + ' |';
  });
  const avgOf = (vals) => vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
  const summary = {
    cerBefore: avgOf(results.map((r) => r.legacy.cer)),
    cerAfter: avgOf(results.map((r) => r.auto.cer)),
    recallBefore: avgOf(results.map((r) => r.legacy.recall)),
    recallAfter: avgOf(results.map((r) => r.auto.recall)),
    msBefore: Math.round(avgOf(results.map((r) => r.legacy.ms))),
    msAfter: Math.round(avgOf(results.map((r) => r.auto.ms)))
  };
  const table = [head, sep].concat(rows).join('\n');
  console.log('\n' + table);
  console.log('\n平均：CER ' + pct(summary.cerBefore) + ' → ' + pct(summary.cerAfter) +
    '，字符命中率 ' + pct(summary.recallBefore) + ' → ' + pct(summary.recallAfter) +
    '，单页耗时 ' + summary.msBefore + 'ms → ' + summary.msAfter + 'ms');

  if (WRITE) {
    const out = path.join(__dirname, '..', 'docs', 'ocr-eval-report.md');
    const md = [
      '# OCR 精度评测报告（自动生成）',
      '',
      '> 生成时间：' + new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC' +
        ' · 引擎：Tesseract.js v5（chi_sim + eng） · 由 `node tools/eval-ocr.cjs --write` 生成',
      '> 「前」= 单遍识别（基座 PSM 6、不启用多通道）；「后」= 多通道识别 + 版面还原 + 文本归一。',
      '> 两列共用同一套后处理（表格列聚类、数字纠错、标点归一），差异只来自识别通道策略。',
      '',
      table,
      '',
      '**平均**：CER ' + pct(summary.cerBefore) + ' → ' + pct(summary.cerAfter) +
        '，字符命中率 ' + pct(summary.recallBefore) + ' → ' + pct(summary.recallAfter) +
        '，单页耗时 ' + summary.msBefore + 'ms → ' + summary.msAfter + 'ms（合成场景，绝对值随机器浮动，趋势可复现）。',
      '',
      '场景为确定性合成图像（固定坐标、字体与噪声种子），不含真人样例，可重复运行对比。'
    ].join('\n');
    fs.writeFileSync(out, md, 'utf8');
    console.log('\n已写入 ' + out);
  }
  process.exit(0);
}).catch((e) => { console.error('脚本异常:', (e && e.message) || e); process.exit(2); });
