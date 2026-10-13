import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectTrustedRuntime } from './trusted-hooks.js'
import type { TrustedRuntimeEntry } from './trusted-hooks.js'

export class RuntimeFreezeError extends Error {
  constructor(public readonly code: 'unsupported' | 'conflict', message: string) { super(message); this.name = 'RuntimeFreezeError' }
}
export type RuntimePackageIdentity = { name: string; version: string; canonicalRoot: string; packageJsonDigest: string }
export type FrozenRuntimePackage = { id: string; source: RuntimePackageIdentity; dependencies: Record<string, string> }
export type FrozenDeliveryRuntime = {
  trustedRuntimeRoot: string; toolEntry: string; canonicalHooksDir: string
  manifest: TrustedRuntimeEntry[]; digest: string; sourcePackage: RuntimePackageIdentity
  packages: FrozenRuntimePackage[]; excluded: { packageId: string; path: string; reason: 'private_metadata' | 'source_symlink' }[]
}
type PackageJson = { name: string; version: string; files?: string[]; main?: string; bin?: string | Record<string, string>; exports?: unknown; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
type Package = { id: string; root: string; json: PackageJson; identity: RuntimePackageIdentity; dependencies: Record<string, Package> }
const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`)
const unsupported = (message: string): never => { throw new RuntimeFreezeError('unsupported', message) }

function readPackage(root: string): { json: PackageJson; identity: RuntimePackageIdentity } {
  if (!lstatSync(join(root, 'package.json')).isFile()) unsupported('package.json 必须是普通发布文件')
  const bytes = readFileSync(join(root, 'package.json')), json = JSON.parse(bytes.toString('utf8')) as PackageJson
  if (typeof json.name !== 'string' || !json.name || typeof json.version !== 'string' || !json.version) unsupported('可信发布包缺少 name/version')
  return { json, identity: { name: json.name, version: json.version, canonicalRoot: root, packageJsonDigest: hash(bytes) } }
}

/** 使用当前包的实际 Node 解析上下文；未导出 package.json 时只由实际入口向上定位包。 */
function dependencyRoot(root: string, name: string): string {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || ['.', '..'].includes(name.split('/').at(-1)!)) unsupported('生产 dependency 名称不能作为包路径解析')
  const require = createRequire(join(root, 'package.json'))
  try { return realpathSync(dirname(require.resolve(`${name}/package.json`))) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' && code !== 'MODULE_NOT_FOUND') throw error
    let directory = dirname(realpathSync(require.resolve(name)))
    for (;;) {
      const manifest = join(directory, 'package.json')
      if (existsSync(manifest) && readPackage(directory).json.name) return directory
      const parent = dirname(directory)
      if (parent === directory) unsupported(`生产依赖 ${name} 无法定位发布 package`)
      directory = parent
    }
  }
}

function packagePath(path: string): string {
  const clean = path.replace(/^\.\//, '').replace(/\/$/, '')
  if (!clean || isAbsolute(clean) || clean.includes('\\') || clean.split('/').some(part => !part || part === '..' || part === '.') || /[\0{}[\]!]/.test(clean)) unsupported('未知或越界发布路径')
  return clean
}
function safeParents(root: string, path: string): void {
  const parts = path.split('/')
  for (let count = 1; count < parts.length; count++) if (!lstatSync(join(root, ...parts.slice(0, count))).isDirectory()) unsupported(`发布路径父目录不能为 symlink: ${path}`)
}
/** 只展开已声明的精确路径或末段 * / ?，不扫描 workspace 的其它目录。 */
function publishedPaths(root: string, declaration: string): string[] {
  const path = packagePath(declaration), parent = dirname(path), name = basename(path)
  if (/[*?]/.test(parent)) unsupported(`未支持的发布 glob: ${path}`)
  safeParents(root, path)
  if (!/[*?]/.test(name)) {
    if (!lstatSync(join(root, path), { throwIfNoEntry: false })) unsupported(`发布文件缺失: ${path}`)
    return [path]
  }
  const pattern = new RegExp(`^${name.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  return readdirSync(join(root, parent)).filter(entry => pattern.test(entry)).sort().map(entry => parent === '.' ? entry : `${parent}/${entry}`)
}
const privateMetadata = (path: string): boolean => path.split('/').some(name => ['node_modules', '.git', '.hg', '.svn', '.npmrc', '.yarnrc', '.ssh', '.aws', '.codex', '.claude', '.spex', '.spexcode', '.npm', '.config', '.cache', '.DS_Store', 'auth.json', 'credentials.json', 'credentials', 'package-lock.json', '.package-lock.json', 'npm-debug.log'].includes(name) || name === '.env' || name.startsWith('.env.') || /\.(?:pem|key)$/i.test(name))
function exportPaths(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (typeof value === 'string') {
    if (!value.startsWith('./')) unsupported('未知 package export 目标')
    return [value]
  }
  if (typeof value !== 'object') unsupported('未知 package exports 声明')
  return Object.values(value).flatMap(exportPaths)
}

/** 冻结可信已编译工具和生产闭包；该发布快照不代表 private delivery 已完成。 */
export function freezeDeliveryRuntime(ownedDestination: string, trustedCliPackageRoot = fileURLToPath(new URL('../..', import.meta.url))): FrozenDeliveryRuntime {
  if (!isAbsolute(ownedDestination)) unsupported('固定 runtime 目标必须为调用方拥有的绝对路径')
  const destination = join(realpathSync(dirname(ownedDestination)), basename(ownedDestination))
  if (lstatSync(destination, { throwIfNoEntry: false })) throw new RuntimeFreezeError('conflict', '固定 runtime 目标已存在，不能替换')
  let stage: string | undefined
  try {
    const packages = new Map<string, Package>()
    const discover = (path: string): Package => {
      const root = realpathSync(path), existing = packages.get(root)
      if (existing) return existing
      if (inside(root, destination) || inside(destination, root)) unsupported('runtime 目标不能重叠可信源 package')
      const { json, identity } = readPackage(root)
      if (json.files !== undefined && (!Array.isArray(json.files) || !json.files.every(file => typeof file === 'string'))) unsupported('未知 package files 发布声明')
      if (!json.files && !root.split(sep).includes('node_modules')) unsupported('workspace 发布包必须显式声明 files')
      const item: Package = { id: String(packages.size), root, json, identity, dependencies: {} }
      packages.set(root, item)
      for (const name of [...new Set([...Object.keys(json.dependencies ?? {}), ...Object.keys(json.optionalDependencies ?? {}), ...Object.keys(json.peerDependencies ?? {})])].sort()) item.dependencies[name] = discover(dependencyRoot(root, name))
      return item
    }
    const cli = discover(trustedCliPackageRoot)
    if (cli.json.name !== '@spexcode/spec-cli') unsupported('可信 CLI 来源 package 身份不匹配')
    for (const path of ['dist/cli.js', 'templates/hooks']) {
      safeParents(cli.root, path)
      const stat = lstatSync(join(cli.root, path), { throwIfNoEntry: false })
      if (!stat || (path === 'dist/cli.js' ? !stat.isFile() : !stat.isDirectory())) unsupported(`可信已编译 CLI 缺少 ${path}`)
    }
    stage = mkdtempSync(join(dirname(destination), '.spex-runtime-'))
    const temporaryRoot = stage, excluded: FrozenDeliveryRuntime['excluded'] = []
    const packageRoot = (item: Package): string => join(temporaryRoot, 'packages', item.id)
    for (const item of packages.values()) {
      const output = packageRoot(item), copied = new Set<string>()
      mkdirSync(output, { recursive: true })
      const copy = (path: string): void => {
        if (copied.has(path)) return
        copied.add(path)
        if (privateMetadata(path)) { excluded.push({ packageId: item.id, path, reason: 'private_metadata' }); return }
        safeParents(item.root, path)
        const source = join(item.root, path), target = join(output, path), stat = lstatSync(source)
        mkdirSync(dirname(target), { recursive: true })
        // npm 发布不包含源码 symlink；只生成本 runtime 的闭合 dependency 链接。
        if (stat.isSymbolicLink()) excluded.push({ packageId: item.id, path, reason: 'source_symlink' })
        else if (stat.isDirectory()) {
          mkdirSync(target, { recursive: true })
          for (const name of readdirSync(source).sort()) copy(`${path}/${name}`)
        } else if (stat.isFile()) { copyFileSync(source, target); chmodSync(target, stat.mode & 0o777) }
        else unsupported(`发布 package 含特殊文件: ${path}`)
      }
      const declarations = item.json.files ?? readdirSync(item.root).sort()
      const bins = typeof item.json.bin === 'string' ? [item.json.bin] : Object.values(item.json.bin ?? {})
      const mandatory = ['package.json', ...(item.json.main ? [item.json.main] : []), ...bins, ...readdirSync(item.root).filter(name => /^(?:readme|licen[cs]e|copying|notice)(?:\.|$)/i.test(name))]
      for (const declaration of [...declarations, ...mandatory]) {
        if (privateMetadata(declaration)) { excluded.push({ packageId: item.id, path: declaration, reason: 'private_metadata' }); continue }
        for (const path of publishedPaths(item.root, declaration)) copy(path)
      }
      if (hash(readFileSync(join(output, 'package.json'))) !== item.identity.packageJsonDigest) unsupported('冻结过程中来源 package 元数据已变化')
      for (const declaration of [...(item.json.main ? [item.json.main] : []), ...bins]) if (!lstatSync(join(output, packagePath(declaration)), { throwIfNoEntry: false })?.isFile()) unsupported('声明的 main/bin 不是闭合的普通发布文件')
      for (const target of exportPaths(item.json.exports)) {
        const paths = publishedPaths(output, target)
        if (!paths.length) unsupported(`未闭合的 package export: ${target}`)
      }
    }
    for (const item of packages.values()) for (const [name, dependency] of Object.entries(item.dependencies)) {
      const link = join(packageRoot(item), 'node_modules', name)
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(relative(dirname(link), packageRoot(dependency)), link, 'dir')
    }
    for (const item of packages.values()) for (const [name, dependency] of Object.entries(item.dependencies)) if (dependencyRoot(packageRoot(item), name) !== packageRoot(dependency)) unsupported(`固定生产依赖解析未闭合: ${name}`)
    if (!existsSync(join(packageRoot(cli), 'dist/cli.js')) || !existsSync(join(packageRoot(cli), 'templates/hooks'))) unsupported('CLI 发布范围没有包含编译入口或 canonical hooks')
    for (const entry of inspectTrustedRuntime(temporaryRoot).reverse()) if (entry.kind !== 'symlink') chmodSync(join(temporaryRoot, entry.path), entry.mode & 0o555)
    chmodSync(temporaryRoot, 0o555)
    const manifest = inspectTrustedRuntime(temporaryRoot), digest = hash(JSON.stringify(manifest))
    // 复制阶段可能较长，再核目标不存在；发布不提供更新入口。
    if (lstatSync(destination, { throwIfNoEntry: false })) throw new RuntimeFreezeError('conflict', '固定 runtime 目标已存在，不能替换')
    renameSync(temporaryRoot, destination)
    stage = undefined
    const cliRoot = join(destination, 'packages', cli.id)
    return { trustedRuntimeRoot: destination, toolEntry: join(cliRoot, 'dist/cli.js'), canonicalHooksDir: join(cliRoot, 'templates/hooks'), manifest, digest, sourcePackage: cli.identity, packages: [...packages.values()].map(item => ({ id: item.id, source: item.identity, dependencies: Object.fromEntries(Object.entries(item.dependencies).map(([name, dependency]) => [name, dependency.id])) })), excluded }
  } catch (error) {
    if (error instanceof RuntimeFreezeError) throw error
    throw new RuntimeFreezeError('unsupported', `可信 runtime 无法冻结: ${(error as Error).message}`)
  } finally {
    if (stage) {
      const unlock = (path: string): void => { const stat = lstatSync(path); if (stat.isDirectory()) { chmodSync(path, 0o755); for (const name of readdirSync(path)) unlock(join(path, name)) } }
      unlock(stage); rmSync(stage, { recursive: true, force: true })
    }
  }
}
