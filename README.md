# 尊泓工具箱

> 老高 · QQ 846193

**纯本地离线**的证件照制作、排版打印、批量处理、文档处理（OCR 文字识别 / 格式转换 / PDF）与文件压缩工具。
图像、文字与文件处理全部在本机完成（Canvas + 本地 WASM 人像分割 + 本地 pdf.js / mammoth + 内置 7z +
Tesseract LSTM 离线识别 + File System Access API），不调用任何后端服务或外部 API，照片与文档不出本机，
断网可完整使用全部功能。

## 使用方式

### 1. 桌面应用（推荐）

```bash
npm install        # 安装依赖（含 electron / electron-builder / 测试工具链）
npm run dist       # 打包 Windows 安装包 + 便携版
```

产物输出在 `release-build/`：

- `尊泓工具箱 Setup <版本>.exe`（NSIS 安装版，可选安装目录、创建桌面快捷方式，版本号随 `package.json`）
- `尊泓工具箱_便携版.exe`（免安装单文件）

图标约定：应用本体（尊泓工具箱.exe）使用尊泓回纹标（`assets/icon.ico`）；Setup 安装器与卸载
程序使用独立安装器图标（`assets/setup-icon.ico`，「安装包盒 + 光盘」）。两者均经
`npm run icons` 从 `assets/src-icon.png` 与 `assets/src-setup-icon.png` 生成，安装器图标经
nsis 的 `installerIcon` / `uninstallerIcon` 挂载——**后续版本的每次打包都会自动使用该图标**，
无需额外步骤；更换图标只需替换对应源图后重跑 `npm run icons`。

安装与更新行为：

- **覆盖安装 / 升级**：直接运行新版 Setup 即可，用户设置（主题 / 规格 / 打印机会账等，存于
  `%APPDATA%` 的 userData 目录）与程序目录天然隔离，升级与卸载均**不清除用户数据**
  （NSIS 显式声明 `deleteAppDataOnUninstall: false`）。
- **进程清理**：覆盖安装前安装器自动静默结束残留的旧版本进程（按安装目录精确匹配 +
  映像名兜底强杀），不会再弹「无法关闭，请手动关闭」卡住安装。
- **升级 / 回滚感知**：应用启动时比对版本标记识别升级与回滚，升级后首启自动备份一次
  当前设置；设置意外丢失且有备份时，启动会弹窗询问是否恢复。

开发调试：`npm start` 直接启动 Electron 窗口（内置随机端口静态服务 + 打印 IPC）。

### 2. 浏览器运行

1. 双击 `start.bat`，或 `npm run serve`（需要本机 Node.js，仅用于起本地静态服务）
2. 浏览器自动打开 `http://localhost:8410/`
3. 手机访问：与服务处于同一局域网时，用控制台打印的局域网地址即可

> 也可以用任意静态服务器（如 `python -m http.server 8410`）。
> 直接双击 `index.html`（file:// 协议）无法加载本地 WASM 模型，页面会给出提示。
> 浏览器模式没有直接打印与压缩/解压能力（无 7z 引擎与系统打印机），相关面板会提示改用桌面版。

## 功能

七个模块：**首页**（软件声明 + 入口）、**照片工具**（证照生成 / 图片转换 / 图片压缩 / 图片合成四个子功能，
另有老照片修复、证照打印规划中）、**排版工具**（4 步批量排版打印）、
**批量工具**（批量重命名 / 去除水印 / 格式转换 / 体积优化 / 批量打印五个子功能，批量加水印规划中）、
**文档工具**（文档打印 · 文档转换 · PDF 工具 · PDF 阅读器 · OCR 文字识别 · 文档加水印六项全部可用）、**压缩工具**（压缩 / 解压 / 压缩包图标）、
**系统工具**（网络检测 / 添加打印机 / 设置三项可用，软件卸载 / 垃圾清理规划中，暂为占位页）。
顶部模块标签与首页工具卡片均可进入；照片、批量、文档与系统工具下设子功能菜单。

| 功能 | 说明 |
| --- | --- |
| AI 人像分割 | MediaPipe Selfie Multiclass（背景/头发/身体皮肤/面部皮肤/衣服/配饰六分类），本地 WASM 推理 |
| 精准度增强 | 分块精修 + 导向滤波 + 分类感知增益 + 滞后阈值二值化 + 连通域清理 + 发丝混色净化与间隙透底（详见「技术要点」） |
| 一键换底 | 白 / 红 / 蓝 / 亮蓝 / 深蓝 / 灰 + 自定义色 |
| 手动修补 | 笔刷修补（恢复人像）/ 擦除（清除背景），大小可调（`[` `]` 快捷键），支持 Ctrl+Z 撤销与重置蒙版 |
| 取景缩放 | 抠图预览支持滚轮/双指自由缩放、空格或中键拖动平移，放大后笔刷坐标自动换算回工作分辨率 |
| 规格模板 | 一寸 / 小二寸 / 二寸 / 大二寸 / 护照 / 签证 / 驾驶证 / 社保照（8 种，含毫米尺寸与 300DPI 像素） |
| 裁剪调整 | 拖动平移、滚轮/双指缩放，头顶线 / 眼线 / 下巴线参考线，一键智能对齐（`重置布局`） |
| 单张导出 | PNG（写入 pHYs）/ JPEG（写入 JFIF 密度，质量 50–100% 可调），真实 300DPI 元数据 |
| 图片转换 | JPG / PNG / WebP 批量互转 · 质量可调 · 透明区域填充 · 多张打包为 ZIP 一次保存 |
| 图片压缩 | 批量压缩图片体积：质量滑杆（50–100%）· 最长边等比缩小（只缩不放，4K/2K/1080P/720P 档）· 保持原格式或统一转 JPG/WebP · 逐张对比压缩前后大小 · 多张打包 ZIP |
| 图片合成 | 横向 / 纵向拼接 · 网格拼图 · 间距与底色可调 · PNG 无损保存 |
| 相纸排版 | 六寸横版 / A4 / B5 / A5 / A3 竖版（5 种，300DPI），可设 0–40px 间距与裁切线开关 |
| 批量排版 | 多选导入照片按序逐格排布，每张可设 1–4 份，超出单版自动分页并可逐页预览下载 |
| 直接打印 | 桌面版枚举系统打印机、发送任务，支持纸张（A4/B5/A5/A3/Letter/4×6）、方向、边距、份数与打印机属性 |
| 批量打印（图片） | 批量工具子功能：多选导入、单张 0/90/180/270 旋转、逐张勾选，按所选纸张 contain 适配整批一次发送（合并单任务，避免驱动逐任务弹确认框） |
| 文档打印 | 文档工具子功能：PDF / TXT / DOCX 列队逐份或合并单任务打印，支持单双面；pdf.js / mammoth 本地渲染，断网可用 |
| 压缩工具 | 7z / ZIP 压缩（密码、7z 加密文件名、四档等级、7z 分卷 1–100 MB、输出到桌面自动命名）· 压缩包内容浏览（路径/大小/修改时间，支持加密包）· ZIP / RAR / 7z / tar / gz 等 16 种格式解压（可选桌面同名文件夹）· 内置 7z 引擎（LGPL）· 进度实时回传、错误中文化 · 压缩包图标关联（无压缩软件电脑一键注册 .7z/.zip 图标，可还原） |
| 批量重命名 | 文件夹级批量改名（照片/文档/自定义后缀过滤）：规则编号（基础名 + 分隔符 + 起始序号 + 位数）与逐行自定义名可混用；照片类型显示缩略图并支持点击放大预览；自然排序（图2 排在图10 前）；冲突逐行标注并跳过（目标已存在 / 链式冲突 / 批内重名 / 非法字符 / 系统保留名）；File System Access API 本地完成，优先原生原子 `move`；「清空」一键释放缩略图缓存与全部状态 |
| 批量去除水印 | 预览图拖拽框选水印区域（选区按比例应用到整文件夹）· 模糊 / 像素化 / 纯色覆盖 / 周边取色填充 · 强度可调 · 另存为「-无水印」或覆盖原文件 |
| 批量格式转换 | JPG / PNG / WebP / PDF 批量互转 · 质量可调 · 透明区域填充 · PDF 可合并为单文件或逐图单页 · 输出到子文件夹「转换输出」不动原文件 |
| 网络检测 | 系统工具子功能：本机网卡信息（接口 / IPv4·IPv6 / MAC）· 公共 DNS 节点 TCP 连通与延迟检测 · 域名解析测试，结果三态汇总（正常 / 不稳定 / 无法联网）；桌面版仅连固定白名单节点，连接即断、不上传任何数据；浏览器模式禁用并提示 |
| 添加打印机 | 系统工具子功能：本机打印机列表（含默认打印机标记）· 一键打开系统「添加打印机」向导与「打印机和扫描仪」设置页 · 打印测试页（打印机名经本机枚举白名单校验）；浏览器模式禁用并提示 |
| 文档转换 | 文档工具子功能：PDF → 图片（JPG / PNG，1x / 1.5x / 2x 倍率，逐页单图）· 图片 → PDF（合并为单文件或逐图单页，原始尺寸或 A4 居中适印）· Word → PDF（.docx 简化版式转 A4 纵向 PDF）· 输出到「转换输出」子目录不动原文件 |
| PDF 工具 | 文档工具子功能：多 PDF 按列表顺序合并为单个文件 · 页码范围拆分提取（如 1-3,5,8-，支持开口区间）· 体积压缩（三档强度重编码，显示前后体积对比）· 处理后页面为图像（文字不可再选中） |
| 文档加水印 | 文档工具子功能：PDF 与图片（JPG / PNG / WebP）批量加文字或图片水印 · 文字水印含内容 / 字号 / 颜色 / 不透明度 / 旋转角，图片水印含缩放与透明度 · 九宫格定位或 1–8 列平铺防删除 · PDF 逐页栅格化重建（水印不可单独剥离），图片保持原格式（PNG 保留透明）· 实时预览 · 输出到「加水印输出」子文件夹不动原文件 |
| OCR 文字识别 | 文档工具子功能：图片（JPG / PNG / WebP / BMP）与扫描 PDF 提取可编辑文字 · 内置 Tesseract LSTM 离线引擎（SIMD 自适应，首次识别加载内核）· 简体中文 + 英文语言包三选 · **按症状自动增强**（小字放大 / 低光照拉伸与锐化 / 暗底反色归一，清晰件不盲目二值化）· **版面保真**（段落重建 + 首行缩进、词级表格检测与逐列对齐/列宽还原）· **A4 固定版心结果区，竖向 / 横向切换**（识别完成自动匹配原件方向）· 结构化字段提取（身份证号校验与混淆位纠错 / 手机号 / 日期）· 结果可编辑 · 一键复制 · 导出 TXT / DOCX（真表格 + 缩进，页面方向随版心）/ **Excel**（每张表格一个工作表，保留行列、数值类型与逐列对齐）· 全程本机完成，断网可用 |
| 主题与偏好 | 系统工具 → 设置：深色 / 浅色主题切换（即时生效、刷新保持）· 启动时进入首页或上次使用的模块 · 设置记忆占用显示与一键恢复默认 · 关于信息（真实版本号取自主进程 / 运行模式自动识别 / 作者 / 许可） |
| 设置记忆 | 规格、底色、输出格式与 JPEG 质量写入 localStorage，下次启动自动恢复；设置带结构版本号（schema v2），旧版/浩玥旧键数据自动逐级迁移，迁移前自动快照备份（原子写、保留 3 份），失败回滚不丢原数据 |

## 操作流程

照片工具、批量工具与文档工具下设**子功能菜单**（首页工具卡片 / 模块标签 → 子菜单 → 具体功能），
其中证照生成与批量重命名为 4 步流程，其余子功能为单页操作；
系统工具的软件卸载 / 垃圾清理目前为「敬请期待」占位页。

**照片工具 → 证照生成**：上传 → 抠图换底 → 规格调整 → 导出

1. **上传**：点击 / 拖拽 / Ctrl+V 粘贴照片，自动加载模型并分割
2. **抠图换底**：选背景色，必要时放大画面用笔刷修补发丝与衣缘
3. **规格调整**：选证件规格，拖动缩放让人像对齐参考线
4. **导出**：下载单张成品照或六寸排版图，桌面版可直接打印

**排版模块**：选择模板 → 导入照片 → 预览导出 → 打印

1. **模板**：单张尺寸（可复用照片模块的 8 种规格）、每张份数、相纸、间距与裁切线
2. **导入**：多选本地照片，或一键「使用照片模块的成品」，可多次导入累加
3. **预览**：查看整版排版结果、翻页、下载排版图（含 300DPI 元数据）
4. **打印**：选打印机与纸张/方向/边距/份数，先看纸张模拟预览再发送

**批量工具 → 批量重命名**：选择文件夹 → 设定规则/自定义名 → 预览 → 执行重命名

1. **选择**：授权一个本地文件夹，按类型过滤（全部 / 照片 / 文档 / 自定义后缀），文件按自然序排列
2. **命名**：规则自动编号（基础名 + 分隔符 + 起始序号 + 位数），也可在「新文件名」列逐行输入自定义名
   （留空 = 自动编号，清除输入即恢复），冲突行实时标红并将在执行时跳过
3. **预览**：照片类型显示缩略图，点击可放大预览；摘要栏统计待重命名与冲突数量
4. **执行**：确认后逐个原子重命名并汇报结果；「清空」释放缩略图缓存并复位全部状态

**批量工具 → 批量打印（图片）**：选择图片 → 设置参数 → 打印

1. **图片**：经主进程文件对话框多选本地图片，列表中可旋转（0/90/180/270）、逐张勾选/取消
2. **参数**：选择打印机、纸张（A4/B5/A5/A3/Letter/4×6）、方向、边距、份数
3. **打印**：整批合并为一次任务发送；浏览器模式提示改用桌面版

**文档工具 → 文档打印**：选择文档 → 设置参数 → 打印

1. **文档**：多选 PDF / TXT / DOCX——PDF 经 pdf.js 本地渲染、DOCX 经 mammoth 提取文本统一排版、
   TXT 原生解码分页，渲染全程在本机完成
2. **参数**：选择打印机、纸张（A4/B5/A5/A3/Letter/4×6）、方向、边距、单双面与份数
3. **打印**：可选列队逐份打印或合并单任务；浏览器模式提示改用桌面版

**文档工具 → OCR 文字识别**：选择文件 → 识别 → 校对编辑 → 导出

1. **文件**：多选图片（JPG / PNG / WebP / BMP）或扫描 PDF，选语言包（中文 + 英文 / 仅中文 / 仅英文）
2. **选项**：默认开启「自动图像增强」（针对模糊、倾斜、低光照与复杂背景自适应处理）；结果模式可选
   「智能排版（表格还原）」或「纯文本」
3. **识别**：首次自动加载本地识别内核（约 12 MB，仅首次较慢），PDF 逐页栅格化识别，进度实时显示；
   完成后按原件方向自动把 A4 版心切为竖向或横向（可手动切换），状态行给出平均置信度、增强动作与表格还原提示
4. **导出**：结果在 A4 版心内可直接编辑，一键复制或导出 TXT / DOCX / Excel——DOCX 保留真表格、首行缩进与页面方向；
   Excel 每张表格一个工作表，保留行列、数值类型与逐列对齐

**压缩工具**：选择文件/文件夹 → 设定格式与密码 → 执行；或选择压缩包 → 解压

1. **压缩**：多选文件或选择整个文件夹（自动去重），可选 7z / ZIP 格式、四档等级
   （存储/快速/标准/极限）、密码；7z 格式还支持加密文件名；「压缩到」可选原目录或桌面（自动命名）
2. **解压**：选择一个或多个压缩包（自动识别 16 种格式），逐个解压到压缩包所在目录的
   子文件夹、原目录或桌面同名文件夹，密码包输入密码即可
3. **进度**：压缩/解压进度实时显示，失败时给出中文原因（密码错误 / 空间不足 / 文件被占用等）；
   浏览器模式无 7z 引擎，面板提示并禁用
4. **压缩包图标**：没装任何压缩软件的电脑上 .7z / .zip 显示白板图标时，可在压缩工具菜单
   「压缩包图标」一键注册（用户级注册表、无需管理员，不覆盖已有关联，可一键还原）

## 目录结构

```
zunhongbox/
├── index.html              # 入口页面（七模块 DOM + 子功能菜单 + 脚本引入顺序）
├── electron/               # Electron 主进程（桌面版）
│   ├── main.js             # 窗口、内置静态服务、CSP、打印/压缩 IPC、文件字节读取
│   ├── preload.js          # contextBridge 暴露 zunhongPrint / zunhongArchive / zunhongArchiveIcons / zunhongDiag / zunhongSystem / zunhongApp（白名单 IPC）
│   ├── static-server.js    # 随机端口本地静态服务（路径穿越防护 + 正确 MIME）
│   ├── print-doc.js        # 多页打印文档构建（合并单任务发送）
│   ├── archive.js          # 压缩/解压 IPC 层（对话框/入参校验/进度回传/通道注册）
│   ├── archive-engine.js   # 7z 引擎层（定位/跑子进程/取消/并发哨兵，不碰 IPC 与对话框）
│   ├── archive-icons.js    # 压缩包图标关联（HKCU ProgID 探测 / 注册 / 还原，白名单扩展名）
│   ├── update.js           # 版本标记与数据备份（升级/回滚识别、userData 备份原子写与恢复 IPC）
│   ├── system.js           # 系统工具 IPC：网络检测（白名单 DNS 节点）+ 打印机向导/设置页/测试页
│   ├── 7z-args.js          # 7z 命令行参数构建与输出解析（纯逻辑，可单测）
│   └── bin/                # 内置 7z.exe + 7z.dll（LGPL，打包注入 resources/bin）
├── assets/                 # 品牌图标（源自尊泓 logo）+ 安装器图标（src-setup-icon.png / setup-icon.ico）
│                           #   + installer.nsh（NSIS 安装器自定义钩子）
├── css/style.css           # 暗色主题响应式样式
├── js/
│   ├── specs.js            # 证件规格模板库（8 种 + 头部参考线比例）
│   ├── dpi.js              # PNG pHYs / JPEG JFIF DPI 元数据注入
│   ├── zip.js              # 零依赖 ZIP 打包（UTF-8 文件名 + CRC32）
│   ├── segmenter.js        # 人像分割与精准度增强管线
│   ├── composer.js         # 换底合成引擎 + 相纸排版引擎（5 种相纸）
│   ├── brush.js            # 蒙版修补/擦除笔刷 + 单通道快照（撤销）
│   ├── matteview.js        # 抠图视图自由缩放/平移
│   ├── cropper.js          # 裁剪拖动/缩放与智能对齐
│   ├── app.js              # 核心状态 + 照片流程（4 步状态机）+ 模块/子功能切换
│   ├── convert.js          # 图片转换（JPG/PNG/WebP 互转 + ZIP 打包）
│   ├── compose.js          # 图片合成（横向/纵向/网格拼接）
│   ├── batch.js            # 批量重命名（计划构建/冲突检测/缩略图/自定义名）
│   ├── batch-watermark.js  # 批量去除水印（框选 + 模糊/像素化/取色填充）
│   ├── batch-format.js     # 批量格式转换（含 PDF 合并/单页）
│   ├── print-batch.js      # 批量打印：图片（批量工具）+ 文档打印（文档工具，pdf.js / mammoth / TXT 分页）
│   ├── archive.js          # 压缩工具渲染层（选择/参数/进度，7z 经主进程）
│   ├── settings.js         # 用户设置持久化（结构版本 v2 迁移框架：迁移前备份 / 失败回滚 / 白名单序列化）
│   ├── system.js           # 系统工具渲染层（网络检测/添加打印机面板 + 浏览器降级）
│   ├── sheet.js            # 排版流程（4 步：模板 → 导入 → 预览 → 打印）
│   ├── print.js            # 直接打印（IPC 面板、纸张参数、打印预览）
│   ├── docs-watermark.js   # 文档加水印（文字/图片水印 · 平铺定位 · FSA 输出）
│   ├── pdfcore.js          # 文档工具共享 PDF 核心（pdf.js 渲染/编码/FSA 写入/页码解析）
│   ├── docs-convert.js     # 文档转换（PDF→图片 / 图片→PDF / Word→PDF）
│   ├── docs-pdf.js         # PDF 工具（合并 / 拆分提取 / 体积压缩）
│   ├── docs-reader.js      # PDF 阅读器（翻页 / 缩放 / 页码跳转 / 整本打印）
│   ├── ocr-enhance.js      # OCR 图像增强与版面还原（纠偏 / 二值化 / 纠错 / 表格对齐 / 段落缩进）
│   ├── xlsx-lite.js        # 零依赖 SpreadsheetML 生成（表格结构化导出 Excel）
│   └── docs-ocr.js         # OCR 文字识别（懒加载 Tesseract · 增强 · 版面还原 · A4 版心 · TXT/DOCX/Excel 导出）
├── vendor/
│   ├── mediapipe/          # 本地化的模型与 WASM 运行时（离线关键）
│   ├── print/              # pdf.js（Apache-2.0）+ mammoth（BSD-2-Clause）本地化
│   └── ocr/                # Tesseract LSTM 离线识别引擎 + 简体中文/英文语言包（Apache-2.0）
├── tools/
│   ├── server.js           # 浏览器模式静态服务（默认 8410，可用 PORT 覆盖）
│   ├── _lib.cjs            # 测试公共库（端口、浏览器、断言计数、照片解析）
│   ├── check-refs.cjs      # index.html 脚本与模型引用完整性校验（npm test 首步）
│   ├── test-*.cjs          # 纯算法 / 冒烟测试（npm test 26 项，含真实 7z 冒烟、主进程白名单假件、IPC 契约、
│   │                       #   版本标记与备份恢复全链路 test-update、OCR 增强 test-ocr-enhance、Excel 生成 test-xlsx-lite）
│   ├── verify-*.cjs        # Playwright 端到端（分割/换底/缩放撤销/排版打印/压缩/批量打印/批量工具/
│   │                       #   OCR 真机识别 + 版面还原 + DOCX/XLSX 打包 + A4 版心方向切换）
│   ├── eval-ocr.cjs        # OCR 精度评测（8 类合成场景 · CER/命中率/F1/行召回/单元格/耗时 · 前后对比）
│   ├── verify-output.cjs   # 检查导出 PNG 的尺寸与 pHYs（DPI）
│   └── make-icons.cjs      # 图标生成（jimp：src-icon.png → icon.ico/png；src-setup-icon.png → setup-icon.ico，支持 --out）
├── fixtures/               # 本地测试照片（gitignore，勿提交真人照片）
├── start.bat               # 浏览器模式一键启动
└── package.json            # 脚本命令与 electron-builder 打包配置
```

## 技术要点

### 分割与蒙版生成

- **模型选择**：优先 `selfie_multiclass_256x256.tflite`（六分类，头发/衣服细分，人像 = 1 − 背景置信度），
  加载失败自动回退 `selfie_segmenter.tflite`（float16 二分类）。
- **工作图限边**：长边上限 1600px，兼顾内存与发丝有效分辨率。
- **分块精修**：长边 ≥800px 时切 512px 重叠瓦片（重叠 96px）逐块推理——模型内部只把单块缩到 256，
  而非整图缩到 256，发丝/衣缘有效分辨率成倍提升；瓦片按到边距离加权融入粗分割结果，过渡无接缝。
- **分类感知增强**：头发主导像素置信度 ×1.3、衣服主导 ×1.25（白衣服与浅背景难分，模型置信度天然偏低），
  并同步下调这两类像素的有效阈值；头发区再用小半径导向滤波吸附单根发丝。
- **脸部保护**：保留脸部专属置信度通道，以较小的增益保护脸颊、耳部等轮廓，不修改原图肤色或五官。
- **轮廓定位**：滞后阈值（强 0.5 / 弱 0.35，分类增益区逐像素下调、下限 0.15），
  强阈值定种子、弱阈值沿八邻域连通生长，保留斜向细发丝；浮点双线性插值避免置信度量化损失。
- **清理**：3×3 多数值滤波保留已有发丝的连通端点，不向背景膨胀；贴边修补与孔洞填充须有前景置信度支持，
  避免误填发丝间、手臂间的真实背景。连通域清理保留最大人像域及面积达其 3% 的次级域。
- **边缘透明度**：在轮廓窄带内，用附近可靠前景/背景的 RGB 反解连续 alpha，减少发梢硬切。
  脸部与衣服仅在紧邻轮廓处处理，保护主体高光和浅色花纹；颜色方程无解（前背景近似同色）时，
  发丝改按 5×5 前景覆盖率柔边，其余情形保留语义轮廓原值。
- **发丝混色净化**：对反解出的半透明发丝像素按 `F = C + k·(C − B)`（k = (1−α)/α，上限 1.5）
  去除原背景染色，B 取逐像素局部背景色场，因此换任何底色都不留原墙色光晕；
  只改半透明轮廓像素（实测约 0.65% 画面），不动人像主体、原背景与不透明像素。
- **发丝间隙透出底色**：与画面外背景连通、且明显更接近背景色而非发色的窄通道判为真实间隙，
  alpha 归零；孤立亮斑、人像置信度 ≥0.6、模型判为衣服/脸部、以及非头发包围区一律不动，
  清除面积超过画面 2% 时整体放弃，避免吃穿浅色衣领与头发高光。
- **蒙版约定**：`maskCanvas` 只用到 alpha 通道（白色=人像，透明=背景，半透明=细发丝/轮廓过渡），合成时与前景按 alpha 相乘。

### 合成、排版与导出

- **共享变换**：预览与导出共用同一变换模型 `x_out = x_work × scale + tx`，笔刷直接编辑工作分辨率蒙版，
  导出时按需重合成保证清晰度。
- **排版引擎**（`composer.js`）：`bestLayout` 穷举列×行组合取容纳最多、留白最小者（不旋转，保持正立）；
  `layoutSheet`/`layoutGroups` 单张成品铺满整版（多人时可纵向分组），
  `layoutBatch` 批量逐格填入、超量自动分页，`layoutExact` 精确张数居中排版；
  `PAPERS` 提供六寸/A4/B5/A5/A3 五种相纸像素尺寸（均按 300DPI）。
- **DPI 元数据**：PNG 手工注入 pHYs 块（含 CRC32），JPEG 修补/插入 JFIF APP0 密度字段，
  打印软件可识别真实物理尺寸；排版图统一写入 300DPI。
- **撤销快照**：单通道 `Uint8Array`（1 字节/像素，较 RGBA ImageData 降至 1/4），
  按蒙版像素数动态限制层数（16MB 预算，最少 3 层、最多 12 层）。

### 桌面版（Electron 44）

- 主进程禁用 GPU（`disable-gpu` / `disable-gpu-compositing` / `in-process-gpu`），规避部分集显驱动下
  WebGL/WASM 推理黑屏；单实例锁防止重复打开。
- 页面由内置随机端口 `127.0.0.1` 静态服务提供，响应头注入 CSP；`preload.js` 通过 contextBridge
  仅暴露打印 / 压缩 / 图标关联等白名单 IPC 方法，不开放 Node 能力。
- 打印：`print:listPrinters` 枚举、`print:printImage` 经隐藏沙箱窗口发送任务（可指定纸张尺寸、
  方向、边距、份数、单双面；B5/4×6 走微米自定义尺寸）、`print:showProperties` 调系统打印机属性对话框。
- 压缩：`electron/bin/7z.exe` 随包分发（extraResources → `resources/bin`，未打包时回退系统 7-Zip），
  渲染层经 `zunhongArchive` 白名单桥接发起压缩/解压，进度经 `archive:progress` 回传。
- 安装与更新：`assets/installer.nsh` 经 electron-builder `nsis.include` 注入安装器，
  定义 `customCheckAppRunning` 在覆盖安装/卸载前静默强杀残留旧进程（按安装目录精确匹配，
  不误杀别处运行的便携版）；`electron/update.js` 维护 `version-marker.json`（原子写、损坏自愈）
  识别升级/回滚，备份 IPC（`app:backupData` / `app:readBackup` 等）经 `zunhongApp` 桥暴露，
  备份文件名白名单 + 路径穿越防护。

### 压缩工具（7z）

- 压缩与解压均由内置 7z.exe 完成，命令行参数由 `7z-args.js` 纯函数构建、`spawn` 数组传参不经 shell，
  密码等用户输入无注入风险；`-bsp1` 进度走 stdout 逐段解析百分比，退出码 0/1 视为成功，
  其余映射中文错误文案（校验失败 / 空间不足 / 文件被占用等）。
- 压缩支持 7z / ZIP 两种格式、四档等级（store / fast / normal / max）与密码；
  ZIP 密码用 AES-256（`-mem=AES256`），仅 7z 支持加密文件名（`-mhe=on`）；
  输出已存在先删除重建，避免 `a` 更新模式残留旧条目。
- 解压支持 16 种常见格式（7z / zip / rar / tar / gz / xz / cab / iso / jar / deb / rpm…），
  `-y` 自动确认覆盖避免交互挂起；默认解压到压缩包所在目录的子文件夹（可选原目录）。
- 压缩包图标关联（`electron/archive-icons.js`）：以用户级（HKCU，无需管理员）ProgID 把
  .7z / .zip 的 DefaultIcon 指向随包 `7z.dll` 内置格式图标（资源索引 0=7z、1=zip，与
  7-Zip 官方安装器注册值一致）；只接管完全无关联的扩展名（HKCR 无 ProgID 且无 UserChoice），
  绝不覆盖既有关联；注册前备份原默认值，可一键精确还原；扩展名经白名单过滤（仅 7z/zip）
  防任意注册表键路径拼接，reg / ie4uinit 等系统工具一律 System32 绝对路径调用。

### 批量打印（图片 + 文档）

- 图片：多选导入 → 单张 0/90/180/270 旋转 → 按所选纸张 contain 适配（不放大只缩小）→
  整批合并一次打印任务发送（沿用多页合并单任务机制，避免驱动逐任务弹确认框）。
- 文档：PDF 经 pdf.js 本地渲染（2.5 倍率 ≈180dpi，2400px 宽上限防内存失控），
  DOCX 经 mammoth 提取文本后按 A4 统一排版分页，TXT 原生 UTF-8 解码折行分页；
  列队模式每文档一个任务，合并模式全部页合为一个任务；均支持单双面
  （simplex / longEdge / shortEdge，经 `webContents.print` 的 `duplexMode`）。
- 沙箱渲染层无 fs 能力，文件字节经主进程 `print:readFile` 读取
  （白名单扩展名 + 200MB 上限，ArrayBuffer 经 IPC 结构化克隆传输）。

### OCR 文字识别（Tesseract LSTM + 本地增强与版面还原）

- **引擎构成**：`vendor/ocr/` 内置 tesseract.js v5（Apache-2.0）——主线程加载器 `tesseract.min.js` +
  Worker 脚本 `worker.min.js` + 双 wasm 识别内核（SIMD / 非 SIMD 各一套 LSTM 专用核心，运行时按
  CPU 支持自适应加载）+ 简体中文 / 英文 traineddata 语言包（best_int 精度档）。
- **懒加载**：脚本标签仅加载主线程加载器（约 60KB），首次点「开始识别」才创建 Worker 并加载内核与
  语言包；切换语言包经 `reinitialize` 复用已加载的 wasm 内核，不重复初始化。
- **路径解析**：tesseract.js 在 blob: Worker 内 `importScripts` / `fetch`，相对路径无法解析，
  workerPath / corePath / langPath 均经 `new URL(p, location.href)` 转绝对 URL。
- **输入预处理**（`js/ocr-enhance.js`）：图片经 `createImageBitmap` 解码后按长边智能缩放——不足 1000px 放大
  2–3 倍（小图提升识别率）、超过 2600px 降采样（更大的图对准确率无益且耗时耗内存）；PDF 经 pdfcore
  逐页栅格化（2x 倍率、长边 ≤2000px）后走同一条管线。
- **质量门控多通道识别**（实测结论驱动，详见 `docs/ocr-accuracy-optimization.md`）：**先跑原图直识**（基座
  PSM 6，最快且多数场景最优），仅在质量信号差时启用像素变体，且每个变体需评分超过当前 5% 才采纳：
  - 小字（行高 <18px，或 <24px 且画布长边 <1200）→ 2 倍放大重识别；
  - 低置信（<55）或整体偏暗（均值 <200）→ 灰度增强（倾斜纠偏 / 百分位对比度拉伸 / 模糊锐化）；
  - 暗底或反色底（均值 <110）→ 二值化 + 极性归一；
  - 仍严重劣化（置信 <60 或行数 ≤2）→ AUTO(3) / 稀疏(11) 备选分页模式。
  增强管线本身含：投影剖面倾角估计（粗扫 2° + 细化 0.25°）与剪切纠偏、百分位对比度拉伸、拉普拉斯方差
  判模糊后 unsharp、Sauvola 自适应二值化（积分图 O(n)，窗口取短边 20% 钳制 31–151px——窗口小于笔画宽度会
  导致笔画内部标准差趋零、阈值跌破墨值而镂空）、3×3 孤点去噪。整条增强在 2600×2000 图上约 260ms。
- **表格单元格重识别**：低置信（<70）且为数字型的单元格按 bbox 裁剪后以单行模式（PSM 7）重识别，需置信
  提升 ≥10 且达 75、字数比 0.8–1.25 才采纳，单页预算 60 格；中文短格不参与（实测裁剪粒度不足会导致
  `摊→难` 这类"置信更高但更错"的替换）。
- **参数卫生**：Tesseract worker 的分页模式是有状态的，每次识别显式指定 PSM、单元格重识别后重置，避免
  跨文件"参数泄漏"导致同图不同结果。
- **识别与版面模型**：`recognize` 显式索取 `text + blocks`（词级 bbox 与置信度），由此构建**结构化文档模型**
  `{blocks: [段落 | 表格]}`——文本视图与 DOCX / Excel 导出共用同一份模型，避免各导出路径各算一遍：
  - **表格检测**：词级 bbox 按 y 聚行、按 x 聚列（容差取词宽中位数），行/列支持率与填充率达标才认定表格；
    逐列以 x0 / x1 / 中心的离散度最小者推断左 / 中 / 右对齐，列宽取列内最大水平跨度；
  - **段落重建**：行距 > 0.75 倍行高即分段，同段内按 CJK 无缝连接、西文以空格连接；段首相对页面左缘
    偏移 > 1.2 倍行高判定首行缩进；
  - **后处理**：全半角归一、中文间冗余空格压缩、标点空格整理；数字上下文纠错（O/Q/D→0、I/l→1、Z→2、
    S→5、B→8、G→6，仅命中含真实数字的字母数字串，`ZOO` / `OK` 等纯字母词不受影响）；身份证号按
    GB 11643-1999 权重校验，校验失败时逐位尝试混淆替换、**唯一解才纠错**；另提取手机号与日期。
- **A4 固定版心结果区**：结果区按 A4 比例固定（竖向 210:297、横向 297:210，CSS `aspect-ratio` 宽度驱动、
  矮窗口两档降宽保比例），白纸黑字、超长内容在版心内滚动；识别完成按页面外接宽高比（> 1.2 判横向）
  自动匹配原件方向，可手动切换，方向同时决定 DOCX 页面尺寸。
- **导出**（零额外依赖，均经内置 `ZipUtil` store 打包）：
  - **TXT**：`Blob` 直接下载；
  - **DOCX**：最小 OOXML 包（`[Content_Types].xml` + `_rels/.rels` + `word/document.xml`）——表格输出
    真 `w:tbl`（`tblGrid` 列宽按相对宽度分配至 A4 版心 9026 twips、单元格 `w:jc` 保留对齐、六向单线边框），
    段落输出 `w:ind firstLine=480` 缩进，`sectPr` 页面尺寸随版心方向（横向为 `16838×11906 + orient=landscape`）；
    表格为正文末块时按 OOXML 要求补尾随空段落；用户编辑过文本后回退纯文本段落导出，以人工修改为准；
  - **Excel**：最小 SpreadsheetML 包（`js/xlsx-lite.js`）——每张表格一个工作表（表名取文件标签、非法字符清洗、
    ≤31 字符、重名追加序号）；单元格定位到行列引用，纯数字（≤11 位且非 0 开头）写数值 `<v>`，证件号等
    长编号保持文本（规避 Excel 15 位精度截断），文本一律 `inlineStr`；逐列对齐写入 `cellXfs`（表头行加粗），
    列宽由相对像素宽度换算为 Excel 字符宽。

## 开发与测试

```bash
npm test          # 纯算法 + 静态服务 + jsdom 冒烟（26 套件，无需浏览器；test-archive 含真实 7z 冒烟，
                  # test-system 以假件覆盖主进程系统工具白名单，test-ipc-contract 校验桥接与 IPC 注册一致，
                  # test-update 覆盖版本标记 / 启动类型识别 / 备份原子写与恢复全链路，
                  # test-ocr-enhance / test-xlsx-lite 覆盖 OCR 增强管线、版面还原与 Excel 生成）
npm run verify    # Playwright 端到端：人像细节 / 换底导出 / 缩放撤销 / 笔刷 / 排版打印 / 压缩 / 批量打印 /
                  # OCR 真机识别（含退化图增强链路、DOCX/XLSX 打包、A4 版心方向切换）
                  # 末尾 verify-packaged 会驱动打包产物（win-unpacked）做真实启动冒烟，无产物自动跳过
npm run lint      # ESLint 静态检查（js/ electron/ 严格，tools/ 放宽）
npm run eval:ocr  # OCR 精度评测：8 类场景的 CER / 字符命中率 / 行召回 / 单元格准确 / 耗时（需 Chromium）
npm run format    # Prettier 格式化（按需，未对历史代码全量重排）
npm run icons     # 重新生成图标（加 -- --out <dir> 可避免覆盖成品图标）
```

版本变更见 [CHANGELOG.md](CHANGELOG.md)；OCR 增强管线、版面模型与导出格式的技术说明见
[docs/ocr-enhancement.md](docs/ocr-enhancement.md)；**OCR 精度诊断、参数配置、评估指标与场景样例见
[docs/ocr-accuracy-optimization.md](docs/ocr-accuracy-optimization.md)**（实测数据由
[docs/ocr-eval-report.md](docs/ocr-eval-report.md) 记录，可运行 `npm run eval:ocr -- --write` 复现）；
v1.3.3 缺陷检测与三轮修复记录见 [docs/bug-report-v1.3.3.md](docs/bug-report-v1.3.3.md)；
发版流程：递增 `package.json` 的 `version` → 打 `v<version>` 标签推送，Actions 自动出安装包。

`npm run verify` 需要两项本地资源，均不入库：

- 测试照片：`fixtures/photo.jpg`（或环境变量 `ZUNHONG_PHOTO=<路径>`）——仅分割相关验证项
  （verify-hair / verify-matteview / verify-brush）需要；仓库不收录真人照片，请自行放置一张正面单人照。
  压缩 / 批量工具 / 批量打印验证（verify-archive / verify-batch / verify-print-batch）
  使用桥接 stub 与 OPFS 沙箱文件系统，无需样片；verify-output 无 E2E 产物时自动跳过。
- Chromium：项目内 playwright 若未下载浏览器，先执行 `npx playwright install chromium`；
  也可用 `ZUNHONG_CHROMIUM=<chrome.exe 路径>` 指向本机已有的浏览器。

### 持续集成与发布（GitHub Actions）

- **CI**（`.github/workflows/ci.yml`）：push 到 `main`、Pull Request 与手动触发时，
  在 ubuntu 与 windows 两个 runner 上跑 `node --check` 语法扫描与 `npm test`
  （含 `tools/check-refs.cjs` 的 index.html 脚本与模型文件引用完整性校验）。
  测试不启动 Electron，故以 `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 省掉二进制下载。
- **发布**（`.github/workflows/release.yml`）：推送 `v*` 标签触发，在 `windows-latest` 上
  先校验标签版本与 `package.json` 一致，再跑 `npm test` 门禁、`npm run dist` 打包，
  把 Setup 与便携版两个 exe 上传到对应 GitHub Release；`workflow_dispatch` 手动触发时
  只上传构建产物供试装，不建 Release。electron / electron-builder 下载目录做了缓存。
- **发布流程**：改动合并到 `main` → 在 PR 里递增 `package.json` 的 `version` →
  合并后 `git tag v<version> && git push origin v<version>` → Actions 自动出安装包。
- `npm run verify` 依赖真人样片与本机 Chromium，属本地验收，不进 CI。
- 依赖升级由 `.github/dependabot.yml` 每周一开 PR（npm 的 minor/patch 合并为一个分组，
  GitHub Actions 工作流单独跟踪）。

## 许可与致谢

- 本工具源码以 MIT 许可发布（`package.json` 中 `license: MIT`），作者：老高 · QQ 846193。
- 人像分割能力来自 [Google MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter)：
  `vendor/mediapipe/vision_bundle.js`（MediaPipe Tasks Vision JS/WASM 运行时）与
  `selfie_multiclass_256x256.tflite`、`selfie_segmenter.tflite` 模型均由 Google 提供，
  遵循 **Apache License 2.0**；模型与运行时随本仓库本地化分发以满足离线运行要求，
  著作权归 Google 所有。第三方库版本登记见 `VENDOR.md`。
- 压缩能力来自 [7-Zip](https://www.7-zip.org/)：内置的 `electron/bin/7z.exe` 与 `7z.dll`
  遵循 **GNU LGPL**（含少量 BSD 组件），随安装包分发以满足离线压缩/解压需求；
  7-Zip 著作权归 Igor Pavlov 所有。
- 文档打印渲染来自 [pdf.js](https://mozilla.github.io/pdf.js/)（Mozilla Foundation，**Apache License 2.0**）
  与 [mammoth.js](https://github.com/mwilliamson/mammoth.js)（Mike Williamson，**BSD-2-Clause**），
  运行时本地化至 `vendor/print/` 以满足离线运行要求。
- OCR 文字识别能力来自 [Tesseract](https://github.com/naptha/tesseract.js)
  （tesseract.js 及 tesseract.js-core，**Apache License 2.0**）及其内置的 Tesseract OCR 引擎
  与简体中文 / 英文 traineddata 语言包，本地化至 `vendor/ocr/` 以满足离线识别要求；
  Tesseract 著作权归 Tesseract OCR 社区（原 HP / Google）所有。
- Electron、electron-builder、jimp、jsdom、Playwright 为开发/打包期依赖，各自遵循其开源许可。

## 注意

- 分割质量取决于原图：建议正面、光线均匀、背景与人像区分度较高的照片。
- 人像分割模型对多人物场景取整体人像区域，请使用单人照。
- 排版模块不做抠图，导入的照片按原样 cover 裁切到目标尺寸；需要换底请先在照片模块完成。
- OCR 识别率取决于原图质量：手写体、艺术字与极低分辨率（短边 < 300px）图片效果有限；图像增强会自动
  纠偏与提升弱光对比度，但对严重失焦或大面积遮挡无法复原。表格识别按对齐的网格推定，无框线且列间
  留白极小的排版可能被判为段落。「导出 Excel」仅在本次识别检测到表格时可用；导出的表格为纯数据网格，
  不还原框线样式、单元格合并与公式。
