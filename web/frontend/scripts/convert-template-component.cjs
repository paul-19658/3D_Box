/**
 * 一次性迁移脚本：把内联 `template` 字符串的 .js 组件转成 .vue 单文件组件。
 *
 * 背景：webpack 别名指向 runtime-only 版 Vue（vue.runtime.esm.js），
 * 它不支持 `template` 字符串选项，模板会被静默忽略、组件渲染为空。
 * 正确做法是交给 vue-loader 预编译，与其他组件保持一致。
 *
 * 用法：node scripts/convert-template-component.cjs src/components/SceneViewport.js
 */

const fs = require('fs')
const path = require('path')

const source = process.argv[2]
if (!source) {
  console.error('用法：node scripts/convert-template-component.cjs <file.js>')
  process.exit(1)
}

const absolute = path.resolve(process.cwd(), source)
const text = fs.readFileSync(absolute, 'utf8')

// 定位 `  template: ` ... `,` 这一段（模板字符串用反引号包裹）。
const startMarker = '  template: `'
const startIndex = text.indexOf(startMarker)
if (startIndex === -1) {
  console.error('未找到 template 字符串，脚本不适用')
  process.exit(1)
}

const contentStart = startIndex + startMarker.length
const endIndex = text.indexOf('`,', contentStart)
if (endIndex === -1) {
  console.error('未找到 template 字符串的结束标记')
  process.exit(1)
}

const templateBody = text.slice(contentStart, endIndex)
// 去掉模板字符串里为对齐而加的缩进（模板首行是换行 + 4 空格）。
const template = templateBody.replace(/\n {4}/g, '\n').replace(/^\n/, '').trimEnd()

// 移除 template 属性（连同其后的换行），其余内容原样保留。
const withoutTemplate = (text.slice(0, startIndex) + text.slice(endIndex + 3)).replace(
  /\n{3,}/,
  '\n\n'
)

const output = `<template>
${template}
</template>

<script>
${withoutTemplate.trimEnd()}
</script>
`

const target = absolute.replace(/\.js$/, '.vue')
fs.writeFileSync(target, output, 'utf8')
fs.unlinkSync(absolute)
console.log(`已生成 ${path.relative(process.cwd(), target)}（原 ${path.basename(source)} 已删除）`)
