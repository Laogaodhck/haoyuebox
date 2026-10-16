/* ============================================================
 * pdf-adapter.mjs — pdf.js 6.x ESM 适配器
 * pdfjs-dist 自 v4 起仅提供 ESM 构建（无 UMD 版 pdf.min.js）。
 * 本适配器以模块方式加载并把 API 挂到 window.pdfjsLib，
 * 供 print-batch.js 等经典脚本沿用既有调用方式。
 * 注意：模块脚本延迟于文档解析后执行，故 pdf.js 的 worker 配置
 * 必须在此完成（经典脚本的 init 阶段 window.pdfjsLib 尚不存在）。
 * ============================================================ */
import * as pdfjsLib from './pdf.min.mjs';

window.pdfjsLib = pdfjsLib;

/* worker 指向本地（CSP 同源）；v6 以 {type:"module"} 创建 worker */
if (pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/print/pdf.worker.min.mjs';
}
