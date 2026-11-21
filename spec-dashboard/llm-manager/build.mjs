import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [source, output] = process.argv.slice(2)
if (!source || !output) {
  throw new Error('Usage: npm run build:llm-manager -- <compiled llm_manager dist directory> <output HTML>')
}

const dist = resolve(source)
await readFile(join(dist, 'index.js'))
const stage = await mkdtemp(join(tmpdir(), 'spex-llm-settings-'))
try {
  const compiled = join(stage, 'llm-manager-dist')
  await mkdir(compiled)
  for (const file of await readdir(dist)) {
    if (file.endsWith('.js')) await cp(join(dist, file), join(compiled, file))
  }
  await cp(new URL('./settings.jsx', import.meta.url), join(stage, 'settings.jsx'))
  execFileSync('npm', [
    'install', '--prefix', stage, '--no-save', '--no-audit', '--no-fund', '--ignore-scripts',
    '--registry=https://registry.npmjs.org', 'react@19.2.7', 'react-dom@19.2.7', 'esbuild@0.28.1',
  ], { stdio: 'inherit' })

  const { build } = await import(pathToFileURL(join(stage, 'node_modules/esbuild/lib/main.js')).href)
  const result = await build({
    absWorkingDir: stage,
    entryPoints: ['settings.jsx'],
    alias: { 'llm-manager-settings': './llm-manager-dist/index.js' },
    jsx: 'automatic',
    bundle: true,
    minify: true,
    legalComments: 'inline',
    write: false,
  })
  const javascript = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')
  const stylesheet = await readFile(new URL('./settings.css', import.meta.url), 'utf8')
  const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LLM Manager</title>
<style>${stylesheet}</style>
</head>
<body>
<main>
<h1>LLM Manager</h1>
<div id="settings"><p role="status">正在加载设置</p></div>
</main>
<script>${javascript}</script>
</body>
</html>
`
  await writeFile(resolve(output), html, { encoding: 'utf8', mode: 0o600 })
} finally {
  await rm(stage, { recursive: true, force: true })
}
