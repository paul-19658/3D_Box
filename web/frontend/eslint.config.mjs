import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'

/**
 * ESLint 扁平配置（ESLint 9）。
 *
 * 取舍说明：
 * - 关闭 `vue/multi-word-component-names`：项目里 `App.vue`、`Editor.vue` 这类名字
 *   是约定俗成的，强行加前缀反而降低可读性；
 * - 允许 `console.warn/error`，禁止裸 `console.log`：调试残留容易混进提交；
 * - 不使用分号、单引号、无尾随逗号，与 Prettier 配置保持一致，避免两边互相打架。
 */
export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**']
  },
  js.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.{js,vue}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        FileReader: 'readonly',
        Response: 'readonly',
        crypto: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        unescape: 'readonly',
        encodeURIComponent: 'readonly',
        globalThis: 'readonly',
        console: 'readonly'
      }
    },
    rules: {
      'vue/multi-word-component-names': 'off',
      // 本项目锁定 Vue 2.6，beforeDestroy / destroyed 是正确写法而非遗留问题。
      'vue/no-deprecated-destroyed-lifecycle': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error'
    }
  },
  {
    /*
     * 浏览器媒体 API 只在 `src/media/` 里用。
     *
     * 单独开一个 files 作用域而不是加到全局：VideoEncoder / VideoFrame
     * 属于 WebCodecs，Node 里根本不存在。把它们设成全局可读，
     * 就等于允许 `core/` 或组件里随手引用——而 `core/` 的硬约定是
     * "不许依赖浏览器 API"（否则 Vitest 在 Node 里直接炸）。
     * 限定目录才能让 lint 守住这条边界。
     */
    files: ['src/media/**/*.js'],
    languageOptions: {
      globals: {
        VideoEncoder: 'readonly',
        VideoFrame: 'readonly',
        VideoDecoder: 'readonly',
        EncodedVideoChunk: 'readonly',
        OffscreenCanvas: 'readonly',
        ImageBitmap: 'readonly',
        createImageBitmap: 'readonly'
      }
    }
  },
  {
    // 测试文件里允许自由命名与断言库全局。
    files: ['**/*.test.js'],
    rules: {
      'no-unused-expressions': 'off'
    }
  }
]
