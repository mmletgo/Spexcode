import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  buildContractGraph, contractDigest, contractImpact, loadSpecs, parseContract,
  projectContractCoverage, validateContractGraph,
  type Contract, type ContractCoverage, type ContractFinding,
} from '@spexcode/spec-core'

export type ContractReport = {
  schemaVersion: 1
  contracts: Contract[]
  digest: string
  findings: ContractFinding[]
  coverage: ContractCoverage
  verification: 'not_run'
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
    schemaVersion: 1, contracts, digest: contractDigest(contracts), findings,
    coverage: projectContractCoverage(graph), verification: 'not_run',
  }
}
