/* ============================================================
 * test-pdfcore.cjs — 文档工具共享 PDF 核心单元测试
 * 页码范围解析：单页/区间/开口区间/中英文分隔/越界钳制/去重升序/非法忽略
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

global.window = { App: { ui: { $: () => null, toast: () => {} } } };
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'pdfcore.js'), 'utf8'));
const P = global.window.App.pdfcore;

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- parsePageRanges ---------- */
assert(eq(P.parsePageRanges('3', 10), [3]), '单页');
assert(eq(P.parsePageRanges('1-3', 10), [1, 2, 3]), '闭区间');
assert(eq(P.parsePageRanges('8-', 10), [8, 9, 10]), '开口区间补齐到 max');
assert(eq(P.parsePageRanges('-4', 10), [1, 2, 3, 4]), '省略起点从 1 开始');
assert(eq(P.parsePageRanges('1-3,5,7', 10), [1, 2, 3, 5, 7]), '逗号混合列表');
assert(eq(P.parsePageRanges('1-3，5；7  9', 10), [1, 2, 3, 5, 7, 9]), '中英文分隔符与空白');
assert(eq(P.parsePageRanges('3,1,2,3', 10), [1, 2, 3]), '去重并升序');
assert(eq(P.parsePageRanges('9-12', 10), [9, 10]), '越界钳到 max');
assert(eq(P.parsePageRanges('0-2', 10), [1, 2]), '下界钳到 1');
assert(eq(P.parsePageRanges('5-3', 10), []), '倒序区间忽略');
assert(eq(P.parsePageRanges('abc,--,3x', 10), []), '非法段全部忽略');
assert(eq(P.parsePageRanges('', 10), []), '空字符串');
assert(eq(P.parsePageRanges('1-3', 0), []), 'max 为 0 → 空');
assert(eq(P.parsePageRanges('1~3, 4–5', 10), [1, 2, 3, 4, 5]), '~ 与 – 分隔符');
assert(eq(P.parsePageRanges('2--3', 10), []), '双连字符段忽略');

/* ---------- 导出面 ---------- */
assert(typeof P.loadPdf === 'function' && typeof P.renderPage === 'function', '渲染接口导出');
assert(typeof P.encodeCanvas === 'function' && typeof P.writeBytes === 'function', '编码/写入接口导出');
assert(typeof P.ensureSubDir === 'function' && typeof P.pickOutputDir === 'function', 'FSA 接口导出');

/* ---------- IO 层真实行为（fs 支持的假 FSA 句柄，QA-A4） ----------
 * 原导出面断言只验「函数存在」；此处用 os.tmpdir() 真实落盘验证行为：
 * 字节一致性、Blob 入参、子目录创建/幂等、防静默覆盖的序号递增。 */
function fakeDir(dir, name) {
  return {
    name: name || path.basename(dir),
    getFileHandle: async function (n, opts) {
      const p = path.join(dir, n);
      if (opts && opts.create === false && !fs.existsSync(p)) {
        const err = new Error('The file was not found'); err.name = 'NotFoundError'; throw err;
      }
      return {
        createWritable: async function () {
          const chunks = [];
          return {
            write: async function (d) {
              if (d && typeof d.arrayBuffer === 'function') chunks.push(Buffer.from(await d.arrayBuffer()));
              else if (Buffer.isBuffer(d)) chunks.push(d);
              else chunks.push(Buffer.from(d && d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d));
            },
            close: async function () { fs.writeFileSync(p, Buffer.concat(chunks)); }
          };
        }
      };
    },
    getDirectoryHandle: async function (n, opts) {
      const p = path.join(dir, n);
      if (opts && opts.create) fs.mkdirSync(p, { recursive: true });
      return fakeDir(p, n);
    }
  };
}

(async function () {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haoyue-pdfcore-'));
  try {
    const dir = fakeDir(tmp);
    await P.writeBytes(dir, 'a.bin', new Uint8Array([1, 2, 3]));
    assert(fs.existsSync(path.join(tmp, 'a.bin')) &&
      Buffer.from(fs.readFileSync(path.join(tmp, 'a.bin'))).equals(Buffer.from([1, 2, 3])),
      'writeBytes 真实落盘且字节一致（Uint8Array）');

    await P.writeBytes(dir, 'b.bin', new Blob([new Uint8Array([9, 8, 7])]));
    assert(Buffer.from(fs.readFileSync(path.join(tmp, 'b.bin'))).equals(Buffer.from([9, 8, 7])),
      'writeBytes 接受 Blob 入参');

    const sub = await P.ensureSubDir(dir, '转换输出');
    assert(sub && sub.name === '转换输出' && fs.statSync(path.join(tmp, '转换输出')).isDirectory(),
      'ensureSubDir 创建子目录并返回同名句柄');
    const sub2 = await P.ensureSubDir(dir, '转换输出');
    assert(sub2 && sub2.name === '转换输出', 'ensureSubDir 重复调用幂等（create:true）');

    assert(await P.uniqueOutName(dir, 'x.pdf') === 'x.pdf', 'uniqueOutName 无同名返回原名');
    await P.writeBytes(dir, 'x.pdf', new Uint8Array([0]));
    assert(await P.uniqueOutName(dir, 'x.pdf') === 'x_1.pdf', 'uniqueOutName 同名追加 _1 后缀');
    await P.writeBytes(dir, 'x_1.pdf', new Uint8Array([0]));
    assert(await P.uniqueOutName(dir, 'x.pdf') === 'x_2.pdf', 'uniqueOutName 序号递增不覆盖');
    assert(await P.uniqueOutName(dir, 'noext') === 'noext', 'uniqueOutName 无扩展名走 base 分支');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(fail ? `\n结果: ${pass} 通过, ${fail} 失败` : `\n结果: ${pass} 通过, 0 失败`);
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error('IO 测试异常:', e); process.exit(1); });
