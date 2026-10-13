import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const EXECUTION_CONFIG_PATTERN = '^(core\\.hookspath|core\\.fsmonitor|core\\.attributesfile|filter\\..*\\.(clean|smudge|process|required)|commit\\.gpgsign|tag\\.gpgsign|gpg\\..*program|gpg\\.program|user\\.signingkey|diff\\.external|diff\\..*\\.(command|textconv)|trailer\\..*\\.(cmd|command))$'
export type FrozenFootprintFile = { path: string; kind: 'missing' | 'file' | 'directory'; mode?: number; digest?: string }
export type FrozenFootprintPolicy = {
  version: 'frozen-delivery-footprint-v1'
  privateDirectory: { path: string; device: number; inode: number; mode: number }
  configurationDigest: string
  files: FrozenFootprintFile[]
}
export const footprintDigest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

/** 只读有效执行配置；不调用任何 hook、filter 或候选命令。 */
export function readFootprintConfiguration(gitPath: string, root: string): { digest: string; records: string[] } {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete env[key]
  const result = spawnSync(gitPath, ['--no-replace-objects', '--no-optional-locks', '-C', root, '-c', 'core.fsmonitor=false', 'config', '--null', '--show-origin', '--get-regexp', EXECUTION_CONFIG_PATTERN], { env, encoding: 'utf8' })
  if (result.status !== 0 && result.status !== 1) throw new Error('冻结 footprint 执行配置无法读取')
  const records = result.stdout.split('\0').filter(Boolean)
  for (let index = 0; index < records.length; index += 2) if (records[index].startsWith('file:')) records[index] = `file:${realpathSync(resolve(root, records[index].slice(5)))}`
  return { digest: footprintDigest(JSON.stringify(records)), records }
}

/** 绑定外部数据文件及目录清单；链接和特殊文件无法证明来源。 */
export function snapshotFootprintFile(path: string): FrozenFootprintFile {
  if (!existsSync(path)) return { path, kind: 'missing' }
  const stat = lstatSync(path)
  if (stat.isFile()) return { path, kind: 'file', mode: stat.mode & 0o777, digest: footprintDigest(readFileSync(path)) }
  if (stat.isDirectory()) return { path, kind: 'directory', mode: stat.mode & 0o777, digest: footprintDigest(JSON.stringify(readdirSync(path).sort())) }
  throw new Error(`冻结 footprint 不接受链接或特殊文件: ${path}`)
}

/** 每条可信 hook 与真实 materialize 均在副作用前复核同一冻结政策。 */
export function verifyFrozenFootprint(policy: FrozenFootprintPolicy, gitPath: string, root: string): void {
  const directory = policy.privateDirectory, stat = lstatSync(directory.path)
  if (policy.version !== 'frozen-delivery-footprint-v1' || !stat.isDirectory() || realpathSync(directory.path) !== directory.path || stat.dev !== directory.device || stat.ino !== directory.inode || (stat.mode & 0o777) !== directory.mode) throw new Error('冻结 footprint 私有目录身份变化')
  if (readFootprintConfiguration(gitPath, root).digest !== policy.configurationDigest) throw new Error('冻结 footprint 执行配置变化')
  for (const file of policy.files) if (JSON.stringify(snapshotFootprintFile(file.path)) !== JSON.stringify(file)) throw new Error(`冻结 footprint 绑定变化: ${file.path}`)
}

/** hook env 仅携内部摘要与无命令/凭据的政策，错误不回显外部配置值。 */
export function frozenFootprintFromEnv(gitPath: string, root: string): FrozenFootprintPolicy {
  const raw = process.env.SPEXCODE_SYNC_FOOTPRINT_POLICY
  if (!raw || footprintDigest(raw) !== process.env.SPEXCODE_SYNC_FOOTPRINT_SHA256) throw new Error('冻结 footprint 政策缺失或摘要变化')
  const policy = JSON.parse(raw) as FrozenFootprintPolicy
  verifyFrozenFootprint(policy, gitPath, root)
  return policy
}

/** 完整绑定已有 per-tree filter 数据，不解析或执行其中任何文本。 */
export function snapshotFilterPayloads(root: string, allowedFiles: readonly string[]): FrozenFootprintFile[] {
  const files = [snapshotFootprintFile(root)]
  if (!existsSync(root)) return files
  for (const tree of readdirSync(root).sort()) {
    files.push(snapshotFootprintFile(join(root, tree)))
    const directory = join(root, tree, 'contract-filter')
    files.push(snapshotFootprintFile(directory))
    if (!existsSync(directory)) continue
    for (const name of readdirSync(directory).sort()) {
      if (name !== 'manifest' && !/^\d+$/.test(name)) throw new Error(`未知 filter payload 文件: ${join(directory, name)}`)
      const file = snapshotFootprintFile(join(directory, name))
      if (file.kind !== 'file') throw new Error(`filter payload 必须为普通文件: ${file.path}`)
      files.push(file)
    }
    for (const row of readFileSync(join(directory, 'manifest'), 'utf8').split('\n').filter(Boolean)) {
      const [file, target, extra] = row.split('\t')
      const name = typeof target === 'string' ? target.slice(target.lastIndexOf('/') + 1) : '', ownedPath = join(directory, name)
      if (extra !== undefined || !allowedFiles.includes(file) || !/^\d+$/.test(name) || target !== ownedPath || !files.some(entry => entry.path === ownedPath && entry.kind === 'file')) throw new Error('filter payload manifest 指向未证明的来源')
    }
  }
  return files
}
