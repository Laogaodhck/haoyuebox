/* ============================================================
 * verify-packaged.cjs — 打包产物 E2E（Playwright _electron 驱动真实 exe）
 *
 * 真实链路：打包产物启动 → 首页渲染 → 版本一致 → preload 桥接真身
 *           → 压缩工具真实 IPC 冒烟（打包内 7z 引擎检测）→ 无页面错误
 *
 * 产物定位（依次尝试，全部缺失时优雅跳过，不阻塞 verify 链）：
 *   1. 环境变量 ZUNHONG_PACKAGED_EXE 指向打包 exe
 *   2. release-build/win-unpacked/尊泓工具箱.exe （npm run dist 本地输出）
 *   3. release/win-unpacked/尊泓工具箱.exe
 *
 * 产出 unpacked：npx electron-builder --win --dir（无需 NSIS 安装包）
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { createChecker, sleep } = require('./_lib.cjs');

const checker = createChecker();
const assert = checker.assert;

const EXE_NAME = '尊泓工具箱.exe';
const PKG_VERSION = require('../package.json').version;

const candidates = [
  process.env.ZUNHONG_PACKAGED_EXE,
  path.join(__dirname, '..', 'release-build', 'win-unpacked', EXE_NAME),
  path.join(__dirname, '..', 'release', 'win-unpacked', EXE_NAME)
].filter(Boolean);

const exe = candidates.find((p) => fs.existsSync(p));
if (!exe) {
  console.log('verify-packaged: 未找到打包产物，跳过');
  console.log('  提示：npx electron-builder --win --dir 产出后重跑，或设 ZUNHONG_PACKAGED_EXE=<exe 绝对路径>');
  process.exit(0);
}

(async () => {
  const { _electron } = require('playwright');
  const env = Object.assign({}, process.env);
  /* 沙箱可能注入 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化成 node 而非启动应用 */
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await _electron.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--disable-gpu-sandbox'], /* 沙箱/CI 环境需要；真机不受影响 */
    env
  });
  const pageErrors = [];
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await sleep(600); /* 等模块 init 与异步探测落地 */
    win.on('pageerror', (e) => pageErrors.push(e.message));

    /* ---------- 应用级：真实主进程版本 ---------- */
    const appVersion = await app.evaluate(({ app }) => app.getVersion());
    assert(appVersion === PKG_VERSION, '打包产物 app.getVersion()=' + appVersion + ' 与 package.json 一致');

    /* ---------- 首页渲染 ---------- */
    assert(/尊泓工具箱/.test(await win.title()), '窗口标题包含「尊泓工具箱」');
    const homeVersion = await win.$eval('.home-version', (el) => el.textContent);
    assert(homeVersion === '桌面离线版 v' + PKG_VERSION,
      '首页版本标签「' + homeVersion + '」与 package.json 一致');
    assert(await win.$('#home-archive') && await win.$('#home-photo'), '首页功能卡片渲染齐备');

    /* ---------- preload 桥接真身（contextIsolation 隔离下的真实注入） ---------- */
    const bridges = await win.evaluate(() => ({
      archive: !!window.zunhongArchive && window.zunhongArchive.isDesktop === true,
      print: !!window.zunhongPrint,
      diag: !!window.zunhongDiag
    }));
    assert(bridges.archive, 'zunhongArchive 桥接已注入（打包 preload 生效）');
    assert(bridges.print && bridges.diag, 'zunhongPrint / zunhongDiag 桥接已注入');

    /* ---------- 单功能真实冒烟：压缩工具 → 主进程 IPC check7z ---------- */
    await win.click('#home-archive');
    assert(await win.$eval('#view-archive', (el) => el.style.display === 'block'),
      '点击首页卡片进入压缩工具模块');
    assert(await win.$eval('#archive-menu', (el) => !el.hidden), '子功能菜单可见');
    await win.click('#archive-open-compress');
    assert(await win.$eval('#ac-unsupported', (el) => el.hidden),
      '桌面打包环境下不显示「浏览器不可用」提示');
    /* #ac-note 来自真实 IPC archive:check7z → 打包内 resources/bin/7z.exe */
    await win.waitForFunction(() => /7z 引擎已就绪/.test(document.getElementById('ac-note').textContent),
      null, { timeout: 15000 });
    assert(true, '主进程真实 IPC：打包内 7z 引擎检测通过');

    /* ---------- 模块切换回归 + 未开发占位页 + 无页面错误 ---------- */
    await win.click('#ac-back');
    await win.click('.module-tab[data-module="photo"]');
    assert(await win.$eval('#view-photo', (el) => el.style.display !== 'none'), '顶栏切回照片工具正常');
    await win.click('#photo-open-restore');
    assert(await win.$eval('#photo-soon', (el) => !el.hidden), '照片工具「老照片修复」占位页可见');
    await win.click('#soon-photo-back');
    assert(await win.$eval('#photo-soon', (el) => el.hidden) && await win.$eval('#photo-menu', (el) => !el.hidden),
      '占位页返回子功能菜单正常');
    await win.click('#photo-open-idphotoprint');
    assert(await win.$eval('#print-soon', (el) => !el.hidden), '照片工具「证照打印」占位页可见');
    await win.click('#soon-print-back');
    assert(await win.$eval('#print-soon', (el) => el.hidden) && await win.$eval('#photo-menu', (el) => !el.hidden),
      '证照打印占位页返回菜单正常');
    await win.click('.module-tab[data-module="print"]');
    assert(await win.$eval('#print-menu', (el) => !el.hidden), '文档工具子功能菜单可见');
    await win.click('#print-open-docs');
    assert(await win.$eval('#pd-doc', (el) => !el.hidden), '文档打印面板可见');
    await win.click('#pd-back');
    assert(await win.$eval('#print-menu', (el) => !el.hidden), '文档打印返回菜单正常');
    assert(pageErrors.length === 0,
      '全程无页面脚本错误' + (pageErrors.length ? '：' + pageErrors.join(' | ') : ''));
  } finally {
    await app.close().catch(() => {});
  }
  checker.finish();
})().catch((e) => {
  console.error('脚本异常:', (e && e.message) || e);
  process.exit(2);
});
