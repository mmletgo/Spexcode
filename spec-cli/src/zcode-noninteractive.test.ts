import assert from 'node:assert/strict'
import test from 'node:test'
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import crypto, { createHash, type BinaryLike, type BinaryToTextEncoding } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pinZCodeToolPolicy, structuredExecutionPolicy } from './session-structured-policy.js'
import { zcodeCapability, zcodeStructuredTurn, type ZCodeStructuredExecution } from './zcode-structured.js'

const read = { schema: { type: 'object' }, inputDigest: 'input', purpose: 'read', timeoutMs: null, model: 'zcode:bigmodel-api/GLM-5.3-Flash', worktree: { baseCommit: 'a'.repeat(40), tree: 'b'.repeat(40), mode: 'read' as const } }
const tools = { version: 1 as const, toolDenylist: ['ExitPlanMode'] as ['ExitPlanMode'] }

test('ZCode noninteractive policy is explicit, exact and preserves historical absence', () => {
  const request = { ...read, zcodeToolPolicy: tools }
  assert.deepEqual(structuredExecutionPolicy(request), { version: 6, policy: 'native-worktree-v1', ...request })
  assert.equal('zcodeToolPolicy' in structuredExecutionPolicy(read), false)
  for (const value of [
    { ...request, zcodeToolPolicy: { ...tools, toolDenylist: ['ExitPlanMode', 'Bash'] } },
    { ...request, worktree: { ...read.worktree, mode: 'edit' as const } },
    { ...request, model: 'claude:MiniMax-M3.1-Flash' },
  ]) assert.throws(() => structuredExecutionPolicy(value as typeof request), { code: 'unsupported' })
})

test('new read defaults are frozen only at admission; old absence and explicit tamper stay distinct', () => {
  assert.deepEqual(pinZCodeToolPolicy(read, null), tools)
  assert.equal(pinZCodeToolPolicy(read, {}), undefined)
  assert.deepEqual(pinZCodeToolPolicy(read, { zcodeToolPolicy: tools }), tools)
  assert.throws(() => pinZCodeToolPolicy({ ...read, zcodeToolPolicy: tools }, {}), { code: 'key_reused' })
  assert.equal(pinZCodeToolPolicy({ ...read, model: 'claude:MiniMax-M3.1-Flash' }, null), undefined)
  assert.equal(pinZCodeToolPolicy({ ...read, worktree: { ...read.worktree, mode: 'edit' } }, null), undefined)
})

test('MockNative captures exact send filtering, unchanged plan mode and permissions, v1 recovery and v2 tamper refusal', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'zcode-noninteractive-')), bin = join(directory, 'bin'), cli = join(bin, 'zcode'), builtin = Buffer.from('PUBLIC_MOCK_BUILTIN')
  mkdirSync(bin)
  const captured = join(directory, 'captured.json')
  const script = `#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline');
if(process.argv.includes('--version')){console.log('0.17.1');process.exit(0)}
let create,send;const permissions={},out=x=>console.log(JSON.stringify(x)),turn='turn',visible=['Read','Glob','Grep','Bash','Edit','Write','NotebookEdit','ExitPlanMode'];
rl.createInterface({input:process.stdin}).on('line',line=>{
if(!/^[\\x00-\\x7f]*$/.test(line))throw Error('non-ASCII RPC wire');const p=JSON.parse(line),reply=result=>out({id:p.id,result});if(!p.method){permissions[p.id]=p.result;return}
if(p.method==='session/create'){create=p.params;reply({session:{sessionId:create.sessionId,model:create.model}})}
else if(p.method==='session/read')reply({session:{sessionId:create.sessionId,model:create.model,status:'idle'},settings:{model:{current:create.model}},runtime:{pendingRequestIds:[]},projection:{currentTurnId:send?turn:undefined,pendingPermissions:[],activeToolCalls:[]}});
else if(p.method==='session/send'){send=p.params;for(const toolName of visible)out({id:'permission-'+toolName,method:'interaction/requestPermission',params:{sessionId:create.sessionId,toolName,input:{file_path:'value'}}});reply({accepted:true,sessionId:create.sessionId})}
else if(p.method==='session/events'){fs.writeFileSync(${JSON.stringify(captured)},JSON.stringify({create,send,permissions,visibleTools:visible.filter(name=>!send.toolDenylist?.includes(name))}));reply({events:[{type:'turn.started',payload:{inputId:send.inputId,queryId:send.queryId,messageId:'user'}},{type:'session.updated',payload:{providerId:create.model.providerId,modelId:create.model.modelId,toolCount:visible.length-(send.toolDenylist?.length??0)}},{type:'turn.completed',payload:{inputId:send.inputId,resultType:'success',response:'{}'}}].map((e,i)=>({...e,eventId:'event-'+i,seq:i+1,sessionId:create.sessionId,turnId:turn}))})}
else if(p.method==='session/messages')reply({messages:[{info:{id:'user',sessionID:create.sessionId,role:'user',anchor:{turnId:turn},modelSelection:create.model,semantics:{kind:'user_prompt'}},parts:[{type:'text',text:send.content}]},{info:{role:'assistant',anchor:{turnId:turn},...create.model,semantics:{kind:'assistant_response'}},parts:[{type:'text',text:'{}'}]}],hasMore:false});
else if(p.method==='session/close')reply({closed:true});else throw Error('unexpected RPC '+p.method);
});
`
  writeFileSync(cli, script); chmodSync(cli, 0o755)
  const originalHash = crypto.createHash, originalRead = fs.readFileSync, originalExists = fs.existsSync, previousPath = process.env.PATH
  t.mock.method(fs, 'existsSync', (path: fs.PathLike) => path === zcodeCapability.builtinPath || originalExists(path))
  t.mock.method(fs, 'readFileSync', ((path: fs.PathOrFileDescriptor, options?: unknown) => path === zcodeCapability.builtinPath ? builtin : originalRead(path, options as null)) as typeof fs.readFileSync)
  t.mock.method(crypto, 'createHash', (...args: Parameters<typeof crypto.createHash>) => {
    const hash = originalHash(...args), update = hash.update.bind(hash) as typeof hash.update, finish = hash.digest.bind(hash)
    let forced: string | undefined
    hash.update = ((bytes: BinaryLike, encoding?: BufferEncoding) => {
      if (Buffer.isBuffer(bytes) && bytes.equals(Buffer.from(script))) forced = zcodeCapability.cliSha256
      if (Buffer.isBuffer(bytes) && bytes.equals(builtin)) forced = zcodeCapability.builtinSha256
      return typeof bytes === 'string' ? update(bytes, encoding ?? 'utf8') : update(bytes)
    }) as typeof hash.update
    hash.digest = ((encoding?: BinaryToTextEncoding) => forced && encoding === 'hex' ? forced : encoding ? finish(encoding) : finish()) as typeof hash.digest
    return hash
  })
  syncBuiltinESMExports(); process.env.PATH = `${bin}:${previousPath}`
  try {
    for (const kind of ['new-read', 'legacy-read', 'edit'] as const) await t.test(kind, async () => {
      const workspace = join(directory, kind), realm = join(directory, 'realm'), root = join(realm, kind)
      mkdirSync(workspace)
      const policy = structuredExecutionPolicy({ ...read, worktree: { ...read.worktree, mode: kind === 'edit' ? 'edit' : 'read' }, ...(kind === 'new-read' ? { zcodeToolPolicy: tools } : {}) })
      let execution = { ...policy, version: 6, policy: 'native-worktree-v1' } as ZCodeStructuredExecution
      const result = await zcodeStructuredTurn(realm, kind, '原业务正文  ', execution, {
        onNative: async zcodeNative => { execution = { ...execution, zcodeNative } },
        onThread: async threadId => { execution = { ...execution, threadId } },
        onTurn: async turnId => { execution = { ...execution, turnId } },
      }, workspace)
      const actual = JSON.parse(readFileSync(captured, 'utf8')) as { create: { mode: string }; send: Record<string, unknown>; visibleTools: string[]; permissions: Record<string, { decision: string }> }
      const plan = JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8')) as Record<string, unknown>, send = JSON.parse(readFileSync(join(root, 'send.json'), 'utf8')) as Record<string, unknown>
      assert.equal(actual.create.mode, kind === 'edit' ? 'build' : 'plan')
      assert.deepEqual(actual.send, { ...send, queryId: plan.queryId })
      assert.equal(plan.version, kind === 'new-read' ? 2 : 1)
      assert.deepEqual(plan.toolDenylist, kind === 'new-read' ? ['ExitPlanMode'] : undefined)
      assert.deepEqual(send.toolDenylist, plan.toolDenylist)
      assert.equal(actual.visibleTools.includes('ExitPlanMode'), kind !== 'new-read')
      for (const tool of ['Read', 'Glob', 'Grep', 'Bash']) {
        assert(actual.visibleTools.includes(tool)); assert.equal(actual.permissions[`permission-${tool}`].decision, 'allow')
      }
      for (const tool of ['Edit', 'Write', 'NotebookEdit']) assert.equal(actual.permissions[`permission-${tool}`].decision, kind === 'edit' ? 'allow' : 'deny')
      assert.equal(actual.permissions['permission-ExitPlanMode'].decision, 'deny')
      assert(String(send.content).endsWith('\n\n原业务正文  '))
      assert.equal(String(send.content).includes('Do not request plan approval'), kind === 'new-read')
      const completed = { ...execution, state: 'completed' as const, output: {}, resultDigest: createHash('sha256').update('{}').digest('hex') }, before = readFileSync(captured)
      const noDispatch = { onNative: async () => assert.fail('no new native'), onThread: async () => assert.fail('no new thread'), onTurn: async () => assert.fail('no new turn') }
      assert.deepEqual(await zcodeStructuredTurn(realm, kind, '原业务正文  ', completed, noDispatch, workspace), result)
      assert.deepEqual(readFileSync(captured), before, 'cold replay must not send again')
      if (kind === 'new-read') for (const [file, corrupt] of [
        ['plan.json', { ...plan, toolDenylist: ['ExitPlanMode', 'Bash'] }],
        ['plan.json', { ...plan, version: 1 }],
        ['plan.json', { ...plan, requestDigest: '0'.repeat(64) }],
        ['send.json', { ...send, toolDenylist: [] }],
      ] as const) {
        const path = join(root, file), bytes = readFileSync(path)
        chmodSync(path, 0o600); writeFileSync(path, JSON.stringify(corrupt))
        await assert.rejects(zcodeStructuredTurn(realm, kind, '原业务正文  ', completed, noDispatch, workspace), { code: 'stale_result' })
        writeFileSync(path, bytes)
      }
    })
    await t.test('real creation queue pins fresh records and rejoins a legacy record without another send', async creation => {
      const previousCwd = process.cwd(), repository = join(directory, 'repository')
      mkdirSync(repository); mkdirSync(join(repository, '.spec'))
      const git = (args: string[]): string => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) git(args)
      writeFileSync(join(repository, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', sessions: { maxActive: 1 } }))
      writeFileSync(join(repository, 'value'), 'seed\n'); git(['add', '.']); git(['commit', '-qm', 'seed'])
      process.chdir(repository)
      try {
        const { runStructuredSession } = await import('./session-structured.js'), { readRecord } = await import('./session-record.js'), { sessionIdForCreateKey } = await import('./sessions.js')
        const worktree = { baseCommit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']), mode: 'read' as const }
        for (const historical of [false, true]) {
          const request = { ...read, root: repository, prompt: 'Return the complete JSON result.', requestKey: `creation-${historical}-${directory}`, timeoutMs: 15000, worktree }
          const result = await runStructuredSession({ ...request, ...(historical ? { sessionCreateKey: request.requestKey } : {}) })
          const record = readRecord(result.sessionId)!, state = record.structuredExecution!
          assert.deepEqual(state.zcodeToolPolicy, historical ? undefined : tools)
          assert.equal(state.zcodeNative?.version, historical ? 1 : 2)
          assert.equal(state.resultWorktree?.tree, worktree.tree)
          const actual = readFileSync(captured), createHash = record.createPayloadHash
          assert.deepEqual(await runStructuredSession(request), result)
          assert.deepEqual(readFileSync(captured), actual)
          assert.equal(readRecord(result.sessionId)!.createPayloadHash, createHash)
          if (historical) await assert.rejects(runStructuredSession({ ...request, zcodeToolPolicy: tools }), { code: 'key_reused' })
        }
        await creation.test('actual resource bridge preserves frozen tools through first record creation and cold replay', async () => {
          const { openProtocol } = await import('@spexcode/session-protocol'), { migrateSyncStore } = await import('./sync/migrations.js'), { SyncStore } = await import('./sync/store.js')
          const { captureInputSnapshot, readEvidence } = await import('./sync/snapshot.js'), { createAttemptRunner } = await import('./sync/native-run.js')
          const input = await captureInputSnapshot(repository, { committed: true }), database = process.env.SPEX_SESSION_DATABASE_PATH
          assert(database)
          const protocol = openProtocol(database)
          try {
            await migrateSyncStore(protocol)
            const store = new SyncStore(protocol, { readBlob: ref => readEvidence(input.source.commonDir, ref) }), scope = { paths: ['value'], contractIds: [], flowIds: [] }
            const operation = store.admitAndEnqueue({ ingressKey: 'zcode-composed-bridge', rootCauseId: 'zcode-composed-bridge', origin: 'spec', model: read.model, input, scope, budget: { maxCalls: 2, maxAttempts: 2, maxRepairs: 1, timeoutMs: 60000 }, policyDigest: 'policy', impactDigest: 'impact', readSetDigest: 'read', delivery: null, deliveryPlan: { canonicalRoot: join(repository, 'delivery'), branch: 'delivery', baseCommit: input.headCommit } })
            const claim = store.claimAttempt({ operationId: operation.id, source: input.source, scope, leaseMs: 30000, expectedMessageId: operation.dispatchMessageId })
            const request = { ...read, root: repository, prompt: 'Return one complete JSON value.', requestKey: 'zcode-composed-bridge', timeoutMs: 15000, worktree }
            const beforeInvalid = readFileSync(captured)
            for (const [index, invalid] of [
              { zcodeToolPolicy: { version: 1, toolDenylist: ['ExitPlanMode', 'Bash'] } as unknown as NonNullable<ZCodeStructuredExecution['zcodeToolPolicy']> },
              { model: 'claude:MiniMax-M3.1-Flash', zcodeToolPolicy: tools },
              { worktree: { ...worktree, mode: 'edit' as const }, zcodeToolPolicy: tools },
            ].entries()) {
              const sessionCreateKey = `invalid-pinned-policy-${index}-${directory}`
              await assert.rejects(runStructuredSession({ ...request, ...invalid, sessionCreateKey }), { code: 'unsupported' })
              assert.equal(readRecord(sessionIdForCreateKey(sessionCreateKey)), null)
            }
            assert.deepEqual(readFileSync(captured), beforeInvalid)
            const run = createAttemptRunner(store, claim.fence, { pollMs: 2 }), result = await run(request), record = readRecord(result.sessionId)!
            assert.deepEqual(record.structuredExecution!.zcodeToolPolicy, tools)
            assert.equal(record.structuredExecution!.zcodeNative!.version, 2)
            assert.deepEqual(JSON.parse(readFileSync(captured, 'utf8')).send.toolDenylist, ['ExitPlanMode'])
            const original = readFileSync(captured), creationHash = record.createPayloadHash
            assert.deepEqual(await createAttemptRunner(store, claim.fence, { pollMs: 2 })(request), result)
            assert.deepEqual(readFileSync(captured), original, 'the composed cold replay must not send again')
            assert.equal(readRecord(result.sessionId)!.createPayloadHash, creationHash)
            assert.equal(store.readOperation(operation.id).callsUsed, 1)
          } finally { protocol.close() }
        })
      } finally { process.chdir(previousCwd) }
    })
  } finally {
    process.env.PATH = previousPath; t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(directory, { recursive: true, force: true })
  }
})
