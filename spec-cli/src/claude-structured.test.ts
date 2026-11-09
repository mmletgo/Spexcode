import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import childProcess, { spawn, type SpawnOptions } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { HARNESS_IDENTITIES, verifyDetachedRuntime, writeDetachedRuntimeReceipt } from '@spexcode/spec-core'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { prepareFrozenPrompt, readFrozenManifest, claudeFrozenContextPrompt, freezeContext, readFrozenRange, proveClaudeFrozenReads, verifyFrozenReadProof, claudeMessageDigest, readClaudeApiSourceMetadata, readClaudePublicHistory, type ClaudeFrozenWitness, type ClaudePublicMessage, type ClaudePublicRecord } from './frozen-context.js'
import { structuredExecutionPolicy, structuredRealmRoot, type StructuredExecution } from './session-structured-policy.js'
import { sampleNativeWorktreeProcesses } from './native-worktree-runtime.js'
import { claudeNativeModel, claudeWorktreeArgs, claudeStructuredArgs, claudeStructuredTurn, observeClaudeWorktreeMissingFinal, observeClaudeStoppedWorktreeFailure, assertClaudeStoppedDraftSource, prepareClaudeAuthenticationEnvironment } from './claude-structured.js'

const contentBlocks = (message: ClaudePublicMessage): Exclude<ClaudePublicMessage['content'], string> => {
  assert(Array.isArray(message.content))
  return message.content
}

const continuationFixture = process.env.SPEX_CLAUDE_CONTINUATION_FIXTURE
const continuationCases = continuationFixture ? (JSON.parse(readFileSync(continuationFixture, 'utf8')) as { cases: { sessionId: string; expectedCode: string; execution: StructuredExecution; files: { path: string; bytes: number; sha256: string }[] }[] }).cases : []
for (const fixture of continuationCases) test(`真实终态续行离线重放 ${fixture.sessionId} 保留失败及全部原件`, async () => {
  const root = fixture.execution.claudeNative!.root
  const original = fixture.files.map(file => {
    const bytes = readFileSync(file.path)
    assert.equal(bytes.length, file.bytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256)
    return bytes
  })
  const echo = JSON.parse(readFileSync(join(root, 'user-echo.json'), 'utf8')) as { message: ClaudePublicMessage }
  const blocks = contentBlocks(echo.message)
  assert.equal(blocks.length, 1); assert.equal(blocks[0].type, 'text')
  let observed: { code: string; message: string } | undefined
  try {
    await claudeStructuredTurn(dirname(root), basename(root), blocks[0].text!, fixture.execution, { onThread: async () => assert.fail('离线重放不得启动线程'), onTurn: async () => assert.fail('离线重放不得启动turn'), onNative: async () => assert.fail('离线重放不得启动Native') })
    assert.fail('终态耗尽不能变业务成功')
  } catch (error) { observed = { code: (error as { code: string }).code, message: (error as Error).message } }
  for (let index = 0; index < fixture.files.length; index++) assert.deepEqual(readFileSync(fixture.files[index].path), original[index])
  for (const name of ['completed.json', 'witness.json']) assert.equal(existsSync(join(root, name)), false)
  if (process.env.SPEX_CLAUDE_CONTINUATION_EVIDENCE_DIR) writeFileSync(join(process.env.SPEX_CLAUDE_CONTINUATION_EVIDENCE_DIR, `${fixture.sessionId}.json`), JSON.stringify({ sessionId: fixture.sessionId, observed, expectedCode: fixture.expectedCode, originalFilesUnchanged: true, nativeCalls: 0 }, null, 2))
  assert.equal(observed.code, fixture.expectedCode)
})

for (const timeoutMs of [1000, null]) test(`stopped exact Claude schema retry exhaustion with timeout=${timeoutMs} remains rejected with no new native turn`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-claude-schema-exhaustion-')), requestKey = `schema-exhaustion-${timeoutMs}`
  let runtimeFixture: string | undefined
  try {
    const realm = join(directory, 'realm'), root = join(realm, 'native'), projects = join(root, 'claude-home/projects/fixture')
    mkdirSync(projects, { recursive: true })
    const ref = freezeContext({ directory, sourceRoot: process.cwd(), binding: { requestKey, inputDigest: 'input' }, entries: [{ id: 'task', label: 'task', kind: 'utf8', bytes: Buffer.from('original public task') }] })
    const prompt = 'fixed original public prompt', message = { role: 'user', content: [{ type: 'text', text: prompt }] }
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { detached: true, stdio: 'ignore' })
    assert(child.pid)
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
    const receiptFile = join(root, 'process.json'), identity = writeDetachedRuntimeReceipt(child.pid, receiptFile)
    process.kill(-child.pid, 'SIGTERM'); await exited
    writeFileSync(join(root, 'mcp-public.jsonl'), JSON.stringify({ type: 'process', pid: child.pid, startToken: identity.startToken }) + '\n')
    const execution = { ...structuredExecutionPolicy({ schema: { type: 'object', properties: { newNodes: { type: 'array', maxItems: 0 } }, required: ['newNodes'], additionalProperties: false }, model: 'claude:MiniMax-M3.1-Flash', frozenContext: ref, inputDigest: 'input', purpose: 'schema-exhaustion', timeoutMs }), claudeNative: { version: 1 as const, root, sessionId: 'session', userUuid: 'user', pid: child.pid, receiptFile } }
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const plan = { version: 1, root, sessionId: 'session', userUuid: 'user', pid: child.pid, receiptFile, cliVersion: '2.1.309 (Claude Code)', requestDigest: digest({ prompt, policy: structuredExecutionPolicy(execution) }), policyDigest: digest(structuredExecutionPolicy(execution)) }
    const result = { type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, session_id: 'session', uuid: 'result', user_message_uuid: 'user', user_message_uuids: ['user'] }
    const init = { session_id: 'session', model: 'MiniMax-M3.1-Flash', tools: ['StructuredOutput', 'mcp__frozen__spex_read_frozen'] }
    const original = { type: 'user', sessionId: 'session', uuid: 'user', parentUuid: null, promptId: 'prompt', message }
    writeFileSync(join(root, 'plan.json'), JSON.stringify(plan))
    writeFileSync(join(root, 'init.json'), JSON.stringify(init))
    writeFileSync(join(root, 'user-echo.json'), JSON.stringify({ uuid: 'user', session_id: 'session', message }))
    writeFileSync(join(root, 'result.json'), JSON.stringify(result))
    writeFileSync(join(root, 'exit.json'), JSON.stringify({ code: 1, signal: null, stopped: true }))
    const historyPath = join(projects, 'session.jsonl')
    const history = [original,
      { type: 'api-request-shape', sessionId: 'session', shapeHash: 'a'.repeat(64), shape: { tools: [...init.tools.map(name => ({ name })), { name: 'DeferredToolPlaceholder', description: 'Reserved placeholder that keeps deferred tool loading active; never call this tool.', defer_loading: true, input_schema: { type: 'object', properties: {} } }] } },
      { type: 'api-request', sessionId: 'session', shapeHash: 'a'.repeat(64), id: 'request', keep: 0, tail: [claudeMessageDigest(message)], params: { model: 'MiniMax-M3.1-Flash' } },
      { type: 'assistant', sessionId: 'session', uuid: 'schema-call', parentUuid: 'user', requestRef: 'request', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'schema', name: 'StructuredOutput', input: { newNodes: {} } }] } },
      { type: 'user', sessionId: 'session', uuid: 'schema-error', parentUuid: 'schema-call', promptId: 'prompt', sourceToolAssistantUUID: 'schema-call', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'schema', is_error: true, content: 'newNodes must be an array' }] } },
    ]
    writeFileSync(historyPath, history.map(row => JSON.stringify(row)).join('\n') + '\n')
    const callbacks = { onThread: async () => assert.fail('no new native session'), onTurn: async () => assert.fail('no new user'), onNative: async () => assert.fail('no new CLI') }
    const failureBytes = readFileSync(join(root, 'result.json')), historyBytes = readFileSync(historyPath)
    for (let replay = 0; replay < 2; replay++) await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, callbacks), error => {
      assert.equal((error as { code: string }).code, 'structured_output_retries_exhausted')
      assert.match(String(error), /error_max_structured_output_retries/)
      return true
    })
    const terminalRequest = { version: 1, reason: 'terminal_settlement', sessionId: 'session', userUuid: 'user', pid: child.pid, receiptDigest: digest(JSON.parse(readFileSync(receiptFile, 'utf8'))), requestDigest: plan.requestDigest, resultDigest: digest(result), signal: 'SIGTERM', requestedAt: 1 }
    writeFileSync(join(root, 'terminal-stop-request.json'), JSON.stringify(terminalRequest))
    writeFileSync(join(root, 'terminal-stop.json'), JSON.stringify({ version: 1, requestObservationDigest: digest(terminalRequest), outcome: 'sent', observedAt: 2 }))
    await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, callbacks), { code: 'stale_result' }, 'legacy forced handler exit1 is not a natural schema exhaustion exit')
    writeFileSync(join(root, 'terminal-stop.json'), JSON.stringify({ version: 1, requestObservationDigest: digest(terminalRequest), outcome: 'gone', observedAt: 2 }))
    await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, callbacks), { code: 'structured_output_retries_exhausted' })
    rmSync(join(root, 'terminal-stop-request.json')); rmSync(join(root, 'terminal-stop.json'))
    assert.deepEqual(readFileSync(join(root, 'result.json')), failureBytes)
    assert.deepEqual(readFileSync(historyPath), historyBytes)
    for (const name of ['completed.json', 'witness.json']) assert.equal(existsSync(join(root, name)), false)
    const summaryMessage = { role: 'user', content: 'Exact same-turn compact summary, no additional instruction.' }
    const summaryHash = claudeMessageDigest({ ...summaryMessage, content: [{ type: 'text', text: summaryMessage.content }] })
    const compactRows: Array<Record<string, unknown>> = [...history,
      { type: 'system', subtype: 'compact_boundary', sessionId: 'session', uuid: 'compact', parentUuid: null, logicalParentUuid: 'schema-error', compactMetadata: { runningTurnSends: { openerUuid: 'user', uuids: ['user'] }, preservedSegment: { headUuid: 'schema-call', tailUuid: 'schema-error', anchorUuid: 'summary' }, preservedMessages: { anchorUuid: 'summary', uuids: ['schema-call', 'schema-error'], allUuids: ['schema-call', 'schema-error'] } } },
      { type: 'attachment', sessionId: 'session', uuid: 'compact-attachment', parentUuid: 'compact' },
      { type: 'user', sessionId: 'session', uuid: 'summary', parentUuid: 'compact-attachment', promptId: 'prompt', isCompactSummary: true, isVisibleInTranscriptOnly: true, summarizedTurnPromptUuids: ['user'], message: summaryMessage },
      { type: 'api-request-blob', sessionId: 'session', hash: summaryHash, message: summaryMessage },
      { ...history[2], id: 'request-after-compact', keep: 0, tail: [summaryHash] },
      { ...history[3], uuid: 'schema-call-after-compact', parentUuid: 'summary', requestRef: 'request-after-compact', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'schema-after-compact', name: 'StructuredOutput', input: { newNodes: {} } }] } },
      { ...history[4], uuid: 'schema-error-after-compact', parentUuid: 'schema-call-after-compact', sourceToolAssistantUUID: 'schema-call-after-compact', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'schema-after-compact', is_error: true, content: "Output does not match required schema: /newNodes: must be array, /newNodes/0: must have required property 'codePath'" }] } },
    ]
    writeFileSync(historyPath, compactRows.map(row => JSON.stringify(row)).join('\n') + '\n')
    for (let replay = 0; replay < 2; replay++) await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, callbacks), error => {
      assert.equal((error as { code: string }).code, 'structured_output_retries_exhausted')
      assert.match(String(error), /schema-after-compact.*newNodes.*must be array/)
      assert.doesNotMatch(String(error), /Exact same-turn compact summary/)
      return true
    })
    const compactNegative: Array<[string, (rows: Array<Record<string, unknown>>) => void]> = [
      ['foreign summary', rows => { rows[7].sessionId = 'foreign' }],
      ['non-string attachment UUID', rows => { rows[6].uuid = 123; rows[7].parentUuid = 123 }],
      ['non-string compact UUID', rows => { rows[5].uuid = 123; rows[6].parentUuid = 123 }],
      ['missing anchor', rows => { delete (rows[5].compactMetadata as { preservedSegment: { anchorUuid?: string } }).preservedSegment.anchorUuid }],
      ['missing preserved UUID', rows => { (rows[5].compactMetadata as { preservedMessages: { allUuids: string[] } }).preservedMessages.allUuids.pop() }],
      ['wrong summary parent', rows => { rows[7].parentUuid = 'user' }],
      ['foreign prompt', rows => { rows[7].promptId = 'foreign' }],
      ['foreign opener', rows => { (rows[5].compactMetadata as { runningTurnSends: { openerUuid: string } }).runningTurnSends.openerUuid = 'foreign' }],
      ['summary API substitution', rows => { rows[8].message = { role: 'user', content: summaryMessage.content + ' extra input' } }],
      ['future summary', rows => { const [summary] = rows.splice(7, 1); rows.push(summary) }],
      ['old request consumer', rows => { rows[10].requestRef = 'unobserved-request' }],
      ['extra user', rows => { rows.push({ type: 'user', sessionId: 'session', uuid: 'extra', parentUuid: 'schema-error-after-compact', promptId: 'prompt', message: { role: 'user', content: 'additional human instruction' } }) }],
    ]
    for (const [name, mutate] of compactNegative) {
      const rows = structuredClone(compactRows); mutate(rows)
      writeFileSync(historyPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, callbacks), { code: 'stale_result' }, name)
    }
    for (const name of ['completed.json', 'witness.json']) assert.equal(existsSync(join(root, name)), false)
    const limitText = 'Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.'
    const limitMessage = { role: 'user', content: [{ type: 'text', text: limitText }] }, limitHash = claudeMessageDigest(limitMessage)
    const interrupted = { type: 'assistant', sessionId: 'session', uuid: 'interrupted', parentUuid: 'user', requestRef: 'request', message: { role: 'assistant', content: [], stop_reason: 'max_tokens' } }
    const companion = { type: 'user', sessionId: 'session', uuid: 'companion', parentUuid: 'interrupted', promptId: 'prompt', isMeta: true, turnCompanion: true, message: { role: 'user', content: limitText } }
    const nextRequest = { ...history[2], id: 'request-recovery', base: 'request', keep: 1, tail: [limitHash] }
    const recoveryRows: Array<Record<string, unknown>> = [...history.slice(0, 3), interrupted, companion, nextRequest, { ...history[3], parentUuid: 'companion', requestRef: 'request-recovery' }, history[4]]
    const merged = { role: 'user', content: [{ type: 'text', text: prompt + '\n' }, { type: 'text', text: limitText }] }
    const mergedHash = claudeMessageDigest(merged)
    for (const rows of [recoveryRows, [...recoveryRows.slice(0, 5), { type: 'api-request-blob', sessionId: 'session', message: merged, hash: mergedHash }, { ...nextRequest, tail: [mergedHash] }, ...recoveryRows.slice(6)]]) {
      writeFileSync(historyPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, callbacks), { code: 'structured_output_retries_exhausted' })
    }
    const row = (rows: Array<Record<string, unknown>>, id: string) => rows.find(row => row.uuid === id || row.id === id)!
    const recoveryNegatives: Array<[string, (rows: Array<Record<string, unknown>>) => void]> = [
      ['missing meta', rows => { delete row(rows, 'companion').isMeta }],
      ['false meta', rows => { row(rows, 'companion').isMeta = false }],
      ['missing companion', rows => { delete row(rows, 'companion').turnCompanion }],
      ['foreign prompt', rows => { row(rows, 'companion').promptId = 'foreign' }],
      ['foreign session', rows => { row(rows, 'companion').sessionId = 'foreign' }],
      ['source assistant', rows => { row(rows, 'companion').sourceToolAssistantUUID = 'interrupted' }],
      ['earlier parent', rows => { row(rows, 'companion').parentUuid = 'user' }],
      ['non-max_tokens parent', rows => { (row(rows, 'interrupted').message as Record<string, unknown>).stop_reason = 'end_turn' }],
      ['array companion', rows => { row(rows, 'companion').message = limitMessage }],
      ['extra whitespace', rows => { row(rows, 'companion').message = { role: 'user', content: limitText + ' ' } }],
      ['unproved 113-character producer', rows => { row(rows, 'companion').message = { role: 'user', content: '[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request. Call this tool now.' }; delete row(rows, 'companion').turnCompanion }],
      ['fake compact', rows => { row(rows, 'companion').isCompactSummary = true }],
      ['old request consumer', rows => { row(rows, 'schema-call').requestRef = 'request' }],
      ['unconsumed', rows => { rows.splice(5) }],
      ['future request', rows => { const request = rows.splice(5, 1)[0]; rows.splice(4, 0, request) }],
      ['different API text', rows => { const message = { role: 'user', content: [{ type: 'text', text: limitText + ' extra' }] }; rows.splice(5, 0, { type: 'api-request-blob', sessionId: 'session', message, hash: claudeMessageDigest(message) }); row(rows, 'request-recovery').tail = [claudeMessageDigest(message)] }],
      ['borrowed repeated companion', rows => { rows.push({ ...interrupted, uuid: 'interrupted-2', parentUuid: 'schema-error', requestRef: 'request-recovery' }, { ...companion, uuid: 'companion-2', parentUuid: 'interrupted-2' }, { ...interrupted, uuid: 'old-consumer', parentUuid: 'companion-2', requestRef: 'request-recovery' }) }],
    ]
    for (const [name, mutate] of recoveryNegatives) {
      const rows = structuredClone(recoveryRows); mutate(rows)
      writeFileSync(historyPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, callbacks), error => {
        assert.equal((error as { code: string }).code, 'stale_result', name)
        return true
      })
    }
    assert.deepEqual(readFileSync(join(root, 'result.json')), failureBytes)
    for (const name of ['completed.json', 'witness.json']) assert.equal(existsSync(join(root, name)), false)
    const privateFragment = { type: 'thinking', thinking: 'SYNTHETIC_PRIVATE_FRAGMENT', signature: 'SYNTHETIC_SIGNATURE', cache_control: { type: 'ephemeral' } }
    const schemaBlock = contentBlocks(history[3].message!)[0]
    const fragmentedHash = claudeMessageDigest({ role: 'assistant', content: [{ type: 'thinking', thinking: 'SYNTHETIC_PRIVATE_FRAGMENT', signature: 'SYNTHETIC_SIGNATURE' }, schemaBlock] })
    const fragments = [
      ...history.slice(0, 3),
      { type: 'assistant', sessionId: 'session', uuid: 'fragment-1', parentUuid: 'user', requestRef: 'request', message: { id: 'same-native-message', role: 'assistant', content: [privateFragment] } },
      { ...history[3], parentUuid: 'fragment-1', message: { ...history[3].message!, id: 'same-native-message' } },
      history[4],
      { ...history[2], id: 'request-fragments', base: 'request', keep: 1, tail: [fragmentedHash, claudeMessageDigest(history[4].message)] },
    ]
    writeFileSync(historyPath, fragments.map(row => JSON.stringify(row)).join('\n') + '\n')
    await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, callbacks), error => {
      assert.equal((error as { code: string }).code, 'structured_output_retries_exhausted', 'same-id native assistant prefix needs no CAS and must bind both prior UUIDs')
      return true
    })
    const sourceMetadata = readClaudeApiSourceMetadata(historyPath, 'session', 'MiniMax-M3.1-Flash')
    assert.deepEqual(sourceMetadata.get('request-fragments')!.messages.get(fragmentedHash)!.sourceUuids, ['fragment-1', 'schema-call'])
    assert(!JSON.stringify([...sourceMetadata].map(([id, value]) => [id, { ...value, messages: [...value.messages] }])).includes('SYNTHETIC_'), 'metadata must never expose private message blocks')
    const systemMessage = { role: 'system', content: 'public fixed system input' }, systemHash = claudeMessageDigest({ role: 'system', content: [{ type: 'text', text: systemMessage.content }] })
    const systemCas = { type: 'api-request-blob', sessionId: 'session', hash: systemHash, message: systemMessage }
    const withSystem = [original, history[1], systemCas, { ...history[2], tail: [claudeMessageDigest(message), systemHash] }, ...history.slice(3)]
    const secondSchemaBlock = { ...schemaBlock, id: 'schema-2' }, firstErrorBlock = contentBlocks(history[4].message!)[0], secondErrorBlock = { ...firstErrorBlock, tool_use_id: 'schema-2' }
    const parallelAssistant = { ...history[3], message: { role: 'assistant', content: [schemaBlock, secondSchemaBlock] } }
    const secondError = { ...history[4], uuid: 'schema-error-2', message: { role: 'user', content: [secondErrorBlock] } }
    const mergedReplies = { role: 'user', content: [firstErrorBlock, secondErrorBlock] }, mergedReplyHash = claudeMessageDigest(mergedReplies)
    const parallelReplies = [...history.slice(0, 3), parallelAssistant, history[4], secondError, { ...history[2], id: 'request-parallel', base: 'request', keep: 1, tail: [claudeMessageDigest(parallelAssistant.message), mergedReplyHash] }]
    for (const rows of [withSystem, parallelReplies]) {
      writeFileSync(historyPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, callbacks), error => (error as { code: string }).code === 'structured_output_retries_exhausted')
    }
    assert.deepEqual(readClaudeApiSourceMetadata(historyPath, 'session', 'MiniMax-M3.1-Flash').get('request-parallel')!.messages.get(mergedReplyHash)!.sourceUuids, ['schema-error', 'schema-error-2'])
    for (const [name, rows] of [
      ['future assistant prefix', fragments.map(row => 'id' in row && row.id === 'request' ? { ...row, tail: [claudeMessageDigest(message), fragmentedHash] } : row)],
      ['private body tamper', fragments.map(row => row.uuid === 'fragment-1' ? { ...row, message: { id: 'same-native-message', role: 'assistant', content: [{ ...privateFragment, thinking: 'TAMPERED_PRIVATE_FRAGMENT' }] } } : row)],
      ['different native message id', fragments.map(row => row.uuid === 'schema-call' ? { ...row, message: { ...history[3].message!, id: 'different-message-id' } } : row)],
      ['cross-role transcript', fragments.map(row => row.uuid === 'fragment-1' ? { ...row, message: { id: 'same-native-message', role: 'user', content: [privateFragment] } } : row)],
      ['future system CAS', [original, history[1], { ...history[2], tail: [claudeMessageDigest(message), systemHash] }, ...history.slice(3), systemCas]],
      ['wrong CAS role hash', withSystem.map(row => row === systemCas ? { ...systemCas, message: { ...systemMessage, role: 'assistant' } } : row)],
      ['CAS body tamper', withSystem.map(row => row === systemCas ? { ...systemCas, message: { ...systemMessage, content: 'tampered system input' } } : row)],
      ['fork source', [...fragments, { type: 'fork-context-ref', sessionId: 'session' }]],
      ['unknown user merged into a known reply', [...parallelReplies.slice(0, -1), { ...original, uuid: 'unknown-user', parentUuid: 'schema-error-2', message: { role: 'user', content: [{ type: 'text', text: 'UNOBSERVED EXTRA USER INTENT' }] } }, parallelReplies.at(-1)!]],
    ] as Array<[string, Array<Record<string, unknown>>]>) {
      writeFileSync(historyPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, callbacks), error => {
        assert.equal((error as { code: string }).code, 'stale_result', name)
        return true
      })
    }
    writeFileSync(historyPath, historyBytes)
    const extraMessage = { role: 'user', content: [{ type: 'text', text: 'UNOBSERVED EXTRA USER INTENT' }] }
    const extraBlob = { type: 'api-request-blob', sessionId: 'session', hash: claudeMessageDigest(extraMessage), message: extraMessage }
    const replyMessage = history[4].message!, replyBlob = { type: 'api-request-blob', sessionId: 'session', hash: claudeMessageDigest(replyMessage), message: replyMessage }
    const apiSourceCases = [
      { name: 'canonical unknown user blob declared before consumption', blob: extraBlob, at: 2, hash: extraBlob.hash },
      { name: 'canonical unknown user blob declared after consumption', blob: extraBlob, at: history.length, hash: extraBlob.hash },
      { name: 'unknown request hash has no CAS blob', hash: extraBlob.hash },
      { name: 'user blob carries a wrong content hash', blob: { ...extraBlob, hash: 'b'.repeat(64) }, at: 2, hash: 'b'.repeat(64) },
      { name: 'request has an unobserved base', base: 'unknown-request' },
      { name: 'request keep exceeds its actual base', keep: 1 },
      { name: 'exact future tool result declared before its native reply', blob: replyBlob, at: 2, hash: replyBlob.hash },
      { name: 'exact future tool result declared after its native reply', blob: replyBlob, at: history.length, hash: replyBlob.hash },
    ]
    for (const invalid of apiSourceCases) {
      const rows: Array<Record<string, unknown>> = structuredClone(history)
      rows[2] = { ...rows[2], ...(invalid.base ? { base: invalid.base } : {}), ...(invalid.keep ? { keep: invalid.keep } : {}), tail: [claudeMessageDigest(message), ...(invalid.hash ? [invalid.hash] : [])] }
      if (invalid.blob) rows.splice(invalid.at!, 0, invalid.blob)
      writeFileSync(historyPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, callbacks), error => {
        assert.equal((error as { code: string }).code, 'stale_result', invalid.name)
        return true
      })
      assert.equal(existsSync(join(root, 'completed.json')), false, invalid.name)
      assert.equal(existsSync(join(root, 'witness.json')), false, invalid.name)
    }
    const consumedReply = { ...history[2], id: 'request-2', base: 'request', keep: 1, tail: [replyBlob.hash] }
    const forgedReplyMessage = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'schema', is_error: true, content: 'different schema error' }] }
    const forgedReplyBlob = { ...replyBlob, message: forgedReplyMessage, hash: claudeMessageDigest(forgedReplyMessage) }
    for (const rows of [
      [...history.slice(0, 2), replyBlob, ...history.slice(2), consumedReply],
      [...history, consumedReply, replyBlob],
      [...history, extraBlob],
    ]) {
      writeFileSync(historyPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, callbacks), error => (error as { code: string }).code === 'structured_output_retries_exhausted')
    }
    for (const rows of [
      [...history, { ...consumedReply, base: 'unobserved-request' }],
      [...history, { ...consumedReply, keep: 2 }],
      [...history, forgedReplyBlob, { ...consumedReply, tail: [forgedReplyBlob.hash] }],
      [...history, extraBlob, { ...consumedReply, tail: [replyBlob.hash, extraBlob.hash] }, { ...consumedReply, id: 'request-3', base: 'request-2', keep: 1, tail: [] }],
    ]) {
      writeFileSync(historyPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, callbacks), error => (error as { code: string }).code === 'stale_result')
    }
    writeFileSync(historyPath, historyBytes)
    for (const invalid of [
      { result: { ...result, subtype: 'error_during_execution' } },
      { result: { ...result, is_error: false } },
      { result: { ...result, session_id: 'foreign' } },
      { result: { ...result, user_message_uuid: 'foreign' } },
      { result: { ...result, user_message_uuids: ['user', 'foreign'] } },
      { echo: { uuid: 'foreign', session_id: 'session', message } },
      { echo: { uuid: 'user', session_id: 'foreign', message } },
      { init: { ...init, model: 'foreign' } },
      { init: { ...init, tools: [...init.tools, 'Bash'] } },
      { plan: { ...plan, policyDigest: 'foreign' } },
      { exit: { code: 1, signal: null, stopped: false } },
      { history: history.map(row => row.type === 'api-request' ? { ...row, params: { model: 'foreign' } } : row) },
      { original: { ...original, promptId: undefined } },
      { original: { ...original, message: { role: 'user', content: [{ type: 'text', text: 'replacement prompt' }] } } },
      { extra: { ...original, uuid: 'foreign-user', parentUuid: 'schema-error', message: { role: 'user', content: [{ type: 'text', text: 'a new user prompt' }] } } },
    ]) {
      writeFileSync(join(root, 'result.json'), JSON.stringify(invalid.result ?? result))
      writeFileSync(join(root, 'init.json'), JSON.stringify(invalid.init ?? init))
      writeFileSync(join(root, 'plan.json'), JSON.stringify(invalid.plan ?? plan))
      writeFileSync(join(root, 'exit.json'), JSON.stringify(invalid.exit ?? { code: 1, signal: null, stopped: true }))
      writeFileSync(join(root, 'user-echo.json'), JSON.stringify(invalid.echo ?? { uuid: 'user', session_id: 'session', message }))
      writeFileSync(historyPath, (invalid.history ?? [invalid.original ?? original, ...history.slice(1), ...(invalid.extra ? [invalid.extra] : [])]).map(row => JSON.stringify(row)).join('\n') + '\n')
      await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, callbacks), error => (error as { code: string }).code !== 'structured_output_retries_exhausted')
    }
    writeFileSync(join(root, 'result.json'), failureBytes); writeFileSync(join(root, 'init.json'), JSON.stringify(init)); writeFileSync(historyPath, historyBytes)
    writeFileSync(join(root, 'mcp-public.jsonl'), JSON.stringify({ type: 'process', pid: process.pid, startToken: null }) + '\n')
    await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, callbacks), error => (error as { code: string }).code === 'cancellation_pending')
    writeFileSync(join(root, 'mcp-public.jsonl'), JSON.stringify({ type: 'process', pid: child.pid, startToken: identity.startToken }) + '\n')
    const { runtimeRoot, sessionArtifactPath } = await import('@spexcode/spec-core')
    const { sessionIdForCreateKey } = await import('./sessions.js')
    const { fromRaw, writeRecord, readRecord } = await import('./session-record.js')
    const { configuredSessionApplication } = await import('./session-application.js')
    const { executeQueuedStructuredSession, runStructuredSession } = await import('./session-structured.js')
    const id = sessionIdForCreateKey(requestKey), policy = structuredExecutionPolicy(execution)
    runtimeFixture = join(runtimeRoot(), 'structured-claude-read-only-v1', id)
    cpSync(root, runtimeFixture, { recursive: true }); writeFileSync(join(runtimeFixture, 'plan.json'), JSON.stringify({ ...plan, root: runtimeFixture }))
    configuredSessionApplication().createSession({ sessionId: id, status: 'awaiting', proposal: 'nothing' })
    const record = fromRaw({ session_id: id, governed: true, worktree_path: process.cwd(), branch: null, title: null, name: null, status: 'awaiting', proposal: 'nothing', merges: 0, note: null, sortkey: null, createdAt: 1, stopped: false, archived: false, harness: 'claude-headless', launch_cmd: 'claude', create_request_id: createHash('sha256').update(requestKey).digest('hex'), create_payload_hash: digest({ prompt, parent: null, launcher: null, structuredExecution: policy }) })
    record.structuredExecution = { ...execution, state: 'running', threadId: 'session', turnId: 'user', claudeNative: { ...execution.claudeNative, root: runtimeFixture } }
    record.harnessSessionId = 'session'; writeRecord(record)
    const launch = sessionArtifactPath(id, 'launch'); mkdirSync(join(launch, '..'), { recursive: true }); writeFileSync(launch, prompt)
    assert.equal(await executeQueuedStructuredSession(id), 'failed')
    assert.equal(readRecord(id)?.structuredExecution?.errorCode, 'structured_output_retries_exhausted')
    const request = { root: process.cwd(), prompt, requestKey, ...policy }
    for (let replay = 0; replay < 2; replay++) await assert.rejects(runStructuredSession(request), error => {
      const cause = error as { code: string; sessionId: string; threadId: string; turnId: string }
      assert.equal(cause.code, 'structured_output_retries_exhausted'); assert.equal(cause.sessionId, id); assert.equal(cause.threadId, 'session'); assert.equal(cause.turnId, 'user')
      return true
    })
    const failed = readRecord(id)!
    writeRecord({ ...failed, structuredExecution: { ...failed.structuredExecution!, errorCode: undefined } })
    await assert.rejects(runStructuredSession(request), error => (error as { code: string }).code === 'failed')
    assert.equal(existsSync(join(runtimeFixture, 'completed.json')), false)
  } finally { if (runtimeFixture) rmSync(runtimeFixture, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true }) }
})

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
    const streamed = structuredClone(raw)
    const fragment = assistant('stream-fragment', 'reply-1', 'request-3')
    streamed.splice(streamed.findIndex(item => item.uuid === 'reply-1') + 1, 0, fragment)
    row(streamed, 'consumed-2').parentUuid = 'stream-fragment'
    const inventory = ['preserved-head', 'read-call-1', 'stream-fragment', 'reply-1', 'consumed-2']
    Object.assign(metadata(streamed, 'compact-2').preservedMessages, { uuids: inventory, allUuids: inventory })
    const streamedProof = proveClaudeFrozenReads(ref, witness(streamed))
    assert.equal(streamedProof.receipts.length, 2)
    verifyFrozenReadProof(ref, streamedProof, { threadId: 'session', turnId: 'user' }, undefined, { output: { answer: 'public' } })
    for (const defect of ['missing-interior', 'unconnected-member', 'duplicate-member', 'branch', 'early-boundary'] as const) {
      const bad = structuredClone(streamed), declared = metadata(bad, 'compact-2').preservedMessages
      if (defect === 'missing-interior') Object.assign(declared, { uuids: inventory.filter(id => id !== 'reply-1'), allUuids: inventory.filter(id => id !== 'reply-1') })
      if (defect === 'unconnected-member' || defect === 'duplicate-member') {
        const ids = [...inventory.slice(0, -1), defect === 'duplicate-member' ? 'stream-fragment' : 'read-call-0', inventory.at(-1)!]
        Object.assign(declared, { uuids: ids, allUuids: ids })
      }
      if (defect === 'branch') row(bad, 'consumed-2').parentUuid = 'reply-1'
      if (defect === 'early-boundary') { const index = bad.findIndex(item => item.uuid === 'compact-2'); const [boundary] = bad.splice(index, 1); bad.splice(index - 1, 0, boundary) }
      assert.throws(() => proveClaudeFrozenReads(ref, witness(bad)), { code: 'stale_result' }, defect)
    }
    const enforced = structuredClone(streamed), enforceText = '[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request. Call this tool now.'
    const enforceMessage = { role: 'user', content: enforceText }, enforceHash = claudeMessageDigest({ role: 'user', content: [{ type: 'text', text: enforceText }] })
    enforced.splice(enforced.findIndex(item => item.uuid === 'final'), 0,
      assistant('plain-answer', 'summary-2', 'request-5'),
      { type: 'user', sessionId: 'session', uuid: 'enforce', parentUuid: 'plain-answer', promptId: 'prompt', isMeta: true, message: enforceMessage },
      request('request-enforce', [enforceHash], 'request-5'), { ...request('request-enforce-retry', [], 'request-enforce'), keep: 1 })
    Object.assign(row(enforced, 'final'), { parentUuid: 'enforce', requestRef: 'request-enforce-retry' })
    const enforceProof = proveClaudeFrozenReads(ref, witness(enforced))
    assert.equal(enforceProof.receipts.length, 2)
    verifyFrozenReadProof(ref, enforceProof, { threadId: 'session', turnId: 'user' }, undefined, { output: { answer: 'public' } })
    for (const defect of ['body', 'prompt', 'parent', 'early', 'non-meta', 'fake-companion', 'source', 'missing-api', 'dropped-api', 'old-api', 'other-tool', 'unconsumed', 'duplicate'] as const) {
      const bad = structuredClone(enforced), reminder = row(bad, 'enforce')
      if (defect === 'body') reminder.message = { role: 'user', content: enforceText + ' extra' }
      if (defect === 'prompt') reminder.promptId = 'foreign'
      if (defect === 'parent') reminder.parentUuid = 'summary-2'
      if (defect === 'early') { const index = bad.indexOf(reminder); bad.splice(index, 1); bad.splice(index - 1, 0, reminder) }
      if (defect === 'non-meta') reminder.isMeta = false
      if (defect === 'fake-companion') reminder.turnCompanion = true
      if (defect === 'source') reminder.sourceToolAssistantUUID = 'plain-answer'
      if (defect === 'missing-api') row(bad, 'request-enforce').tail = []
      if (defect === 'dropped-api') row(bad, 'request-enforce-retry').keep = 0
      if (defect === 'duplicate') {
        bad.splice(bad.findIndex(item => item.id === 'request-enforce-retry'), 0, assistant('enforce-empty', 'enforce', 'request-enforce'), { ...reminder, uuid: 'enforce-again', parentUuid: 'enforce-empty' }, request('request-enforce-again', [enforceHash], 'request-enforce'))
        row(bad, 'request-enforce-retry').base = 'request-enforce-again'; row(bad, 'final').parentUuid = 'enforce-again'
      }
      if (defect === 'old-api') row(bad, 'final').requestRef = 'request-5'
      if (defect === 'other-tool') row(bad, 'final').message = { role: 'assistant', content: [{ type: 'tool_use', id: 'schema', name: 'mcp__frozen__spex_read_frozen', input: inputs[1] }] }
      if (defect === 'unconsumed') row(bad, 'final').message = { role: 'assistant', content: [] }
      assert.throws(() => proveClaudeFrozenReads(ref, witness(bad)), { code: 'stale_result' }, defect)
    }
    const forgedEnforce = witness(enforced)
    forgedEnforce.history.find(item => item.uuid === 'enforce')!.isMeta = false
    assert.throws(() => proveClaudeFrozenReads(ref, forgedEnforce), { code: 'stale_result' }, 'raw native enforcement metadata remains authoritative')
    const retried = structuredClone(raw)
    retried.splice(retried.findIndex(item => item.uuid === 'consumed-1'), 0,
      { type: 'attachment', sessionId: 'session', uuid: 'retry-attachment', parentUuid: 'reply-0' },
      { type: 'system', subtype: 'api_error', sessionId: 'session', isSidechain: false, uuid: 'retry-1', parentUuid: 'retry-attachment', source: 'request_retry', level: 'error', retryInMs: 523, retryAttempt: 1, maxRetries: 10, error: { message: 'read ECONNRESET', formatted: 'SYNTHETIC_PRIVATE_ERROR', error: null } },
      { type: 'system', subtype: 'api_error', sessionId: 'session', isSidechain: false, uuid: 'retry-2', parentUuid: 'retry-1', source: 'request_retry', level: 'error', retryInMs: 1000, retryAttempt: 2, maxRetries: 10, error: { message: 'network retry', formatted: 'SYNTHETIC_PRIVATE_ERROR', error: null } })
    const retryBase = row(retried, 'request-2')
    retried.splice(retried.findIndex(item => item.uuid === 'consumed-1'), 0, { ...request('request-2-retry', [], 'request-2'), keep: (retryBase.keep as number) + (retryBase.tail as string[]).length })
    row(retried, 'consumed-1').parentUuid = 'retry-2'
    row(retried, 'consumed-1').requestRef = 'request-2-retry'
    const retryWitness = witness(retried), retryProof = proveClaudeFrozenReads(ref, retryWitness)
    assert.deepEqual(retryProof.coveredEntryIds, proof.coveredEntryIds)
    assert.deepEqual(retryProof.receipts, proof.receipts, 'native retry telemetry grants no read receipts or coverage')
    assert.equal(JSON.stringify(retryWitness.history).includes('SYNTHETIC_PRIVATE_ERROR'), false)
    assert.equal(retryWitness.history.filter(item => item.subtype === 'api_error').length, 2)
    verifyFrozenReadProof(ref, retryProof, { threadId: 'session', turnId: 'user' })
    const changedError = structuredClone(retried)
    const retryError = row(changedError, 'retry-1').error as { formatted: string }
    retryError.formatted = 'changed diagnostic'
    witness(changedError)
    assert.throws(() => verifyFrozenReadProof(ref, retryProof, { threadId: 'session', turnId: 'user' }), /saved public witness differs from original native history/)
    const retryCases: Array<[string, (rows: typeof raw) => void]> = [
      ['foreign retry', rows => { row(rows, 'retry-1').sessionId = 'foreign' }],
      ['sidechain retry', rows => { row(rows, 'retry-1').isSidechain = true }],
      ['agent retry', rows => { row(rows, 'retry-1').agentId = 'foreign' }],
      ['unknown retry source', rows => { row(rows, 'retry-1').source = 'unknown_retry' }],
      ['unknown retry level', rows => { row(rows, 'retry-1').level = 'info' }],
      ['retry skips chain tail', rows => { row(rows, 'retry-1').parentUuid = 'user' }],
      ['retry missing parent', rows => { row(rows, 'retry-1').parentUuid = 'missing' }],
      ['retry duplicate UUID', rows => { row(rows, 'retry-1').uuid = 'reply-0' }],
      ['retry numeric UUID', rows => { row(rows, 'retry-1').uuid = 17; row(rows, 'retry-2').parentUuid = 17 }],
      ['retry numeric tail UUID', rows => { row(rows, 'retry-2').uuid = 17; row(rows, 'consumed-1').parentUuid = 17 }],
      ['retry reordered', rows => { const first = rows.findIndex(item => item.uuid === 'retry-1'); [rows[first], rows[first + 1]] = [rows[first + 1], rows[first]] }],
      ['retry count string', rows => { row(rows, 'retry-1').retryAttempt = '1' }],
      ['retry count zero', rows => { row(rows, 'retry-1').retryAttempt = 0 }],
      ['retry count over maximum', rows => { row(rows, 'retry-1').retryAttempt = 11 }],
      ['retry negative delay', rows => { row(rows, 'retry-1').retryInMs = -1 }],
      ['retry missing error', rows => { delete row(rows, 'retry-1').error }],
      ['retry adds user turn', rows => { rows.splice(rows.findIndex(item => item.uuid === 'consumed-1'), 0, { type: 'user', sessionId: 'session', uuid: 'new-turn', parentUuid: 'retry-2', promptId: 'prompt', message: { role: 'user', content: 'read proof bypass' } }) }],
    ]
    for (const [name, mutate] of retryCases) {
      const changed = structuredClone(retried); mutate(changed)
      assert.throws(() => proveClaudeFrozenReads(ref, witness(changed)), { code: 'stale_result' }, name)
    }
    const sourcePrefix = retried.slice(0, retried.findIndex(item => item.uuid === 'compact-1'))
    witness(sourcePrefix)
    const retrySources = readClaudeApiSourceMetadata(path, 'session', 'MiniMax-M3')
    assert.deepEqual([...retrySources.get('request-2-retry')!.messages], [...retrySources.get('request-2')!.messages], 'the retried API request consumes the exact complete prior input without a new tail')
    const connected = structuredClone(retried)
    row(connected, 'retry-1').source = 'connection_retry'
    row(connected, 'retry-2').source = 'connection_retry'
    const connectionWitness = witness(connected), connectionProof = proveClaudeFrozenReads(ref, connectionWitness)
    assert.deepEqual(connectionProof.receipts, proof.receipts)
    assert.deepEqual(connectionProof.coveredEntryIds, proof.coveredEntryIds)
    verifyFrozenReadProof(ref, connectionProof, { threadId: 'session', turnId: 'user' })
    const connectedPrefix = connected.slice(0, connected.findIndex(item => item.uuid === 'compact-1'))
    witness(connectedPrefix)
    const connectionSources = readClaudeApiSourceMetadata(path, 'session', 'MiniMax-M3')
    assert.deepEqual([...connectionSources.get('request-2-retry')!.messages], [...connectionSources.get('request-2')!.messages])
    const mixedRetry = structuredClone(connected)
    row(mixedRetry, 'retry-2').source = 'request_retry'
    assert.deepEqual(proveClaudeFrozenReads(ref, witness(mixedRetry)).receipts, proof.receipts)
    const connectionCases: Array<[string, (rows: typeof raw) => void]> = [
      ['connection retry without preceding API', rows => { rows.splice(0, rows.length, ...rows.filter(item => item.type !== 'api-request')) }],
      ['connection retry changed complete params', rows => { (row(rows, 'request-2-retry').params as Record<string, unknown>).max_tokens = 8192 }],
      ['connection retry changed full input', rows => { row(rows, 'request-2-retry').tail = [claudeMessageDigest(original)] }],
      ['connection retry changed shape', rows => {
        const shape = structuredClone(rows.find(item => item.type === 'api-request-shape')!)
        shape.shapeHash = 'b'.repeat(64)
        rows.splice(rows.findIndex(item => item.id === 'request-2-retry'), 0, shape)
        row(rows, 'request-2-retry').shapeHash = shape.shapeHash
      }],
      ['connection retry old request consumption', rows => { row(rows, 'consumed-1').requestRef = 'request-2' }],
      ['connection retry future API consumption', rows => {
        const index = rows.findIndex(item => item.id === 'request-2-retry'), [api] = rows.splice(index, 1)
        rows.splice(rows.findIndex(item => item.uuid === 'consumed-1') + 1, 0, api)
      }],
      ['connection retry unconsumed', rows => { rows.splice(rows.findIndex(item => item.uuid === 'consumed-1')) }],
      ['connection retry no new API', rows => { rows.splice(rows.findIndex(item => item.id === 'request-2-retry'), 1) }],
      ['connection retry foreign parent', rows => { row(rows, 'retry-1').parentUuid = 'user' }],
      ['connection retry sidechain', rows => { row(rows, 'retry-1').isSidechain = true }],
      ['connection retry foreign session', rows => { row(rows, 'retry-1').sessionId = 'foreign' }],
      ['connection retry new user', rows => { rows.splice(rows.findIndex(item => item.id === 'request-2-retry'), 0, { type: 'user', sessionId: 'session', uuid: 'injected', parentUuid: 'retry-2', promptId: 'prompt', message: original }) }],
    ]
    for (const [name, mutate] of connectionCases) {
      const changed = structuredClone(connected); mutate(changed)
      assert.throws(() => witness(changed), { code: 'stale_result' }, name)
    }
    const alteredParams = structuredClone(connected)
    ;(row(alteredParams, 'request-2-retry').params as Record<string, unknown>).max_tokens = 8192
    writeFileSync(path, alteredParams.map(item => JSON.stringify(item)).join('\n') + '\n')
    assert.throws(() => proveClaudeFrozenReads(ref, connectionWitness), { code: 'stale_result' }, 'handmade witness cannot bypass raw connection retry payload validation')
    assert.deepEqual(proveClaudeFrozenReads(ref, witness()), proof, 'histories without retries keep the original proof bytes')
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
    assert.throws(() => proveClaudeFrozenReads(ref, rawStringBlob), { code: 'stale_result', message: 'Claude public API message has invalid bytes or type' }, 'raw API strings cannot bypass the observed compact-summary binding')
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

const recoveryVariants = [
  ['truncated-response', 'Your response above was cut off mid-stream. Resume directly from where it stops — no apology, no recap. If none of it survived, answer the request from the start.'],
  ['output-token-limit', 'Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.'],
] as const
for (const [variant, recoveryText] of recoveryVariants) test(`Claude internal ${variant} companions require native flags and a new exact API consumer`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-claude-recovery-'))
  try {
    const prompt = 'public prompt'
    const ref = freezeContext({ directory, sourceRoot: process.cwd(), binding: { requestKey: 'recovery', inputDigest: 'input' }, entries: [{ id: 'task', label: 'task', kind: 'utf8', bytes: Buffer.from('public frozen task') }] })
    const input = { contextDigest: ref.contextDigest, entryId: 'task', startByte: 0, endByte: 18 }
    const original = { role: 'user', content: [{ type: 'text', text: prompt }] }, recoveryMessage = { role: 'user', content: recoveryText }
    const apiRecovery = { role: 'user', content: [{ type: 'text', text: recoveryText }] }, recoveryHash = claudeMessageDigest(apiRecovery)
    const reply = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: readFrozenRange(ref, input).response.contentItems.map(item => ({ type: 'text', text: item.text })) }] }
    const request = (id: string, tail: string[], base?: string, keep = 0) => ({ type: 'api-request', sessionId: 'session', id, shapeHash: 'a'.repeat(64), keep, ...(base ? { base } : {}), tail, params: { model: 'MiniMax-M3' } })
    const assistant = (uuid: string, parentUuid: string, requestRef: string, content: unknown[] = []) => ({ type: 'assistant', sessionId: 'session', uuid, parentUuid, requestRef, message: { role: 'assistant', content, stop_reason: 'max_tokens' } })
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
      ['false companion flag', rows => { row(rows, 'recovery-1').turnCompanion = false }],
      ['string meta flag', rows => { row(rows, 'recovery-1').isMeta = 'true' }],
      ['string flag', rows => { row(rows, 'recovery-1').turnCompanion = 'true' }],
      ['wrong prompt', rows => { row(rows, 'recovery-1').promptId = 'foreign' }],
      ['wrong session', rows => { row(rows, 'recovery-1').sessionId = 'foreign' }],
      ['sidechain', rows => { row(rows, 'recovery-1').isSidechain = true }],
      ['earlier parent', rows => { row(rows, 'recovery-1').parentUuid = 'user' }],
      ['tool-result identity', rows => { row(rows, 'recovery-1').sourceToolAssistantUUID = 'interrupted' }],
      ['unknown text', rows => { row(rows, 'recovery-1').message = { role: 'user', content: 'continue with different business instructions' } }],
      ['suffix', rows => { row(rows, 'recovery-1').message = { role: 'user', content: recoveryText + '\n' } }],
      ['changed whitespace', rows => { row(rows, 'recovery-1').message = { role: 'user', content: recoveryText.replace('Resume directly', 'Resume  directly') } }],
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
    if (variant === 'output-token-limit') cases.push(
      ['missing max_tokens', rows => { delete (row(rows, 'interrupted').message as Record<string, unknown>).stop_reason }],
      ['different stop reason', rows => { (row(rows, 'interrupted').message as Record<string, unknown>).stop_reason = 'end_turn' }],
      ['earlier max_tokens cannot authorize a nonmax parent', rows => {
        rows.splice(rows.findIndex(item => item.uuid === 'interrupted'), 0, assistant('earlier-limit', 'user', 'request-1'))
        row(rows, 'interrupted').parentUuid = 'earlier-limit'; (row(rows, 'interrupted').message as Record<string, unknown>).stop_reason = 'end_turn'
      }],
    )
    for (const [name, mutate] of cases) { const bad = structuredClone(raw); mutate(bad); assert.throws(() => proveClaudeFrozenReads(ref, witness(bad)), name) }
    const human = structuredClone(raw)
    human.push({ type: 'user', sessionId: 'session', uuid: 'human', parentUuid: 'schema-reply', promptId: 'prompt', message: { role: 'user', content: 'another human request' } })
    assert.throws(() => proveClaudeFrozenReads(ref, witness(human)), /another user turn/)
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
    const otherText = recoveryVariants.find(([name]) => name !== variant)![1]
    const otherApi = { role: 'user', content: [{ type: 'text', text: otherText }] }, otherHash = claudeMessageDigest(otherApi)
    for (const content of [otherApi.content, [{ type: 'text', text: prompt + '\n' }, ...otherApi.content]]) {
      const swapped = structuredClone(raw), blob = swapped.find(item => item.type === 'api-request-blob')!
      blob.message = { role: 'user', content }; blob.hash = claudeMessageDigest(blob.message); row(swapped, 'request-2').tail = [blob.hash]
      assert.throws(() => proveClaudeFrozenReads(ref, witness(swapped)), /unobserved text/, 'an allowed but unobserved variant cannot substitute the actual companion text')
    }
    const mixed = structuredClone(raw)
    mixed.splice(mixed.findIndex(item => item.uuid === 'read-call'), 0,
      assistant('interrupted-2', 'recovery-1', 'request-2'),
      { ...companion('recovery-2', 'interrupted-2'), message: { role: 'user', content: otherText } },
      { type: 'api-request-blob', sessionId: 'session', message: otherApi, hash: otherHash }, request('request-2b', [otherHash], 'request-2', 1))
    row(mixed, 'read-call').parentUuid = 'recovery-2'; row(mixed, 'read-call').requestRef = 'request-2b'; row(mixed, 'request-3').base = 'request-2b'
    assert.deepEqual(proveClaudeFrozenReads(ref, witness(mixed)).coveredEntryIds, ['task'])
    const mixedBorrowed = structuredClone(mixed); row(mixedBorrowed, 'request-2b').tail = [recoveryHash]
    assert.throws(() => proveClaudeFrozenReads(ref, witness(mixedBorrowed)), /no new exact actual API consumer/, 'a different later variant cannot inherit the earlier variant API hash')
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
    if (variant === 'output-token-limit') {
      const nonmax = structuredClone(raw); (row(nonmax, 'interrupted').message as Record<string, unknown>).stop_reason = 'end_turn'
      writeFileSync(nativePath, nonmax.map(item => JSON.stringify(item)).join('\n') + '\n')
      assert.throws(() => proveClaudeFrozenReads(ref, valid), /preceding max_tokens/, 'a directly supplied witness cannot hide a nonmax raw parent omitted from the public projection')
    }
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
    const terminalRequest = { version: 1, reason: 'terminal_settlement', sessionId: 'session', userUuid: 'user', pid: child.pid, receiptDigest: digest(JSON.parse(readFileSync(receiptFile, 'utf8'))), requestDigest: plan.requestDigest, resultDigest: digest(witness.result), signal: 'SIGTERM', requestedAt: 1 }
    writeFileSync(join(root, 'terminal-stop-request.json'), JSON.stringify(terminalRequest))
    writeFileSync(join(root, 'terminal-stop.json'), JSON.stringify({ version: 1, requestObservationDigest: digest(terminalRequest), outcome: 'sent', observedAt: 2 }))
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
    writeFileSync(join(root, 'mcp-public.jsonl'), JSON.stringify({ type: 'process', pid: child.pid, startToken: processIdentity.startToken }) + '\n')
    writeFileSync(join(root, 'init.json'), JSON.stringify({ session_id: 'session', model: 'MiniMax-M3' }))
    writeFileSync(join(root, 'user-echo.json'), JSON.stringify(witness.echo)); writeFileSync(join(root, 'result.json'), JSON.stringify(witness.result))
    await assert.rejects(claudeStructuredTurn(realm, 'native', witness.prompt, execution, callbacks), { code: 'failed' }, 'uncached frozen success cannot bypass a new sent observation')
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


test('native CLI configuration accepts opaque selections and omits --model for default', () => {
  for (const model of ['sonnet', 'opus', 'haiku', 'provider/model[1m]', 'a model;$(never-shell)']) {
    assert.equal(claudeNativeModel(`claude:${model}`, 'cli-config-v1'), model)
    const args = claudeWorktreeArgs({ sessionId: 'session', model, schema: {}, nativeConfiguration: 'cli-config-v1' })
    assert.equal(args[args.indexOf('--model') + 1], model)
    for (const flag of ['--setting-sources', '--settings', '--strict-mcp-config', '--mcp-config', '--restricted', '--tools']) assert(!args.includes(flag))
  }
  assert(!claudeWorktreeArgs({ sessionId: 'session', model: 'default', schema: {}, nativeConfiguration: 'cli-config-v1' }).includes('--model'))
  for (const model of ['claude:', 'claude:   ', 'claude:a\0b', 'codex:model']) assert.throws(() => claudeNativeModel(model, 'cli-config-v1'))
})

for (const [selected, configMode, outcome] of [['default', 'unset', 'success'], ['default', 'empty', 'success'], ['sonnet', 'explicit', 'success'], ['provider/opaque[1m]', 'explicit', 'success'], ['provider/opaque[1m]', 'explicit', 'controlled-success-143'], ['provider/opaque[1m]', 'explicit', 'controlled-cancel-after-term'], ['provider/opaque[1m]', 'explicit', 'periodic-recovered'], ['provider/opaque[1m]', 'explicit', 'periodic-expired'], ['provider/opaque[1m]', 'explicit', 'periodic-cancelled'], ['provider/opaque[1m]', 'explicit', 'periodic-final-pending'], ['provider/opaque[1m]', 'explicit', 'periodic-error'], ['provider/opaque[1m]', 'explicit', 'periodic-error-stop-unknown'], ['provider/opaque[1m]', 'explicit', 'periodic-result-first'], ['any/alias + context', 'explicit', 'schema-exhaustion']] as const) test(`native CLI configuration fixture preserves configuration and model observations for ${selected}/${configMode}/${outcome}`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-claude-native-config-')), bin = join(directory, 'bin'), config = selected === 'default' ? join(directory, 'home', '.claude') : join(directory, 'native-config'), workspace = join(directory, 'worktree'), realm = join(directory, 'realm'), root = join(realm, 'native')
  const identityKeys = [...new Set(['SPEXCODE_SESSION_ID', ...HARNESS_IDENTITIES.map(harness => harness.sessionEnvVar)])].filter(Boolean)
  const environmentKeys = [...identityKeys, 'PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_MODEL', 'ANTHROPIC_BASE_URL', 'PUBLIC_CLAUDE_FIXTURE_LOG'] as const
  const before = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]))
  const periodic = outcome.startsWith('periodic-'), release = join(directory, 'release-result')
  const controlled = outcome.startsWith('controlled-') || outcome === 'periodic-recovered', lateCancel = outcome === 'controlled-cancel-after-term', controller = new AbortController()
  let fixtureNative: StructuredExecution['claudeNative']
  const watchdog = periodic ? setTimeout(() => controller.abort(), 45_000) : undefined
  try {
    mkdirSync(bin); mkdirSync(config, { recursive: true }); mkdirSync(workspace)
    childProcess.execFileSync('git', ['init', '-q'], { cwd: workspace, stdio: 'pipe' })
    writeFileSync(join(config, 'settings.json'), 'UNPARSEABLE_PUBLIC_FIXTURE_SETTINGS')
    const log = join(directory, 'observed.json'), cli = join(bin, 'claude'), actualModel = 'native-provider/resolved-model'
    const usageModels = configMode === 'empty' ? undefined : {
      main: { inputTokens: 700, outputTokens: 23, cacheReadInputTokens: 91, cacheCreationInputTokens: 0, costUSD: 99, unretained: 'SYNTHETIC_USAGE_METADATA' },
      helper: { inputTokens: 100, outputTokens: 4, ...(selected === 'sonnet' ? { cacheReadInputTokens: -9 } : { cacheReadInputTokens: 9, cacheCreationInputTokens: 0 }) },
    }
    const expectedUsage = usageModels && {
      source: 'claude-model-usage', uncachedInputTokens: 800, outputTokens: 27,
      ...(selected === 'sonnet' ? {} : { cacheReadInputTokens: 100, cacheWriteInputTokens: 0 }),
    }
    writeFileSync(cli, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
if(process.argv.includes('--version')){console.log('9.8.7 (Claude Code)');process.exit(0)}
const exhausted=${JSON.stringify(outcome === 'schema-exhaustion')},output=exhausted?{ok:'bad'}:{ok:true};const args=process.argv.slice(2);fs.writeFileSync(process.env.PUBLIC_CLAUDE_FIXTURE_LOG,JSON.stringify({args,config:process.env.CLAUDE_CONFIG_DIR,provider:process.env.CLAUDE_CODE_USE_BEDROCK,model:process.env.ANTHROPIC_MODEL,baseUrl:process.env.ANTHROPIC_BASE_URL,identity:Object.fromEntries(${JSON.stringify(identityKeys)}.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]])),store:{SPEXCODE_HOME:process.env.SPEXCODE_HOME,SPEX_SESSION_DATABASE_PATH:process.env.SPEX_SESSION_DATABASE_PATH}}));
const emit=x=>console.log(JSON.stringify(x));
readline.createInterface({input:process.stdin}).on('line',line=>{
  const input=JSON.parse(line);
  if(input.type==='control_request'){
    fs.writeFileSync(${JSON.stringify(join(directory, 'fixture-interrupted'))},'true');
    process.exit(0);
  }
  if(input.type!=='user')return;
  const session=input.session_id,user=input.uuid;const projects=path.join(process.env.CLAUDE_CONFIG_DIR||path.join(process.env.HOME,'.claude'),'projects','fixture');fs.mkdirSync(projects,{recursive:true});const history=[{type:'user',sessionId:session,uuid:user,parentUuid:null,promptId:'public-prompt',message:input.message},{type:'api-request',sessionId:session,id:'wire-request',params:{model:'wire-provider/actual-id'}},{type:'assistant',sessionId:session,uuid:'assistant',parentUuid:user,requestRef:'wire-request',message:{role:'assistant',content:[{type:'thinking',thinking:'SYNTHETIC_PRIVATE_THINKING'},{type:'tool_use',id:'final',name:'StructuredOutput',input:output}]}}];if(exhausted)history.push({type:'user',sessionId:session,uuid:'schema-error',parentUuid:'assistant',promptId:'public-prompt',sourceToolAssistantUUID:'assistant',message:{role:'user',content:[{type:'tool_result',tool_use_id:'final',is_error:true,content:'Output does not match required schema: /ok: must be boolean'}]}});fs.writeFileSync(path.join(projects,session+'.jsonl'),history.map(x=>JSON.stringify(x)).join('\\n')+'\\n');emit({type:'system',subtype:'init',session_id:session,model:${JSON.stringify(actualModel)},tools:['Read','Bash','StructuredOutput']});emit({type:'user',uuid:user,session_id:session,message:input.message});const finish=()=>{emit({type:'result',subtype:exhausted?'error_max_structured_output_retries':'success',is_error:exhausted,session_id:session,user_message_uuid:user,user_message_uuids:[user],...(exhausted?{}:{structured_output:output}),modelUsage:${JSON.stringify(usageModels)},usage:{input_tokens:5000,output_tokens:999}});process.exitCode=exhausted?1:0;if(${controlled}){process.stdin.once('end',()=>fs.writeFileSync(${JSON.stringify(join(directory, 'stdin-ended'))},'true'));setInterval(()=>{},1000);process.on('SIGTERM',()=>{if(!${lateCancel})process.exit(143);fs.writeFileSync(${JSON.stringify(join(directory, 'term-received'))},'true');setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(directory, 'allow-exit'))}))process.exit(143)},10)})}};
  if(${periodic}){
    const waiting=setInterval(()=>{
      if(fs.existsSync(${JSON.stringify(release)})){
        clearInterval(waiting);
        finish();
      }
    },10);
  }else finish();
});
`)
    chmodSync(cli, 0o755)
    process.env.PATH = `${bin}:${before.PATH}`; process.env.HOME = join(directory, 'home'); if (configMode === 'unset') delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = configMode === 'empty' ? '' : config; process.env.CLAUDE_CODE_USE_BEDROCK = '1'; process.env.ANTHROPIC_MODEL = 'native-user-default'; process.env.ANTHROPIC_BASE_URL = 'https://public-provider.invalid/arbitrary-route'; process.env.PUBLIC_CLAUDE_FIXTURE_LOG = log
    for (const key of identityKeys) process.env[key] = `PUBLIC_PARENT_${key}`
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
    let execution: StructuredExecution = { ...structuredExecutionPolicy({ schema, inputDigest: 'fixture', purpose: 'native-config-fixture', timeoutMs: controlled || periodic ? null : 10000, model: `claude:${selected}`, worktree: { baseCommit: 'a'.repeat(40), tree: 'b'.repeat(40), mode: 'read' } }), nativeConfiguration: 'cli-config-v1' }
    const callbacks = { signal: controller.signal, onThread: async (threadId: string) => { execution = { ...execution, threadId } }, onTurn: async (turnId: string) => { execution = { ...execution, turnId } }, onNative: async (claudeNative: NonNullable<StructuredExecution['claudeNative']>) => { fixtureNative = claudeNative; execution = { ...execution, claudeNative } } }
    let rejectedProbes = 0, finalProbes = 0, heldForResult = false
    const samplingError = new Error('fixture periodic observer exception')
    const observations: { status: string; elapsedMs: number }[] = []
    if (periodic) {
      const spawnOriginal = spawn
      t.mock.method(childProcess, 'spawn', (file: string, args: readonly string[], options: SpawnOptions) => {
        if (file === '/bin/ps' && args[1] === 'uid=,pid=,ppid=,lstart=' && execution.turnId) {
          const resultPath = join(root, 'result.json')
          const expired = observations.some(({ status }) => status === 'expired')
          if (existsSync(resultPath)) finalProbes++
          if (outcome === 'periodic-result-first' && !heldForResult) {
            heldForResult = true
            writeFileSync(release, 'true')
            return spawnOriginal(process.execPath, ['-e', `
const { existsSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const waiting = setInterval(() => {
  if (!existsSync(process.argv[1])) return
  clearInterval(waiting)
  process.stdout.write(execFileSync('/bin/ps', process.argv.slice(2)))
}, 5)
`, resultPath, ...args], options)
          }
          if (!rejectedProbes || outcome === 'periodic-expired' && !expired || outcome === 'periodic-final-pending' || outcome === 'periodic-error-stop-unknown') {
            rejectedProbes++
            if (outcome === 'periodic-error-stop-unknown' && rejectedProbes > 1) throw new Error('fixture later stop observation exception')
            if (outcome === 'periodic-error' || outcome === 'periodic-error-stop-unknown' || outcome === 'periodic-result-first') throw samplingError
            return spawnOriginal(process.execPath, ['-e', 'process.exit(7)'], options)
          }
        }
        return spawnOriginal(file, args, options)
      })
      syncBuiltinESMExports()
      const warn = console.warn
      t.mock.method(console, 'warn', (label: string, data: string) => {
        if (label !== 'spex claude periodic observation') { warn(label, data); return }
        const observation = JSON.parse(data) as { status: string; elapsedMs: number }
        assert.deepEqual(Object.keys(observation).sort(), ['elapsedMs', 'status'])
        observations.push(observation)
        if (observation.status === 'pending' && outcome === 'periodic-cancelled') controller.abort()
        if (observation.status === 'recovered' || observation.status === 'pending' && outcome === 'periodic-final-pending') writeFileSync(release, 'true')
      })
    }
    const pending = claudeStructuredTurn(realm, 'native', 'public native config task', execution, callbacks, workspace)
    if (periodic && outcome !== 'periodic-recovered' && outcome !== 'periodic-result-first') {
      if (outcome === 'periodic-expired') {
        await assert.rejects(pending, { code: 'failed', message: 'native worktree process observation remains unproven' })
        assert(rejectedProbes > 1)
        assert.deepEqual(observations.map(({ status }) => status), ['pending', 'expired'])
        assert(observations[1].elapsedMs >= 10_000 && observations[1].elapsedMs < 12_000)
      } else if (outcome === 'periodic-cancelled') {
        await assert.rejects(pending, { code: 'cancelled' })
        assert.deepEqual(observations.map(({ status }) => status), ['pending'])
        assert(existsSync(join(directory, 'fixture-interrupted')))
      } else if (outcome === 'periodic-final-pending') {
        await assert.rejects(pending, { code: 'cancellation_pending' })
        assert.deepEqual(observations.map(({ status }) => status), ['pending'])
        assert(existsSync(join(root, 'result.json')))
        assert(finalProbes > 0, 'the final stop must take a fresh observation')
      } else if (outcome === 'periodic-error-stop-unknown') {
        await assert.rejects(pending, { code: 'cancellation_pending', message: samplingError.message })
        assert(rejectedProbes > 1)
        assert.deepEqual(observations, [])
      } else {
        await assert.rejects(pending, { code: 'failed', message: samplingError.message, cause: samplingError })
        assert.deepEqual(observations, [])
      }
      assert.equal(existsSync(join(root, 'interrupt-request.json')), outcome === 'periodic-cancelled')
      assert(!existsSync(join(root, 'completed.json')))
      if (outcome === 'periodic-expired' || outcome === 'periodic-error') {
        const { code, signal, stopped } = JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8')) as { code: number | null; signal: string; stopped: boolean }
        assert.deepEqual({ code, signal, stopped }, { code: null, signal: 'SIGTERM', stopped: true })
      }
      console.log(JSON.stringify({ scenario: outcome, observations, rejectedProbes, finalProbes }))
      return
    }
    if (lateCancel) {
      const outcome = pending.then(value => ({ value }), error => ({ error: error as { code: string } }))
      const term = join(directory, 'term-received'), ready = Date.now() + 15000
      while (!existsSync(term) && Date.now() < ready) await new Promise(resolve => setTimeout(resolve, 10))
      assert(existsSync(term)); assert(existsSync(join(directory, 'stdin-ended')))
      const stop = readFileSync(join(root, 'terminal-stop.json'))
      assert.equal(JSON.parse(stop.toString('utf8')).outcome, 'sent')
      controller.abort(); writeFileSync(join(directory, 'allow-exit'), 'true')
      const ended = await outcome
      assert('error' in ended); assert.equal(ended.error.code, 'cancelled')
      assert(existsSync(join(root, 'interrupt-request.json')), 'closed stdin must still retain the external cancellation intent')
      assert(!existsSync(join(root, 'interrupt-ack.json')))
      assert(!existsSync(join(root, 'completed.json')))
      const noDispatch = { onThread: async () => assert.fail('no new thread'), onTurn: async () => assert.fail('no new turn'), onNative: async () => assert.fail('no new CLI') }
      await assert.rejects(claudeStructuredTurn(realm, 'native', 'public native config task', { ...execution, state: 'running' }, noDispatch, workspace))
      assert(!existsSync(join(root, 'completed.json')))
      assert.deepEqual(readFileSync(join(root, 'terminal-stop.json')), stop)
      return
    }
    if (outcome === 'schema-exhaustion') {
      await assert.rejects(pending, error => {
        assert.equal((error as { code: string }).code, 'structured_output_retries_exhausted')
        assert.equal((error as { rejectedOutput: { text: string } }).rejectedOutput.text, JSON.stringify({ ok: 'bad' }))
        assert.deepEqual((error as { nativeTokenUsage?: unknown }).nativeTokenUsage, expectedUsage)
        return true
      })
      const plan = JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8')) as { requestedModel: string; resolvedModel: string }
      assert.equal(plan.requestedModel, `claude:${selected}`); assert.equal(plan.resolvedModel, actualModel)
      const snapshot = JSON.parse(readFileSync(join(root, 'public-history.json'), 'utf8')) as { history: ClaudePublicRecord[] }
      assert.equal(snapshot.history.find(row => row.type === 'api-request')?.model, 'wire-provider/actual-id')
      assert(!existsSync(join(root, 'completed.json')))
      const noDispatch = { onThread: async () => assert.fail('no new thread'), onTurn: async () => assert.fail('no new turn'), onNative: async () => assert.fail('no new CLI') }
      await assert.rejects(claudeStructuredTurn(realm, 'native', 'public native config task', execution, noDispatch, workspace), { code: 'structured_output_retries_exhausted' })
      return
    }
    const result = await pending
    if (periodic) {
      assert.equal(rejectedProbes, 1)
      assert(finalProbes > 0)
      assert.deepEqual(observations.map(({ status }) => status), outcome === 'periodic-result-first' ? [] : ['pending', 'recovered'])
      assert(!existsSync(join(directory, 'fixture-interrupted')))
      assert(!existsSync(join(root, 'interrupt-request.json')))
      console.log(JSON.stringify({ scenario: outcome, observations, rejectedProbes, finalProbes }))
    }
    if (controlled) {
      const { code, signal, stopped } = JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8')) as { code: number; signal: string | null; stopped: boolean }
      assert.deepEqual({ code, signal, stopped }, { code: 143, signal: null, stopped: true })
      assert.equal(JSON.parse(readFileSync(join(root, 'terminal-stop.json'), 'utf8')).outcome, 'sent')
    }
    assert.deepEqual(JSON.parse(result.text), { ok: true }); assert.equal(result.frozenReadProof, undefined)
    assert.deepEqual('nativeTokenUsage' in result ? result.nativeTokenUsage : undefined, expectedUsage)
    const terminal = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')) as Record<string, unknown>
    assert.deepEqual(terminal.nativeTokenUsage, expectedUsage)
    assert(!Object.hasOwn(terminal, 'modelUsage'))
    assert(!Object.hasOwn(terminal, 'usage'))
    assert.equal(execution.model, `claude:${selected}`)
    const observed = JSON.parse(readFileSync(log, 'utf8')) as { args: string[]; config?: string; provider: string; model: string; baseUrl: string; identity: Record<string, string>; store: Record<string, string | undefined> }
    assert.equal(observed.config, configMode === 'unset' ? undefined : configMode === 'empty' ? '' : config); assert.equal(observed.provider, '1'); assert.equal(observed.model, 'native-user-default'); assert.equal(observed.baseUrl, 'https://public-provider.invalid/arbitrary-route')
    assert.deepEqual(observed.identity, { SPEXCODE_SESSION_ID: 'native' })
    assert.deepEqual(observed.store, { SPEXCODE_HOME: process.env.SPEXCODE_HOME, SPEX_SESSION_DATABASE_PATH: process.env.SPEX_SESSION_DATABASE_PATH })
    assert.equal(observed.args.includes('--model'), selected !== 'default')
    if (selected !== 'default') assert.equal(observed.args[observed.args.indexOf('--model') + 1], selected)
    const plan = JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8')) as { version: number; cliVersion: string; binaryDigest: string; requestedModel: string; resolvedModel: string; historyDigest: string }
    assert.equal(plan.version, 2); assert.equal(plan.cliVersion, '9.8.7 (Claude Code)'); assert.match(plan.binaryDigest, /^[a-f0-9]{64}$/)
    assert.equal(plan.requestedModel, `claude:${selected}`); assert.equal(plan.resolvedModel, actualModel)
    const snapshot = readFileSync(join(root, 'public-history.json'), 'utf8'); assert(!snapshot.includes('SYNTHETIC_PRIVATE_THINKING'))
    if (configMode === 'unset') {
      const { sessionArtifactPath } = await import('@spexcode/spec-core')
      const { fromRaw, writeRecord, readRecord } = await import('./session-record.js')
      const { configuredSessionApplication } = await import('./session-application.js')
      const { executeQueuedStructuredSession } = await import('./session-structured.js')
      const git = (...args: string[]) => childProcess.execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim()
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'seed')
      const id = 'f9a673a2-28e1-4e8e-9ae0-6f8b56e0d66b', prompt = 'measure the canonical result'
      const policy = structuredExecutionPolicy({ ...execution, worktree: { baseCommit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), mode: 'read' } })
      configuredSessionApplication().createSession({ sessionId: id, status: 'queued' })
      const record = fromRaw({ session_id: id, governed: true, worktree_path: workspace, branch: null, title: null, name: null, status: 'queued', proposal: null, merges: 0, note: null, sortkey: null, createdAt: 1, stopped: false, archived: false, harness: 'claude-headless', launch_cmd: 'claude' })
      writeRecord({ ...record, structuredExecution: policy })
      const launch = sessionArtifactPath(id, 'launch')
      mkdirSync(dirname(launch), { recursive: true }); writeFileSync(launch, prompt)
      assert.equal(await executeQueuedStructuredSession(id), 'completed')
      const saved = readRecord(id)?.structuredExecution
      assert.deepEqual(saved?.nativeTokenUsage, expectedUsage)
      assert.deepEqual(saved?.output, { ok: true })
      assert.deepEqual(structuredExecutionPolicy(saved!), policy)
      assert.equal(await executeQueuedStructuredSession(id), 'completed')
      assert.deepEqual(readRecord(id)?.structuredExecution, saved)
    }
    execution = { ...execution, state: 'completed', output: { ok: true }, resultDigest: createHash('sha256').update(JSON.stringify({ ok: true })).digest('hex') }
    rmSync(config, { recursive: true }); rmSync(bin, { recursive: true }); process.env.CLAUDE_CONFIG_DIR = join(directory, 'different-config')
    const noDispatch = { onThread: async () => assert.fail('cold replay must not dispatch'), onTurn: async () => assert.fail('cold replay must not append'), onNative: async () => assert.fail('cold replay must not launch') }
    assert.deepEqual(await claudeStructuredTurn(realm, 'native', 'public native config task', execution, noDispatch, workspace), result)
    const originalInit = readFileSync(join(root, 'init.json'))
    chmodSync(join(root, 'init.json'), 0o600)
    writeFileSync(join(root, 'init.json'), JSON.stringify({ session_id: execution.threadId, model: 'forged-model', tools: ['Read'] }))
    await assert.rejects(claudeStructuredTurn(realm, 'native', 'public native config task', execution, noDispatch, workspace), { code: 'stale_result' })
    writeFileSync(join(root, 'init.json'), originalInit)
    await assert.rejects(claudeStructuredTurn(realm, 'native', 'changed prompt', execution, noDispatch, workspace), { code: 'stale_result' })
    await assert.rejects(claudeStructuredTurn(realm, 'native', 'public native config task', { ...execution, claudeNative: { ...execution.claudeNative!, userUuid: 'foreign-user' } }, noDispatch, workspace), { code: 'stale_result' })
    await assert.rejects(claudeStructuredTurn(realm, 'native', 'public native config task', { ...execution, model: 'claude:changed-request' }, noDispatch, workspace), { code: 'stale_result' })
    chmodSync(join(root, 'public-history.json'), 0o600)
    for (const changed of [snapshot.replace('public-prompt', 'forged-prompt'), snapshot.replace('wire-provider/actual-id', 'other-wire-model'), snapshot.replace('wire-request', 'foreign-request')]) {
      writeFileSync(join(root, 'public-history.json'), changed)
      await assert.rejects(claudeStructuredTurn(realm, 'native', 'public native config task', execution, noDispatch, workspace), { code: 'stale_result' })
    }
    const planBytes = readFileSync(join(root, 'plan.json')), changedHistory = JSON.parse(snapshot.replace('wire-provider/actual-id', 'other-wire-model')) as { history: ClaudePublicRecord[] }
    writeFileSync(join(root, 'public-history.json'), JSON.stringify(changedHistory))
    writeFileSync(join(root, 'plan.json'), JSON.stringify({ ...JSON.parse(planBytes.toString('utf8')), historyDigest: createHash('sha256').update(JSON.stringify(changedHistory.history)).digest('hex') }))
    await assert.rejects(claudeStructuredTurn(realm, 'native', 'public native config task', execution, noDispatch, workspace), { code: 'stale_result' })
  } finally {
    if (watchdog) clearTimeout(watchdog)
    if (periodic) { t.mock.restoreAll(); syncBuiltinESMExports() }
    if ((controlled || periodic) && fixtureNative?.pid && fixtureNative.receiptFile && verifyDetachedRuntime(fixtureNative.pid, fixtureNative.receiptFile).ok) {
      try { process.kill(-fixtureNative.pid, 'SIGKILL') } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH') }
    }
    for (const key of environmentKeys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]
    rmSync(directory, { recursive: true, force: true })
  }
})


test('native configuration schema exhaustion authenticates per-request wire models and preserves rejected output', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-claude-native-config-schema-')), realm = join(directory, 'realm'), root = join(realm, 'native'), workspace = join(directory, 'workspace')
  mkdirSync(root, { recursive: true }); mkdirSync(workspace)
  const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const prompt = 'public schema task', model = 'provider/actual-model', selection = 'arbitrary/selection + context', rejected = { ok: 'bad' }
  try {
    await sampleNativeWorktreeProcesses({ root, receiptFile: join(root, 'process.json'), workspace })
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { detached: true, stdio: 'ignore' })
    assert(child.pid)
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    const receiptFile = join(root, 'process.json'); writeDetachedRuntimeReceipt(child.pid, receiptFile)
    process.kill(-child.pid, 'SIGTERM'); await closed
    const native = { version: 2 as const, root, sessionId: 'session', userUuid: 'user', pid: child.pid, receiptFile }
    const execution: StructuredExecution = { ...structuredExecutionPolicy({ schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, inputDigest: 'fixture', purpose: 'native-schema-fixture', timeoutMs: null, model: 'claude:sonnet', worktree: { baseCommit: 'a'.repeat(40), tree: 'b'.repeat(40), mode: 'read' } }), nativeConfiguration: 'cli-config-v1', claudeNative: native }
    const policy = structuredExecutionPolicy(execution), message = { role: 'user', content: [{ type: 'text', text: prompt }] }
    const history = [
      { type: 'user', sessionId: 'session', uuid: 'user', parentUuid: null, promptId: 'prompt', message },
      { type: 'api-request', sessionId: 'session', id: 'request', model },
      { type: 'assistant', sessionId: 'session', uuid: 'call', parentUuid: 'user', requestRef: 'request', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'schema', name: 'StructuredOutput', input: rejected }] } },
      { type: 'user', sessionId: 'session', uuid: 'reply', parentUuid: 'call', promptId: 'prompt', sourceToolAssistantUUID: 'call', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'schema', is_error: true, content: 'Output does not match required schema: /ok: must be boolean' }] } },
      { type: 'api-request', sessionId: 'session', id: 'request-2', model: 'another-provider/wire-routing-id' },
      { type: 'assistant', sessionId: 'session', uuid: 'call-2', parentUuid: 'reply', requestRef: 'request-2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'schema-2', name: 'StructuredOutput', input: rejected }] } },
      { type: 'user', sessionId: 'session', uuid: 'reply-2', parentUuid: 'call-2', promptId: 'prompt', sourceToolAssistantUUID: 'call-2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'schema-2', is_error: true, content: 'Output does not match required schema: /ok: must be boolean' }] } },
    ]
    const plan = { ...native, workspace, cliVersion: 'future-native-version', requestedModel: execution.model, resolvedModel: selection, historyDigest: hash(history), policyDigest: hash(policy), requestDigest: hash({ prompt, policy }) }
    const init = { session_id: 'session', model: selection, tools: ['Read', 'StructuredOutput'] }, echo = { session_id: 'session', uuid: 'user', message }, result = { type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, session_id: 'session', user_message_uuid: 'user', user_message_uuids: ['user'] }
    for (const [name, value] of Object.entries({ 'plan.json': plan, 'init.json': init, 'user-echo.json': echo, 'result.json': result, 'exit.json': { code: 1, signal: null, stopped: true }, 'public-history.json': { version: 1, sessionId: 'session', history } })) writeFileSync(join(root, name), JSON.stringify(value))
    const noDispatch = { onThread: async () => assert.fail('no new session'), onTurn: async () => assert.fail('no new prompt'), onNative: async () => assert.fail('no new CLI') }
    for (let replay = 0; replay < 2; replay++) await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, noDispatch, workspace), error => {
      assert.equal((error as { code: string }).code, 'structured_output_retries_exhausted')
      assert.match(String(error), /schema.*must be boolean/)
      assert.equal((error as { rejectedOutput: { text: string } }).rejectedOutput.text, JSON.stringify(rejected))
      return true
    })
    assert.equal(execution.model, 'claude:sonnet'); assert(!existsSync(join(root, 'completed.json')))
    for (const mutate of [
      (rows: ClaudePublicRecord[]) => { delete rows[1].model },
      (rows: ClaudePublicRecord[]) => { rows[2].requestRef = 'foreign-request' },
      (rows: ClaudePublicRecord[]) => { contentBlocks(rows[3].message!)[0].tool_use_id = 'foreign-call' },
    ]) {
      const foreign: ClaudePublicRecord[] = structuredClone(history); mutate(foreign)
      writeFileSync(join(root, 'public-history.json'), JSON.stringify({ version: 1, sessionId: 'session', history: foreign }))
      writeFileSync(join(root, 'plan.json'), JSON.stringify({ ...plan, historyDigest: hash(foreign) }))
      await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, noDispatch, workspace), { code: 'stale_result' })
    }
    writeFileSync(join(root, 'public-history.json'), JSON.stringify({ version: 1, sessionId: 'session', history })); writeFileSync(join(root, 'plan.json'), JSON.stringify(plan))
    writeFileSync(join(root, 'init.json'), JSON.stringify({ ...init, model: undefined }))
    await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, noDispatch, workspace), { code: 'stale_result' })
    const stopped: StructuredExecution = { ...execution, worktree: { ...execution.worktree!, mode: 'edit' }, state: 'cancelled', threadId: 'session', turnId: 'user', cancellation: { reason: 'cancelled', requestedAt: 1, nativeStopped: true, acknowledged: false, nativeStatus: 'processGroupGone' } }
    const editPolicy = structuredExecutionPolicy(stopped), editPlan = { ...plan, policyDigest: hash(editPolicy), requestDigest: hash({ prompt, policy: editPolicy }) }
    for (const [name, value] of Object.entries({ 'plan.json': editPlan, 'init.json': init, 'result.json': { ...result, subtype: 'success', is_error: false }, 'exit.json': { code: 0, signal: null, stopped: true } })) writeFileSync(join(root, name), JSON.stringify(value))
    const paths = ['plan.json', 'init.json', 'user-echo.json', 'result.json', 'exit.json', 'public-history.json'], before = paths.map(name => readFileSync(join(root, name)))
    assertClaudeStoppedDraftSource(prompt, stopped, workspace)
    assert.equal(observeClaudeWorktreeMissingFinal(prompt, stopped, workspace).code, 'structured_output_format_invalid')
    assert.deepEqual(paths.map(name => readFileSync(join(root, name))), before, 'v2新观察只读原已封存字节')
    rmSync(join(root, 'public-history.json'))
    assert.throws(() => observeClaudeWorktreeMissingFinal(prompt, stopped, workspace), { code: 'stale_result' })
    assert.equal(existsSync(join(root, 'public-history.json')), false, '缺sealed history不得补封存旧原件')
    assert.deepEqual(readFileSync(join(root, 'plan.json')), before[0]); assert.equal(existsSync(join(root, 'completed.json')), false)
    const errorResult = { ...result, subtype: 'success', is_error: true }
    writeFileSync(join(root, 'result.json'), JSON.stringify(errorResult)); writeFileSync(join(root, 'exit.json'), JSON.stringify({ code: 1, signal: null, stopped: true }))
    const beforeFailureObservation = ['plan.json', 'init.json', 'user-echo.json', 'result.json', 'exit.json'].map(name => readFileSync(join(root, name)))
    assert.equal(observeClaudeStoppedWorktreeFailure(prompt, stopped, workspace), undefined, '明确错误终态仅续Git材料，不给格式码')
    assert.throws(() => observeClaudeWorktreeMissingFinal(prompt, stopped, workspace), { code: 'stale_result' }, '原精准missing-final资格不扩展到exit1/error')
    assert.deepEqual(['plan.json', 'init.json', 'user-echo.json', 'result.json', 'exit.json'].map(name => readFileSync(join(root, name))), beforeFailureObservation)
    assert.equal(existsSync(join(root, 'public-history.json')), false); assert.equal(existsSync(join(root, 'native-protocol.jsonl')), false, '冷观察不补安全诊断或sealed原件')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})


for (const close of [{ code: 143, signal: null }, { code: null, signal: 'SIGTERM' }] as const) test(`controlled Claude terminal result cold replay keeps exact ${close.code ?? close.signal} exit and witnesses`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-claude-terminal-cold-')), realm = join(directory, 'realm'), root = join(realm, 'native'), workspace = join(directory, 'workspace')
  mkdirSync(root, { recursive: true }); mkdirSync(workspace)
  const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const receiptFile = join(root, 'process.json'), completion = join(root, 'completed.json'), prompt = 'public terminal task', output = { ok: true }
  try {
    await sampleNativeWorktreeProcesses({ root, receiptFile, workspace })
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { detached: true, stdio: 'ignore' })
    assert(child.pid)
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
    writeDetachedRuntimeReceipt(child.pid, receiptFile)
    const native = { version: 2 as const, root, sessionId: 'session', userUuid: 'user', pid: child.pid, receiptFile }
    const execution: StructuredExecution = { ...structuredExecutionPolicy({ schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, inputDigest: 'terminal', purpose: 'terminal-replay', timeoutMs: null, model: 'claude:opaque/selection', worktree: { baseCommit: 'a'.repeat(40), tree: 'b'.repeat(40), mode: 'read' } }), nativeConfiguration: 'cli-config-v1', claudeNative: native, state: 'running', threadId: 'session', turnId: 'user' }
    const policy = structuredExecutionPolicy(execution), init = { session_id: 'session', model: 'native-selection', tools: ['StructuredOutput'] }, echo = { uuid: 'user', session_id: 'session', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }
    const history = [{ type: 'user', sessionId: 'session', uuid: 'user', parentUuid: null, promptId: 'prompt', message: echo.message }, { type: 'api-request', sessionId: 'session', id: 'request', model: 'wire-model' }]
    const plan = { ...native, workspace, cliVersion: 'fixture Claude CLI', requestedModel: execution.model, resolvedModel: init.model, historyDigest: hash(history), policyDigest: hash(policy), requestDigest: hash({ prompt, policy }) }
    const result = { type: 'result', subtype: 'success', is_error: false, session_id: 'session', user_message_uuid: 'user', user_message_uuids: ['user'], structured_output: output }
    const exit = { ...close, stopped: true }, request = { version: 1, reason: 'terminal_settlement', sessionId: 'session', userUuid: 'user', pid: child.pid, receiptDigest: hash(JSON.parse(readFileSync(receiptFile, 'utf8'))), requestDigest: plan.requestDigest, resultDigest: hash(result), signal: 'SIGTERM', requestedAt: Date.now() }
    writeFileSync(join(root, 'terminal-stop-request.json'), JSON.stringify(request))
    process.kill(-child.pid, 'SIGTERM'); await exited
    const observation = { version: 1, requestObservationDigest: hash(request), outcome: 'sent', observedAt: Date.now() }
    for (const [name, value] of Object.entries({ 'plan.json': plan, 'init.json': init, 'user-echo.json': echo, 'result.json': result, 'exit.json': exit, 'terminal-stop.json': observation, 'public-history.json': { version: 1, sessionId: 'session', history } })) writeFileSync(join(root, name), JSON.stringify(value))
    const noDispatch = { onThread: async () => assert.fail('no new session'), onTurn: async () => assert.fail('no new prompt'), onNative: async () => assert.fail('no new CLI') }
    const bytes = new Map(['result.json', 'exit.json', 'process.json', 'terminal-stop-request.json', 'terminal-stop.json'].map(name => [name, readFileSync(join(root, name))]))
    const replay = (state = execution) => claudeStructuredTurn(realm, 'native', prompt, state, noDispatch, workspace)
    const answer = await replay()
    assert.deepEqual(answer, { threadId: 'session', turnId: 'user', text: JSON.stringify(output) })
    for (const [name, original] of bytes) assert.deepEqual(readFileSync(join(root, name)), original)
    const canonical: StructuredExecution = { ...execution, state: 'completed', output, resultDigest: hash(output) }
    const completed = readFileSync(completion)
    assert.deepEqual(await replay(canonical), answer)
    assert.deepEqual(readFileSync(completion), completed)
    for (const [name, invalid] of [
      ['terminal-stop-request.json', { ...request, sessionId: 'another-session' }],
      ['terminal-stop-request.json', { ...request, receiptDigest: 'foreign-receipt' }],
      ['terminal-stop-request.json', { ...request, requestDigest: 'foreign-request' }],
      ['terminal-stop-request.json', { ...request, resultDigest: 'foreign-result' }],
      ['terminal-stop.json', { ...observation, outcome: 'gone' }],
      ['terminal-stop.json', { ...observation, requestObservationDigest: 'foreign-observation' }],
      ['exit.json', { code: 0, signal: null, stopped: true }],
      ['exit.json', { ...exit, stopped: false }],
    ] as const) {
      writeFileSync(join(root, name), JSON.stringify(invalid))
      await assert.rejects(replay(canonical), { code: 'stale_result' }, name)
      writeFileSync(join(root, name), bytes.get(name)!)
    }
    rmSync(join(root, 'terminal-stop.json'))
    await assert.rejects(replay(canonical), { code: 'cancellation_pending' })
    rmSync(join(root, 'terminal-stop-request.json'))
    await assert.rejects(replay(canonical), { code: 'stale_result' })
    writeFileSync(join(root, 'terminal-stop-request.json'), bytes.get('terminal-stop-request.json')!)
    writeFileSync(join(root, 'terminal-stop.json'), bytes.get('terminal-stop.json')!)
    rmSync(completion)
    for (const state of ['failed', 'cancelling', 'cancelled', 'timeout'] as const) await assert.rejects(replay({ ...execution, state }))
    await assert.rejects(replay({ ...execution, error: 'prior public failure' }))
    await assert.rejects(replay({ ...execution, cancellation: { reason: 'timeout', requestedAt: 1, nativeStopped: true, acknowledged: false } }))
    const controller = new AbortController(); controller.abort()
    await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, { ...noDispatch, signal: controller.signal }, workspace))
    writeFileSync(join(root, 'native-protocol.jsonl'), JSON.stringify({ version: 1, ordinal: 3, kind: 'error', code: 'stale_result' }) + '\n')
    await assert.rejects(replay())
    rmSync(join(root, 'native-protocol.jsonl'))
    rmSync(receiptFile)
    await assert.rejects(replay(), { code: 'cancellation_pending' })
    writeFileSync(receiptFile, bytes.get('process.json')!)
    for (const invalidResult of [{ ...result, structured_output: undefined }, { ...result, is_error: true }, { ...result, structured_output: { ok: 'bad' } }]) {
      const bound = { ...request, resultDigest: hash(invalidResult) }
      writeFileSync(join(root, 'result.json'), JSON.stringify(invalidResult))
      writeFileSync(join(root, 'terminal-stop-request.json'), JSON.stringify(bound))
      writeFileSync(join(root, 'terminal-stop.json'), JSON.stringify({ ...observation, requestObservationDigest: hash(bound) }))
      await assert.rejects(replay(), { code: 'failed' })
      assert(!existsSync(completion))
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

for (const apiModel of [undefined, 'legacy-internal-model']) test(`legacy Claude completed worktree preserves original API model semantics for ${apiModel}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-claude-legacy-cold-')), realm = join(directory, 'realm'), root = join(realm, 'native'), workspace = join(directory, 'workspace'), projects = join(root, 'claude-home', 'projects', 'fixture')
  mkdirSync(projects, { recursive: true })
  const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  try {
    const prompt = 'public legacy task', output = { ok: true }, native = { version: 1 as const, root, sessionId: 'session', userUuid: 'user', pid: 123, receiptFile: join(root, 'process.json') }
    const policy = structuredExecutionPolicy({ schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, inputDigest: 'legacy', purpose: 'legacy-completed', timeoutMs: null, model: 'claude:MiniMax-M3', worktree: { baseCommit: 'a'.repeat(40), tree: 'b'.repeat(40), mode: 'read' } })
    const execution: StructuredExecution = { ...policy, claudeNative: native, state: 'completed', threadId: 'session', turnId: 'user', output, resultDigest: hash(output) }
    const plan = { ...native, workspace, cliVersion: '2.1.309 (Claude Code)', requestDigest: hash({ prompt, policy }), policyDigest: hash(policy) }
    const init = { session_id: 'session', model: 'MiniMax-M3', tools: ['Read', 'StructuredOutput'] }, echo = { uuid: 'user', session_id: 'session', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }
    const result = { type: 'result', subtype: 'success', is_error: false, session_id: 'session', user_message_uuid: 'user', user_message_uuids: ['user'], structured_output: output }, exit = { code: 0, signal: null, stopped: true }
    const answer = { threadId: 'session', turnId: 'user', text: JSON.stringify(output) }, completed = { plan, init, echo, result, exit, promptId: 'prompt', answer }
    for (const [name, value] of Object.entries({ 'plan.json': plan, 'init.json': init, 'user-echo.json': echo, 'result.json': result, 'exit.json': exit, 'completed.json': completed })) writeFileSync(join(root, name), JSON.stringify(value))
    writeFileSync(join(projects, 'session.jsonl'), [
      { type: 'user', sessionId: 'session', uuid: 'user', parentUuid: null, promptId: 'prompt', message: echo.message },
      { type: 'api-request', sessionId: 'session', id: 'legacy-request', params: { model: apiModel } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    const original = readFileSync(join(root, 'completed.json'))
    const noDispatch = { onThread: async () => assert.fail('no new session'), onTurn: async () => assert.fail('no new prompt'), onNative: async () => assert.fail('no new CLI') }
    assert.deepEqual(await claudeStructuredTurn(realm, 'native', prompt, execution, noDispatch, workspace), answer)
    assert.deepEqual(readFileSync(join(root, 'completed.json')), original)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})


const modelObservationFixture = process.env.SPEX_CLAUDE_MODEL_OBSERVATION_FIXTURE
test('sealed real Claude public evidence separates init selection from each wire model in an offline wrapper', { skip: !modelObservationFixture }, async () => {
  assert(modelObservationFixture)
  const source = modelObservationFixture, directory = mkdtempSync(join(tmpdir(), 'spex-claude-model-observation-')), realm = join(directory, 'realm'), root = join(realm, 'native'), workspace = join(directory, 'workspace')
  const bytesHash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
  const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const sourceNames = ['files.json', 'original-prompt-model-exit-public-checks.json', 'original-prompt-model-exit-full-public-checks.json', 'plan.json', 'init.json', 'user-echo.json', 'result.json', 'exit.json', 'launch.json', 'public-history.json']
  const originals = new Map(sourceNames.map(name => [name, readFileSync(join(source, name))]))
  assert.equal(bytesHash(originals.get('files.json')!), '79277afb97a6c83f374c39722192a60ceab09dbabd45bc4408a9634ab32c340a')
  assert.equal(bytesHash(originals.get('original-prompt-model-exit-public-checks.json')!), 'c2de7a17612c60c91f609680499f440f90cff16b58c1c3a13f09a2c63c060ca9')
  assert.equal(bytesHash(originals.get('original-prompt-model-exit-full-public-checks.json')!), 'cd9fdf93d6a25c9fc5c3a3551f64b9f9dd9b45f401651afc5fd69008a378f51d')
  assert.equal(bytesHash(originals.get('public-history.json')!), '86ea2580251e0b6634ae037f626b65e7403df8244a8f7e9d01e2926a4370f160')
  const manifest = JSON.parse(originals.get('files.json')!.toString('utf8')) as Record<string, { sha256: string }>
  for (const name of ['plan.json', 'init.json', 'user-echo.json', 'result.json', 'exit.json', 'launch.json']) assert.equal(bytesHash(originals.get(name)!), manifest[name].sha256)
  let observed: { code?: string; resultDigest?: string } | undefined
  let wrapperChanges: { field: string; originalDigest: string; wrapperDigest: string }[] = []
  let schemaDigest: string | undefined
  try {
    mkdirSync(root, { recursive: true }); mkdirSync(workspace)
    for (const name of ['init.json', 'user-echo.json', 'result.json', 'exit.json', 'public-history.json']) writeFileSync(join(root, name), originals.get(name)!)
    const originalPlan = JSON.parse(originals.get('plan.json')!.toString('utf8')) as { [key: string]: unknown; sessionId: string; userUuid: string; requestedModel: string; resolvedModel: string; historyDigest: string }
    const echo = JSON.parse(originals.get('user-echo.json')!.toString('utf8')) as { message: ClaudePublicMessage }
    const blocks = contentBlocks(echo.message); assert.equal(blocks.length, 1); assert.equal(typeof blocks[0].text, 'string')
    const prompt = blocks[0].text!
    assert.equal(createHash('sha256').update(prompt).digest('hex'), '3048a508320bfe74bb558eab2e0ddde1def46df062d9596377b30dc18fa3b97b')
    const history = JSON.parse(originals.get('public-history.json')!.toString('utf8')) as { history: ClaudePublicRecord[] }
    assert.equal(hash(history.history), originalPlan.historyDigest)
    assert.equal(history.history.filter(row => row.type === 'api-request').length, 9)
    assert.equal(originalPlan.resolvedModel, 'glm-5.3-flash[1m]')
    assert(history.history.filter(row => row.type === 'api-request').every(row => row.model === 'glm-5.3-flash'))
    // 离线wrapper只替换路径、测试policy和自有已停Node的receipt；不重签真实记录或证明原业务/Git结果。
    const receiptFile = join(root, 'process.json')
    await sampleNativeWorktreeProcesses({ root, receiptFile, workspace })
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { detached: true, stdio: 'ignore' }); assert(child.pid)
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    writeDetachedRuntimeReceipt(child.pid, receiptFile); process.kill(-child.pid, 'SIGTERM'); await closed
    const native = { version: 2 as const, root, sessionId: originalPlan.sessionId, userUuid: originalPlan.userUuid, pid: child.pid, receiptFile }
    const launch = JSON.parse(originals.get('launch.json')!.toString('utf8')) as { args: string[] }
    const schemaIndex = launch.args.indexOf('--json-schema'); assert(schemaIndex >= 0)
    const schema = JSON.parse(launch.args[schemaIndex + 1]) as Record<string, unknown>; schemaDigest = hash(schema)
    const policy = structuredExecutionPolicy({ schema, inputDigest: 'offline-wrapper', purpose: 'real-public-model-observation', timeoutMs: null, model: originalPlan.requestedModel, nativeConfiguration: 'cli-config-v1', worktree: { baseCommit: 'a'.repeat(40), tree: 'b'.repeat(40), mode: 'read' } })
    const execution: StructuredExecution = { ...policy, claudeNative: native }
    const wrappedPlan: Record<string, unknown> = { ...originalPlan, ...native, workspace, configRoot: join(directory, 'unread-config'), historyPath: join(directory, 'unread-original-history'), policyDigest: hash(policy), requestDigest: hash({ prompt, policy }) }
    wrapperChanges = Object.keys(wrappedPlan).filter(key => hash(wrappedPlan[key]) !== hash(originalPlan[key])).map(field => ({ field, originalDigest: hash(originalPlan[field]), wrapperDigest: hash(wrappedPlan[field]) }))
    writeFileSync(join(root, 'plan.json'), JSON.stringify(wrappedPlan))
    const noDispatch = { onThread: async () => assert.fail('offline wrapper cannot create a session'), onTurn: async () => assert.fail('offline wrapper cannot append a prompt'), onNative: async () => assert.fail('offline wrapper cannot launch Claude') }
    const result = await claudeStructuredTurn(realm, 'native', prompt, execution, noDispatch, workspace)
    const originalResult = JSON.parse(originals.get('result.json')!.toString('utf8')) as { structured_output: unknown }
    assert.equal(result.text, JSON.stringify(originalResult.structured_output))
    observed = { resultDigest: hash(originalResult.structured_output) }
  } catch (error) { observed = { code: (error as { code?: string }).code }; throw error }
  finally {
    for (const [name, bytes] of originals) assert.deepEqual(readFileSync(join(source, name)), bytes)
    if (process.env.SPEX_CLAUDE_MODEL_OBSERVATION_EVIDENCE) writeFileSync(process.env.SPEX_CLAUDE_MODEL_OBSERVATION_EVIDENCE, JSON.stringify({ controlledOfflineWrapper: true, originalFilesUnchanged: true, originalPromptSHA256: '3048a508320bfe74bb558eab2e0ddde1def46df062d9596377b30dc18fa3b97b', initSelection: 'glm-5.3-flash[1m]', wireModels: ['glm-5.3-flash'], apiRequestCount: 9, observed, realClaudeCalls: 0, realDatabaseWrites: 0, originalOperationStateChanged: false, originalSchemaPreserved: true, schemaDigest, wrapperChanges, originalFiles: [...originals].map(([file, bytes]) => ({ file, sha256: bytesHash(bytes) })) }, null, 2))
    rmSync(directory, { recursive: true, force: true })
  }
})
