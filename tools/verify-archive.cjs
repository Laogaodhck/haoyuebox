/* ============================================================
 * verify-archive.cjs — 压缩工具真机验证（Playwright + Chromium）
 * 桥接层 stub（模拟 Electron preload 的 window.zunhongArchive），
 * 走真实渲染层交互链路：
 *   1. 首页入口 / 顶栏切换 / 面板显隐 / 返回菜单
 *   2. 压缩：选文件+选文件夹 → 拖拽文件+文件夹 → 去重 → 参数联动
 *      → 执行 payload 校验 → 进度回调 → 完成文案 → 清空
 *   3. 解压：非压缩包过滤 → 拖拽压缩包入列（非压缩包过滤）→ 解压到联动
 *      → 成功/失败结果渲染
 *   4. 浏览器环境（无桥接）：提示可见、按钮禁用
 * ============================================================ */
'use strict';
const { createChecker, sleep, launchBrowser, withServer } = require('./_lib.cjs');

const PORT = 8437;
const checker = createChecker();
const assert = checker.assert;

withServer(PORT, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));

    // stub：模拟 preload 桥接（压缩/解压在主进程执行，这里返回固定结果）
    await page.addInitScript(() => {
      const bridge = {
        isDesktop: true,
        calls: [],
        _archivePick: 0,
        pickPaths: async (kind) => {
          if (kind === 'file') return [
            { path: 'C:\\f\\照片1.jpg', name: '照片1.jpg', isDir: false, size: 1024 },
            { path: 'C:\\f\\照片2.png', name: '照片2.png', isDir: false, size: 2048 }
          ];
          if (kind === 'dir') return [{ path: 'C:\\f\\旅行', name: '旅行', isDir: true, size: 0 }];
          if (kind === 'archive') {
            bridge._archivePick++;
            return bridge._archivePick === 1
              ? [{ path: 'C:\\f\\a.zip', name: 'a.zip', isDir: false, size: 512 },
                 { path: 'C:\\f\\坏.exe', name: '坏.exe', isDir: false, size: 10 }]
              : [{ path: 'C:\\f\\b.7z', name: 'b.7z', isDir: false, size: 4096 }];
          }
          return [];
        },
        saveDialog: async (def) => {
          bridge.calls.push(['saveDialog', def]);
          return 'C:\\f\\' + def;
        },
        compress: async (p) => {
          bridge.calls.push(['compress', p]);
          if (bridge._cb) bridge._cb({ task: 'compress', pct: 42 });
          return { ok: true, outPath: p.outPath, size: 12345 };
        },
        extract: async (p) => {
          bridge.calls.push(['extract', p]);
          return {
            ok: true,
            okCount: p.items.filter(n => !/b\.7z$/.test(n)).length,
            failCount: p.items.filter(n => /b\.7z$/.test(n)).length,
            results: p.items.map(n => ({
              path: n,
              name: n.split('\\').pop(),
              outDir: n.replace(/\.[^.]+$/, ''),
              ok: !/b\.7z$/.test(n),
              error: /b\.7z$/.test(n) ? '密码错误' : ''
            }))
          };
        },
        check7z: async () => ({ ok: true, version: '7-Zip 26.03 (x64)', path: 'C:\\fake\\7z.exe' }),
        onProgress: (cb) => { bridge._cb = cb; },
        /* 拖拽支持 stub：File.name → 本机路径；statPaths 按名称给元数据（无扩展名视为文件夹） */
        pathForFile: (f) => 'C:\\drop\\' + ((f && f.name) || ''),
        statPaths: async (paths) => (paths || []).map((p) => {
          const name = p.split('\\').pop();
          const isDir = !/\.[^.]+$/.test(name);
          return { path: p, name, isDir, size: isDir ? 0 : 777 };
        })
      };
      Object.defineProperty(window, 'zunhongArchive', { value: bridge });
    });

    await page.goto('http://localhost:' + PORT + '/');
    await sleep(400);

    // ---------- 首页入口与模块切换 ----------
    const cardOrder = await page.$eval('#home-archive', el => el.previousElementSibling && el.previousElementSibling.id);
    assert(cardOrder === 'home-print', '首页卡片位于「打印工具」之下');
    await page.click('#home-archive');
    assert(await page.$eval('#view-archive', el => el.style.display === 'block'), '压缩工具模块视图已显示');
    assert(await page.$eval('.module-tab[data-module="archive"]', el => el.classList.contains('active')),
      '顶栏「压缩工具」标签激活');
    assert(await page.$eval('body', el => document.body.dataset.module === 'archive'), 'body data-module=archive');
    assert(await page.$eval('#steps-nav', el => getComputedStyle(el).display === 'none'),
      '照片步骤导航在压缩模块下隐藏');
    assert(await page.$eval('#archive-menu', el => !el.hidden
      && document.getElementById('archive-compress').hidden
      && document.getElementById('archive-extract').hidden), '进入时显示子功能菜单、两面板收纳');

    // ---------- 压缩面板：选择与去重 ----------
    await page.click('#archive-open-compress');
    assert(await page.$eval('#archive-compress', el => !el.hidden && document.getElementById('archive-menu').hidden),
      '进入压缩面板、菜单隐藏');
    assert(await page.$eval('#ac-unsupported', el => el.hidden), '桌面桥接下不显示不支持提示');
    const note = await page.$eval('#ac-note', el => el.textContent);
    assert(/7z 引擎已就绪/.test(note), '7z 引擎检查通过提示');
    assert(await page.$eval('#ac-run', el => el.disabled), '未选择内容时执行按钮禁用');

    await page.click('#ac-pick-files');
    await page.waitForFunction(() => document.querySelectorAll('#ac-table tbody tr').length === 2);
    assert(await page.$eval('#ac-count', el => /已勾选 2 项/.test(el.textContent) && /3 KB/.test(el.textContent)),
      '选 2 个文件计数与体积正确');
    assert(await page.$eval('#ac-run', el => !el.disabled), '选择后执行按钮可用');
    assert(await page.$eval('#ac-check-all', el => el.checked && !el.indeterminate), '默认全部勾选、全选框选中');

    await page.click('#ac-pick-dir');
    await page.waitForFunction(() => document.querySelectorAll('#ac-table tbody tr').length === 3);
    const row3 = await page.$eval('#ac-table tbody tr:last-child', tr => tr.textContent);
    assert(/旅行/.test(row3) && /文件夹/.test(row3) && /—/.test(row3), '文件夹行显示类型与占位大小');
    assert(await page.$eval('#ac-count', el => /已勾选 3 项/.test(el.textContent)), '文件夹计入选择数');
    assert(await page.$$eval('#ac-table input[type="checkbox"]', boxes => boxes.length) === 4,
      '每行带勾选框（3 行 + 表头全选）');

    await page.click('#ac-pick-files');
    await sleep(150);
    assert(await page.$$eval('#ac-table tbody tr', trs => trs.length) === 3, '重复选择按路径去重');

    // ---------- 勾选交互 ----------
    await page.click('#ac-table tbody tr:first-child .col-check input'); // 取消勾选第 1 项
    assert(await page.$eval('#ac-count', el => /已勾选 2 项/.test(el.textContent)), '取消勾选后计数联动');
    assert(await page.$eval('#ac-check-all', el => el.indeterminate && !el.checked), '部分勾选时全选框半选');
    assert(await page.$eval('#ac-table tbody tr:first-child', tr => tr.classList.contains('row-unchecked')),
      '未勾选行变暗');

    await page.click('#ac-table tbody tr:nth-child(2) .col-check input');
    await page.click('#ac-table tbody tr:nth-child(3) .col-check input');
    assert(await page.$eval('#ac-run', el => el.disabled), '全部取消勾选后执行禁用');
    assert(await page.$eval('#ac-count', el => /未勾选/.test(el.textContent)), '全部取消后提示未勾选');

    await page.click('#ac-check-all'); // 全选恢复
    assert(await page.$eval('#ac-count', el => /已勾选 3 项/.test(el.textContent))
      && await page.$eval('#ac-run', el => !el.disabled), '表头全选框一键恢复勾选');

    // 仅保留 2、3 两项勾选后执行，payload 应只含勾选项
    await page.click('#ac-table tbody tr:first-child .col-check input');
    assert(await page.$eval('#ac-check-all', el => el.indeterminate), '再次部分勾选、全选框半选');
    await page.click('#ac-run');

    // ---------- 参数联动与执行 payload ----------
    await page.selectOption('#ac-fmt', 'zip');
    assert(await page.$eval('#ac-encnames-row', el => el.hidden), 'ZIP 下隐藏「加密文件名」');
    await page.selectOption('#ac-fmt', '7z');
    assert(await page.$eval('#ac-encnames-row', el => !el.hidden), '7z 下显示「加密文件名」');
    await page.check('#ac-encnames');

    await page.click('#ac-run');
    await page.waitForFunction(() => /压缩完成/.test(document.getElementById('ac-progress').textContent));
    const payload = await page.evaluate(() => {
      const c = window.zunhongArchive.calls.filter(c => c[0] === 'compress');
      return c.length ? c[c.length - 1][1] : null;
    });
    assert(!!payload, '压缩 payload 已上报');
    assert(payload.items.length === 2
      && payload.items[0] === 'C:\\f\\照片2.png'
      && payload.items[1] === 'C:\\f\\旅行', 'payload 只含勾选的 2 项（未勾选的照片1 被排除）');
    assert(payload.fmt === '7z' && payload.level === 'normal', 'payload 格式 7z / 等级标准');
    assert(payload.encNames === true, 'payload 勾选了加密文件名');
    assert(payload.outPath === 'C:\\f\\压缩包.7z', '多项时默认压缩包名为「压缩包.7z」');
    const dlgCalls = await page.evaluate(() =>
      window.zunhongArchive.calls.filter(c => c[0] === 'saveDialog').length);
    assert(dlgCalls === 2, '弹窗模式每次执行都调用另存为（此前共执行 2 次）');

    // ---------- 「压缩到」= 所选内容所在目录（免弹窗自动命名） ----------
    await page.selectOption('#ac-out', 'same');
    await page.click('#ac-check-all'); // 半选状态点击 → 全选
    assert(await page.$eval('#ac-count', el => /已勾选 3 项/.test(el.textContent)), '压缩到模式前恢复全选');
    await page.click('#ac-run');
    // v1.3.0 起：同目录自动命名输出已存在时先弹覆盖确认（stub 的 statPaths 视一切路径存在 → 必弹）
    await page.waitForFunction(() => !document.getElementById('confirm-dlg').hidden);
    assert(/覆盖它吗/.test(await page.$eval('#confirm-msg', el => el.textContent)),
      '同目录输出已存在时弹出覆盖确认');
    await page.click('#confirm-ok');
    await page.waitForFunction(() => {
      const c = window.zunhongArchive.calls.filter(c => c[0] === 'compress');
      return c.length >= 3;   // 此前已有 2 次（弹窗模式两轮），须等到第 3 次真实到达
    });
    const payload2 = await page.evaluate(() => {
      const c = window.zunhongArchive.calls.filter(c => c[0] === 'compress');
      return c[c.length - 1][1];
    });
    assert(payload2.outPath === 'C:\\f\\压缩包.7z', '压缩到「所在目录」自动拼输出路径');
    assert(payload2.items.length === 3, '压缩到模式包含全部勾选项');
    const dlgCalls2 = await page.evaluate(() =>
      window.zunhongArchive.calls.filter(c => c[0] === 'saveDialog').length);
    assert(dlgCalls2 === 2, '压缩到「所在目录」不再弹另存为');
    await page.selectOption('#ac-out', 'dialog');
    const pct = await page.$eval('#ac-progress', el => el.textContent);
    assert(/42%|压缩完成/.test(pct), '进度经 onProgress 回传渲染');
    await page.evaluate(() => window.zunhongArchive._cb({ task: 'compress', pct: 77 }));
    assert(await page.$eval('#ac-progress', el => el.textContent === '压缩中… 77%'), '进度文案实时更新');

    // ---------- 清空 ----------
    await page.click('#ac-clear');
    assert(await page.$$eval('#ac-table tbody tr', trs => trs.length) === 0
      && await page.$eval('#ac-run', el => el.disabled), '清空后表格清空、执行禁用');
    assert(await page.$eval('#ac-empty', el => !el.hidden), '清空后显示空态提示');

    // ---------- 拖拽选择（压缩面板）：文件 + 文件夹混合拖入 ----------
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['a'], '拖拽文档.txt'));
      dt.items.add(new File(['b'], '拖拽目录'));
      document.getElementById('ac-drop')
        .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await page.waitForFunction(() => document.querySelectorAll('#ac-table tbody tr').length === 2);
    const dropRow = await page.$eval('#ac-table tbody tr:last-child', tr => tr.textContent);
    assert(/拖拽目录/.test(dropRow) && /文件夹/.test(dropRow) && /—/.test(dropRow),
      '拖拽文件夹入列并标类型');
    assert(await page.$eval('#ac-count', el => /已勾选 2 项/.test(el.textContent)),
      '拖拽文件+文件夹后计数与勾选正确');
    assert(await page.$eval('#ac-run', el => !el.disabled), '拖拽后执行按钮可用');

    // ---------- 解压面板 ----------
    await page.click('#ac-back');
    assert(await page.$eval('#archive-menu', el => !el.hidden), '返回按钮回到菜单');
    await page.click('#archive-open-extract');
    assert(await page.$eval('#archive-extract', el => !el.hidden), '进入解压面板');

    await page.click('#ax-pick');
    await page.waitForFunction(() => document.querySelectorAll('#ax-table tbody tr').length === 1);
    assert(await page.$eval('#ax-count', el => /已勾选 1 项/.test(el.textContent)), '非压缩包（exe）被过滤');
    assert(await page.$eval('#ax-table tbody tr td:nth-child(4)', td => td.textContent === 'a/'),
      '解压到列显示同名子文件夹');
    await page.selectOption('#ax-out', 'same');
    assert(await page.$eval('#ax-table tbody tr td:nth-child(4)', td => td.textContent === '压缩包所在目录'),
      '切换「解压到」后表格联动');

    await page.click('#ax-run');
    await page.waitForFunction(() => /解压完成/.test(document.getElementById('ax-result').textContent));
    const extPayload = await page.evaluate(() => {
      const c = window.zunhongArchive.calls.filter(c => c[0] === 'extract');
      return c.length ? c[c.length - 1][1] : null;
    });
    assert(extPayload.destMode === 'same' && extPayload.items[0] === 'C:\\f\\a.zip', '解压 payload 正确');
    assert(await page.$eval('#ax-table tbody tr td:nth-child(4)',
      td => td.querySelector('svg.icon') !== null && td.textContent.indexOf('\u2713') < 0),
      '成功行带 SVG 成功标记（对勾图标，非字符拼接）');
    assert(await page.$eval('#ax-progress', el => el.hidden),
      '解压完成后进度行收纳（不留「解压中 — N%」残留）');

    // 第二次选择：b.7z（stub 第二次返回）→ 模拟失败
    await page.click('#ax-pick');
    await page.waitForFunction(() => /b\.7z/.test(document.getElementById('ax-table').textContent));
    await page.selectOption('#ax-out', 'sub');
    await page.click('#ax-run');
    await page.waitForFunction(() => /失败 1 个/.test(document.getElementById('ax-result').textContent));
    const badRow = await page.$eval('#ax-table tbody tr:last-child', tr => tr.textContent);
    assert(/失败：密码错误/.test(badRow), '失败行展示错误原因');
    assert(await page.$eval('#ax-table tbody tr:last-child', tr => tr.classList.contains('st-bad')),
      '失败行标红（st-bad）');

    // ---------- 拖拽选择（解压面板）：压缩包入列、非压缩包过滤 ----------
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['c'], '拖拽包.rar'));
      dt.items.add(new File(['d'], '图片.jpg'));
      document.getElementById('ax-drop')
        .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await page.waitForFunction(() => /拖拽包\.rar/.test(document.getElementById('ax-table').textContent));
    assert(await page.$$eval('#ax-table tbody tr', trs => trs.length) === 3,
      '拖拽压缩包入列，同拖的非压缩包被过滤');

    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['e'], '纯图片.png'));
      document.getElementById('ax-drop')
        .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await sleep(200);
    assert(await page.$$eval('#ax-table tbody tr', trs => trs.length) === 3,
      '仅拖入非压缩包时不入列');
    await page.evaluate(() => window.zunhongArchive._cb({ task: 'extract', index: 0, total: 1, name: 'b.7z', pct: 66 }));
    assert(await page.$eval('#ax-progress', el => el.textContent === '解压中（1/1）：b.7z — 66%'),
      '解压进度文案带序号与文件名');

    // ---------- 模块切换回归 ----------
    await page.click('#ax-back');
    await page.click('.module-tab[data-module="batch"]');
    await page.click('.module-tab[data-module="archive"]');
    assert(await page.$eval('#archive-menu', el => !el.hidden
      && document.getElementById('archive-compress').hidden
      && document.getElementById('archive-extract').hidden), '切走再切回时重置到子功能菜单');

    assert(pageErrors.length === 0, '无页面脚本错误' + (pageErrors.length ? '：' + pageErrors.join(' | ') : ''));

    // ---------- 浏览器环境（无桥接）降级 ----------
    const page2 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page2.on('pageerror', e => pageErrors.push(e.message));
    await page2.goto('http://localhost:' + PORT + '/');
    await sleep(400);
    await page2.click('#home-archive');
    await page2.click('#archive-open-compress');
    assert(await page2.$eval('#ac-unsupported', el => !el.hidden), '浏览器环境显示不支持提示');
    assert(await page2.$eval('#ac-run', el => el.disabled), '浏览器环境压缩执行禁用');
    await page2.click('#ac-back');
    await page2.click('#archive-open-extract');
    assert(await page2.$eval('#ax-unsupported', el => !el.hidden)
      && await page2.$eval('#ax-run', el => el.disabled), '浏览器环境解压提示与禁用');
    await page2.click('#ax-back');
    assert(await page2.$eval('#archive-menu', el => !el.hidden), '浏览器环境仍可返回菜单浏览');
    await page2.close();

    await browser.close();
  } finally {
    await browser.close().catch(() => {});
  }
  checker.finish();
}).catch(e => { console.error('脚本异常:', e && e.message || e); process.exit(2); });
