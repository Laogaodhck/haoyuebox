/* ============================================================
 * verify-output.cjs — 检查 PNG 产物的尺寸与 pHYs（DPI）元数据
 * 用法：node tools/verify-output.cjs [a.png b.png ...]
 *       不带参数时检查 .playwright-cli/ 下 E2E 下载的默认产物
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function phys(buf) {
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    if (buf.toString('ascii', pos + 4, pos + 8) === 'pHYs') {
      return { x: buf.readUInt32BE(pos + 8), y: buf.readUInt32BE(pos + 12), u: buf[pos + 16] };
    }
    pos += 12 + len;
  }
  return null;
}

const args = process.argv.slice(2);
let files = args.length
  ? args
  : ['.playwright-cli/out-single.png', '.playwright-cli/out-sheet.png'].map(p => path.join(ROOT, p));

/* 默认模式（无参数）：E2E 产物不存在时优雅跳过，不阻塞 verify 链 */
if (!args.length) {
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length === files.length) {
    console.log('verify-output: 无 E2E 产物可查（.playwright-cli/out-*.png 不存在），跳过');
    process.exit(0);
  }
  files = files.filter((f) => fs.existsSync(f));
}

let fail = 0;
for (const f of files) {
  let buf;
  try {
    buf = fs.readFileSync(f);
  } catch (e) {
    console.error('跳过（读不到文件）:', f);
    fail++;
    continue;
  }
  const dpi = phys(buf);
  const name = path.basename(f);
  console.log(name + ':', buf.length, 'bytes;',
    'size:', buf.readUInt32BE(16) + 'x' + buf.readUInt32BE(20),
    '; pHYs:', JSON.stringify(dpi),
    '=> DPI:', dpi && dpi.u === 1 ? Math.round(dpi.x * 0.0254) : 'NONE');
  if (!dpi || dpi.u !== 1) fail++;
}
process.exit(fail ? 1 : 0);
