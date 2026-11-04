import { verifyFrozenReadProof, type FrozenContextRef, type FrozenReadProof } from './frozen-context.js'
import { verifyZCodeFrozenReadProof } from './zcode-frozen-evidence.js'
import { StructuredSessionError } from './session-structured-policy.js'

/** 在结构化会话接缝选择原生证明校验器，旧provider仍使用原算法与证据。 */
export function verifyStructuredFrozenReadProof(ref: FrozenContextRef, proof: FrozenReadProof, identity: { threadId: string; turnId: string }, toolOutputTokenLimit?: number, result?: { output: unknown }): void {
  if (proof.version === 4) {
    if (toolOutputTokenLimit !== undefined) throw new StructuredSessionError('stale_result', 'ZCode evidence cannot use a Codex reader runtime')
    verifyZCodeFrozenReadProof(ref, proof, identity, undefined, result)
  } else verifyFrozenReadProof(ref, proof, identity, toolOutputTokenLimit, result)
}
