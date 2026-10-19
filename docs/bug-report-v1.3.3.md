# 尊泓工具箱 v1.3.3 Bug 检测报告

- 检测日期：2026-10-19
- 检测对象：commit 41b51b3（文档工具四项实装 + 系统工具模块 + 解压进度修复）
- 检测方式：机械门禁（ESLint + 22 套件 1026 断言）+ 三专家并行代码审查（主进程 / 渲染层 / 测试完整性）+ 总监逐条交叉验证
- 结论：**发现 1 项 P0、3 项 P1 功能缺陷、3 项 P0 级测试覆盖缺口、19 项 P2、15 项 advisory**（其中 1 项初判 P1 经真机验证后证伪，见 P1-2 更正说明）
- **修复状态：全部修复完毕，无遗留**——P0/P1 全部、P2 全部（13+6 项）、测试覆盖缺口全部（T1-T3 + QA-B4/B5/B6 + Cropper 几何）、advisory 15 项全部（BE-A1~A5 / FE-A7~A9 / QA-A1~A6；FE-A10 为备案项评估不构成违规）。另经提交前三路独立审查（前端 / QA / 后端 + 总监复核）修复 2 项 blocking 与 10 项 advisory（第八节第四轮），提交后遗留 backlog 4 项全部清零（第八节第五轮）。最终门禁：ESLint 0 告警；npm test **24 套件 1145 断言 0 失败**（退出码直读）；npm run verify 全绿（含重新出包后 verify-packaged 21 断言 + verify-ocr 真机 OCR 冒烟）。详见第八节一/二/三/四/五轮修复记录

---

## 一、机械门禁结果（机器证据）

| 门禁 | 结果 |
|---|---|
| ESLint 9 | 0 告警 0 错误 |
| npm test | 22 套件、**1026 项断言全部通过，0 失败** |
| 测试反作弊门（QA 6 类检测） | 全部通过：无测试删除、无断言弱化、无新增 skip/.only、无硬编码期望回填、无门禁配置篡改、退出码机制诚实 |

测试基础设施本身干净可信，问题在覆盖缺口而非作弊。

---

## 二、P0 — 功能缺陷（1 项）

### P0-1 emoji 作为功能图标（违反团队 P0-1 规则）
- 位置：`js/app.js:958`
- 现象：file:// 打开时的警告条使用 `⚠️`（U+26A0 U+FE0F，强制 emoji 呈现）充当警告图标
- 溯源：历史遗留（初始提交引入，非 41b51b3 新增）；全库扫描确认为唯一真 emoji
- 修复：替换为内联 SVG 警告图标（TriangleAlert 风格，与现有 hc-icon 描边一致）+ 纯文本

---

## 三、P1 — 功能缺陷（4 项）

### P1-1 中文打印机名「默认打印机」徽标永不显示（编码不匹配）
- 位置：`electron/main.js:67-78`（windowsDefaultPrinter），消费点 `main.js:88`
- 根因：`execFile(powershell)` 未指定编码，Node 按 UTF-8 解码 stdout；Windows PowerShell 5.1 管道输出走 OEM 代码页（GBK 936）。中文打印机名解码成乱码，与 Electron 枚举的 Unicode 名永不相等 → `isDefault` 恒 false。英文名不受影响，故测试环境从未暴露（已真机验证）
- 影响：系统工具→打印机面板默认标记在中文打印机名机器上静默失效（`js/system.js:143-144`）
- 修复：`-Command` 前强制 UTF-8：`'[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' + 原命令`

### P1-2 PDF 加水印预览（初判缺陷，经真机验证证伪——保留为改进项）

> **更正说明（2026-10-19 修复轮）**：初判「预览必坏」的根因归属有误。用项目自带 vendor/print/pdf.js 在真实 Chromium 中实测：裸 ArrayBuffer 形态 `getDocument({data: rawArrayBuffer})` **加载成功**（numPages=1、getPage 正常）。bundle 中 "Invalid data format, must be a string or TypedArray." 来自 `MurmurHash3_64.update()`（字体/批注哈希），其调用方全部传字符串或 TypedArray，从 `getDocument({data})` 路径不可达。故此项**不是功能缺陷**，不计入 P1。

- 位置：`js/docs-watermark.js:231-232`（修复前）
- 保留的改进（已实施）：预览路径绕过共享核心 `pdfcore.loadPdf` 自写 `getDocument`，与同模块主管线（:137）和 print-batch 的 toPdfData 范式不一致；且全程无 `pdf.cleanup()`，反复预览泄漏文档句柄。现预览与主管线统一走 `core.loadPdf` + `try/finally cleanup()`

### P1-2 docs-pdf 合并/拆分缺错误分支：单文件失败即整批静默中止
- 位置：`js/docs-pdf.js:78-88`（runMerge）、`90-106`（runSplit）；外层 run()（146-169）只有 try/finally 无 catch
- 根因：任一 PDF 损坏/加密 → rejection 沿 async 链上抛至 click 监听器，仅靠 app.js:940 全局兜底弹通用错误。状态行卡在「合并 2/3」、结果列表全空、用户无从知道哪个文件失败。同文件 runShrink（112-130）有完整 per-file try/catch，明显不对称
- 修复：runMerge 循环体内 try/catch（addResult 失败 + console.error）；runSplit 整体 try/catch，失败时 toast + 状态复位

### P1-3 docs-convert 图片→PDF 合并分支缺错误分支（同 P1-2 同源）
- 位置：`js/docs-convert.js:109-119`
- 根因：merge 分支 `pages.push(await imageToPage(...))` 无 try/catch，一张坏图（改扩展名的假 JPEG、0 字节文件）解码失败 → 整批中止；非 merge 分支（121-132）有 per-file catch
- 修复：循环体内 try/catch + addResult(失败)；连续失败可提前中止并提示

---

## 四、P0 — 测试覆盖缺口（QA 门禁判定，3 项）

> v1.3.3 新增约 1900 行源码仅换来 276 行测试，且集中在低风险纯函数层；以下三项恰是最可能出错又最无保护的路径。

| # | 模块 | 缺口 | 优先级理由 |
|---|---|---|---|
| T1 | `js/docs-convert.js`（289 行） | 零行为测试（仅 test-dom 存在性断言）；自带 `_test` 钩子只转发 pdfcore.parsePageRanges，零新增区分力 | 直接读写用户 PDF/Word，出错=数据损坏 |
| T2 | `js/docs-pdf.js`（219 行） | 零行为测试；`_test: { moveRef, listRef }` 钩子已留（:199）但无任何测试引用 | 测试接口已留、测试没写 |
| T3 | `js/system.js` esc()（:14-18） | XSS 防护函数零测试；其输出经 innerHTML 插入（renderIfaces:52、renderProbe:74-80），数据源为系统返回的网卡名/IP/打印机名 | 安全相关；test-print-doc.cjs:63-71 已树立转义测试先例 |

另：`electron/system.js`（144 行，白名单校验/sysExe 防注入关键逻辑）、`js/settings.js`（旧品牌键迁移逻辑）、`js/print.js` 均为零覆盖（P1）。

---

## 五、P2 — 次要缺陷（19 项）

### 主进程（贝洛奇，13 项）
| # | 位置 | 问题 |
|---|---|---|
| B2 | `electron/7z-args.js:110-120` | parseProgress 被文件名中「数字+%」劫持（"100%完成.txt" → 进度跳 100）；41b51b3 修帧滞留时引入的回归。修法：按 \r\|\n 切分取末段、行首锚定 `/^\s*(\d{1,3})%/` |
| B3 | `electron/main.js:102-110` | print:showProperties 的 15s execFile 超时会把用户交互中的打印机属性对话框强关。修法：改 spawn 不设 timeout（对齐 system.js launch 模式） |
| B4 | `electron/7z-args.js:159` | 目录判定 `/\bD/` 违反项目约定 `/^D/`（当前无行为偏差，规范违反） |
| B5 | `electron/archive.js:182,259` | compress/extract 对 payload 未做空值防护（listArchive:300 有，风格不一致） |
| B6 | `electron/archive.js:197,236-247` | zip + volumeMB 组合静默产出 `{ok:true,size:0,parts:1}`，UI 显示「压缩完成（0 B）」；主进程应显式拒绝 |
| B7 | `electron/archive.js:227-231` | 7z 失败（非取消）不清理半成品，残留截断 .7z/残缺分卷 |
| B8 | `electron/archive.js:322` | listArchive 取消路径缺 `cancelled:true` 标记，渲染层显示「读取失败：任务已取消」语义不一致 |
| B9 | `electron/main.js:142-153` | print:printImage 无看门狗，print 回调永不触发即永久泄漏（隐藏窗口+IPC promise+按钮禁用） |
| B10 | `electron/archive.js:318` | listArchive 输出累积无上限，超大压缩包 -slt 输出可达数百 MB |
| B11 | `electron/archive.js` | 无并发哨兵：两个 compress 并发会互相 removeOutputs 删掉对方产物（IPC 可被 devtools 直连） |
| B12 | `electron/archive.js:159-170` | 7z 错误信息中文 Windows 可能乱码，且乱码行优先级高于 exitCodeText 中文说明 |
| B13 | `electron/main.js:277` | createWindow 无 .catch，静态服务监听失败时应用变僵尸（无窗口无退出） |
| B14 | `electron/system.js:50-58` | dnsProbe 无超时（tcpProbe 有 3s），系统解析器挂起时 netProbe IPC 无限期不返回 |

### 渲染层（贾思敏，6 项）
| # | 位置 | 问题 |
|---|---|---|
| A1 | `js/docs-watermark.js:170-171` | 「共 N 页」实为文件数（it.pages 从未赋值，reduce 累加全部条目含图片）——沉默逻辑错误，显示错误数据比无数据更糟 |
| A2 | `js/docs-convert.js:170-182` | Word→PDF 末页垂直拉伸变形（源高不足一页时被 drawImage 拉满 A4 目标高度，约 3 倍拉伸） |
| A3 | `js/system.js:157-179` | 三个打印机操作缺 .catch（IPC 异常静默无反馈）；printTest 连点会向打印机发多张测试页 |
| A4 | `js/docs-watermark.js:231,260-262` | 预览竞态（250ms 防抖只延迟不取消）+ 大 PDF 每次预览全量重读盘 |
| A5 | `js/docs-ocr.js:239-249` | run() 无 finally，循环后异常时按钮永久锁死、running 永 true |
| A6 | `js/docs-watermark.js:353/359`、`js/docs-convert.js:125`、`js/docs-pdf.js:64` | 同名输出文件静默覆盖（不同文件夹多选同名文件），archive.js:115-126 有现成 bumpOutName 模式 |

---

## 六、Advisory（15 项，不阻断）

主进程：A1 print:readFile 同步读盘 200MB 阻塞事件循环；A2 pickPaths/saveDialog 未查 isDestroyed；A3 preload onProgress(null) 后再绑定会重复监听（当前无调用方触发）；A4 check7z 版本号取整行带出版权行；A5 cancel 后 error/close 竞态边缘。
渲染层：A7 排版符号作交互控件（✕/★，非彩色 emoji 不构成 P0，建议统一 SVG）；A8 文档漂移与死代码（preload 头注释过期、`okN += 0`、split 模式不可达检查）；A9 mammoth 输出未 sanitize 直接 innerHTML（本地离线+用户自选文件，实际风险低）；A10 canvas 功能色值备案（PDF 铺白/水印墨色，非 UI 主题，不构成违规）。
QA：A1 assert(true) 弱断言 6 处（失败检测由 waitForFunction 超时承担，不构成假绿）；A2 test-print-doc 硬编码结果文案；A3 test-zip 非 Win 无工具时静默 skip；A4 pdfcore IO 层仅 typeof 断言；A5 docs-ocr 主链路无冒烟；A6 main.js system IPC 注册无验证。

> **状态更新（2026-10-19 第三轮）**：以上 15 项已全部处置完毕（BE-A1~A5 / FE-A7~A9 / QA-A1~A6 共 14 项修复 + FE-A10 备案确认），处置明细见第八节第三轮修复记录。

---

## 七、修复优先级建议（检测时排序，已按序执行，实际执行记录见第八节）

1. ~~**P1-2**（PDF 预览必坏，一行修复：改用 core.loadPdf）~~ → **已证伪**（真机实测裸 ArrayBuffer 可正常加载），保留为 DRY 重构 + cleanup 防泄漏改进项
2. **P1-1**（中文用户体验，一行修复：OutputEncoding UTF-8）→ 已修复，真机探针证实
3. **P1-3 / P1-4**（批量路径错误分支，按 runShrink 模式补 per-file catch）→ 已修复
4. **P0-1**（emoji 图标换 SVG）→ 已修复
5. **T1-T3**（补行为测试）→ T3（esc 断言）与 docs-pdf 钩子断言已补；T1/T2 及 QA-B4/B5/B6 于第二轮全部补齐（见第八节）
6. P2 按排期：B2（进度回归）→ B3（对话框被强关）→ B14（dns 超时）→ B5/B8/B13 → 已全部修复；B4/B6/B7/B9/B10/B11/B12 + A2/A4/A5/A6 于第二轮全部修复（见第八节）

## 八、修复记录（2026-10-19 当日完成）

以下修复已全部实施并通过 **ESLint 0 告警 + npm test 22 套件 1038 断言 0 失败（退出码直读 npm test）**：

| 编号 | 修复内容 | 验证方式 |
|---|---|---|
| P0-1 | `js/app.js:958` ⚠️ emoji → Lucide 风格内联 SVG 警告图标（triangle-alert），css 补 `.warn-banner .icon` 间距 | 全库 emoji 正则扫描归零；test-dom 319 断言含无引导期错误 |
| P1-1 | `electron/main.js` windowsDefaultPrinter 的 `-Command` 前加 `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` | **真机探针证实**：无前缀 PowerShell 输出 GBK 字节 `bb dd c6 d5` → UTF-8 解码成乱码；加前缀输出 `e6 83 a0 e6 99 ae` → 正确得「惠普」 |
| P1-2 | `js/docs-pdf.js` runMerge/runSplit 补 per-file try/catch + addResult(失败) + 失败状态行 + `pdf.cleanup()`，对齐 runShrink 范式（注：cleanup 实际只覆盖 runSplit，runMerge/runShrink 共用的 pdfToPages 泄漏由第四轮审查证伪后补齐，见 RV-1） | test-dom 新增 docsPdf _test 钩子 5 断言（setItems/move/listRef） |
| P1-3 | `js/docs-convert.js` 图片合并分支补 per-file try/catch；run() 支持 noSummary 精确状态行；删死代码 `okN += 0` | test-dom 319 断言通过 |
| （原 P1-2 证伪项） | `js/docs-watermark.js` 预览与主管线统一走 `core.loadPdf` + `try/finally cleanup()`；「共 N 页」假数据改为「含 PDF N 个」诚实计数 | 真 Chromium 探针：两种数据形态均加载成功（根因归属更正）；npm test 通过 |
| B2 | `electron/7z-args.js` parseProgress 改按 `\r\|\n` 切分取末段 + 行首锚定 `/^\s*(\d{1,3})%/`，防文件名「数字+%」劫持 | test-archive 新增 3 断言（`100%完成.txt` 不劫持、多帧含 % 取末帧、空输入 null），107→110；后端审查用真实 7z.exe -bsp1 字节流独立复核：旧实现对「78% 14\r100%完成.txt 5」返回 100（劫持）、新实现返回 78（正确） |
| B3 | `electron/main.js` showProperties 改 spawn（spawn/error 事件），不再用 15s execFile 超时杀对话框 | 代码审查确认对齐 system.js launch 范式；npm test 通过 |
| B13 | `electron/main.js` whenReady 链补 .catch：落诊断日志 + dialog 报错 + app.quit()，不再静默变僵尸 | npm test 通过 |
| B14 | `electron/system.js` dnsProbe 补 3s 超时（Promise 内 settled 哨兵 + clearTimeout） | npm test 通过 |
| A3 | `js/system.js` 三个打印机操作补 .catch；printTest 加在途标志防连点发多张测试页 | npm test 通过 |
| B5 | `electron/archive.js` compress/extract 入口 `payload = payload \|\| {}` 空值防护 | npm test 通过 |
| B8 | `electron/archive.js` listArchive 取消路径补 `cancelled: true` 标记（与 run7z 一致） | npm test 通过 |
| T3 | `js/system.js` esc() 经 `_test.escRef` 导出，test-dom 新增 4 断言（五字符转义 + 空值兜底） | test-dom 310→319 |

### 本轮未修复（留待排期）

- ~~**T1/T2 深度行为测试**~~ → **已补齐**（见下轮修复记录）
- ~~**B6**（zip+volumeMB 主进程显式拒绝）、**B7**（7z 失败清理半成品）、**B9**（printImage 看门狗）、**B10**（listArchive 输出封顶）、**B11**（并发哨兵）、**B12**（7z 错误信息 GBK 解码）~~ → **已全部修复**（见下轮修复记录）
- 其余 P2 与 advisory 见第五、六节

### 第二轮修复记录（2026-10-19 深夜，P0/P1/P2 全清）

用户要求「P0/P1/P2 全部全量修复，无遗留」。本轮将剩余 P2 六项（B4/B6/B7/B9/B10/B11/B12）、渲染层 P2 四项（A2/A4/A5/A6）、测试缺口全部（T1/T2 + QA-B4/B5/B6 + Cropper 覆盖表缺口）修完。以下修复已全部实施并通过 **ESLint 0 告警 + npm test 23 套件 1057 断言 0 失败（退出码直读 npm test）**：

| 编号 | 修复内容 | 验证方式 |
|---|---|---|
| B4 | `electron/7z-args.js` 目录属性判定 `/\bD/` → `/^D/`（对齐项目约定） | test-archive 110 断言通过 |
| B6 | `electron/archive.js` compress 入口显式拒绝 zip + volumeMB>0（「ZIP 格式不支持分卷压缩，请改用 7z 格式」），不再静默返回 size:0/parts:1 | 代码审查 + 全量测试 |
| B7 | compress 失败（非取消）分支补 `removeOutputs()`：密码错误/磁盘满后清掉截断半成品与残缺分卷，与取消路径策略一致 | 代码审查 + 全量测试 |
| B9 | `electron/main.js` print:printImage 加 60s 看门狗：print 回调永不触发（驱动挂起）时 destroy 隐藏窗口 + 返回「打印超时」错误，防窗口/路由/IPC promise 三泄漏、按钮永久禁用 | 代码审查 + 全量测试 |
| B10 | listArchive 输出累积封顶 64MB：超限杀子进程并报「内容列表超过 64MB，已中止读取」，防超大包 -slt 输出压垮主进程 | 代码审查 + 全量测试 |
| B11 | archive.js 模块级 `archiveBusy` 并发哨兵：compress/extract 同一时刻只允许一个任务，第二个直接返回「已有压缩/解压任务进行中」（IPC 可被 devtools 直连，两个压缩会互相删产物） | 代码审查 + 全量测试 |
| B12 | run7z stderr 改 Buffer 收集 + `decodeErrTail()`：先试 GBK 解码（中文 Windows 本地化 7z），UTF-8 解码含 U+FFFD 判定乱码弃用，让 exitCodeText 中文说明优先；干净本地化错误行保留 | test-archive 110 断言通过 |
| A2 | `js/docs-convert.js` Word→PDF 末页按源高度等比缩放（`dstH = slice.height × srcH / A4_PAGE_PX`），不再拉满整页（561px→1684px 约 3 倍拉伸变形） | 代码审查 + 全量测试 |
| A4 | `js/docs-watermark.js` 预览加 `previewGen` 代数丢弃过期回调（防慢渲染覆盖新预览）+ `pdfCache` 同文件缓存（大 PDF 拖滑块不重复读盘），切文件/清空/进面板时 `releasePdfCache()` 释放句柄 | 代码审查 + 全量测试 |
| A5 | `js/docs-ocr.js` run() 收尾（joinUnits/updateMeta/exportsEnable）包进 try + finally 复位按钮/running，异常不再永久锁死 | 代码审查 + 全量测试 |
| A6 | `js/pdfcore.js` 新增共享 `uniqueOutName()`（archive.js bumpOutName 的 FSA 版）；docs-watermark / docs-convert / docs-pdf 全部写盘点改用，同名输出追加 _N 后缀，不同文件夹多选同名不再静默覆盖 | test-dom uniqueOutName 2 断言 + 三模块行为测试 |
| T1 | docs-convert 行为测试：`_test` 钩子扩 setItemsRef/setModeRef/runImagesToPdfRef/runPdfToImagesRef；test-dom 新增 7 断言（坏图合并不葬送整批、p2i 逐页输出、坏 PDF 不中断、状态行如实 1/2）——jsdom 内 stub createImageBitmap/假 canvas/IO 层 | test-dom 319→350 |
| T2 | docs-pdf 行为测试：`_test` 钩子扩 runMergeRef/runSplitRef/runShrinkRef/setModeRef/setDirRef；test-dom 新增 6 断言（合并坏 PDF 只记失败、拆分按页码范围提取） | test-dom 350 断言 |
| QA-B4 | 新建 `tools/test-system.cjs`（16 断言）：printTestPage 四路径（非 win32/空名/白名单外/白名单内放行且 spawn 参数无注入）、sysExe System32 解析、netInfo 回环过滤、dnsProbe/tcpProbe；spawn 在 require 前替换为假件，绝不真打印测试页 | test-system 16/16；npm test 挂入第 23 套件 |
| QA-B5 | settings 行为测试（test-dom 7 断言）：save→load 往返、quality/whiten 钳制边界、非法枚举不采纳、haoyue-idphoto-settings 旧键迁移并写新键、损坏 JSON 容错 | test-dom 350 断言 |
| QA-B6 | print clampCopies 行为测试（test-dom 4 断言）：空/非法/负值→1、小数取整、上限 99；`App.print._test.clampCopiesRef` 钩子 | test-dom 350 断言 |
| 覆盖表收尾 | Cropper 倾斜几何 `_test`（tiltPointRef/minScaleForRef）+ test-dom 4 断言：零倾斜恒等、90° 绕中心、minScale 公式、倾斜后放大 | test-dom 350 断言 |

**全清确认**：第五节 P2 表 19 项（B2-B14、A1-A6）已全部修复；第四节 T1/T2/T3 + QA-B4/B5/B6 已全部补齐。

### 第三轮修复记录（2026-10-19 深夜续，advisory 15 项全清）

用户要求「advisory 15 项一并处理，无遗留」。第六节所列主进程 A1-A5、渲染层 A7-A9、QA A1-A6 全部处置完毕（A10 canvas 功能色值为备案项，评估不构成违规，无需改动）。以下修复已全部实施并通过 **ESLint 0 告警 + npm test 24 套件 1084 断言 0 失败（退出码直读 npm test）+ npm run verify 全绿（含真实打包产物 21 断言）**：

| 编号 | 修复内容 | 验证方式 |
|---|---|---|
| BE-A1 | `electron/main.js` print:readFile 由 fs.statSync/readFileSync 同步读改 `fs.promises` 异步读（200MB 级文件不再阻塞主进程事件循环），返回形状不变 | 全量测试 + 打包产物 E2E |
| BE-A2 | `electron/archive.js` pickPaths/saveDialog 的 getWin() 补 `isDestroyed()` 检查（对齐 system.js），窗口销毁竞态下退回无父窗口对话框，不再抛原生 Error | 全量测试 |
| BE-A3 | `electron/preload.js` onProgress 改用独立 `progressBound` 标志：监听器全局只注册一次，onProgress(null) 后再入不再重复绑定（修掉进度事件双触发隐患） | 代码审查 + 全量测试 |
| BE-A4 | `electron/archive.js` check7z 版本号按整行匹配后在首个 `' :'` 处截断，UI 备注只保留「7-Zip 26.03 (x64)」，不再带出版权/日期行（实测本机 7z 26.03 版本行格式确认） | 全量测试 |
| BE-A5 | `electron/archive.js` run7z 的 error 分支优先判 `killedByUser`：cancel 后子进程先发 error 再 close 时按「任务已取消」收场，不再误报「7z 启动失败」 | 代码审查 + 全量测试 |
| FE-A7 | 交互控件标识统一 SVG：新增共享助手 `App.ui.icon()`（Lucide 风格内联 SVG，与 file:// 警告图标同一 .icon 描边体系）；print-batch 上移/下移/移除、compose 前移/后移/移除、docs-pdf 上移/下移全部换 SVG + aria-label；默认打印机标记 print.js 与 system.js 统一为「（默认）」文字（option 元素内无法含 SVG）；index.html 两处帮助文本改文字描述；css 补 .ops button 图标居中 | test-dom 新增源码级扫描断言：5 文件（print/print-batch/compose/docs-pdf/index.html）排版符号零残留；verify-print-batch 43 断言真机通过 |
| FE-A8 | 死代码与文档漂移清理：docs-watermark 删未使用的 `wmImg.f` expando；docs-pdf 删不可达的 split 多文件检查（该模式只保留首个文件）；preload 头注释从「仅暴露打印能力」更新为五组桥接实际描述 | 全量测试 |
| FE-A9 | `js/docs-convert.js` 新增 `sanitizeDocxHtml()`：mammoth 输出进 innerHTML 前剥离 on* 事件属性、危险协议 URL（黑名单 javascript/vbscript/livescript/mocha/data（img data:image 除外）/file，http(s) 与相对地址保留）、危险 style 表达式、script/iframe/object 等可执行与外联标签 | test-dom 新增 sanitizeRef 8 断言（含回归：http(s) 外链与 data:image 内嵌图必须保留——首版实现误杀 http 链接被断言当场抓住） |
| QA-A1 | assert(true) 弱断言 6 处全清：verify-print-batch（4 处）与 verify-packaged（1 处）改为对 `waitForFunction` 返回值的 `jsonValue() === true` 实质断言（超时检测仍由 throw 承担，行为不变）；test-server 的无局域网 IP 分支改显式 skip 计数 | verify-print-batch 43/43、verify-packaged 21/21 通过 |
| QA-A2 | test-print-doc 硬编码「20 通过, 0 失败」改动态计数（node assert 计数包装）——实测该文件早有 23 条断言，旧文案长期少报 3 条 | test-print-doc 23 通过 |
| QA-A3 | test-zip 无解压器时的 skip 显式化：记 skip 计数并在汇总行声明「另跳过 N 项：无可用解压器」，退出码仍只由失败数决定（ZIP 结构/CRC32 断言仍覆盖正确性） | test-zip 26 通过 |
| QA-A4 | test-pdfcore 18→26：writeBytes/ensureSubDir/uniqueOutName 由「仅 typeof」升级为 fs 真实落盘行为断言（os.tmpdir() + 假 FSA 句柄：字节一致性、Blob 入参、子目录创建与幂等、同名防覆盖序号递增） | test-pdfcore 26/26 |
| QA-A5 | 新建 `tools/verify-ocr.cjs`（挂入 npm run verify）：OCR 主链路真机冒烟——页内 canvas 生成「HELLO 123」图片，经 js/docs-ocr.js 新增 `_test.ocrRef` 钩子走真实 Tesseract worker（vendor core wasm + chi_sim/eng 语言包 → recognize → cleanText） | **实测一次通过：识别 "HELLO 123"，置信度 91** |
| QA-A6 | system IPC 注册正确性双重覆盖：① 新建 `tools/test-ipc-contract.cjs`（npm test 第 24 套件）：preload 每个 invoke/send 通道必须有主进程 handle/on 注册（防拼写不一致/漏挂）；② verify-packaged 新增系统工具 E2E——进模块并真实调用 system:netInfo 断言返回网卡数组 | test-ipc-contract 3/3；verify-packaged 21/21（fresh build） |

**advisory 全清确认**：第六节 15 项——BE-A1~A5（5 项）、FE-A7~A9（3 项）、QA-A1~A6（6 项）、FE-A10（备案项，评估不构成违规）全部处置完毕，无遗留。

### 第四轮修复记录（2026-10-20 凌晨，提交前三路独立审查补记）

提交前由前端 / QA / 后端三路专家独立审查 + 总监逐条复核，发现 **2 项 blocking、10 项 advisory**，全部就地修复（后端审查对其余 17 项修复用真实 7z.exe 字节流独立复核均为属实）。以下修复已全部实施并通过 **ESLint 0 告警 + npm test 24 套件 1091 断言 0 失败（退出码直读 npm test）**：

| 编号 | 修复内容 | 验证方式 |
|---|---|---|
| RV-1（前端 blocking） | `js/docs-pdf.js` pdfToPages（runMerge/runShrink 共用）经 core.loadPdf 加载后从不 cleanup，P1-2 行声称只对 runSplit 成立——审查证伪。函数体包 try/finally，getDocument 的 worker/句柄泄漏修复 | test-dom 新增 cleanup 间谍断言（合并路径每个成功解析的 PDF 均被释放） |
| RV-2（前端 advisory） | `js/docs-convert.js` runPdfToImages 与 `js/docs-ocr.js` PDF 分支补齐 pdf.cleanup()（报告未声称，与 runSplit 范式对齐） | test-dom p2i cleanup 间谍断言 |
| RV-3（前端 advisory） | `js/docs-watermark.js` pdfCache 竞态：loadPdf await 期间新预览使旧回调过期后，旧回调仍无条件覆写缓存——两份文档句柄一起泄漏。现加载完成后先判代数，过期即 cleanup 并放弃占缓存 | 代码审查 + 全量测试 |
| RV-4（前端 advisory） | `js/docs-pdf.js` runSplit 页码范围无效时返回 {okN:0} 无 noSummary，状态行谎报「完成：成功 0 项，已输出到…」。补 noSummary + 明确失败状态行 | test-dom 新增无效区间断言（noSummary 且无产出） |
| RV-5（前端 advisory） | `js/app.js` App.ui.icon 未知图标名静默回退 x，补 console.warn 开发期告警 | test-dom 新增告警断言 |
| RV-6（QA blocking） | `tools/test-system.cjs` 7 处断言跑在真实平台上：CI ubuntu 腿上 printTestPage 返回 NOT_WIN，白名单内路径的 ok/spawnCalls 断言全红，且 spawnCalls[0].exe 取空数组元素 TypeError 硬崩套件（exit 2）。win32 前提路径统一切 withPlatform('win32') 假平台（Windows 上恒等包装，行为零变化） | 代码审查 + 全量测试；Windows 上原 16 条断言集不变 |
| RV-7（QA advisory） | `tools/test-ipc-contract.cjs` 主进程文件名单硬编码 6 个，新增 electron 模块会被静默漏检——改 electron/ 目录扫描 | test-ipc-contract 3/3 不变 |
| RV-8（QA advisory） | `tools/test-dom.cjs` settings 损坏 JSON 容错用 assert(true) 占位（与 QA-A1「占位全清」自相矛盾）——改实质断言（损坏 load 不抛错且不改写当前值） | test-dom 370 断言 |
| RV-9（QA advisory） | test-dom 引导错误过滤器全局豁免 [zunhong] 前缀，会把 stub 还原后的真实诊断错误一起吞掉——收窄为只豁免行为测试窗口内的 intentional 失败路径 | test-dom「无引导期脚本错误」断言仍在 |
| RV-10（QA advisory） | 更正历史组计数漂移：docs-convert 行为测试 8→7、docs-pdf 行为测试 5→6、sanitizeRef 9→8（QA 机械核实调用点；各处总数准确） | 文档更正 |
| RV-11（后端 advisory） | B8 的 cancelled 标记无渲染层消费方：js/archive.js 内容浏览失败分支补 cancelled 判断，取消按中性「读取已取消」收场，不再显示为红色读取失败 | 代码审查 + 全量测试 |
| RV-12（后端 advisory） | decodeErrTail 策略调整为先判 UTF-8 合法性再试 GBK：7z UTF-8 构建的合法非 ASCII 错误行不再被 GBK 分支解成乱码采用；中文 Windows 本地化 GBK 输出路径不变（electron/archive.js） | 代码审查（GBK/UTF-8 双场景推演）+ 全量测试 |
| RV-13（后端 advisory） | listArchive 输出上限改按字节累计：原按 UTF-16 码元计，中文条目 1 字符 3 字节会少算约 3 倍，实际 192MB 级输出才触发 64MB 封顶（electron/archive.js） | 代码审查 + 全量测试 |
| RV-14（后端 advisory） | test-archive 新增真实 7z 含子目录归档的压缩与 l -slt 列表断言——目录条目 isDir 判定（/^D/）对真实输出闭环（原单元测试样本为合成属性串） | test-archive 110→112 |
| RV-15（后端 advisory） | test-system 新增 dnsProbe 解析器挂起时 3s 超时断言（stub dns.lookup 永不回调，与 tcpProbe 超时对齐） | test-system 16→17 |

**遗留 backlog 处置记录（第五轮全部清零）**：

| # | 事项 | 处置 |
|---|---|---|
| 1 | 正文遗留排版符号 ✓ / ⚠ / ← / →（非 emoji、非交互控件标识，不构成 P0-1 违反） | **已 SVG 化**：index.html 34 处按钮/标签（27 个「← 返回」+ 4 个「下一步 →」+ 3 个「X → Y」转换标签）的导航箭头改内联 SVG；print / print-batch / sheet / archive 四模块状态行与 toast 的成功失败标识改 App.ui.statusText（文本 textContent + 末尾 SVG，新增 check / alert 图标）；帮助文本按既有约定改文字描述。test-dom 源码扫描升级为 7 文件控件符号 + 全 js 对勾/警示字符零残留（注释计入） |
| 2 | electron/archive.js 344 行略超 300 行指引 | **已拆分**：archive-engine.js（196 行，7z 进程机制：定位/运行/取消/哨兵）+ archive.js（290 行，IPC 层：对话框/校验/进度/注册），哨兵上移为 runExclusive 共用；test-archive 新增结构守卫 20 断言（行数/分层/导出面） |
| 3 | verify-ocr 未挂 release.yml 门禁 | **已挂**：release.yml 测试门禁后、打包前新增 Chromium 安装 + OCR 主链路冒烟两步；ms-playwright 目录纳入 actions/cache |
| 4 | 7z.exe 被安全软件误报时本机冒烟无法机械检测 | **可处置部分已做**：引擎层 no7zError() 统一文案——「未找到 7z 引擎」时提示安全软件误隔离及恢复/信任/重启步骤（或安装 7-Zip），check7z / compress / extract / listArchive 四路径共用；完整排查仍指向 docs/security-software-compatibility.md。「本机误报」本身依赖用户环境，机械检测不适用，维持已知风险备案 |

---

## 九、已检查未发现问题的方面（三专家共识）

- IPC 契约：5 个桥接全部方法名/参数/返回结构与主进程实现、渲染层调用点逐一对上（含新增 system:* 五方法）
- app.js 注册表：MODULE_CARDS(6) / SUB_ENTRIES(34) / MODULE_INITS(15) 与 index.html 全部对应，无重复注册
- DOM 解引用：200+ 元素 ID 全部存在于 index.html；新模块无裸 getElementById
- 依赖存在性：pdf.js v6 adapter / Tesseract v5 API / vendor 模型文件全部在位，无幻觉依赖
- 7z 安全：-sccUTF-8、`--` 终止防注入、密码单参数形态；数据安全（hasInputConflict 先于 removeOutputs，单文件同名覆盖路径已封死）
- 路径安全：static-server 四防护（同前缀兄弟目录/NUL/畸形百分号/Host 白名单）齐全
- 注册表安全：archive-icons 只写 HKCU、不覆盖已有关联、备份还原闭环
- 资源释放：run7z/printWin/tcpProbe 全路径清理；进度监听单注册
- 全局约定：无 window.confirm/alert；$ 统一 App.ui.$；localStorage 键迁移符合约定
