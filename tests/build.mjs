// Bundles the TypeScript tests (with a stub for the 'electron' module) so they run under plain Node.
import { build } from 'esbuild'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const entries = readdirSync(here).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(here, f))
await build({
  entryPoints: entries,
  outdir: path.join(here, 'dist'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  packages: 'external',
  alias: { electron: path.join(here, 'electron-stub.ts') },
  logLevel: 'warning'
})