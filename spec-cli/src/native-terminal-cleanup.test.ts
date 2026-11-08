import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { openProtocol } from '@spexcode/session-protocol'
import { sessionArtifactPath } from '@spexcode/spec-core'
import { configuredSessionApplication, setSessionApplicationCommitWake } from './session-application.js'
import { readRecord, writeRecord } from './session-record.js'
import { executeQueuedStructuredSession, StructuredSessionError } from './session-structured.js'
import { structuredExecutionPolicy } from './session-structured-policy.js'
import { refreshQueueCandidate, withArchivedStructuredWorktree } from './sessions.js'
import { createAttemptRunner } from './sync/native-run.js'
import { recoverSyncOperationResources } from './sync/coordinator.js'
import { migrateSyncStore } from './sync/migrations.js'
import { captureInputSnapshot, readEvidence } from './sync/snapshot.js'
import { stageWorktree } from './sync/stage-worktree.js'
import { SyncStore } from './sync/store.js'

async function runFixture(scenario: string): Promise<void> {
  const recovering = scenario.startsWith('recovery-'), dirty = scenario.endsWith('dirty'), unknown = scenario === 'unknown-stop' || scenario === 'recovery-unknown'
  const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim()
  const input = await captureInputSnapshot(process.cwd(), { committed: true })
  configuredSessionApplication()
  const protocol = openProtocol(process.env.SPEX_SESSION_DATABASE_PATH!)
  await migrateSyncStore(protocol)
  const store = new SyncStore(protocol, { readBlob: ref => readEvidence(input.source.commonDir, ref) }), scope = { paths: ['value'], contractIds: [], flowIds: [] }
  const operation = store.admitAndEnqueue({ ingressKey: 'terminal', rootCauseId: 'terminal', origin: 'spec', input, scope, budget: { maxCalls: 2, maxAttempts: 1, maxRepairs: 0, timeoutMs: 60000 }, policyDigest: 'policy', impactDigest: 'impact', readSetDigest: 'read', delivery: null, deliveryPlan: { canonicalRoot: process.cwd() + '/delivery', branch: 'delivery', baseCommit: input.headCommit } })
  const claim = store.claimAttempt({ operationId: operation.id, source: input.source, scope, leaseMs: 60000, expectedMessageId: operation.dispatchMessageId })
  const seed = stageWorktree(input.source.commonDir, input.headCommit, input.immutableTree, 'edit')
  const request = { root: process.cwd(), base: seed.baseCommit, worktree: seed, requestKey: 'terminal', inputDigest: 'input', purpose: 'code_behavior_analyze', prompt: 'controlled terminal failure', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, timeoutMs: null, model: 'claude:default' }
  const originalWrite = fs.writeFileSync
  if (unknown) {
    fs.writeFileSync = ((...args: Parameters<typeof originalWrite>) => {
      const [path] = args, result = originalWrite(...args)
      if (String(path).endsWith('/exit.json')) {
        const receipt = join(dirname(String(path)), 'process.json')
        fs.renameSync(receipt, receipt + '.held')
      }
      return result
    }) as typeof fs.writeFileSync
    syncBuiltinESMExports()
  }
  const failure = await createAttemptRunner(store, claim.fence, { pollMs: 2, ...(!recovering && scenario !== 'legacy-failed' ? { retireSettledWorktrees: true } : {}) })(request).then(() => assert.fail('failed CLI cannot return a result'), (error: unknown) => error)
  fs.writeFileSync = originalWrite; syncBuiltinESMExports()
  assert(failure instanceof StructuredSessionError)
  assert(failure.sessionId)
  let record = readRecord(failure.sessionId)!
  const state = record.structuredExecution!, resource = store.findResource(claim.attempt.id, request.requestKey)!
  const message = 'Claude native execution exited unsuccessfully: code=1, signal=null, result.is_error=true'
  assert.equal(failure.message, message); assert.equal(state.error, message)
  for (const key of ['errorCode', 'output', 'rejectedOutput', 'failedWorktree', 'resultWorktree', 'resultDigest'] as const) assert.equal(state[key], undefined)
  assert.equal(JSON.parse(fs.readFileSync(process.env.SPEX_TERMINAL_CALLS_PATH!, 'utf8')).length, 1)
  assert.equal(store.readOperation(operation.id).callsUsed, 1)
  if (recovering) {
    assert.equal(fs.existsSync(record.worktreePath), true)
    if (scenario === 'recovery-removed-unknown') writeRecord({ ...record, structuredExecution: { ...state, cancellation: { ...state.cancellation!, nativeStopped: false, error: 'fixture stop remains unknown' } } })
    const sibling = randomUUID(), siblingBranch = 'queued-sibling', siblingPath = join(dirname(record.worktreePath), sibling)
    git('worktree', 'add', '-qb', siblingBranch, siblingPath, seed.baseCommit)
    configuredSessionApplication().createSession({ sessionId: sibling, status: 'queued' })
    writeRecord({ ...record, session: sibling, worktreePath: siblingPath, branch: siblingBranch, status: 'queued', proposal: null, note: null, harnessSessionId: null, stopped: false, archived: false, closedAt: null, coldProof: null, launchOwner: null, runtimeStartToken: null, createRequestId: null, createPayloadHash: null, structuredExecution: structuredExecutionPolicy(state) })
    fs.writeFileSync(sessionArtifactPath(sibling, 'launch'), 'queued sibling must stay idle')
    refreshQueueCandidate(sibling)
    const queuedBefore = JSON.stringify(readRecord(sibling))
    const beforeOperation = JSON.stringify(store.readOperation(operation.id)), beforeResource = JSON.stringify(resource)
    let wakes = 0
    setSessionApplicationCommitWake(() => { wakes++ })
    const artifacts = fs.realpathSync(fs.mkdtempSync(join(dirname(process.env.SPEX_SESSION_DATABASE_PATH!), 'artifacts-')))
    const recovered = await recoverSyncOperationResources(store, operation.id, { root: process.cwd(), inputId: input.id, artifactRoot: artifacts })
    assert.equal(recovered.status, unknown ? 'recovery_required' : 'resources_recovered', JSON.stringify(recovered.failure))
    assert.equal(JSON.stringify(store.readOperation(operation.id)), beforeOperation)
    if (!unknown) assert.equal(JSON.stringify(store.findResource(claim.attempt.id, request.requestKey)), beforeResource, 'retirement cannot rewrite a removed checkpoint')
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(wakes, 0, 'offline recovery cannot request an execution wake')
    assert.equal(JSON.stringify(readRecord(sibling)), queuedBefore, 'offline recovery cannot wake a queued sibling')
    record = readRecord(record.session)!
    assert.equal(fs.existsSync(record.worktreePath), dirty || unknown || scenario === 'recovery-removed-unknown', 'formal recovery retires only clean exactly stopped checkouts')
    assert.equal(record.structuredExecution!.error, message, 'resource cleanup preserves the original business failure')
  }
  if (unknown) {
    assert.equal(failure.code, 'cancellation_pending'); assert.equal(state.state, 'cancelling')
    assert.equal(state.cancellation?.nativeStopped, false); assert(state.cancellation?.error); assert.notEqual(state.cancellation.error, message)
    assert.notEqual(resource.phase, 'removed'); assert.equal(fs.existsSync(record.worktreePath), true)
  } else {
    assert.equal(failure.code, 'failed'); assert.equal(state.state, 'failed')
    assert.equal(state.cancellation?.nativeStopped, true, 'new exact terminal failure must persist its stop proof')
    assert.equal(resource.phase, 'removed')
    if (scenario === 'legacy-failed') {
      writeRecord({ ...record, structuredExecution: { ...state, cancellation: undefined } })
      const before = JSON.stringify(readRecord(record.session)), native = fs.readFileSync(state.claudeNative!.root + '/exit.json')
      assert.equal(await executeQueuedStructuredSession(record.session), 'failed')
      assert.equal(JSON.stringify(readRecord(record.session)), before, 'cold legacy failed must not acquire a new stop signature')
      assert.deepEqual(fs.readFileSync(state.claudeNative!.root + '/exit.json'), native)
    } else if (dirty || scenario === 'recovery-removed-unknown') {
      assert.equal(fs.existsSync(record.worktreePath), true); assert.equal(record.archived, false)
      assert.equal(fs.readFileSync(join(record.worktreePath, '.spex-sync-drafts/draft.json'), 'utf8'), '{"unapproved":true}\n')
    } else {
      assert.equal(fs.existsSync(record.worktreePath), false, 'clean failed Native checkout must be retired'); assert.equal(record.archived, true)
      const head = git('rev-parse', record.branch!)
      assert.equal(head, fs.readFileSync(process.env.SPEX_TERMINAL_HEAD_PATH!, 'utf8'))
      assert.equal(git('show', 'refs/spex-archive/' + record.session + ':.spex-sync-drafts/draft.json'), '{"unapproved":true}')
      assert.equal(git('show', head + ':.spex-sync-drafts/draft.json'), '{"unapproved":true}')
      const before = JSON.stringify(readRecord(record.session))
      await assert.rejects(createAttemptRunner(store, claim.fence, { pollMs: 2, retireSettledWorktrees: true })(request), { code: 'failed', message })
      assert.equal(JSON.stringify(readRecord(record.session)), before)
      const checkpointBefore = readEvidence(input.source.commonDir, resource.checkpointRef), archiveBefore = git('rev-parse', 'refs/spex-archive/' + record.session)
      assert.equal(await withArchivedStructuredWorktree(record, path => fs.readFileSync(join(path, '.spex-sync-drafts/draft.json'), 'utf8')), '{"unapproved":true}\n', 'existing archive seam retains the unapproved draft')
      assert.equal(fs.existsSync(record.worktreePath), false)
      assert.equal(JSON.stringify(readRecord(record.session)), before)
      assert.deepEqual(readEvidence(input.source.commonDir, resource.checkpointRef), checkpointBefore)
      assert.equal(git('rev-parse', 'refs/spex-archive/' + record.session), archiveBefore)
    }
  }
  assert.equal(JSON.parse(fs.readFileSync(process.env.SPEX_TERMINAL_CALLS_PATH!, 'utf8')).length, 1, 'cleanup and replay cannot send another Native call')
  console.log(JSON.stringify({ scenario, state: state.state, phase: resource.phase, nativeStopped: state.cancellation?.nativeStopped, archived: record.archived }))
  protocol.close()
}

const scenario = process.env.SPEX_TERMINAL_SCENARIO
if (scenario) {
  await runFixture(scenario)
  process.exit(0)
} else for (const mode of ['clean', 'dirty', 'unknown-stop', 'legacy-failed', 'recovery-clean', 'recovery-dirty', 'recovery-unknown', 'recovery-removed-unknown']) test('Claude terminal failure preserves its error and exact cleanup boundary: ' + mode, () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'spex-terminal-cleanup-')), root = join(directory, 'repo'), home = join(directory, 'home'), bin = join(directory, 'bin'), count = join(directory, 'calls.json')
  for (const path of [root, home, bin]) fs.mkdirSync(path)
  const git = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  try {
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'terminal fixture'); git('config', 'user.email', 'terminal@example.invalid')
    fs.mkdirSync(join(root, '.spec')); fs.writeFileSync(join(root, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', sessions: { maxActive: 1 } }))
    fs.writeFileSync(join(root, 'value'), 'seed\n'); git('add', '.'); git('commit', '-qm', 'seed')
    const executable = join(bin, 'claude')
    fs.writeFileSync(executable, [
      '#!/usr/bin/env node',
      'const fs=require("node:fs"),rl=require("node:readline"),cp=require("node:child_process");',
      'if(process.argv.includes("--version")){console.log("controlled-terminal-fixture");process.exit(0)}',
      'const arg=name=>process.argv[process.argv.indexOf(name)+1],session=arg("--session-id"),send=event=>process.stdout.write(JSON.stringify(event)+"\\n");',
      'rl.createInterface({input:process.stdin}).on("line",line=>{const user=JSON.parse(line);if(user.type!=="user")return;',
      'const count=process.env.SPEX_TERMINAL_CALLS_PATH;fs.writeFileSync(count,JSON.stringify([...(fs.existsSync(count)?JSON.parse(fs.readFileSync(count,"utf8")):[]),session]));',
      'send({type:"system",subtype:"init",session_id:session,model:arg("--model")||"fixture-model",tools:["Bash","Edit"]});send(user);',
      'fs.mkdirSync(".spex-sync-drafts",{recursive:true});fs.writeFileSync(".spex-sync-drafts/draft.json",JSON.stringify({unapproved:true})+"\\n");',
      'if(!process.env.SPEX_TERMINAL_SCENARIO.endsWith("dirty")){cp.execFileSync("git",["add",".spex-sync-drafts/draft.json"]);cp.execFileSync("git",["commit","-qm","unapproved draft"])}',
      'fs.writeFileSync(process.env.SPEX_TERMINAL_HEAD_PATH,cp.execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim());',
      'send({type:"result",subtype:"success",is_error:true,session_id:session,uuid:"result",user_message_uuid:user.uuid,user_message_uuids:[user.uuid]});process.exitCode=1;});',
    ].join('\n'))
    fs.chmodSync(executable, 0o755)
    const result = spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx/esm'), fileURLToPath(import.meta.url)], { cwd: root, env: { ...process.env, PATH: bin + ':' + process.env.PATH, HOME: home, SPEXCODE_HOME: home, SPEX_SESSION_DATABASE_PATH: join(home, 'sessions.sqlite'), SPEX_RUNTIME_HOME: join(home, 'runtime'), CLAUDE_CONFIG_DIR: join(home, 'claude'), ANTHROPIC_BASE_URL: 'https://example.invalid', SPEXCODE_CODEX_USAGE_GUARD: '0', SPEX_TEST: '1', SPEX_TERMINAL_SCENARIO: mode, SPEX_TERMINAL_CALLS_PATH: count, SPEX_TERMINAL_HEAD_PATH: join(directory, 'head') }, encoding: 'utf8', timeout: 30000 })
    assert.equal(result.status, 0, result.stdout + '\n' + result.stderr)
    console.log(result.stdout)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
