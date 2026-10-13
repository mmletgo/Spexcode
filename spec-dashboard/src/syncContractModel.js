// [[sync-contract-panel]] projects a server report for reading, never a verification verdict.
export function selectContractScope(report, nodeId) {
  const contracts = nodeId === '*' ? report.contracts : report.contracts.filter((item) => item.nodeId === nodeId)
  const items = contracts.flatMap((contract) => contract.items)
  const ids = new Set(items.map((item) => item.id))
  const objects = new Set(items.flatMap((item) => item.object ? [item.object] : []))
  const gaps = report.coverage.gaps.filter((gap) => nodeId === '*' || gap.nodeIds.includes(nodeId) || ids.has(gap.id))
  const gapIds = new Set(gaps.map((gap) => gap.id))
  const byId = new Map(report.contracts.flatMap((contract) => contract.items).map((item) => [item.id, item]))
  return {
    contracts, items, byId, gaps,
    coverage: report.coverage.items.filter((item) => nodeId === '*' || item.nodeId === nodeId),
    matrix: report.coverage.matrix.filter((cell) => nodeId === '*' || objects.has(cell.object)),
    findings: report.findings.filter((finding) => nodeId === '*' || !finding.nodeId || finding.nodeId === nodeId || gapIds.has(finding.itemId)),
  }
}

export function hasContractNode(report, nodeId) {
  return report.contracts.some((contract) => contract.nodeId === nodeId) || report.findings.some((finding) => finding.nodeId === nodeId)
}
