const { defineConfig } = require('vitest/config')
const path = require('path')

/**
 * 单元测试配置。
 *
 * 只测 `src/core` 与 `src/store`：这两层是"纯逻辑 + 状态"，可以在 Node 里跑；
 * 组件与 three.js 渲染依赖真实 WebGL，放在浏览器里手工验证更划算。
 *
 * 用 CommonJS 写法（而不是 ESM）：package.json 未声明 `"type": "module"`，
 * 而 Vitest 4 的配置加载器会警告"在按 CJS 加载的文件里使用 ESM 语法"。
 * 保持 CJS 可以彻底避开这个警告，也让配置在 Node 24 下行为最确定。
 */
module.exports = defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
    reporters: 'default'
  }
})
