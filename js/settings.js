/* ============================================================
 * settings.js — 用户设置持久化（localStorage）+ 版本化迁移
 * 记住上次使用的规格、底色、输出格式与 JPEG 质量；
 * 以及系统工具 → 设置 的偏好（主题 / 启动模块 / 上次模块）。
 *
 * 迁移框架（覆盖安装/版本更新的数据保留核心）：
 *  - 每份设置带结构版本号 v；SCHEMA_VERSION 升级时在 MIGRATIONS 补一步，
 *    逐级迁移（v1 → v2 → …），缺步骤时向前兼容兜底（load 按字段校验）；
 *  - 迁移前先把原始数据快照备份到 userData/backups（经 haoyueApp 桥，
 *    主进程原子写、保留最近 3 份），迁移失败回滚：原始 raw 原样保留、
 *    不写入任何新值，按默认值继续并上报诊断日志；
 *  - 比当前更新版本（v > SCHEMA_VERSION，降级安装场景）的数据原样保留，
 *    不向下迁移、不重写，避免高版本字段被截断丢失。
 * ============================================================ */
'use strict';

(function (App) {

  var $ = App.ui.$;
  var State = App.State;
  var SETTINGS_KEY = 'haoyue-idphoto-settings';
  /* 旧版「尊泓工具箱」的存储键：首次加载时读取并迁移，之后不再使用 */
  var SETTINGS_KEY_LEGACY = 'zunhong-toolbox-settings';
  /* 设置结构版本：v1 = 无版本标记的旧数据（含旧版存储键） */
  var SCHEMA_VERSION = 2;
  /* 持久化白名单：v2 起存储对象只含这些字段 + v（防止历史脏数据长期滞留） */
  var KNOWN_FIELDS = ['spec', 'bg', 'fmt', 'quality', 'whiten', 'theme', 'startMode', 'lastModule'];

  /* 迁移步骤表：key = 目标版本。每步接收旧对象、返回迁移后对象（须打 v 标）；
   * 步骤内抛错即中止迁移（load 捕获后回滚） */
  var MIGRATIONS = {
    /* v1 → v2：字段边界规范化——把非法值清出（load 本就按字段校验，
     * 这里在落盘前清掉，避免脏数据随版本化结构继续带下去） */
    2: function (s) {
      if (s.theme !== 'light' && s.theme !== 'dark') delete s.theme;
      if (s.startMode !== 'home' && s.startMode !== 'last') delete s.startMode;
      if (s.fmt !== 'png' && s.fmt !== 'jpeg') delete s.fmt;
      if (typeof s.quality !== 'number' || s.quality < 0.5 || s.quality > 1) delete s.quality;
      if (typeof s.whiten !== 'number' || s.whiten < 0 || s.whiten > 100) delete s.whiten;
      if (typeof s.lastModule !== 'string') delete s.lastModule;
      s.v = 2;
      return s;
    }
  };

  /* 结构版本号：无 v / 非法 v 视作 v1（旧数据与旧版存储键） */
  function versionOf(s) {
    return s && typeof s.v === 'number' && s.v >= 1 ? Math.floor(s.v) : 1;
  }

  /* 逐级迁移到 SCHEMA_VERSION。步骤数封顶防御：迁移表配置错误绝不死循环 */
  function migrate(s) {
    var v = versionOf(s);
    var steps = 0;
    while (v < SCHEMA_VERSION) {
      var step = MIGRATIONS[v + 1];
      if (!step) {
        /* 缺步骤表：向前兼容兜底——按当前结构直接打标
         * （applyFields 按字段校验，未知/非法值不会进入 State） */
        s.v = SCHEMA_VERSION;
        v = SCHEMA_VERSION;
        break;
      }
      s = step(s) || s;
      v = versionOf(s) > v ? versionOf(s) : v + 1;
      if (++steps > 32) break;
    }
    return s;
  }

  /* 上报诊断（桌面版落盘 userData/logs，浏览器版静默） */
  function reportDiag(kind, msg) {
    try {
      if (window.haoyueDiag && window.haoyueDiag.logError) {
        window.haoyueDiag.logError('[' + kind + '] ' + msg);
      }
    } catch (e) { /* 静默 */ }
  }

  /* 迁移前快照：原始数据原文交主进程备份落盘（异步，失败不影响启动）。
   * 浏览器版无桥接，静默跳过。 */
  function snapshotBackup(raw) {
    try {
      if (window.haoyueApp && window.haoyueApp.backupData) {
        window.haoyueApp.backupData(raw).catch(function () { /* 备份失败不阻断 */ });
      }
    } catch (e) { /* 静默 */ }
  }

  /* 白名单序列化落盘（迁移结果与常规保存共用同一出口，v 恒为当前版本） */
  function save0(obj) {
    var out = { v: SCHEMA_VERSION };
    for (var i = 0; i < KNOWN_FIELDS.length; i++) {
      var k = KNOWN_FIELDS[i];
      if (obj[k] !== undefined) out[k] = obj[k];
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(out));
  }

  function save() {
    try {
      save0({
        spec: State.spec.id, bg: State.bg, fmt: State.fmt, quality: State.quality,
        whiten: State.whiten,
        /* 系统工具 → 设置 的偏好 */
        theme: State.theme, startMode: State.startMode, lastModule: State.lastModule
      });
    } catch (e) { /* 存储不可用时静默忽略 */ }
  }

  /* 按字段校验写入 State：未知/非法字段一律忽略（迁移兜底与降级兼容的
   * 共同防线——存储里的多余字段永远不会污染运行时） */
  function applyFields(s) {
    if (s.spec) State.spec = window.SpecUtil.byId(s.spec);
    if (s.bg) State.bg = s.bg;
    if (s.fmt === 'png' || s.fmt === 'jpeg') State.fmt = s.fmt;
    if (typeof s.quality === 'number') State.quality = Math.min(1, Math.max(0.5, s.quality));
    if (typeof s.whiten === 'number') State.whiten = Math.min(100, Math.max(0, Math.round(s.whiten)));
    if (s.theme === 'light' || s.theme === 'dark') State.theme = s.theme;
    if (s.startMode === 'home' || s.startMode === 'last') State.startMode = s.startMode;
    if (typeof s.lastModule === 'string') State.lastModule = s.lastModule;
  }

  function load() {
    try {
      var fromLegacy = localStorage.getItem(SETTINGS_KEY) === null;
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (raw === null) raw = localStorage.getItem(SETTINGS_KEY_LEGACY);
      var s = JSON.parse(raw || 'null');
      if (s && typeof s === 'object') {
        if (versionOf(s) < SCHEMA_VERSION) {
          /* 旧版本数据：先快照备份原文，再逐级迁移落盘。
           * migrate 抛错 → catch 回滚：原始 raw 原样保留、不写任何新值 */
          snapshotBackup(raw);
          s = migrate(s);
          save0(s);
        } else if (fromLegacy) {
          save0(s); // 旧版存储键数据迁移到当前存储键
        }
        /* v > SCHEMA_VERSION（降级安装后的高版本数据）原样保留：
         * 不向下迁移、不重写，仅按字段校验取本版本认识的字段 */
        applyFields(s);
      }
    } catch (e) {
      /* 设置损坏或迁移失败：按默认值继续（回滚语义——存储原文未被改动） */
      reportDiag('settings-migrate-failed', (e && e.message) || String(e));
    }
    applyTheme();
  }

  /* 主题应用：浅色经 body[data-theme="light"] 覆盖颜色变量（见 style.css），深色即默认无属性 */
  function applyTheme() {
    if (State.theme === 'light') {
      document.body.dataset.theme = 'light';
    } else {
      delete document.body.dataset.theme;
    }
  }

  function applyToUI() {
    document.querySelectorAll('input[name="fmt"]').forEach(function (r) {
      r.checked = r.value === State.fmt;
    });
    $('quality-row').hidden = State.fmt !== 'jpeg';
    $('quality').value = Math.round(State.quality * 100);
    $('quality-val').textContent = Math.round(State.quality * 100) + '%';
    $('custom-bg').value = /^#[0-9a-fA-F]{6}$/.test(State.bg) ? State.bg : '#FFFFFF';
    App.photo.syncBgSwatches();
    $('set-theme').value = State.theme === 'light' ? 'light' : 'dark';
    $('set-start').value = State.startMode === 'last' ? 'last' : 'home';
  }

  App.settings = {
    save: save, load: load, applyToUI: applyToUI, applyTheme: applyTheme,
    KEY: SETTINGS_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    versionOf: versionOf,
    migrate: migrate
  };
})(window.App);
