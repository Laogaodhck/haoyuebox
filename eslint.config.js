/* ============================================================
 * eslint.config.js — ESLint 9 扁平配置
 * 范围：js/（浏览器 CommonJS 脚本）、electron/（主进程/preload，Node 环境）、
 * tools/（Node 工具与测试）。vendor/ 为第三方压缩产物，不检查。
 * 规则取向：捕获真实缺陷（未定义变量、未用变量、空 catch、误用），
 * 不强制风格（风格交给 Prettier，既有 var 风格保持不动）。
 * ============================================================ */
'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'vendor/**',
      'release/**',
      'release-build/**',
      'output/**',
      '.playwright-cli/**',
      '.ci-repro/**',
      'coverage/**'
    ]
  },
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.es2021, App: 'readonly', SPECS: 'readonly' }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-undef': 'error',
      'no-console': 'off',
      'no-var': 'off'
    }
  },
  {
    files: ['electron/**/*.js', 'tools/**/*.cjs', 'tools/**/*.js', '*.cjs', '*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.node, ...globals.es2021 }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-var': 'off'
    }
  },
  {
    /* 测试 / 验证 / 探针脚本：在 Node 里构造 jsdom 或经 page.evaluate 注入
       浏览器代码执行，页面全局（App/Brush/Composer/document 等）无法穷举，
       因此关闭 no-undef；脚本自身的真实缺陷由测试运行暴露。 */
    files: ['tools/**/*.cjs', 'tools/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.node, ...globals.browser, ...globals.es2021 }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-var': 'off'
    }
  }
];
