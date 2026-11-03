import test from 'node:test'
import assert from 'node:assert/strict'
import { pinNativeConfiguration, pinZCodeToolPolicy, structuredExecutionPolicy, structuredRealmRoot, type StructuredExecution } from './session-structured-policy.js'

const request = { schema: { type: 'object' }, inputDigest: 'input', purpose: 'native-config', timeoutMs: null, model: 'claude:default', worktree: { baseCommit: 'a'.repeat(40), tree: 'b'.repeat(40), mode: 'edit' as const } }
const configured = { ...request, nativeConfiguration: 'cli-config-v1' as const }

test('cli-config-v1显式进入固定策略及创建摘要，旧缺席不补', () => {
  const current = structuredExecutionPolicy(configured)
  assert.equal((current as StructuredExecution & { nativeConfiguration?: string }).nativeConfiguration, 'cli-config-v1')
  assert.equal(current.version, 6)
  assert.equal((structuredExecutionPolicy(request) as StructuredExecution & { nativeConfiguration?: string }).nativeConfiguration, undefined)
  assert.notEqual(JSON.stringify(current), JSON.stringify(structuredExecutionPolicy(request)))
})

for (const model of ['claude:default', 'claude:deployment@2026/alias β', 'zcode:default', 'zcode:custom provider/opaque:model@2026/alias β']) test(`cli-config-v1路由不透明原生选择 ${model}`, () => {
  const policy = structuredExecutionPolicy({ ...configured, model })
  assert.equal(structuredRealmRoot(policy, '/runtime'), `/runtime/structured-native-worktree-v1/${model.startsWith('zcode:') ? 'zcode' : 'claude'}`)
})

for (const change of [{ nativeConfiguration: 'unknown' }, { model: 'claude:' }, { model: 'zcode:' }, { model: 'zcode:provider/' }, { model: 'default' }, { worktree: undefined }]) test(`cli-config-v1严格拒绝错误边界 ${JSON.stringify(change)}`, () => {
  assert.throws(() => structuredExecutionPolicy({ ...configured, ...change } as typeof configured), { code: 'unsupported' })
})

test('旧frozen realm不得取得新原生配置，旧ZCode精确路由保持', () => {
  const old = { version: 5, policy: 'zcode-frozen-read-only-v1', timeoutMs: null, model: 'zcode:provider/model', frozenContext: { version: 1 } } as StructuredExecution
  assert.equal(structuredRealmRoot(old, '/runtime'), '/runtime/structured-zcode-read-only-v1')
  assert.equal(structuredRealmRoot({ ...old, nativeConfiguration: 'cli-config-v1' }, '/runtime'), null)
  assert.equal(structuredRealmRoot({ ...old, model: 'zcode:default' }, '/runtime'), null)
  assert.equal(structuredRealmRoot({ ...old, version: 6, policy: 'native-worktree-v1', worktree: request.worktree, frozenContext: undefined, model: 'zcode:default' }, '/runtime'), null)
})

for (const model of ['claude:default', 'zcode:default']) test(`新配置冻结只认new边界且不替旧缺席补字段 ${model}`, () => {
  const value = { ...request, model }
  assert.equal(pinNativeConfiguration(value, null), 'cli-config-v1')
  assert.equal(pinNativeConfiguration(value, {}), undefined)
  assert.equal(pinNativeConfiguration(value, { nativeConfiguration: 'cli-config-v1' }), 'cli-config-v1')
  assert.throws(() => pinNativeConfiguration({ ...value, nativeConfiguration: 'cli-config-v1' }, {}), { code: 'key_reused' })
  assert.equal(pinNativeConfiguration({ model }, null), undefined)
  if (model.startsWith('zcode:')) {
    const read = { ...value, worktree: { ...value.worktree, mode: 'read' as const } }
    assert.equal(pinNativeConfiguration(read, null), 'cli-config-v1')
    assert.deepEqual(pinZCodeToolPolicy(read, null), { version: 1, toolDenylist: ['ExitPlanMode'] })
    assert.equal(pinZCodeToolPolicy(read, {}), undefined)
  }
})
