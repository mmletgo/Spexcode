import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type TrustedHookIssue = { path: string; reason: string }
export type TrustedRuntimeEntry = { path: string; kind: 'file' | 'directory' | 'symlink'; mode: number; digest?: string; target?: string }
export type TrustedHooksBinding = {
  version: 'trusted-hooks-v1'
  operation: 'prepare' | 'publish'
  root: string
  nodePath: string; nodeDigest: string
  gitPath: string; gitDigest: string
  toolEntry: string; toolDigest: string
  trustedRuntimeRoot: string; runtimeManifest: TrustedRuntimeEntry[]; runtimeDigest: string
  canonicalHooksDir: string; hooksDir: string; hookDigests: Record<string, string>
  expectedTree: string; expectedParent: string; expectedRef: string
}
export type TrustedHooksOptions = Pick<TrustedHooksBinding, 'operation' | 'toolEntry' | 'trustedRuntimeRoot' | 'canonicalHooksDir' | 'expectedTree' | 'expectedParent' | 'expectedRef'> & { nodePath?: string; gitPath?: string }
export type TrustedHooksInspection = { status: 'supported'; binding: TrustedHooksBinding } | { status: 'unsupported'; issues: TrustedHookIssue[] }
const REQUIRED_HOOKS = ['pre-commit', 'prepare-commit-msg', 'reference-transaction', 'post-checkout']
const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`)
const fileDigest = (path: string): string => hash(readFileSync(path))

/** 完整发布 runtime 的字节/模式/内部链接身份；不执行任何入口或候选脚本。 */
export function inspectTrustedRuntime(root: string): TrustedRuntimeEntry[] {
  const entries: TrustedRuntimeEntry[] = []
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path), local = relative(root, path).split(sep).join('/')
      if (stat.isSymbolicLink()) {
        if (!inside(root, realpathSync(path))) throw new Error(`runtime 外部链接无法绑定: ${local}`)
        entries.push({ path: local, kind: 'symlink', mode: stat.mode & 0o777, target: readlinkSync(path) })
      } else if (stat.isDirectory()) { entries.push({ path: local, kind: 'directory', mode: stat.mode & 0o777 }); visit(path) }
      else if (stat.isFile()) entries.push({ path: local, kind: 'file', mode: stat.mode & 0o777, digest: fileDigest(path) })
      else throw new Error(`runtime 特殊文件无法绑定: ${local}`)
    }
  }
  visit(root)
  return entries
}

/** 内部交付 child 的确定环境；不继承 shell/Node/Git 注入或本地 lint/defer bypass。 */
export function makeTrustedHookEnv(binding: TrustedHooksBinding, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('BASH_FUNC_') && !key.startsWith('LD_') && !key.startsWith('DYLD_') && !key.startsWith('SPEXCODE_SYNC_') && !['NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'CDPATH', 'SPEXCODE_SKIP_LINT', 'SPEXCODE_DEFER_FOOTPRINT_REFRESH', 'SPEXCODE_ALLOW_MAIN', 'SPEXCODE_GATE_SCOPE_ONLY'].includes(key)))
  return { ...env, PATH: `${dirname(binding.gitPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, SPEXCODE_SYNC_HOOK_MODE: 'trusted-v1', SPEXCODE_SYNC_OPERATION: binding.operation, SPEXCODE_SYNC_NODE: binding.nodePath, SPEXCODE_SYNC_NODE_SHA256: binding.nodeDigest, SPEXCODE_SYNC_GIT: binding.gitPath, SPEXCODE_SYNC_GIT_SHA256: binding.gitDigest, SPEXCODE_SYNC_TOOL: binding.toolEntry, SPEXCODE_SYNC_TOOL_SHA256: binding.toolDigest, SPEXCODE_SYNC_RUNTIME_ROOT: binding.trustedRuntimeRoot, SPEXCODE_SYNC_RUNTIME_SHA256: binding.runtimeDigest, SPEXCODE_SYNC_EXPECTED_TREE: binding.expectedTree, SPEXCODE_SYNC_EXPECTED_PARENT: binding.expectedParent, SPEXCODE_SYNC_EXPECTED_REF: binding.expectedRef }
}

/** 静态 preflight 固定外部发布工具与实际 canonical hooks；无法证明时列出路径并拒绝。 */
export function prepareTrustedHooksBinding(root: string, options: TrustedHooksOptions): TrustedHooksInspection {
  const issues: TrustedHookIssue[] = []
  if (!['prepare', 'publish'].includes(options.operation)) return { status: 'unsupported', issues: [{ path: root, reason: '受控操作必须明确 prepare 或 publish' }] }
  const issue = (path: string, reason: string): void => { issues.push({ path, reason }) }
  try {
    for (const path of [options.nodePath, options.gitPath, options.toolEntry, options.trustedRuntimeRoot, options.canonicalHooksDir].filter((path): path is string => path !== undefined)) if (!isAbsolute(path)) issue(path, '受信工具与模板必须提供绝对路径')
    if (issues.length) return { status: 'unsupported', issues }
    if (!['darwin', 'linux'].includes(process.platform)) return { status: 'unsupported', issues: [{ path: root, reason: '受控 Bash hooks 当前只证明 Darwin/Linux' }] }
    root = realpathSync(root)
    const nodePath = realpathSync(options.nodePath ?? process.execPath)
    const gitDefault = ['/usr/bin/git', '/bin/git'].find(path => existsSync(path))
    if (!options.gitPath && !gitDefault) throw new Error('没有固定系统 Git 路径')
    const gitPath = realpathSync(options.gitPath ?? gitDefault!)
    const toolEntry = realpathSync(options.toolEntry), trustedRuntimeRoot = realpathSync(options.trustedRuntimeRoot), canonicalHooksDir = realpathSync(options.canonicalHooksDir)
    for (const path of [nodePath, gitPath, toolEntry, trustedRuntimeRoot, canonicalHooksDir]) if (!isAbsolute(path) || inside(root, path) || inside(trustedRuntimeRoot, root)) issue(path, '受信系统工具/runtime/模板必须在候选目录外')
    if (!/[/\\]dist[/\\]cli\.(?:js|mjs)$/.test(toolEntry) || !inside(trustedRuntimeRoot, toolEntry) || !inside(trustedRuntimeRoot, canonicalHooksDir)) issue(toolEntry, '入口必须为受信 runtime 内的 dist/cli.js 或 cli.mjs；不启动源码 launcher')
    for (const path of [nodePath, gitPath]) if (!lstatSync(path).isFile() || !(lstatSync(path).mode & 0o111)) issue(path, '系统 Node/Git 必须为可执行普通文件')
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.expectedTree) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.expectedParent) || !options.expectedRef.startsWith('refs/heads/')) issue(root, '交付 tree/parent/ref 必须为明确不可变身份')
    const env = makeTrustedHookEnv({ nodePath, gitPath } as TrustedHooksBinding)
    delete env.SPEXCODE_SYNC_HOOK_MODE
    const git = (args: string[]): string => {
      const result = spawnSync(gitPath, ['--no-optional-locks', '-C', root, '-c', 'core.fsmonitor=false', ...args], { env, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`Git 静态读取失败: ${args[0]}`)
      return result.stdout.trim()
    }
    if (git(['check-ref-format', options.expectedRef]) !== '') issue(root, '交付 ref 非法')
    if (git(['cat-file', '-t', options.expectedTree]) !== 'tree' || git(['cat-file', '-t', options.expectedParent]) !== 'commit') issue(root, '预期 tree/parent 对象类型不匹配')
    if (options.operation === 'prepare' && git(['show', '-s', '--format=%T', options.expectedParent]) !== options.expectedTree) issue(root, 'prepare 必须绑定已有 parent 的 base tree')
    if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== root) issue(root, '必须提供实际 worktree 根目录')
    const config = spawnSync(gitPath, ['--no-optional-locks', '-C', root, '-c', 'core.fsmonitor=false', 'config', '--null', '--show-origin', '--get-regexp', '^(core\\.hookspath|core\\.fsmonitor|core\\.attributesfile|filter\\..*\\.(clean|smudge|process|required)|commit\\.gpgsign|tag\\.gpgsign|gpg\\..*program|gpg\\.program|user\\.signingkey|diff\\.external|diff\\..*\\.(command|textconv)|trailer\\..*\\.(cmd|command))$'], { env, encoding: 'utf8' })
    if (config.status !== 0 && config.status !== 1) throw new Error('Git 执行配置无法静态读取')
    const records = config.stdout.split('\0').filter(Boolean)
    for (let index = 0; index < records.length; index += 2) {
      const origin = records[index], [key, ...value] = records[index + 1].split('\n'), content = value.join('\n')
      if (['commit.gpgsign', 'tag.gpgsign'].includes(key) && /^(false|no|off|0)$/i.test(content)) continue
      if (key === 'core.fsmonitor' && /^(false|no|off|0)$/i.test(content)) continue
      // 不回显命令值；filter/signing 命令中可能包含凭据。
      issue(origin.startsWith('file:') ? resolve(root, origin.slice(5)) : origin, `执行配置来源未证明: ${key}`)
    }
    const hooksDir = realpathSync(git(['rev-parse', '--path-format=absolute', '--git-path', 'hooks']))
    if (inside(root, hooksDir) && !inside(resolve(root, '.git'), hooksDir)) issue(hooksDir, '候选目录内 hookspath 不具备受信来源')
    const hookDigests: Record<string, string> = {}
    for (const name of readdirSync(hooksDir)) {
      if (name.endsWith('.sample')) continue
      const actual = join(hooksDir, name), stat = lstatSync(actual)
      if (!(stat.mode & 0o111)) continue
      const canonical = join(canonicalHooksDir, name)
      if (!stat.isFile() || !existsSync(canonical) || !lstatSync(canonical).isFile() || !readFileSync(actual).equals(readFileSync(canonical))) issue(actual, '实际可执行 hook 与受信 canonical 模板字节不一致')
      else hookDigests[name] = fileDigest(actual)
    }
    for (const name of REQUIRED_HOOKS) if (!hookDigests[name]) issue(join(hooksDir, name), '受控交付必需 canonical hook 缺失或未执行')
    if (issues.length) return { status: 'unsupported', issues }
    const runtimeManifest = inspectTrustedRuntime(trustedRuntimeRoot)
    return { status: 'supported', binding: { version: 'trusted-hooks-v1', operation: options.operation, root, nodePath, nodeDigest: fileDigest(nodePath), gitPath, gitDigest: fileDigest(gitPath), toolEntry, toolDigest: fileDigest(toolEntry), trustedRuntimeRoot, runtimeManifest, runtimeDigest: hash(JSON.stringify(runtimeManifest)), canonicalHooksDir, hooksDir, hookDigests, expectedTree: options.expectedTree, expectedParent: options.expectedParent, expectedRef: options.expectedRef } }
  } catch (error) {
    issue(root, error instanceof Error ? error.message : String(error))
    return { status: 'unsupported', issues }
  }
}

/** commit 前重新核对固定 binding；不会修补配置或替换 custom hooks。 */
export function inspectTrustedHooksBinding(root: string, binding: TrustedHooksBinding): TrustedHooksInspection {
  const inspected = prepareTrustedHooksBinding(root, binding)
  if (inspected.status === 'unsupported') return inspected
  if (JSON.stringify(inspected.binding) !== JSON.stringify(binding)) return { status: 'unsupported', issues: [{ path: root, reason: '已登记工具/runtime/hook/配置 binding 已变化' }] }
  return inspected
}
