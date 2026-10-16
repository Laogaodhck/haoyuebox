# 第三方库版本登记（vendor/）

本目录收录的第三方库均以**本地文件**形式分发，保证断网可用。升级任何库时，请更新本表。

| 库 | 版本 | 本地文件 | 来源 | 许可 | 更新日期 |
|---|---|---|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js)（pdfjs-dist） | 6.4.299 | `vendor/print/pdf.min.mjs`、`pdf.worker.min.mjs`、`pdf-adapter.mjs`（ESM 适配器） | https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz | Apache-2.0 | 2026-10-17 |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | 1.13.0 | `vendor/print/mammoth.browser.min.js` | https://registry.npmjs.org/mammoth/-/mammoth-1.13.0.tgz | BSD-2-Clause | 2026-10-17 |
| [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) | 1.1.1 | `vendor/mediapipe/vision_bundle.js`、`wasm/`（6 个文件）、`models/*.tflite`（模型资产不变） | https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-1.1.1.tgz | Apache-2.0 | 2026-10-17 |

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

## 验证入口

- `npm test`：test-dom 校验脚本引入与页面结构；test-server 校验静态服务可正常分发上述文件；
- `npm run verify`（真机 Chromium）：verify-hair 覆盖 MediaPipe 分割全链路，
  verify-print-batch 覆盖 pdf.js 渲染与 mammoth 文档解析。
