/* ============================================================
 * make-icons.cjs — 生成 Electron/NSIS 所需图标：多尺寸 PNG + 多尺寸 ICO（PNG 条目）
 * 用法：npm run icons [-- --out <目录>]
 * 产物：icon.png(256) + icon.ico（应用本体，源 assets/src-icon.png）
 *       setup-icon.ico（NSIS 安装器/卸载程序，源 assets/src-setup-icon.png）
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { Jimp, JimpMime, ResizeStrategy } = require('jimp');

const ROOT = path.join(__dirname, '..');
const SIZES = [256, 128, 64, 48, 32, 24, 16];

function outDir() {
  const i = process.argv.indexOf('--out');
  return i > -1 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, 'assets');
}

/* 多尺寸 PNG 数据组装为 ICO（PNG 条目容器，Vista+ 标准） */
function assembleIco(pngs) {
  const count = pngs.length;
  const headerSize = 6 + 16 * count;
  const totalSize = headerSize + pngs.reduce((s, p) => s + p.buf.length, 0);
  const ico = Buffer.alloc(totalSize);
  let off = 0;

  ico.writeUInt16LE(0, off); off += 2;   // reserved
  ico.writeUInt16LE(1, off); off += 2;   // type: icon
  ico.writeUInt16LE(count, off); off += 2;

  let dataOff = headerSize;
  for (const p of pngs) {
    ico[off++] = p.size === 256 ? 0 : p.size; // width (0 = 256)
    ico[off++] = p.size === 256 ? 0 : p.size; // height
    ico[off++] = 0;   // 调色板色数
    ico[off++] = 0;   // reserved
    ico.writeUInt16LE(1, off); off += 2;   // planes
    ico.writeUInt16LE(32, off); off += 2;  // bpp
    ico.writeUInt32LE(p.buf.length, off); off += 4;
    ico.writeUInt32LE(dataOff, off); off += 4;
    p.buf.copy(ico, dataOff);
    dataOff += p.buf.length;
  }
  return ico;
}

/* 源图 → 多尺寸 PNG 缓冲（256px 可选单独落盘为 icon.png） */
async function buildSizes(src, dir, writePng256) {
  const pngs = [];
  for (const size of SIZES) {
    const img = src.clone().resize({ w: size, h: size, strategy: ResizeStrategy.BICUBIC });
    const buf = await img.getBuffer(JimpMime.png);
    pngs.push({ size, buf });
    if (size === 256 && writePng256) {
      fs.writeFileSync(path.join(dir, 'icon.png'), buf);
    }
  }
  return pngs;
}

(async () => {
  const dir = outDir();
  fs.mkdirSync(dir, { recursive: true });

  // 应用本体图标（尊泓回纹标）
  const src = await Jimp.read(path.join(ROOT, 'assets', 'src-icon.png'));
  console.log('应用图标源图:', src.bitmap.width + 'x' + src.bitmap.height, '→ 输出', dir);
  const pngs = await buildSizes(src, dir, true);
  const ico = assembleIco(pngs);
  fs.writeFileSync(path.join(dir, 'icon.ico'), ico);
  console.log('icon.ico:', ico.length, 'bytes,', pngs.length, '个尺寸; icon.png 256px 已生成');

  // 安装器图标（安装包盒+光盘；经 nsis.installerIcon/uninstallerIcon 挂载到 Setup/卸载程序）
  const setupSrcPath = path.join(ROOT, 'assets', 'src-setup-icon.png');
  if (fs.existsSync(setupSrcPath)) {
    const setupSrc = await Jimp.read(setupSrcPath);
    console.log('安装器图标源图:', setupSrc.bitmap.width + 'x' + setupSrc.bitmap.height);
    const setupPngs = await buildSizes(setupSrc, dir, false);
    const setupIco = assembleIco(setupPngs);
    fs.writeFileSync(path.join(dir, 'setup-icon.ico'), setupIco);
    console.log('setup-icon.ico:', setupIco.length, 'bytes,', setupPngs.length, '个尺寸');
  } else {
    console.log('未找到 assets/src-setup-icon.png，跳过安装器图标生成');
  }
})().catch(e => { console.error(e); process.exit(1); });
