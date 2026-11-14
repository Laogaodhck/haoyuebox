/* ============================================================
 * build-ocr-engine.cjs — 生成 OCR 引擎精简包（体积小、仅中英模型）
 *
 * 引擎不随仓库/安装包分发，改为发布到 GitHub Release 供应用按需下载。
 * 维护者从 Umi-OCR 发布包提取引擎后，用本脚本打包：
 *
 *   node tools/build-ocr-engine.cjs [引擎目录] [输出文件]
 *
 * 默认：electron/bin/umi-ocr（.gitignore 忽略，本地放置即可）
 *       → release-build/haoyue-ocr-engine-2.1.5.zip（zip 内顶层目录 umi-ocr/）
 * 生成后上传到 tag `ocr-engine-2.1.5` 的同名 Release（见 VENDOR.md）。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const hashLib = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const engine = require(path.join(ROOT, 'electron', 'ocr-engine.js'));
const { resolve7zPath, no7zError } = require(path.join(ROOT, 'electron', 'archive-engine.js'));

const src = path.resolve(process.argv[2] || path.join(ROOT, 'electron', 'bin', 'umi-ocr'));
const out = path.resolve(process.argv[3] || path.join(ROOT, 'release-build', engine.ASSET_NAME));

function fail(msg) {
  console.error('打包失败：' + msg);
  process.exit(1);
}

const missing = engine.missingFiles(src);
if (missing.length) fail('源目录缺少文件（' + src + '）：' + missing.join('、'));

const exe7z = resolve7zPath();
if (!exe7z) fail(no7zError());

fs.mkdirSync(path.dirname(out), { recursive: true });
try { fs.unlinkSync(out); } catch (err) { /* 不存在 */ }

/* 以引擎目录的父目录为工作目录打包，保证 zip 内顶层为 umi-ocr/，
 * 应用解压到安装根目录后即为 <root>/umi-ocr/RapidOCR-json.exe */
const r = spawnSync(exe7z, ['a', '-tzip', '-mx=5', out, path.basename(src)], {
  cwd: path.dirname(src),
  windowsHide: true,
  encoding: 'utf8'
});
if (r.status !== 0) fail((r.stderr || r.stdout || '').trim() || ('7z 退出码 ' + r.status));

const size = fs.statSync(out).size;
const hash = hashLib.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
console.log('已生成：' + out);
console.log('体积：' + (size / 1024 / 1024).toFixed(1) + ' MB');
console.log('SHA-256：' + hash);
console.log('');
console.log('上传（首次创建 Release，tag 需指向不含引擎的提交）：');
console.log('  gh release create ' + engine.RELEASE_TAG + ' "' + out + '" \\');
console.log('    --repo ' + 'Laogaodhck/haoyuebox' + ' --title "OCR 引擎 ' + engine.ENGINE_VERSION + '" --notes "RapidOCR 精简引擎（中英）"');
