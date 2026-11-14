/* ============================================================
 * eval-ocr-real.cjs — OCR 真实素材抽检（真实 Chromium + 真实 Tesseract）
 *
 * 与 eval-ocr.cjs 的区别：样本不是 canvas 合成场景，而是本地真实图片
 * （票据 / 表格 / 标签 / 文档 / 场景照），走生产同一条：
 *   文件解码缩放（_test.fileToCanvas）→ 多通道识别 → 版面还原 → 单元格校正
 *
 * 样本目录：testdata/ocr-real/（含个人信息，默认不入库）
 *   manifest.json        样本清单：id / file / gt / category / fields / table
 *   <id>.jpg             原图
 *   <id>.gt.txt          人工核对的 GT（一行一条可见正文；不含水印/装饰/遮挡）
 *   <id>.table.json      可选：表格 GT（二维数组，按行/列与识别表格对应）
 *
 * 指标：
 *   CER / 字符命中 / 精确率 / F1 / 行召回     同 eval-ocr.cjs（tools/_ocr-metrics.cjs）
 *   字段命中    关键字段（金额/号码/日期等）归一化后子串命中率
 *   表格单元格  与 GT 表格同一行/列完全一致的比例（未检出表格则记「未检出」）
 *
 * 运行：node tools/eval-ocr-real.cjs [--write] [--dump] [--only=id1,id2] [--lang=both]
 *   --write  写入 docs/ocr-real-report.md
 *   --dump   打印每张图的 GT / 识别原文 / 表格，供逐张复核
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { launchBrowser, withServer } = require('./_lib.cjs');
const { textMetrics, tableMetrics, fieldHits } = require('./_ocr-metrics.cjs');

const PORT = 8454;
const DIR = path.join(__dirname, '..', 'testdata', 'ocr-real');
const WRITE = process.argv.includes('--write');
const DUMP = process.argv.includes('--dump');
const ONLY = (process.argv.filter((a) => a.indexOf('--only=') === 0)[0] || '').replace('--only=', '');
const LANG = (process.argv.filter((a) => a.indexOf('--lang=') === 0)[0] || '').replace('--lang=', '') || 'both';

/* ================= 样本清单 ================= */

function loadSamples() {
  const manifestPath = path.join(DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('缺少样本清单：' + manifestPath);
    console.error('请把真实样张与 GT 放入 testdata/ocr-real/（格式见 docs/ocr-real-samples.md）。');
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const all = Array.isArray(manifest.samples) ? manifest.samples : [];
  const wanted = ONLY ? ONLY.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const samples = all.filter((s) => !wanted || wanted.indexOf(s.id) >= 0);
  const missing = [];
  samples.forEach((s) => {
    [s.file, s.gt].concat(s.table ? [s.table] : []).forEach((rel) => {
      if (!fs.existsSync(path.join(DIR, rel))) missing.push(s.id + ' → ' + rel);
    });
  });
  if (missing.length) {
    console.error('样本文件缺失：\n  ' + missing.join('\n  '));
    process.exit(2);
  }
  return samples.map((s) => {
    const gtText = fs.readFileSync(path.join(DIR, s.gt), 'utf8');
    return Object.assign({}, s, {
      gtLines: gtText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
      gtTable: s.table ? JSON.parse(fs.readFileSync(path.join(DIR, s.table), 'utf8')) : null
    });
  });
}

/* ================= 浏览器内：文件 → 生产管线 ================= */

const PAGE_FN = async function (arg) {
  const res = await fetch(arg.url);
  if (!res.ok) throw new Error('图片读取失败 HTTP ' + res.status);
  const blob = await res.blob();
  const file = new File([blob], arg.name || 'sample.jpg', { type: blob.type || 'image/jpeg' });
  const canvas = await window.App.docsOcr._test.fileToCanvas(file);
  const t0 = performance.now();
  const r = await window.App.docsOcr._test.pipelineEval(canvas, { strategy: 'auto', mode: 'auto', lang: arg.lang });
  r.ms = Math.round(performance.now() - t0);
  r.canvas = { w: canvas.width, h: canvas.height };
  return r;
};

/* ================= 输出 ================= */

function pct(v) { return (v * 100).toFixed(1) + '%'; }

function tableCell(r) {
  if (!r.gtTable) return '—';
  if (!r.table || !r.table.found) return '未检出';
  return pct(r.table.cellAcc) + '（' + r.table.cols + ' 列）';
}

withServer(PORT, async (port) => {
  const samples = loadSamples();
  if (!samples.length) {
    console.error('没有匹配的样本（--only=' + ONLY + '）');
    process.exit(2);
  }

  const browser = await launchBrowser();
  const results = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(300000);
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
    await page.goto('http://localhost:' + port + '/');
    await page.waitForFunction(() => window.App && window.App.docsOcr && window.App.docsOcr._test
      && typeof window.App.docsOcr._test.pipelineEval === 'function'
      && typeof window.App.docsOcr._test.fileToCanvas === 'function', null, { timeout: 30000 });

    for (const sample of samples) {
      const row = { id: sample.id, category: sample.category || '', gtLines: sample.gtLines, gtTable: sample.gtTable };
      const url = 'http://localhost:' + port + '/testdata/ocr-real/' + encodeURIComponent(sample.file);
      try {
        const r = await page.evaluate(PAGE_FN, { url: url, name: sample.file, lang: LANG });
        row.text = r.text || '';
        row.ms = r.ms;
        row.conf = r.conf;
        row.canvas = r.canvas;
        row.passes = r.passes;
        row.psm = r.psm;
        row.scale = r.scale;
        row.enhMode = r.enhMode;
        row.metrics = textMetrics(sample.gtLines, row.text);
        row.fields = fieldHits(sample.fields, row.text);
        row.table = sample.gtTable ? tableMetrics(sample.gtTable, null, r.doc) : null;
        row.docTable = sample.gtTable
          ? (((r.doc && r.doc.blocks) || []).filter((b) => b.type === 'table')[0] || null)
          : null;
        console.log('  ' + sample.id.padEnd(18) +
          ' CER ' + pct(row.metrics.cer) +
          ' 命中 ' + pct(row.metrics.recall) +
          ' 行召回 ' + pct(row.metrics.lineRecall) +
          ' 字段 ' + row.fields.hit + '/' + row.fields.total +
          (row.table ? ' 表格 ' + tableCell(row) : '') +
          '  ' + row.ms + 'ms');
        if (DUMP) {
          console.log('\n--- ' + sample.id + ' [' + row.category + '] ' + row.canvas.w + 'x' + row.canvas.h +
            ' | conf ' + (row.conf || 0).toFixed(1) + ' passes ' + row.passes +
            ' psm ' + row.psm + ' enh ' + row.enhMode + ' scale ' + row.scale);
          console.log('GT   :', JSON.stringify(sample.gtLines));
          console.log('OUT  :\n' + (row.text || '(空)'));
          if (sample.gtTable) {
            console.log('TABLE GT :', JSON.stringify(sample.gtTable));
            console.log('TABLE OUT:', JSON.stringify(row.docTable && row.docTable.rows));
          }
          console.log('FIELDS:', JSON.stringify(sample.fields || []));
          console.log('');
        }
      } catch (e) {
        row.error = String((e && e.message) || e);
        console.log('  ' + sample.id.padEnd(18) + ' 失败：' + row.error);
      }
      results.push(row);
    }
  } finally {
    await browser.close();
  }

  const ok = results.filter((r) => !r.error);
  if (!ok.length) {
    console.error('全部样本识别失败，未生成报告。');
    process.exit(1);
  }

  const avg = (vals) => vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
  function summarize(list) {
    const tables = list.filter((r) => r.table && r.table.found);
    return {
      n: list.length,
      cer: avg(list.map((r) => r.metrics.cer)),
      recall: avg(list.map((r) => r.metrics.recall)),
      precision: avg(list.map((r) => r.metrics.precision)),
      f1: avg(list.map((r) => r.metrics.f1)),
      lineRecall: avg(list.map((r) => r.metrics.lineRecall)),
      fieldRate: avg(list.map((r) => r.fields.rate)),
      tableAcc: tables.length ? avg(tables.map((r) => r.table.cellAcc)) : null,
      ms: Math.round(avg(list.map((r) => r.ms)))
    };
  }
  const isScene = (r) => r.category.indexOf('场景') === 0;
  const mainList = ok.filter((r) => !isScene(r));
  const sceneList = ok.filter(isScene);
  const summary = summarize(ok);
  summary.main = summarize(mainList);
  summary.scene = summarize(sceneList);
  const weakOf = (list) => list.filter((r) => r.metrics.cer >= 0.1)
    .sort((a, b) => b.metrics.cer - a.metrics.cer);

  function summaryLine(s) {
    return 'CER ' + pct(s.cer) +
      '，字符命中 ' + pct(s.recall) +
      '，精确率 ' + pct(s.precision) +
      '，F1 ' + s.f1.toFixed(3) +
      '，行召回 ' + pct(s.lineRecall) +
      '，字段命中 ' + pct(s.fieldRate) +
      (s.tableAcc == null ? '' : '，表格单元格 ' + pct(s.tableAcc)) +
      '，单页 ' + s.ms + 'ms';
  }

  const head = '| 样本 | 类别 | 通道 | 尺寸 | CER | 字符命中 | 精确率 | 行召回 | 字段命中 | 表格单元格 | 置信度 | 耗时 ms |';
  const sep = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  const rows = results.map((r) => {
    if (r.error) {
      return '| ' + r.id + ' | ' + r.category + ' | — | — | — | — | — | — | — | — | — | 失败：' + r.error.replace(/\|/g, '/') + ' |';
    }
    const ch = (r.enhMode || 'off') + ' · ' + r.psm + ' · ' + (r.scale || 1) + 'x';
    return '| ' + r.id + ' | ' + r.category + ' | ' + ch + ' | ' + r.canvas.w + '×' + r.canvas.h + ' | ' +
      pct(r.metrics.cer) + ' | ' + pct(r.metrics.recall) + ' | ' + pct(r.metrics.precision) + ' | ' +
      pct(r.metrics.lineRecall) + ' | ' + r.fields.hit + '/' + r.fields.total + ' | ' +
      tableCell(r) + ' | ' + (r.conf || 0).toFixed(1) + ' | ' + r.ms + ' |';
  });
  const table = [head, sep].concat(rows).join('\n');

  console.log('\n' + table);
  console.log('\n总体平均（' + summary.n + ' 张）：' + summaryLine(summary));
  if (summary.main.n) console.log('主场景平均（' + summary.main.n + ' 张）：' + summaryLine(summary.main));
  if (summary.scene.n) console.log('场景边界平均（' + summary.scene.n + ' 张）：' + summaryLine(summary.scene));
  const weak = weakOf(mainList);
  const sceneWeak = weakOf(sceneList);
  if (weak.length) {
    console.log('主场景弱项（CER ≥ 10%）：' + weak.map((r) => r.id + ' ' + pct(r.metrics.cer)).join('、'));
  }
  if (sceneWeak.length) {
    console.log('场景边界弱项（CER ≥ 10%）：' + sceneWeak.map((r) => r.id + ' ' + pct(r.metrics.cer)).join('、'));
  }

  if (WRITE) {
    const out = path.join(__dirname, '..', 'docs', 'ocr-real-report.md');
    const lines = [
      '# OCR 真实素材抽检报告（自动生成）',
      '',
      '> 生成时间：' + new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC' +
        ' · 引擎：Tesseract.js v5（chi_sim + eng） · 由 `node tools/eval-ocr-real.cjs --write` 生成',
      '> 样本：' + results.length + ' 张真实图片（票据 / 表格 / 标签 / 文档 / 场景照），本地目录 `testdata/ocr-real/`，来源与 GT 约定见 `docs/ocr-real-samples.md`。',
      '> 管线：当前生产链路（通道择优 + 版面还原 + 单元格校正）。',
      '> GT 为人工核对的可辨正文，不含水印 / 装饰 / 遮挡文字；字段命中按关键字段归一化子串匹配。',
      '',
      table,
      '',
      '**总体平均（' + summary.n + ' 张）**：' + summaryLine(summary) + '。',
      '',
      summary.main.n ? '**主场景平均（' + summary.main.n + ' 张：文档 / 票据 / 标签 / 表格）**：' + summaryLine(summary.main) + '。' : '',
      '',
      summary.scene.n ? '**场景边界平均（' + summary.scene.n + ' 张：场景 / 竖排）**：' + summaryLine(summary.scene) + '。' : '',
      '',
      '**主场景弱项（CER ≥ 10%）**：' + (weak.length
        ? weak.map((r) => '`' + r.id + '` ' + pct(r.metrics.cer)).join('、')
        : '无。'),
      '',
      sceneWeak.length ? '**场景边界弱项（CER ≥ 10%）**：' +
        sceneWeak.map((r) => '`' + r.id + '` ' + pct(r.metrics.cer)).join('、') : '',
      '',
      '> 真实图片含个人信息，默认不入库；复跑前先按 `docs/ocr-real-samples.md` 准备样本与 GT。'
    ].filter((line, i, arr) => line !== '' || arr[i - 1] !== '');
    fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
    console.log('\n已写入 ' + out);
  }
  process.exit(results.some((r) => r.error) ? 1 : 0);
}).catch((e) => { console.error('脚本异常:', (e && e.message) || e); process.exit(2); });
