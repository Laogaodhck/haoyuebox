# 更新日志

本项目所有显著变更记录于此。版本号遵循语义化版本（主版本.次版本.修订号）。

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
