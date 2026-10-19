/* ============================================================
 * test-ipc-contract.cjs — IPC 通道契约静态测试（QA-A6）
 * preload.js 经 contextBridge 暴露的每个 ipcRenderer.invoke/send 通道，
 * 必须在主进程侧有对应的 ipcMain.handle/on 注册。
 * 防「桥接名与注册名拼写不一致 / 注册漏挂」类运行时 TypeError——
 * 此类错误此前无任何覆盖（verify-packaged 只冒烟 7z 一条链路）。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}

/* 主进程源文件：electron/ 下全部 .js——新增注册模块自动纳入契约检查，
 * 不再维护硬编码名单（硬编码曾让漏检风险随新模块静默增长） */
const MAIN_FILES = fs.readdirSync(path.join(ROOT, 'electron'))
  .filter((f) => /\.js$/.test(f) && fs.statSync(path.join(ROOT, 'electron', f)).isFile())
  .map((f) => path.join(ROOT, 'electron', f));

const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
const mainSrc = MAIN_FILES.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

/* 渲染侧通道：ipcRenderer.invoke('x') / ipcRenderer.send('x') */
const used = new Set();
let m;
const reUse = /ipcRenderer\.(?:invoke|send)\(\s*'([^']+)'/g;
while ((m = reUse.exec(preloadSrc)) !== null) used.add(m[1]);

/* 主进程侧注册：ipcMain.handle('x') / ipcMain.on('x') */
const registered = new Set();
const reReg = /ipcMain\.(?:handle|on)\(\s*'([^']+)'/g;
while ((m = reReg.exec(mainSrc)) !== null) registered.add(m[1]);

assert(used.size >= 15, 'preload 解析到桥接通道 ' + used.size + ' 个（预期 ≥15：五组桥接）');
assert(registered.size >= used.size, '主进程解析到注册 ' + registered.size + ' 个');

const missing = [...used].filter((c) => !registered.has(c));
assert(missing.length === 0,
  '所有桥接通道均有主进程注册' + (missing.length ? '，缺失: ' + missing.join(', ') : ''));

/* 反向备查（不阻断）：仅主进程注册、桥接未暴露的通道（内部用途允许存在） */
const internal = [...registered].filter((c) => !used.has(c));
console.log('  备查 - 仅主进程注册、桥接未暴露的通道: '
  + (internal.length ? internal.join(', ') : '（无）'));

console.log(fail ? `\n结果: ${pass} 通过, ${fail} 失败` : `\n结果: ${pass} 通过, 0 失败`);
process.exit(fail ? 1 : 0);
