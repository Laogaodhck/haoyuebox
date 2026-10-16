/* ============================================================
 * verify-printers.cjs — 打印机管理真机验证（Playwright + 真实页面链路）
 * stub window.zunhongPrint（listPrinters / probePrinter），走真实页面：
 * 导航 → 添加（对话框校验）→ 可用性检测（通/断两路）→ 检索筛选 →
 * 系统导入 → 编辑 → 删除（App.ui.confirm 模态点击确定）→ 持久化 → 返回菜单。
 * ============================================================ */
'use strict';

const { createChecker, launchBrowser, withServer } = require('./_lib.cjs');

const t = createChecker();
const assert = (c, n) => t.assert(c, n);

/* stub 行为开关：探测结果与系统打印机列表由测试页面内改写 */
const STUB = {
  probeOk: true,                 // probePrinter 返回成功/失败
  probeLatency: 12,
  sysPrinters: []                // listPrinters 返回值
};

(async () => {
  await withServer(8615, async () => {
    const browser = await launchBrowser();
    try {
      const ctx = await browser.newContext();
      await ctx.addInitScript((stub) => {
        window.zunhongPrint = {
          isDesktop: true,
          listPrinters() { return Promise.resolve(stub.sysPrinters.slice()); },
          probePrinter(p) {
            return Promise.resolve(stub.probeOk
              ? { ok: true, latencyMs: stub.probeLatency }
              : { ok: false, error: '连接被拒绝（目标未监听该端口）' });
          },
          showPrinterProperties() { return Promise.resolve({ ok: true }); },
          printImage() { return Promise.resolve({ ok: true }); }
        };
        window.__stub = stub;
      }, STUB);

      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('dialog', (d) => d.accept());   // 兜底：原生对话框自动接受（确认已改走 App.ui.confirm 模态）

      const rowCount = () => page.locator('#pm-table tbody tr').count();
      const firstRowText = () => page.locator('#pm-table tbody tr').first().textContent();
      const chipText = () => page.locator('#pm-table tbody tr .pm-st').first().textContent();

      await page.goto('http://127.0.0.1:8615/', { waitUntil: 'load' });

      /* ---------- 1. 导航到打印机管理 ---------- */
      await page.click('#home-print');
      assert(await page.$eval('#view-print', (el) => el.style.display === 'block'), '首页卡进入打印工具');
      assert(await page.$eval('#print-open-manager', (el) => !el.disabled), '打印机管理入口可用（非占位）');
      await page.click('#print-open-manager');
      assert(await page.$eval('#print-menu', (el) => el.hidden), '进入管理后面板菜单收纳');
      assert(await page.$eval('#print-manager', (el) => !el.hidden), '打印机管理面板可见');
      assert(await page.$eval('#print-batch', (el) => el.hidden), '批量打印面板保持隐藏（互斥）');
      assert(await page.$eval('#pm-empty', (el) => !el.hidden), '空台账显示空态提示');

      /* ---------- 2. 添加打印机（对话框 + 校验） ---------- */
      await page.click('#pm-add');
      assert(await page.$eval('#pm-dlg', (el) => !el.hidden), '添加对话框打开');
      assert(await page.$eval('#pm-row-conn', (el) => el.hidden), '系统类型默认隐藏连接配置组');

      /* 名称为空 → 保存被拒并提示 */
      await page.click('#pm-dlg-save');
      assert(await page.$eval('#pm-dlg-err', (el) => el.textContent.indexOf('名称') >= 0),
        '名称为空时保存被拒并给出原因');
      assert(await page.$eval('#pm-dlg', (el) => !el.hidden), '校验失败对话框不关闭');

      /* 切到网络类型 → 连接配置组出现；不填地址 → 被拒 */
      await page.selectOption('#pm-f-type', 'network');
      assert(await page.$eval('#pm-row-conn', (el) => !el.hidden), '网络类型显示连接配置组');
      await page.fill('#pm-f-name', '前台网络打印机');
      await page.click('#pm-dlg-save');
      assert(await page.$eval('#pm-dlg-err', (el) => el.textContent.indexOf('地址') >= 0),
        '网络类缺地址时保存被拒');

      /* 填完整配置保存（端口留空 → 协议默认 9100；新添加的网络类自动检测一次） */
      await page.fill('#pm-f-address', '192.168.1.50');
      await page.selectOption('#pm-f-protocol', 'Raw9100');
      await page.check('#pm-f-default');
      await page.click('#pm-dlg-save');
      assert(await page.$eval('#pm-dlg', (el) => el.hidden), '保存成功后对话框关闭');
      assert(await rowCount() === 1, '台账出现新打印机行');
      assert((await firstRowText()).indexOf('前台网络打印机') >= 0, '行内显示打印机名称');
      assert((await firstRowText()).indexOf('192.168.1.50:9100') >= 0, '连接配置展示地址与默认端口');
      assert(await page.$eval('#pm-table tbody tr .pm-star', (el) => !el.hidden), '默认打印机星标显示');
      assert(await page.$eval('#pm-stats', (el) => el.textContent.indexOf('共 1 台') >= 0), '统计栏计数正确');
      /* 新添加的网络/共享打印机自动检测：stub 返回成功 → 在线 */
      await page.waitForFunction(() => {
        const chip = document.querySelector('#pm-table tbody tr .pm-st');
        return chip && chip.textContent === '在线';
      }, null, { timeout: 5000 });
      assert(true, '新添加的网络打印机自动检测为在线');

      /* ---------- 3. 重复名校验 ---------- */
      await page.click('#pm-add');
      await page.fill('#pm-f-name', '前台网络打印机');
      await page.click('#pm-dlg-save');
      assert(await page.$eval('#pm-dlg-err', (el) => el.textContent.indexOf('同名') >= 0),
        '同名打印机保存被拒');
      await page.click('#pm-dlg-cancel');

      /* ---------- 4. 探测失败 → 离线 + 异常提示 ---------- */
      await page.evaluate(() => { window.__stub.probeOk = false; });
      await page.locator('#pm-table tbody tr .pm-op').first().click();   // 第一台：检测
      await page.waitForFunction(() => {
        const chip = document.querySelector('#pm-table tbody tr .pm-st');
        return chip && chip.textContent === '离线';
      }, null, { timeout: 5000 });
      assert(true, '探测失败后状态徽标变为离线');
      assert(await page.$eval('#toast', (el) => el.textContent.indexOf('连接异常') >= 0),
        '连接异常时 toast 明确提示');
      assert(await page.$eval('#pm-table tbody tr .pm-st', (el) => el.title.indexOf('连接被拒绝') >= 0),
        '离线徽标悬浮显示异常原因');

      /* ---------- 5. 检索筛选 ---------- */
      await page.fill('#pm-search', '不存在的关键词');
      assert(await page.$eval('#pm-nofilter', (el) => !el.hidden), '无匹配时显示筛选空态');
      assert(await rowCount() === 0, '关键词过滤生效');
      await page.fill('#pm-search', '');
      await page.selectOption('#pm-filter-status', 'offline');
      assert(await rowCount() === 1, '按状态筛选命中离线项');
      await page.selectOption('#pm-filter-status', 'online');
      assert(await rowCount() === 0, '在线筛选无命中（当前为离线）');
      await page.selectOption('#pm-filter-status', 'all');
      await page.selectOption('#pm-filter-type', 'network');
      assert(await rowCount() === 1, '按类型筛选命中网络类');
      await page.selectOption('#pm-filter-type', 'system');
      assert(await rowCount() === 0, '系统类筛选无命中');
      await page.selectOption('#pm-filter-type', 'all');

      /* ---------- 6. 系统导入（stub listPrinters） ---------- */
      await page.evaluate(() => {
        window.__stub.sysPrinters = [
          { name: 'Microsoft Print to PDF', displayName: 'Microsoft Print to PDF', isDefault: false },
          { name: 'EPSON_L4150', displayName: '爱普生 L4150 系列', isDefault: true }
        ];
      });
      await page.click('#pm-import');
      await page.waitForFunction(() => document.querySelectorAll('#pm-table tbody tr').length === 3,
        null, { timeout: 5000 });
      assert(true, '从系统导入 2 台后台账共 3 行');
      assert(await page.$eval('#pm-stats', (el) => el.textContent.indexOf('共 3 台') >= 0), '导入后统计更新');
      assert(await page.$eval('#pm-sys-hint', (el) => el.textContent.indexOf('系统检测到 2 台') >= 0),
        '系统检测数量提示');
      assert(await page.$eval('#pm-stats', (el) => el.textContent.indexOf('在线 2') >= 0),
        '导入的系统打印机比对列表后为在线');

      /* ---------- 7. 编辑 ---------- */
      await page.locator('#pm-table tbody tr .pm-op').first().click();   // 第一行：检测（保持在线）
      await page.locator('#pm-table tbody tr .pm-op').nth(1).click();    // 第一行：编辑
      assert(await page.$eval('#pm-dlg-title', (el) => el.textContent === '编辑打印机'), '编辑对话框标题');
      await page.fill('#pm-f-name', '前台网络打印机（改）');
      await page.click('#pm-dlg-save');
      assert((await firstRowText()).indexOf('前台网络打印机（改）') >= 0, '编辑后名称更新');

      /* ---------- 8. 删除（App.ui.confirm 模态 → 点击确定） ---------- */
      await page.locator('#pm-table tbody tr .pm-op').nth(2).click();    // 第一行：删除
      await page.click('#confirm-ok');
      await page.waitForFunction(() => document.querySelectorAll('#pm-table tbody tr').length === 2,
        null, { timeout: 5000 });
      assert(true, '删除后台账剩 2 行');
      assert(await page.$eval('#pm-table tbody tr .pm-star', (el) => !el.hidden),
        '删除默认打印机后自动提升新默认（星标仍在）');

      /* ---------- 9. 持久化与返回 ---------- */
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('zunhong-toolbox-printers') || '[]'));
      assert(Array.isArray(stored) && stored.length === 2, 'localStorage 持久化台账（2 条）');
      await page.click('#pm-back');
      assert(await page.$eval('#print-menu', (el) => !el.hidden), '返回后子功能菜单恢复');
      assert(await page.$eval('#print-manager', (el) => el.hidden), '管理面板收起');

      assert(errors.length === 0, '无未捕获脚本错误' + (errors.length ? '：' + errors[0] : ''));
    } finally {
      await browser.close();
    }
  });
  t.finish();
})().catch((e) => {
  console.log('  FAIL - 验证脚本异常：' + (e && e.stack || e));
  process.exit(1);
});
