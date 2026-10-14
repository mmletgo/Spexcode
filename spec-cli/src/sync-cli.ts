import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { repoRoot } from '@spexcode/spec-core'
import { clientSyncRequest } from './client.js'
import { readSpecBodyEdit } from './spec-body-edit.js'
import { stripRefSigil } from './mentions.js'

/** CLI 只提交真实后端操作并打印持久结果；操作在服务进程内继续，无 Dashboard 依赖。 */
export async function runSyncCli(argv: readonly string[]): Promise<void> {
  const [verb] = argv
  const values = new Set(['--node', '--request-id', '--retry-of', '--patch-file', '--limit', '--config-digest', '--api', '--port', '--password', '--origin', '--input-id', '--analysis', '--findings', '--choice', '--rule'])
  const allowed = new Set([...values, '--json', '--insecure'])
  const positional: string[] = []
  const flags = new Map<string, string>()
  for (let at = 1; at < argv.length; at++) {
    const token = argv[at]
    if (!token.startsWith('--')) { positional.push(token); continue }
    if (!allowed.has(token)) throw usage(`未知选项 ${token}`)
    if (values.has(token)) {
      const value = argv[++at]
      if (!value || value.startsWith('--')) throw usage(`${token} 需要值`)
      flags.set(token, value)
    }
  }
  if (verb !== 'decide' && ['--input-id', '--analysis', '--findings', '--choice', '--rule'].some(flag => flags.has(flag))) throw usage('裁决选项只用于 sync decide')
  if (verb !== 'run' && flags.has('--origin')) throw usage('--origin 只用于 sync run')
  if (verb !== 'run' && flags.has('--retry-of')) throw usage('--retry-of 只用于 sync run')
  const targetTree = repoRoot(), query = new URLSearchParams({ targetTree })
  let result: unknown
  if (verb === 'enable') result = await clientSyncRequest('/settings', { targetTree, ...(flags.has('--config-digest') ? { expectedConfigDigest: flags.get('--config-digest') } : {}) })
  else if (verb === 'settings') result = await clientSyncRequest(`/settings?${query}`)
  else if (verb === 'status') {
    if (flags.has('--node')) query.set('nodeId', stripRefSigil(flags.get('--node')!))
    if (flags.has('--limit')) {
      const limit = Number(flags.get('--limit'))
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw usage('--limit 须为 1 至 200 的整数')
      query.set('limit', String(limit))
    }
    result = await clientSyncRequest(`/status?${query}`)
  } else if (verb === 'run' || verb === 'verify') {
    const nodeId = flags.get('--node') ?? positional[0]
    if (!nodeId) throw usage('run 需要节点：spex sync run <node-id>')
    const retryOf = flags.get('--retry-of')
    const patchFile = flags.get('--patch-file')
    if (retryOf && patchFile) throw usage('--retry-of 沿用原正文意图，不能同时指定 --patch-file')
    const patch = patchFile ? readSpecBodyEdit(JSON.parse(readFileSync(patchFile, 'utf8')) as unknown) : undefined
    result = await clientSyncRequest(verb === 'verify' ? '/verify' : '/run', { targetTree, nodeId: stripRefSigil(nodeId), requestId: flags.get('--request-id') ?? randomUUID(), ...(retryOf ? { retryOf, ...(flags.has('--origin') ? { origin: flags.get('--origin') } : {}) } : { origin: flags.get('--origin') ?? 'spec' }), ...(patch ? { patch } : {}) })
  } else if (verb === 'decide') {
    if (positional.length !== 1 || !['--input-id', '--analysis', '--findings', '--choice'].every(flag => flags.has(flag))) throw usage('decide 需要 operation ID、--input-id、--analysis、--findings 与 --choice')
    const choice = flags.get('--choice')!
    if (choice !== 'new_rule' && flags.has('--rule')) throw usage('--rule 只用于 new_rule 裁决')
    if (!['keep_intent', 'adopt_behavior', 'new_rule'].includes(choice) || choice === 'new_rule' && !flags.get('--rule')?.trim()) throw usage('裁决需要 keep_intent、adopt_behavior 或带 --rule 的 new_rule')
    result = await clientSyncRequest(`/operations/${encodeURIComponent(positional[0])}/decide`, { targetTree, requestId: flags.get('--request-id') ?? randomUUID(), inputId: flags.get('--input-id'), analysisRef: { sha256: flags.get('--analysis') }, findingIds: flags.get('--findings')!.split(','), decision: { choice, ...(choice === 'new_rule' ? { rule: flags.get('--rule') } : {}) } })
  } else if ((verb === 'pause' || verb === 'resume') && positional.length === 0) {
    result = await clientSyncRequest(`/automatic/${verb}`, { targetTree })
  } else if (verb === 'show' || ['pause', 'resume', 'cancel', 'recover'].includes(verb ?? '')) {
    if (positional.length !== 1) throw usage(`${verb} 需要完整 operation ID`)
    const path = `/operations/${encodeURIComponent(positional[0])}`
    result = verb === 'show' ? await clientSyncRequest(`${path}?${query}`) : await clientSyncRequest(`${path}/${verb}`, { targetTree })
  } else throw usage('用法：spex sync settings|enable|status|run|verify|decide|show|pause|resume|cancel|recover（spex help sync）')
  console.log(JSON.stringify(result, null, 2))
}
function usage(message: string): Error { const error = new Error(message); error.name = 'UsageError'; return error }
