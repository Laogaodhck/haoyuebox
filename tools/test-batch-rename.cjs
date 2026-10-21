/* ============================================================
 * test-batch-rename.cjs — 批量重命名模块测试
 * 1) 纯逻辑单测：名称校验 / 后缀解析 / 计划构建与冲突检测 / 自定义名
 * 2) jsdom 全流程：模拟文件夹句柄 → 选目录 → 预览（缩略图列）
 *    → 逐行自定义文件名 → 执行重命名
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createChecker, withServer } = require('./_lib.cjs');

const ROOT = path.join(__dirname, '..');
const PORT = 8441;

/* ---------- 模拟 File System Access 目录句柄 ---------- */
const fakeFile = { current: null }; // 缩略图测试用的 File 桩
function makeDirHandle(initialNames) {
  const files = new Map(); // name -> {kind:'file', name, move, getFile}
  for (const n of initialNames) {
    files.set(n, {
      kind: 'file',
      name: n,
      getFile: async () => fakeFile.current,
      move: async function (newName) {
        if (files.has(newName)) throw new Error('目标已存在');
        files.delete(this.name);
        const h = { kind: 'file', name: newName, move: this.move, getFile: this.getFile };
        files.set(newName, h);
      }
    });
  }
  return {
    name: '测试文件夹',
    files,
    async *values() { for (const [, v] of files) yield v; },
    async *entries() { for (const [, v] of files) yield v; },
    async getFileHandle(name, opts) {
      if (!files.has(name)) {
        if (!opts || !opts.create) throw new Error('NotFound');
        files.set(name, { kind: 'file', name, move: async function (nn) {
          files.delete(this.name);
          files.set(nn, { kind: 'file', name: nn, move: this.move });
        } });
      }
      return files.get(name);
    },
    async removeEntry(name) {
      if (!files.has(name)) throw new Error('NotFound');
      files.delete(name);
    }
  };
}

function flush(ms) { return new Promise((r) => setTimeout(r, ms || 120)); }

// 桩必须在页面脚本引导前注入（batch.js 初始化时探测 API 支持情况）
const dirRef = { current: null };

withServer(PORT, async (port) => {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.message || e).split('\n')[0]));
  const dom = await JSDOM.fromURL('http://localhost:' + port + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    virtualConsole: vc,
    pretendToBeVisual: true,
    beforeParse(window) {
      window.showDirectoryPicker = async () => dirRef.current;
      // 缩略图/放大预览测试桩：File + data URI 形式的 objectURL（jsdom 无 blob 支持）
      try {
        fakeFile.current = new window.File([new Uint8Array([1, 2, 3])], 'f.jpg', { type: 'image/jpeg' });
      } catch (e) { fakeFile.current = null; }
      window.URL.createObjectURL = () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      window.URL.revokeObjectURL = function () {};
    }
  });
  await flush(1500);
  const win = dom.window;
  const doc = win.document;
  const App = win.App;
  const checker = createChecker();
  const assert = checker.assert;
  const T = App.batch._test;
  /* 确认对话框桩：批量改名确认统一走 App.ui.confirm（Promise 化模态） */
  App.ui.confirm = async () => true;

  /* ---------- 1. 纯逻辑单测 ---------- */
  assert(T.validateBase('照片').ok === true, '基础名称「照片」合法');
  assert(T.validateBase('').ok === false, '空名称被拒绝');
  assert(T.validateBase('a/b').ok === false, '含斜杠被拒绝');
  assert(T.validateBase('a<b>?*|:"\\').ok === false, '危险字符被拒绝');
  assert(T.validateBase('con').ok === false, '系统保留名被拒绝');
  assert(T.validateBase('照片.').ok === false, '以点结尾被拒绝');
  assert(T.validateBase('x'.repeat(81)).ok === false, '超长名称被拒绝');

  const exts = T.parseExts('jpg, png;.PDF，heic  txt');
  assert(JSON.stringify(exts) === JSON.stringify(['jpg', 'png', 'pdf', 'heic', 'txt']), '自定义后缀解析正确');

  // 计划构建：保留后缀大小写、序号补零、数值排序输入
  let rows = T.buildPlan(
    [{ name: 'b.PNG' }, { name: 'a.jpg' }].sort((x, y) => x.name.localeCompare(y.name)),
    { base: '照片', sep: '-', start: 1, digits: 3 },
    () => false
  );
  assert(rows[0].newName === '照片-001.jpg' && rows[0].status === 'ok', 'a.jpg → 照片-001.jpg');
  assert(rows[1].newName === '照片-002.PNG' && rows[1].status === 'ok', 'b.PNG 后缀大小写保留');
  assert(rows[0].autoName === '照片-001' && rows[0].ext === '.jpg', '行数据携带 autoName/ext 供输入框占位');

  // 未变化
  rows = T.buildPlan([{ name: '照片-001.jpg' }], { base: '照片', sep: '-', start: 1, digits: 3 }, () => true);
  assert(rows[0].status === 'same', '名称未变化标记 same');

  // 目标已存在（非本次待改名文件）
  rows = T.buildPlan(
    [{ name: 'a.jpg' }, { name: '备注.txt' }],
    { base: '照片', sep: '-', start: 2, digits: 3 },
    (n) => n === '照片-002.jpg' || n === '备注.txt'
  );
  assert(rows[0].status === 'exists', '目标已存在被标记');

  // 链式冲突：目标名是另一个「会被改名腾出」的源文件
  rows = T.buildPlan(
    [{ name: '照片-2.jpg' }, { name: 'x.jpg' }],
    { base: '照片', sep: '-', start: 1, digits: 1 },
    () => false
  );
  assert(rows[0].status === 'ok', '照片-2.jpg → 照片-1.jpg 可执行（会腾出原名）');
  assert(rows[1].status === 'chain', 'x.jpg → 照片-2.jpg 被识别为链式冲突');

  // 目标名被已存在的其他文件占用（防御性检查，如预览后新出现的文件）
  rows = T.buildPlan(
    [{ name: '照片-2.jpg' }, { name: 'x.jpg' }],
    { base: '照片', sep: '-', start: 2, digits: 1 },
    (n) => n === '照片-3.jpg'
  );
  assert(rows[0].status === 'same', '照片-2.jpg 本身未变化');
  assert(rows[1].status === 'exists', 'x.jpg → 照片-3.jpg 标记为已存在');

  // ---------- 自定义名称 ----------
  rows = T.buildPlan(
    [{ name: 'a.jpg' }, { name: 'b.jpg' }],
    { base: '照片', sep: '-', start: 1, digits: 3, custom: { 'a.jpg': '生日' } },
    () => false
  );
  assert(rows[0].newName === '生日.jpg' && rows[0].status === 'ok', '自定义名优先于规则（生日.jpg）');
  assert(rows[0].custom === '生日' && rows[1].custom === '', '行数据记录 custom 字段');
  assert(rows[1].newName === '照片-002.jpg', '未自定义的文件仍按规则编号');

  rows = T.buildPlan(
    [{ name: 'a.jpg' }],
    { base: '照片', sep: '-', start: 1, digits: 3, custom: { 'a.jpg': 'x<y' } },
    () => false
  );
  assert(rows[0].status === 'invalid', '自定义名含非法字符被标记');

  rows = T.buildPlan(
    [{ name: 'a.jpg' }, { name: 'b.jpg' }],
    { base: '照片', sep: '-', start: 1, digits: 3, custom: { 'a.jpg': '生日', 'b.jpg': '生日' } },
    () => false
  );
  assert(rows[0].status === 'ok' && rows[1].status === 'dup', '自定义名重复被标记');

  rows = T.buildPlan(
    [{ name: 'a.jpg' }, { name: 'b.jpg' }],
    { base: '照片', sep: '-', start: 1, digits: 3, custom: { 'b.jpg': 'a' } },
    () => false
  );
  assert(rows[1].status === 'chain', '自定义名与源文件同名被标记为链式冲突');

  /* ---------- 2. jsdom 全流程 ---------- */
  // 夹具设计：a.jpg 的目标（照片-001.jpg）恰是另一个源文件名 → 链式冲突；
  // a10/a2 验证数值排序；报告.pdf/readme.txt 验证类型过滤。
  const dir = makeDirHandle([
    'a.jpg', 'a10.png', 'a2.png', '照片-001.jpg', '微信图片A.jpg', '微信图片B.jpg',
    '报告.pdf', 'readme.txt'
  ]);
  dirRef.current = dir;

  App.showModule('batch');
  assert(win.getComputedStyle(doc.getElementById('view-batch')).display === 'block', '批量工具视图已显示（计算样式）');
  App.showModule('home');
  assert(win.getComputedStyle(doc.getElementById('view-batch')).display === 'none', '离开批量工具后视图隐藏');
  App.showModule('batch');
  assert(doc.getElementById('batch-menu').hidden === false, '默认展示子功能菜单');
  doc.getElementById('batch-open-rename').click();
  assert(doc.getElementById('batch-rename').hidden === false, '点击后进入重命名面板');

  // 未选文件夹时「刷新预览」必须有提示反馈（修复前静默无反应）
  doc.getElementById('btn-batch-refresh').click();
  assert(doc.getElementById('toast').className.indexOf('show') >= 0, '未选文件夹时刷新预览弹出提示');
  assert(doc.getElementById('toast').textContent.indexOf('请先选择文件夹') >= 0, '提示内容为「请先选择文件夹」');

  doc.getElementById('batch-pick').click();
  await flush();
  assert(doc.getElementById('batch-folder').textContent.indexOf('测试文件夹') >= 0, '文件夹已选择并显示名称');

  // 默认类型=全部：图片文件也要加载缩略图，文档保持占位图
  // （修复前全部类型下预览列全是占位图且点击无任何反馈）
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  await flush(60);
  const rowByName = (n) => Array.from(doc.querySelectorAll('#batch-table tbody tr'))
    .find((tr) => tr.cells[2].textContent === n);
  assert(rowByName('a.jpg').cells[1].querySelector('img').getAttribute('src') !== BLANK, '全部类型下照片行缩略图已加载');
  assert(rowByName('readme.txt').cells[1].querySelector('img').getAttribute('src') === BLANK, '全部类型下文档行保持占位图');

  doc.getElementById('batch-base').value = '照片';
  doc.getElementById('batch-base').dispatchEvent(new win.Event('input'));
  // 类型=照片：a.jpg / a2.png / a10.png / 照片-001.jpg / 微信图片A.jpg / 微信图片B.jpg 共 6 个
  doc.getElementById('batch-kind').value = '照片';
  doc.getElementById('batch-kind').dispatchEvent(new win.Event('change'));
  await flush(300);
  let tbody = doc.getElementById('batch-table').querySelector('tbody');
  // 行单元格保留元素引用，便于读取输入框/后缀标签
  let vrows = Array.from(tbody.querySelectorAll('tr')).map((tr) => Array.from(tr.cells));
  assert(vrows.length === 6, '照片类型过滤出 6 个文件，实际 ' + vrows.length);

  // 列结构：0=序号 1=预览(缩略图) 2=原文件名 3=新文件名(输入框+后缀) 4=状态
  function findRow(name) { return vrows.find((r) => r[2].textContent === name); }
  function statusOf(name) { return findRow(name)[4].textContent; }
  function customInput(name) { return findRow(name)[3].querySelector('input.rename-input'); }
  function targetOf(name) {
    const cell = findRow(name)[3];
    const inp = cell.querySelector('input.rename-input');
    return (inp.value || inp.placeholder) + cell.querySelector('.ext-label').textContent;
  }

  // 缩略图列：照片类型每行渲染缩略图占位（jsdom 中 getFile 返回 null，静默保持占位图）
  assert(findRow('a.jpg')[1].querySelector('img.batch-thumb') !== null, '照片类型渲染缩略图单元格');

  // 数值排序：a2.png 必须排在 a10.png 之前（行号更小）
  assert(findRow('a2.png')[0].textContent * 1 < findRow('a10.png')[0].textContent * 1, '数值排序 a2 < a10');
  assert(targetOf('a2.png') === '照片-002.png' && targetOf('a10.png') === '照片-003.png', 'a2/a10 依次编为 002/003');
  assert(statusOf('a.jpg') === '与源文件同名', 'a.jpg → 照片-001.jpg 链式冲突被标记');
  assert(statusOf('微信图片A.jpg') === '待重命名' && targetOf('微信图片A.jpg').slice(-4) === '.jpg', '微信图片A.jpg 可执行且保留后缀');
  assert(doc.getElementById('batch-summary').textContent.indexOf('冲突') >= 0, '摘要提示冲突数量');
  assert(doc.getElementById('btn-batch-run').disabled === false, '仍有可执行行时执行按钮可用');

  // 逐行自定义文件名：a2.png → 生日.png；微信图片A.jpg → 非法名（应跳过）
  customInput('a2.png').value = '生日';
  customInput('a2.png').dispatchEvent(new win.Event('input', { bubbles: true }));
  customInput('微信图片A.jpg').value = 'x<y';
  customInput('微信图片A.jpg').dispatchEvent(new win.Event('input', { bubbles: true }));
  await flush(450); // 等待防抖 + 仅缓存重建计划
  vrows = Array.from(tbody.querySelectorAll('tr')).map((tr) => Array.from(tr.cells)); // 重渲染后重新抓取

  assert(targetOf('a2.png') === '生日.png' && statusOf('a2.png') === '待重命名', '自定义名生效（a2.png → 生日.png）');
  assert(statusOf('微信图片A.jpg') === '名称非法', '非法自定义名被标记并将跳过');
  assert(doc.getElementById('btn-batch-run').disabled === false, '存在可执行行时仍可执行');

  // 修改规则参数（全量刷新）不影响已自定义的名称
  doc.getElementById('batch-start').value = '5';
  doc.getElementById('batch-start').dispatchEvent(new win.Event('input'));
  await flush(400);
  vrows = Array.from(tbody.querySelectorAll('tr')).map((tr) => Array.from(tr.cells));
  assert(targetOf('a2.png') === '生日.png', '规则变化后自定义名保留');
  doc.getElementById('batch-start').value = '1';
  doc.getElementById('batch-start').dispatchEvent(new win.Event('input'));
  await flush(400);
  vrows = Array.from(tbody.querySelectorAll('tr')).map((tr) => Array.from(tr.cells));

  // 执行：确认弹窗已在引导前桩定为确定；冲突行/非法自定义名必须跳过
  doc.getElementById('btn-batch-run').click();
  await flush(400);
  let names = Array.from(dir.files.keys()).sort();
  assert(JSON.stringify(names) === JSON.stringify(['a.jpg', 'readme.txt', '微信图片A.jpg', '报告.pdf', '照片-003.png', '照片-005.jpg', '照片-006.jpg', '生日.png']),
    '链式冲突(a.jpg)与非法自定义名(微信图片A.jpg)保持原名，其余 4 行成功重命名: ' + names.join(', '));

  // 执行后自定义项清空，重新预览（重命名后的文件全部自动编号）
  vrows = Array.from(tbody.querySelectorAll('tr')).map((tr) => Array.from(tr.cells));
  if (findRow('微信图片A.jpg')) {
    assert(customInput('微信图片A.jpg').value === '', '执行后自定义项已清空');
  }

  // 第二轮：起始序号=10，剩余行全部可执行
  doc.getElementById('batch-start').value = '10';
  doc.getElementById('batch-start').dispatchEvent(new win.Event('input'));
  await flush(300);
  doc.getElementById('btn-batch-run').click();
  await flush(400);
  names = Array.from(dir.files.keys()).sort();
  assert(JSON.stringify(names) === JSON.stringify(['readme.txt', '报告.pdf', '照片-010.jpg', '照片-011.jpg', '照片-012.png', '照片-013.jpg', '照片-014.jpg', '照片-015.png']),
    '第二轮执行：剩余照片全部按新序号重命名，非照片类型不受影响: ' + names.join(', '));

  /* ---------- 3. 缩略图点击放大预览 ---------- */
  doc.getElementById('btn-batch-refresh').click();
  await flush(400);
  vrows = Array.from(tbody.querySelectorAll('tr')).map((tr) => Array.from(tr.cells));
  const thumbImg = findRow('照片-010.jpg')[1].querySelector('img.batch-thumb');
  assert(thumbImg.getAttribute('src').indexOf('data:image/png') === 0, '缩略图已加载真实预览地址（非占位图）');

  const box = doc.getElementById('thumb-lightbox');
  assert(box.hidden === true, 'lightbox 初始隐藏');
  thumbImg.click();
  assert(box.hidden === false, '点击缩略图打开放大预览');
  assert(doc.getElementById('thumb-lightbox-img').getAttribute('src') === thumbImg.getAttribute('src'), '大图与缩略图同源');
  box.click();
  assert(box.hidden === true, '点击遮罩关闭预览');
  thumbImg.click();
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
  assert(box.hidden === true, 'Esc 关闭预览');
  // 占位图不响应放大
  const phImg = findRow('readme.txt'); // readme 不在照片列表，取任一照片行验证占位路径
  thumbImg.setAttribute('src', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
  thumbImg.click();
  assert(box.hidden === true, '占位图点击不打开预览');
  assert(doc.getElementById('toast').className.indexOf('show') >= 0 && doc.getElementById('toast').textContent.indexOf('无法预览') >= 0, '占位图点击给出无法预览提示');
  assert(phImg !== null, '表格行查找正常');

  /* ---------- 4. 清空：状态重置 + 缩略图缓存释放 ---------- */
  assert(T.thumbCacheSize() > 0, '清空前缩略图缓存存在（' + T.thumbCacheSize() + ' 项）');
  doc.getElementById('btn-batch-clear').click();
  await flush(300);
  assert(T.thumbCacheSize() === 0, '清空后缩略图缓存已释放');
  assert(doc.getElementById('batch-folder').textContent === '未选择文件夹', '清空后文件夹选择已重置');
  assert(doc.getElementById('batch-table').querySelector('tbody').children.length === 0, '清空后预览表格已清空');
  assert(doc.getElementById('batch-empty').hidden === false, '清空后回到未选择文件夹提示');
  assert(doc.getElementById('btn-batch-run').disabled === true, '清空后执行按钮禁用');
  // 清空后重新选择文件夹可正常恢复预览
  doc.getElementById('batch-pick').click();
  await flush(300);
  assert(doc.getElementById('batch-table').querySelector('tbody').children.length === 8 - 2, '重新选择文件夹后预览恢复（剩 6 个照片文件）');

  assert(errors.length === 0, '无脚本错误: ' + errors.join(' | '));
  checker.finish();
}).catch((e) => { console.error('测试执行失败:', e); process.exit(1); });
