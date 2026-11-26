/* ============================================================
 * check-refs.cjs — 校验 index.html 与分割器引用的本地资源真实存在
 * 纯前端无构建步骤，漏文件只会在运行时 404，这里提前拦住。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { ROOT, createChecker } = require('./_lib.cjs');

const checker = createChecker();
const assert = checker.assert;

/* 相对路径（非协议/锚点/内联数据）才需要落盘校验 */
function isLocal(ref) {
  return !/^([a-z]+:)?\/\//i.test(ref) && !/^(#|data:|mailto:|javascript:)/i.test(ref);
}

function refsFrom(file, pattern) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const out = [];
  let m;
  while ((m = pattern.exec(text)) !== null) out.push(m[1]);
  return out;
}

const html = refsFrom('index.html', /(?:src|href)="([^"]+)"/g).filter(isLocal);
assert(html.length >= 12, 'index.html 解析到 ' + html.length + ' 个本地引用');
for (const ref of new Set(html)) {
  assert(fs.existsSync(path.join(ROOT, ref.split('?')[0])), 'index.html 引用存在：' + ref);
}

/* 首页版本号必须与 package.json 一致（v1.1.0/v1.2.0 两次发版均漏改首页标签） */
const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const homeVer = /class="home-version">桌面离线版 v([^<]+)</.exec(
  fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
);
assert(homeVer, 'index.html 存在首页版本标签');
assert(homeVer && homeVer[1] === pkgVersion,
  '首页版本号（' + (homeVer ? homeVer[1] : '无') + '）与 package.json（' + pkgVersion + '）一致');

/* Win7 兼容包构建参数必须与主版本隔离：Electron 22 + 独立输出目录 + 独立更新通道，
 * 任一漏改都会让 Win7 包覆盖主版本产物或把 Win7 用户更新到无法启动的新内核 */
const win7Script = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['dist:win7'] || '';
assert(/electronVersion=22\./.test(win7Script), 'dist:win7 固定 Electron 22（最后一个支持 Win7 的版本）');
assert(/directories\.output=release-build-win7/.test(win7Script), 'dist:win7 输出到独立目录 release-build-win7');
assert(/publish\.channel=win7/.test(win7Script), 'dist:win7 使用独立更新通道 win7');
assert(/win7/i.test(win7Script), 'dist:win7 产物名带 win7 标识，避免与主版本同名');

/* 结业证预览底图（代码中按路径动态加载，静态扫描不到，单独校验存在与大小） */
['assets/cert/page-a.jpg', 'assets/cert/page-b.jpg'].forEach(function (rel) {
  var p = path.join(ROOT, rel);
  assert(fs.existsSync(p) && fs.statSync(p).size > 20 * 1024,
    '结业证预览底图存在且体积合理：' + rel);
});

const vendor = refsFrom('js/segmenter.js', /['"](vendor\/[^'"]+)['"]/g);
assert(vendor.length >= 3, '分割器解析到 ' + vendor.length + ' 个 vendor 路径');
for (const ref of new Set(vendor)) {
  assert(fs.existsSync(path.join(ROOT, ref)), '模型/运行时就位：' + ref);
}

checker.finish();
