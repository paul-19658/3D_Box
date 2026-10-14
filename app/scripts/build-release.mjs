import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'))
const target = process.argv[2]
if (target !== '--dir' && target !== '--win') {
  throw new Error('用法：node scripts/build-release.mjs --dir|--win')
}

async function resolveOutputDirectory(baseDirectory) {
  const unpackedDir = join(appRoot, baseDirectory, 'win-unpacked')
  try {
    await rm(unpackedDir, { recursive: true, force: true })
    return baseDirectory
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code !== 'EBUSY' && code !== 'EPERM') throw error
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const fallback = `${baseDirectory}-retry-${stamp}`
    console.warn(
      `[build-release] ${unpackedDir} 被占用（${code}），改输出到 ${fallback}。请关闭 Cursor 中对该目录的预览后再删旧包。`
    )
    return fallback
  }
}

const outputDirectory = await resolveOutputDirectory(`release/v${packageJson.version}`)
const child = spawn(
  process.execPath,
  [
    join(appRoot, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
    target,
    `--config.directories.output=${outputDirectory}`
  ],
  { cwd: appRoot, stdio: 'inherit' }
)

child.on('error', (error) => {
  throw error
})

const exitCode = await new Promise((resolveExit) => child.on('close', resolveExit))
if (exitCode !== 0) process.exitCode = Number(exitCode ?? 1)
