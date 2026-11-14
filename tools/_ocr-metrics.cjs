/* ============================================================
 * _ocr-metrics.cjs — OCR 评测共用指标（合成场景 / 真实素材）
 *
 * 归一化后按 Unicode 字符计 Levenshtein 编辑距离：
 *   CER = (S+D+I)/N，字符命中 = M/N，精确率 = M/(M+S+I)，F1 = 2PR/(P+R)
 * 行召回按「标准答案行与任一输出行相似度 ≥ 0.8」计；表格按单元格完全一致计。
 * ============================================================ */
'use strict';

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
    alignsOk: gtAligns ? JSON.stringify(table.aligns) === JSON.stringify(gtAligns) : null
  };
}

// 关键字段命中：归一化后子串匹配；纯数字字段加边界，避免 0.1 命中 0.15
function fieldHits(fields, outText) {
  const out = norm(outText);
  const list = fields || [];
  const hit = list.filter((f) => {
    const n = norm(f);
    if (!n) return false;
    if (/^[\d.,:%+\-/￥¥]+$/.test(n)) {
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('(^|[^0-9.])' + esc + '($|[^0-9.])').test(out);
    }
    return out.indexOf(n) >= 0;
  }).length;
  return { hit: hit, total: list.length, rate: list.length ? hit / list.length : 1 };
}

module.exports = { norm, alignChars, lineSim, textMetrics, tableMetrics, fieldHits };
