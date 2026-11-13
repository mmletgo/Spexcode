import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { repoRoot } from '@spexcode/spec-core'
import { clientSyncRequest } from './client.js'
import { readSpecBodyEdit } from './spec-body-edit.js'
import { stripRefSigil } from './mentions.js'

/** 同步操作交由真实后端持续执行；独立 check 直接调用同一候选验证能力。 */
export async function runSyncCli(argv: readonly string[]): Promise<void> {
  const [verb] = argv
  if (verb === 'check') return (await import('./sync/conformance-cli.js')).runConformanceCli(argv.slice(1))
  const continuityValues = ['--revision', '--enabled-digest', '--old-common-dev', '--old-root-dev', '--old-git-dev']
  const values = new Set(['--node', '--request-id', '--model', '--retry-of', '--patch-file', '--limit', '--config-digest', '--api', '--port', '--password', '--origin', '--input-id', '--analysis', '--findings', '--choice', '--rule', ...continuityValues])
  const allowed = new Set([...values, '--json', '--insecure', '--committed', '--record-unverified-coverage', '--inherit-retry-budget'])
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
  if (verb !== 'decide' && ['--analysis', '--findings', '--choice', '--rule'].some(flag => flags.has(flag))) throw usage('裁决选项只用于 sync decide')
  if (!['decide', 'resources', 'source-continuity'].includes(verb ?? '') && flags.has('--input-id')) throw usage('--input-id只用于裁决或显式离线恢复入口')
  if (verb !== 'source-continuity' && continuityValues.some(flag => flags.has(flag))) throw usage('连续性证明选项只用于 sync source-continuity')
  if (!['run', 'verify', 'status'].includes(verb ?? '') && flags.has('--node')) throw usage('--node 只用于 sync run、verify 或 status，物理暂停请省略节点选项')
  if (verb !== 'run' && flags.has('--patch-file')) throw usage('--patch-file 只用于 sync run')
  if (verb !== 'run' && flags.has('--origin')) throw usage('--origin 只用于 sync run')
  if (!['run', 'verify'].includes(verb ?? '') && flags.has('--model')) throw usage('--model 只用于 sync run 或 verify；恢复沿用原操作模型')
  if (verb !== 'run' && flags.has('--retry-of')) throw usage('--retry-of 只用于 sync run')
  const inheritRetryBudget = argv.includes('--inherit-retry-budget')
  if (inheritRetryBudget && (verb !== 'run' || !flags.has('--retry-of') || !flags.has('--model'))) throw usage('--inherit-retry-budget 需要 sync run --retry-of <operation-id> --model <model-id>')
  const committed = argv.includes('--committed')
  if (committed && (verb !== 'run' || flags.get('--origin') !== 'initial' || flags.has('--retry-of') || flags.has('--patch-file'))) throw usage('--committed 只用于无 --retry-of 和 --patch-file 的 sync run --origin initial')
  const recordUnverifiedCoverage = argv.includes('--record-unverified-coverage')
  const coverageOrigin = flags.get('--origin')
  if (recordUnverifiedCoverage && (verb !== 'run' || flags.has('--patch-file') || positional.length > (flags.has('--node') ? 0 : 1) || (coverageOrigin ? !['initial', 'code'].includes(coverageOrigin) : !flags.has('--retry-of')))) throw usage('--record-unverified-coverage 只用于无正文差量的 sync run --origin initial 或 code，也可用于这类操作的 --retry-of')
  const targetTree = repoRoot(), query = new URLSearchParams({ targetTree })
  let result: unknown
  if (verb === 'source-continuity') {
    const required = ['--input-id', ...continuityValues]
    if (positional.length !== 1 || required.some(flag => !flags.get(flag)?.trim())) throw usage('source-continuity需要operation ID、--input-id、--revision、--enabled-digest及三个--old-*-dev显式候选')
    if ([...flags.keys()].some(flag => !required.includes(flag)) || argv.includes('--insecure')) throw usage('source-continuity是离线入口，拒绝API路由或其它业务选项')
    const { registerSourceContinuity } = await import('./sync/application.js'), { configuredSessionApplication } = await import('./session-application.js')
    result = await registerSourceContinuity(targetTree, { operationId: positional[0], inputId: flags.get('--input-id')!, revision: Number(flags.get('--revision')), enabledDigest: flags.get('--enabled-digest')!, previousDevices: { commonDir: flags.get('--old-common-dev')!, root: flags.get('--old-root-dev')!, gitDir: flags.get('--old-git-dev')! } }, { protocol: configuredSessionApplication().protocol })
  } else if (verb === 'resources') {
    if (positional.length !== 2 || positional[0] !== 'recover' || !flags.get('--input-id')?.trim()) throw usage('resources recover需要完整operation ID与--input-id <原frozen输入>')
    if ([...flags.keys()].some(flag => flag !== '--input-id') || argv.includes('--insecure')) throw usage('resources recover是离线入口，仅接受--input-id与--json')
    const application = await (await import('./sync/application.js')).configuredSyncResourceRecoveryApplication(targetTree)
    const recovered = await application.recoverResources(positional[1], flags.get('--input-id')!)
    result = recovered
    if (recovered.status !== 'resources_recovered') process.exitCode = 1
  } else if (verb === 'enable') result = await clientSyncRequest('/settings', { targetTree, ...(flags.has('--config-digest') ? { expectedConfigDigest: flags.get('--config-digest') } : {}) })
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
    result = await clientSyncRequest(verb === 'verify' ? '/verify' : '/run', { targetTree, nodeId: stripRefSigil(nodeId), requestId: flags.get('--request-id') ?? randomUUID(), ...(retryOf ? { retryOf, ...(flags.has('--origin') ? { origin: flags.get('--origin') } : {}) } : { origin: flags.get('--origin') ?? 'spec' }), ...(flags.has('--model') ? { model: flags.get('--model') } : {}), ...(inheritRetryBudget ? { inheritRetryBudget } : {}), ...(patch ? { patch } : {}), ...(committed ? { committed } : {}), ...(recordUnverifiedCoverage ? { recordUnverifiedCoverage } : {}) })
  } else if (verb === 'decide') {
    if (positional.length !== 1 || !['--input-id', '--analysis', '--findings', '--choice'].every(flag => flags.has(flag))) throw usage('decide 需要 operation ID、--input-id、--analysis、--findings 与 --choice')
    const choice = flags.get('--choice')!
    if (choice !== 'new_rule' && flags.has('--rule')) throw usage('--rule 只用于 new_rule 裁决')
    if (!['keep_intent', 'adopt_behavior', 'new_rule'].includes(choice) || choice === 'new_rule' && !flags.get('--rule')?.trim()) throw usage('裁决需要 keep_intent、adopt_behavior 或带 --rule 的 new_rule')
    result = await clientSyncRequest(`/operations/${encodeURIComponent(positional[0])}/decide`, { targetTree, requestId: flags.get('--request-id') ?? randomUUID(), inputId: flags.get('--input-id'), analysisRef: { sha256: flags.get('--analysis') }, findingIds: flags.get('--findings')!.split(','), decision: { choice, ...(choice === 'new_rule' ? { rule: flags.get('--rule') } : {}) } })
  } else if (verb === 'adopt') {
    if (positional.length !== 1) throw usage('adopt 需要完整 operation ID')
    result = await clientSyncRequest(`/operations/${encodeURIComponent(positional[0])}/adopt`, { targetTree })
  } else if (verb === 'revert') {
    if (positional.length !== 1) throw usage('revert 需要完整 operation ID')
    result = await clientSyncRequest(`/operations/${encodeURIComponent(positional[0])}/revert`, { targetTree, requestId: flags.get('--request-id') ?? randomUUID() })
  } else if (verb === 'stop-writer') {
    if (positional.length || flags.has('--request-id')) throw usage('stop-writer 不接收 operation ID 或 --request-id')
    result = await clientSyncRequest('/stop-writer', { targetTree })
  } else if ((verb === 'pause' || verb === 'resume') && positional.length === 0) {
    result = await clientSyncRequest(`/automatic/${verb}`, { targetTree })
  } else if (verb === 'show' || ['pause', 'resume', 'cancel', 'recover'].includes(verb ?? '')) {
    if (positional.length !== 1) throw usage(`${verb} 需要完整 operation ID`)
    const path = `/operations/${encodeURIComponent(positional[0])}`
    result = verb === 'show' ? await clientSyncRequest(`${path}?${query}`) : await clientSyncRequest(`${path}/${verb}`, { targetTree })
  } else throw usage('用法：spex sync settings|enable|status|run|verify|decide|show|pause|resume|cancel|recover|resources|adopt|revert|stop-writer|check（spex help sync）')
  console.log(JSON.stringify(result, null, 2))
}
function usage(message: string): Error { const error = new Error(message); error.name = 'UsageError'; return error }
