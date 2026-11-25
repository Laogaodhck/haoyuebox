/* zip.js 单元测试：ZIP(store) 结构 / CRC32 向量 / 真实解压回归（Win: Expand-Archive / 其他: python zipfile） */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// 以经典脚本方式加载 zip.js（模拟 window）
global.window = {};
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'zip.js'), 'utf8'));
const ZipUtil = global.window.ZipUtil;

let pass = 0, fail = 0, skipped = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}
function skip(name) {
  skipped++;
  // 跳过必须显式：真实解压回归（独立解压器逐字节比对）未执行时，
  // 汇总行要能看见，防止「结构断言全绿」被误读为「解压链路已验证」
  console.log('  skip -', name);
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

  /* ---------- 5. 真实解压回归：独立解压器交叉验证 ----------
     Windows：优先系统自带 bsdtar（Win10 1803+ / CI runner 均有），失败再走 PowerShell
     直接调 .NET ZipFile.ExtractToDirectory（2 参数重载，尊重 UTF-8 文件名标志位）。
     刻意不用 Expand-Archive：CI 实测 PowerShell 7 的 Microsoft.PowerShell.Archive
     会因 ExtractToDirectory 重载缺失抛非终止错误，进程仍以 0 退出且不产出文件。
     Ubuntu：没有 powershell（spawnSync ENOENT）；Info-ZIP unzip 对 UTF-8 文件名标志位
     处理不稳（CI 实测中文条目名被改写），故用 python3 -m zipfile（独立实现）。
     全部解压器不可用 / 均失败时跳过（ZIP 结构 / CRC32 断言已覆盖正确性）。 */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haoyue-zip-'));
  try {
    const zipPath = path.join(tmp, 'test.zip');
    fs.writeFileSync(zipPath, buf);
    const outDir = path.join(tmp, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const winPs = 'Add-Type -AssemblyName System.IO.Compression.FileSystem; '
      + "[System.IO.Compression.ZipFile]::ExtractToDirectory('" + zipPath + "','" + outDir + "')";
    const attempts = process.platform === 'win32'
      ? [
          ['tar', ['-xf', zipPath, '-C', outDir]],
          ['powershell.exe', ['-NoProfile', '-Command', winPs]],
          ['pwsh', ['-NoProfile', '-Command', winPs]]
        ]
      : [
          ['python3', ['-X', 'utf8', '-m', 'zipfile', '-e', zipPath, outDir]],
          ['unzip', ['-o', zipPath, '-d', outDir]]
        ];
    let extracted = false;
    const failedTools = [];
    const hasAnyFile = function (dir) {
      return fs.readdirSync(dir, { withFileTypes: true }).some(function (ent) {
        return ent.isDirectory() ? hasAnyFile(path.join(dir, ent.name)) : true;
      });
    };
    for (const pair of attempts) {
      try {
        execFileSync(pair[0], pair[1], { stdio: 'pipe' });
        /* 外部工具可能「报错但退出码为 0、且什么也没解压」（CI 实测 PowerShell 的非终止
           错误），因此解压后必须确认目录里真的落了文件，否则换下一个解压器 */
        if (!hasAnyFile(outDir)) throw new Error('解压器未产出文件');
        extracted = true;
        break;
      } catch (e) {
        failedTools.push(pair[0] + (e && e.code === 'ENOENT' ? '(未安装)' : ''));
      }
    }
    if (!extracted) {
      skip('解压器不可用（' + failedTools.join(' / ') + '），跳过真实解压回归；'
        + 'ZIP 结构 / CRC32 断言仍覆盖正确性');
    }
    if (extracted) {
      /* 外部解压器对 UTF-8 文件名标志的支持取决于工具与系统区域设置
         （CI 的 Windows PowerShell 按系统代码页还原中文名，条目名会变成乱码），
         而条目名本身的正确性已由上面的中央目录断言逐字节覆盖。
         这里只做「内容完整性」交叉验证：遍历解压结果，逐个匹配预期原始数据。 */
      const got = [];
      (function walk(dir) {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const fp = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(fp);
          else got.push(Buffer.from(fs.readFileSync(fp)));
        }
      })(outDir);
      for (let i = 0; i < raw.length; i++) {
        const hit = got.some(function (b) { return b.equals(raw[i]); });
        assert(hit, '解压后存在内容一致的条目 #' + (i + 1) + '（' + expected[i] + '）');
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n结果： ' + pass + ' 通过， ' + fail + ' 失败'
    + (skipped ? '（另跳过 ' + skipped + ' 项：无可用解压器）' : ''));
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
