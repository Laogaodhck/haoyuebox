# 第三方库版本登记（vendor/）

本目录收录的第三方库均以**本地文件**形式分发，保证断网可用。升级任何库时，请更新本表。

| 库 | 版本 | 本地文件 | 来源 | 许可 | 更新日期 |
|---|---|---|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js)（pdfjs-dist） | 6.4.299 | `vendor/print/pdf.min.mjs`、`pdf.worker.min.mjs`、`pdf-adapter.mjs`（ESM 适配器） | https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz | Apache-2.0 | 2026-10-17 |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | 1.13.0 | `vendor/print/mammoth.browser.min.js` | https://registry.npmjs.org/mammoth/-/mammoth-1.13.0.tgz | BSD-2-Clause | 2026-10-17 |
| [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) | 1.1.1 | `vendor/mediapipe/vision_bundle.js`、`wasm/`（6 个文件）、`models/*.tflite`（模型资产不变） | https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-1.1.1.tgz | Apache-2.0 | 2026-10-17 |
| [tesseract.js](https://github.com/naptha/tesseract.js) | 5.1.1 | `vendor/ocr/tesseract.min.js`、`worker.min.js` | https://registry.npmjs.org/tesseract.js/-/tesseract.js-5.1.1.tgz | Apache-2.0 | 2026-10-19 |
| [tesseract.js-core](https://github.com/naptha/tesseract.js-core) | 5.1.1 | `vendor/ocr/tesseract-core-{simd-,}lstm.wasm(.js)`（LSTM 内核 + wasm sidecar） | https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-5.1.1.tgz | Apache-2.0 | 2026-10-19 |
| [@tesseract.js-data/chi_sim](https://github.com/naptha/tesseract.js-data) | 1.0.0（4.0.0_best_int） | `vendor/ocr/lang/chi_sim.traineddata.gz` | https://registry.npmjs.org/@tesseract.js-data/chi_sim/-/chi_sim-1.0.0.tgz | Apache-2.0 | 2026-10-19 |
| [@tesseract.js-data/eng](https://github.com/naptha/tesseract.js-data) | 1.0.0（4.0.0_best_int） | `vendor/ocr/lang/eng.traineddata.gz` | https://registry.npmjs.org/@tesseract.js-data/eng/-/eng-1.0.0.tgz | Apache-2.0 | 2026-10-19 |

## 升级注意事项

### pdf.js（3.32.2 → 6.4.299）

- v4 起官方**仅提供 ESM 构建**（无 UMD 版 `pdf.min.js`），故 `index.html` 改为加载
  `pdf-adapter.mjs`（模块脚本），由它把 API 挂到 `window.pdfjsLib` 供既有代码调用；
- worker 改为 `pdf.worker.min.mjs`，pdf.js 内部以 `{type: "module"}` 创建 worker，
  `js/print-batch.js` 中的 `GlobalWorkerOptions.workerSrc` 需指向 `.mjs` 文件；
- **迁移踩坑（已在代码中修复，升级时勿回退）**：
  1. 模块脚本延迟执行——经典脚本的 `init()` 阶段 `window.pdfjsLib` 尚不存在，
     worker 配置必须放在 `pdf-adapter.mjs` 内完成（并在 `renderPdf` 做懒加载兜底）；
  2. `getDocument({ data })` 的 `data` **只接受 TypedArray**（内部直接 `r.buffer`
     转移给 worker），传 ArrayBuffer 会静默失败——IPC 读文件返回的是 ArrayBuffer，
     需经 `toPdfData()` 归一化；
  3. `PDFDocumentProxy.destroy()` 已移除，改用 `cleanup()`（`destroy()` 现仅属于
     loading task）；
- **未打包** `cmaps/`、`standard_fonts/`、`wasm/`、`image_decoders/`（与升级前一致）：
  依赖内嵌字体子集化的 PDF 可正常渲染；依赖系统 CJK 字体回退的 PDF 文字可能显示异常，
  如需支持须另行打包上述目录并在 `getDocument` 配置 `cMapUrl` / `standardFontDataUrl`。

### MediaPipe Tasks Vision（0.10.x → 1.1.1）

- 官方包不再提供 `vision_bundle.iife.js`，但 `vision_bundle.js` 即等价 IIFE 构建，
  全局名由 `window.__mpVision` 改为 `window.Vision`（`js/segmenter.js` 的 `vision()`
  已做双名兼容）；
- `wasm/` 目录文件构成有变化（新增 `vision_wasm_module_internal.*`），升级须整目录替换；
- `FilesetResolver.forVisionTasks` / `ImageSegmenter.createFromOptions` /
  `confidenceMasks` / `MPMask.getAsFloat32Array()` 等 API 经 1.1.1 类型定义核实保持不变。

### mammoth（→ 1.13.0）

- UMD 构建，仍挂 `window.mammoth`，`convertToHtml({ arrayBuffer })` API 不变，直接替换文件即可。

### tesseract.js（5.1.1，新增）

- 主线程构建 `tesseract.min.js` 为 UMD（挂 `window.Tesseract`），`worker.min.js` 由主线程
  以 blob: 包装 `importScripts` 加载——**三个路径（workerPath / corePath / langPath）必须传
  绝对 URL**，blob: Worker 内无法解析相对路径（`js/docs-ocr.js` 的 `absUrl()` 已处理）；
- `corePath` 指向目录时按 CPU SIMD 支持自适应加载 `tesseract-core-simd-lstm` 或
  `tesseract-core-lstm`（OEM 1 = LSTM_ONLY），**`.wasm` 文件是对应 `.wasm.js`（emscripten
  glue）的 sidecar，升级必须成对拷贝**；
- 语言包来自 `@tesseract.js-data/*`，仅有 `4.0.0_best_int` 精度档目录（无 fast_int），
  gzip 包随 `langPath` 目录分发；`createWorker(langs, 1, opts)` 的 `logger` 仅在主线程回调。

## 验证入口

- `npm test`：test-dom 校验脚本引入与页面结构；test-server 校验静态服务可正常分发上述文件；
- `npm run verify`（真机 Chromium）：verify-hair 覆盖 MediaPipe 分割全链路，
  verify-print-batch 覆盖 pdf.js 渲染与 mammoth 文档解析。
