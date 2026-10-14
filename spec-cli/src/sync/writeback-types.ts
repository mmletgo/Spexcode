import type { ElaborationFact, ElaborationTrace } from './elaboration-types.js'
import type { BlobRef } from './operation-types.js'

export type SyncDecisionInput = {
  requestId: string; operationId: string; inputId: string; analysisRef: BlobRef; findingIds: string[]
  decision: { choice: 'keep_intent' | 'adopt_behavior' } | { choice: 'new_rule'; rule: string }
}
export type ContractNodeProposal = { action: 'move'; from: { nodeId: string; path: string }; to: { nodeId: string; path: string } } | { action: 'retire'; from: { nodeId: string; path: string } }
export type ContractNodeChange = ContractNodeProposal & { evidenceRef: BlobRef }
export type AcceptanceChangeProposal = { id: string; action: 'update_acceptance'; source: 'user:raw' | `decision:${string}` | `code:${string}`; reason: string; ruleIds: string[] }
export type CodeBehaviorKind = 'refactor' | 'allowed_change' | 'coverage_gap' | 'conflict'
export type CodeBehaviorChange = {
  id: string; kind: CodeBehaviorKind; paths: string[]; affectedIds: string[]; ruleIds: string[]
  originalIntent: string; previousBehavior: string; sourceBehavior: string; deliveryBehavior: string
  evidence: string; counterexample: string
}
export type CodeBehaviorFinding = {
  id: string; kind: 'coverage_gap' | 'conflict'; affectedIds: string[]; paths: string[]; ruleIds: string[]
  originalIntent: string; sourceBehavior: string; deliveryBehavior: string; evidence: string
  counterexample: string; decision: string
}
export type CodeBehaviorAnalysis = {
  version: 'code-behavior-v1'; inputId: string; baselinePairId: string | null
  composedDigest: string; readSetDigest: string; policyDigest: string; inputDigest: string
  decision?: { requestRef: BlobRef; analysisRef: BlobRef; findingIds: string[] }
  authorChanges?: { nodeId: string; path: string; beforeRaw: string | null; afterRaw: string | null; changedIds: string[] }[]
  changes: CodeBehaviorChange[]; findings: CodeBehaviorFinding[]
  facts: ElaborationFact[]; authorizedChanges: AcceptanceChangeProposal[]; nodeChanges: ContractNodeProposal[]
  newNodes: { nodeId: string; path: string; rawSource: string; codePath: string }[]
  resolutions: { path: string; content: string | null; mode: '100644' | '100755' | '120000' | null }[]
  traces: ElaborationTrace[]; reviewPassed: boolean
}
export type CodeBehaviorEvidence = { ref: BlobRef; analysis: CodeBehaviorAnalysis }
export type GenerationDirection = 'preserve_business' | 'preserve_observed_behavior' | 'repair_to_intent'
