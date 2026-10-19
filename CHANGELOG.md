# 更新日志

本项目所有显著变更记录于此。版本号遵循语义化版本（主版本.次版本.修订号）。

## [未发布]

### 修复
- **修复中文打印机名「默认打印机」徽标永不显示**：windowsDefaultPrinter 经 execFile 调 PowerShell 未指定输出编码，中文 Windows 的 PowerShell 5.1 管道输出走 OEM 代码页（GBK 936），Node 按 UTF-8 解码成乱码，与 Electron 枚举的 Unicode 打印机名永不相等（英文名不受影响，故测试环境从未暴露）。现 `-Command` 前强制 `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;`（electron/main.js；真机探针证实：无前缀输出 GBK 字节 bb dd c6 d5 解码为乱码，加前缀输出 e6 83 a0 e6 99 ae 正确得「惠普」）
- **修复 7z 进度被文件名中「数字+%」劫持**：parseProgress 取 chunk 内最后一个百分比，而 -bsp1 进度行自带当前文件名（如「100%完成.txt」），含 % 的文件名会让进度跳错（41b51b3 修帧滞留时引入的回归）。现按 \r|\n 切分取最后一个非空段、行首锚定匹配百分比（electron/7z-args.js；test-archive 新增 3 断言）
- **修复打印机属性对话框被 15 秒超时强关**：print:showProperties 的 execFile timeout 到期即 kill 子进程，而 rundll32 托管的属性对话框在用户交互期间常驻，用户设置到一半被强关且 IPC 还回失败态。现改 spawn 不设超时（electron/main.js）
- **修复 PDF 工具合并/拆分、文档转换图片合并的批量静默中止**：runMerge/runSplit 与图片合并分支此前无 per-file try/catch，单个坏文件（损坏/加密 PDF、改扩展名的假 JPEG、0 字节图）的 rejection 直达全局兜底，状态行卡死、结果列表全空、用户无从知道哪个文件失败。现按 runShrink 范式逐文件 try/catch + 失败结果行 + 精确状态行（js/docs-pdf.js、js/docs-convert.js）
- **修复网络检测 DNS 解析测试无超时**：dnsProbe 未设超时（tcpProbe 有 3s），系统解析器挂起时 netProbe IPC 无限期不返回。现补 3s 超时兜底（electron/system.js）
- **修复静态服务监听失败时应用静默变僵尸**：createWindow 失败（极端端口耗尽）只落一条日志，无窗口、无退出、用户面对空白。现 whenReady 链补 .catch：诊断日志 + 弹窗告知 + app.quit()（electron/main.js）
- 次要修复：compress/extract 入口 payload 空值防护；listArchive 取消路径补 cancelled 标记（与 run7z 一致）；js/system.js 三个打印机操作补 IPC 异常 .catch、测试页加在途标志防连点向打印机多发；docs-watermark 预览与主管线统一走 core.loadPdf 并补 pdf.cleanup() 防文档句柄泄漏；「共 N 页」假数据改为「含 PDF N 个」诚实计数（it.pages 从未在选文件时读取，reduce 把图片也按 1 页计入）；docs-convert 删死代码 okN += 0
- **第二轮（P0/P1/P2 全清，详见 docs/bug-report-v1.3.3.md 第八节）**：
  - **修复 Word→PDF 末页垂直拉伸变形**：切片循环末页源高不足一页时被 drawImage 拉满整页 A4 目标高度（561px → 1684px 约 3 倍拉伸，末页文字变扁长），现按源高度等比缩放（js/docs-convert.js）
  - **修复加水印预览竞态与大 PDF 反复全量读盘**：250ms 防抖只延迟不取消，慢渲染后完成会覆盖新预览；且每次预览都对 PDF 全量重读盘（百 MB 扫描件拖一次滑块读一次）。现加 previewGen 代数丢弃过期回调 + pdfCache 同文件缓存，切文件/清空/进面板时释放文档句柄（js/docs-watermark.js）
  - **修复 OCR 异常时按钮永久锁死**：run() 循环后 joinUnits/updateMeta/exportsEnable 若抛错会跳过 disabled=false 复位，按钮永久禁用、running 永 true。现收尾包进 try + finally 复位（js/docs-ocr.js）
  - **修复文档三模块同名输出静默覆盖**：不同文件夹多选同名文件时后写覆盖先写且无提示。pdfcore 新增共享 uniqueOutName()（探测 FSA 目录已有则追加 _1…_99 后缀，批次内同样有效），docs-watermark / docs-convert / docs-pdf 全部写盘点改用（js/pdfcore.js 等三模块）
  - **修复 zip + 分卷组合静默产出错误结果**：buildCompressArgs 对 zip 不追加 -v，若绕过渲染层双保险直达 IPC 会丢分卷参数并返回 {ok:true,size:0,parts:1}，UI 显示「压缩完成（0 B）」。现主进程显式拒绝（electron/archive.js）
  - **修复 7z 失败后残留半成品**：密码错误/磁盘满/致命错误后输出位置残留截断的 .7z 或残缺分卷，与取消路径的清理策略不一致。现失败分支也 removeOutputs()（electron/archive.js）
  - **修复 listArchive 输出累积无上限**：超大/损坏包 -slt 输出可达数百 MB 压垮主进程。现封顶 64MB，超限杀子进程并明确报错（electron/archive.js）
  - **修复压缩/解压无并发哨兵**：渲染层 running 标志只能挡 UI 并发，IPC 可被 devtools 直连——两个 compress 并发会互相 removeOutputs 删掉对方产物。现模块级 archiveBusy 哨兵，第二个任务直接返回「已有压缩/解压任务进行中」（electron/archive.js）
  - **修复 7z 错误信息中文 Windows 乱码且乱码行覆盖中文说明**：随包 7z.exe 若为本地化构建，错误行走 OEM 代码页（GBK），按 UTF-8 解成乱码且优先级高于 exitCodeText。现 stderr 收 Buffer，先试 GBK 解码，UTF-8 含替换符判定乱码弃用、让 exitCodeText 兜底（electron/archive.js）
  - **修复 printImage 回调永不触发即永久泄漏**：webContents.print 回调未到（驱动挂起）时，隐藏窗口、printPages 路由、IPC promise 三者一起泄漏，渲染层按钮永久禁用。现加 60s 看门狗 destroy + 返回「打印超时」（electron/main.js）
  - **修复目录属性判定违反项目约定**：7z-args.js 的 `/\bD/` 改 `/^D/`（当前无行为偏差，规范对齐；electron/7z-args.js）
- **第三轮（advisory 全清，详见 docs/bug-report-v1.3.3.md）**：
  - **修复 print:readFile 同步读盘阻塞主进程事件循环**：原 fs.statSync/readFileSync 同步读最大 200MB 文件，读盘期间窗口无响应、IPC 全排队。现改 fs.promises 异步读（electron/main.js）
  - **修复 preload onProgress 重复绑定**：onProgress(null) 后再 onProgress(cb) 会因「callback===null 才绑定」判断重复注册 ipcRenderer 监听，每个进度事件双触发。现以独立 progressBound 标志保证监听器全局只绑一次（electron/preload.js）
  - **修复取消竞态边缘误报「7z 启动失败」**：cancel 后子进程可能先发 'error'（kill 导致）再 'close'，用户看到的是启动失败而非任务已取消。现 error 分支优先判 killedByUser，按已取消收场（electron/archive.js）
  - **修复对话框父窗口销毁竞态**：pickPaths/saveDialog 用 getWin() 未查 isDestroyed，窗口关闭竞态下把销毁窗口传给 dialog 会抛原生 Error。现对齐 system.js 的 isDestroyed 检查，退回无父窗口对话框（electron/archive.js）
  - **修复 7z 版本备注带出版权行**：check7z 版本号取整行（「7-Zip 26.03 (x64) : Copyright (c) …」），UI 备注冗长。现按整行匹配后在首个 ' :' 处截断，只保留「7-Zip 26.03 (x64)」（electron/archive.js）
- **第四轮（提交前三路独立审查补记：前端 / QA 各 1 项 blocking + 后端 advisory，全部就地修复）**：
  - **修复 pdfToPages 文档句柄泄漏（前端审查 blocking）**：js/docs-pdf.js 的 pdfToPages（runMerge/runShrink 共用）经 core.loadPdf 加载后从不 cleanup，而检测报告 P1-2 行「runMerge/runSplit 补 pdf.cleanup()」的声称只对 runSplit 成立——审查证伪。getDocument 每次解析都拉 worker，合并/压缩整批文档时句柄与 worker 逐个泄漏。现函数体包 try/finally 保证 cleanup
  - js/docs-convert.js runPdfToImages 与 js/docs-ocr.js PDF 分支同样补齐 pdf.cleanup()（前端审查 advisory，报告未声称，与 runSplit 范式对齐）
  - **修复加水印预览 pdfCache 竞态**：loadPdf await 期间新预览使旧回调过期后，旧回调仍无条件覆写 pdfCache——新文件的文档句柄被覆写泄漏、旧文件的文档也无人释放。现加载完成后先判代数，过期即 cleanup 并放弃占缓存（js/docs-watermark.js）
  - 修复 PDF 拆分页码范围无效时状态行谎报「完成：成功 0 项，已输出到…」：补 noSummary 与明确失败状态行（js/docs-pdf.js）
  - App.ui.icon 未知图标名不再静默回退 x，补 console.warn 开发期告警（js/app.js）
  - **修复 test-system.cjs 平台假设（QA 审查 blocking）**：7 处断言跑在真实平台上——CI ubuntu 腿上 printTestPage 首行返回 NOT_WIN，白名单内路径的 ok / spawnCalls 断言全红，且 spawnCalls[0].exe 取空数组元素 TypeError 硬崩套件（exit 2）。win32 前提路径统一切 withPlatform('win32') 假平台（Windows 上为恒等包装，行为零变化；文件内 NOT_WIN 测试早已用同机制切 'linux'）
  - **修复 B8 cancelled 标记无渲染层消费方**（后端审查 advisory）：js/archive.js 内容浏览失败分支补 cancelled 判断，取消按中性「读取已取消」收场，不再显示为红色「读取失败：任务已取消」
  - decodeErrTail 解码策略调整为先判 UTF-8 合法性再试 GBK（后端审查 advisory）：7z UTF-8 构建的合法非 ASCII 错误行不再被 GBK 分支解成乱码采用；中文 Windows 本地化 GBK 输出路径行为不变（electron/archive.js）
  - listArchive 输出上限改按字节累计（后端审查 advisory）：原按 UTF-16 码元计，中文条目 1 字符 3 字节会少算约 3 倍，实际 192MB 级输出才触发 64MB 封顶（electron/archive.js）
  - test-ipc-contract.cjs 主进程文件名单由硬编码 6 个改 electron/ 目录扫描：新增注册模块不再被静默漏检（QA 审查 advisory）
  - test-dom 原 assert(true) 占位（settings 损坏 JSON 容错）改实质断言：quality 保持原值（QA 审查 advisory，与 QA-A1「占位全清」自相矛盾）
  - test-dom 引导错误过滤器收窄：原全局豁免 [zunhong] 前缀会把 stub 还原后的真实诊断错误一起吞掉，现只豁免行为测试窗口内的 intentional 失败路径（QA 审查 advisory）

### 改进
- **file:// 警告条 emoji 图标改 SVG**：⚠️（U+26A0 U+FE0F，强制 emoji 呈现）替换为 Lucide 风格内联 triangle-alert 图标，与全项目描边图标体系统一（js/app.js、css/style.css 补 .warn-banner .icon 间距）
- **交互控件标识统一为 SVG 图标**（advisory A7）：print-batch 的上移/下移/移除、compose 的前移/后移/移除、docs-pdf 的上移/下移均由排版符号文本改为 Lucide 风格内联 SVG——新增共享助手 App.ui.icon（与 file:// 警告图标同一体系，.icon 描边样式），按钮补 aria-label；默认打印机标记在 print.js 与 system.js 统一为「（默认）」文字（option 元素内无法含 SVG）；index.html 两处帮助文本改为文字描述按钮
- **mammoth 输出 sanitize 后进 innerHTML**（advisory A9）：DOCX 转 HTML 虽由 mammoth 白名单生成，但排版容器会先挂进 document.body 再序列化，挂载阶段事件属性即可执行。新增 sanitizeDocxHtml：剥离 on* 事件属性、危险协议 URL（黑名单 javascript/vbscript/livescript/mocha/data（img 的 data:image 除外）/file，http(s) 与相对地址保留）、危险 style 表达式、script/iframe/object 等可执行与外联标签（js/docs-convert.js）
- 清理死代码与文档漂移（advisory A8）：docs-watermark 删未使用的 wmImg.f expando；docs-pdf 删不可达的 split 多文件检查（该模式只保留首个文件，onFilesPicked 已保证）；preload 头注释从「仅暴露打印能力」更新为五组桥接的实际描述
- 文档同步（README）：preload 桥接清单更新为五组（补 zunhongArchiveIcons / zunhongDiag）；测试小节套件数 21→24 并说明 test-system（主进程白名单假件）/ test-ipc-contract（桥接与 IPC 注册契约）/ verify-ocr（真 Tesseract 冒烟）的覆盖定位；verify 端到端清单补 OCR；开发流程新增 v1.3.3 缺陷报告链接（docs/bug-report-v1.3.3.md）
- **第五轮（遗留 backlog 清零，详见 docs/bug-report-v1.3.3.md 第八节）**：
  - **正文排版符号 SVG 化**（backlog ①）：index.html 27 个「← 返回」与 4 个「下一步 →」按钮、3 个「X → Y」转换标签页的导航箭头改内联 SVG（left/right，与首页卡片箭头同描边体系）；print / print-batch / sheet / archive 四个模块状态行与 toast 的「✓ / ⚠」成功失败标识改新增助手 App.ui.statusText（文本走 textContent 防注入 + 末尾 SVG 标识），App.ui.icon 注册表新增 check（对勾）与 alert（三角警示，多 path 数组）；帮助文本「整个文件夹 → 7z 或 ZIP」按既有帮助文本约定改文字描述
  - **electron/archive.js 拆分为引擎层 + IPC 层**（backlog ②）：原 424 行单文件混装 7z 进程机制与 IPC 关注点。新 electron/archive-engine.js（196 行）：resolve7zPath / run7z / check7z / decodeErrTail / cancelActiveJobs / trackChild / untrackChild / statEntry / runExclusive（压缩解压互斥哨兵上移，compress/extract 共用，busy 语义不变）；archive.js（290 行）只留对话框、入参校验、进度回传与 8 条通道注册，引擎函数经 module.exports 再导出保持既有引用面（main.js 仍只用 registerArchiveIpc）
  - **「未找到 7z 引擎」文案给排查路径**（backlog ④）：安全软件（杀毒/防火墙）误隔离随包 7z.exe 是全新安装或更新后「引擎突然没了」的最高频原因，原文案只报结果。引擎层新增 no7zError()：隔离区恢复 + 添加信任 + 重启指引（或安装 7-Zip），check7z / compress / extract / listArchive 四条路径统一改用；完整排查步骤见 docs/security-software-compatibility.md
  - **release.yml 挂 OCR 主链路门禁**（backlog ③）：npm test 只覆盖后处理纯函数，发布链路缺真实 Tesseract 冒烟。测试门禁之后、打包之前新增两步：「安装 Chromium（npx playwright install chromium）」+「OCR 主链路冒烟（node tools/verify-ocr.cjs）」；ms-playwright 浏览器目录纳入 actions/cache（与 electron 缓存同 key 规律，版本随 package-lock 变更失效）

### 测试
- test-archive 新增 3 断言：parseProgress 文件名含「数字+%」不劫持进度、多帧且文件名含 % 时取末帧行首百分比、空输入/纯空白返回 null（107→110）
- test-dom 新增 9 断言：system esc() 五字符转义与空值兜底（XSS 防护函数首次覆盖）、docsPdf _test 钩子（setItemsRef/moveRef/listRef 排序与条目读取）（310→319）
- **第二轮（P0/P1/P2 全清）**：
  - 新建 tools/test-system.cjs（16 断言）：electron/system.js printTestPage 四路径（非 win32 / 空名 / 白名单外 / 白名单内放行且 spawn 参数无注入面）、sysExe System32 解析、netInfo 回环过滤、dnsProbe/tcpProbe；spawn 在 require 前替换为假件，绝不真启动 rundll32。npm test 套件 22→23
  - test-dom 319→350：docs-convert 行为测试 7 断言（坏图合并不葬送整批、p2i 逐页输出、坏 PDF 不中断、状态行如实 1/2）、docs-pdf 行为测试 6 断言（合并坏 PDF 只记失败、拆分按页码范围提取）、uniqueOutName 2 断言、print clampCopies 4 断言、settings 往返/钳制/旧键迁移/损坏容错 7 断言、Cropper 倾斜几何 4 断言（tiltPoint 零倾斜恒等 / 90° 绕中心、minScaleFor 公式与倾斜放大）
  - 测试钩子扩展：js/docs-convert.js _test（setItemsRef/setModeRef/setDirRef/runPdfToImagesRef/runImagesToPdfRef/imageToPageRef）、js/docs-pdf.js _test（runMergeRef/runSplitRef/runShrinkRef/setModeRef/setDirRef）、js/print.js _test（clampCopiesRef）、js/cropper.js _test（tiltPointRef/minScaleForRef）、js/pdfcore.js 导出 uniqueOutName；electron/system.js 导出 printTestPage/sysExe/dnsProbe/tcpProbe
  - 全量门禁：ESLint 0 告警；npm test 23 套件 1057 断言 0 失败（退出码直读 npm test，未经管道中转）
- **第三轮（advisory 全清）**：
  - 新建 tools/test-ipc-contract.cjs（3 断言）：preload 桥接的每个 invoke/send 通道必须有主进程 handle/on 注册——防「桥接名与注册名拼写不一致 / 注册漏挂」类运行时 TypeError（此前无任何覆盖，verify-packaged 只冒烟 7z 一条链路）。npm test 套件 23→24
  - 新建 tools/verify-ocr.cjs（3 断言，挂入 npm run verify）：OCR 主链路真机冒烟——页内 canvas 生成「HELLO 123」图片，经 js/docs-ocr.js 新增的 _test.ocrRef 钩子走真实 Tesseract worker（vendor core wasm + chi_sim/eng 语言包加载 → recognize → cleanText），断言识别文本与置信度（实测一次通过：识别 "HELLO 123"，置信度 91）
  - test-pdfcore 18→26：writeBytes/ensureSubDir/uniqueOutName 由「仅验函数存在」升级为 fs 真实落盘行为断言（os.tmpdir() + 假 FSA 句柄：字节一致性、Blob 入参、子目录创建与幂等、同名防覆盖序号递增）
  - test-print-doc 硬编码「20 通过」改动态计数（实际 23 条，旧文案长期少报 3 条）
  - test-zip / test-server 的 skip 显式化：无解压器 / 无局域网 IP 时记 skip 计数并在汇总行声明，不再用恒真断言冒充通过
  - verify-print-batch / verify-packaged 的 assert(true)（共 5 处）改为对 waitForFunction 返回值的实质断言（超时检测由 throw 承担，行为不变）
  - verify-packaged 新增系统工具 E2E：进入系统工具模块并真实调用 system:netInfo，断言返回网卡数组（system IPC 注册正确性首次有 E2E 覆盖）
  - test-dom 350→366：docsConvert sanitizeRef 8 断言（事件属性 / 危险协议 / 危险标签 / style 表达式剥离，正文与 data:image 内嵌图、http(s) 外链保留）、App.ui.icon 3 断言、排版符号源码级退场扫描 5 文件（print/print-batch/compose/docs-pdf/index.html 零残留）
  - 全量门禁：ESLint 0 告警；npm test 24 套件 1084 断言 0 失败（退出码直读 npm test，未经管道中转）；verify-ocr / verify-print-batch 真机通过
- **第四轮（提交前三路独立审查补记）**：
  - test-dom 366→370：docs-pdf 合并 / pdfToPages cleanup 间谍断言（每个成功解析的 PDF 文档均被释放）、docs-convert p2i cleanup、拆分无效区间返回 noSummary 不谎报完成、App.ui.icon 未知名告警
  - test-system 16→17：新增 dnsProbe 解析器挂起时 3s 超时断言（stub dns.lookup 永不回调，与 tcpProbe 超时对齐）；win32 路径切假平台后 CI 跨平台腿可跑
  - test-archive 110→112：新增真实 7z 含子目录归档的压缩与 l -slt 列表断言——目录条目 isDir 判定（/^D/）对真实输出闭环（原单元测试样本为合成属性串）
- **第五轮（backlog 清零）**：
  - test-dom 370→404：新增 check/alert 图标路径与 alert 多 path 断言、statusText 文本与 SVG 标识断言共 5 条；控件标识符号扫描扩至 7 个文件（补 js/archive.js、js/sheet.js，字符类加 ←→✓⚠）2 条；新增全部 js（26 个）+ index.html 的对勾/警示字符零残留扫描 27 条（注释同样计入——宁可改注释表述，不留扫描盲区）
  - test-archive 112→132：新增「主进程模块结构守卫」20 断言（两层均 ≤320 行、IPC 层引用引擎层、引擎层不碰 ipcMain/dialog 且持有 spawn、引擎层 10 个导出、IPC 层 5 个再导出、no7zError 文案含隔离/信任指引）
  - 全量门禁：ESLint 0 告警；npm test 24 套件 1145 断言 0 失败（退出码直读 npm test，未经管道中转）
  - 更正历史组计数漂移（QA 审查机械核实调用点）：docs-convert 行为测试 8→7、docs-pdf 行为测试 5→6、sanitizeRef 9→8（各处总数均准确）
  - 全量门禁：ESLint 0 告警；npm test 24 套件 1091 断言 0 失败（退出码直读 npm test，未经管道中转）
- 全量门禁：ESLint 0 告警；npm test 22 套件 1038 断言 0 失败（退出码直读 npm test）

## [1.3.3] - 2026-10-19

### 修复
- **修复解压进度「卡住」在历史百分比（如 78%）的问题**：其一，`parseProgress` 原取 chunk 内首个百分比，而 7z 以 `\r` 同行重刷进度、一次 stdout data 事件常携带多帧（如 ` 78% 14 \r 99% 44 - f`），取首帧导致进度滞留旧值，现改为取最后一帧（electron/7z-args.js，test-archive 新增 2 断言）；其二，解压完成 / 失败 / 取消后 `ax-progress` 进度行不收纳，残留最后一帧「解压中（1/1）：xxx — N%」令用户误以为任务卡死（实际产物已完整落盘），现完成时随结果文案一并收纳进度行，新增压缩包入列时同样收纳上一轮残留（js/archive.js，verify-archive 新增 1 断言）

### 新增
- **OCR 文字识别实装**（文档工具子功能，最后一张占位卡片转可用，文档工具五项全部实装）：内置 Tesseract LSTM 离线引擎（vendor/ocr，Apache-2.0，约 17.6 MB——主线程加载器 + 双 wasm 识别内核按 SIMD 支持自适应加载 + 简体中文 / 英文语言包）；识别对象为图片（JPG / PNG / WebP / BMP）与扫描 PDF（经 pdfcore 逐页栅格化，长边 ≤2000px）；语言包三选（中文 + 英文 / 仅中文 / 仅英文），引擎懒加载（首次识别才创建 Worker），切换语言经 reinitialize 复用内核不重建；识别结果集中文本框可编辑，支持一键复制（clipboard 失败回退 execCommand）、导出 TXT、导出 DOCX（最小 OOXML 三件套经 ZipUtil.store 打包，A4 纵向逐行成段，Word / WPS 可直接打开）；blob: Worker 内无法解析相对路径，引擎三路径均转为绝对 URL；Electron CSP 已具备 wasm-unsafe-eval 与 worker blob: 无需变更；全程本机离线
- 新增 js/docs-ocr.js 模块（文本清理 / 结果拼接 / 导出名 / DOCX XML 生成纯逻辑单测）与 tools/test-docs-ocr.cjs 31 断言，测试套件总数 21（test-dom 冒烟更新至 310 断言）
- **修复文档转换 / PDF 工具面板桌面端布局**：两面板外壳与文档加水印同构但漏加 `display:block` 覆盖，被 `.subpage` 双栏网格挤压（内容区仅剩 26px），随 OCR 面板接入一并补上（style.css：#docs-convert / #docs-pdf / #docs-ocr）
- **文档转换实装**（文档工具子功能，原占位卡片转可用）：三个方向——PDF → 图片（pdf.js 逐页渲染，JPG / PNG，1x / 1.5x / 2x 倍率，逐页单图输出）；图片 → PDF（JPG / PNG / WebP 合并为单个 PDF 或逐图单页，按原始尺寸或 A4 居中适印）；Word → PDF（mammoth 转 HTML → foreignObject 栅格化 → A4 分页重建，简化版式）。输出到「转换输出」子目录，不动原文件
- **PDF 工具实装**（文档工具子功能，原占位卡片转可用）：合并（多 PDF 按列表顺序 ↑↓ 调整后重建为单个「合并.pdf」）；拆分提取（页码范围语法「1-3,5,8-」，支持单页 / 区间 / 开口区间 / 中英文分隔，输出「原名-提取.pdf」）；体积压缩（三档强度重编码，完成时显示前后体积对比与缩减百分比，扫描件效果最佳）
- **共享核心 js/pdfcore.js**：文档工具公共管线（页码范围解析 / pdf.js 加载渲染 / canvas 编码 / FSA 子目录写入 / 目录选择统一降级），文档加水印同步重构复用；纯 JS PDF 生成器由 batch-format 内部提升为公开导出；新增 test-pdfcore.cjs 18 断言（页码解析 15 + 导出面 3），测试套件总数 20（test-dom 299 断言）
- **文档工具子功能菜单扩展**：新增「PDF 工具（合并 / 拆分提取 / 体积压缩）」「OCR 文字识别（图片 / 扫描件转可复制文本）」「文档加水印（文字 / 图片水印，平铺与位置可调）」三张「敬请期待」占位卡片；原静态「文档转换」占位页改为动态外壳（与系统工具 SYSTEM_SOON 同构），四项共用一套占位页，标题/要点按入口填充、图标自对应卡片克隆
- **文档加水印实装**（文档工具子功能，原占位卡片转可用）：支持 PDF 与 JPG / PNG / WebP 混合多选；文字水印（内容 / 字号 / 颜色 / 不透明度 / 旋转角 / 九宫格定位或 1–8 列平铺防删除）与图片水印（水印图 / 占短边缩放 / 共用不透明度与定位）；PDF 逐页栅格化（长边 ≤2000px）后经纯 JS 生成器重建，水印无法单独剥离；图片保持原格式（PNG 保留透明通道，JPEG / WebP 质量 0.92）；FSA 写入所选文件夹的「加水印输出」子文件夹，不动原文件；实时预览（防抖）+ 逐文件结果列表；新增 js/docs-watermark.js 模块，纯逻辑（钳制 / 定位 / 平铺坐标 / 绘制冒烟）27 项单元断言（tools/test-docs-watermark.cjs，测试套件总数 19）
- **系统工具模块**：顶部导航与首页新增第七个模块「系统工具」，下设子功能菜单（5 张卡片），其中两项为「敬请期待」占位、三项已实装：
  - **设置**：
    - 外观 · 主题切换：深色（默认）/ 浅色。浅色经 `body[data-theme="light"]` 仅覆盖颜色变量与滚动条（style.css），深色保持无属性默认态；切换即时生效并随设置持久化，启动最早阶段应用避免闪屏
    - 通用 · 启动时进入：首页（默认）/ 上次使用的模块。`showModule` 记录上次模块随偏好持久化，启动恢复经模块名白名单校验，存储脏数据兜底回首页
    - 数据 · 设置记忆占用显示（localStorage，仅存本机）；「恢复全部默认」经统一确认框二次确认后清空 localStorage 并重启
    - 关于 · 软件版本、运行模式（自动识别桌面版 Electron / 浏览器版）、作者与许可
  - **网络检测**：
    - 本机网卡信息：接口名 / IPv4·IPv6 / MAC（过滤回环接口）
    - 网络连通检测：对固定公共 DNS 节点（阿里/DNSPod/114/Google，53 端口）做 TCP 握手延迟测试 + 两个域名经系统解析器解析测试，三态汇总（正常 / 不稳定 / 无法联网）
    - 主进程仅连固定白名单节点，渲染层无输入参与连接目标；不发 HTTP、不上传任何数据；浏览器模式禁用并提示
  - **添加打印机**：
    - 本机打印机列表（复用打印模块枚举 IPC，含默认打印机标记）
    - 一键打开系统「添加打印机」向导（rundll32 printui.dll /il）与系统「打印机和扫描仪」设置页（explorer ms-settings:printers），System32 绝对路径 + 数组参数防注入
    - 打印测试页：打印机名先过本机枚举白名单校验再交 printui.dll /k；浏览器模式禁用并提示
  - **软件卸载 / 垃圾清理（敬请期待）**：两项共用一个占位页外壳，标题/要点按入口动态填充、图标自对应菜单卡片克隆，避免重复 HTML
- 新增 Electron 主进程模块 electron/system.js（system:* 五个白名单 IPC）与渲染层 js/system.js（App.system，面板逻辑 + 浏览器降级），preload 暴露 zunhongSystem 桥接
- 设置持久化扩展（js/settings.js）：照片偏好存储键新增 `theme / startMode / lastModule` 字段，与原规格/底色/输出记忆兼容混存
- test-dom 冒烟断言累计新增 24 条：系统工具入口/控件与可用态 +17，文档工具占位卡片与动态占位页 +7，总计 220 断言

### 文档
- README 功能概览与功能表（七模块：文档工具五项全部可用，系统工具三项可用）、操作流程（文档工具全部实装，仅系统工具软件卸载 / 垃圾清理为占位页；新增 OCR 操作流程）、js/ 与 vendor/ 目录结构注释、技术要点新增 OCR 小节同步

## [1.3.2] - 2026-10-18

### 修复
- **证照生成 · 皮肤美白拖动滑块报「脚本错误」**：美白像素混合函数 `whitenData` 此前只挂在 Matting 的内部测试导出（`_test`）上，未进入公开 API，美白强度大于 0 时 `applyWhiten` 调用抛 TypeError 被全局兜底捕获后弹错。已将 `whitenData` 补入公开导出表（js/segmenter.js），美白功能恢复正常

## [1.3.1] - 2026-10-18

### 新增
- **证照生成 · 人像倾斜校正**：抠图换底步骤新增「人像倾斜校正」滑块（±15°、0.5° 步进）与「回正」按钮，头像拍歪时旋转人像使其摆正，无需重拍
  - 实现为合成管线级旋转（composer.js）：work 与蒙版同用一套「缩放平移 + 绕工作图中心旋转」变换，不重写像素数据——笔刷修补、皮肤美白、撤销快照全部仍工作于原始 work 坐标，倾斜与美白/修补可任意叠加，画质无损
  - brush.js 笔刷落点经逆旋转仿射映射回工作图坐标，倾斜状态下修补/擦除位置精确；脏区局部重绘在倾斜下按区域四角逆映射包围盒增量重绘，拖拽性能不受影响
  - cropper.js 自动对齐（头顶/眼线定位）感知倾斜：特征点先过倾斜映射再求位移；最小缩放按倾斜后内接矩形放大，任意平移位置画框不露底色楔形
  - matteview.js 平移钳制按倾斜后内容包围盒外扩；抠图画布虚线边界随旋转绘制
  - 换新照片自动回正；倾斜不入设置持久化（属于单张照片的校正参数）

### 安全软件兼容性（防误报专项）
- **新增《安全软件兼容性指南》（docs/security-software-compatibility.md）**：国产安全软件（360 安全卫士 / 360 杀毒 / 腾讯电脑管家 / 火绒）误报原理与本项目风险点全面审计——spawn 7z / reg 写 HKCU / powershell CIM / rundll32 / 本地 127.0.0.1 服务逐项定级，代码签名证书选型对比（OV/EV 费用与效果）、各安全软件白名单申诉入口与材料清单、四步兼容性验证测试步骤
- **electron/main.js**：Windows 下设置 `app.setAppUserModelId('com.zunhong.toolbox')`，进程身份与应用绑定（此前任务栏进程无 AUMID，身份模糊不利于安全软件归类）
- **package.json**（build.win）：`requestedExecutionLevel: "asInvoker"` 显式声明不要求管理员提权（提权类软件是主动防御重点盯防对象）；`legalTrademarks: "尊泓工具箱"` 补全 exe 版本资源商标字段
- 确认无加壳/无混淆/无外联/不写 HKLM 等有利项，形成「刻意避开的高危特征」清单供后续功能开发遵守

### 修复（CI 跨平台）
- GitHub Actions Billing 解除后 CI 恢复执行，修复 3 个历史遗留的平台问题，windows + ubuntu 双矩阵全绿：test-zip 非 Windows 解压回归改用 python3 zipfile（Info-ZIP unzip 会改写 UTF-8 中文名）；test-archive 非 Windows 跳过 7z.exe 冒烟、GZ 冒烟只校验内容不假定还原文件名（7z 按 ANSI 代码页写 gzip 头）；7z-args.js normPathKey 固定 `path.win32.resolve`（Windows 运行时行为零变化）

## [1.3.0] - 2026-10-18

### 清理
- 移除遗留的一次性实验 / 探针脚本：tools/_probe-import.cjs、tools/_probe-pager.cjs（临时真机探针）、
  tools/layout-a4.cjs、tools/layout-preview.cjs（版面调研脚本）、tools/shot-responsive.cjs（硬编码本机路径的截图脚本）
- index.html 清理已移除功能（打印机管理，1.2.2 下线）的残留注释
- README 同步菜单重组后的模块地图、功能表与操作流程，移除已下线的打印机管理章节，补压缩包图标关联说明

### 新增
- **压缩包图标关联**：为没装任何压缩软件的电脑解决 .7z / .zip 显示白板图标的问题。压缩工具菜单新增「压缩包图标」卡片，可一键注册 / 恢复：
  - 原理：资源管理器图标由文件关联决定。本程序以用户级（HKCU，无需管理员）注册 ProgID，把 DefaultIcon 指向随包分发的 7z.dll 内置格式图标（索引 0=7z、1=zip，与 7-Zip 官方安装器注册值一致），图标即随包分发、无需系统安装任何软件
  - 安全边界：只写 HKCU\Software\Classes；扩展名已有关联（HKCR 有 ProgID 或存在 UserChoice）时绝不覆盖，只在完全无关联时接管；不注册打开方式，双击行为不变；接管前备份原默认值，可一键精确还原
  - 注册后经 ie4uinit -show 刷新图标缓存，未生效时 F5 或重开资源管理器窗口即可
- electron/archive-icons.js 主进程模块（probe / apply / restore IPC + zunhongArchiveIcons 渲染桥接）

### 修复
- **压缩「所选内容所在目录（自动命名）」模式下，单个压缩包文件（如 report.7z 选 7z 格式）自动命名与源文件同名，清理旧产物步骤会先删除源文件再压缩，导致源文件丢失**。三层防护：
  - 主进程 compress() 在删除旧产物前经 hasInputConflict（electron/7z-args.js，大小写/分隔符归一）校验输出与任一输入相同则拒绝执行
  - 渲染层自动命名与待压缩内容同名时自动追加 _1/_2 后缀（bumpOutName）
  - 同目录自动命名模式下输出已存在时先弹确认框，不再静默覆盖（另存为弹窗模式本有系统确认，行为对齐）
- 内容浏览（7z l）：check7z 引擎检测增加 15s 超时兜底，防异常挂起
- 7z 引擎检测失败后执行按钮不再被任务结束时的恢复逻辑重新启用（engineOk 状态纳入 bridgeOk）
- 浏览器环境下解压面板「内容浏览」按钮未禁用（此前无监听器点击无反应，现在与其它入口一致禁用）
- **批量打印（图片面板）任务异常会永久锁死执行按钮**：runImages 生成页画布与发送打印的整个链路缺异常兜底，任一 drawImage / toDataURL 抛错（坏图、内存不足等）后 printing 标志永远为 true，pb-run / pd-run 从此不可用。已与文档打印路径一致补 try / catch / finally 兜底
- **批量去水印「覆盖原文件」模式不弹确认直接覆盖**：这是全项目唯一不可逆覆盖用户数据的路径，现执行前经统一确认框（App.ui.confirm）二次确认，取消即不处理
- **排版工具清空导入照片后预览不刷新**：预览画布与页码停留在旧排版，需碰任意参数才恢复；现清空后立即重置预览
- **图片压缩从批量工具「体积优化」进入后，返回按钮错落回照片工具菜单**：compress 模块现记录进入来源（photo / batch），返回时回到来源处
- 批量打印图片解码失败路径未释放 blob URL（每张失败图泄漏一个直到清空列表）；文档重复添加时对仍在解析中的条目可能重复触发预解析（新增 parsing 标志去重）
- **批量打印（图片面板）双重边距**：画布生成页时先烤入 5mm 白边，发送时又选 marginType:printableArea 让驱动按可打印区再收缩一次，实际白边约 10mm（UI 标注「约 5mm」）。现画布整页铺满、边距只交给打印驱动，白边回到约 5mm 且图片明显更大
- **排版（layoutBatch）满页时底边距缩水到约 3mm 有裁切风险**：容量按 paper.h − 2×5mm 计算行数，但首行锚点钉在 7mm，满页时底边 = 7 + (h − 10)。首行锚点改回 MARGIN_Y(5mm)，满页底边距恢复 5mm，多页首行位置一致性与分页逻辑不变
- **图片格式转换运行期间不锁控件**：转换中仍可改格式/质量/底色或增删列表（批量打印与压缩均有锁定，此模块漏了）；现与 compress.js 一致补 setControlsLocked

### 性能
- **批量去水印涂抹笔迹 O(n²) 卡顿**：旧实现每次 pointermove 把当前笔迹临时入列并全量重放所有动作重建蒙版（长笔迹时每帧成本随总点数线性增长，二次方累计）。改为 pointerdown 建好蒙版底色、pointermove 只增量绘制新增一段（O(1)/次），提交/取消时整帧重放一次兜底；蒙版色不透明 + 圆头笔帽保证分段绘制与整笔重放视觉等价。顺带修复首笔涂抹时实时反馈不可见（预览叠加条件补上涂抹中状态）

### 调整
- **工具箱菜单重组**：「打印工具」更名为**文档工具**，原两个子功能全部迁出并各归其位：
  - **批量打印（图片）→ 批量工具**：面板整体迁入批量工具视图并纳入其子页体系（返回按钮回批量菜单，进入时自动刷新打印机列表）；原「图片打印 / 文档打印」标签页拆除，图片与文档两个面板各自独立成子功能
  - **文档打印 → 文档工具**（新菜单的首个可用子功能）：原批量打印的文档面板（PDF / DOCX / TXT 列队 / 合并打印）独立为「文档打印」
  - **证照打印（占位）→ 照片工具**：占位页迁入照片工具子页体系，与证照生成同处一个菜单
  - 文档工具新增「文档转换」占位卡（PDF ↔ 图片互转 · Word 转 PDF，开发中）；首页卡片与顶栏标签同步更名
  - 顺带修复：文档打印面板因外壳样式未随迁移调整被塞入 340px 窄列（#print-docs 缺 display:block 覆盖导致面板超高不可滚动）；verify-print-batch（43 断言）与 verify-packaged E2E 已按新导航结构更新

### 安全加固
- **依赖漏洞清零（npm audit 0 vulnerabilities，此前 12 项：11 high + 1 critical）**：
  - electron-builder 25.1.8 → 26.15.3（vulnerabilities 全部位于其构建工具链 @electron/rebuild → node-gyp → tar/cacache；仅构建期使用、不进安装包，但属于真实依赖风险）
  - 新增 overrides 将 app-builder-lib 依赖的 @electron/get 钉到 5.1.0（该包 3.x 引入的 global-agent → sprintf-js 链存在全版本 DoS 漏洞 GHSA-hp3w-g68c-fv3c 且无修复版本，5.x 已移除该依赖）
  - 验证：升级后 `--dir` 打包成功，verify-packaged 打包版 E2E 16 断言全过；npm test 17 套件全绿；lint 0 告警
- **archive-icons IPC 入口白名单**：渲染层传入的 exts 现经 sanitizeExts 过滤（只允许 7z/zip、去点、小写归一），杜绝任意注册表键路径拼接（此前 probeExt 在 applyExt 校验之前就拿原始值拼键路径）
- **系统工具绝对路径解析**：reg / rundll32 / ie4uinit / powershell 一律经 System32 绝对路径调用（sysExe），消除 PATH（或工作目录）被劫持时执行到假冒可执行文件的风险
- **打印属性对话框超时**：print:showProperties 的 rundll32 调用加 15s 超时（此前无超时，rundll32 异常挂起会拖死 IPC promise）
- **日志防伪造**：appendDiag 落盘前把 CR/LF 展平为 ↵，渲染层上报的错误信息无法再伪造多行日志条目干扰排障
- **打印路由 token 改用 crypto.randomUUID**：此前为 Date.now + Math.random（可预测），避免本机其他进程猜中 token 抢读内存中待打印文档

### 测试
- test-archive.cjs 新增 11 条断言：bumpOutName 冲突递增/无扩展名/空输入兜底，hasInputConflict 大小写不敏感/相对段归一/不同名与空输出放行
- test-archive-icons.cjs 新增 20 条断言：图标索引表与官方注册值一致、reg 输出解析、关联决策（ours/userchoice/associated/available）、备份标记编解码、DefaultIcon 值构建、7z.dll 定位；test-dom 同步压缩工具菜单 4 卡片与图标卡片控件断言
- 安全加固补测：sanitizeExts 合法保留/归一/非法剔除/非数组拒绝 5 条断言（共 25 条）

## [1.2.5] - 2026-10-17

### 改进
- 压缩文件 / 解压文件面板：拖拽投放区由「空态提示兼作投放区」升级为内容区上方**常驻的实体拖拽框**（实线边框 + 图标 + 说明文字），已有列表内容时仍可继续拖入追加；拖入时高亮，拖拽链路（webUtils.getPathForFile → archive:statPaths）不变，空态提示文字保留但不再承担投放职责

## [1.2.4] - 2026-10-17

### 新增
- 照片 / 批量 / 打印工具各新增一个「开发中」子功能占位页，点击入口卡可进入查看功能规划：
  - 照片工具「老照片修复」：划痕折痕修复 / 黑白照上色 / 画质增强与放大（规划中）
  - 批量工具「批量加水印」：文字与图片水印、九宫位置预设、单角居中平铺（规划中）
  - 打印工具「证照打印」：原禁用占位卡升级为可进入的规划页，常用规格直出打印 / 六寸排版 / 与证照生成打通（规划中）
- 占位页统一居中卡片样式（虚线边框 + 「功能开发中 · 敬请期待」徽标 + 功能规划清单 + 返回按钮），入口卡带琥珀色「敬请期待」徽章

## [1.2.3] - 2026-10-17

### 新增
- 压缩文件 / 解压文件支持拖拽选择：面板内容区改为虚线拖拽框（拖入高亮）。压缩面板可同时拖入文件与文件夹，解压面板可拖入任意常见格式压缩包（非压缩包自动过滤、仅拖入不可识别内容时提示）；拖入的 File 经 webUtils.getPathForFile 转本机真实路径，主进程新增 archive:statPaths 统一 stat 出元数据，与对话框选择共用同一套去重 / 勾选 / 渲染链路；原有对话框按钮保留，两种方式可混用

### 修复
- E2E 静态服务端口被无关进程的临时连接（CLOSE_WAIT）占住时整条 verify 直接失败 → withServer 自动换下一个端口重试（最多 5 个），实际端口参数化传入测试体

## [1.2.2] - 2026-10-17

### 新增
- 抠图换底新增「皮肤美白」：滑块 0–100 实时调节。皮肤区域来自多分类分割模型的身体皮肤 + 脸部皮肤双通道（取 max 置信），美白算法为白色 Screen 混合 × 置信度门控（高光提亮多、暗部少，肤色饱和度自然收敛、不偏橙），蒙版边缘按置信度羽化无硬边；预览与导出共用同一工作图，回退到二/三分类模型时滑块自动禁用；美白强度作为用户偏好持久化
- 去除水印新增「手动涂抹蒙版」：框选之外新增涂抹 / 擦除两种笔刷工具（笔刷大小 8–120 可调、跟随光标圆圈预览），可手动刷出任意形状的水印蒙版并擦除修正；蒙版按矢量笔迹记录，撤销一步可回退笔迹；处理时蒙版轻微羽化后按比例适配每张图片，模糊 / 像素化 / 纯色 / 周边取色四种方式均支持蒙版路径，「周边取色填充」自动改为沿蒙版边缘 8 方向环采

### 改进
- 去除水印入口由「选择文件夹」改为「选择图片」：showOpenFilePicker 多选图片（可跳过非图片文件），预览第一张、框选 / 蒙版按比例批量应用；输出仍支持「另存 -无水印 副本」（执行时选择一次保存位置，会话内复用）与「覆盖原文件」（经文件句柄直接写回）

### 修复
- 图片合成页面所有控件无响应：合成面板与压缩面板误用同一组 DOM id（cmp-pick/file/count/empty/clear/run/back 共 7 个重复），`getElementById` 只命中先出现的压缩面板 → 合成面板整组改用 `co-` 前缀，重复 id 清零；此前「返回照片工具」「生成并保存」等按钮均因绑定落空而失灵
- 移除打印工具中的「打印机管理」子功能：删除首页入口卡片、管理面板与添加/编辑对话框、js/printer-manager.js、electron/printer-probe.js 及 print:probePrinter IPC（preload 暴露面同步收敛），test/verify 门禁链同步摘除对应套件；打印工具菜单仅保留「批量打印」与「证照打印（敬请期待）」

## [1.2.1] - 2026-10-17

### 工程改进
- 新增打包产物 E2E（verify-packaged）：Playwright _electron 驱动真实 exe，链路「产物启动 → 首页渲染 → 版本一致 → preload 桥接真身 → 压缩工具主进程 7z IPC 冒烟 → 无页面错误」12 断言；无产物时优雅跳过，verify 链扩至 11 套件
- 修复 release.yml 产物路径不一致：electron-builder 输出目录为 release-build/，而发布步骤误传 release/*.exe → 统一为 release-build/*.exe；打包后新增「打包产物 E2E 冒烟」门禁步骤

### 交互改进
- 压缩 / 解压面板的「密码（可选）」输入框改为按键 + 弹窗：点「设置密码… / 输入密码…」弹出密码对话框（支持回车确认、Esc 取消、一键清除），按钮实时显示密码状态（已设置 / 已输入），密码不再明文驻留面板

### 修复（评测报告 docs/assessment-2026-10-17.md 全部 24 项）

P1 功能错误：
- 图片压缩「保持原格式」输出 GIF/BMP 时扩展名错标（实际编码为 JPEG）→ 输出扩展名随实际编码格式走（gif/bmp 自动改 jpg），完成提示注明 GIF 按首帧转静态图
- 排版批量导入失败被静默 / 成功数虚报 / FileReader 出错进度条卡死 → 补 img 与 FileReader 错误处理，按真实成功数计数，全失败明确报错
- 超大照片排版被静默裁切 → layoutBatch 对「照片任一边超出相纸可打印区」返回 null，提示缩小照片或换相纸

P2 健壮性：
- 抠图模型加载失败后本会话永久不可用 → 失败清空缓存，下次自动重试
- 大图处理中最小化窗口界面假死（rAF 暂停）→ document.hidden 时退化为 setTimeout 让渡
- 抠图画布空格平移劫持输入框空格 → 排除 INPUT/SELECT/contentEditable；attach 重复调用叠加监听器 → WeakMap 防重挂载
- 裁剪 setPointerCapture 未捕获异常导致拖拽失效 → 包 try
- 图片合成进行中移除图片触发 TypeError → 合成中锁定列表操作；输出前判空并给可读报错
- 压缩运行中改格式/尺寸导致结果写错行 → 运行中锁定全部列表控件
- 合成位图缓存无上限 → 新增 1 亿像素总预算，超限对新图自动降采样
- 模块初始化链无隔离（一处抛错全页半瘫）→ app.js 逐模块 try/catch + 诊断上报
- 压缩 IPC 输出路径未校验 / 分卷清理可能误删同前缀文件 → 校验绝对路径与 .7z/.zip 扩展名；分卷清理改精确 .NNN 编号匹配
- 7z 任务无取消 / 内容浏览无超时 → 新增「取消任务」按钮（archive:cancel kill 子进程，多包解压中止后续包）；内容浏览 30s 超时兜底；取消压缩后自动清理半成品（残缺包与 .NNN 分卷卷不残留）

P3 代码质量：
- 打印文档 dataURL 未转义拼 HTML → escapeAttr 转义，测试补注入断言
- 压缩单文件下载 Blob MIME 非法（image/*）→ 使用实际编码 MIME
- 排版份数读取无钳制 → 钳制 1–99；画布编码失败给出可读报错
- PNG 双 pHYs 块风险 → 移除全部旧 pHYs 再插入新块，保证单块合规
- 笔刷 sizeWork NaN 静默失效 → brushSize 非法回退默认 30；pointerCount 对未按下的 pointerId 误递减 → 仅回收真实按下过的 id
- 裁剪双指重合除零 → 距离钳制最小 1
- 图片转换兜底命名可能重名 → 复用全局已用名表
- preload onProgress 重复调用叠加监听器 → 单注册回调可替换
- 静态服务器空闲 socket 无超时 → 30s 空闲销毁
- 7z 密码命令行残留风险 → 代码注释记录评估结论（7-Zip 无 stdin 密码通道，离线单用户可接受）

另：首页「桌面离线版」版本标签 v1.0.0 → 与 package.json 同步；check-refs 门禁新增版本一致性断言防再漏。

## [1.2.0] - 2026-10-17

### 新增
- 图片压缩 / 尺寸调整子功能（照片工具）：质量滑杆、最长边等比缩小（只缩不放）、保持原格式或统一转 JPG/WebP，逐张对比压缩前后体积，多张打包 ZIP 输出
- 批量工具「体积优化（图片）」入口，复用压缩管线（文档体积优化经评估暂不做）
- 分卷压缩：7z 格式支持按 1/5/10/50/100 MB 分卷（压缩包.7z.001/002…），完成提示分卷数
- 压缩包内容浏览：`7z l -slt` 技术列表（`-sccUTF-8` 强制 UTF-8 避免中文乱码），对话框展示路径/大小/修改时间与摘要，支持加密包

### 变更
- 首页 4 张「敬请期待」占位卡中 3 张转为可用入口（图片压缩 / 体积优化 / 分卷与浏览）；「证照打印」按排期暂缓开发，占位保留

## [1.1.0] - 2026-10-17

### 新增
- 打印机管理子功能：托管打印机台账（添加/编辑/删除/检索筛选）、系统打印机一键导入、网络/共享打印机 TCP 连通探测与在线状态展示
- 打印机台账导出 / 导入 JSON 备份（防重装或便携迁移导致的 localStorage 丢失）
- 应用统一确认对话框 `App.ui.confirm`（Promise 化），替代原生 `window.confirm`
- 崩溃与异常诊断日志落盘：主进程未捕获异常 / Promise 拒绝 / 渲染进程与子进程退出 / 渲染层脚本错误，写入 `userData/logs/app-YYYY-MM-DD.log`，自动轮转保留最近 10 份

### 变更
- Electron 33 → 44（随附 Node 24）；Electron 36+ 移除 `PrinterInfo.isDefault/status` 后，主进程经 PowerShell CIM 查询默认打印机补回
- vendor 库升级：pdfjs-dist 3.32.2 → 6.4.299（仅 ESM，新增 `pdf-adapter.mjs` 适配器）、mammoth → 1.13.0、MediaPipe tasks-vision → 1.1.1；新增 `VENDOR.md` 版本登记
- 首页「软件声明」更新为纯本地离线口径（仅供尊泓内部用途，联系老高）
- 全量图标替换为尊泓 logo 新版导出集（icon.png / icon.ico / 源图）

### 安全
- 内置静态服务（桌面与浏览器模式）修复路径穿越与同前缀目录碰撞缺陷；新增 Host 白名单（防 DNS rebinding）、NUL 字节与畸形百分号编码拦截、仅放行 GET/HEAD
- 新增内容安全策略（CSP，meta 与响应头双轨一致）：阻止远程内容、内联脚本与框架嵌套

### 工程质量
- 修复两处空 `catch`；接入 ESLint 9（扁平配置）与 Prettier 3，新增 `npm run lint` / `format` 脚本
- 孤立测试资产挂入门禁：`test-print-doc` 入 test 链，`verify-brush` / `verify-output` 入 verify 链；移除误留的他项目实验脚本
- 渲染层 `$` helper 统一为 `App.ui.$`（9 处重复定义收敛为单一来源）
- 首页卡片与子功能入口注册改声明式注册表，新增功能不再需要改三处

### 移除
- `tools/print-load-probe.js`（调研探针，其 `zunhong-print://` 为未启用的死引用）

## [1.0.0] - 2026-10-16

- 首个版本（由「浩玥工具箱」更名为「尊泓工具箱」）：证照生成（AI 抠图换底）、图片转换 / 合成、排版打印、批量打印、批量改名 / 加水印 / 转格式、压缩解压、打印机管理等纯本地离线工具集
