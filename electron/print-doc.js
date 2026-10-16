/* ============================================================
 * print-doc.js — 打印文档构造（纯函数，供主进程与单测使用）
 * 将一至多张图片 dataURL 组装为一份多页打印文档：
 *   - 已知纸张毫米尺寸（含横/竖方向换算）→ @page 精确分页，
 *     每图恰好占一页（object-fit:contain 不拉伸），无亚像素溢出空白页；
 *   - 未知尺寸 → 退化为宽度 100% + max-height 限高，仍按图分页。
 * 多页合并在一次 print() 里发送：逐页各发任务会让打印机驱动
 * 每个任务弹一次确认框（多页照片 = 弹 N 个确认框）。
 * ============================================================ */
'use strict';

/* 常见命名纸张（mm，竖向宽×高），与渲染层 PRINT_PAPERS 保持一致 */
const NAMED_PAPER_MM = {
  A4: [210, 297],
  A5: [148, 210],
  A3: [297, 420],
  Letter: [215.9, 279.4]
};

/* 从 Electron pageSize 参数解析纸张毫米尺寸（竖向），无法识别返回 null */
function resolvePageMm(pageSize) {
  if (typeof pageSize === 'string' && NAMED_PAPER_MM[pageSize]) {
    return { w: NAMED_PAPER_MM[pageSize][0], h: NAMED_PAPER_MM[pageSize][1] };
  }
  if (pageSize && typeof pageSize === 'object' && pageSize.width > 0 && pageSize.height > 0) {
    return { w: pageSize.width / 1000, h: pageSize.height / 1000 };  // 微米 → 毫米
  }
  return null;
}

function num(n) {  // 去掉多余小数位（101.6mm 而非 101.60000000000001mm）
  return Math.round(n * 100) / 100;
}

/* HTML 属性转义：dataURL 只做前缀校验不足以安全内插（" 可逃逸属性），
 * 统一转义后拼入 img src */
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 构造整份打印 HTML。
 * @param {string[]} dataUrls 图片 dataURL 数组（无效项自动过滤）
 * @param {*} pageSize  Electron pageSize（'A4' 或 {width,height} 微米），可空
 * @param {boolean} landscape 是否横向（横向时 CSS 页面宽高对调）
 * @returns {{ html: string, pageCount: number, cssPageSized: boolean }}
 */
function buildPrintDoc(dataUrls, pageSize, landscape) {
  const urls = (Array.isArray(dataUrls) ? dataUrls : [dataUrls]).filter(
    (u) => typeof u === 'string' && u.indexOf('data:image/') === 0
  );

  let mm = resolvePageMm(pageSize);
  if (mm && landscape) mm = { w: mm.h, h: mm.w };  // 横向：CSS 页面宽高对调

  const css = mm
    ? '@page{size:' + num(mm.w) + 'mm ' + num(mm.h) + 'mm;margin:0}'
      + 'img{display:block;width:' + num(mm.w) + 'mm;height:' + num(mm.h) + 'mm;'
      + 'object-fit:contain;page-break-after:always}'
      + 'img:last-child{page-break-after:auto}'
    : '@page{margin:0}'
      + 'img{display:block;width:100%;height:auto;max-height:100vh;page-break-after:always}'
      + 'img:last-child{page-break-after:auto}';

  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
    + 'html,body{margin:0;padding:0;background:#fff}' + css
    + '</style></head><body>'
    + urls.map((u) => '<img src="' + escapeAttr(u) + '">').join('')
    + '</body></html>';

  return { html: html, pageCount: urls.length, cssPageSized: !!mm };
}

module.exports = { buildPrintDoc, resolvePageMm, NAMED_PAPER_MM };
