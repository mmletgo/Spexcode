import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const packageRoot = fileURLToPath(new URL('../../', import.meta.url)), repositoryRoot = dirname(packageRoot)

test('AC-REMOTE-BUILD-01 正常build和pack保留真实helper运行时，compiled consumer可导入', t => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'spex-v3-build-')))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  mkdirSync(join(fixture, 'src', 'sync'), { recursive: true })
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { files: string[] }
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'verification-runtime-artifact-fixture', version: '1.0.0', type: 'module', files: packageJson.files }))
  for (const name of ['tsconfig.json', 'tsconfig.build.json']) copyFileSync(join(packageRoot, name), join(fixture, name))
  // 连同可能遮蔽runtime的同名声明复制；不能只在fixture中挑选已知能过的.mjs。
  for (const name of readdirSync(join(packageRoot, 'src', 'sync')).filter(name => name.startsWith('verification-remote-helper.'))) copyFileSync(join(packageRoot, 'src', 'sync', name), join(fixture, 'src', 'sync', name))
  writeFileSync(join(fixture, 'src', 'sync', 'consumer.ts'), "export { verificationExportDigest } from './verification-remote-helper.mjs'\n")
  symlinkSync(join(repositoryRoot, 'node_modules'), join(fixture, 'node_modules'))
  execFileSync(process.execPath, [join(repositoryRoot, 'scripts', 'build-dist.mjs')], { cwd: fixture, stdio: 'pipe' })
  const runtime = join(fixture, 'dist', 'sync', 'verification-remote-helper.mjs')
  assert.equal(existsSync(runtime), true, '正常build不能只留下同名声明而漏发runtime')
  const consumer = pathToFileURL(join(fixture, 'dist', 'sync', 'consumer.js')).href
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(consumer)});console.log(typeof m.verificationExportDigest)`], { encoding: 'utf8' }).trim(), 'function')
  const userConfig = join(fixture, 'npmrc-user'), globalConfig = join(fixture, 'npmrc-global')
  writeFileSync(userConfig, ''); writeFileSync(globalConfig, '')
  const manifest = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: fixture, encoding: 'utf8', env: { ...process.env, npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig, npm_config_cache: join(fixture, 'npm-cache'), npm_config_offline: 'true', npm_config_update_notifier: 'false' } })) as { files: { path: string }[] }[]
  assert.ok(manifest[0].files.some(file => file.path === 'dist/sync/verification-remote-helper.mjs'))
})
