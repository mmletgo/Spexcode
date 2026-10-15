import { repoRoot } from '@spexcode/spec-core'
import { runConformance } from './conformance.js'

/** CI 入口直接重算当前候选，不连接开发机后台或接受已通过结果。 */
export async function runConformanceCli(argv: readonly string[]): Promise<void> {
  const flags = new Map<string, string>(), allowed = new Set(['--repository', '--base', '--candidate', '--policy', '--evidence-directory'])
  for (let at = 0; at < argv.length; at++) {
    const name = argv[at]
    if (name === '--json') continue
    if (!allowed.has(name) || flags.has(name)) throw usage(`sync check 未知或重复选项: ${name}`)
    const value = argv[++at]
    if (!value || value.startsWith('--')) throw usage(`sync check ${name} 需要值`)
    flags.set(name, value)
  }
  const baseCommit = flags.get('--base'), candidateCommit = flags.get('--candidate')
  if (!baseCommit || !candidateCommit) throw usage('用法：spex sync check --base <commit-sha> --candidate <commit-sha> [--policy <trusted-commit-sha>] [--repository <path>] [--evidence-directory <existing-directory>]')
  const result = await runConformance({ repository: flags.get('--repository') ?? repoRoot(), baseCommit, candidateCommit, policyCommit: flags.get('--policy') ?? baseCommit, ...(flags.has('--evidence-directory') ? { evidenceDirectory: flags.get('--evidence-directory') } : {}) })
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.status === 'passed' || result.status === 'not_applicable' ? 0 : result.status === 'unsupported' ? 2 : 1
}

function usage(message: string): Error { const error = new Error(message); error.name = 'UsageError'; return error }
