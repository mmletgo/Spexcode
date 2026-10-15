import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { bindIntentAuthorizations, rawIntentChanges, readIntentAuthorizations } from './intent-authorization.js'

const path = '.spec/product/node/spec.md'
const sha = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('hex')
const source = (raw: string): string => `---\ntitle: 不计入原意\n---\n## raw source\n\n${raw}\n\n## expanded spec\n详细规则\n`
const policy = (authorizations: unknown[]): string => JSON.stringify({ version: 'sync-intent-authorizations-v1', authorizations })
const record = { path, beforeRawDigest: sha('旧原意'), afterRawDigest: sha('新原意'), source: '用户裁决记录' }

test('摘要沿用现有LF/围栏感知分段；元数据、首尾空白和expanded变化不形成原意差量', () => {
  const raw = '真实原意\n```markdown\n## expanded spec\n围栏仍属原意\n```'
  const before = source(raw).replaceAll('\n', '\r\n')
  const after = source(raw).replace('不计入原意', '新标题').replace('详细规则', '修改详细规则')
  assert.deepEqual(rawIntentChanges(new Map([[path, before]]), new Map([[path, after]]), [path]), [])
  const changed = rawIntentChanges(new Map([[path, before]]), new Map([[path, source(`${raw}\n新一行`)]]), [path])
  assert.equal(changed[0].beforeRaw, raw)
  assert.equal(changed[0].beforeRawDigest, sha(raw))
  assert.equal(changed[0].afterRawDigest, sha(`${raw}\n新一行`))
  assert.equal(rawIntentChanges(new Map([[path, '---\ntitle: 旧\n---\n完整正文\r\n']]), new Map(), [path])[0].beforeRawDigest, sha('完整正文'))
})

test('新增、删除和移动分别绑定规范路径以及显式null，不把空原意当不存在', () => {
  const nextPath = '.spec/product/moved/spec.md'
  const changes = rawIntentChanges(new Map([[path, source('原意')]]), new Map([[nextPath, source('原意')]]), [path, nextPath])
  assert.deepEqual(changes.map(change => [change.path, change.beforeRawDigest, change.afterRawDigest]), [[nextPath, null, sha('原意')], [path, sha('原意'), null]])
  const records = changes.map(({ beforeRaw: _old, afterRaw: _next, ...change }) => ({ ...change, source: '用户同意移动节点' }))
  assert.ok(bindIntentAuthorizations(changes, policy(records)).changes.every(change => change.authorization))
  assert.equal(bindIntentAuthorizations(changes, policy([records[0]])).changes[1].authorization, null)
  assert.equal(rawIntentChanges(new Map(), new Map([[path, source('')]]), [path])[0].afterRawDigest, sha(''))
})

test('精确path/旧摘要/新摘要均匹配才授权；错配与缺记录保留可审摘要', () => {
  const changes = rawIntentChanges(new Map([[path, source('旧原意')]]), new Map([[path, source('新原意')]]), [path])
  assert.equal(bindIntentAuthorizations(changes, policy([record])).changes[0].authorization?.source, record.source)
  for (const wrong of [{ ...record, path: '.spec/product/other/spec.md' }, { ...record, beforeRawDigest: sha('不同旧原意') }, { ...record, afterRawDigest: sha('不同新原意') }]) {
    const result = bindIntentAuthorizations(changes, policy([wrong]))
    assert.equal(result.changes[0].authorization, null)
    assert.equal(result.changes[0].beforeRawDigest, record.beforeRawDigest)
    assert.equal(result.changes[0].afterRawDigest, record.afterRawDigest)
  }
  assert.equal(bindIntentAuthorizations(changes, undefined).artifactDigest, null)
})

test('受信文件边界拒绝缺null、额外字段、重复或非规范路径、伪摘要及空来源', () => {
  const { beforeRawDigest: _before, ...missingBefore } = record
  const { afterRawDigest: _after, ...missingAfter } = record
  const invalid = [
    policy([missingBefore]), policy([missingAfter]), policy([{ ...record, approved: true }]), policy([record, record]),
    ...['/absolute/spec.md', '.spec/product/../node/spec.md', '.spec//node/spec.md', '.spec/product/node\\spec.md', 'src/file.ts'].map(path => policy([{ ...record, path }])),
    policy([{ ...record, beforeRawDigest: 'fake' }]), policy([{ ...record, source: ' ' }]),
    policy([{ ...record, beforeRawDigest: null, afterRawDigest: null }]), '{', JSON.stringify({ version: 'future', authorizations: [] }),
  ]
  for (const text of invalid) assert.throws(() => readIntentAuthorizations(text), { code: 'invalid_intent_authorizations' })
})
