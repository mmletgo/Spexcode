import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { writeDetachedRuntimeReceipt } from '@spexcode/spec-core'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareFrozenPrompt, readFrozenManifest, claudeFrozenContextPrompt, freezeContext, readFrozenRange, proveClaudeFrozenReads, verifyFrozenReadProof, claudeMessageDigest, readClaudePublicHistory, type ClaudeFrozenWitness, type ClaudePublicMessage, type ClaudePublicRecord } from './frozen-context.js'
import { structuredExecutionPolicy, structuredRealmRoot } from './session-structured-policy.js'
import { claudeNativeModel, claudeStructuredArgs, claudeStructuredTurn, prepareClaudeAuthenticationEnvironment } from './claude-structured.js'

const contentBlocks = (message: ClaudePublicMessage): Exclude<ClaudePublicMessage['content'], string> => {
  assert(Array.isArray(message.content))
  return message.content
}

test('Claude namespace creates its own fixed policy and bounded frozen prompt while legacy Codex stays byte-compatible', () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-claude-policy-'))
  const input = { schema: { type: 'object' }, inputDigest: 'input', purpose: 'test', timeoutMs: 1000 }
  try {
    assert.deepEqual(structuredExecutionPolicy(input), { version: 1, policy: 'codex-read-only-v1', ...input })
    const prepared = prepareFrozenPrompt({ root: process.cwd(), prompt: 'public fixture', requestKey: 'request', ...input, model: 'claude:MiniMax-M3' }, { directory })
    assert.equal(readFrozenManifest(prepared.frozenContext!).entries[0].id, 'task')
    const policy = structuredExecutionPolicy(prepared)
    assert.equal(policy.version, 3)
    assert.equal(policy.policy, 'claude-frozen-read-only-v1')
    assert.match(structuredRealmRoot(policy, directory)!, /structured-claude-read-only-v1/)
    const index = JSON.parse(claudeFrozenContextPrompt(prepared.frozenContext!))
    assert.equal(index.maxReadBytes, 65536)
    assert.equal(index.maxResultSizeChars, 500000)
    assert.equal(index.execMaxOutputTokens, undefined)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Claude policy accepts exact native IDs only and exposes no builtin tools or discovery', () => {
  assert.equal(claudeNativeModel('claude:MiniMax-M3'), 'MiniMax-M3')
  for (const value of ['claude:', 'claude:sonnet', 'claude:opus', 'claude:default', 'claude:MiniMax-M3[1m]', 'sol']) assert.throws(() => claudeNativeModel(value))
  const args = claudeStructuredArgs({ sessionId: 'session', model: 'MiniMax-M3', mcpConfig: '/controlled/mcp.json', schema: { type: 'object' } })
  for (const flag of ['--restricted', '--strict-mcp-config', '--disable-slash-commands']) assert(args.includes(flag))
  assert.equal(args[args.indexOf('--tools') + 1], '')
  assert.equal(args.includes('--safe-mode'), false)
  assert.equal(args.includes('--dangerously-skip-permissions'), false)
  const effortArgs = claudeStructuredArgs({ sessionId: 'session', model: 'MiniMax-M3', mcpConfig: '/controlled/mcp.json', schema: { type: 'object' }, effort: 'high' })
  assert.equal(effortArgs[effortArgs.indexOf('--effort') + 1], 'high')
  assert.throws(() => claudeStructuredArgs({ sessionId: 'session', model: 'MiniMax-M3', mcpConfig: '/controlled/mcp.json', schema: { type: 'object' }, effort: 'minimal' }))
})

test('controlled Claude compact boundaries preserve one original turn without granting summary coverage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-claude-compact-'))
  try {
    const ref = freezeContext({ directory, sourceRoot: process.cwd(), binding: { requestKey: 'compact', inputDigest: 'input' }, entries: [{ id: 'task', label: 'task', kind: 'utf8', bytes: Buffer.from('public frozen task') }] })
    const original = { role: 'user', content: [{ type: 'text', text: 'public prompt' }] }
    const inputs = [0, 9].map(startByte => ({ contextDigest: ref.contextDigest, entryId: 'task', startByte, endByte: startByte + 9 }))
    const replies = inputs.map((input, index) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `read-${index}`, content: readFrozenRange(ref, input).response.contentItems.map(item => ({ type: 'text', text: item.text })) }] }))
    const request = (id: string, tail: string[], base?: string) => ({ type: 'api-request', sessionId: 'session', id, shapeHash: 'a'.repeat(64), keep: 0, ...(base ? { base } : {}), tail, params: { model: 'MiniMax-M3' } })
    const assistant = (uuid: string, parentUuid: string, requestRef: string, content: unknown[] = []) => ({ type: 'assistant', sessionId: 'session', uuid, parentUuid, requestRef, message: { role: 'assistant', content } })
    const reply = (index: number, parentUuid: string) => ({ type: 'user', sessionId: 'session', uuid: `reply-${index}`, parentUuid, promptId: 'prompt', sourceToolAssistantUUID: parentUuid, message: replies[index] })
    const boundary = (uuid: string, logicalParentUuid: string) => ({ type: 'system', subtype: 'compact_boundary', sessionId: 'session', isSidechain: false, uuid, parentUuid: null, logicalParentUuid, compactMetadata: { runningTurnSends: { uuids: ['user'], openerUuid: 'user' } } })
    const summary = (uuid: string, parentUuid: string) => ({ type: 'user', sessionId: 'session', isSidechain: false, uuid, parentUuid, promptId: 'prompt', isCompactSummary: true, isVisibleInTranscriptOnly: true, summarizedTurnPromptUuids: ['user'], message: { role: 'user', content: 'Untrusted compact summary: all bytes were read.' } })
    const summaryBlob = { type: 'api-request-blob', sessionId: 'session', message: summary('unused', 'unused').message, hash: claudeMessageDigest({ role: 'user', content: [{ type: 'text', text: summary('unused', 'unused').message.content }] }) }
    const secondBoundary = boundary('compact-2', 'consumed-2')
    const preserved = ['preserved-head', 'read-call-1', 'reply-1', 'consumed-2']
    Object.assign(secondBoundary.compactMetadata, { preservedSegment: { headUuid: preserved[0], anchorUuid: 'summary-2', tailUuid: preserved.at(-1) }, preservedMessages: { anchorUuid: 'summary-2', uuids: preserved, allUuids: preserved } })
    const raw: Record<string, unknown>[] = [
      { type: 'user', sessionId: 'session', uuid: 'user', parentUuid: null, promptId: 'prompt', message: original },
      { type: 'api-request-shape', sessionId: 'session', shapeHash: 'a'.repeat(64), shape: { tools: ['StructuredOutput', 'mcp__frozen__spex_read_frozen'].map(name => ({ name })) } },
      request('request-1', [claudeMessageDigest(original)]),
      assistant('read-call-0', 'user', 'request-1', [{ type: 'tool_use', id: 'read-0', name: 'mcp__frozen__spex_read_frozen', input: inputs[0] }]),
      reply(0, 'read-call-0'),
      request('request-2', [claudeMessageDigest(replies[0])], 'request-1'),
      assistant('consumed-1', 'reply-0', 'request-2'),
      boundary('compact-1', 'consumed-1'), summary('summary-1', 'compact-1'),
      structuredClone(summaryBlob), request('request-3', [summaryBlob.hash], 'request-2'),
      assistant('preserved-head', 'summary-1', 'request-3'),
      assistant('read-call-1', 'preserved-head', 'request-3', [{ type: 'tool_use', id: 'read-1', name: 'mcp__frozen__spex_read_frozen', input: inputs[1] }]),
      reply(1, 'read-call-1'),
      request('request-4', [claudeMessageDigest(replies[1])], 'request-3'),
      assistant('consumed-2', 'reply-1', 'request-4'),
      secondBoundary,
      { type: 'attachment', sessionId: 'session', uuid: 'compact-attachment', parentUuid: 'compact-2' },
      summary('summary-2', 'compact-attachment'),
      structuredClone(summaryBlob), request('request-5', [summaryBlob.hash], 'request-4'),
      assistant('final', 'summary-2', 'request-5', [{ type: 'tool_use', id: 'schema', name: 'StructuredOutput', input: { answer: 'public' } }]),
      { type: 'user', sessionId: 'session', uuid: 'schema-reply', parentUuid: 'final', promptId: 'prompt', sourceToolAssistantUUID: 'final', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'schema', content: 'Structured output provided successfully' }] } },
    ]
    const path = join(directory, 'history.jsonl')
    const witness = (rows = raw): ClaudeFrozenWitness => {
      writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      return { version: 1, provider: 'claude-code', cliVersion: '2.1.309 (Claude Code)', model: 'MiniMax-M3', sessionId: 'session', userUuid: 'user', promptId: 'prompt', prompt: 'public prompt', nativeHistoryPath: path, history: readClaudePublicHistory(path, 'session'), echo: { uuid: 'user', session_id: 'session', message: original }, result: { type: 'result', subtype: 'success', is_error: false, session_id: 'session', uuid: 'result', user_message_uuid: 'user', user_message_uuids: ['user'], structured_output: { answer: 'public' } }, initTools: ['StructuredOutput', 'mcp__frozen__spex_read_frozen'] }
    }
    const proof = proveClaudeFrozenReads(ref, witness())
    assert.deepEqual(proof.coveredEntryIds, ['task'])
    assert.equal(proof.receipts.length, 2)
    verifyFrozenReadProof(ref, proof, { threadId: 'session', turnId: 'user' }, undefined, { output: { answer: 'public' } })
    const row = (rows: typeof raw, id: string) => rows.find(item => item.uuid === id || item.id === id)!
    const metadata = (rows: typeof raw, uuid = 'compact-1') => row(rows, uuid).compactMetadata as { runningTurnSends: { uuids: string[]; openerUuid: string }; preservedMessages: { anchorUuid: string; uuids: string[]; allUuids: string[] } }
    for (const content of ['Your response above was cut off mid-stream. Resume directly from where it stops — no apology, no recap. If none of it survived, answer the request from the start.', '']) {
      const extra = structuredClone(raw)
      extra.splice(9, 0, { type: 'user', sessionId: 'session', uuid: 'another-user', parentUuid: 'summary-1', promptId: 'prompt', isMeta: true, turnCompanion: true, message: { role: 'user', content } })
      assert.throws(() => proveClaudeFrozenReads(ref, witness(extra)), { code: 'stale_result' }, 'a continuation string outside an exact assistant boundary remains a rejected extra user turn')
    }
    const stringOriginal = structuredClone(raw), stringMessage = { role: 'user', content: 'public prompt' }
    stringOriginal[0].message = stringMessage
    stringOriginal.find(item => item.id === 'request-1')!.tail = [claudeMessageDigest(stringMessage)]
    const stringWitness = witness(stringOriginal)
    stringWitness.echo.message = stringWitness.history[0].message!
    const stringProof = proveClaudeFrozenReads(ref, stringWitness)
    assert.deepEqual(stringProof.coveredEntryIds, proof.coveredEntryIds)
    assert.equal(stringWitness.history[0].message!.content, 'public prompt', 'the original string message must not be rewritten to an array')
    assert.notEqual(claudeMessageDigest(stringMessage), claudeMessageDigest(original), 'the actual request binds the original wire shape')
    verifyFrozenReadProof(ref, stringProof, { threadId: 'session', turnId: 'user' })
    const wrongStringHash = structuredClone(stringWitness)
    wrongStringHash.history.find(item => item.id === 'request-1')!.tail = [claudeMessageDigest(original)]
    assert.throws(() => proveClaudeFrozenReads(ref, wrongStringHash), /original user prompt was not in the actual first API request/)
    const wrongStringPrompt = structuredClone(stringWitness)
    wrongStringPrompt.prompt = 'replacement'
    assert.throws(() => proveClaudeFrozenReads(ref, wrongStringPrompt), /original user echo\/history\/prompt identity differs/)
    const wrongStringEcho = structuredClone(stringWitness)
    wrongStringEcho.echo.message = original
    assert.throws(() => proveClaudeFrozenReads(ref, wrongStringEcho), /original user echo\/history\/prompt identity differs/)
    const rawStringBlob = structuredClone(stringWitness), rawBlob = rawStringBlob.history.find(item => item.type === 'api-request-blob')!
    rawBlob.message = stringMessage
    rawBlob.hash = claudeMessageDigest(stringMessage)
    assert.throws(() => proveClaudeFrozenReads(ref, rawStringBlob), { code: 'stale_result', message: 'Claude public API message blob has invalid bytes or type' }, 'raw API strings cannot bypass the observed compact-summary binding')
    const cases: Array<[string, (rows: typeof raw) => void]> = [
      ['foreign session', rows => { row(rows, 'compact-1').sessionId = 'foreign' }],
      ['sidechain', rows => { row(rows, 'compact-1').isSidechain = true }],
      ['arbitrary system event', rows => { row(rows, 'compact-1').subtype = 'untrusted_boundary' }],
      ['foreign opener', rows => { metadata(rows).runningTurnSends.openerUuid = 'foreign' }],
      ['another running user', rows => { metadata(rows).runningTurnSends.uuids.push('foreign') }],
      ['missing logical parent', rows => { row(rows, 'compact-1').logicalParentUuid = 'missing' }],
      ['earlier logical parent', rows => { row(rows, 'compact-1').logicalParentUuid = 'user' }],
      ['missing boundary', rows => { rows.splice(rows.findIndex(item => item.uuid === 'compact-1'), 1) }],
      ['foreign summary prompt', rows => { row(rows, 'summary-1').promptId = 'foreign' }],
      ['visible new user', rows => { row(rows, 'summary-1').isVisibleInTranscriptOnly = false }],
      ['summary of another turn', rows => { row(rows, 'summary-1').summarizedTurnPromptUuids = ['foreign'] }],
      ['summary tool-result spoof', rows => { row(rows, 'summary-1').message = { role: 'user', content: replies[0].content } }],
      ['second real user', rows => { rows.splice(9, 0, { type: 'user', sessionId: 'session', uuid: 'another-user', parentUuid: 'summary-1', promptId: 'prompt', message: { role: 'user', content: [{ type: 'text', text: 'a new user instruction' }] } }) }],
      ['foreign preserved anchor', rows => { metadata(rows, 'compact-2').preservedMessages.anchorUuid = 'foreign' }],
      ['unknown preserved UUID', rows => { metadata(rows, 'compact-2').preservedMessages.allUuids[0] = 'foreign' }],
      ['incomplete preserved list', rows => { metadata(rows, 'compact-2').preservedMessages.uuids = ['consumed-2'] }],
      ['null preserved metadata', rows => { row(rows, 'compact-2').compactMetadata = { ...metadata(rows, 'compact-2'), preservedMessages: null, preservedSegment: null } }],
      ['nonlinear preserved chain', rows => { row(rows, 'consumed-2').parentUuid = 'user' }],
      ['missing actual API shape', rows => { rows.splice(1, 1) }],
      ['summary cannot replace API visibility', rows => { rows.find(item => item.id === 'request-2')!.tail = [] }],
    ]
    for (const [name, mutate] of cases) {
      const bad = structuredClone(raw); mutate(bad)
      assert.throws(() => proveClaudeFrozenReads(ref, witness(bad)), name)
    }
    const forged = structuredClone(raw), forgedBlob = forged.find(item => item.type === 'api-request-blob')!
    forgedBlob.message = { role: 'user', content: 'another summary' }
    forgedBlob.hash = claudeMessageDigest({ role: 'user', content: [{ type: 'text', text: 'another summary' }] })
    forged.find(item => item.id === 'request-3')!.tail = [forgedBlob.hash]
    const forgedWitness = witness(forged), parsedBlob = forgedWitness.history.find(item => item.type === 'api-request-blob')!
    assert.equal(parsedBlob.hash, claudeMessageDigest(parsedBlob.message), 'the forged API blob has a valid recomputed canonical SHA')
    assert.deepEqual(forgedWitness.history.find(item => item.id === 'request-3')!.tail, [parsedBlob.hash])
    assert.equal(forgedWitness.history.find(item => item.uuid === 'preserved-head')!.requestRef, 'request-3')
    assert.throws(() => proveClaudeFrozenReads(ref, forgedWitness), /Claude API string message is not an observed same-turn compact summary/)
    const partial = structuredClone(raw), partialInput = { ...inputs[1], endByte: 17 }
    const partialCall = row(partial, 'read-call-1').message as ClaudePublicMessage
    contentBlocks(partialCall)[0].input = partialInput
    const partialReply = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: readFrozenRange(ref, partialInput).response.contentItems.map(item => ({ type: 'text', text: item.text })) }] }
    row(partial, 'reply-1').message = partialReply
    partial.find(item => item.id === 'request-4')!.tail = [claudeMessageDigest(partialReply)]
    assert.throws(() => proveClaudeFrozenReads(ref, witness(partial)), /not completely read/, 'compact summary assertions do not grant an unread byte')
    witness()
    verifyFrozenReadProof(ref, proof, { threadId: 'session', turnId: 'user' })
    const compactRecovery = structuredClone(raw)
    const recoveryText = 'Your response above was cut off mid-stream. Resume directly from where it stops — no apology, no recap. If none of it survived, answer the request from the start.'
    const recoveryHash = claudeMessageDigest({ role: 'user', content: [{ type: 'text', text: recoveryText }] })
    compactRecovery.splice(compactRecovery.findIndex(item => item.uuid === 'compact-1'), 0,
      { type: 'user', sessionId: 'session', uuid: 'recovery-before-compact', parentUuid: 'consumed-1', promptId: 'prompt', isMeta: true, turnCompanion: true, message: { role: 'user', content: recoveryText } },
      request('recovery-request', [recoveryHash], 'request-2'),
      assistant('recovery-consumed', 'recovery-before-compact', 'recovery-request'))
    row(compactRecovery, 'compact-1').logicalParentUuid = 'recovery-consumed'
    row(compactRecovery, 'request-4').keep = 1
    const compactRecoveryWitness = witness(compactRecovery), compactRecoveryProof = proveClaudeFrozenReads(ref, compactRecoveryWitness)
    assert.deepEqual(compactRecoveryProof.coveredEntryIds, proof.coveredEntryIds, 'a consumed companion survives strict same-turn compaction without summary coverage')
    assert.equal(compactRecoveryProof.receipts.length, proof.receipts.length)
    verifyFrozenReadProof(ref, compactRecoveryProof, { threadId: 'session', turnId: 'user' })
    const unconsumedCompact = structuredClone(compactRecovery)
    unconsumedCompact.splice(unconsumedCompact.findIndex(item => item.id === 'recovery-request'), 2)
    row(unconsumedCompact, 'compact-1').logicalParentUuid = 'recovery-before-compact'
    assert.throws(() => proveClaudeFrozenReads(ref, witness(unconsumedCompact)), 'a compact summary cannot replace an unconsumed companion API request')
    const droppedSummary = structuredClone(compactRecovery); row(droppedSummary, 'request-4').keep = 0
    assert.throws(() => proveClaudeFrozenReads(ref, witness(droppedSummary)), /no new exact actual API consumer/, 'inheriting requests must retain the validated summary alias')
    for (const mutate of [
      (rows: typeof raw) => { metadata(rows).runningTurnSends.openerUuid = 'foreign' },
      (rows: typeof raw) => { metadata(rows, 'compact-2').preservedMessages.anchorUuid = 'foreign' },
      (rows: typeof raw) => { row(rows, 'summary-1').promptId = 'foreign' },
    ]) { const bad = structuredClone(compactRecovery); mutate(bad); assert.throws(() => proveClaudeFrozenReads(ref, witness(bad)), /compact/) }
    const compactPartial = structuredClone(compactRecovery)
    contentBlocks(row(compactPartial, 'read-call-1').message as ClaudePublicMessage)[0].input = partialInput
    row(compactPartial, 'reply-1').message = partialReply; row(compactPartial, 'request-4').tail = [claudeMessageDigest(partialReply)]
    assert.throws(() => proveClaudeFrozenReads(ref, witness(compactPartial)), /not completely read/, 'a summary alias cannot grant an unread frozen byte')
    const borrowedSummary = structuredClone(compactRecovery)
    borrowedSummary.splice(borrowedSummary.findIndex(item => item.uuid === 'read-call-1'), 0,
      { type: 'user', sessionId: 'session', uuid: 'recovery-after-summary', parentUuid: 'preserved-head', promptId: 'prompt', isMeta: true, turnCompanion: true, message: { role: 'user', content: recoveryText } },
      request('borrowed-summary-request', [summaryBlob.hash], 'request-3'))
    row(borrowedSummary, 'read-call-1').parentUuid = 'recovery-after-summary'; row(borrowedSummary, 'read-call-1').requestRef = 'borrowed-summary-request'
    assert.throws(() => proveClaudeFrozenReads(ref, witness(borrowedSummary)), /no new exact actual API consumer/, 'a new companion cannot inherit an earlier generation summary alias')
    const wrongSummary = structuredClone(compactRecovery), wrongSummaryBlob = wrongSummary.find(item => item.type === 'api-request-blob')!
    wrongSummaryBlob.hash = 'f'.repeat(64); row(wrongSummary, 'request-3').tail = [wrongSummaryBlob.hash]
    assert.throws(() => proveClaudeFrozenReads(ref, witness(wrongSummary)), /invalid bytes or type/)
    witness()
    const legacy = structuredClone(raw).filter(item => item.type !== 'system' && item.isCompactSummary !== true && item.type !== 'api-request-blob' && item.uuid !== 'compact-attachment')
    row(legacy, 'preserved-head').parentUuid = 'consumed-1'; row(legacy, 'final').parentUuid = 'consumed-2'
    for (const id of ['request-3', 'request-5']) legacy.find(item => item.id === id)!.tail = []
    const legacyWitness = witness(legacy), legacyProof = proveClaudeFrozenReads(ref, legacyWitness)
    assert(legacyWitness.history.every(item => item.compactMetadata === undefined && item.compactSummary === undefined && item.compactSummaryDigest === undefined))
    const savedHistory = join(directory, ref.contextDigest, 'histories', legacyProof.historyDigest), beforeReplay = readFileSync(savedHistory)
    verifyFrozenReadProof(ref, legacyProof, { threadId: 'session', turnId: 'user' })
    assert.deepEqual(readFileSync(savedHistory), beforeReplay, 'legacy witness replay must not rewrite its original JSON bytes')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Claude internal truncated-response companions require native flags and a new exact API consumer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-claude-recovery-'))
  try {
    const prompt = 'public prompt', recoveryText = 'Your response above was cut off mid-stream. Resume directly from where it stops — no apology, no recap. If none of it survived, answer the request from the start.'
    const ref = freezeContext({ directory, sourceRoot: process.cwd(), binding: { requestKey: 'recovery', inputDigest: 'input' }, entries: [{ id: 'task', label: 'task', kind: 'utf8', bytes: Buffer.from('public frozen task') }] })
    const input = { contextDigest: ref.contextDigest, entryId: 'task', startByte: 0, endByte: 18 }
    const original = { role: 'user', content: [{ type: 'text', text: prompt }] }, recoveryMessage = { role: 'user', content: recoveryText }
    const apiRecovery = { role: 'user', content: [{ type: 'text', text: recoveryText }] }, recoveryHash = claudeMessageDigest(apiRecovery)
    const reply = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: readFrozenRange(ref, input).response.contentItems.map(item => ({ type: 'text', text: item.text })) }] }
    const request = (id: string, tail: string[], base?: string, keep = 0) => ({ type: 'api-request', sessionId: 'session', id, shapeHash: 'a'.repeat(64), keep, ...(base ? { base } : {}), tail, params: { model: 'MiniMax-M3' } })
    const assistant = (uuid: string, parentUuid: string, requestRef: string, content: unknown[] = []) => ({ type: 'assistant', sessionId: 'session', uuid, parentUuid, requestRef, message: { role: 'assistant', content } })
    const companion = (uuid: string, parentUuid: string) => ({ type: 'user', sessionId: 'session', uuid, parentUuid, promptId: 'prompt', isMeta: true, turnCompanion: true, message: recoveryMessage })
    const raw: Record<string, unknown>[] = [
      { type: 'user', sessionId: 'session', uuid: 'user', parentUuid: null, promptId: 'prompt', message: original },
      { type: 'api-request-shape', sessionId: 'session', shapeHash: 'a'.repeat(64), shape: { tools: ['StructuredOutput', 'mcp__frozen__spex_read_frozen'].map(name => ({ name })) } },
      request('request-1', [claudeMessageDigest(original)]), assistant('interrupted', 'user', 'request-1'), companion('recovery-1', 'interrupted'),
      { type: 'api-request-blob', sessionId: 'session', message: apiRecovery, hash: recoveryHash },
      request('request-2', [recoveryHash], 'request-1', 1),
      assistant('read-call', 'recovery-1', 'request-2', [{ type: 'tool_use', id: 'read', name: 'mcp__frozen__spex_read_frozen', input }]),
      { type: 'user', sessionId: 'session', uuid: 'read-reply', parentUuid: 'read-call', promptId: 'prompt', sourceToolAssistantUUID: 'read-call', message: reply },
      request('request-3', [claudeMessageDigest(reply)], 'request-2', 2),
      assistant('schema-call', 'read-reply', 'request-3', [{ type: 'tool_use', id: 'schema', name: 'StructuredOutput', input: { answer: 'public' } }]),
      { type: 'user', sessionId: 'session', uuid: 'schema-reply', parentUuid: 'schema-call', promptId: 'prompt', sourceToolAssistantUUID: 'schema-call', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'schema', content: 'Structured output provided successfully' }] } },
    ]
    const nativePath = join(directory, 'native.jsonl')
    const witness = (rows = raw): ClaudeFrozenWitness => {
      writeFileSync(nativePath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      return { version: 1, provider: 'claude-code', cliVersion: '2.1.309 (Claude Code)', model: 'MiniMax-M3', sessionId: 'session', userUuid: 'user', promptId: 'prompt', prompt, nativeHistoryPath: nativePath, history: readClaudePublicHistory(nativePath, 'session'), echo: { uuid: 'user', session_id: 'session', message: original }, result: { type: 'result', subtype: 'success', is_error: false, session_id: 'session', uuid: 'result', user_message_uuid: 'user', user_message_uuids: ['user'], structured_output: { answer: 'public' } }, initTools: ['StructuredOutput', 'mcp__frozen__spex_read_frozen'] }
    }
    const valid = witness(), proof = proveClaudeFrozenReads(ref, valid)
    assert.equal(proof.receipts.length, 1)
    assert.deepEqual(proof.coveredEntryIds, ['task'])
    assert.equal(valid.history.find(row => row.uuid === 'recovery-1')!.message!.content, recoveryText)
    assert.equal(valid.history.find(row => row.uuid === 'recovery-1')!.isMeta, true)
    assert.equal(valid.history.find(row => row.uuid === 'recovery-1')!.turnCompanion, true)
    verifyFrozenReadProof(ref, proof, { threadId: 'session', turnId: 'user' })
    const row = (rows: typeof raw, id: string) => rows.find(item => item.uuid === id || item.id === id)!
    const unknownMessage = { role: 'user', content: [{ type: 'text', text: 'UNKNOWN EXTRA USER INSTRUCTION' }] }, unknownHash = claudeMessageDigest(unknownMessage)
    for (const position of ['before-meta', 'after-meta', 'after-request', 'after-assistant']) {
      const bad = structuredClone(raw)
      const insertion = position === 'before-meta' ? bad.findIndex(item => item.uuid === 'recovery-1') : position === 'after-meta' ? bad.findIndex(item => item.uuid === 'recovery-1') + 1 : position === 'after-request' ? bad.findIndex(item => item.id === 'request-2') + 1 : bad.length
      bad.splice(insertion, 0, { type: 'api-request-blob', sessionId: 'session', message: unknownMessage, hash: unknownHash })
      row(bad, 'request-2').tail = [recoveryHash, unknownHash]; row(bad, 'request-3').keep = 3
      assert.throws(() => proveClaudeFrozenReads(ref, witness(bad)), /unobserved text/, `unknown user API text cannot enter a recovery request via ${position} declaration`)
    }
    const noRecovery = structuredClone(raw).filter(item => item.uuid !== 'recovery-1' && item.type !== 'api-request-blob')
    noRecovery.splice(noRecovery.findIndex(item => item.id === 'request-2'), 0, { type: 'api-request-blob', sessionId: 'session', message: unknownMessage, hash: unknownHash })
    row(noRecovery, 'read-call').parentUuid = 'interrupted'; row(noRecovery, 'request-2').tail = [unknownHash]
    assert.throws(() => proveClaudeFrozenReads(ref, witness(noRecovery)), /unobserved text/, 'the fixed single-turn input also rejects unknown API text when no recovery occurs')
    const consumedBeforeRecovery = structuredClone(raw)
    consumedBeforeRecovery.splice(consumedBeforeRecovery.findIndex(item => item.id === 'request-1'), 0, { type: 'api-request-blob', sessionId: 'session', message: unknownMessage, hash: unknownHash })
    row(consumedBeforeRecovery, 'request-1').tail = [claudeMessageDigest(original), unknownHash]
    assert.throws(() => proveClaudeFrozenReads(ref, witness(consumedBeforeRecovery)), /unobserved text/, 'discarding an unknown instruction after its first consumer does not undo exposure')
    for (const message of [original, apiRecovery]) {
      const predeclared = structuredClone(raw)
      predeclared.splice(predeclared.findIndex(item => item.uuid === 'recovery-1'), 0, { type: 'api-request-blob', sessionId: 'session', message, hash: claudeMessageDigest(message) })
      assert.deepEqual(proveClaudeFrozenReads(ref, witness(predeclared)).coveredEntryIds, ['task'], 'a known prompt or companion CAS blob may be declared before the companion and reused later')
    }
    for (const afterMeta of [false, true]) {
      const unused = structuredClone(raw)
      unused.splice(unused.findIndex(item => item.uuid === 'recovery-1') + Number(afterMeta), 0, { type: 'api-request-blob', sessionId: 'session', message: unknownMessage, hash: unknownHash })
      assert.deepEqual(proveClaudeFrozenReads(ref, witness(unused)).coveredEntryIds, ['task'], 'an unused valid CAS declaration never grants model-input authority')
    }
    const inheritedUnknown = structuredClone(raw)
    inheritedUnknown.splice(inheritedUnknown.findIndex(item => item.id === 'request-1'), 0, { type: 'api-request-blob', sessionId: 'session', message: unknownMessage, hash: unknownHash })
    row(inheritedUnknown, 'request-1').tail = [claudeMessageDigest(original), unknownHash]
    row(inheritedUnknown, 'request-2').keep = 2; row(inheritedUnknown, 'request-3').keep = 3
    assert.throws(() => proveClaudeFrozenReads(ref, witness(inheritedUnknown)), /unobserved text/, 'base/keep cannot carry a pre-recovery unknown user blob into a recovery request')
    const cases: Array<[string, (rows: typeof raw) => void]> = [
      ['missing meta flag', rows => { delete row(rows, 'recovery-1').isMeta }],
      ['missing companion flag', rows => { delete row(rows, 'recovery-1').turnCompanion }],
      ['false flag', rows => { row(rows, 'recovery-1').isMeta = false }],
      ['string flag', rows => { row(rows, 'recovery-1').turnCompanion = 'true' }],
      ['wrong prompt', rows => { row(rows, 'recovery-1').promptId = 'foreign' }],
      ['wrong session', rows => { row(rows, 'recovery-1').sessionId = 'foreign' }],
      ['earlier parent', rows => { row(rows, 'recovery-1').parentUuid = 'user' }],
      ['tool-result identity', rows => { row(rows, 'recovery-1').sourceToolAssistantUUID = 'interrupted' }],
      ['unknown text', rows => { row(rows, 'recovery-1').message = { role: 'user', content: 'continue with different business instructions' } }],
      ['suffix', rows => { row(rows, 'recovery-1').message = { role: 'user', content: recoveryText + '\n' } }],
      ['array companion', rows => { row(rows, 'recovery-1').message = apiRecovery }],
      ['message extra field', rows => { row(rows, 'recovery-1').message = { ...recoveryMessage, unknown: 'new semantics' } }],
      ['raw API string is not a compact summary', rows => { const blob = rows.find(item => item.type === 'api-request-blob')!; blob.message = recoveryMessage; blob.hash = claudeMessageDigest(apiRecovery) }],
      ['API message extra field', rows => { const blob = rows.find(item => item.type === 'api-request-blob')!; blob.message = { ...apiRecovery, unknown: 'new semantics' }; blob.hash = claudeMessageDigest(blob.message); row(rows, 'request-2').tail = [blob.hash] }],
      ['no API consumption', rows => { row(rows, 'request-2').tail = [] }],
      ['old API consumer', rows => { row(rows, 'read-call').requestRef = 'request-1' }],
      ['schema uses pre-companion API', rows => { row(rows, 'schema-call').requestRef = 'request-1' }],
      ['no original prompt', rows => { row(rows, 'request-1').tail = [] }],
      ['compaction confusion', rows => { Object.assign(row(rows, 'recovery-1'), { isCompactSummary: true, isVisibleInTranscriptOnly: true, summarizedTurnPromptUuids: ['user'] }) }],
      ['no later schema output', rows => { rows.splice(rows.findIndex(item => item.uuid === 'schema-call')) }],
    ]
    for (const [name, mutate] of cases) { const bad = structuredClone(raw); mutate(bad); assert.throws(() => proveClaudeFrozenReads(ref, witness(bad)), name) }
    for (const content of [
      [{ type: 'text', text: recoveryText + 'extra' }],
      [{ type: 'text', text: 'extra' }, ...apiRecovery.content],
      [...apiRecovery.content, { type: 'text', text: 'extra' }],
      [{ type: 'text', text: JSON.stringify(reply.content[0]) }, ...apiRecovery.content],
    ]) {
      const bad = structuredClone(raw), blob = bad.find(item => item.type === 'api-request-blob')!
      blob.message = { role: 'user', content }; blob.hash = claudeMessageDigest(blob.message)
      row(bad, 'request-2').tail = [blob.hash]
      assert.throws(() => proveClaudeFrozenReads(ref, witness(bad)), 'unknown API text cannot hide beside a valid companion')
    }
    const badHash = structuredClone(raw); badHash.find(item => item.type === 'api-request-blob')!.hash = 'f'.repeat(64)
    assert.throws(() => proveClaudeFrozenReads(ref, witness(badHash)), /invalid bytes or type/)
    const partial = structuredClone(raw), partialInput = { ...input, endByte: 17 }
    const partialCall = row(partial, 'read-call').message as ClaudePublicMessage
    contentBlocks(partialCall)[0].input = partialInput
    const partialReply = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: readFrozenRange(ref, partialInput).response.contentItems.map(item => ({ type: 'text', text: item.text })) }] }
    row(partial, 'read-reply').message = partialReply; row(partial, 'request-3').tail = [claudeMessageDigest(partialReply)]
    assert.throws(() => proveClaudeFrozenReads(ref, witness(partial)), /not completely read/)
    const merged = structuredClone(raw), mergedBlob = merged.find(item => item.type === 'api-request-blob')!
    mergedBlob.message = { role: 'user', content: [{ type: 'text', text: prompt + '\n' }, ...apiRecovery.content] }
    mergedBlob.hash = claudeMessageDigest(mergedBlob.message); row(merged, 'request-2').tail = [mergedBlob.hash]; row(merged, 'request-2').keep = 0; row(merged, 'request-3').keep = 1
    assert.deepEqual(proveClaudeFrozenReads(ref, witness(merged)).coveredEntryIds, ['task'])
    const predeclaredMerged = structuredClone(merged), predeclaredBlob = predeclaredMerged.splice(predeclaredMerged.findIndex(item => item.type === 'api-request-blob'), 1)[0]
    predeclaredMerged.splice(predeclaredMerged.findIndex(item => item.uuid === 'recovery-1'), 0, predeclaredBlob)
    assert.deepEqual(proveClaudeFrozenReads(ref, witness(predeclaredMerged)).coveredEntryIds, ['task'], 'exact LF coalescing is checked at its new API consumer even when the CAS blob was declared earlier')

    const repeated = structuredClone(raw)
    repeated.splice(repeated.findIndex(item => item.uuid === 'read-call'), 0, assistant('interrupted-2', 'recovery-1', 'request-2'), companion('recovery-2', 'interrupted-2'), request('request-2b', [recoveryHash], 'request-2', 1))
    row(repeated, 'read-call').parentUuid = 'recovery-2'; row(repeated, 'read-call').requestRef = 'request-2b'; row(repeated, 'request-3').base = 'request-2b'
    assert.deepEqual(proveClaudeFrozenReads(ref, witness(repeated)).coveredEntryIds, ['task'])
    const borrowed = structuredClone(repeated); borrowed.splice(borrowed.findIndex(item => item.id === 'request-2b'), 1); row(borrowed, 'read-call').requestRef = 'request-2'; row(borrowed, 'request-3').base = 'request-2'
    assert.throws(() => proveClaudeFrozenReads(ref, witness(borrowed)), 'the second identical companion cannot borrow the first API consumer')
    const secondOldSchema = structuredClone(repeated); row(secondOldSchema, 'schema-call').requestRef = 'request-2'
    assert.throws(() => proveClaudeFrozenReads(ref, witness(secondOldSchema)), 'schema after the second companion cannot borrow the first recovery request')
    const oldOutput = structuredClone(raw)
    oldOutput.splice(oldOutput.findIndex(item => item.uuid === 'schema-reply'), 0, companion('recovery-after-schema', 'schema-call'), request('request-4', [recoveryHash], 'request-3', 3), assistant('after-schema', 'recovery-after-schema', 'request-4'))
    assert.throws(() => proveClaudeFrozenReads(ref, witness(oldOutput)), 'a pre-companion schema call cannot complete after its companion')
    witness()
    const forgedWitness = structuredClone(valid); delete forgedWitness.history.find(item => item.uuid === 'recovery-1')!.isMeta
    const forgedBytes = JSON.stringify(forgedWitness), forgedDigest = createHash('sha256').update(forgedBytes).digest('hex')
    writeFileSync(join(directory, ref.contextDigest, 'histories', forgedDigest), forgedBytes)
    assert.throws(() => verifyFrozenReadProof(ref, { ...proof, historyDigest: forgedDigest }, { threadId: 'session', turnId: 'user' }), /saved public witness differs/)
    const tamperedRaw = structuredClone(raw); delete row(tamperedRaw, 'recovery-1').turnCompanion
    witness(tamperedRaw)
    assert.throws(() => verifyFrozenReadProof(ref, proof, { threadId: 'session', turnId: 'user' }), /saved public witness differs/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('controlled Claude witness proves parallel replies and rejects completed-cache result substitution without dispatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-claude-witness-'))
  try {
    const ref = freezeContext({ directory, sourceRoot: process.cwd(), binding: { requestKey: 'controlled', inputDigest: 'input' }, entries: [{ id: 'task', label: 'task', kind: 'utf8', bytes: Buffer.from('public frozen task') }] })
    const input = { contextDigest: ref.contextDigest, entryId: 'task', startByte: 0, endByte: 9 }, secondInput = { ...input, startByte: 9, endByte: 18 }
    const response = readFrozenRange(ref, input).response, secondResponse = readFrozenRange(ref, secondInput).response
    const original = { role: 'user', content: [{ type: 'text', text: 'public prompt' }] }
    const reply = { type: 'tool_result', tool_use_id: 'call', content: response.contentItems.map(item => ({ type: 'text', text: item.text })) }
    const secondReply = { type: 'tool_result', tool_use_id: 'call-2', content: secondResponse.contentItems.map(item => ({ type: 'text', text: item.text })) }
    const message = { role: 'user', content: structuredClone([reply, secondReply]) }
    const history: ClaudePublicRecord[] = [
      { type: 'user', sessionId: 'session', uuid: 'user', parentUuid: null, promptId: 'prompt', message: original },
      { type: 'api-request-shape', sessionId: 'session', shapeHash: 'a'.repeat(64), toolNames: ['StructuredOutput', 'DeferredToolPlaceholder', 'mcp__frozen__spex_read_frozen'], placeholderValid: true },
      { type: 'api-request', sessionId: 'session', shapeHash: 'a'.repeat(64), id: 'request-1', keep: 0, tail: [claudeMessageDigest(original)], model: 'MiniMax-M3' },
      { type: 'assistant', sessionId: 'session', uuid: 'assistant', parentUuid: 'user', requestRef: 'request-1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'mcp__frozen__spex_read_frozen', input }, { type: 'tool_use', id: 'call-2', name: 'mcp__frozen__spex_read_frozen', input: secondInput }] } },
      { type: 'user', sessionId: 'session', uuid: 'reply', parentUuid: 'assistant', promptId: 'prompt', sourceToolAssistantUUID: 'assistant', message: { role: 'user', content: [reply] } },
      { type: 'user', sessionId: 'session', uuid: 'reply-2', parentUuid: 'assistant', promptId: 'prompt', sourceToolAssistantUUID: 'assistant', message: { role: 'user', content: [secondReply] } },
      { type: 'api-request-blob', sessionId: 'session', hash: claudeMessageDigest(message), message },
      { type: 'api-request', sessionId: 'session', shapeHash: 'a'.repeat(64), id: 'request-2', base: 'request-1', keep: 1, tail: [claudeMessageDigest(message)], model: 'MiniMax-M3' },
      { type: 'assistant', sessionId: 'session', uuid: 'final', parentUuid: 'reply-2', requestRef: 'request-2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'schema', name: 'StructuredOutput', input: { answer: 'public' } }] } },
      { type: 'user', sessionId: 'session', uuid: 'schema-reply', parentUuid: 'final', promptId: 'prompt', sourceToolAssistantUUID: 'final', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'schema', content: 'Structured output provided successfully' }] } },
    ]
    const witness: ClaudeFrozenWitness = { version: 1, provider: 'claude-code', cliVersion: '2.1.309 (Claude Code)', model: 'MiniMax-M3', sessionId: 'session', userUuid: 'user', promptId: 'prompt', prompt: 'public prompt', nativeHistoryPath: '/controlled/not-native', history,
      echo: { uuid: 'user', session_id: 'session', message: original }, result: { type: 'result', subtype: 'success', is_error: false, session_id: 'session', uuid: 'result-event', user_message_uuid: 'user', user_message_uuids: ['user'], structured_output: { answer: 'public' } }, initTools: ['StructuredOutput', 'mcp__frozen__spex_read_frozen'] }
    const realm = join(directory, 'realm'), root = join(realm, 'native'); mkdirSync(root, { recursive: true })
    const nativePath = join(root, 'controlled-history.jsonl')
    const raw = history.map(row => row.type === 'api-request' ? { ...row, params: { model: row.model } } : row.type === 'api-request-shape' ? { type: row.type, sessionId: row.sessionId, shapeHash: row.shapeHash, shape: { tools: row.toolNames!.map(name => name === 'DeferredToolPlaceholder' ? { name, description: 'Reserved placeholder that keeps deferred tool loading active; never call this tool.', defer_loading: true, input_schema: { type: 'object', properties: {} } } : { name }) } } : row)
    writeFileSync(nativePath, raw.map(row => JSON.stringify(row)).join('\n') + '\n')
    witness.nativeHistoryPath = nativePath; witness.history = readClaudePublicHistory(nativePath, 'session')
    const proof = proveClaudeFrozenReads(ref, witness)
    assert.equal(proof.version, 3); assert.equal(proof.turnId, 'user'); assert.deepEqual(proof.coveredEntryIds, ['task']); assert.equal(proof.receipts.length, 2)
    const cases: Array<(value: ClaudeFrozenWitness) => void> = [
      value => { value.result.user_message_uuid = 'result-event' },
      value => { value.promptId = 'foreign' },
      value => { value.history[4].sourceToolAssistantUUID = 'foreign' },
      value => { value.history.find(row => row.id === 'request-2')!.tail = [] },
      value => { value.history.find(row => row.uuid === 'final')!.requestRef = 'foreign' },
      value => { value.history.find(row => row.id === 'request-2')!.model = 'different-model' },
      value => { contentBlocks(value.history[3].message!)[0].name = 'DeferredToolPlaceholder' },
      value => { value.history[1].placeholderValid = false },
      value => { contentBlocks(value.history.find(row => row.type === 'api-request-blob')!.message!)[0].content = 'Output has been saved to a file' },
      value => { contentBlocks(value.history[4].message!)[0].content = 'Output has been saved to a file' },
      value => { value.history[4].promptId = 'next-user-turn' },
      value => { value.history[3].parentUuid = 'missing-parent' },
      value => { value.history = value.history.filter(row => row.type !== 'api-request-shape') },
      value => { value.history.find(row => row.id === 'request-2')!.shapeHash = 'b'.repeat(64) },
      value => { value.prompt = 'replacement'; contentBlocks(value.echo.message)[0].text = 'replacement'; contentBlocks(value.history[0].message!)[0].text = 'replacement' },
    ]
    for (const mutate of cases) { const bad = structuredClone(witness); mutate(bad); assert.throws(() => proveClaudeFrozenReads(ref, bad)) }
    const rejected = structuredClone(witness), unavailable = 'mcp__frozen__spez_read_frozen'
    const rejection = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'unavailable', is_error: true, content: `<tool_use_error>Error: No such tool available: ${unavailable}</tool_use_error>` }] }
    const mcpPath = join(directory, 'controlled-mcp.jsonl')
    writeFileSync(mcpPath, JSON.stringify({ type: 'request', request: { method: 'tools/call', params: { name: 'spex_read_frozen' } } }) + '\n')
    rejected.mcpHistory = { path: mcpPath, toolNames: ['spex_read_frozen'] }
    rejected.history.splice(3, 0,
      { type: 'assistant', sessionId: 'session', uuid: 'unavailable-call', parentUuid: 'user', requestRef: 'request-1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'unavailable', name: unavailable, input }] } },
      { type: 'user', sessionId: 'session', uuid: 'unavailable-reply', parentUuid: 'unavailable-call', promptId: 'prompt', sourceToolAssistantUUID: 'unavailable-call', message: rejection },
      { type: 'api-request', sessionId: 'session', shapeHash: 'a'.repeat(64), id: 'request-rejected', base: 'request-1', keep: 1, tail: [claudeMessageDigest(rejection)], model: 'MiniMax-M3' })
    rejected.history.find(row => row.uuid === 'assistant')!.parentUuid = 'unavailable-reply'
    rejected.history.find(row => row.uuid === 'assistant')!.requestRef = 'request-rejected'
    const rejectedProof = proveClaudeFrozenReads(ref, rejected)
    assert.deepEqual(rejectedProof.coveredEntryIds, proof.coveredEntryIds)
    assert.equal(rejectedProof.receipts.length, 2, '原生拒绝事件不能作为读取覆盖')
    const rejectedCases: Array<(value: ClaudeFrozenWitness) => void> = [
      value => { contentBlocks(value.history.find(row => row.uuid === 'unavailable-reply')!.message!)[0].is_error = false },
      value => { contentBlocks(value.history.find(row => row.uuid === 'unavailable-reply')!.message!)[0].content = 'Permission denied' },
      value => { contentBlocks(value.history.find(row => row.uuid === 'unavailable-reply')!.message!)[0].content = 'No such tool available: another-tool' },
      value => { value.history.find(row => row.uuid === 'unavailable-reply')!.sourceToolAssistantUUID = 'foreign' },
      value => { contentBlocks(value.history.find(row => row.uuid === 'unavailable-call')!.message!)[0].name = 'DeferredToolPlaceholder' },
      value => { value.history.find(row => row.type === 'api-request-shape')!.toolNames!.push(unavailable) },
      value => { value.history.find(row => row.id === 'request-rejected')!.tail = [] },
      value => { contentBlocks(value.history.find(row => row.uuid === 'unavailable-call')!.message!)[0].name = 'mcp__frozen__spex_read_frozen' },
      value => { delete value.mcpHistory },
      value => { value.mcpHistory!.toolNames.push('spez_read_frozen') },
    ]
    for (const mutate of rejectedCases) { const bad = structuredClone(rejected); mutate(bad); assert.throws(() => proveClaudeFrozenReads(ref, bad)) }
    const otherSpelling = structuredClone(rejected), otherName = 'mcp__frozen__srozen__spex_read_frozen'
    contentBlocks(otherSpelling.history.find(row => row.uuid === 'unavailable-call')!.message!)[0].name = otherName
    const otherReply = otherSpelling.history.find(row => row.uuid === 'unavailable-reply')!.message!
    contentBlocks(otherReply)[0].content = `<tool_use_error>Error: No such tool available: ${otherName}</tool_use_error>`
    otherSpelling.history.find(row => row.id === 'request-rejected')!.tail = [claudeMessageDigest(otherReply)]
    assert.equal(proveClaudeFrozenReads(ref, otherSpelling).receipts.length, 2)
    writeFileSync(mcpPath, JSON.stringify({ type: 'request', request: { method: 'tools/call', params: { name: 'spez_read_frozen' } } }) + '\n')
    assert.throws(() => proveClaudeFrozenReads(ref, rejected), /MCP/)
    writeFileSync(mcpPath, JSON.stringify({ type: 'request', request: { method: 'tools/call', params: { name: 'spex_read_frozen' } } }) + '\n')
    const parallelRejection = structuredClone(witness)
    parallelRejection.mcpHistory = rejected.mcpHistory
    contentBlocks(parallelRejection.history[3].message!).push({ type: 'tool_use', id: 'unavailable', name: unavailable, input })
    parallelRejection.history.splice(6, 0, { type: 'user', sessionId: 'session', uuid: 'unavailable-reply', parentUuid: 'assistant', promptId: 'prompt', sourceToolAssistantUUID: 'assistant', message: rejection })
    const merged = parallelRejection.history.find(row => row.type === 'api-request-blob')!
    contentBlocks(merged.message!).push(contentBlocks(rejection)[0]); merged.hash = claudeMessageDigest(merged.message)
    parallelRejection.history.find(row => row.id === 'request-2')!.tail = [merged.hash]
    assert.equal(proveClaudeFrozenReads(ref, parallelRejection).receipts.length, 2)
    const noRead = structuredClone(parallelRejection)
    noRead.history[3].message!.content = contentBlocks(noRead.history[3].message!).filter(block => block.id === 'unavailable')
    noRead.history = noRead.history.filter(row => !['reply', 'reply-2'].includes(row.uuid ?? ''))
    noRead.history.find(row => row.uuid === 'final')!.parentUuid = 'unavailable-reply'
    const noReadBlob = noRead.history.find(row => row.type === 'api-request-blob')!
    noReadBlob.message!.content = [contentBlocks(rejection)[0]]; noReadBlob.hash = claudeMessageDigest(noReadBlob.message)
    noRead.history.find(row => row.id === 'request-2')!.tail = [noReadBlob.hash]
    assert.throws(() => proveClaudeFrozenReads(ref, noRead), /not completely read/)
    const rangeRejected = structuredClone(rejected), rangeError = 'frozen reader range is invalid or exceeds its bounded response'
    const rangeCall = contentBlocks(rangeRejected.history.find(row => row.uuid === 'unavailable-call')!.message!)[0]
    rangeCall.name = 'mcp__frozen__spex_read_frozen'; rangeCall.input = { ...input, endByte: 65536 }
    const rangeReply = rangeRejected.history.find(row => row.uuid === 'unavailable-reply')!.message!
    contentBlocks(rangeReply)[0].content = rangeError
    rangeRejected.history.find(row => row.id === 'request-rejected')!.tail = [claudeMessageDigest(rangeReply)]
    assert.equal(proveClaudeFrozenReads(ref, rangeRejected).receipts.length, 2)
    for (const mutate of [
      (value: ClaudeFrozenWitness) => { contentBlocks(value.history.find(row => row.uuid === 'unavailable-reply')!.message!)[0].is_error = false },
      (value: ClaudeFrozenWitness) => { contentBlocks(value.history.find(row => row.uuid === 'unavailable-reply')!.message!)[0].content = 'Permission denied' },
      (value: ClaudeFrozenWitness) => { contentBlocks(value.history.find(row => row.uuid === 'unavailable-call')!.message!)[0].input = input },
      (value: ClaudeFrozenWitness) => { contentBlocks(value.history.find(row => row.uuid === 'unavailable-call')!.message!)[0].input = { ...input, contextDigest: 'foreign', endByte: 65536 } },
      (value: ClaudeFrozenWitness) => { value.history.find(row => row.id === 'request-rejected')!.tail = [] },
      (value: ClaudeFrozenWitness) => { delete value.mcpHistory },
    ]) { const bad = structuredClone(rangeRejected); mutate(bad); assert.throws(() => proveClaudeFrozenReads(ref, bad)) }
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { detached: true, stdio: 'ignore' })
    assert(child.pid)
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
    const receiptFile = join(root, 'process.json'), processIdentity = writeDetachedRuntimeReceipt(child.pid, receiptFile)
    process.kill(-child.pid, 'SIGTERM'); await exited
    writeFileSync(join(root, 'mcp-public.jsonl'), JSON.stringify({ type: 'process', pid: child.pid, startToken: processIdentity.startToken }) + '\n')
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }
    const execution = { ...structuredExecutionPolicy({ schema, model: 'claude:MiniMax-M3', frozenContext: ref, inputDigest: 'input', purpose: 'controlled-cache', timeoutMs: 1000 }), claudeNative: { version: 1 as const, root, sessionId: 'session', userUuid: 'user', pid: child.pid, receiptFile } }
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const plan = { version: 1, root, sessionId: 'session', userUuid: 'user', pid: child.pid, receiptFile, cliVersion: '2.1.309 (Claude Code)', requestDigest: digest({ prompt: witness.prompt, policy: structuredExecutionPolicy(execution) }), policyDigest: digest(structuredExecutionPolicy(execution)) }
    const saved = { plan, witness: structuredClone(witness), result: { threadId: 'session', turnId: 'user', text: JSON.stringify({ answer: 'forged' }), frozenReadProof: proof } }
    saved.witness.result.structured_output = { answer: 'forged' }
    writeFileSync(join(root, 'plan.json'), JSON.stringify(plan)); writeFileSync(join(root, 'completed.json'), JSON.stringify(saved))
    await assert.rejects(claudeStructuredTurn(realm, 'native', witness.prompt, execution, { onThread: async () => assert.fail('no dispatch'), onTurn: async () => assert.fail('no turn'), onNative: async () => assert.fail('no CLI') }), /witness|result|completion/i)
    const nativeResult = { ...saved.result, text: JSON.stringify({ answer: 'public' }) }
    writeFileSync(join(root, 'completed.json'), JSON.stringify({ plan, witness, result: nativeResult }))
    writeFileSync(join(root, 'mcp-public.jsonl'), JSON.stringify({ type: 'process', pid: process.pid, startToken: null }) + '\n')
    const completed = { ...execution, state: 'completed' as const, threadId: 'session', turnId: 'user', output: { answer: 'public' }, resultDigest: digest({ answer: 'public' }), frozenReadProof: proof }
    const callbacks = { onThread: async () => assert.fail('no dispatch'), onTurn: async () => assert.fail('no turn'), onNative: async () => assert.fail('no CLI') }
    const kill = process.kill, signals: number[] = []
    process.kill = ((pid: number, signal?: number | NodeJS.Signals) => { if ((pid === process.pid || pid === -process.pid) && signal !== 0) { signals.push(pid); throw new Error('must not signal an unrelated reused PID') } return kill(pid, signal) }) as typeof process.kill
    try {
      assert.deepEqual(await claudeStructuredTurn(realm, 'native', witness.prompt, completed, callbacks), nativeResult)
      await assert.rejects(claudeStructuredTurn(realm, 'native', witness.prompt, { ...completed, state: 'running' }, callbacks), error => (error as { code: string }).code === 'cancellation_pending')
      await assert.rejects(claudeStructuredTurn(realm, 'native', witness.prompt, { ...completed, state: undefined }, callbacks), error => (error as { code: string }).code === 'cancellation_pending')
      await assert.rejects(claudeStructuredTurn(realm, 'native', witness.prompt, { ...completed, resultDigest: undefined }, callbacks), /durable completed state/)
      rmSync(join(root, 'completed.json'))
      await assert.rejects(claudeStructuredTurn(realm, 'native', witness.prompt, completed, callbacks), error => (error as { code: string }).code === 'cancellation_pending')
      assert.deepEqual(signals, [])
    } finally { process.kill = kill }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('public tool inputs keep business signature/thinking keys while actual synthetic private blocks are excluded', () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-claude-public-fields-'))
  try {
    const input = { signature: 'business-signature', thinking: { nested: 'business-thinking' } }, path = join(directory, 'public.jsonl')
    writeFileSync(path, JSON.stringify({ type: 'assistant', sessionId: 'session', uuid: 'assistant', parentUuid: 'user', requestRef: 'request', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'SYNTHETIC_PRIVATE_THINKING', signature: 'SYNTHETIC_PRIVATE_SIGNATURE' }, { type: 'tool_use', id: 'schema', name: 'StructuredOutput', input }] } }) + '\n')
    const records = readClaudePublicHistory(path, 'session')
    assert.deepEqual(contentBlocks(records[0].message!)[0].input, input)
    assert(!JSON.stringify(records).includes('SYNTHETIC_PRIVATE'))
    writeFileSync(path, JSON.stringify({ type: 'assistant', sessionId: 'session', uuid: 'assistant-text', message: { role: 'assistant', content: 'public assistant text' } }) + '\n')
    assert.deepEqual(readClaudePublicHistory(path, 'session')[0].message, { role: 'assistant', content: [] })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('native authentication projection keeps only four keys and explicit process values own the whole group', () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-claude-auth-projection-'))
  try {
    const path = join(directory, 'settings.json'), values = { ANTHROPIC_AUTH_TOKEN: 'PUBLIC_DUMMY_TOKEN', ANTHROPIC_API_KEY: 'PUBLIC_DUMMY_API_KEY', CLAUDE_CODE_OAUTH_TOKEN: 'PUBLIC_DUMMY_OAUTH', ANTHROPIC_BASE_URL: 'https://example.invalid/native' }
    writeFileSync(path, JSON.stringify({ env: { ...values, ANTHROPIC_MODEL: 'must-not-inherit', EXTRA_SECRET: 'must-not-inherit' }, hooks: { SessionStart: [{ command: 'must-not-run' }] }, permissions: { defaultMode: 'bypassPermissions' }, mcpServers: { foreign: {} } }))
    assert.deepEqual(prepareClaudeAuthenticationEnvironment({}, path), { environment: values, source: 'native-user-settings' })
    assert.deepEqual(prepareClaudeAuthenticationEnvironment({ ANTHROPIC_BASE_URL: 'https://example.invalid/explicit' }, path), { environment: { ANTHROPIC_BASE_URL: 'https://example.invalid/explicit' }, source: 'process' })
    assert.deepEqual(prepareClaudeAuthenticationEnvironment({ ANTHROPIC_AUTH_TOKEN: '' }, path), { environment: { ANTHROPIC_AUTH_TOKEN: '' }, source: 'process' })
    writeFileSync(path, '{"env":{"ANTHROPIC_AUTH_TOKEN":"PUBLIC_DUMMY_BROKEN"')
    assert.throws(() => prepareClaudeAuthenticationEnvironment({}, path), error => { assert(!String(error).includes('PUBLIC_DUMMY_BROKEN')); return true })
    assert.deepEqual(prepareClaudeAuthenticationEnvironment({ ANTHROPIC_AUTH_TOKEN: 'PUBLIC_EXPLICIT' }, path), { environment: { ANTHROPIC_AUTH_TOKEN: 'PUBLIC_EXPLICIT' }, source: 'process' })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
