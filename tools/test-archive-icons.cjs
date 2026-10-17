/* ============================================================
 * test-archive-icons.cjs — 压缩包图标关联单测（纯逻辑部分）
 * electron/archive-icons.js 中不依赖 reg.exe 的决策 / 编解码 /
 * 值构建逻辑；注册表读写链路属系统集成，由桌面端手工验证。
 * ============================================================ */
'use strict';
const path = require('path');
const { createChecker } = require('./_lib.cjs');

const t = createChecker();
const mod = require(path.join(__dirname, '..', 'electron', 'archive-icons.js'));

console.log('\n[archive-icons] 纯逻辑');

/* 索引表与官方 7-Zip 安装器一致（.7z → 7z.dll,0；.zip → 7z.dll,1） */
t.assert(mod.ICON_INDEX['7z'] === 0 && mod.ICON_INDEX.zip === 1,
  'ICON_INDEX：7z=0、zip=1（对齐 7-Zip 官方 DefaultIcon 注册值）');
t.assert(/7z 压缩包/.test(mod.FRIENDLY_NAME['7z']) && /ZIP/.test(mod.FRIENDLY_NAME.zip),
  'FRIENDLY_NAME 含格式名与工具箱标识');

/* reg query 默认值解析 */
t.assert(mod.parseRegDefault('    (默认值)    REG_SZ    WinRAR') === 'WinRAR',
  'parseRegDefault 提取 REG_SZ 之后的值');
t.assert(mod.parseRegDefault('    (默认值)    REG_SZ    ') === '',
  'parseRegDefault 空值返回空串');
t.assert(mod.parseRegDefault('错误: 系统找不到指定的注册表项') === '',
  'parseRegDefault 无 REG_SZ 行返回空串');
t.assert(mod.parseRegDefault('HKEY_CLASSES_ROOT\\.7z\r\n    (默认值)    REG_SZ    7-Zip.7z\r\n') === '7-Zip.7z',
  'parseRegDefault 多行时取最后一个 REG_SZ 值');

/* 关联决策：ours 优先，其次 userchoice / associated，最后 available */
t.assert(mod.decideExt(true, '', false) === 'ours', 'decideExt：已注册本程序 → ours');
t.assert(mod.decideExt(false, '', true) === 'userchoice', 'decideExt：用户指定关联 → userchoice');
t.assert(mod.decideExt(false, 'WinRAR', false) === 'associated', 'decideExt：系统已有关联 → associated');
t.assert(mod.decideExt(false, '', false) === 'available', 'decideExt：完全无关联 → available');
t.assert(mod.decideExt(true, 'WinRAR', true) === 'ours', 'decideExt：本程序注册优先级最高');
t.assert(mod.decideExt(false, 'WinRAR', true) === 'userchoice', 'decideExt：UserChoice 优先于 HKCR 默认值');

/* 备份标记编解码（原值原样还原 / 空值区分） */
t.assert(mod.decodeBackup(mod.encodeBackup('WinRAR')) === 'WinRAR', 'encodeBackup/decodeBackup 原值往返');
t.assert(mod.decodeBackup(mod.encodeBackup('')) === '', 'encodeBackup 空值 → EMPTY → 还原空串');
t.assert(mod.encodeBackup('').startsWith('EMPTY'), 'encodeBackup 空值标记');
t.assert(mod.encodeBackup('7-Zip.7z').startsWith('b64:'), 'encodeBackup 非空值 base64 前缀');
t.assert(mod.decodeBackup('乱输入') === '' && mod.decodeBackup('b64:!!!非法!!!') === '',
  'decodeBackup 非法标记兜底空串');

/* DefaultIcon 值构建：路径含空格加引号，索引在引号外 */
t.assert(mod.buildIconValue('C:\\bin\\7z.dll', 0) === '"C:\\bin\\7z.dll",0',
  'buildIconValue 常规路径');
t.assert(mod.buildIconValue('C:\\Program Files\\7-Zip\\7z.dll', 1) === '"C:\\Program Files\\7-Zip\\7z.dll",1',
  'buildIconValue 含空格路径引号包裹，索引在引号外');

/* 图标资源定位：开发环境 electron/bin/7z.dll 必然存在 */
t.assert(mod.resolveIconDll() !== '', 'resolveIconDll 开发环境能找到 7z.dll');

/* IPC 入口白名单：渲染层传入 exts 必须经 sanitizeExts 过滤 */
t.assert(JSON.stringify(mod.sanitizeExts(['7z', 'zip'])) === '["7z","zip"]', 'sanitizeExts 合法输入原样保留');
t.assert(JSON.stringify(mod.sanitizeExts(['.7z', '.ZIP'])) === '["7z","zip"]', 'sanitizeExts 去点+小写归一');
t.assert(JSON.stringify(mod.sanitizeExts(['exe', '..', 'HKCU\\x', '', null, 42])) === '[]', 'sanitizeExts 非法值全部剔除');
t.assert(JSON.stringify(mod.sanitizeExts('7z')) === '[]', 'sanitizeExts 非数组拒绝');
t.assert(JSON.stringify(mod.sanitizeExts(undefined)) === '[]', 'sanitizeExts 未传拒绝');

t.finish();
