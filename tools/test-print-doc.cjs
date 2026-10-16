/* ============================================================
 * test-print-doc.cjs — 打印文档构造单元测试（纯 Node，无 GUI）
 * 验证 buildPrintDoc 多页合并与分页 CSS：
 *   1) 多张图片合并为一份文档（单任务打印，驱动只弹一次确认框）
 *   2) 命名纸张 @page 精确尺寸；横向宽高对调
 *   3) 自定义纸张（微米）换算为毫米
 *   4) 每页 page-break-after:always，末页 auto（无尾部空白页）
 *   5) 无效 dataURL 被过滤；全无效时 pageCount = 0
 *   6) 未知纸张退化为宽度 100% 限高分页
 * 运行：node tools/test-print-doc.cjs
 * ============================================================ */
'use strict';

const assert = require('assert');
const { buildPrintDoc, resolvePageMm } = require('../electron/print-doc');

const IMG = (n) => 'data:image/png;base64,IMG' + n;

/* 1. 多张合并为一份文档 */
let d = buildPrintDoc([IMG(1), IMG(2), IMG(3)], 'A4', false);
assert.strictEqual(d.pageCount, 3, '三张图片合并为一份文档');
assert.strictEqual((d.html.match(/<img /g) || []).length, 3, '包含 3 个 img');
assert.ok(d.cssPageSized, '已知纸张使用 @page 精确尺寸');
assert.ok(d.html.indexOf('page-break-after:always') !== -1, '页间分页符存在');
assert.ok(d.html.indexOf('img:last-child{page-break-after:auto}') !== -1, '末页不分页（无尾部空白页）');

/* 2. A4 竖向 @page 尺寸 */
d = buildPrintDoc([IMG(1)], 'A4', false);
assert.ok(d.html.indexOf('@page{size:210mm 297mm;margin:0}') !== -1, 'A4 竖向 @page 210×297mm');
assert.ok(d.html.indexOf('width:210mm;height:297mm;object-fit:contain') !== -1, 'img 恰好一页且不拉伸');

/* 3. A4 横向宽高对调 */
d = buildPrintDoc([IMG(1)], 'A4', true);
assert.ok(d.html.indexOf('@page{size:297mm 210mm;margin:0}') !== -1, 'A4 横向 @page 297×210mm');

/* 4. 自定义纸张微米 → 毫米（4x6 相纸） */
d = buildPrintDoc([IMG(1)], { width: 101600, height: 152400 }, false);
assert.ok(d.html.indexOf('@page{size:101.6mm 152.4mm;margin:0}') !== -1, '4x6 微米换算 101.6×152.4mm');

/* 5. 无效 dataURL 过滤 + 全无效 pageCount=0 */
d = buildPrintDoc(['javascript:alert(1)', 'data:text/html,x', IMG(9)], 'A4', false);
assert.strictEqual(d.pageCount, 1, '仅有效图片 dataURL 保留');
d = buildPrintDoc([undefined, null, ''], 'A4', false);
assert.strictEqual(d.pageCount, 0, '全无效时 pageCount 为 0');

/* 6. 未知纸张退化为限高分页 */
d = buildPrintDoc([IMG(1), IMG(2)], undefined, false);
assert.ok(!d.cssPageSized, '未知纸张不使用 @page 尺寸');
assert.ok(d.html.indexOf('width:100%;height:auto;max-height:100vh') !== -1, '退化为宽度 100% 限高');
assert.ok(d.html.indexOf('page-break-after:always') !== -1, '仍按图分页');

/* 7. resolvePageMm 直接验证 */
assert.deepStrictEqual(resolvePageMm('A4'), { w: 210, h: 297 }, 'resolvePageMm A4');
assert.deepStrictEqual(resolvePageMm('Letter'), { w: 215.9, h: 279.4 }, 'resolvePageMm Letter');
assert.deepStrictEqual(resolvePageMm({ width: 182000, height: 257000 }), { w: 182, h: 257 }, 'resolvePageMm B5 微米');
assert.strictEqual(resolvePageMm(undefined), null, 'resolvePageMm 未知返回 null');

/* 8. 兼容旧单张 dataUrl（非数组入参） */
d = buildPrintDoc(IMG(1), 'A4', false);
assert.strictEqual(d.pageCount, 1, '旧单张调用兼容');


/* 7. 属性注入转义：dataURL 中的引号/尖括号必须被转义，不可逃逸 img 属性 */
{
  const evil = 'data:image/png" onerror="alert(1)<script>';
  const t = buildPrintDoc([evil], null, false);
  assert.ok(t.pageCount === 1, '前缀校验仍放行（转义交由 escapeAttr）');
  assert.ok(t.html.indexOf('" onerror=') === -1, '原始引号不得出现在 src 属性中');
  assert.ok(t.html.indexOf('&quot;') !== -1, '引号已转义为 &quot;');
  assert.ok(t.html.indexOf('<script>') === -1, '尖括号已转义');
}

console.log('结果: 20 通过, 0 失败');
process.exit(0);
