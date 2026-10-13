import test from 'node:test'
import assert from 'node:assert/strict'
import { selectContractScope, hasContractNode } from './syncContractModel.js'

const report = {
  verification: 'not_run',
  contracts: [
    { nodeId: 'export', items: [{ id: 'REQ-EXPORT', kind: 'REQ' }, { id: 'STATE-READY', kind: 'STATE', object: 'task' }] },
    { nodeId: 'policy', items: [{ id: 'GAP-RETENTION', kind: 'GAP' }, { id: 'TR-COMPLETE', kind: 'TR', object: 'task', disposition: 'transition' }] },
    { nodeId: 'other', items: [{ id: 'STATE-OTHER', kind: 'STATE', object: 'other' }] },
  ],
  coverage: {
    items: [
      { id: 'REQ-EXPORT', nodeId: 'export', status: 'bound', blockedBy: ['GAP-RETENTION'] },
      { id: 'GAP-RETENTION', nodeId: 'policy', status: 'declared' },
    ],
    matrix: [
      { object: 'task', stateId: 'STATE-READY', eventId: 'EVENT-DONE', transitionIds: ['TR-COMPLETE'], status: 'bound' },
      { object: 'task', stateId: 'STATE-FINISHED', eventId: 'EVENT-DONE', transitionIds: [], status: 'missing' },
      { object: 'other', stateId: 'STATE-OTHER', eventId: 'EVENT-OTHER', transitionIds: [], status: 'missing' },
    ],
    gaps: [{ id: 'GAP-RETENTION', affectedIds: ['REQ-EXPORT'], nodeIds: ['export'] }],
  },
  findings: [
    { nodeId: 'export', code: 'matrix-incomplete' },
    { nodeId: 'policy', itemId: 'GAP-RETENTION', code: 'unresolved-gap' },
    { nodeId: '', code: 'binding-outside-root' },
    { nodeId: 'other', code: 'matrix-incomplete' },
    { nodeId: 'invalid-contract', code: 'invalid-schema' },
  ],
}

test('node scope preserves cross-node transitions, complete object matrix and dependent GAPs', () => {
  const view = selectContractScope(report, 'export')
  assert.deepEqual(view.items.map((item) => item.id), ['REQ-EXPORT', 'STATE-READY'])
  assert.equal(view.matrix.length, 2)
  assert.equal(view.matrix[1].status, 'missing')
  assert.equal(view.byId.get('TR-COMPLETE').disposition, 'transition')
  assert.equal(view.gaps[0].id, 'GAP-RETENTION')
  assert.deepEqual(view.findings.map((finding) => finding.code), ['matrix-incomplete', 'unresolved-gap', 'binding-outside-root'])
  assert.equal(view.coverage[0].status, 'bound')
  assert.equal(report.verification, 'not_run')
})

test('all-node scope preserves the server report, including every matrix cell and finding', () => {
  const view = selectContractScope(report, '*')
  assert.equal(view.items.length, 5)
  assert.equal(view.matrix.length, 3)
  assert.equal(view.findings.length, 5)
  assert.deepEqual(view.coverage, report.coverage.items)
})

test('legacy nodes stay empty while malformed enabled contracts retain their findings', () => {
  assert.equal(hasContractNode(report, 'legacy'), false)
  assert.equal(hasContractNode(report, 'invalid-contract'), true)
  const view = selectContractScope(report, 'invalid-contract')
  assert.equal(view.items.length, 0)
  assert.equal(view.findings.at(-1).code, 'invalid-schema')
})
