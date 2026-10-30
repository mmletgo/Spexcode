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
    const row = (rows: typeof raw, uuid: string) => rows.find(item => item.uuid === uuid)!
    const metadata = (rows: typeof raw, uuid = 'compact-1') => row(rows, uuid).compactMetadata as { runningTurnSends: { uuids: string[]; openerUuid: string }; preservedMessages: { anchorUuid: string; uuids: string[]; allUuids: string[] } }
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
    partialCall.content[0].input = partialInput
    const partialReply = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: readFrozenRange(ref, partialInput).response.contentItems.map(item => ({ type: 'text', text: item.text })) }] }
    row(partial, 'reply-1').message = partialReply
    partial.find(item => item.id === 'request-4')!.tail = [claudeMessageDigest(partialReply)]
    assert.throws(() => proveClaudeFrozenReads(ref, witness(partial)), /not completely read/, 'compact summary assertions do not grant an unread byte')
    witness()
    verifyFrozenReadProof(ref, proof, { threadId: 'session', turnId: 'user' })
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
      value => { value.history[3].message!.content[0].name = 'DeferredToolPlaceholder' },
      value => { value.history[1].placeholderValid = false },
      value => { value.history.find(row => row.type === 'api-request-blob')!.message!.content[0].content = 'Output has been saved to a file' },
      value => { value.history[4].message!.content[0].content = 'Output has been saved to a file' },
      value => { value.history[4].promptId = 'next-user-turn' },
      value => { value.history[3].parentUuid = 'missing-parent' },
      value => { value.history = value.history.filter(row => row.type !== 'api-request-shape') },
      value => { value.history.find(row => row.id === 'request-2')!.shapeHash = 'b'.repeat(64) },
      value => { value.prompt = 'replacement'; value.echo.message.content[0].text = 'replacement'; value.history[0].message!.content[0].text = 'replacement' },
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
      value => { value.history.find(row => row.uuid === 'unavailable-reply')!.message!.content[0].is_error = false },
      value => { value.history.find(row => row.uuid === 'unavailable-reply')!.message!.content[0].content = 'Permission denied' },
      value => { value.history.find(row => row.uuid === 'unavailable-reply')!.message!.content[0].content = 'No such tool available: another-tool' },
      value => { value.history.find(row => row.uuid === 'unavailable-reply')!.sourceToolAssistantUUID = 'foreign' },
      value => { value.history.find(row => row.uuid === 'unavailable-call')!.message!.content[0].name = 'DeferredToolPlaceholder' },
      value => { value.history.find(row => row.type === 'api-request-shape')!.toolNames!.push(unavailable) },
      value => { value.history.find(row => row.id === 'request-rejected')!.tail = [] },
      value => { value.history.find(row => row.uuid === 'unavailable-call')!.message!.content[0].name = 'mcp__frozen__spex_read_frozen' },
      value => { delete value.mcpHistory },
      value => { value.mcpHistory!.toolNames.push('spez_read_frozen') },
    ]
    for (const mutate of rejectedCases) { const bad = structuredClone(rejected); mutate(bad); assert.throws(() => proveClaudeFrozenReads(ref, bad)) }
    const otherSpelling = structuredClone(rejected), otherName = 'mcp__frozen__srozen__spex_read_frozen'
    otherSpelling.history.find(row => row.uuid === 'unavailable-call')!.message!.content[0].name = otherName
    const otherReply = otherSpelling.history.find(row => row.uuid === 'unavailable-reply')!.message!
    otherReply.content[0].content = `<tool_use_error>Error: No such tool available: ${otherName}</tool_use_error>`
    otherSpelling.history.find(row => row.id === 'request-rejected')!.tail = [claudeMessageDigest(otherReply)]
    assert.equal(proveClaudeFrozenReads(ref, otherSpelling).receipts.length, 2)
    writeFileSync(mcpPath, JSON.stringify({ type: 'request', request: { method: 'tools/call', params: { name: 'spez_read_frozen' } } }) + '\n')
    assert.throws(() => proveClaudeFrozenReads(ref, rejected), /MCP/)
    writeFileSync(mcpPath, JSON.stringify({ type: 'request', request: { method: 'tools/call', params: { name: 'spex_read_frozen' } } }) + '\n')
    const parallelRejection = structuredClone(witness)
    parallelRejection.mcpHistory = rejected.mcpHistory
    parallelRejection.history[3].message!.content.push({ type: 'tool_use', id: 'unavailable', name: unavailable, input })
    parallelRejection.history.splice(6, 0, { type: 'user', sessionId: 'session', uuid: 'unavailable-reply', parentUuid: 'assistant', promptId: 'prompt', sourceToolAssistantUUID: 'assistant', message: rejection })
    const merged = parallelRejection.history.find(row => row.type === 'api-request-blob')!
    merged.message!.content.push(rejection.content[0]); merged.hash = claudeMessageDigest(merged.message)
    parallelRejection.history.find(row => row.id === 'request-2')!.tail = [merged.hash]
    assert.equal(proveClaudeFrozenReads(ref, parallelRejection).receipts.length, 2)
    const noRead = structuredClone(parallelRejection)
    noRead.history[3].message!.content = noRead.history[3].message!.content.filter(block => block.id === 'unavailable')
    noRead.history = noRead.history.filter(row => !['reply', 'reply-2'].includes(row.uuid ?? ''))
    noRead.history.find(row => row.uuid === 'final')!.parentUuid = 'unavailable-reply'
    const noReadBlob = noRead.history.find(row => row.type === 'api-request-blob')!
    noReadBlob.message!.content = [rejection.content[0]]; noReadBlob.hash = claudeMessageDigest(noReadBlob.message)
    noRead.history.find(row => row.id === 'request-2')!.tail = [noReadBlob.hash]
    assert.throws(() => proveClaudeFrozenReads(ref, noRead), /not completely read/)
    const rangeRejected = structuredClone(rejected), rangeError = 'frozen reader range is invalid or exceeds its bounded response'
    const rangeCall = rangeRejected.history.find(row => row.uuid === 'unavailable-call')!.message!.content[0]
    rangeCall.name = 'mcp__frozen__spex_read_frozen'; rangeCall.input = { ...input, endByte: 65536 }
    const rangeReply = rangeRejected.history.find(row => row.uuid === 'unavailable-reply')!.message!
    rangeReply.content[0].content = rangeError
    rangeRejected.history.find(row => row.id === 'request-rejected')!.tail = [claudeMessageDigest(rangeReply)]
    assert.equal(proveClaudeFrozenReads(ref, rangeRejected).receipts.length, 2)
    for (const mutate of [
      (value: ClaudeFrozenWitness) => { value.history.find(row => row.uuid === 'unavailable-reply')!.message!.content[0].is_error = false },
      (value: ClaudeFrozenWitness) => { value.history.find(row => row.uuid === 'unavailable-reply')!.message!.content[0].content = 'Permission denied' },
      (value: ClaudeFrozenWitness) => { value.history.find(row => row.uuid === 'unavailable-call')!.message!.content[0].input = input },
      (value: ClaudeFrozenWitness) => { value.history.find(row => row.uuid === 'unavailable-call')!.message!.content[0].input = { ...input, contextDigest: 'foreign', endByte: 65536 } },
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
    assert.deepEqual(records[0].message!.content[0].input, input)
    assert(!JSON.stringify(records).includes('SYNTHETIC_PRIVATE'))
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
