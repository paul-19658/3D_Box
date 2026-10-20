/**
 * 对象分色：为每个物体生成稳定的辨识色。
 *
 * 用途：导出"物体分色图"，供 AI 区分不同物体做局部重绘。
 * 用字符串哈希而不是随机色，保证同一物体每次导出颜色一致。
 */

function hashIdentifier(identifier) {
  let hash = 2166136261
  for (let index = 0; index < identifier.length; index += 1) {
    hash ^= identifier.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const PALETTE = [
  '#e6194b',
  '#3cb44b',
  '#ffe119',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#42d4f4',
  '#f032e6',
  '#bfef45',
  '#fabed4',
  '#469990',
  '#dcbeff',
  '#9a6324',
  '#fffac8',
  '#800000',
  '#aaffc3',
  '#808000',
  '#ffd8b1',
  '#000075',
  '#a9a9a9'
]

export function objectIdColor(identifier) {
  return PALETTE[hashIdentifier(identifier) % PALETTE.length]
}
