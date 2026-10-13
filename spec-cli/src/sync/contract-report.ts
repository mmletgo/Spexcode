import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  buildContractGraph, contractDigest, contractImpact, gitA, loadSpecs, parseContract,
  projectContractCoverage, validateContractGraph,
  type Contract, type ContractCoverage, type ContractFinding,
} from '@spexcode/spec-core'

export type ContractReport = {
  schemaVersion: 1
  targetTree: string
  contracts: Contract[]
  digest: string
  findings: ContractFinding[]
  coverage: ContractCoverage
  verification: 'not_run'
}

export class ContractReportScopeError extends Error {
  readonly status = 400
}

/** A HTTP caller may inspect only a still-registered worktree in this project. */
export async function readProjectContractReport(projectRoot: string, targetTree?: string): Promise<ContractReport> {
  if (!targetTree) return readContractReport(projectRoot)
  if (!isAbsolute(targetTree) || !existsSync(targetTree))
    throw new ContractReportScopeError('targetTree must identify an existing project worktree')
  const requested = realpathSync(targetTree)
  const registry = await gitA(['-C', projectRoot, 'worktree', 'list', '--porcelain', '-z'])
  const registered = registry.split('\0').filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length))
  if (!registered.some((path) => existsSync(path) && realpathSync(path) === requested))
    throw new ContractReportScopeError('targetTree is not registered in this project')
  const common = async (root: string): Promise<string> => realpathSync((await gitA([
    '-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir',
  ])).trim())
  if (await common(requested) !== await common(projectRoot))
    throw new ContractReportScopeError('targetTree no longer belongs to this project')
  return readContractReport(requested)
}

/** Read authored contracts and real binding files without running any authored command. */
export async function readContractReport(root: string): Promise<ContractReport> {
  const canonicalRoot = realpathSync(root)
  const nodes = await loadSpecs(root, { history: null, drift: null })
  const parsed = nodes.map((node) => parseContract({
    nodeId: node.id,
    path: node.path,
    source: readFileSync(resolve(root, node.path), 'utf8'),
  }))
  const contracts = parsed.flatMap((result) => result.contract ? [result.contract] : [])
  const graph = buildContractGraph(contracts)
  const impact = contractImpact(graph, [...graph.items.keys()])
  const files = new Map<string, string>()
  const findings = parsed.flatMap((result) => result.findings)
  const sourcePaths = [...graph.items.values()].flatMap((item) =>
    item.kind !== 'VERIFY' && item.source.kind === 'code' ? [item.source.ref.split('#')[0]] : [])
  for (const path of new Set([...impact.codePaths, ...impact.testPaths, ...sourcePaths])) {
    const full = resolve(root, path)
    const lexical = relative(resolve(root), full)
    const outside = isAbsolute(path) || lexical === '..' || lexical.startsWith('..' + sep)
    if (outside) continue // The contract validator reports invalid authored paths.
    if (!existsSync(full)) continue // Missing files are reported by the same validator.
    const real = relative(canonicalRoot, realpathSync(full))
    if (real === '..' || real.startsWith('..' + sep) || isAbsolute(real)) {
      findings.push({
        code: 'binding-outside-root', severity: 'error', nodeId: '', path,
        message: 'Contract bindings must resolve inside the current worktree.',
      })
      continue
    }
    if (statSync(full).isFile()) files.set(path, readFileSync(full, 'utf8'))
  }
  findings.push(...validateContractGraph(graph, {
    files, nodeIds: new Set(nodes.map((node) => node.id)),
  }))
  return {
    schemaVersion: 1, targetTree: canonicalRoot, contracts, digest: contractDigest(contracts), findings,
    coverage: projectContractCoverage(graph), verification: 'not_run',
  }
}
