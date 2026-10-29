# 浩玥工具箱

> 老高 · QQ 846193 · MIT

**纯本地离线**的桌面工具箱：证件照制作、排版打印、批量图片处理、文档处理（OCR / 格式转换 / PDF / 水印）与压缩解压。
人像分割、OCR、PDF 渲染与压缩全部在本机完成（Canvas + MediaPipe WASM + Tesseract + pdf.js + 内置 7z），
不调用任何后端服务或外部 API——照片与文档不出本机，断网可用。

## 功能

| 模块 | 能力 |
| --- | --- |
| **照片工具** | 证照生成：AI 抠图换底、笔刷修补、8 种证件规格、300DPI 导出与六寸排版 · 图片转换（JPG/PNG/WebP）· 图片压缩 · 图片合成（拼接 / 网格） |
| **排版工具** | 4 步批量排版打印：模板 → 导入 → 预览 → 打印；6 寸 / A4 / B5 / A5 / A3 相纸，间距与裁切线可调 |
| **批量工具** | 批量重命名（规则编号 + 自定义名、冲突检测）· 去除水印 · 格式转换 · 体积优化 · 批量打印（图片） |
| **文档工具** | 文档打印（PDF/TXT/DOCX，单双面）· 文档转换（PDF↔图片、Word→PDF）· PDF 工具（合并 / 拆分 / 压缩）· PDF 阅读器 · OCR 文字识别 · 文档加水印 |
| **压缩工具** | 7z / ZIP 压缩（密码、加密文件名、四档等级、分卷）· 16 种格式解压 · 压缩包内容浏览 · 压缩包图标关联 |
| **系统工具** | 网络检测 · 添加打印机（向导 / 测试页）· 设置（主题、启动页、备份恢复、诊断日志导出） |

已具备的横向能力：

- **长任务可取消**：OCR、文档加水印、文档转换、PDF 工具运行中可随时取消；已完成的文件与页面保留，运行期参数控件自动锁定，避免中途改设置导致结果不一致。
- **文档五页统一拖放**：OCR / 加水印 / 转换 / PDF 工具 / 阅读器均可把文件拖到页面任意位置导入，统一虚线高亮与类型过滤提示。
- **诊断日志导出**：系统工具 → 设置 → 数据，把最近 10 份运行日志合并导出为 TXT（纯文本、不含照片或文件内容）。

开发中（首页标注「敬请期待」）：老照片修复、软件卸载、垃圾清理。

## 使用

### 桌面版（推荐）

从 [Releases](https://github.com/Laogaodhck/haoyuebox/releases) 下载安装：

- `haoyue-idphoto-Setup-<版本>.exe`：NSIS 安装版，可选安装目录、创建桌面快捷方式
- `haoyue-idphoto-<版本>-portable.exe`：免安装单文件便携版

**应用内更新**：设置 → 关于 → 「检查更新」，手动触发（联网仅发生在点击后）。安装版可检查 → 下载（进度条）→ 安装并重启；
便携版与浏览器版降级为「打开发布页」手动下载。安装包未签名，Windows SmartScreen 提示时选「更多信息 → 仍要运行」。

**数据与升级**：用户设置存于 `%APPDATA%/浩玥工具箱`，与程序目录隔离，升级与卸载均不清除（`deleteAppDataOnUninstall: false`）；
升级 / 回滚启动时自动备份设置，丢失时可弹窗恢复；覆盖安装前安装器会静默结束残留旧进程。

### 浏览器版

```bash
start.bat          # 或 npm run serve（需本机 Node.js）
```

浏览器打开 `http://localhost:8410/`，同一局域网内手机也可访问。

浏览器版无打印、7z 压缩解压与系统工具（依赖主进程 IPC），对应面板会提示改用桌面版；
直接双击 `index.html`（file:// 协议）无法加载本地 WASM 模型。

## 开发

```bash
npm install
npm start        # 启动 Electron 窗口（内置随机端口静态服务）
npm run dist     # 打包 Windows 安装版 + 便携版 → release-build/
npm test         # 28 套件：纯算法 / 静态服务 / jsdom 冒烟（无需浏览器）
npm run verify   # Playwright 端到端（需 Chromium；部分项需 fixtures/photo.jpg）
npm run lint     # ESLint
npm run eval:ocr # OCR 精度评测（8 类场景 CER / 命中率 / 耗时）
```

需要 Node.js 22（CI 版本）。`npm run verify` 的本地资源均不入库：

- Chromium：`npx playwright install chromium`，或用 `HAOYUE_CHROMIUM=<chrome.exe>` 指定本机浏览器
- 测试照片：`fixtures/photo.jpg` 或 `HAOYUE_PHOTO=<路径>`（仓库不收录真人照片）

### 发布流程

1. 递增 `package.json` 的 `version`，在 `CHANGELOG.md` 记录变更
2. `git tag v<version> && git push origin v<version>`
3. GitHub Actions 自动：测试门禁 → OCR 主链路冒烟 → 打包 → 打包产物 E2E → 上传 Release（含 `latest.yml` 与 blockmap）

CI（`.github/workflows/ci.yml`）在 push / PR 时跑语法扫描与 `npm test`；依赖由 Dependabot 每周巡检。

## 目录结构

```
├── index.html            # 单页入口（七模块 + 子功能菜单）
├── js/                   # 渲染层（IIFE 模块挂 window.App）
│   ├── app.js            # 核心状态机、模块路由、取消令牌、拖放助手
│   ├── segmenter.js      # 人像分割与蒙版增强
│   ├── docs-*.js         # 文档工具：打印 / 转换 / PDF / 阅读器 / 水印 / OCR
│   ├── ocr-enhance.js    # OCR 图像增强与版面还原
│   └── ...               # 排版、批量、压缩、设置等
├── electron/             # 主进程：窗口、静态服务、打印 / 7z / 系统工具 / 备份 / 更新 IPC
├── vendor/               # 离线运行时：MediaPipe、pdf.js、mammoth、Tesseract 与语言包
├── assets/               # 图标、NSIS 安装器钩子
├── tools/                # 测试与验收脚本（test-* / verify-* / eval-*）
└── docs/                 # OCR 增强与精度、安全兼容性等技术文档
```

## 技术要点

- **人像分割**：MediaPipe 六分类模型 + 分块精修、导向滤波、滞后阈值、发丝混色净化与间隙透底，
  导出写入真实 300DPI 元数据（PNG pHYs / JPEG JFIF）。详见 `js/segmenter.js`。
- **OCR**：Tesseract LSTM 离线引擎，先原图直识、按质量信号启用放大 / 增强 / 二值化 / 备用分页模式；
  词级 bbox 重建段落与表格，导出 DOCX（真表格 + 缩进）与 Excel（每表一个工作表）。
  详见 [docs/ocr-enhancement.md](docs/ocr-enhancement.md) 与 [docs/ocr-accuracy-optimization.md](docs/ocr-accuracy-optimization.md)。
- **安全边界**：`contextIsolation` + `sandbox` + CSP；`preload.js` 仅暴露白名单 IPC，渲染层无 Node 能力；
  7z 经 `spawn` 数组传参不经 shell，用户输入无注入风险；压缩包图标仅接管无关联的 .7z / .zip。

## 许可与致谢

本工具源码以 **MIT** 许可发布。第三方组件（版本登记见 [VENDOR.md](VENDOR.md)）：

- 人像分割：[Google MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter)（Apache-2.0）
- 压缩：[7-Zip](https://www.7-zip.org/)（LGPL，含 BSD 组件）
- 文档渲染：[pdf.js](https://mozilla.github.io/pdf.js/)（Apache-2.0）、[mammoth.js](https://github.com/mwilliamson/mammoth.js)（BSD-2-Clause）
- OCR：[tesseract.js](https://github.com/naptha/tesseract.js)（Apache-2.0）与 Tesseract 语言包

以上运行时均本地化至 `vendor/` / `electron/bin/` 以满足离线使用，著作权归各自作者所有。

## 注意

- 人像分割请使用单人正面照，光线均匀、背景区分度高效果最好；多人物场景按整体人像区域处理。
- 排版模块不做抠图，导入照片按原样 cover 裁切；需要换底请先在照片工具完成。
- OCR 对手写体、艺术字与极低分辨率（短边 < 300px）效果有限；表格按对齐网格推定，无框线且列间留白极小的排版可能被判为段落。
- 导出的 Excel 为纯数据网格，不还原框线样式、合并单元格与公式。

版本变更见 [CHANGELOG.md](CHANGELOG.md)；软件声明：本软件免费使用，仅供学习用途，请勿用于非法用途。
