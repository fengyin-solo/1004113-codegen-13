/**
 * 交接链路规则的零依赖运行时验证：
 *   node scripts/test-handover.cjs
 * 用已安装的 esbuild 把 TS（含 @/ 别名）打成单文件 CJS，在内存版 localStorage 中执行。
 */
const path = require('node:path')
const fs = require('node:fs')
const esbuild = require(path.join(__dirname, '..', 'node_modules', 'esbuild'))
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'node_modules', '.cache', 'handover-test')
fs.mkdirSync(OUT_DIR, { recursive: true })
const entry = path.join(OUT_DIR, 'entry.ts')
const bundle = path.join(OUT_DIR, 'bundle.cjs')
fs.writeFileSync(
  entry,
  [
    "export * as service from '@/api/crew-schedule-service'",
    "export * as store from '@/data/local-store'",
    "export * as chainsStore from '@/data/handover-store'",
    "export * as query from '@/api/handover-query-service'",
  ].join('\n'),
)

esbuild
  .build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    resolveExtensions: ['.ts', '.js'],
    outfile: bundle,
    alias: { '@': path.join(ROOT, 'src') },
  })
  .then(() => {
    execFileSync(process.execPath, [path.join(__dirname, 'handover-rules.cjs'), bundle], { stdio: 'inherit' })
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
