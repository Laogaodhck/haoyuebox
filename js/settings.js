/* ============================================================
 * settings.js — 用户设置持久化（localStorage）
 * 记住上次使用的规格、底色、输出格式与 JPEG 质量。
 * ============================================================ */
'use strict';

(function (App) {

  var $ = App.ui.$;
  var State = App.State;
  var SETTINGS_KEY = 'zunhong-toolbox-settings';
  /* 旧版「浩玥工具箱」的存储键：首次加载时读取并迁移，之后不再使用 */
  var SETTINGS_KEY_LEGACY = 'haoyue-idphoto-settings';

  function save() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        spec: State.spec.id, bg: State.bg, fmt: State.fmt, quality: State.quality
      }));
    } catch (e) { /* 存储不可用时静默忽略 */ }
  }

  function load() {
    try {
      var fromLegacy = localStorage.getItem(SETTINGS_KEY) === null;
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (raw === null) raw = localStorage.getItem(SETTINGS_KEY_LEGACY);
      var s = JSON.parse(raw || 'null');
      if (!s) return;
      if (s.spec) State.spec = window.SpecUtil.byId(s.spec);
      if (s.bg) State.bg = s.bg;
      if (s.fmt === 'png' || s.fmt === 'jpeg') State.fmt = s.fmt;
      if (typeof s.quality === 'number') State.quality = Math.min(1, Math.max(0.5, s.quality));
      if (fromLegacy) save(); // 旧品牌设置迁移到新存储键
    } catch (e) { }
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
  }

  App.settings = { save: save, load: load, applyToUI: applyToUI };
})(window.App);
