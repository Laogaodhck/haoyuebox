# 浩玥工具箱（haoyue-idphoto v1.7.2）架构与核心逻辑分析

> 分析日期：2026-11-06（代码基线 v1.7.1）；2026-11-14 增补：1.7.2 的 OCR 编排 / 增强 / 版面改动与随包 RapidOCR 引擎（详见文末「九、1.7.2 起的 OCR 演进」）。除文末增补外，正文中的行号与文件规模仍以 1.7.1 快照为准，定位请优先用函数名检索。
> 分析方式：只读阅读源码、测试脚本与发布配置，未修改业务代码、未提交 Git。
> 引用约定：`文件路径:行号` 均为当前基线下的实际位置；带「推断」的结论是从代码结构推导、未经运行验证。
> 读者定位：已熟悉本项目或即将接手维护的人，重点解释「为什么这样设计」，而非文件清单。

---

## 0. 一页结论

1. **这是一个没有构建步骤的 Electron 单页应用**：`index.html`（1.7.1 快照 1937 行 / 106 KB，1.7.2 约 1800 行 / 108 KB）直接以 `<script src>` 顺序加载 IIFE 业务模块（1.7.1 为 29 个，1.7.2 增至 30 个，另有 3 个 vendor 脚本），业务模块全部挂到 `window.App` 命名空间；`vendor/` 预置模型与 wasm，`js/` 源码即产物。设计目标是「纯本地离线、可断网、可人工排查」，代价是没有模块边界与类型约束。
2. **安全模型是三层收口**：渲染进程 `sandbox + contextIsolation + nodeIntegration=false`，preload 只暴露 8 组白名单桥（1.7.2 起含 OCR：`haoyueOcr`），主进程对文件路径做「会话级白名单 + 扩展名 + 200 MB 上限」，系统命令一律走 `System32` 绝对路径。见 [electron/main.js](electron/main.js) L259-L314、L377-L387。
3. **图片主链路全部在渲染层的 Canvas 2D 上完成**：MediaPipe 人像分割（1600px 工作画布 + 512px 瓦片精修 + guided filter 等后处理）→ 蒙版编辑 → 换底合成 → 规格裁剪 → 300 DPI 注入 → 排版。主进程只负责打印、压缩、文件读取与更新。
4. **打印走「隐藏窗口 + 内存路由」**：多页 dataURL 先由主进程拼成 HTML，存进 `printPages` Map，隐藏 `BrowserWindow` 经本地静态服务加载 `http://127.0.0.1:<port>/__print__/<uuid>`，再一次 `webContents.print()` 发出。这是为绕开 `data:` URL 2MB 上限、以及「逐页发任务导致驱动多次弹窗」的工程折中（[electron/main.js](electron/main.js) L38-L41、L203-L252）。
5. **测试体系是自研的 Node 脚本矩阵**：`npm test` 顺序跑 `check-refs.cjs` 与 `test-*.cjs`（1.7.1 为 27 个，1.7.2 增至 30 个，含 OCR 引擎安装与识别测试），`npm run verify` 跑 11 个真实浏览器/打包产物端到端脚本；CI 在 Ubuntu + Windows 双跑静态检查与单测，Release 在 tag push 时加 OCR 真链路与打包 E2E 门禁后发 GitHub Release。

---

## 1. 总体分层与进程架构

### 1.1 进程与资源拓扑

```
┌──────────────────────────────────────────────────────────────────────┐
│ Electron 主进程 (electron/main.js, 1.7.1 为 422 行 / 1.7.2 为 398 行)     │
│  ├─ 单实例锁 / AUMID=com.haoyue.idphoto                             │
│  ├─ createStaticServer(root, printPages) → 127.0.0.1:<随机端口>      │
│  ├─ BrowserWindow(主窗口, sandbox=true, preload=preload.js)          │
│  ├─ 打印：buildPrintDoc + 隐藏窗口 + webContents.print(silent)       │
│  ├─ IPC 注册：print:* / archive:* / archive-icons:* / system:*       │
│  │            ocr:* / app:* / app-update:*                           │
│  ├─ OCR：ocr-engine.js（按需下载） / rapidocr.js（子进程） / umi-ocr.js（HTTP） │
│  ├─ 诊断日志：userData/logs/app-YYYY-MM-DD.log（保留 10 份）          │
│  └─ 更新：update.js（版本标记/数据备份） + updater.js（electron-updater）│
└───────────────┬──────────────────────────────────────────────────────┘
                │ contextBridge（8 组白名单，无 Node 能力）
┌───────────────▼──────────────────────────────────────────────────────┐
│ preload.js                                                           │
│  haoyuePrint / haoyueArchive / haoyueDiag / haoyueArchiveIcons        │
│  haoyueSystem / haoyueOcr / haoyueApp / haoyueAppUpdate               │
└───────────────┬──────────────────────────────────────────────────────┘
                │ window.postMessage 语义（ipcRenderer.invoke/send）
┌───────────────▼──────────────────────────────────────────────────────┐
│ 渲染进程（http://127.0.0.1:<port>/）                                  │
│  index.html（7 个模块页 + 照片工具 4 步）                              │
│  css/style.css (1.7.1 为 1429 行 / 1.7.2 为 1376 行)                  │
│  js/ 30 个 IIFE 模块，共享 window.App{State,ui,...}                    │
│  vendor/ mediapipe(模型+wasm) / ocr(tesseract) / print(pdf.js,mammoth)│
└──────────────────────────────────────────────────────────────────────┘
```

关键技术事实：

- 主窗口 `webPreferences`：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，preload 路径注入（[electron/main.js](electron/main.js) L352-L358）。
- 导航被锁死：`will-navigate` 只允许 `http://127.0.0.1:<port>`；`setWindowOpenHandler` 一律 `deny`，http(s) 交给系统浏览器（L367-L375）。
- CSP 同时写在 `index.html` meta 和主进程响应头（逐字一致）：`script-src 'self' 'wasm-unsafe-eval'`（MediaPipe WASM 必需）、`style-src 'unsafe-inline'`、`img-src data: blob:`、`worker-src 'self' blob:`（Tesseract 需要 blob Worker），L377-L387。
- 照片/文档处理以 Canvas 2D 为主，应用启动即禁用硬件加速并强制进程内软件合成（L316-L322），用稳定性换性能。
- 静态服务是本应用的地基：`createStaticServer(root, printPages)` 在 `0` 端口（随机）监听回环，主窗口与打印隐藏窗口都走它（[electron/static-server.js](electron/static-server.js)）。因此 `file://` 的 CORS、Worker、WASM 限制全部不存在；同时它自身带四道加固：仅 GET/HEAD、回环 Host 白名单（防 DNS rebinding）、路径归一化 containment（修掉旧版 `startsWith(root)` 的前缀碰撞）、畸形百分号/NUL 直接 400（L2-L12、L34-L60）。

### 1.2 目录职责

| 目录 | 定位 | 事实 |
|---|---|---|
| `electron/` | 主进程与 preload | 1.7.1 为 11 个模块、1.7.2 为 14 个（新增 `rapidocr.js` / `umi-ocr.js` / `ocr-engine.js`）；`main.js` 1.7.1 为 422 行 / 1.7.2 为 398 行，其余按领域拆分（archive / system / print-doc / update / updater / static-server / 7z 引擎 / OCR 引擎与进程） |
| `js/` | 渲染层业务 | 1.7.1 为 29 个 IIFE、1.7.2 为 30 个（新增 `ocr-umi.js`）；最大 `docs-ocr.js`（1.7.2 约 1800 行），其后 `ocr-enhance.js`、`app.js` |
| `index.html` | 单页 UI 与脚本清单 | 1.7.1 为 1937 行 / 106.4 KB、1.7.2 为 1801 行 / 108 KB；7 个模块页（home/photo/sheet/batch/print/archive/system），照片工具内部 4 步（upload/matte/spec/export） |
| `css/style.css` | 全部样式 | 1.7.1 为 1429 行 / 47.3 KB、1.7.2 为 1376 行 / 47 KB，无预处理器 |
| `vendor/` | 第三方离线资产 | `mediapipe/models` 15.9 MB（两个 tflite 分割模型）、`mediapipe/wasm` 38.8 MB、`ocr` 13.2 MB + `ocr/lang` 4.5 MB（Tesseract）、`print` 2 MB（pdf.js / mammoth）；入口 `vendor/mediapipe/vision_bundle.js` |
| `assets/` | 品牌与安装资源 | 应用/安装器/压缩包图标、`installer.nsh`；`src-*` 为设计源图 |
| `tools/` | 测试、校验、开发服务器 | 1.7.2 为 29 个 `test-*.cjs`、11 个 `verify-*.cjs`、`_lib.cjs`、`server.js`、`make-icons.cjs`、OCR 评测脚本（合成 / 真实两套） |
| `docs/` | 历史报告 | 架构分析、v1.3.3 Bug 报告、OCR 优化 / 评测 / 真实抽检 6 篇、安全软件兼容性 |
| `.github/workflows/` | CI 与发布 | `ci.yml`（双 OS 静态检查+单测）、`release.yml`（tag 打包+门禁+GitHub Release） |

### 1.3 启动时序

1. `migrateLegacyUserData()` 在模块顶层同步执行：若 `%APPDATA%/浩玥工具箱` 不存在而 `%APPDATA%/尊泓工具箱` 存在，则整目录 `cpSync` 复制，旧目录保留（[electron/main.js](electron/main.js) L24-L34）。
2. 注册诊断钩子：`uncaughtException`、`unhandledRejection`、`child-process-gone`、`render-process-gone`、渲染层 `app:logError`（L66-L75）。
3. 注册各领域 IPC（打印 L159、压缩 L274、系统 L276、版本 L278、更新 L280、图标 L287-L289、读文件 L297）。
4. 单实例锁；禁用 GPU；`whenReady` 后先 `updateCtl.scanOnLaunch()`（升级/回滚扫描必须早于窗口创建，L409-L413），再 `createWindow()`。
5. `createWindow` 启动静态服务 → 创建隐藏窗口 → 绑定导航/CSP → `loadURL('http://127.0.0.1:<port>/')`，首次失败 800ms 后重试一次（L336-L400）。
6. 渲染层 `app.js` 的 `boot()`（[js/app.js](js/app.js) L1128）恢复设置、注册模块、绑定拖拽/快捷键、拉取 `app:updateInfo` 等。

设置层与启动扫描是配套的：`js/settings.js` 用 `SCHEMA_VERSION=2` + `MIGRATIONS` 逐级迁移（[js/settings.js](js/settings.js) L21-L44），首次加载会读旧键 `zunhong-toolbox-settings`（L23）；迁移前经 `haoyueApp.backupData` 在主进程原子写备份，失败则保留原始 raw、不写新值——这是「覆盖安装不丢配置、降级不截断字段」的兜底。

### 1.4 为什么这样设计

- **无打包器**：所有依赖以静态文件形式存在，源码可被 `node --check` 与 jsdom 直接加载，测试无需构建链；升级只替换 asar。代价是没有 tree-shaking、模块作用域靠 IIFE 约定。
- **本地 HTTP 而非 `file://`**：WASM（MediaPipe）、blob Worker（Tesseract）、ES module 动态导入（pdf.js）在 `file://` 下都有兼容问题；回环服务让渲染层等价于普通 Web 页面，也让隐藏打印窗口有稳定同源 URL。
- **主进程只做「特权操作」**：文件系统、打印、7z、注册表、更新。图像算法全部留在渲染层，避免 IPC 传输大画布，也避免主进程被 CPU 任务阻塞。
- **单窗口单实例**：应用状态是全局的 `App.State`，多开没有意义，单实例锁直接排除并发写入设置/备份的风险。

---

## 2. IPC 契约与调用链

### 2.1 通道命名规则

统一为 `域:动作`，共 7 个域。域与主进程模块一一对应，便于按文件定位：

| 域 | 归属 | 通道数 | 备注 |
|---|---|---|---|
| `print:` | `main.js` | 4 | 打印机枚举/属性/打印/读文件 |
| `archive:` | `electron/archive.js` | 9 | 7z 引擎、选择、压缩、解压、列表、取消 |
| `archive-icons:` | `main.js` + `archive-icons.js` | 3 | 探测/接管/恢复文件关联 |
| `system:` | `electron/system.js` | 5 | 网络探测、打印机向导/设置/测试页 |
| `app:` | `main.js` + `update.js` | 6 | 日志上报/导出、版本信息、备份读写删 |
| `app-update:` | `electron/updater.js` | 5 | 状态/检查/下载/安装/打开发布页 |
| `ocr:` | `umi-ocr.js` / `rapidocr.js` / `ocr-engine.js` | 7 | Umi 服务探测识别、RapidOCR 状态识别、引擎状态/下载/移除 |

另有 3 个**单向事件**：`archive:progress`（[electron/archive.js](electron/archive.js) L80-L145 内发送）、`app-update:progress`（[electron/updater.js](electron/updater.js) L157-L194）、`ocr-engine:progress`（[electron/ocr-engine.js](electron/ocr-engine.js) 的 `registerIpc`）。它们不经过 `invoke`，也不在契约测试的主断言范围内。

### 2.2 preload 暴露面（8 组）

[electron/preload.js](electron/preload.js) 全文 1.7.1 为 103 行、1.7.2 为 119 行，暴露面如下：

| 桥 | 行（1.7.2） | 方法 |
|---|---|---|
| `haoyuePrint` | L16-L24 | `isDesktop`、`listPrinters`、`showPrinterProperties`、`printImage`、`pickPaths`、`readFile` |
| `haoyueArchive` | L27-L55 | `check7z`、`pickPaths`、`pathForFile`（`webUtils.getPathForFile`）、`statPaths`、`saveDialog`、`desktopPath`、`compress`、`extract`、`list`、`cancel`、`onProgress` |
| `haoyueDiag` | L58-L61 | `logError`（`ipcRenderer.send`） |
| `haoyueArchiveIcons` | L64-L69 | `probe`、`apply`、`restore` |
| `haoyueSystem` | L72-L82 | `netInfo`、`netProbe`、`openAddPrinter`、`openPrintSettings`、`printTestPage` |
| `haoyueOcr` | L85-L104 | `probe` / `recognize`（本机 Umi-OCR HTTP 服务）、`rapidStatus` / `rapidRecognize`（RapidOCR 子进程）、`engineStatus` / `engineInstall` / `engineRemove` / `onEngineProgress`（引擎按需下载） |
| `haoyueApp` | L108-L115 | `updateInfo`、`backupData`、`readBackup`、`deleteBackup`、`exportLogs` |
| `haoyueAppUpdate` | L121-L140 | `status`、`check`、`download`、`install`、`openReleases`、`onProgress` |

两个细节值得记住：

- `haoyueArchive.onProgress` 的监听器**全局只绑一次**，后续调用只替换回调；否则 `onProgress(null)` 再注册会重复绑定，进度事件双触发（L43-L52 注释即原因）。
- 文件拖拽路径通过 `webUtils.getPathForFile(file)` 取得；渲染层拿到的 `File` 本身没有真实路径（沙箱 + contextIsolation 的必然结果）。

### 2.3 主进程注册分布

没有统一的 `ipc/index.js`，而是**按模块各自注册**：

| 模块 | 入口 | 注册行 |
|---|---|---|
| 打印 | `registerPrintIpc()` | [main.js](electron/main.js) L159-L253，调用 L254 |
| 压缩/解压 | `registerArchiveIpc(ipcMain, getWin, allowReadPaths)` | [archive.js](electron/archive.js) L277-L293，调用 [main.js](electron/main.js) L274 |
| 系统 | `registerSystemIpc(ipcMain, getWin)` | [system.js](electron/system.js)，调用 [main.js](electron/main.js) L276 |
| 版本/备份 | `update.registerUpdateIpc(...)` | [update.js](electron/update.js) L141-L221，调用 L278 |
| 应用内更新 | `registerAppUpdateIpc(...)` | [updater.js](electron/updater.js) L157-L194，调用 L280 |
| 图标关联 | 内联 `ipcMain.handle` | [main.js](electron/main.js) L287-L289 |
| OCR（本机服务） | `umiOcr.registerOcrIpc(ipcMain)` | [umi-ocr.js](electron/umi-ocr.js) 的 `registerOcrIpc`，调用 [main.js](electron/main.js) L280 |
| OCR（按需下载引擎） | `ocrEngine.registerIpc(ipcMain, () => mainWindow)` + `rapidOcr.registerRapidIpc(ipcMain)` | [ocr-engine.js](electron/ocr-engine.js)（下载/解压/校验/移除，进度经 `ocr-engine:progress` 推送）与 [rapidocr.js](electron/rapidocr.js)（引擎进程管理），调用 [main.js](electron/main.js) L280-L286 |
| 诊断/导出 | 内联 | [main.js](electron/main.js) L75、L79 |
| 读文件 | 内联 | [main.js](electron/main.js) L297-L314 |

这种「领域模块 + 内联少量」的组织方式使每个模块可独立 require 测试（`tools/test-archive.cjs`、`test-system.cjs` 均直接 require 主进程模块），但通道全貌只能靠 grep 或契约脚本还原。

### 2.4 一条完整调用链（打印）

```
js/print.js: setupPanel() L37
  → printApi.printImage({ dataUrls, printerName, copies, pageSize, landscape, marginType })
  → preload L18 ipcRenderer.invoke('print:printImage')
  → main.js L206 handler
      buildPrintDoc(dataUrls, pageSize, landscape)  [print-doc.js L41-L72]
      token = randomUUID(); printPages.set('/__print__/'+token, html)
      new BrowserWindow({show:false, sandbox:true})
      loadURL('http://127.0.0.1:'+serverPort+route)
      webContents.print({silent:true, deviceName, copies, pageSize, margins}, cb)
      60s watchdog → destroy + 返回超时错误
      finally printPages.delete(route)
```

关键设计：

- **一次任务装载整份多页文档**：逐页调用 `print()` 会让驱动每任务弹一次确认框，且无法跨页排序（L203-L205 注释）。
- **内存路由而非 `data:` URL**：Chromium 对 `data:` 有 2 MB 上限（`ERR_INVALID_URL -300`），大尺寸多页 HTML 必然超限；临时文件又要处理清理与权限（L38-L41 注释）。
- **看门狗**：`webContents.print` 回调在驱动挂起时可能永不触发，必须超时销毁隐藏窗口并回收 Map，否则窗口、路由、IPC Promise 三者一起泄漏（L232-L245）。

### 2.5 路径读取白名单

这是主进程最值得注意的纵深防御：

1. `archive:pickPaths`（对话框）与 `archive:statPaths`（拖拽）返回的元数据经 `record()` → `allowReadPaths(metas)` 写入 `readPathWhitelist`（[archive.js](electron/archive.js) L280-L286；[main.js](electron/main.js) L259-L273）。
2. `print:readFile` 只接受已登记路径，再校验扩展名（pdf/txt/docx/doc/jpg/jpeg/png/webp/bmp/gif）与 200 MB 上限，异步读取后以 `ArrayBuffer` 经结构化克隆返回（L296-L314）。
3. 归一化键：`path.resolve` + Windows 小写化；容量 5000，超限整体清空（正常使用远达不到）。
4. 白名单是**会话级**的：重启应用后需重新选择，避免「一次授权永久可读」。

同类收口还有：打印机名必须命中 `getPrintersAsync()` 枚举（L181-L190）；系统命令用 `sysExe()` 拼 `System32` 绝对路径防 PATH 劫持（L137-L140）；`reg.exe` 只允许 `7z/zip` 扩展名经 `sanitizeExts`（[archive-icons.js](electron/archive-icons.js) L127-L132）。

### 2.6 `tools/test-ipc-contract.cjs` 在约束什么

该脚本是**静态契约检查**，不启动 Electron：

- 扫描 `electron/preload.js` 中所有 `ipcRenderer.invoke('<channel>')` / `ipcRenderer.send('<channel>')`，得到「渲染层实际使用集合」；
- 扫描 `electron/*.js` 中所有 `ipcMain.handle('<channel>')` / `ipcMain.on('<channel>')`，得到「主进程注册集合」；
- 断言：使用数 ≥ 15；**每个被 preload 使用的通道都必须在主进程注册**（缺失即失败）；并打印反向「注册但未被使用」的提示（不失败）。

它真正防的是**改名/删注册导致的静默 404**——`ipcRenderer.invoke` 对未注册通道会 reject，页面报错但很容易被当成业务错误。它的盲区也要清楚：

- 不做 payload/返回值结构校验，参数名与顺序靠人工；
- 不覆盖 `archive:progress` / `app-update:progress` 这类单向事件；
- 不检查同一通道是否被重复注册（Electron 会抛错，但静态扫描不一定暴露）；
- 不校验 `preload` 暴露的方法名与页面调用名的一致性（例如 `printApi.pickPaths` 实际指向 `archive:pickPaths` 这种跨域复用）。

### 2.7 安全模型小结

| 层 | 措施 | 位置 |
|---|---|---|
| 进程 | `sandbox`、`contextIsolation`、无 Node、单实例 | main.js L352-L358、L325 |
| 页面 | 严格 CSP（禁内联脚本、禁远程）、禁导航/弹窗 | main.js L367-L387 |
| 桥 | 7 组显式方法，不透传 `ipcRenderer` | preload 全文 |
| 文件 | 会话白名单 + 扩展名 + 200 MB + 异步读 | main.js L259-L314 |
| 系统调用 | `System32` 绝对路径、打印机名白名单、注册表扩展名白名单 | main.js L137、L181；archive-icons L127 |
| 本地服务 | 随机端口、仅 GET/HEAD、回环 Host 白名单、路径 containment | static-server.js L2-L12、L34-L60 |
| 日志 | 单行化防伪造、按天轮转保留 10 份、导出上限 2 MB | main.js L47-L65、L79-L131 |

---

## 3. 核心业务流程

### 3.1 证件照主链路：导入 → 分割 → 换底 → 规格 → 导出

页面结构：`#view-photo`（index.html L118）内部四步 `#step-upload` L185、`#step-matte` L202、`#step-spec` L265、`#step-export` L297，由 `showStep()`（[js/app.js](js/app.js) L44）切换。

```
File/拖拽/示例
  → app.js loadFile(file) L119
      createImageBitmap → 尺寸校验 → State 初始化 → showStep('matte')
  → Matting.segment(image, onProgress)  segmenter.js L733
      makeWorkCanvas: 长边 ≤1600 的 ImageData（L55）
      MediaPipe ImageSegmenter 逐瓦片推理 → 人像置信度
      extractPersonConf → 后处理链 → alpha → maskCanvas
  → app.js renderMatteView L275 / scheduleMatteRender L337
      Composer.compositeInto(ctx,w,h,st,dirty)  composer.js L173
      （换底色 / 白边 / 倾斜 / 美白 都在这一层合成）
  → step-matte: Brush 手涂 / MatteView 缩放平移 / Undo L353
  → enterSpecStep L484 → buildSpecGrid L494（SPECS 规格模板）
      Cropper 交互裁剪 → renderCrop L536
  → enterExportStep L610 → makeSingleCanvas L643
      Composer.buildSheet / 单张合成 → canvas.toBlob
      DpiUtil.setPngDpi / setJpegDpi 注入 300 DPI 物理密度
      download(blob, name) L106（a[download]）
```

#### 3.1.1 分割算法链（`js/segmenter.js`）

`window.Matting` 是单例 IIFE，模型与 worker 懒加载：

| 阶段 | 函数 | 作用 |
|---|---|---|
| 初始化 | `init()` L35、`createSegmenter(modelPath)` L22 | 主模型 `selfie_multiclass_256x256.tflite`（头发/皮肤/衣服细分），失败回退 `selfie_segmenter.tflite`（L37-L42） |
| 预处理 | `makeWorkCanvas(image)` L55 | 长边压到 1600，控制内存与推理时间 |
| 整图粗分割 | `segment()` L742-L748、`extractPersonConf` L105 | 取人像类别置信度，输出同尺寸 `Float32Array`，并保留 hair/skin/clothes 分类掩码 |
| 瓦片精修 | `TILED_MIN=800` L11、`tiledRefine` L207、`tileStarts` L198、`axisWeight` L179 | 长边 ≥800 才启用；512 瓦片、96 重叠，按轴权重融合过渡带 |
| 边缘引导 | `guidedFilter(conf, lum, w, h, r, eps)` L294、`boxBlur` L265 | 用亮度引导把低分辨率置信度对齐到原图边缘 |
| 类别增益 | `classBoost` L325、`classGain` L339 | 对头发/衣服/肤色类别做置信度加权 |
| 二值化 | `hysteresisBin(conf, w, h, strongT, weakT, gain)` L356 | 双阈值滞后：强置信种子 + 弱置信连通 |
| 去噪 | `medianFilter3` L395、`cleanComponents` L416 | 中值滤波 + 连通域清理（去孤立块/填小洞） |
| 边界固化 | `solidifyBorders` L467、`fillHoles` L525 | 保证人物外轮廓闭合、内部空洞填充 |
| 软边 | `refineAlpha` L550、`clearHairGaps` L644 | 生成 0-255 alpha，发丝间透光区域单独处理 |
| 输出 | `alphaToCanvas` L718 | alpha → `maskCanvas`（与工作画布同尺寸） |

这套链路的取舍：**离线 CPU 推理不做端到端大模型**，而是「小模型 + 传统 CV 后处理」。好处是包体可控（模型 15.9 MB）、弱机可跑；代价是参数多、对极端背景/复杂发丝依赖后处理调优，`tools/verify-hair.cjs`、`test-hair-clothes.cjs` 就是为此存在的回归护栏。

#### 3.1.2 合成与状态（`js/composer.js` + `js/app.js`）

`App.State`（[js/app.js](js/app.js) L10）是全应用唯一可变状态：`workCanvas`（原图工作副本）、`maskCanvas`（alpha）、`baseCanvas`（底色/白边）、`bg`、`spec`、`tilt`、`whiten`、`zoom/pan`、`undoStack` 等。模块之间不通过事件总线，而是**直接读写这个对象**。

`Composer` 的核心优化：

- `workLayer(st, outW, outH, tf)` L70：按输出尺寸与变换生成工作层，带单槽缓存（`_layerC`），状态版本不变时复用；
- `scaledMask(st, outW, outH, tf, region)` L96：只缩放脏区，避免每次全图重采样；
- `compositeInto(ctx, outW, outH, st, dirty)` L173：按脏矩形重绘，支持换底色、白边、倾斜、美白；
- `applyWhiten`（app.js L218）与 `scheduleTiltRender`（L254）分别做防抖/节流，把高频滑杆输入合并成一次合成。

**为什么这样设计**：证件照交互要求「拖动即见」。全量重绘 1600px 画布在弱机上会卡；脏区 + 图层缓存是这里最有效的优化，也解释了为什么 `State` 里要维护 `_workRev` 与 `pendingDirty`（app.js L328-L351）。

#### 3.1.3 规格、裁剪与导出

- `js/specs.js` 定义 `window.SPECS`（毫米尺寸 + 300 DPI 像素 + 头部参考线）与 `SpecUtil`。
- `Cropper`（[js/cropper.js](js/cropper.js) L8-L221）负责自动对齐、蒙版分析、画布缩放平移与指针事件；输出裁剪参数写回 `State`。
- `makeSingleCanvas`（app.js L643）按目标规格合成单张；导出时 `js/dpi.js` 直接改字节：PNG 写 `pHYs`、JPEG 改 JFIF density（`setPngDpi` / `setJpegDpi`，L9-L127）。这是「像素尺寸正确但打印机会按 72 DPI 放大」问题的根治手段。
- 预览排版 `previewSheet` L630 调 `Composer.layoutSheet` 生成 6 寸纸预览。

### 3.2 排版与单张打印（`js/sheet.js` + `js/print.js`）

排版页 `#view-sheet`（index.html L522）是一个独立工作流：

```
loadFiles(files) L216
  → coverToSpec(src, sp) L36（cover 裁切到规格比例）
  → 按规格/纸张收集 cells（collectCells L50）
  → Composer.layoutBatch/layoutGroups 计算每页格位（composer.js L253/L353）
  → renderLaySheet L130 → drawPage L163（画裁切线、页码、纸张预览）
  → 导出：drawPage → toBlob → DpiUtil.setPngDpi → download / ZipUtil 打包
  → 打印：App.print.printSheets L198 → printApi.printImage(...) L222
          （批量页签复用 setupPanel L37 装配同一个打印面板）
```

`Composer` 的排版模型：

- `PAPERS`（L215）以 300 DPI 定义纸张像素（如 6 寸 1800×1200）；
- `bestLayout` L224 在给定纸张/格子下搜索最优行列；
- `layoutGroups` L253 按「同规格分组」排版，避免混排浪费；
- `layoutBatch` L353 让每页首行统一锚定 5mm 上边距，余量留底部（L208-L209 注释）；
- `layoutExact` L411 用于固定格数场景。

打印面板（[js/print.js](js/print.js)）只做参数装配：打印机列表 `fillPrinterSelect`（L17，导出页刷新器由 `setupPanel` 注册，L37-L56）、份数 clamp（L96）、预览（L114）、属性对话框（L179）、`printSheets`（L198）、`printImage`（L222）。真正的纸张/方向/双面/边距由主进程 `buildPrintDoc` 与 `webContents.print` 处理。

`buildPrintDoc(dataUrls, pageSize, landscape)`（[electron/print-doc.js](electron/print-doc.js) L41-L72）输出 `{html, pageCount, cssPageSized}`：每图一页（`page-break-after`）、`@page size` 与边距、横版时宽高对调。页面尺寸可用 `'A4'/'A5'/'Letter'` 或微米对象，直接透传给 Chromium。

### 3.3 批量打印与文档打印（`js/print-batch.js`，893 行）

`window.App.printBatch`（L15）是「文档工具」页的核心，有两条并列链路：

**图片批量打印**：

```
pickImages L176 → printApi.pickPaths('image') → addImages L182
  → loadImage L196：printApi.readFile(path) → Blob → ObjectURL → Image 解码
  → 缩略图网格；旋转/勾选/排序由本地 imgs[] 维护
  → runImages L345：按份数/每页张数合成画布 → sendPrint L163
      → printApi.printImage({dataUrls:[...]})
```

**文档批量打印**：

```
pickDocs → addDocs → 每个 doc 懒加载
  → renderDoc(d, onPage) L539
      PDF：pdf.js（vendor/print）逐页 render 到 canvas
      DOCX：mammoth 转 HTML → 离屏 DOM/Canvas 分页
      TXT：按行分页
  → runDocs L736
      mode=queue：每份文档独立任务顺序发送（保留文档顺序/份数）
      mode=merge：所有页面合并成一次 printImage（减少驱动弹窗）
  → sendPrint L163 仅薄封装 printApi.printImage；进度/逐项成败由 runImages / runDocs 的状态区维护
```

关键工程点：`readFile` 返回 `ArrayBuffer`，渲染层自己造 Blob URL，**避免把大字节塞进 DOM**；`URL.revokeObjectURL` 在失败路径也释放（L215-L216），防长批次内存泄漏。

### 3.4 压缩解压（`js/archive.js` + `electron/archive.js` + 7z）

渲染层 `App.archive`（[js/archive.js](js/archive.js) L767）只做列表、参数、进度与结果展示；执行在主进程：

```
runCompress L336 → haoyueArchive.compress(payload)
  → archive:compress → archive.js L80-L145
      validate 输入/输出（禁止输出落在输入集合内）
      args7z.buildCompressArgs(...)  [7z-args.js L69-L103]
      engine.run7z(...)             [archive-engine.js L137-L181]
      spawn 7z.exe，stdout 解析进度 → win.webContents.send('archive:progress')
  → runExtract L420 → archive:extract → archive.js L173-L215（多包循环）
```

- 7z 定位：打包后 `resources/bin/7z.exe`，开发期 `electron/bin/7z.exe`，再回退系统 7-Zip（[archive-engine.js](electron/archive-engine.js) L17-L31）。
- **全局互斥**：`runExclusive` 保证同一时刻只有一个压缩/解压任务（L46-L69），避免多任务争抢 CPU 与进度通道。
- **取消**：`cancelActiveJobs` 打 `killedByUser` 标记并 `kill()` 活动子进程；压缩取消时清理半成品（archive.js L80-L145）。
- 参数全部经 `7z-args` 构造：`a -t... -mx... -v... -p... -mhe... -bsp1 -bso0 -- out inputs`；解压 `x -o... -y -bsp1 -bso0 -- archive`。密码用 `-p` 直接拼参数（同机进程可见命令行，见第 6 节风险）。
- 压缩包浏览 `browseArchive` L482 调 `archive:list`，主进程解析 7z 列表输出，渲染层表格展示。

### 3.5 OCR（`js/docs-ocr.js` 1643 行 + `js/ocr-enhance.js` 1306 行）

`App.docsOcr`（L1503，`enter` 在 L1496）是文档工具里最重的一条链路：

```
enter L1496 → 选文件/拖拽 → canvas 解码
  → enhanceCanvas(c, mode) L73（灰度/二值/去噪/透视校正等预处理）
  → Tesseract worker 懒加载 L1128-L1132
      workerPath: vendor/ocr/worker.min.js
      corePath:   vendor/ocr/
      langPath:   vendor/ocr/lang/
  → recognizeSmart(wk, canvas, opts) L399
      基础 PSM → 置信度/清晰度评分 → 分场景二次识别
      （稀疏文本、表格、小数点修复、颜色区域检测）
  → buildResult L932 → cleanText L977 → 字段/表格结构化
  → 导出：TXT / DOCX（buildDocxXml / buildDocxFiles L1012/L1087，手写 OOXML）
        / XLSX（js/xlsx-lite.js，手写单元格 XML）
        / ZIP（js/zip.js 自研 store 模式打包）
```

设计特点：

- **完全离线**：Tesseract core + 中英文语言包全部在 `vendor/ocr`，不下载、不联网。
- **手写格式生成器**：DOCX/XLSX 不引第三方库，直接生成 OOXML + ZIP；`tools/test-xlsx-lite.cjs`、`test-docs-ocr.cjs` 覆盖。
- **后处理比识别更重**：`ocr-enhance.js` 1306 行负责版面分析、表格还原、数字/小数点修复、置信度过滤；`docs/ocr-*.md` 五篇文档记录了调优与评测过程。
- **性能取舍**：识别在主线程外的 Tesseract Worker 执行，但 canvas 预处理仍在渲染线程；大图会先 `scaleCanvas`/`calcScale`（L47）降采样。

### 3.6 PDF / 文档转换链路（pdfcore + buildPdf）

这条链路有一个容易被忽略的架构事实：**没有 PDF 结构编辑库**。所有 PDF 输出都是「页面栅格化 → 重新生成 PDF」：

- `js/pdfcore.js` L39 `loadPdf` 用 `window.pdfjsLib` 加载；L45 `renderPage` 渲染到 canvas；L75 `writeBytes` 用 **File System Access API**（`showDirectoryPicker`，L103-L107）直接写目录，避免批量输出时反复弹保存框。
- 重新生成 PDF 的函数是 `App.batchFormat.buildPdf(pages)`（[js/batch-format.js](js/batch-format.js) L61，纯 JS 生成器，以 `DCTDecode` 直接嵌入 JPEG 页图，L442 注释）。
- 因此：
  - `docs-pdf.js` 合并 = 多 PDF 逐页栅格化后重建；拆分 = 按页码提取后重建；压缩 = 中等分辨率 + 较低 JPEG 质量重编码（[js/docs-pdf.js](js/docs-pdf.js) L4-L9 注释，输出页明确为图像、文字不可选中）；
  - `docs-convert.js` 图片→PDF、PDF→图片、DOCX→PDF（mammoth → HTML → 分页 → canvas → `buildPdf`）；
  - `docs-watermark.js` 在渲染后的 canvas 上画水印再重建；
  - `docs-reader.js` 只读渲染，不写出。

**为什么这样设计**：纯前端环境缺少可靠的 PDF 结构编辑库，栅格化重建实现简单、结果稳定、所有页面视觉一致；代价是**文字层丢失、文件体积变大、扫描件质量下降**（第 6 节列为已知技术债）。

### 3.7 其余批量工具（相对独立）

| 工具 | 文件 | 入口 | 数据流 |
|---|---|---|---|
| 批量改名 | `js/batch.js`（479 行） | `pickFolder` L392 → 规则/预览 → `executeRename` L375 | `showDirectoryPicker` 拿 `FileSystemDirectoryHandle`，扫描/改名都走 FSA，不经 IPC |
| 格式转换 | `js/batch-format.js`（`App.batchFormat` L436） | `scanFolder` L148 → 解码 → canvas → 输出 | `createImageBitmap` 解码，`buildPdf` L61 供 PDF 输出复用 |
| 批量水印 | `js/batch-watermark.js`（`App.batchWatermark` L779） | 框选/涂抹蒙版 → 应用 | 蒙版按图应用；结合 `docs-watermark` 的绘制算法 |
| 图片压缩 | `js/compress.js` L330 | `computeTargetSize` L31、质量 clamp L24 | 本地 canvas 缩放/重编码，输出名去重 `buildOutputName` L64 |
| 图片合成 | `js/compose.js` L353 | `computeLayout` L25 | 多图拼版，纯 Canvas |
| 图片转换 | `js/convert.js` L251 | 格式/质量 | 纯 Canvas 重编码 |
| 批量 ZIP | `js/zip.js` L8-L90 | `ZipUtil.store` | 自研 store 模式（无压缩），避免 Electron 连续保存框 |

这些工具都不经过主进程，只有「读取本地文件」在 Electron 下借助 `File` 对象或 `haoyuePrint.readFile`（批量打印场景）。**写盘统一走 File System Access API**（`showDirectoryPicker` → `FileSystemDirectoryHandle`），原因是：渲染层沙箱没有 `fs`，而连续 `download()` 会为每个文件弹一次保存框；FSA 一次授权目录后可批量原子写，且 `js/pdfcore.js` 的 `uniqueOutName`/`writeBytes`（L75-L100）负责防静默覆盖。Electron 45 的 Chromium 支持该 API；不支持时 `supported()` 会禁用入口并提示（[js/batch.js](js/batch.js) L180）。浏览器模式下同一套代码也能跑，桌面桥缺失时各模块用自己的 `supported()` / `bridgeOk()`（[js/archive.js](js/archive.js) L236）做降级提示。

---

## 4. 分层依赖与耦合现状

### 4.1 事实上的核心枢纽

```
                 ┌──────────────┐
                 │  js/app.js   │  State / ui / 路由 / 上传 / 导出 / 更新UI
                 └──────┬───────┘
        ┌───────────────┼─────────────────┐
        ▼               ▼                 ▼
  js/composer.js   js/segmenter.js   js/cropper.js / brush.js / matteview.js
        │               │
        └───────► 所有页面模块（sheet / batch / archive / print / docs-*）
                        │
                        ▼
              window.haoyue* 桥（preload）
                        │
                        ▼
              electron/* 主进程模块
```

- **`js/app.js` 是上帝模块**：持有 `App.State`、`App.ui`（toast/confirm/download）、步骤路由、上传、美白、蒙版渲染调度、撤销、规格、导出、模块切换、系统设置页、更新 UI（`updaterUI` L913-L951）、错误上报、任务取消 `createTask` L1232、拖拽绑定 L1243。任何页面模块都依赖它。
- **`Composer` 是图像合成的公共底座**：证件照预览、单张导出、排版预览、排版导出、批量打印合成全部调用它；它的缓存（`_layerC`）与 `State` 强绑定。
- **`segmenter` 是独立单例**：只依赖 `vendor/mediapipe` 与 canvas，不依赖 `App`，可被 Node/jsdom 测试直接加载（`test-hair-clothes.cjs` 的加载方式）。
- **`pdfcore` + `batchFormat.buildPdf` 是文档链路的公共底座**：docs-pdf / docs-convert / docs-watermark / docs-reader 四个模块共享「pdf.js 渲染 + 自研 PDF 生成」。

### 4.2 耦合方式与代价

| 耦合方式 | 体现 | 代价 |
|---|---|---|
| 全局可变 `App.State` | 各模块直接读写，无 getter/setter | 状态变更不可追踪；脏区/缓存失效靠手工 `_workRev` |
| `window.App` 命名空间 | 模块加载顺序决定可用性（index.html L1903-L1935） | 少一个 `<script>` 就是 `undefined`；测试需按序模拟 |
| 直接 DOM id 访问 | `$('step-upload')`、`$('dw-status')` 遍布模块 | UI 结构改动会静默破坏逻辑；无组件边界 |
| 跨域复用桥 | `haoyuePrint.pickPaths` 实际调 `archive:pickPaths` | 命名误导；契约测试只看通道存在 |
| 共享 canvas 缓存 | `Composer._layerC`、`Brush.snapMask` 直接操作 `st.maskCanvas` | 并发/多文档不可能；单窗口单图是隐含前提 |

### 4.3 单文件过大与职责混杂

| 文件 | 行数/KB | 混杂职责 |
|---|---|---|
| `js/docs-ocr.js` | 1643 / 75.6 | 预处理、Tesseract 调度、版面分析、小数点修复、颜色区域、DOCX 生成、UI 状态 |
| `js/ocr-enhance.js` | 1306 / 54.1 | 文本块增强、表格还原、阅读顺序、渲染辅助 |
| `js/app.js` | 1301 / 55.3 | 全局状态 + 6 个页面流程 + 更新 UI + 系统设置 |
| `js/print-batch.js` | 893 / 33.2 | 图片队列 + PDF/DOCX/TXT 渲染 + 打印编排 + UI |
| `js/segmenter.js` | 820 / 35.1 | 模型封装 + 12 个 CV 后处理函数（算法密度高，拆分收益中等） |
| `js/batch-watermark.js` | 799 / 28.7 | 蒙版编辑 + 批处理 + 输出 |
| `js/archive.js`（渲染） | 790 / 31.8 | 压缩/解压/浏览/密码框四套 UI 状态机 |
| `index.html` | 1937 / 106.4 | 7 个模块页全部内联 |

> 说明：`app.js` 按物理行统计为 1301 行；其中空行/注释占比不低，但函数数量（约 60 个）与职责面确实过大。`segmenter.js` 虽长，但函数职责单一、可独立测试，拆分优先级应低于 `app.js` 与 `docs-ocr.js`。

---

## 5. 构建、测试与发布

### 5.1 脚本体系（package.json L9-L21）

| 脚本 | 作用 |
|---|---|
| `start` | `electron .` 开发启动（走本地静态服务） |
| `serve` | `node tools/server.js` 纯浏览器调试（无 Electron 能力） |
| `dist` | `electron-builder --win --publish never`，产物到 `release-build/` |
| `test` | `check-refs.cjs` + `test-*.cjs`（1.7.2 为 30 个，含 OCR 引擎安装/识别测试）串行；任一非零退出即失败 |
| `verify` | 11 个 `verify-*.cjs`（真实浏览器 E2E / 打包产物 / OCR 真链路） |
| `lint` / `lint:fix` | ESLint 9（flat config） |
| `format` / `format:check` | Prettier（仅 js/electron/tools） |
| `eval:ocr` / `eval:ocr:real` | OCR 精度评测（合成样本 / 真实样本） |
| `ocr:pack` | 生成 OCR 引擎精简包（上传 Release 供应用按需下载） |
| `icons` | `tools/make-icons.cjs` 从 `assets/src-*.png` 生成图标集 |

依赖策略：运行时只有 `electron-updater`；其余（Electron、builder、jsdom、jimp、playwright、prettier、eslint）都是 devDependencies。`overrides: @electron/get 5.1.0` 用于锁定下载器版本。

### 5.2 测试脚本的三层结构

| 层 | 代表 | 加载方式 | 断言 |
|---|---|---|---|
| 纯函数/字节级 | `test-dpi.cjs`、`test-zip.cjs`、`test-pdfcore.cjs` | Node 里 `eval()` 加载 `js/*.js`，伪造 `window` | 直接比较字节/结构 |
| DOM 冒烟 | `test-dom.cjs`（580 行）、`test-server.cjs` | jsdom 加载 `index.html` + 全部脚本；`_lib.withServer` 起本地服务 | 断言各模块挂载到 `window`、关键 DOM 存在、无引导期脚本错误 |
| 主进程模块 | `test-archive.cjs`、`test-system.cjs`、`test-update.cjs`、`test-appupdater.cjs` | `require('electron/...')`，在 require 前替换 `child_process.spawn`、`app`、`ipcMain` 等副作用 | 通道注册、参数校验、路径归一化、备份命名、平台分支 |
| 契约/引用 | `check-refs.cjs`、`test-ipc-contract.cjs` | 正则/静态扫描 | 文件存在、版本一致、通道对齐 |
| 端到端 | `verify-hair.cjs`、`verify-sheet.cjs`、`verify-archive.cjs`、`verify-print-batch.cjs`、`verify-ocr.cjs`、`verify-packaged.cjs` | Playwright 真 Chromium / 真实 exe | 图像产出、DOM 行为、OCR 置信度、打包后桥接与 7z |

`tools/_lib.cjs` 是共用底座：`assert()` 计数、`finish()` 以失败数决定 `exit(1|0)`（L18-L30），`withServer()` 给需要 HTTP 的测试起静态服务（L61-L94）。所有 `test-*`/`verify-*` 都遵循「失败即非零退出」，因此可以被 npm 串行链与 CI 直接消费。

`check-refs.cjs`（L13-L45）做三件事：`index.html` 所有本地引用存在、首页展示版本与 `package.json` 一致、`js/segmenter.js` 里的 vendor 路径存在。这弥补了「无打包器导致引用不会被构建期发现」的空白。

### 5.3 CI（`.github/workflows/ci.yml`）

- 触发：push 到 `main`、任意 PR、手动。
- 矩阵：`ubuntu-latest` + `windows-latest`，Node 24，`ELECTRON_SKIP_BINARY_DOWNLOAD=1`（测试不启动 Electron）。
- 步骤：`npm ci` → `node --check` 全量语法 → `npm run lint` → `npm test`。
- 设计意图：跨平台验证「路径/编码/大小写」差异；不跑 Electron 以控制时长与体积。

### 5.4 发布（`.github/workflows/release.yml`）

触发：`v*` tag push，或手动 `workflow_dispatch`（可填已有 tag 补发）。

流水线：

1. Node 22（注释明确：npm 11 的 install-scripts allowlist 会拦截 Electron postinstall）。
2. 缓存 Electron / electron-builder / ms-playwright。
3. `npm ci` → 若缺 `node_modules/electron/path.txt` 则执行 `node node_modules/electron/install.js`（Electron 44.8+ 不再带 postinstall）。
4. 校验 tag 与 `package.json` 版本严格一致（`v1.2.0` ↔ `1.2.0`）。
5. `npm test` 门禁。
6. `npx playwright install chromium` → `verify-ocr.cjs`（真实 Chromium 跑 Tesseract wasm + 语言包 + 识别断言）。
7. `npm run dist`（失败把日志尾部贴到 Step Summary）。
8. `verify-packaged.cjs`：启动真实 exe → 首页渲染 → 版本一致 → 桥接真身 → 7z IPC 冒烟。
9. 指定 tag 时 `gh release create/upload`，上传 4 个资产：Setup exe、blockmap、portable exe、`latest.yml`；未指定 tag 则只上传 artifact。

### 5.5 electron-builder 与 electron-updater 的关系

- `build.publish` 指向 GitHub `Laogaodhck/haoyuebox`（[package.json](package.json) L27-L31）。仓库必须公开，否则匿名更新请求 403（项目记忆中的硬约束）。
- 目标：`nsis`（x64）+ `portable`（x64），两者产出不同 artifactName：
  - NSIS：`haoyue-idphoto-Setup-${version}.${ext}`（L90）
  - Portable：`haoyue-idphoto-${version}-portable.exe`（L93）
- `electron-updater` 的 `NsisUpdater` 读取 Release 中的 `latest.yml`，按其中记录的文件名下载；因此 **artifactName 必须纯 ASCII 且与 latest.yml 一致**，否则 GitHub Release 清洗文件名后更新 404。
- `.blockmap` 支持差分下载（release.yml L112-L114 注释）。
- `electron/updater.js`：
  - `FEED` 指向 GitHub Release（L13-L22）；
  - `envKind` 区分 `portable / packaged / dev`；便携版是临时解压目录，**不支持就地更新**，只能引导打开发布页；
  - `autoDownload=false`、`autoInstallOnAppQuit=false`，全部手动触发（L157-L194）；
  - 进度经 `app-update:progress` 推送，渲染层 `haoyueAppUpdate.onProgress` 注册。
- `electron/update.js` 是**另一套机制**，与在线更新无关：
  - `version-marker.json` 记录 `lastVersion`，`decideLaunch` 判定 `first/upgrade/rollback/normal/unknown`（L55-L62）；
  - 升级首启时把用户数据备份到 `userData/backups`，文件名 `data-<13位时间戳>-<4位随机>-v<version>.json`，字典序即时间序，保留最近 3 份（L93-L135）；
  - 备份写入用「临时文件 + rename」原子替换（L66-L75）；
  - `app:updateInfo` / `app:backupData` / `app:readBackup` / `app:deleteBackup`（L141-L221）。
  - 渲染层 `checkUpdateAndBackup()`（app.js L1083）在启动时消费这些信息。

---

## 6. 工程约束与风险（按影响程度排序）

### 6.0 已固化的硬约束

| 约束 | 代码/配置依据 | 违反后果 |
|---|---|---|
| 安装包产物名必须纯 ASCII | `nsis.artifactName`、`portable.artifactName`（[package.json](package.json) L90-L93） | GitHub Release 清洗中文名后 `latest.yml` 指向的文件 404，自动更新失败 |
| 应用 ID 必须全局一致 | `appId: com.haoyue.idphoto`（L24）、`setAppUserModelId`（[main.js](electron/main.js) L404-L406）、安装器/快捷方式 | 任务栏身份、更新归属、安全软件识别错乱 |
| 旧用户数据必须可迁移且可回滚 | userData 目录复制（[main.js](electron/main.js) L24-L34）、localStorage 旧键迁移（[settings.js](js/settings.js) L21-L23）、版本标记备份（[update.js](electron/update.js) L141-L221） | 升级后设置/备份丢失，且无法回退旧版 |
| 便携版不支持就地更新 | `envKind` 判定（[updater.js](electron/updater.js) L13-L22 附近） | 对临时解压目录执行安装会导致更新「成功但无效」 |
| 更新仓库必须公开 | `build.publish` 指向 GitHub（[package.json](package.json) L27-L31） | 匿名 `electron-updater` 请求返回 403 |
| 发布 tag 必须与 `package.json` 版本严格一致 | [release.yml](.github/workflows/release.yml) L72-L81 | 构建直接失败，或产物名与标签不符 |

### P0 / 高影响

**1. 品牌残留：压缩包关联仍写 `ZunhongArchive` ProgID**

`CHANGELOG.md` 宣称「压缩包关联 ProgID 友好名全量更名」，但代码仍是旧品牌：

- `const keyProgId = (ext) => 'HKCU\\Software\\Classes\\ZunhongArchive.' + ext;`（[electron/archive-icons.js](electron/archive-icons.js) L134）
- 备份值名 `ZunhongBackup`（L144、L164）
- 写扩展名默认值 `'ZunhongArchive.' + ext`（L165）

影响：注册表里保留旧品牌标识，与新名称不一致；若未来再次改名或清理，容易遗漏键。**这是本次分析发现的唯一明确的品牌一致性缺口**（其余如 `installer.nsh` 注释、`start.bat` 标题属于注释/开发脚本，用户可见性低）。

**2. `app.js` 上帝模块 + 全局可变状态**

`App.State` 被 20+ 模块直接读写，`app.js` 同时承担状态、UI、路由、流程编排、更新 UI。任何新功能都倾向继续往 `app.js` 加函数，回归风险随行数线性增长。当前 1301 行、约 60 个函数，已经超出单文件合理边界。

**3. `index.html` 单文件 1937 行 + 隐式脚本顺序**

7 个模块页、所有表单/表格/对话框全部内联；脚本依赖靠 L1903-L1935 的物理顺序。`check-refs.cjs` 只能保证文件存在，无法发现「A 模块在 B 模块之前使用 B」的时序错误（`test-dom.cjs` 能部分兜底，但只在测试环境）。

**4. IPC 契约测试只覆盖「通道存在」**

`test-ipc-contract.cjs` 不校验 payload 结构、返回值、事件通道、重复注册，也不校验 preload 方法名与实际通道的语义对应。改参数名、改返回字段不会失败，只会在运行时暴露。对于 30+ 通道的应用，这是中等偏高的维护风险。

**5. 文档链路的 PDF 栅格化重建**

`docs-pdf` / `docs-convert` / `docs-watermark` 全部走「pdf.js 渲染 → canvas → `buildPdf` 重建」。结果是：

- 文字层/书签/表单/超链接全部丢失，PDF 变成图片集；
- 文件体积显著增大；
- 反复处理会累积重采样损失。

这是有意的工程折中（纯前端无可靠 PDF 编辑库），但应在 UI 上明确提示，否则用户会认为「合并没有改变内容」。

### P1 / 中影响

**6. 全局 Canvas 缓存与单文档假设**

`Composer._layerC` 单槽缓存、`Matting` 单例、`Brush` 直接改 `st.maskCanvas`，隐含「同一时刻只有一个照片工程」。单窗口产品下可接受，但若未来做多标签/多图并行，需要重构为实例化对象。

**7. 7z 密码以命令行参数传递**

`buildCompressArgs` 生成 `-p<password>`（[electron/7z-args.js](electron/7z-args.js) L81-L85）。同机其他进程可通过进程列表看到密码；这是 7z CLI 的固有限制（无 stdin 密码通道），代码注释已显式评估「离线单用户场景可接受」。参数数组不经 shell、使用 `--` 分隔，命令注入风险已被排除，剩下的只是本机隐私面。

**8. preload 文档与实际暴露面漂移**

文件头注释写「暴露五组能力」，实际暴露 7 组（新增 `haoyueApp`、`haoyueAppUpdate`），L2-L5。不影响运行，但会误导维护者与契约审查。

**9. 包体较大**

`vendor/mediapipe/wasm` 38.8 MB + `mediapipe/models` 15.9 MB + `ocr` 13.2 MB + `ocr/lang` 4.5 MB ≈ 72 MB 静态资产，加上 Electron 运行时，安装包体积偏大。离线定位决定了不能 CDN 化，但可考虑按需加载/模型量化。

**10. 无类型与无模块边界**

IIFE + `window` 全局，ESLint 只能做语法/风格约束；跨模块调用的参数错误无法在编译期发现。`test-dom.cjs` 的「挂载断言」是当前最有效的护栏。

### P2 / 低影响

**11. CSP 允许 `style-src 'unsafe-inline'`**

因为大量内联 style 与动态样式。脚本侧已禁内联，XSS 风险被大幅压缩；但样式注入仍可被用于 UI 欺骗。属于可接受的折中。

**12. 未签名安装包**

Windows SmartScreen 会提示未知发布者；`docs/security-software-compatibility.md` 已记录误报治理方案（EV/OV 证书）。这是发布策略问题，不是代码缺陷。

**13. Release 门禁依赖公开仓库与网络**

`electron-updater` 匿名访问 GitHub；仓库私有即 403。CI 缓存/依赖下载也依赖网络。项目记忆已将其列为硬约束。

**14. 版本/运行环境注释漂移**

`release.yml` L49 注释写「Electron 44.8.0」，而 `package.json` 是 `^45.1.0`；`start.bat` 标题仍是 `Zunhong Toolbox`。不影响功能，但会增加排障噪音。

**15. 文档工具输出依赖 File System Access API**

`pdfcore.pickOutputDir` 依赖 `window.showDirectoryPicker`（L103-L107）。Electron 45 支持；若未来降级 Electron 或切到受限环境，批量输出会直接不可用（当前有 `null` 返回与调用方提示兜底）。

---

## 7. 改进建议（按投入产出排序）

> 以下仅为分析建议，本次任务未实施任何修改。

### 短期（低风险、立刻可做）

1. **统一品牌残留**：把 `archive-icons.js` 的 `ZunhongArchive` / `ZunhongBackup` 改为 `HaoyueArchive` / `HaoyueBackup`，并写一次「旧键迁移」逻辑（探测旧 ProgID → 迁移/删除），避免已接管用户的关联失效。同步修正 `preload.js` 头部注释为 7 组、`release.yml` 注释版本、`start.bat` 标题。
2. **补强 IPC 契约测试**：在 `test-ipc-contract.cjs` 中增加
   - 事件通道白名单（`archive:progress`、`app-update:progress`）；
   - 重复注册检测；
   - 从 preload 方法名到通道名的映射表断言（防止 `pickPaths` 跨域复用造成误解）。
3. **文档链路加显式提示**：合并/拆分/水印页面标注「输出为图像型 PDF，文字层将丢失」，减少用户预期落差。

### 中期（结构性、需排期）

4. **拆 `app.js`**：至少抽出 `updaterUI`（L913-L951）、系统设置页（L770-L845）、`export`（L610-L719）、`spec`（L484-L609）为独立模块；`App.State` 改为带 `set/get` 与版本号的轻量 store，保留现有 API 以免大改。
5. **拆 `docs-ocr.js`**：把「Tesseract 调度 / 版面分析 / 文档生成（DOCX/XLSX/ZIP）」分成三个文件；`ocr-enhance.js` 的表格与阅读顺序也可独立。算法函数已是纯函数，拆分成本可控。
6. **`index.html` 模板化（不引入构建）**：用 `<template>` + 运行时 include，或至少把 7 个模块页拆成 `partials/*.html` 由 `tools/server.js` 与构建期脚本拼接。可保留「无打包器」原则。
7. **Composer 实例化**：把 `_layerC` 缓存与 `State` 绑定改为 `new Composer(state)`，为未来多图/多文档留出口。

### 长期（产品级）

8. **引入 PDF 结构库**（如 pdf-lib 的离线构建）用于合并/拆分/水印，保留栅格化路径作为「扫描件」兜底；可显著改善文档工具的专业度。
9. **签名发布**：按 `docs/security-software-compatibility.md` 推进 OV/EV 证书，降低 SmartScreen 与国产安全软件误报。
10. **模型与资产按需加载**：MediaPipe 模型与 Tesseract 语言包可按语言/场景拆分，减少首包体积。

---

## 附录 A：关键文件规模（基线 1.7.1）

| 文件 | 行数 | 大小 |
|---|---|---|
| `index.html` | 1937 | 106.4 KB |
| `css/style.css` | 1429 | 47.3 KB |
| `js/docs-ocr.js` | 1643 | 75.6 KB |
| `js/ocr-enhance.js` | 1306 | 54.1 KB |
| `js/app.js` | 1301 | 55.3 KB |
| `js/print-batch.js` | 893 | 33.2 KB |
| `js/segmenter.js` | 820 | 35.1 KB |
| `js/batch-watermark.js` | 799 | 28.7 KB |
| `js/archive.js` | 790 | 31.8 KB |
| `js/composer.js` | 502 | 22.2 KB |
| `js/docs-watermark.js` | 496 | 19.0 KB |
| `js/batch.js` | 479 | 19.0 KB |
| `js/batch-format.js` | 454 | 15.3 KB |
| `electron/main.js` | 422 | 19.6 KB |
| `js/docs-convert.js` | 407 | 18.3 KB |
| `js/compose.js` | 362 | 12.6 KB |
| `js/sheet.js` | 342 | 14.2 KB |
| `js/docs-pdf.js` | 329 | 13.7 KB |
| `js/compress.js` | 343 | 12.9 KB |
| `js/docs-reader.js` | 323 | 12.4 KB |
| `electron/archive.js` | 302 | 14.2 KB |

> 行数为 `(Get-Content <file>).Count` 的物理行数（含空行）；不同统计方式可能有 ±几十行差异。

## 附录 B：IPC 通道清单（32 个通道：31 invoke + 1 send；另有 2 个单向事件）

```
print:listPrinters        print:showProperties     print:printImage       print:readFile
archive:check7z           archive:pickPaths        archive:statPaths      archive:saveDialog
archive:desktopPath       archive:compress         archive:extract        archive:list
archive:cancel
archive-icons:probe       archive-icons:apply      archive-icons:restore
system:netInfo            system:netProbe          system:openAddPrinter  system:openPrintSettings
system:printTestPage
app:logError (send)       app:exportLogs           app:updateInfo         app:backupData
app:readBackup            app:deleteBackup
app-update:status         app-update:check         app-update:download    app-update:install
app-update:openReleases
事件：archive:progress    app-update:progress
```

## 附录 C：分析边界与不确定项

- 本次未运行应用、未执行 `npm test`/`npm run verify`，所有行为结论来自源码与测试脚本的静态阅读；运行时表现（尤其 MediaPipe/Tesseract 的具体精度）未复验。
- 带「推断」的条目：`docs-*` 各模块之间的完整调用顺序（从函数引用与注释推导）、`Composer` 缓存失效的精确触发路径（未逐分支跟踪）、首页卡片到子模块的映射细节（`SUB_ENTRIES` 已在 app.js L963-L1014 核对，但未逐个运行）。
- 行号以 1.7.1 基线工作区为准；1.7.2 起 OCR 两个文件有改动，相关行号可能漂移，建议用函数名检索定位。

## 九、1.7.2 起的 OCR 演进（2026-11-14 增补）

这部分描述 1.7.1 快照之后的变化，正文未覆盖：

1. **识别编排拆分**：`js/docs-ocr.js` 的 Tesseract 分支改为「质量门控多通道」（基座原图 → 纠偏 / 放大 / 增强 / 二值化 / 备用 PSM → 表格单元格重识别），预算由 `MULTI` 常量统一约束；`js/ocr-enhance.js` 增加彩色通道、场景照兜底、小数点保守修复等能力。真实素材抽检与复测见 [ocr-accuracy-optimization.md](ocr-accuracy-optimization.md) 第八节、[ocr-real-report.md](ocr-real-report.md)。
2. **三引擎选择**（`js/docs-ocr.js` 的 `resolveEngine`）：RapidOCR（按需下载）→ 本机 Umi-OCR HTTP 服务 → 内置 Tesseract。RapidOCR 与 Umi 的结果统一经 `js/ocr-umi.js` 转成「Tesseract 同构 blocks」，下游版面还原 / 表格 / DOCX / Excel 导出完全复用。
3. **RapidOCR 按需下载并运行**（`electron/ocr-engine.js` + `electron/rapidocr.js`）：引擎二进制不入库、不随安装包，面板点击下载时由主进程从 Release `ocr-engine-2.1.5` 拉取精简包（约 26 MB，GitHub → `gh-proxy.com` → `ghproxy.net` 镜像回退），用随包 7z 解压到 `%APPDATA%/浩玥工具箱/ocr-engine/umi-ocr`，校验 9 个文件后写 `engine.json`；可用 `HAOYUE_OCR_ENGINE_URL` / `HAOYUE_OCR_ENGINE_DIR` 覆盖。运行侧负责 spawn、`OCR init completed.` 启动握手、管道一问一答的串行队列、语言切换重启、识别超时与 `will-quit` 释放；IPC 为 `ocr:engineStatus` / `ocr:engineInstall` / `ocr:engineRemove`（进度 `ocr-engine:progress`）与 `ocr:rapidStatus` / `ocr:rapidRecognize`。
4. **IPC 与桥接增量**：新增 `ocr:umiProbe` / `ocr:umiRecognize` / `ocr:rapidStatus` / `ocr:rapidRecognize` / `ocr:engineStatus` / `ocr:engineInstall` / `ocr:engineRemove` 七个 invoke 通道与一个进度事件（preload 增加 `haoyueOcr` 一组），主进程模块增至 14 个，渲染层 IIFE 增至 30 个；`tools/test-ipc-contract.cjs` 会按 preload 实际调用自动纳入契约检查。
5. **只保留中英模型**：下载包内 `models/configs.txt` 裁剪为简体中文 / English 两块；升级引擎时须同步裁剪（否则 Umi 面板会列出未随包的模型），并用 `npm run ocr:pack` 重新打包上传。升级注意见 [VENDOR.md](../VENDOR.md)。
