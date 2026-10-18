/* zip.js 单元测试：ZIP(store) 结构 / CRC32 向量 / 真实解压回归（Win: Expand-Archive / 其他: unzip） */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// 以经典脚本方式加载 zip.js（模拟 window）
global.window = {};
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'zip.js'), 'utf8'));
const ZipUtil = global.window.ZipUtil;

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}

(async function main() {
  /* ---------- 1. CRC32 标准测试向量 ---------- */
  assert(ZipUtil.crc32(new TextEncoder().encode('123456789')) === 0xCBF43926,
    'CRC32("123456789") = 0xCBF43926');
  assert(ZipUtil.crc32(new Uint8Array(0)) === 0, 'CRC32(空数据) = 0');

  /* ---------- 2. 打包两个条目（含中文文件名） ---------- */
  const pngA = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4, 5]);
  const pngB = Buffer.concat([Buffer.alloc(1000, 0x7A), Buffer.from('tail-bytes')]);
  const files = [
    { name: '照片A_排版_6寸_第1页共2页.png', data: new Uint8Array(pngA) },
    { name: '照片B.png', data: new Uint8Array(pngB) }
  ];
  const blob = await ZipUtil.store(files);
  assert(blob instanceof Blob && blob.type === 'application/zip', '返回 Blob，MIME 为 application/zip');
  const buf = Buffer.from(await blob.arrayBuffer());

  /* ---------- 3. EOCD ---------- */
  const eocdOff = buf.length - 22;
  assert(buf.readUInt32LE(eocdOff) === 0x06054b50, 'EOCD 签名位于末尾 22 字节处');
  assert(buf.readUInt16LE(eocdOff + 8) === 2 && buf.readUInt16LE(eocdOff + 10) === 2,
    'EOCD 条目数（本盘/总计）均为 2');

  const cdOffset = buf.readUInt32LE(eocdOff + 16);
  const cdSize = buf.readUInt32LE(eocdOff + 12);

  /* ---------- 4. 遍历中央目录：名字 / 标志 / store / CRC / 数据逐字节 ---------- */
  const expected = ['照片A_排版_6寸_第1页共2页.png', '照片B.png'];
  const raw = [pngA, pngB];
  let pos = cdOffset;
  for (let i = 0; i < 2; i++) {
    assert(buf.readUInt32LE(pos) === 0x02014b50, '条目 ' + i + ' 中央目录签名');
    assert(buf.readUInt16LE(pos + 8) === 0x0800, '条目 ' + i + ' UTF-8 文件名标志 0x0800');
    assert(buf.readUInt16LE(pos + 10) === 0, '条目 ' + i + ' 压缩方法为 store(0)');
    const crc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const localOff = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    assert(name === expected[i], '条目 ' + i + ' 文件名 UTF-8 往返一致');
    assert(compSize === uncompSize, '条目 ' + i + ' 压缩前后大小一致（store）');

    assert(buf.readUInt32LE(localOff) === 0x04034b50, '条目 ' + i + ' 本地文件头签名');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    assert(data.equals(raw[i]), '条目 ' + i + ' 数据逐字节一致');
    assert(ZipUtil.crc32(data) === crc, '条目 ' + i + ' CRC32 与数据匹配');

    pos += 46 + nameLen;
  }
  assert(pos === cdOffset + cdSize, '中央目录实际大小与 EOCD 记录一致');

  /* ---------- 5. 真实解压回归：Windows Expand-Archive / 其他平台 unzip ----------
     CI 的 ubuntu runner 没有 powershell（spawnSync ENOENT），非 Windows 改用
     系统自带 unzip；两者都不可用时跳过本步（结构/CRC 断言已覆盖正确性）。 */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zunhong-zip-'));
  try {
    const zipPath = path.join(tmp, 'test.zip');
    fs.writeFileSync(zipPath, buf);
    const outDir = path.join(tmp, 'out');
    let extracted = false;
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command',
        "Expand-Archive -LiteralPath '" + zipPath + "' -DestinationPath '" + outDir + "' -Force"]);
      extracted = true;
    } else {
      try {
        execFileSync('unzip', ['-o', zipPath, '-d', outDir]);
        extracted = true;
      } catch (e) {
        if (e && e.code !== 'ENOENT') throw e;
        console.log('  skip - 未找到 unzip，跳过真实解压回归（非 Windows 平台）');
      }
    }
    if (extracted) {
      for (let i = 0; i < expected.length; i++) {
        const fp = path.join(outDir, expected[i]);
        assert(fs.existsSync(fp), '解压后存在文件「' + expected[i] + '」');
        if (fs.existsSync(fp)) {
          assert(Buffer.from(fs.readFileSync(fp)).equals(raw[i]), '解压文件「' + expected[i] + '」逐字节一致');
        }
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n结果： ' + pass + ' 通过， ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
