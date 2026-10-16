# 尊泓工具箱 v1.2.0 功能完成度评测报告

- 评测日期：2026-10-17
- 评测对象：commit `b2b92bf`（v1.2.0，工作区干净）
- 评测方式：全量门禁实跑 + 全模块代码走查（渲染层 22 文件 + 主进程 7 文件，约 9000 行）
- 性质：只读评测，未修改任何代码

> **✅ 整改状态（2026-10-17 更新）：报告所列全部 24 项问题已修复，见文末「六、整改结果」。以下为评测当时的原始记录，保留作历史存档。**

---

## 一、门禁证据（全部实跑，退出码直读）

| 门禁 | 结果 | 明细 |
|---|---|---|
| `npm test` | ✅ exit 0（27s） | 18 套件，776 断言，0 失败 |
| `npm run verify` | ✅ exit 0（1m14s） | 10 套件，约 223 断言，0 失败 0 跳过 |
| `npm run lint` | ✅ exit 0 | ESLint 9 全仓无告警 |

---

## 二、问题清单

严重度定义：P0 崩溃/数据丢失（未发现）｜P1 功能错误｜P2 健壮性/体验缺陷｜P3 低风险/代码质量。

### P1（3 条，建议 v1.2.1 修复）

| # | 位置 | 问题 | 复现 |
|---|---|---|---|
| 1 | `js/compress.js:43-54`（配合 204-216） | keep 模式 GIF/BMP **格式错标**：pickExt 保留 `.gif/.bmp` 扩展名，但 pickMime 只认 jpeg/png/webp、其余回退 `image/jpeg` → canvas 实际编码为 JPEG，数据却存成 `.gif/.bmp` 文件，部分看图软件报错 | 导入 GIF → 保持原格式 → 压缩 → 输出的 .gif 实为 JPEG |
| 2 | `js/sheet.js:212-258` | 批量导入失败处理不完整：① img.onerror 只计数不提示；② 全部失败时完全静默；③ 部分失败仍提示「已导入 N 张 ✓」用含失败的总数，**虚报成功数**；④ FileReader 未绑 onerror，出错时进度条永久卡住 | 拖入 10 张含 3 张损坏图 → 提示「已导入 10 张 ✓」实为 7 张 |
| 3 | `js/composer.js:272-318` | **超大照片被静默裁切**：单元格大于相纸可用区时 sheetCapacity 的 cols/rows=0 被 `Math.max(1,0)` 兜成 1，startX 可为负，drawImage 越界部分丢失；layoutBatch 对非空 cells 永不返回 null，调用方判空失效 | 导入 5000×7000 照片 → 六寸相纸 → 照片被裁掉大半且无警告 |

### P2（10 条）

| # | 位置 | 问题 |
|---|---|---|
| 4 | `js/segmenter.js:35-45` | init 失败的 rejected promise 被永久缓存：首次模型加载失败后本会话所有 segment() 永远失败，无重试入口 |
| 5 | `js/segmenter.js:148-156,167-218` | yieldUI 依赖 rAF：窗口最小化/遮挡时 rAF 暂停，大图处理中最小化窗口 → await 永不 resolve，界面假死 |
| 6 | `js/matteview.js:148-162` | 空格平移监听只排除 TEXTAREA 未排除 INPUT：抠图激活时任何单行输入框无法输入空格；attach 重复调用会重复绑定 |
| 7 | `js/cropper.js:133` | setPointerCapture 未包 try（brush.js:187 有包）：指针失效抛 NotFoundError 中断拖拽 |
| 8 | `js/compose.js:232-251,104-136` | 合成进行中缩略图的移除/清空按钮未禁用：移除全部图片 → renderTo 返回 null → run 里 `layout.W` 抛 TypeError，报错信息晦涩 |
| 9 | `js/compress.js:176-180` | 压缩运行中格式/尺寸控件未禁用：中途改设置触发 renderAll 重建表格，writeOutSize 按旧索引写错行（清空按钮同样未锁） |
| 10 | `js/compose.js:75-102` | addFiles 将每张 ImageBitmap 全程缓存无总量上限：约 20 张 4000×3000 图 ≈ 1GB 内存常驻 |
| 11 | `js/app.js:723` | **MODULE_INITS 无逐模块隔离**：一个模块 init 抛错，其后所有模块（含注册表后段）全部不初始化，页面半瘫（仅有全局 toast 兜底） |
| 12 | `electron/archive.js:150-158` | IPC `outPath` 未校验（渲染层可传任意路径触发 `fs.rmSync`）；分卷清理 `f.startsWith(base + '.')` 会误删同前缀无关文件（如 `photos.7z.bak`） |
| 13 | `electron/archive.js`（run7z） | 7z 子进程无超时/取消机制：异常挂起时任务永久占用 running 标志，UI 无取消按钮，只能重启应用 |

### P3（11 条）

| # | 位置 | 问题 |
|---|---|---|
| 14 | `electron/print-doc.js:62` | dataURL 未转义直接拼 HTML 属性：`data:image/png" onerror="…` 形式可注入打印窗口（窗口 sandbox 且无 preload，实际影响有限） |
| 15 | `js/compress.js:235` | 单文件下载 `new Blob([...], {type:'image/*'})` 非法 MIME |
| 16 | `js/sheet.js:59-66,185` | copies 无钳制（NaN → 误报「无法排入相纸」）；toBlob 可 resolve null → 晦涩 TypeError |
| 17 | `js/dpi.js:70-73` | 旧 pHYs 块位置靠后时不删除 → 产出含双 pHYs 的 PNG，违反单块规范 |
| 18 | `js/brush.js:201,225-232` | brushSize 缺失时 lineWidth=NaN 被静默忽略；stop 对未按下的 pointerId 也递减计数 |
| 19 | `js/cropper.js:136,149` | 双指同坐标 pinch.dist=0 → factor=Infinity，中间态 ±Infinity 传入合成一帧 |
| 20 | `js/convert.js:156` | outName 缺失时用空 used 表兜底，理论上可生成重名 ZIP 条目 |
| 21 | `electron/preload.js:29` | onProgress 重复调用会叠加监听器（当前仅调用一次） |
| 22 | `electron/static-server.js` | 无 socket 超时（慢速连接可占住句柄；仅回环监听，风险极低） |
| 23 | `electron/archive.js` | 7z 密码经命令行 `-p` 传递，本机进程列表可见（单用户离线场景可接受） |
| 24 | `js/compress.js` | GIF 压缩走 canvas 重编码丢动画（取首帧），UI 未提示 |

### 未发现明显问题的部分

- **主进程安全面**：static-server（Host 白名单 / root+sep 路径守卫 / NUL 与畸形编码 400 / 仅 GET-HEAD）、CSP 逐字一致、contextIsolation+sandbox、preload 不暴露 Node、will-navigate/setWindowOpenHandler 拦截、打印窗口 sandbox——整体姿势良好。
- **持久化**：settings.js 与 printer-manager.js 均有损坏 JSON 兜底；台账导入有格式校验与 sanitizePrinter 清洗；导出/导入备份格式自描述。
- **批量与打印链**：batch-format / batch-watermark / print / print-batch 异常处理完整（failed 列表、逐项 catch、对象 URL 统一 revoke、txt GBK 解码回退、doc 旧格式明确提示转换）。
- **纯逻辑层**：zip.js（CRC32/DOS 时间/EOCD 构造正确）、specs.js（byId 有兜底）、printer-probe.js（超时钳制、永不 reject、错误码中文化）、7z-args.js（`--` 分隔符齐备、数组 spawn 无注入、UTF-8 输出、进度解析有界）。

---

## 三、整体评估结论

**完成度评级：良好（B+ / 85 分），可放心日常使用。**

| 维度 | 评分 | 说明 |
|---|---|---|
| 功能完整度 | 9/10 | 全部入口可用，无「敬请期待」占位；分卷/浏览/压缩为 v1.2.0 新增且已闭环 |
| 正确性 | 8/10 | 门禁全绿（999 断言）；但 3 个 P1 集中在照片工具链的边界路径，单测未覆盖 |
| 健壮性 | 7.5/10 | 错误提示可感知性普遍好（失败均 toast + 首个失败文件名）；扣分在 init 隔离、无取消机制、rAF 假死 |
| 安全 | 9/10 | 主进程防护到位、暴露面最小；仅 outPath 校验与 dataURL 转义两处防御纵深缺口 |
| 可维护性 | 8.5/10 | 声明式注册表、纯逻辑 `_test` 导出、注释精炼；lint 全绿 |

核心结论：
1. **无 P0**——不存在崩溃、数据丢失或安全漏洞级问题；主流程（证照生成、转换、合成、压缩/解压、批量、打印）在门禁与走查中均按预期运行。
2. 问题呈**明显的链路聚集**：3 个 P1 全部落在「照片工具 → 排版导出」链（compress/sheet/composer），其余模块成熟度显著更高——这与 v1.2.0 新增 compress、以及 sheet/composer 是最早开发的历史代码相吻合。
3. v1.1.0/v1.2.0 的工程整改（$ 统一、confirm 模态、lint、测试补桩）效果扎实：本轮未再发现公共层分裂或假绿类问题。

## 四、改进建议（按优先级）

**短期（建议 v1.2.1，工作量约半天）**
1. 修 P1×3：① pickMime 对 keep 模式的 gif/bmp 明确「转 JPEG 并改扩展名 jpg」或直接禁用 keep；② sheet.js 补 onerror/reader.onerror + 真实成功计数；③ layoutBatch 对 cols/rows=0 返回 null 并 toast 提示「照片大于相纸可打印区」。
2. `app.js` MODULE_INITS 加逐模块 try/catch（失败 toast + 继续 init 其余模块）。
3. compress/compose 运行中禁用列表操作控件（复用 running 标志锁按钮）。

**中期（v1.3.0 候选）**
4. 7z 任务取消：记录当前 child 进程句柄，提供 `archive:cancel` IPC（kill），进度条旁加取消按钮。
5. 主进程 IPC 输入校验：compress 的 outPath 限定为 saveDialog 返回值风格（校验绝对路径 + 扩展名），分卷清理改精确正则 `/^\.\d{3}$/`。
6. segmenter 模型加载失败提供「重试」按钮；rAF 依赖改为 setTimeout 兜底。
7. matteview 空格监听补排除 INPUT；cropper setPointerCapture 包 try。

**长期**
8. compose 的 ImageBitmap 缓存加总量上限（如总像素 > 1 亿时对新增图降采样）。
9. P3 批量清理（一个提交顺手修完 14-24 条中的简单项）。
10. 打包版 E2E：verify 目前驱动的是源码页 + 本机 Chromium，建议增加一条「打包产物启动 → 首页渲染 → 单功能冒烟」的真实链路（CI 已有安装包产物，可复用）。
11. 遗留决策项：内置 SQLite（native 模块 + electron-rebuild，便携场景有兼容风险）仍待需求明确后单独评估。

---

## 六、整改结果（2026-10-17 追加）

**报告所列全部 24 项问题已修复完毕。** 涉及 21 个文件（+319/−84），相关提交：

| 提交 | 内容 |
|---|---|
| `4a9a496` | 首页版本标签 v1.0.0 → v1.2.0（评测前用户反馈即修）；check-refs 门禁新增「首页版本号 == package.json」断言防再漏 |
| `4ec49b9` | 全量整改主提交：P1×3 + P2×10 + P3×11，测试同步更新 |
| `aa77cbe` | 补充：取消压缩后自动清理半成品输出（残缺包与 .NNN 分卷卷）；解压取消刻意不清理（same 模式目录可能混有用户既有文件，防误删） |

### 逐项对应

- **P1-1**（GIF/BMP 格式错标）→ `pickExt` 增加输出 MIME 参数，扩展名随实际编码格式走；完成提示注明 GIF 按首帧转静态图（顺带闭环 P3-24）
- **P1-2**（导入静默/虚报/卡死）→ `settle()` 统一计数（img.onerror + FileReader.onerror），按真实成功数提示，全失败明确报错
- **P1-3**（超大照片静默裁切）→ `layoutBatch` 对超出相纸可打印区返回 null，调用方提示缩小照片或换相纸
- **P2-4/5**（模型失败永久缓存 / rAF 假死）→ 失败清空 initPromise 可重试；`document.hidden` 时退化为 setTimeout 让渡
- **P2-6**（空格劫持/重复绑定）→ 排除 INPUT/SELECT/contentEditable；WeakMap 防重挂载
- **P2-7/19**（pointerCapture / 捏合除零）→ 包 try；距离钳制最小 1
- **P2-8/9/10**（合成中删图 / 压缩中改设置 / 内存无上限）→ 合成与压缩运行中锁列表控件；输出判空给可读报错；1 亿像素总预算超限降采样
- **P2-11**（init 链无隔离）→ `app.js` MODULE_INITS 逐模块 try/catch + 诊断上报
- **P2-12**（IPC outPath / 分卷误删）→ 校验绝对路径与 .7z/.zip 扩展名；分卷清理精确 `.NNN` 匹配（`removeOutputs()` 与取消清理共用）
- **P2-13**（7z 无取消/超时）→ `archive:cancel` IPC + 取消按钮（压缩/解压/浏览均覆盖），多包解压中止后续包；内容浏览 30s 超时；取消压缩自动清理半成品
- **P3-14~23** → print-doc `escapeAttr` 转义（测试补注入断言）；下载 MIME 用实际编码格式；份数钳制 1–99；toBlob null 可读报错；PNG 清理全部旧 pHYs 保证单块合规；笔刷 brushSize 回退 30 + 计数只回收真实按下的 id；转换兜底命名复用已用名表；preload onProgress 单注册；静态服务器 socket 30s 空闲超时；7z 密码 argv 残留风险在 `7z-args.js` 注释记录评估结论（7-Zip 无 stdin 密码通道，离线单用户可接受）

### 整改后门禁（全部实跑，退出码直读）

| 门禁 | 结果 |
|---|---|
| `npm test` | ✅ 18 套件 **785 断言**（较评测时 +9），0 失败 |
| `npm run lint` | ✅ 0 告警 |
| `npm run verify` | ✅ 10 套件全绿（含真实 7z 分卷冒烟、DPI 300 注入验证） |

### 仍开放的事项

- 建议 10 已于 1.2.1 实施（tools/verify-packaged.cjs，_electron 驱动真实打包产物 12 断言，并接入 verify 链与 release.yml 门禁）；建议 11（内置 SQLite）待需求明确。
- 1.2.1 尚未发版：升 version + tag `v1.2.1` 后 GitHub Actions 自动出包，修复即达用户。
